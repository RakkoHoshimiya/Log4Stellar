import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { migrationLockId } from './sync-migrate.mjs';
import { syncRetention } from './sync-contract.mjs';
import { WorkspaceError } from './workspace-contract.mjs';

// PostgreSQL access for the object-storage collector (task 06, 存储对象清理).
//
// Two things live here, both deliberately narrow:
//   1. migrateBlobGcSchema: applies blob-gc-schema.sql under the same advisory lock
//      sync-migrate.mjs uses, so the collector and a starting server cannot interleave.
//   2. createBlobGcStore: every query the collector needs, taking no transaction of its
//      own unless the method is documented to own one.
//
// The reference test is the safety-critical query. It answers "may this object still be
// needed by someone?" from all seven sources, and it is the only place that decides.

const schemaSql = await readFile(new URL('./blob-gc-schema.sql', import.meta.url), 'utf8');

export const blobGcTables = Object.freeze({
	runs: 'log4stellar.gc_runs',
	candidates: 'log4stellar.gc_candidates',
	intents: 'log4stellar.blob_write_intents',
	holds: 'log4stellar.blob_holds',
});

/** The storage tables the reference test reads, with the exact columns it uses. */
export const blobGcReferenceSources = Object.freeze([
	{
		source: 'log4stellar.storage_file_versions',
		columns: ['workspace_id', 'sha256'],
		meaning: 'a retained version row still names the object, whether or not an entry points at it',
	},
	{
		source: 'log4stellar.storage_entries',
		columns: ['workspace_id', 'file_id', 'revision_id'],
		meaning: 'a visible file or directory entry, joined to its version to reach the digest',
	},
	{
		source: 'log4stellar.storage_trash_entries',
		columns: ['trash_id', 'file_id', 'revision_id'],
		meaning: 'a file sitting in the recycle bin; restorable, therefore referenced',
	},
	{
		source: 'log4stellar.storage_snapshots',
		columns: ['workspace_id', 'expires_ms'],
		meaning: 'only snapshots whose expires_ms is still in the future are "active"',
	},
	{
		source: 'log4stellar.storage_snapshot_entries',
		columns: ['snapshot_id', 'sha256'],
		meaning: 'the pinned entry set of an active snapshot',
	},
	{
		source: 'log4stellar.storage_changes',
		columns: ['workspace_id', 'sha256', 'created_ms'],
		meaning: 'an incremental change still replayable by a client inside changesTtlMs',
	},
	{
		source: 'log4stellar.blob_write_intents',
		columns: ['workspace_id', 'digest', 'expires_ms'],
		meaning: 'a writer that registered its upload and has not released it yet',
	},
	{
		source: 'log4stellar.blob_holds',
		columns: ['digest', 'workspace_id', 'expires_ms'],
		meaning: 'an explicit hold: a verified backup, or an operator pin. expires_ms NULL = forever',
	},
]);

/**
 * The reference test. $1 workspace id, $2 digest, $3 now in ms, $4 the oldest change
 * stamp still replayable (now - syncRetention.changesTtlMs).
 *
 * It returns one boolean per source plus `referenced`, so a caller can explain *why*
 * an object is protected instead of guessing. Deliberately a single statement: all
 * seven checks see one snapshot of the database, so a writer committing between two
 * separate queries cannot slip between them.
 */
export const referenceSql = `
WITH version_hit AS (
	SELECT 1 FROM log4stellar.storage_file_versions
	 WHERE workspace_id = $1 AND sha256 = $2
), entry_hit AS (
	SELECT 1 FROM log4stellar.storage_entries e
	 JOIN log4stellar.storage_file_versions v
	   ON v.workspace_id = e.workspace_id AND v.file_id = e.file_id AND v.revision_id = e.revision_id
	 WHERE e.workspace_id = $1 AND v.sha256 = $2
), trash_hit AS (
	SELECT 1 FROM log4stellar.storage_trash t
	 JOIN log4stellar.storage_trash_entries te ON te.trash_id = t.id
	 JOIN log4stellar.storage_file_versions v
	   ON v.workspace_id = t.workspace_id AND v.file_id = te.file_id AND v.revision_id = te.revision_id
	 WHERE t.workspace_id = $1 AND v.sha256 = $2
), snapshot_hit AS (
	SELECT 1 FROM log4stellar.storage_snapshots s
	 JOIN log4stellar.storage_snapshot_entries se ON se.snapshot_id = s.id
	 WHERE s.workspace_id = $1 AND se.sha256 = $2 AND s.expires_ms > $3
), change_hit AS (
	SELECT 1 FROM log4stellar.storage_changes c
	 WHERE c.workspace_id = $1 AND c.sha256 = $2 AND c.created_ms > $4
), intent_hit AS (
	SELECT 1 FROM log4stellar.blob_write_intents i
	 WHERE i.workspace_id = $1 AND i.digest = $2 AND i.expires_ms > $3
), hold_hit AS (
	SELECT 1 FROM log4stellar.blob_holds h
	 WHERE h.digest = $2 AND (h.workspace_id IS NULL OR h.workspace_id = $1)
	   AND (h.expires_ms IS NULL OR h.expires_ms > $3)
)
SELECT
	EXISTS (SELECT 1 FROM version_hit) AS versions,
	EXISTS (SELECT 1 FROM entry_hit) AS entries,
	EXISTS (SELECT 1 FROM trash_hit) AS trash,
	EXISTS (SELECT 1 FROM snapshot_hit) AS snapshots,
	EXISTS (SELECT 1 FROM change_hit) AS changes,
	EXISTS (SELECT 1 FROM intent_hit) AS intents,
	EXISTS (SELECT 1 FROM hold_hit) AS holds
`;

function referenceResult(row) {
	const sources = {
		versions: row.versions === true,
		entries: row.entries === true,
		trash: row.trash === true,
		snapshots: row.snapshots === true,
		changes: row.changes === true,
		intents: row.intents === true,
		holds: row.holds === true,
	};
	return {
		referenced: Object.values(sources).some(Boolean),
		sources,
		// Why it is protected, without ever naming an object key.
		blockers: Object.entries(sources).filter(([, hit]) => hit).map(([name]) => name),
	};
}

export function blankReference() {
	return {
		referenced: false,
		sources: {
			versions: false, entries: false, trash: false,
			snapshots: false, changes: false, intents: false, holds: false,
		},
		blockers: [],
	};
}

function candidateJson(row) {
	return {
		workspaceId: row.workspace_id,
		digest: row.digest,
		objectVersion: row.object_version ?? null,
		sizeBytes: Number(row.size_bytes),
		runId: row.run_id ?? null,
		state: row.state,
		reason: row.reason,
		firstSeenMs: Number(row.first_seen_ms),
		eligibleAfterMs: Number(row.eligible_after_ms),
		updatedMs: Number(row.updated_ms),
		recoveryPath: row.recovery_path ?? null,
		lastError: row.last_error ?? null,
	};
}

function runJson(row) {
	return {
		runId: row.run_id,
		scope: row.scope,
		mode: row.mode,
		dryRun: row.dry_run === true,
		state: row.state,
		inventoryCursor: row.inventory_cursor ?? null,
		candidateCount: Number(row.candidate_count),
		candidateBytes: Number(row.candidate_bytes),
		deletedCount: Number(row.deleted_count),
		deletedBytes: Number(row.deleted_bytes),
		startedMs: Number(row.started_ms),
		updatedMs: Number(row.updated_ms),
	};
}

/**
 * Applies blob-gc-schema.sql. Idempotent and serialised with every other storage
 * migration, because it takes migrationLockId for the duration of the DDL.
 */
export async function migrateBlobGcSchema(pool) {
	const connection = await pool.connect();
	try {
		await connection.query('BEGIN');
		await connection.query('SELECT pg_advisory_xact_lock($1)', [migrationLockId]);
		await connection.query(schemaSql);
		await connection.query('COMMIT');
	} catch (error) {
		await connection.query('ROLLBACK').catch(() => {});
		throw error;
	} finally {
		connection.release();
	}
}

// A second advisory-lock class for per-object mutual exclusion. The migration lock is
// class 0 through the single-argument form, so these two never collide.
const candidateLockClass = 0x4743; // 'GC'

/**
 * The collector's PostgreSQL access.
 *
 * @param {import('pg').Pool} pool a pool already pointed at the storage database.
 * @param {{migrate?: boolean}} [options] migrate defaults to true; tests that build the
 *   schema themselves may skip it.
 */
export function createBlobGcStore(pool, { migrate = true } = {}) {
	let migrated = null;
	function shape() {
		migrated ??= migrate ? migrateBlobGcSchema(pool) : Promise.resolve();
		return migrated;
	}

	async function query(text, parameters) {
		await shape();
		return pool.query(text, parameters);
	}

	/**
	 * Runs `action(connection)` in a read-only repeatable-read transaction, holding a
	 * shared storage-migration lock so the DDL cannot change underneath it.
	 */
	async function readTransaction(action) {
		await shape();
		const connection = await pool.connect();
		try {
			await connection.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
			await connection.query('SELECT pg_advisory_xact_lock_shared($1)', [migrationLockId]);
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
	 * Runs `action(connection)` in a read-write transaction. When `lockKey` is given the
	 * transaction first takes the per-object advisory lock, which is the fence the task
	 * book asks for: a second collector working the same object waits, and a writer that
	 * registered an intent is visible to whoever holds the lock.
	 *
	 * @param {(connection: import('pg').PoolClient) => Promise<any>} action
	 * @param {{lockKey?: string}} [options]
	 */
	async function writeTransaction(action, { lockKey } = {}) {
		await shape();
		const connection = await pool.connect();
		try {
			await connection.query('BEGIN');
			await connection.query('SELECT pg_advisory_xact_lock_shared($1)', [migrationLockId]);
			if (lockKey) {
				await connection.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [
					candidateLockClass, lockKey,
				]);
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

	async function beginRun({ scope, mode, dryRun, startedMs }) {
		const runId = randomUUID();
		const { rows } = await query(
			`INSERT INTO ${blobGcTables.runs} (run_id, scope, mode, dry_run, state, started_ms, updated_ms)
			 VALUES ($1, $2, $3, $4, 'planned', $5, $5) RETURNING *`,
			[runId, scope, mode, dryRun === true, startedMs],
		);
		return runJson(rows[0]);
	}

	async function readRun(runId) {
		const { rows } = await query(`SELECT * FROM ${blobGcTables.runs} WHERE run_id = $1`, [runId]);
		return rows[0] ? runJson(rows[0]) : null;
	}

	/** Absolute counter writes; omitted keys keep their current value. */
	async function updateRun(runId, patch) {
		const { rows } = await query(
			`UPDATE ${blobGcTables.runs} SET
				state = COALESCE($2, state),
				inventory_cursor = COALESCE($3, inventory_cursor),
				candidate_count = COALESCE($4, candidate_count),
				candidate_bytes = COALESCE($5, candidate_bytes),
				deleted_count = COALESCE($6, deleted_count),
				deleted_bytes = COALESCE($7, deleted_bytes),
				updated_ms = $8
			 WHERE run_id = $1 RETURNING *`,
			[
				runId,
				patch.state ?? null,
				patch.inventoryCursor ?? null,
				patch.candidateCount ?? null,
				patch.candidateBytes ?? null,
				patch.deletedCount ?? null,
				patch.deletedBytes ?? null,
				patch.updatedMs,
			],
		);
		return rows[0] ? runJson(rows[0]) : null;
	}

	/** Relative counter bump, so an interrupted apply keeps a truthful running total. */
	async function bumpRun(runId, { deletedCount = 0, deletedBytes = 0, updatedMs }) {
		await query(
			`UPDATE ${blobGcTables.runs}
			 SET deleted_count = deleted_count + $2, deleted_bytes = deleted_bytes + $3, updated_ms = $4
			 WHERE run_id = $1`,
			[runId, deletedCount, deletedBytes, updatedMs],
		);
	}

	async function findCandidate(workspaceId, digest) {
		const { rows } = await query(
			`SELECT * FROM ${blobGcTables.candidates} WHERE workspace_id = $1 AND digest = $2`,
			[workspaceId, digest],
		);
		return rows[0] ? candidateJson(rows[0]) : null;
	}

	/**
	 * Records an observation. A row already in flight (deleting/deleted/cancelled/failed)
	 * is reset to a fresh 'observed' cycle with a new first_seen, because seeing the
	 * object again means it has a new life of its own; keeping the old deadlines would
	 * delete a recreated object on the next sweep.
	 */
	async function observeCandidate({ workspaceId, digest, objectVersion, sizeBytes, runId, reason, firstSeenMs, eligibleAfterMs }) {
		const { rows } = await query(
			`INSERT INTO ${blobGcTables.candidates} AS c
				(workspace_id, digest, object_version, size_bytes, run_id, state, reason,
				 first_seen_ms, eligible_after_ms, updated_ms, recovery_path, last_error)
			 VALUES ($1, $2, $3, $4, $5, 'observed', $6, $7, $8, $7, NULL, NULL)
			 ON CONFLICT (workspace_id, digest) DO UPDATE SET
				object_version = EXCLUDED.object_version,
				size_bytes = EXCLUDED.size_bytes,
				run_id = EXCLUDED.run_id,
				reason = EXCLUDED.reason,
				updated_ms = EXCLUDED.updated_ms,
				recovery_path = NULL,
				last_error = NULL,
				state = 'observed',
				first_seen_ms = CASE
					WHEN c.state IN ('observed', 'eligible') THEN c.first_seen_ms
					ELSE EXCLUDED.first_seen_ms
				END,
				eligible_after_ms = CASE
					WHEN c.state IN ('observed', 'eligible') THEN c.eligible_after_ms
					ELSE EXCLUDED.eligible_after_ms
				END
			 WHERE c.state IN ('observed', 'eligible', 'deleting', 'deleted', 'cancelled', 'failed')
			 RETURNING *`,
			[workspaceId, digest, objectVersion ?? null, sizeBytes ?? 0, runId ?? null, reason, firstSeenMs, eligibleAfterMs],
		);
		return rows[0] ? candidateJson(rows[0]) : null;
	}

	/**
	 * Compare-and-set on the state column. Returns the updated row, or null when the
	 * candidate was not in one of the expected states — which is how a concurrent sweep
	 * loses the race and does nothing, instead of deleting twice.
	 */
	async function transitionCandidate({ workspaceId, digest, from, to, reason, recoveryPath, lastError, objectVersion, runId, updatedMs }) {
		const { rows } = await query(
			`UPDATE ${blobGcTables.candidates} SET
				state = $4,
				reason = COALESCE($5, reason),
				recovery_path = COALESCE($6, recovery_path),
				last_error = $7,
				object_version = COALESCE($8, object_version),
				run_id = COALESCE($9, run_id),
				updated_ms = $10
			 WHERE workspace_id = $1 AND digest = $2 AND state = ANY($3::text[])
			 RETURNING *`,
			[workspaceId, digest, from, to, reason ?? null, recoveryPath ?? null, lastError ?? null, objectVersion ?? null, runId ?? null, updatedMs],
		);
		return rows[0] ? candidateJson(rows[0]) : null;
	}

	/**
	 * Lists candidates in a workspace. `states` narrows by state, `eligibleByMs` keeps
	 * only rows whose grace period has elapsed.
	 */
	async function listCandidates(workspaceId, { states, eligibleByMs, limit = 100 } = {}) {
		const parameters = [workspaceId];
		let where = 'workspace_id = $1';
		if (states && states.length > 0) {
			parameters.push(states);
			where += ` AND state = ANY($${parameters.length}::text[])`;
		}
		if (eligibleByMs !== undefined) {
			parameters.push(eligibleByMs);
			where += ` AND eligible_after_ms <= $${parameters.length}`;
		}
		parameters.push(limit);
		const { rows } = await query(
			`SELECT * FROM ${blobGcTables.candidates} WHERE ${where}
			 ORDER BY first_seen_ms, digest LIMIT $${parameters.length}`,
			parameters,
		);
		return rows.map(candidateJson);
	}

	/** The counts a plan reports, without loading the rows. */
	async function candidateTotals(workspaceId) {
		const { rows } = await query(
			`SELECT state, count(*)::int AS candidates, COALESCE(sum(size_bytes), 0)::bigint AS bytes
			 FROM ${blobGcTables.candidates} WHERE workspace_id = $1 GROUP BY state`,
			[workspaceId],
		);
		const totals = {};
		for (const row of rows) {
			totals[row.state] = { candidates: Number(row.candidates), bytes: Number(row.bytes) };
		}
		return totals;
	}

	/**
	 * The reference test. Runs on the caller's connection when one is given, so it can
	 * share the sweep's transaction and its advisory lock.
	 */
	async function isReferenced(workspaceId, digest, { nowMs, connection } = {}) {
		const run = connection ? (text, parameters) => connection.query(text, parameters) : query;
		const { rows } = await run(referenceSql, [
			workspaceId,
			digest,
			nowMs,
			nowMs - syncRetention.changesTtlMs,
		]);
		return referenceResult(rows[0]);
	}

	async function listIntents(workspaceId, digest, nowMs) {
		const { rows } = await query(
			`SELECT writer_id, created_ms, expires_ms FROM ${blobGcTables.intents}
			 WHERE workspace_id = $1 AND digest = $2 AND expires_ms > $3 ORDER BY created_ms`,
			[workspaceId, digest, nowMs],
		);
		return rows.map((row) => ({
			writerId: row.writer_id,
			createdMs: Number(row.created_ms),
			expiresMs: Number(row.expires_ms),
		}));
	}

	async function registerIntent({ workspaceId, digest, writerId, createdMs, expiresMs }) {
		const { rows } = await query(
			`INSERT INTO ${blobGcTables.intents} (workspace_id, digest, writer_id, created_ms, expires_ms)
			 VALUES ($1, $2, $3, $4, $5)
			 ON CONFLICT (workspace_id, digest, writer_id)
			 DO UPDATE SET created_ms = EXCLUDED.created_ms, expires_ms = EXCLUDED.expires_ms
			 RETURNING created_ms, expires_ms`,
			[workspaceId, digest, writerId, createdMs, expiresMs],
		);
		return { createdMs: Number(rows[0].created_ms), expiresMs: Number(rows[0].expires_ms) };
	}

	async function releaseIntent({ workspaceId, digest, writerId }) {
		await query(
			`DELETE FROM ${blobGcTables.intents}
			 WHERE workspace_id = $1 AND digest = $2 AND writer_id = $3`,
			[workspaceId, digest, writerId],
		);
	}

	async function createHold({ scope, workspaceId, digest, reason, createdMs, expiresMs }) {
		const holdId = randomUUID();
		const { rows } = await query(
			`INSERT INTO ${blobGcTables.holds}
				(hold_id, scope, workspace_id, digest, reason, created_ms, expires_ms)
			 VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING hold_id`,
			[holdId, scope, workspaceId ?? null, digest, reason, createdMs, expiresMs ?? null],
		);
		return rows[0].hold_id;
	}

	async function releaseHold(holdId) {
		await query(`DELETE FROM ${blobGcTables.holds} WHERE hold_id = $1`, [holdId]);
	}

	async function listHolds(workspaceId, digest, nowMs) {
		const { rows } = await query(
			`SELECT hold_id, scope, workspace_id, digest, reason, created_ms, expires_ms
			 FROM ${blobGcTables.holds}
			 WHERE digest = $2 AND (workspace_id IS NULL OR workspace_id = $1)
			   AND (expires_ms IS NULL OR expires_ms > $3)
			 ORDER BY created_ms`,
			[workspaceId, digest, nowMs],
		);
		return rows.map((row) => ({
			holdId: row.hold_id,
			scope: row.scope,
			reason: row.reason,
			createdMs: Number(row.created_ms),
			expiresMs: row.expires_ms === null ? null : Number(row.expires_ms),
		}));
	}

	/** Deletes expired intent rows; they are noise once their deadline has passed. */
	async function pruneIntents({ nowMs, workspaceId }) {
		const { rowCount } = await query(
			`DELETE FROM ${blobGcTables.intents}
			 WHERE expires_ms <= $1 AND ($2::text IS NULL OR workspace_id = $2)`,
			[nowMs, workspaceId ?? null],
		);
		return rowCount ?? 0;
	}

	/** Every workspace that has to be scanned for a given scope. */
	async function workspacesForScope(scope) {
		if (typeof scope !== 'string') throw new WorkspaceError(400, 'invalid_scope');
		if (scope === 'all') {
			const { rows } = await query(
				'SELECT id FROM log4stellar.storage_workspaces ORDER BY id',
			);
			return rows.map((row) => row.id);
		}
		if (scope.startsWith('workspace:')) {
			const workspaceId = scope.slice('workspace:'.length);
			if (!workspaceId) throw new WorkspaceError(400, 'invalid_scope');
			return [workspaceId];
		}
		throw new WorkspaceError(400, 'invalid_scope');
	}

	return {
		pool,
		migrate: shape,
		readTransaction,
		writeTransaction,
		beginRun,
		readRun,
		updateRun,
		bumpRun,
		findCandidate,
		observeCandidate,
		transitionCandidate,
		listCandidates,
		candidateTotals,
		isReferenced,
		listIntents,
		registerIntent,
		releaseIntent,
		createHold,
		releaseHold,
		listHolds,
		pruneIntents,
		workspacesForScope,
	};
}
