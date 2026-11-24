import { randomUUID } from 'node:crypto';
import { WorkspaceError } from './workspace-contract.mjs';
import { syncRetention } from './sync-contract.mjs';

// PostgreSQL access for the incremental-sync tables (docs/incremental-sync.md §2.1).
// Every function here takes a connection that already belongs to the caller's
// transaction, so the change row is committed atomically with the storage write it
// describes (§2.2). Nothing in this module opens a transaction of its own.

export const syncTables = {
	heads: 'log4stellar.storage_change_heads',
	changes: 'log4stellar.storage_changes',
	snapshots: 'log4stellar.storage_snapshots',
	snapshotEntries: 'log4stellar.storage_snapshot_entries',
};

const changeColumns = [
	'workspace_id', 'seq', 'change_id', 'kind', 'entry_kind', 'path', 'from_path', 'conflict_path',
	'file_id', 'revision_id', 'parent_revision_id', 'sha256', 'size_bytes', 'trash_id', 'device_id',
	'idempotency_key', 'idempotency_fingerprint', 'created_ms', 'op_id', 'base_revision',
];

function changeJson(row) {
	return {
		seq: Number(row.seq),
		changeId: row.change_id,
		kind: row.kind,
		entryKind: row.entry_kind,
		path: row.path,
		fromPath: row.from_path ?? null,
		conflictPath: row.conflict_path ?? null,
		fileId: row.file_id ?? null,
		revisionId: row.revision_id ?? null,
		parentRevisionId: row.parent_revision_id ?? null,
		sha256: row.sha256 ?? null,
		size: row.size_bytes === null || row.size_bytes === undefined ? null : Number(row.size_bytes),
		trashId: row.trash_id ?? null,
		deviceId: row.device_id ?? null,
		opId: row.op_id ?? null,
		baseRevision: row.base_revision ?? null,
		at: Number(row.created_ms),
	};
}

function snapshotEntryJson(row) {
	return {
		path: row.path,
		kind: row.kind,
		fileId: row.file_id,
		revisionId: row.revision_id,
		sha256: row.sha256 ?? null,
		size: row.size_bytes === null || row.size_bytes === undefined ? null : Number(row.size_bytes),
		modifiedAt: Number(row.modified_ms),
	};
}

/** Reads the workspace head without creating it. A workspace that never wrote has seq 0 / floor 1. */
export async function readHead(connection, workspaceId) {
	const { rows } = await connection.query(`
		SELECT seq, retained_floor FROM ${syncTables.heads} WHERE workspace_id = $1
	`, [workspaceId]);
	if (!rows.length) {
		return { seq: 0, retainedFloor: 1 };
	}
	return { seq: Number(rows[0].seq), retainedFloor: Number(rows[0].retained_floor) };
}

/**
 * Allocates the next sequence number for the workspace (§2.2). Runs INSIDE the write
 * transaction, after the caller took the workspace row lock. The upsert also locks the
 * head row, so two writers of one workspace can never interleave sequence allocation.
 */
export async function allocateSeq(connection, workspaceId, nowMs = Date.now()) {
	const { rows } = await connection.query(`
		INSERT INTO ${syncTables.heads} (workspace_id, seq, retained_floor, updated_ms)
		VALUES ($1, 1, 1, $2)
		ON CONFLICT (workspace_id) DO UPDATE
			SET seq = ${syncTables.heads}.seq + 1, updated_ms = $2
		RETURNING seq
	`, [workspaceId, nowMs]);
	return Number(rows[0].seq);
}

/**
 * Appends one immutable change row and returns it as the contract JSON plus its id.
 * Callers that emit several changes for one logical operation pass the same `opId`.
 */
export async function appendChange(connection, workspaceId, fields) {
	const seq = await allocateSeq(connection, workspaceId, fields.at ?? Date.now());
	const changeId = fields.changeId ?? randomUUID();
	const values = {
		workspace_id: workspaceId,
		seq,
		change_id: changeId,
		kind: fields.kind,
		entry_kind: fields.entryKind,
		path: fields.path,
		from_path: fields.fromPath ?? null,
		conflict_path: fields.conflictPath ?? null,
		file_id: fields.fileId ?? null,
		revision_id: fields.revisionId ?? null,
		parent_revision_id: fields.parentRevisionId ?? null,
		sha256: fields.sha256 ?? null,
		size_bytes: fields.sizeBytes === undefined ? null : fields.sizeBytes,
		trash_id: fields.trashId ?? null,
		device_id: fields.deviceId ?? null,
		idempotency_key: fields.idempotencyKey ?? null,
		idempotency_fingerprint: fields.idempotencyFingerprint ?? null,
		created_ms: fields.at ?? Date.now(),
		op_id: fields.opId ?? null,
		base_revision: fields.baseRevision ?? null,
	};
	const { rows } = await connection.query(`
		INSERT INTO ${syncTables.changes} (${changeColumns.join(', ')})
		VALUES (${changeColumns.map((_, index) => '$' + (index + 1)).join(', ')})
		RETURNING *
	`, changeColumns.map(column => values[column]));
	return changeJson(rows[0]);
}

/**
 * Looks up a previous attempt of the same logical write (§5.2). MUST be called after the
 * workspace row lock and before any version or entry is written. Returns null when the key
 * was never seen, the stored result when the fingerprint matches, and throws
 * 409 IdempotencyKeyReused when the same key was used for a different request.
 */
export async function replayChanges(connection, workspaceId, { idempotencyKey, fingerprint }) {
	const { rows } = await connection.query(`
		SELECT * FROM ${syncTables.changes}
		WHERE workspace_id = $1 AND idempotency_key = $2
	`, [workspaceId, idempotencyKey]);
	if (!rows.length) {
		return undefined;
	}
	const [first] = rows;
	// Both sides are normalised to null so a caller that legitimately passes no fingerprint
	// replays instead of being told the key was reused.
	if ((first.idempotency_fingerprint ?? null) !== (fingerprint ?? null)) {
		throw new WorkspaceError(409, 'IdempotencyKeyReused');
	}
	// Every change of the operation shares the op_id, including rows that carry no key
	// (the conflict marker row cannot carry one: the partial unique index allows a single
	// keyed row per workspace).
	const group = first.op_id === null
		? rows
		: (await connection.query(`
			SELECT * FROM ${syncTables.changes} WHERE workspace_id = $1 AND op_id = $2 ORDER BY seq
		`, [workspaceId, first.op_id])).rows;
	return {
		opId: first.op_id,
		changes: group.map(changeJson),
	};
}

/** Keyset page of the change stream (§7.1). `hasMore` is the only end-of-stream signal. */
export async function readChangesPage(connection, workspaceId, { fromSeq, limit }) {
	const head = await readHead(connection, workspaceId);
	const { rows } = await connection.query(`
		SELECT * FROM ${syncTables.changes}
		WHERE workspace_id = $1 AND seq > $2
		ORDER BY seq
		LIMIT $3
	`, [workspaceId, fromSeq, limit + 1]);
	const hasMore = rows.length > limit;
	const page = rows.slice(0, limit);
	return {
		head: head.seq,
		retainedFloor: head.retainedFloor,
		changes: page.map(changeJson),
		hasMore,
	};
}

/** One immutable snapshot of the working tree, taken inside the caller's REPEATABLE READ read. */
export async function readTreeForSnapshot(connection, workspaceId) {
	const head = await readHead(connection, workspaceId);
	const { rows } = await connection.query(`
		SELECT e.path, e.kind, e.file_id, e.revision_id, e.modified_ms, v.sha256, v.size_bytes
		FROM log4stellar.storage_entries e
		LEFT JOIN log4stellar.storage_file_versions v
			USING (workspace_id, file_id, revision_id)
		WHERE e.workspace_id = $1
		ORDER BY e.path
	`, [workspaceId]);
	return { seq: head.seq, retainedFloor: head.retainedFloor, entries: rows };
}

/** Materializes an already-read tree into the snapshot tables (§4.1). */
export async function materializeSnapshot(connection, { snapshotId = randomUUID(), workspaceId, seq, entries, nowMs = Date.now(), ttlMs = syncRetention.snapshotTtlMs }) {
	const createdMs = nowMs;
	const expiresMs = nowMs + ttlMs;
	await connection.query(`
		INSERT INTO ${syncTables.snapshots} (id, workspace_id, seq, entry_count, created_ms, expires_ms)
		VALUES ($1, $2, $3, $4, $5, $6)
	`, [snapshotId, workspaceId, seq, entries.length, createdMs, expiresMs]);
	const chunkSize = 500;
	for (let offset = 0; offset < entries.length; offset += chunkSize) {
		const chunk = entries.slice(offset, offset + chunkSize);
		const values = [];
		const placeholders = chunk.map((entry, index) => {
			const base = index * 8;
			values.push(
				snapshotId, entry.path, entry.kind, entry.file_id, entry.revision_id,
				entry.sha256 ?? null, entry.size_bytes === null || entry.size_bytes === undefined ? null : Number(entry.size_bytes),
				Number(entry.modified_ms),
			);
			return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8})`;
		});
		await connection.query(`
			INSERT INTO ${syncTables.snapshotEntries}
				(snapshot_id, path, kind, file_id, revision_id, sha256, size_bytes, modified_ms)
			VALUES ${placeholders.join(', ')}
		`, values);
	}
	return { snapshotId, seq, entryCount: entries.length, createdMs, expiresMs };
}

/** Snapshot page read: keyset over `path` on the materialized copy only (§4.3). */
export async function readSnapshotPage(connection, workspaceId, { snapshotId, lastPath, limit, nowMs = Date.now() }) {
	const { rows } = await connection.query(`
		SELECT * FROM ${syncTables.snapshots} WHERE id = $1 AND workspace_id = $2
	`, [snapshotId, workspaceId]);
	if (!rows.length) {
		throw new WorkspaceError(410, 'InvalidSnapshot');
	}
	const snapshot = rows[0];
	if (Number(snapshot.expires_ms) < nowMs) {
		throw new WorkspaceError(410, 'InvalidSnapshot');
	}
	const page = await connection.query(`
		SELECT * FROM ${syncTables.snapshotEntries}
		WHERE snapshot_id = $1 AND path > $2
		ORDER BY path
		LIMIT $3
	`, [snapshotId, lastPath, limit + 1]);
	const hasMore = page.rows.length > limit;
	const entries = page.rows.slice(0, limit).map(snapshotEntryJson);
	return {
		snapshotId,
		seq: Number(snapshot.seq),
		entryCount: Number(snapshot.entry_count),
		expiresAt: Number(snapshot.expires_ms),
		entries,
		hasMore,
		lastPath: entries.length ? entries.at(-1).path : lastPath,
	};
}

/**
 * Applies the retention policy of §7.2 to one workspace. Runs inside the writing
 * transaction, so a cursor can never be validated against rows that are already gone.
 *
 * Trimming always removes a CONTIGUOUS PREFIX of the stream. Deleting rows from the middle
 * would leave `retained_floor` pointing at an older seq than the rows that survive, and a
 * client would silently miss changes while still being told its cursor is valid. Gaps in
 * the stream are only ever produced by the writer, never by the trimmer.
 *
 * A keyed row is the replay record of a write, so it outlives the plain change TTL: the
 * prefix stops at the first row that is still inside the idempotency window.
 */
export async function trimChanges(connection, workspaceId, {
	nowMs = Date.now(),
	changesTtlMs = syncRetention.changesTtlMs,
	idempotencyTtlMs = syncRetention.idempotencyTtlMs,
	// Retained for callers that pass it (tests pin the ceiling behaviour); it no longer trims
	// rows that are still inside the TTL, so the ceiling is advisory (§7.2).
	maxChanges = syncRetention.maxChangesPerWorkspace,
} = {}) {
	const head = await readHead(connection, workspaceId);
	if (head.seq === 0) {
		return { deleted: 0, retainedFloor: head.retainedFloor };
	}
	const { rows } = await connection.query(`
		SELECT COALESCE(MIN(seq), $2::bigint) AS survivor FROM ${syncTables.changes}
		WHERE workspace_id = $1
			AND (created_ms >= $3 OR (idempotency_key IS NOT NULL AND created_ms >= $4))
	`, [workspaceId, head.seq + 1, nowMs - changesTtlMs, nowMs - idempotencyTtlMs]);
	const firstSurvivor = Number(rows[0].survivor);
	// Two limits compete here, and they are not interchangeable: the TTL decides which rows are
	// still CONTRACTUALLY needed, the row ceiling exists only to bound disk. Letting the ceiling
	// win (`head.seq - maxChanges + 1` folded in with `max`) silently cut the idempotency window
	// down to "as long as the stream is short": a retry after a busy period became a brand new
	// request, which for a save is a conflict and for a delete is a second trash entry.
	// So the TTL/floor survivor is the hard lower bound and the ceiling may only be exceeded —
	// the workspace keeps its keys, and a client that has fallen behind still gets 410.
	const keepFrom = Math.min(firstSurvivor, head.seq + 1);
	const floor = Math.max(head.retainedFloor, keepFrom);
	if (keepFrom <= 1 && floor === head.retainedFloor) {
		return { deleted: 0, retainedFloor: head.retainedFloor };
	}
	const removed = await connection.query(`
		DELETE FROM ${syncTables.changes} WHERE workspace_id = $1 AND seq < $2
	`, [workspaceId, keepFrom]);
	if (floor > head.retainedFloor) {
		await connection.query(`
			UPDATE ${syncTables.heads} SET retained_floor = $2, updated_ms = $3 WHERE workspace_id = $1
		`, [workspaceId, floor, nowMs]);
	}
	return { deleted: removed.rowCount, retainedFloor: floor };
}

/** Expired snapshot pages are unreachable, so their rows are dropped opportunistically. */
export async function trimSnapshots(connection, workspaceId, nowMs = Date.now()) {
	const { rowCount } = await connection.query(`
		DELETE FROM ${syncTables.snapshots} WHERE workspace_id = $1 AND expires_ms < $2
	`, [workspaceId, nowMs]);
	return rowCount;
}

export { changeJson, snapshotEntryJson };
