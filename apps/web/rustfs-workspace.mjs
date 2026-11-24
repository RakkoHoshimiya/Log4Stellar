import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { basename, dirname as parentPath } from 'node:path/posix';
import { Pool } from 'pg';
import { openRustfsBlobs } from './rustfs-blobs.mjs';
import { ensureStorageSchema } from './sync-migrate.mjs';
import { WorkspaceError, ifMatchHolds, normalizeWorkspacePath } from './workspace-contract.mjs';
import {
	conflictPath,
	encodeCursor,
	encodePageToken,
	idempotencyFingerprint,
	maxConflictIndex,
	nextConflictPath,
	requireHeadCursor,
	requireLiveCursor,
	requireRetainedCursor,
	syncRetention,
} from './sync-contract.mjs';
import {
	appendChange,
	changeJson,
	materializeSnapshot,
	readChangesPage,
	readHead,
	readSnapshotPage,
	readTreeForSnapshot,
	replayChanges,
	syncTables,
	trimChanges,
	trimSnapshots,
} from './sync-store.mjs';
import {
	drainIndexJobs,
	indexStatus,
	matchFromRow,
	rebuildWorkspaceIndex,
} from './search-indexer.mjs';
import {
	countDocuments,
	ensureSearchSchema,
	enqueueIndexUpdate,
	queryDocuments,
	readIndexState,
} from './search-store.mjs';
import {
	decodeSearchCursor, encodeSearchCursor, searchLimits, searchMatchText,
} from './search-contract.mjs';

const file = 1;
const directory = 2;
const entries = 'log4stellar.storage_entries';
const versions = 'log4stellar.storage_file_versions';
const workspaces = 'log4stellar.storage_workspaces';
const trash = 'log4stellar.storage_trash';
const trashEntries = 'log4stellar.storage_trash_entries';
const changesTable = syncTables.changes;
const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

function etag(revisionId) {
	return `"${revisionId}"`;
}

function describe(row) {
	return {
		type: row.kind,
		ctime: Number(row.created_ms),
		mtime: Number(row.modified_ms),
		size: Number(row.size_bytes ?? 0),
		etag: etag(row.revision_id),
	};
}

function nonRoot(path) {
	const normalized = normalizeWorkspacePath(path);
	if (normalized === '/') {
		throw new WorkspaceError(403, 'NoPermissions');
	}
	return normalized;
}

// Splits a path so a keep-both restore can insert a ` (restored)` marker without disturbing the
// name. The marker goes after the first dot rather than after the last one, so `report.tar.gz`
// restores as `report (restored).tar.gz` instead of `report.tar (restored).gz`, and a name that
// already carries a marker continues the numbering (`report (restored 2).tar.gz`) instead of
// nesting a second marker.
function restoreNaming(original, kind) {
	const parent = parentPath(original);
	if (kind !== file) {
		return { parent, stem: basename(original), extension: '', index: 1 };
	}
	const name = basename(original);
	// A leading dot is part of the name, not of an extension, so `.hidden` keeps its whole name.
	const dot = name.indexOf('.', name.startsWith('.') ? 1 : 0);
	const stem = dot === -1 ? name : name.slice(0, dot);
	const extension = dot === -1 ? '' : name.slice(dot);
	const marker = / \(restored(?: (\d+))?\)$/.exec(stem);
	if (!marker) {
		// Trimming keeps `notes .pdf` from restoring as `notes  (restored).pdf`.
		return { parent, stem: stem.trimEnd(), extension, index: 1 };
	}
	return { parent, stem: stem.slice(0, marker.index), extension, index: marker[1] ? Number(marker[1]) + 1 : 2 };
}

function restoredPath(naming, index) {
	const suffix = index === 1 ? ' (restored)' : ' (restored ' + index + ')';
	return (naming.parent === '/' ? '' : naming.parent) + '/' + naming.stem + suffix + naming.extension;
}

/**
 * Reads and validates `LOG4STELLAR_STORAGE_CONFIG`. Shared by `openRustfsWorkspace`
 * and `rustfsWorkspaceExists` so both reject a broken configuration the same way.
 */
async function readStorageSettings() {
	const configPath = process.env.LOG4STELLAR_STORAGE_CONFIG;
	if (!configPath) {
		throw new Error('Set LOG4STELLAR_STORAGE_CONFIG to the server-side storage JSON file.');
	}
	const settings = JSON.parse(await readFile(configPath, 'utf8'));
	const postgres = settings.postgres;
	if (!postgres?.host || !postgres.database || !postgres.user || !postgres.password || !settings.s3) {
		throw new Error('The storage configuration must provide PostgreSQL connection details and RustFS settings.');
	}
	return { configPath, settings, postgres };
}

/**
 * Answers whether a storage workspace has been imported, without opening it. Used by
 * the operator CLI: a member row for a workspace that was never imported logs the
 * account in and then fails every mount with 403, which looks like a permissions bug.
 */
export async function rustfsWorkspaceExists(workspaceId) {
	if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(workspaceId)) {
		throw new Error('A RustFS workspace ID must contain 1–63 lowercase letters, digits or hyphens.');
	}
	const { postgres } = await readStorageSettings();
	const pool = new Pool({ connectionTimeoutMillis: 5000, max: 1, ...postgres });
	try {
		const { rowCount } = await pool.query(`SELECT 1 FROM ${workspaces} WHERE id = $1`, [workspaceId]);
		return rowCount === 1;
	} finally {
		await pool.end();
	}
}

export async function openRustfsWorkspace(workspaceId, { importing = false, createBlobs = openRustfsBlobs } = {}) {
	if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(workspaceId)) {
		throw new Error('A RustFS workspace ID must contain 1–63 lowercase letters, digits or hyphens.');
	}
	const { configPath, settings, postgres } = await readStorageSettings();
	const pool = new Pool({ connectionTimeoutMillis: 5000, max: 8, ...postgres });
	const blobs = await createBlobs(settings.s3, workspaceId, join(dirname(configPath), 'spool'));

	// Every writing transaction holds the shared half of the migration advisory lock, so a
	// process that boots while others are already working waits for them instead of fighting
	// them for table locks (the CREATE TABLE .. IF NOT EXISTS still needs AccessExclusiveLock,
	// and taking it while a writer holds RowExclusiveLock on another table deadlocks).
	// A writer never waits for the migration itself: it takes the shared lock before touching
	// any table, and the migrator takes the exclusive one before its first DDL statement.
	async function transaction(action, { shared = true } = {}) {
		const connection = await pool.connect();
		try {
			await connection.query('BEGIN');
			if (shared) {
				await connection.query('SELECT pg_advisory_xact_lock_shared(467209224)');
			}
			const result = await action(connection);
			await connection.query('COMMIT');
			return result;
		} catch (error) {
			await connection.query('ROLLBACK').catch(() => {});
			throw error;
		} finally {
			connection.release();
		}
	}

	/**
	 * A consistent read of the whole workspace. The snapshot flow needs the head seq and the
	 * entry tree from ONE view: REPEATABLE READ gives that, READ ONLY keeps a long snapshot
	 * from holding a write transaction (§4.2). Materializing the snapshot happens afterwards
	 * in a normal write transaction, which is why the read transaction stays read-only.
	 */
	async function readTransaction(action) {
		const connection = await pool.connect();
		try {
			await connection.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
			const result = await action(connection);
			await connection.query('COMMIT');
			return result;
		} catch (error) {
			await connection.query('ROLLBACK').catch(() => {});
			throw error;
		} finally {
			connection.release();
		}
	}

	// --- change stream -------------------------------------------------------------------
	// Every mutation appends its change rows inside the same transaction that wrote the
	// entries, and only after ensureWorkspace(connection, true) took the workspace row lock.
	// Sequence allocation therefore happens after the lock (§2.2), so per-workspace seq order
	// is commit order (§1 invariant 1).
	const changeTrimInterval = 512;
	// How often a READ path may pay for snapshot GC (§7.2). Ten minutes keeps an idle
	// workspace from accumulating more than a few expired snapshots while costing one small
	// indexed DELETE per open backend per interval, instead of one per request.
	const snapshotGcIntervalMs = 10 * 60 * 1000;
	let snapshotsCollectedAtMs = 0;

	/**
	 * Appends one change row and mirrors it into the search queue in the same
	 * transaction. Funneling every mutation through this one helper is what makes the
	 * "index event commits with the write" rule hold without repeating the call at
	 * each of the ten write paths: a save, a rename, a delete, a restore, a rollback
	 * and a conflict copy all reach `enqueueIndexUpdate` exactly once, after the
	 * change sequence was allocated.
	 */
	async function append(connection, fields) {
		const change = await appendChange(connection, workspaceId, fields);
		await recordIndexUpdate(connection, change);
		return change;
	}

	/**
	 * Feeds one change into the search queue, inside the transaction that wrote it.
	 *
	 * Only the two states that a note file can be in matter: present (index its current
	 * revision) and gone (drop it). A rename needs no work at all — the document stores
	 * the extracted text, and every read takes the path from `storage_entries`, so a move
	 * is visible to search the moment it commits. That is also why a directory rename,
	 * which is one change for a whole subtree, needs nothing here.
	 */
	async function recordIndexUpdate(connection, change) {
		if (change.entryKind !== file || !change.fileId) {
			return;
		}
		if (change.kind === 'file.deleted') {
			await enqueueIndexUpdate(connection, {
				workspaceId, fileId: change.fileId, seq: change.seq, operation: 'delete', nowMs: change.at,
			});
			return;
		}
		if (change.kind === 'file.created' || change.kind === 'file.saved'
			|| change.kind === 'file.rolledback' || change.kind === 'file.restored'
			|| change.kind === 'file.conflicted') {
			await enqueueIndexUpdate(connection, {
				workspaceId,
				fileId: change.fileId,
				revisionId: change.revisionId,
				seq: change.seq,
				operation: 'upsert',
				nowMs: change.at,
			});
		}
	}

	/** Opportunistic retention work, run every `changeTrimInterval` writes (§7.2). */
	async function maintain(connection, seq) {
		if (seq % changeTrimInterval !== 0) {
			return;
		}
		await trimChanges(connection, workspaceId);
		await trimSnapshots(connection, workspaceId);
	}

	/**
	 * Snapshot GC for workspaces that never write.
	 *
	 * `maintain()` only runs when a write lands on a multiple of `changeTrimInterval`, so an
	 * idle workspace kept every expired snapshot forever: the TTL table promises six hours,
	 * and the rows (plus their entry pages, via ON DELETE CASCADE) simply stayed. There is no
	 * background sweeper yet, so the read paths collect on their own schedule: at most once
	 * per `snapshotGcIntervalMs` per open backend, tracked in memory. A read path that has to
	 * pay for a DELETE every request would be worse than the leak, hence the throttle.
	 *
	 * The cost is bounded and independent of the workspace size: the DELETE is an index scan
	 * on `(workspace_id, expires_ms)`.
	 */
	async function collectExpiredSnapshots(nowMs = Date.now()) {
		if (nowMs - snapshotsCollectedAtMs < snapshotGcIntervalMs) {
			return 0;
		}
		const collected = await transaction(connection => trimSnapshots(connection, workspaceId, nowMs));
		snapshotsCollectedAtMs = nowMs;
		return collected;
	}

	/**
	 * Replay probe usable BEFORE any state check.
	 *
	 * §5.2 puts the replay lookup inside the write transaction, after the workspace row lock.
	 * That is where it decides what to write — but it is too late to decide what to ANSWER when
	 * the caller cached a state check outside the transaction first. An upload whose parent
	 * directory was removed by another device, a rollback whose file was deleted, a restore
	 * whose trash row was consumed: all three used to fail that cached check with 404 and never
	 * reach the transaction, so an already-committed write was reported as "nothing happened".
	 * Reading the stored answer first keeps the retry contract of §5.2 even when the state the
	 * request originally ran against is gone; the in-transaction probe still decides the write.
	 */
	async function replayFirst(fields) {
		if (!fields?.idempotencyKey) {
			return undefined;
		}
		return replayChanges(pool, workspaceId, fields);
	}

	function uploadBody(row, replayed) {
		return {
			seq: row.seq,
			changeId: row.changeId,
			changeIds: [row.changeId],
			path: row.path,
			fileId: row.fileId,
			revisionId: row.revisionId,
			etag: etag(row.revisionId),
			size: row.size,
			sha256: row.sha256,
			created: row.kind === 'file.created',
			replayed,
			opId: row.opId,
		};
	}

	/** The stored answer of a write, rendered exactly as the first attempt was (§5.2). */
	function replayResponse(previousAttempt) {
		return {
			replayed: true,
			conflict: previousAttempt.changes.some(row => row.kind === 'file.conflicted'),
			created: previousAttempt.changes.some(row => row.kind === 'file.created'),
			changes: previousAttempt.changes,
			opId: previousAttempt.opId,
		};
	}

	/**
	 * A mutation that changed nothing: no seq is spent, no change row is written, and the
	 * response says so explicitly rather than borrowing the workspace head (§8.6).
	 */
	function noChangeBody(path) {
		return {
			seq: null,
			changeId: null,
			changeIds: [],
			opId: null,
			replayed: false,
			changed: false,
			path,
		};
	}

	function conflictBody(rows, replayed) {
		const mark = rows.find(row => row.kind === 'file.conflicted');
		return {
			error: 'SyncConflict',
			seq: mark.seq,
			changeId: mark.changeId,
			changeIds: rows.map(row => row.changeId),
			conflictPath: mark.conflictPath,
			currentRevision: mark.parentRevisionId ?? null,
			fileId: mark.fileId ?? null,
			revisionId: mark.revisionId,
			etag: etag(mark.revisionId),
			size: mark.size,
			sha256: mark.sha256,
			created: true,
			replayed,
			opId: mark.opId,
		};
	}

	function batchBody(changes, replayed, extra) {
		return {
			seq: changes.at(-1).seq,
			changeId: changes.at(-1).changeId,
			changeIds: changes.map(change => change.changeId),
			opId: changes[0].opId,
			replayed,
			...(typeof extra === 'function' ? extra(changes) : extra),
		};
	}

	function replayBatch(replay, extra) {
		return { status: 200, body: batchBody(replay.changes, true, extra(replay.changes)) };
	}

	async function ensureWorkspace(connection, lock = false) {
		const { rowCount } = await connection.query(
			`SELECT 1 FROM ${workspaces} WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [workspaceId],
		);
		if (rowCount !== 1) {
			throw new Error('The RustFS workspace must be imported before it can be opened.');
		}
	}

	async function findEntry(connection, path) {
		const { rows } = await connection.query(`
			SELECT e.*, v.sha256, v.size_bytes FROM ${entries} e
			LEFT JOIN ${versions} v USING (workspace_id, file_id, revision_id)
			WHERE e.workspace_id = $1 AND e.path = $2
		`, [workspaceId, path]);
		return rows[0];
	}

	async function requiredEntry(connection, path, kind) {
		const row = await findEntry(connection, path);
		if (!row) {
			throw new WorkspaceError(404, 'FileNotFound');
		}
		if (kind && row.kind !== kind) {
			throw new WorkspaceError(400, kind === directory ? 'FileNotADirectory' : 'FileIsADirectory');
		}
		return row;
	}

	async function hasChildren(connection, path) {
		const result = await connection.query(`
			SELECT 1 FROM ${entries} WHERE workspace_id = $1 AND parent_path = $2 LIMIT 1
		`, [workspaceId, path]);
		return result.rowCount > 0;
	}

	async function addEntry(connection, path, kind, { id = randomUUID(), revision = randomUUID(), created = Date.now(), modified = created } = {}) {
		const { rows } = await connection.query(`
			INSERT INTO ${entries} (workspace_id, path, parent_path, name, file_id, revision_id, kind, created_ms, modified_ms)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *
		`, [workspaceId, path, path === '/' ? null : parentPath(path), basename(path), id, revision, kind, created, modified]);
		return rows[0];
	}

	async function writeVersion(connection, path, previous, blob, time = {}) {
		const id = previous?.file_id ?? randomUUID();
		const revision = randomUUID();
		const modified = time.modified ?? Date.now();
		await connection.query(`
			INSERT INTO ${versions} (workspace_id, file_id, revision_id, parent_revision_id, sha256, size_bytes, created_ms)
			VALUES ($1, $2, $3, $4, $5, $6, $7)
		`, [workspaceId, id, revision, previous?.revision_id ?? null, blob.digest, blob.size, modified]);

		if (!previous) {
			const row = await addEntry(connection, path, file, { ...time, id, revision, modified });
			return { ...describe({ ...row, size_bytes: blob.size }), created: true, fileId: id, revisionId: revision };
		}
		await connection.query(`
			UPDATE ${entries} SET revision_id = $3, modified_ms = $4 WHERE workspace_id = $1 AND path = $2
		`, [workspaceId, path, revision, modified]);
		return {
			...describe({ ...previous, revision_id: revision, modified_ms: modified, size_bytes: blob.size }),
			created: false, fileId: id, revisionId: revision,
		};
	}

	async function findRevision(connection, current, id) {
		if (!uuidPattern.test(id)) {
			throw new WorkspaceError(400, 'InvalidRevision');
		}
		const { rows } = await connection.query(`
			SELECT revision_id, sha256, size_bytes, created_ms
			FROM ${versions} WHERE workspace_id = $1 AND file_id = $2 AND revision_id = $3
		`, [workspaceId, current.file_id, id]);
		if (!rows.length) {
			throw new WorkspaceError(404, 'FileNotFound');
		}
		return rows[0];
	}

	async function moveToTrash(connection, path, id = randomUUID()) {
		await connection.query(`INSERT INTO ${trash} VALUES ($1, $2, $3, $4)`, [id, workspaceId, path, Date.now()]);
		// Returning the removed rows is what lets the caller emit one change per deleted path
		// (§8.6: a recursive delete is N changes, not one).
		const { rows } = await connection.query(`
			WITH removed AS (
				DELETE FROM ${entries}
				WHERE workspace_id = $1 AND (path = $2 OR left(path, length($2) + 1) = $2 || '/')
				RETURNING path, file_id, revision_id, kind, created_ms, modified_ms
			)
			INSERT INTO ${trashEntries} SELECT $3, removed.* FROM removed
			RETURNING path, file_id, revision_id, kind, created_ms, modified_ms
		`, [workspaceId, path, id]);
		return { trashId: id, removed: rows };
	}

	/**
	 * Conflict copies share one prefix and differ only by index (§6.3). nextConflictPath()
	 * probes synchronously, so every candidate name in the index range is read in one query
	 * and the caller closes over the resulting Set.
	 */
	async function conflictCandidates(connection, path, device, timestampMs) {
		const names = [];
		for (let index = 1; index <= maxConflictIndex; index += 1) {
			names.push(conflictPath(path, { device, timestampMs, index }));
		}
		const { rows } = await connection.query(`
			SELECT path FROM ${entries} WHERE workspace_id = $1 AND path = ANY($2)
		`, [workspaceId, names]);
		return new Set(rows.map(row => row.path));
	}

	/**
	 * A multi-row operation stores the idempotency key on ONE row only: the partial unique
	 * index allows a single keyed row per workspace, and the group is recovered through op_id
	 * (§5.2). The keyed row is the first appended one, so `replayChanges` finds it
	 * deterministically and rows are never rewritten after insert (§1 invariant 2).
	 */
	function keyFields(key) {
		if (!key?.idempotencyKey) {
			return {};
		}
		return {
			idempotencyKey: key.idempotencyKey,
			idempotencyFingerprint: key.fingerprint,
			baseRevision: key.baseRevision,
		};
	}

	/** One change per trashed path, all sharing `opId` (§8.6 batch grouping). */
	async function trashChanges(connection, { trashId, removed, opId, deviceId, at, key }) {
		const changes = [];
		for (const row of removed) {
			changes.push(await append(connection, {
				kind: row.kind === file ? 'file.deleted' : 'directory.deleted',
				entryKind: row.kind,
				path: row.path,
				fileId: row.file_id,
				revisionId: row.revision_id,
				trashId,
				opId,
				deviceId,
				at,
				...(changes.length ? {} : keyFields(key)),
			}));
		}
		return changes;
	}

	async function restoreParents(connection, parent) {
		const createdParents = [];
		let path = '';
		for (const name of parent.split('/').filter(Boolean)) {
			path += '/' + name;
			const existing = await findEntry(connection, path);
			if (existing?.kind === file) {
				throw new WorkspaceError(409, 'RestoreParentIsFile');
			}
			if (!existing) {
				await addEntry(connection, path, directory);
				createdParents.push(path);
			}
		}
		return createdParents;
	}

	/** Trash snapshots are immutable until a restore consumes their ID. */
	async function trashSnapshot(connection, ids) {
		const items = await connection.query(`
			SELECT t.id, t.original_path, t.deleted_ms, e.kind, e.file_id, e.revision_id
			FROM ${trash} t JOIN ${trashEntries} e ON e.trash_id = t.id AND e.path = t.original_path
			WHERE t.workspace_id = $1 AND t.id = ANY($2::uuid[])
			ORDER BY length(t.original_path), t.original_path, t.id
		`, [workspaceId, ids]);
		if (items.rowCount !== ids.length) {
			throw new WorkspaceError(404, 'FileNotFound');
		}
		const objects = await connection.query(`
			SELECT DISTINCT v.sha256, v.size_bytes
			FROM ${trash} t JOIN ${trashEntries} e ON e.trash_id = t.id
			LEFT JOIN ${versions} v ON v.workspace_id = t.workspace_id AND v.file_id = e.file_id AND v.revision_id = e.revision_id
			WHERE t.workspace_id = $1 AND t.id = ANY($2::uuid[]) AND e.kind = $3
			ORDER BY v.sha256, v.size_bytes
		`, [workspaceId, ids, file]);
		return { items: items.rows, objects: objects.rows };
	}

	async function restoreTrashItem(connection, item, keepBoth) {
		const id = item.id;
		const original = item.original_path;
		let target = original;
		if (await findEntry(connection, target)) {
			if (!keepBoth) {
				throw new WorkspaceError(409, 'FileExists');
			}
			const naming = restoreNaming(original, item.kind);
			target = restoredPath(naming, naming.index);
			while (await findEntry(connection, target)) {
				target = restoredPath(naming, ++naming.index);
			}
		}
		const createdParents = await restoreParents(connection, parentPath(target));
		// RETURNING tells the change stream which paths actually came back, so a restored
		// directory subtree is reported path by path (§8.6 "one per entry").
		const { rows } = await connection.query(`
			INSERT INTO ${entries} (workspace_id, path, parent_path, name, file_id, revision_id, kind, created_ms, modified_ms)
			SELECT $1, $4 || substring(path from length($3) + 1),
				CASE WHEN path = $3 THEN $5 ELSE $4 || substring(regexp_replace(path, '/[^/]+$', '') from length($3) + 1) END,
				CASE WHEN path = $3 THEN $6 ELSE regexp_replace(path, '^.*/', '') END,
				file_id, revision_id, kind, created_ms, modified_ms
			FROM ${trashEntries} WHERE trash_id = $2
			RETURNING path, file_id, revision_id, kind
		`, [workspaceId, id, original, target, parentPath(target), basename(target)]);
		await connection.query(`DELETE FROM ${trash} WHERE workspace_id = $1 AND id = $2`, [workspaceId, id]);
		return { path: target, type: item.kind, createdParents, restored: rows };
	}

	async function restoreTrashEntries(ids, keepBoth, sync) {
		if (!ids.length || ids.some(id => typeof id !== 'string' || !uuidPattern.test(id))
			|| new Set(ids.map(id => id.toLowerCase())).size !== ids.length) {
			throw new WorkspaceError(400, 'InvalidTrashId');
		}
		// A restore consumes its trash row, so a retry finds nothing to snapshot and used to
		// die with 404 FileNotFound before the in-transaction replay lookup could answer (§5.2).
		const answered = sync?.idempotencyKey ? await replayFirst(sync) : undefined;
		if (answered) {
			return { replayed: true, restored: [], changes: answered.changes, opId: answered.opId };
		}
		const snapshot = await trashSnapshot(pool, ids);
		for (let offset = 0; offset < snapshot.objects.length; offset += 8) {
			await Promise.all(snapshot.objects.slice(offset, offset + 8).map(object => blobs.verify(object.sha256, Number(object.size_bytes))));
		}

		const result = await transaction(async connection => {
			await ensureWorkspace(connection, true);
			if (sync?.idempotencyKey) {
				// Same placement as the upload path: replay lookup after the row lock, before
				// any entry is written (§5.2).
				const replay = await replayChanges(connection, workspaceId, sync);
				if (replay) {
					return { replayed: true, ...replay };
				}
			}
			// An item can be restored by another session while the object store is being checked.
			const current = await trashSnapshot(connection, ids);
			if (JSON.stringify(current) !== JSON.stringify(snapshot)) {
				throw new WorkspaceError(409, 'TrashChanged');
			}
			const opId = randomUUID();
			const restored = [];
			const changes = [];
			for (const item of current.items) {
				const entry = await restoreTrashItem(connection, item, keepBoth);
				restored.push(entry);
				if (!sync) {
					continue;
				}
				for (const row of entry.restored) {
					changes.push(await append(connection, {
						// The change-kind enum has no directory.restored, so a restored directory
						// is reported as a fresh directory instead (contract gap, see report).
						kind: row.kind === file ? 'file.restored' : 'directory.created',
						entryKind: row.kind,
						path: row.path,
						fileId: row.file_id,
						revisionId: row.revision_id,
						trashId: item.id,
						opId,
						deviceId: sync.device,
						...(changes.length ? {} : keyFields(sync)),
					}));
				}
			}
			return { replayed: false, restored, changes, opId };
		});
		if (sync) {
			return result;
		}
		return result.restored;
	}

	// --- mutating primitives -------------------------------------------------------------
	// The public methods and their sync counterparts share these bodies; the sync wrappers
	// add the idempotency lookup and the change response, nothing else. Keeping one body is
	// what guarantees /static/mount and /sync/v1 write identical storage and identical
	// stream rows (§8: the two endpoints are two doors into one workspace).

	async function deleteEntries(connection, target, { recursive, trashId, opId, deviceId, at, key }) {
		const row = await requiredEntry(connection, target);
		if (row.kind === directory && !recursive && await hasChildren(connection, target)) {
			throw new WorkspaceError(409, 'DirectoryNotEmpty');
		}
		const trashed = await moveToTrash(connection, target, trashId);
		return trashChanges(connection, { ...trashed, opId, deviceId, at, key });
	}

	async function renameEntries(connection, source, target, { overwrite, opId, deviceId, at, key }) {
		const row = await requiredEntry(connection, source);
		if (source === target) {
			return [];
		}
		if (target.startsWith(source + '/')) {
			throw new WorkspaceError(400, 'InvalidPath');
		}
		await requiredEntry(connection, parentPath(target), directory);
		const collision = await findEntry(connection, target);
		const changes = [];
		if (collision) {
			if (!overwrite) {
				throw new WorkspaceError(409, 'FileExists');
			}
			if (collision.kind !== row.kind) {
				throw new WorkspaceError(400, collision.kind === directory ? 'FileIsADirectory' : 'FileNotADirectory');
			}
			if (collision.kind === directory && await hasChildren(connection, target)) {
				throw new WorkspaceError(409, 'DirectoryNotEmpty');
			}
			// An overwrite silently trashes the target, so the stream says so before the rename
			// lands on top of it.
			const trashed = await moveToTrash(connection, target);
			changes.push(...await trashChanges(connection, { ...trashed, opId, deviceId, at, key }));
		}
		// One change for the whole subtree: clients move their local tree with it, which is what
		// §8.6 asks rename to be (unlike delete, which is per path).
		changes.push(await append(connection, {
			kind: row.kind === directory ? 'directory.renamed' : 'file.renamed',
			entryKind: row.kind,
			path: target,
			fromPath: source,
			fileId: row.file_id,
			revisionId: row.revision_id,
			opId,
			deviceId,
			at,
			...(changes.length ? {} : keyFields(key)),
		}));
		await connection.query(`
			UPDATE ${entries} SET
				path = $3 || substring(path from length($2) + 1),
				parent_path = CASE WHEN path = $2 THEN $4 ELSE $3 || substring(parent_path from length($2) + 1) END,
				name = CASE WHEN path = $2 THEN $5 ELSE name END
			WHERE workspace_id = $1 AND (path = $2 OR left(path, length($2) + 1) = $2 || '/')
		`, [workspaceId, source, target, parentPath(target), basename(target)]);
		return changes;
	}

	async function mkdirEntries(connection, target, { opId, deviceId, at, key }) {
		const existing = await findEntry(connection, target);
		if (existing?.kind === directory) {
			return [];
		}
		if (existing) {
			throw new WorkspaceError(409, 'FileExists');
		}
		await requiredEntry(connection, parentPath(target), directory);
		const row = await addEntry(connection, target, directory);
		return [await append(connection, {
			kind: 'directory.created',
			entryKind: directory,
			path: target,
			fileId: row.file_id,
			revisionId: row.revision_id,
			opId,
			deviceId,
			at,
			...keyFields(key),
		})];
	}

	async function rollbackEntries(connection, target, revision, expectedEtag, { opId, deviceId, at, key }) {
		const current = await requiredEntry(connection, target, file);
		if (!ifMatchHolds(expectedEtag, etag(current.revision_id))) {
			// §8 has no rollback-specific stale rule, so the mount endpoint's 412 is reused:
			// nothing was written, which is exactly what 412 promises.
			throw new WorkspaceError(412, 'FileChanged');
		}
		const result = await writeVersion(connection, target, current, { digest: revision.sha256, size: Number(revision.size_bytes) });
		const change = await append(connection, {
			// §9.11: the stream carries the NEW version id, so a peer applies the rollback as an
			// ordinary save instead of a special case.
			kind: 'file.rolledback',
			entryKind: file,
			path: target,
			fileId: result.fileId,
			revisionId: result.revisionId,
			parentRevisionId: current.revision_id,
			sha256: revision.sha256,
			sizeBytes: Number(revision.size_bytes),
			opId,
			deviceId,
			at,
			...keyFields(key),
		});
		return { result, changes: [change] };
	}

	const close = async () => {
		blobs.close();
		await pool.end();
	};
	try {
		// One advisory lock covers both schema files, so two processes starting at once cannot
		// interleave the additive sync migration with the base schema (§2.1). The same module
		// runs standalone as `node apps/web/sync-migrate.mjs`.
		//
		// It runs only when a catalog probe says something is missing. The migration is not
		// harmless to run again: `ALTER TABLE .. ADD COLUMN IF NOT EXISTS` still requests
		// AccessExclusiveLock, so an unconditional call made every cold open a DDL request that
		// queued behind in-flight readers and then blocked every reader behind itself. The
		// probe reads catalogs only, so the common path takes no lock at all; a stale schema
		// still goes through the exclusive advisory lock and stays idempotent under contention.
		//
		// The probe checks every column, index and constraint sync-schema.sql declares, not just
		// "do the tables exist". The additive migration cannot repair a wrong type, default,
		// nullability or a dropped index, so a deviation it cannot fix is refused here: that
		// fails the open (and therefore the request that needed the workspace) with the exact
		// table and column named, instead of serving a half-migrated schema whose idempotency
		// index is gone and whose dropped columns 42703 on every sync call.
		await ensureStorageSchema(pool);
		// The search tables are additive derived data, so they are migrated on their own
		// probe+lazy path instead of joining sync-schema.sql: that file's contract promises a
		// rollback to the previous release stays readable, and the search tables are new.
		await ensureSearchSchema(pool);
		if (!importing) {
			await ensureWorkspace(pool);
		}
	} catch (error) {
		await close();
		throw error;
	}

	function readable(row) {
		const stat = describe(row);
		return {
			...stat,
			stream: range => blobs.read(row.sha256, stat.size, range),
			close: () => {},
		};
	}

	/**
	 * The scope the index worker needs: a read entry point, the workspace ID and a write
	 * transaction. The worker never opens its own connection, so a drain during a search
	 * request reuses this backend's pool instead of adding a second one.
	 */
	const indexScope = {
		backend: {
			openRead: async path => readable(await requiredEntry(pool, normalizeWorkspacePath(path), file)),
		},
		workspaceId,
		withTransaction: action => transaction(action),
	};

	return {
		close,

		async importDirectory(root, maxBytes) {
			if (!importing) {
				throw new Error('Open the destination workspace in import mode.');
			}
			const counts = { files: 0, directories: 0, bytes: 0, skipped: 0 };
			await transaction(async connection => {
				const result = await connection.query(`
					INSERT INTO ${workspaces} VALUES ($1, $2) ON CONFLICT DO NOTHING
				`, [workspaceId, Date.now()]);
				if (result.rowCount !== 1) {
					throw new Error('The import destination already exists. Use a new workspace ID.');
				}
				async function importEntry(source, path) {
					const stat = await lstat(source);
					const time = { created: Math.trunc(stat.birthtimeMs || stat.ctimeMs), modified: Math.trunc(stat.mtimeMs) };
					if (stat.isDirectory()) {
						await addEntry(connection, path, directory, time);
						counts.directories++;
						for (const name of (await readdir(source)).sort()) {
							await importEntry(join(source, name), normalizeWorkspacePath(path + '/' + name));
						}
					} else if (stat.isFile()) {
						const stream = createReadStream(source);
						try {
							const blob = await blobs.put(stream, maxBytes);
							await writeVersion(connection, path, undefined, blob, time);
							counts.files++;
							counts.bytes += blob.size;
						} finally {
							stream.destroy();
						}
					} else {
						counts.skipped++;
					}
				}
				await importEntry(root, '/');
			});
			return counts;
		},

		async stat(path) {
			return describe(await requiredEntry(pool, normalizeWorkspacePath(path)));
		},

		async readDirectory(path) {
			const target = normalizeWorkspacePath(path);
			await requiredEntry(pool, target, directory);
			const { rows } = await pool.query(`
				SELECT name, kind AS type FROM ${entries} WHERE workspace_id = $1 AND parent_path = $2 ORDER BY name
			`, [workspaceId, target]);
			return rows;
		},

		async listFiles(path, pattern, limit) {
			const target = normalizeWorkspacePath(path);
			await requiredEntry(pool, target, directory);
			const prefix = target === '/' ? '/' : target + '/';
			const { rows } = await pool.query(`
				SELECT path FROM ${entries}
				WHERE workspace_id = $1 AND kind = 1 AND left(path, length($2)) = $2
					AND strpos(lower(path), lower($3)) > 0
				ORDER BY path LIMIT $4
			`, [workspaceId, prefix, pattern, limit]);
			return rows.map(row => row.path);
		},

		async openRead(path) {
			return readable(await requiredEntry(pool, normalizeWorkspacePath(path), file));
		},

		async listVersions(path) {
			const current = await requiredEntry(pool, normalizeWorkspacePath(path), file);
			const { rows } = await pool.query(`
				WITH RECURSIVE history AS (
					SELECT revision_id, parent_revision_id, size_bytes, created_ms, 0 AS depth
					FROM ${versions} WHERE workspace_id = $1 AND file_id = $2 AND revision_id = $3
					UNION ALL
					SELECT v.revision_id, v.parent_revision_id, v.size_bytes, v.created_ms, h.depth + 1
					FROM ${versions} v JOIN history h ON v.revision_id = h.parent_revision_id
					WHERE v.workspace_id = $1 AND v.file_id = $2
				)
				SELECT * FROM history ORDER BY depth
			`, [workspaceId, current.file_id, current.revision_id]);
			return rows.map(row => ({
				id: row.revision_id,
				createdAt: Number(row.created_ms),
				size: Number(row.size_bytes),
				current: row.depth === 0,
				initial: row.parent_revision_id === null,
			}));
		},

		async openRevision(path, id) {
			const current = await requiredEntry(pool, normalizeWorkspacePath(path), file);
			const revision = await findRevision(pool, current, id);
			return readable({ ...revision, kind: file, modified_ms: revision.created_ms });
		},

		async restoreRevision(path, id, expectedEtag) {
			const target = nonRoot(path);
			const original = await requiredEntry(pool, target, file);
			if (!ifMatchHolds(expectedEtag, etag(original.revision_id))) {
				throw new WorkspaceError(412, 'FileChanged');
			}
			const revision = await findRevision(pool, original, id);
			if (revision.revision_id === original.revision_id) {
				throw new WorkspaceError(409, 'RevisionIsCurrent');
			}
			await blobs.verify(revision.sha256, Number(revision.size_bytes));

			return transaction(async connection => {
				await ensureWorkspace(connection, true);
				const { result, changes } = await rollbackEntries(connection, target, revision, expectedEtag, { opId: randomUUID() });
				await maintain(connection, changes.at(-1).seq);
				return result;
			});
		},

		async listTrash() {
			const { rows } = await pool.query(`
				SELECT t.id, t.original_path AS path, t.deleted_ms, e.kind AS type
				FROM ${trash} t JOIN ${trashEntries} e ON e.trash_id = t.id AND e.path = t.original_path
				WHERE t.workspace_id = $1
				ORDER BY t.deleted_ms DESC NULLS LAST, t.original_path, t.id
			`, [workspaceId]);
			return rows.map(({ deleted_ms, ...item }) => ({ ...item, deletedAt: deleted_ms === null ? null : Number(deleted_ms) }));
		},

		async restoreTrash(id, keepBoth) {
			// Empty sync context: /static/mount has no idempotency key but must still append
			// the file.restored change, otherwise a mount-only client is invisible to sync.
			const { restored } = await restoreTrashEntries([id], keepBoth, {});
			return restored[0];
		},

		async restoreTrashBatch(ids) {
			const { restored } = await restoreTrashEntries(ids, false, {});
			return restored;
		},

		// --- incremental sync endpoints (docs/incremental-sync.md §8) --------------------
		// These are the methods the /sync/v1 handler drives. They are deliberately not part of
		// workspace-access.mjs's backendMethods table: authorization goes through
		// `facade.require(capability)` in the handler, using the existing capability names only.

		/** GET /sync/v1/changes — keyset page of the stream (§7.1, §8.4). */
		async syncChanges({ cursor, limit }) {
			// Window expiry outranks every other cursor complaint: an expired snapshot cursor and
			// a trimmed one both mean "throw the cursor away and re-snapshot" (§3.3).
			if (cursor) {
				requireLiveCursor(cursor, Date.now());
			}
			// An idle workspace never writes, so nothing else would ever collect its expired
			// snapshots (§7.2). This is the cheapest read path a polling client hits.
			await collectExpiredSnapshots();
			return readTransaction(async connection => {
				const head = await readHead(connection, workspaceId);
				// A missing cursor starts at retained_floor - 1 (§8.4). Reading the head inside
				// this transaction keeps the start point consistent with the page it produces.
				const fromSeq = cursor ? cursor.seq : head.retainedFloor - 1;
				// Semantic cursor checks come after the codec checks the handler already ran
				// (§3.3): both failures are 410 ResyncRequired, never a 200 empty page.
				requireRetainedCursor({ seq: fromSeq }, head.retainedFloor);
				requireHeadCursor({ seq: fromSeq }, head.seq);
				const page = await readChangesPage(connection, workspaceId, { fromSeq, limit });
				const last = page.changes.length ? page.changes.at(-1).seq : fromSeq;
				return {
					workspaceId,
					head: page.head,
					fromSeq,
					toSeq: last,
					changes: page.changes,
					hasMore: page.hasMore,
					cursor: encodeCursor({ workspaceId, kind: 'changes', seq: last }),
				};
			});
		},

		/** POST /sync/v1/snapshot — head seq and the whole tree from ONE view (§4.1, §4.2). */
		async syncSnapshot({ limit }) {
			const captured = await readTransaction(async connection => {
				const tree = await readTreeForSnapshot(connection, workspaceId);
				return tree;
			});
			if (captured.entries.length > syncRetention.maxSnapshotEntries) {
				throw new WorkspaceError(413, 'SnapshotTooLarge');
			}
			const now = Date.now();
			const snapshot = await transaction(async connection => {
				await ensureWorkspace(connection, false);
				await trimSnapshots(connection, workspaceId, now);
				return materializeSnapshot(connection, {
					workspaceId, seq: captured.seq, entries: captured.entries, nowMs: now,
				});
			});
			const entries = captured.entries.slice(0, limit).map(row => ({
				path: row.path,
				kind: row.kind,
				fileId: row.file_id,
				revisionId: row.revision_id,
				sha256: row.sha256 ?? null,
				size: row.size_bytes === null || row.size_bytes === undefined ? null : Number(row.size_bytes),
				modifiedAt: Number(row.modified_ms),
			}));
			return {
				snapshotId: snapshot.snapshotId,
				workspaceId,
				seq: snapshot.seq,
				entryCount: snapshot.entryCount,
				expiresAt: snapshot.expiresMs,
				cursor: encodeCursor({ workspaceId, kind: 'snapshot', seq: snapshot.seq, expiresMs: snapshot.expiresMs }),
				entries,
				pageToken: entries.length ? encodePageToken({ snapshotId: snapshot.snapshotId, lastPath: entries.at(-1).path }) : null,
				hasMore: captured.entries.length > limit,
			};
		},

		/** GET /sync/v1/snapshot/:id — pages only the materialized copy (§4.3). */
		async syncSnapshotPage({ snapshotId, lastPath, limit }) {
			return readTransaction(async connection => {
				const page = await readSnapshotPage(connection, workspaceId, { snapshotId, lastPath, limit });
				return {
					...page,
					pageToken: page.hasMore ? encodePageToken({ snapshotId, lastPath: page.lastPath }) : null,
				};
			});
		},

		/**
		 * PUT /sync/v1/file — the conflict-copy write path (§6).
		 *
		 * Order inside the transaction is fixed by §5.2: workspace row lock, idempotency
		 * lookup, THEN storage. A replay returns the stored result and writes nothing.
		 */
		async syncPutFile({ path, mode, baseRevision, idempotencyKey, device, source, maxBytes }) {
			const target = nonRoot(path);
			const blob = await blobs.put(source, maxBytes);
			// The fingerprint covers the streamed digest and size, so it can only be computed
			// after the object store has accepted the bytes (§5.2 field order). Putting the bytes
			// first is safe: the store is content-addressed, so a retry rewrites nothing.
			// `mode` is part of the identity: create and save against the same digest are two
			// different requests, and a create whose key got reused by a save must be refused
			// instead of replayed with the create's answer.
			const fingerprint = idempotencyFingerprint({
				method: 'PUT', path: target, baseRevision, digest: blob.digest, size: blob.size, device, mode,
			});
			const answered = await replayFirst({ idempotencyKey, fingerprint });
			if (answered) {
				// A retry always answers 200 (§5.2 as implemented: replayed is an ordinary
				// success carrying the stored result, whatever the first attempt's status was),
				// and it renders the same body the first attempt produced.
				const conflicted = answered.changes.some(row => row.kind === 'file.conflicted');
				return {
					status: 200,
					body: conflicted ? conflictBody(answered.changes, true) : uploadBody(answered.changes.at(-1), true),
				};
			}
			// Only now may the request be judged against current state.
			await requiredEntry(pool, parentPath(target), directory);
			const replayed = await transaction(async connection => {
				await ensureWorkspace(connection, true);
				const previousAttempt = await replayChanges(connection, workspaceId, { idempotencyKey, fingerprint });
				if (previousAttempt) {
					// A replay reports the stored result verbatim: same status class, same seq,
					// same change ids, same copy name. Nothing is written (§5.2).
					return replayResponse(previousAttempt);
				}
				const current = await findEntry(connection, target);
				if (current?.kind === directory) {
					throw new WorkspaceError(400, 'FileIsADirectory');
				}
				const matchesBase = current !== undefined && current.revision_id === baseRevision;
				const normal = mode === 'create' ? current === undefined : matchesBase;
				const now = Date.now();
				const opId = randomUUID();
				if (normal) {
					const result = await writeVersion(connection, target, current, blob, { modified: now });
					const change = await append(connection, {
						kind: result.created ? 'file.created' : 'file.saved',
						entryKind: file,
						path: target,
						fileId: result.fileId,
						revisionId: result.revisionId,
						parentRevisionId: current?.revision_id ?? null,
						sha256: blob.digest,
						sizeBytes: blob.size,
						deviceId: device,
						idempotencyKey,
						idempotencyFingerprint: fingerprint,
						baseRevision,
						opId,
						at: now,
					});
					await maintain(connection, change.seq);
					return { replayed: false, created: result.created, changes: [change], opId };
				}
				// A conflict keeps BOTH versions: the client's bytes land in a conflict copy and
				// the original path is never overwritten (§6.1). Two changes, because the client
				// needs to know what the original path is now AND where its content went.
				// Reading the incumbent names inside the locked transaction keeps two concurrent
				// saves from picking the same conflict name.
				const taken = await conflictCandidates(connection, target, device, now);
				const copyPath = nextConflictPath(target, {
					device,
					// The timestamp is this first attempt's clock, not a retry's, so the name is
					// reproducible; the idempotency key makes sure there is no second attempt.
					timestampMs: now,
					isTaken: candidate => taken.has(candidate),
				});
				const copy = await writeVersion(connection, copyPath, undefined, blob, { modified: now });
				const saved = await append(connection, {
					kind: 'file.saved',
					entryKind: file,
					path: copyPath,
					fileId: copy.fileId,
					revisionId: copy.revisionId,
					sha256: blob.digest,
					sizeBytes: blob.size,
					deviceId: device,
					opId,
					at: now,
				});
				const conflicted = await append(connection, {
					kind: 'file.conflicted',
					entryKind: file,
					path: target,
					conflictPath: copyPath,
					// The surviving artifact of a conflict is the copy, so the row points at it.
					fileId: copy.fileId,
					revisionId: copy.revisionId,
					parentRevisionId: current?.revision_id ?? null,
					sha256: blob.digest,
					sizeBytes: blob.size,
					deviceId: device,
					idempotencyKey,
					idempotencyFingerprint: fingerprint,
					baseRevision,
					opId,
					at: now,
				});
				await maintain(connection, conflicted.seq);
				return { replayed: false, created: true, changes: [saved, conflicted], opId, conflict: true };
			});
			return {
				status: replayed.replayed ? 200 : (replayed.conflict ? 409 : (replayed.created ? 201 : 200)),
				body: replayed.conflict
					? conflictBody(replayed.changes, replayed.replayed)
					: uploadBody(replayed.changes.at(-1), replayed.replayed),
			};
		},

		/** DELETE /sync/v1/file — trash a path, one change per removed entry (§8.6). */
		async syncDelete({ path, recursive, idempotencyKey, fingerprint, device }) {
			const target = nonRoot(path);
			return transaction(async connection => {
				await ensureWorkspace(connection, true);
				const replay = idempotencyKey
					? await replayChanges(connection, workspaceId, { idempotencyKey, fingerprint })
					: undefined;
				if (replay) {
					return { status: 200, body: batchBody(replay.changes, true, changes => ({ trashId: changes[0].trashId })) };
				}
				const key = { idempotencyKey, fingerprint };
				const changes = await deleteEntries(connection, target, { recursive, opId: randomUUID(), deviceId: device, key });
				await maintain(connection, changes.at(-1).seq);
				return { status: 200, body: batchBody(changes, false, () => ({ trashId: changes[0].trashId })) };
			});
		},

		/** POST /sync/v1/rename — one change for the whole subtree (§8.6, §9.10). */
		async syncRename({ from, to, overwrite, idempotencyKey, fingerprint, device }) {
			const source = nonRoot(from);
			const target = nonRoot(to);
			return transaction(async connection => {
				await ensureWorkspace(connection, true);
				const replay = idempotencyKey
					? await replayChanges(connection, workspaceId, { idempotencyKey, fingerprint })
					: undefined;
				if (replay) {
					return { status: 200, body: batchBody(replay.changes, true, () => ({ path: replay.changes.at(-1).path, fromPath: source })) };
				}
				const key = { idempotencyKey, fingerprint };
				const changes = await renameEntries(connection, source, target, { overwrite, opId: randomUUID(), deviceId: device, key });
				if (!changes.length) {
					// source === target: nothing changed, so nothing is appended and no seq is spent.
					return { status: 200, body: { ...noChangeBody(target), fromPath: source } };
				}
				await maintain(connection, changes.at(-1).seq);
				return { status: 200, body: batchBody(changes, false, changes => ({ path: changes.at(-1).path, fromPath: source })) };
			});
		},

		/** POST /sync/v1/mkdir — directory.created, 201 on the first attempt (§8.6). */
		async syncMkdir({ path, idempotencyKey, fingerprint, device }) {
			const target = nonRoot(path);
			return transaction(async connection => {
				await ensureWorkspace(connection, true);
				const replay = idempotencyKey
					? await replayChanges(connection, workspaceId, { idempotencyKey, fingerprint })
					: undefined;
				if (replay) {
					// §5.2: a replay is an ordinary success that says "this already happened", so it
					// answers 200 whatever the first attempt's status was. mkdir was the one route
					// that echoed its 201 here, which made the replay indistinguishable from a new
					// creation for a client that only looks at the status line.
					return { status: 200, body: batchBody(replay.changes, true, () => ({ path: replay.changes.at(-1).path })) };
				}
				const changes = await mkdirEntries(connection, target, { opId: randomUUID(), deviceId: device, key: { idempotencyKey, fingerprint } });
				if (!changes.length) {
					// Already a directory: createDirectory() is idempotent and spends no seq.
					// Reporting the head seq here would let a client move its cursor past other
					// people's changes, and `changeId: null` next to `replayed: false` is not a
					// state a client can act on, so a no-op answers "nothing changed" — the same
					// shape rename uses when source === target (§8.6).
					return { status: 201, body: noChangeBody(target) };
				}
				await maintain(connection, changes.at(-1).seq);
				return { status: 201, body: batchBody(changes, false, () => ({ path: target })) };
			});
		},

		/** POST /sync/v1/restore — file.restored per entry, still `workspace.restore` (§8.1). */
		async syncRestore({ trashId, keepBoth, idempotencyKey, fingerprint, device }) {
			const key = idempotencyKey ? { idempotencyKey, fingerprint } : {};
			const result = await restoreTrashEntries([trashId], keepBoth, { ...key, device });
			const changes = result.changes;
			return {
				status: 200,
				body: batchBody(changes, result.replayed, changes => ({
					restored: result.restored.map(item => item.path),
					paths: changes.map(change => change.path),
				})),
			};
		},

		/** POST /sync/v1/rollback — file.rolledback with the NEW revision id (§8.6, §9.11). */
		async syncRollback({ path, revisionId, baseRevision, idempotencyKey, fingerprint, device }) {
			const target = nonRoot(path);
			const answered = await replayFirst({ idempotencyKey, fingerprint });
			if (answered) {
				return { status: 200, body: batchBody(answered.changes, true, changes => ({ path: changes.at(-1).path })) };
			}
			const original = await requiredEntry(pool, target, file);
			const revision = await findRevision(pool, original, revisionId);
			if (revision.revision_id === original.revision_id) {
				throw new WorkspaceError(409, 'RevisionIsCurrent');
			}
			await blobs.verify(revision.sha256, Number(revision.size_bytes));
			return transaction(async connection => {
				await ensureWorkspace(connection, true);
				const replay = idempotencyKey
					? await replayChanges(connection, workspaceId, { idempotencyKey, fingerprint })
					: undefined;
				if (replay) {
					return { status: 200, body: batchBody(replay.changes, true, changes => ({ path: changes.at(-1).path })) };
				}
				const { result, changes } = await rollbackEntries(
					connection, target, revision, etag(baseRevision), {
						opId: randomUUID(), deviceId: device, key: { idempotencyKey, fingerprint },
					},
				);
				await maintain(connection, changes.at(-1).seq);
				return {
					status: 200,
					body: batchBody(changes, false, () => ({
						path: target,
						fileId: result.fileId,
						revisionId: result.revisionId,
						size: result.size,
						etag: result.etag,
					})),
				};
			});
		},

		/** GET /sync/v1/conflicts — file.conflicted rows whose copy still exists (§8.7). */
		async syncConflicts({ cursor, limit }) {
			if (cursor) {
				requireLiveCursor(cursor, Date.now());
			}
			return readTransaction(async connection => {
				const head = await readHead(connection, workspaceId);
				const fromSeq = cursor ? cursor.seq : head.retainedFloor - 1;
				// Same three semantic checks as the change stream (§3.3): a paginated read must
				// never answer 200 with an empty page for a position it cannot serve.
				requireRetainedCursor({ seq: fromSeq }, head.retainedFloor);
				requireHeadCursor({ seq: fromSeq }, head.seq);
				const { rows } = await connection.query(`
					SELECT c.* FROM ${changesTable} c
					JOIN ${entries} e ON e.workspace_id = c.workspace_id AND e.path = c.conflict_path
					WHERE c.workspace_id = $1 AND c.kind = 'file.conflicted' AND c.seq > $2
					ORDER BY c.seq
					LIMIT $3
				`, [workspaceId, fromSeq, limit + 1]);
				const hasMore = rows.length > limit;
				const page = rows.slice(0, limit).map(changeJson);
				const last = page.length ? page.at(-1).seq : fromSeq;
				return {
					conflicts: page.map(row => ({
						changeId: row.changeId,
						seq: row.seq,
						path: row.path,
						conflictPath: row.conflictPath,
						fileId: row.fileId,
						revisionId: row.revisionId,
						deviceId: row.deviceId,
						at: row.at,
						// Deleting the copy is the documented way to resolve a conflict (§8.7).
						resolved: false,
					})),
					hasMore,
					cursor: encodeCursor({ workspaceId, kind: 'changes', seq: last }),
				};
			});
		},

		/** GET /sync/v1/conflict?path= — one conflict copy's detail (§8.7). */
		async syncConflict({ path }) {
			const { rows } = await readTransaction(connection => connection.query(`
				SELECT * FROM ${changesTable}
				WHERE workspace_id = $1 AND kind = 'file.conflicted' AND conflict_path = $2
				ORDER BY seq DESC LIMIT 1
			`, [workspaceId, path]));
			if (!rows.length) {
				throw new WorkspaceError(404, 'FileNotFound');
			}
			const row = changeJson(rows[0]);
			return {
				changeId: row.changeId,
				seq: row.seq,
				path: row.path,
				conflictPath: row.conflictPath,
				fileId: row.fileId,
				revisionId: row.revisionId,
				originalRevisionId: row.parentRevisionId,
				baseRevision: row.baseRevision,
				deviceId: row.deviceId,
				at: row.at,
			};
		},

		// --- full text search (docs: task 01 全文搜索) ----------------------------------
		// These are driven by /search/v1. The handler takes the capability from the search
		// route table and calls `facade.require()` before any of this runs, exactly like the
		// sync methods above.

		async searchStatus() {
			return indexStatus(indexScope);
		},

		/**
		 * GET /search/v1/query. The queue is drained first so a search that arrives right
		 * after a save sees it, but the drain is bounded and best effort: a file that cannot
		 * be read right now must not turn a read into a 500, so failures are swallowed and
		 * the job stays queued for the next drain.
		 *
		 * `limit + 1` is read so `hasMore` does not need a second query, and the total is a
		 * separate capped count because paging must not pay for it.
		 */
		async searchDocuments({ query, cursor, limit = searchLimits.defaultLimit }) {
			// The HTTP layer normalizes the page size before it gets here, but the backend is
			// also called directly (tests, future clients), so it clamps again rather than
			// letting an undefined limit reach SQL as NaN.
			const pageSize = Number.isSafeInteger(limit) && limit >= 1
				? Math.min(limit, searchLimits.maxLimit)
				: searchLimits.defaultLimit;
			await drainIndexJobs(indexScope, { maxJobs: 25 }).catch(() => {});
			return readTransaction(async connection => {
				const state = await readIndexState(connection, workspaceId);
				const after = cursor
					? decodeSearchCursor(cursor, { workspaceId, generation: state.generation, query })
					: undefined;
				const needle = searchMatchText(query);
				const [{ rows, hasMore }, total] = await Promise.all([
					queryDocuments(connection, { workspaceId, needle, after, limit: pageSize }),
					countDocuments(connection, { workspaceId, needle }),
				]);
				const items = rows.map(row => matchFromRow(row, query));
				const last = rows.at(-1);
				return {
					items,
					total,
					hasMore,
					nextCursor: hasMore && last
						? encodeSearchCursor({
							workspaceId, generation: state.generation, query, path: last.path, fileId: last.fileId,
						})
						: null,
					indexGeneration: state.generation,
					indexedAt: state.indexedMs,
				};
			});
		},

		/**
		 * POST /search/v1/reindex. Bumps the generation, empties the derived copy and
		 * re-queues every current file, all in one transaction; the refill then runs inline
		 * so the workspace is searchable again when this returns.
		 */
		async reindexWorkspace() {
			return rebuildWorkspaceIndex(indexScope);
		},
		// --- end full text search --------------------------------------------------------

		async writeFile(path, source, options) {
			const target = nonRoot(path);
			async function check(connection) {
				await requiredEntry(connection, parentPath(target), directory);
				const previous = await findEntry(connection, target);
				if (previous?.kind === directory) {
					throw new WorkspaceError(400, 'FileIsADirectory');
				}
				if (previous && !options.overwrite) {
					throw new WorkspaceError(409, 'FileExists');
				}
				if (previous ? !ifMatchHolds(options.etag, etag(previous.revision_id)) : Boolean(options.etag)) {
					throw new WorkspaceError(412, 'FileChanged');
				}
				if (!previous && !options.create) {
					throw new WorkspaceError(404, 'FileNotFound');
				}
				return previous;
			}
			await check(pool);
			const blob = await blobs.put(source, options.maxBytes);
			return transaction(async connection => {
				await ensureWorkspace(connection, true);
				const previous = await check(connection);
				const now = Date.now();
				const result = await writeVersion(connection, target, previous, blob, { modified: now });
				// /static/mount keeps its 412/409 semantics but still feeds the stream, so a
				// device that only ever used the old endpoint is still visible to sync clients.
				const change = await append(connection, {
					kind: result.created ? 'file.created' : 'file.saved',
					entryKind: file,
					path: target,
					fileId: result.fileId,
					revisionId: result.revisionId,
					parentRevisionId: previous?.revision_id ?? null,
					sha256: blob.digest,
					sizeBytes: blob.size,
					at: now,
				});
				await maintain(connection, change.seq);
				return result;
			});
		},

		createDirectory(path) {
			const target = normalizeWorkspacePath(path);
			return transaction(async connection => {
				await ensureWorkspace(connection, true);
				const changes = await mkdirEntries(connection, target, { opId: randomUUID() });
				if (changes.length) {
					await maintain(connection, changes.at(-1).seq);
				}
			});
		},

		rename(from, to, overwrite) {
			const source = nonRoot(from);
			const target = nonRoot(to);
			return transaction(async connection => {
				await ensureWorkspace(connection, true);
				const changes = await renameEntries(connection, source, target, { overwrite, opId: randomUUID() });
				if (changes.length) {
					await maintain(connection, changes.at(-1).seq);
				}
			});
		},

		delete(path, recursive, trashId) {
			const target = nonRoot(path);
			if (trashId !== undefined && !uuidPattern.test(trashId)) {
				throw new WorkspaceError(400, 'InvalidTrashId');
			}
			return transaction(async connection => {
				await ensureWorkspace(connection, true);
				// §8.6: a recursive delete reports every removed path, each with its own seq, all
				// sharing one opId so a client can apply the group atomically.
				const changes = await deleteEntries(connection, target, { recursive, trashId, opId: randomUUID() });
				await maintain(connection, changes.at(-1).seq);
			});
		},
	};
}
