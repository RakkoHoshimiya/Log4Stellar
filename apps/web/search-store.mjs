// SQL layer for the workspace full text index (task 01 全文搜索).
//
// Every function here receives a connection owned by the caller and never opens a
// transaction of its own, exactly like sync-store.mjs: an index update has to be
// committed atomically with the storage change that produced it, so the caller
// decides the transaction boundary.
//
// The index is derived data. `search_documents` caches one extracted file revision
// and every read joins it back to `storage_entries`, so a row whose revision is no
// longer current is never returned. `search_jobs` carries the desired state; its
// `desired_seq` is the storage change sequence, so a duplicated or out of order
// event cannot overwrite a newer desired state.

import { readFile } from 'node:fs/promises';

export const searchTables = Object.freeze({
	documents: 'log4stellar.search_documents',
	jobs: 'log4stellar.search_jobs',
	state: 'log4stellar.search_index_state',
	entries: 'log4stellar.storage_entries',
	versions: 'log4stellar.storage_file_versions',
});

// A dedicated advisory lock: applying search-schema.sql must not race with the
// storage migration, which holds migrationLockId (467209224).
export const searchSchemaLockId = 467209225;

// Rebuild jobs are not storage changes, so they sit at the bottom of the sequence
// range. The queue only moves a row forward, which means any real change (> 1)
// supersedes a rebuild job for the same file.
export const rebuildSeq = 1;

const searchSchema = await readFile(new URL('./search-schema.sql', import.meta.url), 'utf8');

// Applying the schema once per pool is enough; the advisory lock only covers a
// second process starting at the same moment.
const applied = new WeakSet();

export async function ensureSearchSchema(pool) {
	if (applied.has(pool)) {
		return false;
	}
	const present = await pool.query('SELECT to_regclass($1) IS NOT NULL AS present', [searchTables.documents]);
	if (present.rows[0].present) {
		applied.add(pool);
		return false;
	}
	const connection = await pool.connect();
	try {
		await connection.query('BEGIN');
		await connection.query('SELECT pg_advisory_xact_lock($1)', [searchSchemaLockId]);
		await connection.query(searchSchema);
		await connection.query('COMMIT');
	} catch (error) {
		await connection.query('ROLLBACK').catch(() => {});
		throw error;
	} finally {
		connection.release();
	}
	applied.add(pool);
	return true;
}

export async function readIndexState(connection, workspaceId) {
	const { rows } = await connection.query(
		`SELECT generation, indexed_ms, rebuilt_ms FROM ${searchTables.state} WHERE workspace_id = $1`,
		[workspaceId],
	);
	if (rows.length === 0) {
		return { generation: 1, indexedMs: 0, rebuiltMs: null };
	}
	return {
		generation: Number(rows[0].generation),
		indexedMs: Number(rows[0].indexed_ms),
		rebuiltMs: rows[0].rebuilt_ms === null ? null : Number(rows[0].rebuilt_ms),
	};
}

/**
 * Bumps the index generation. Every page cursor is bound to the generation it was
 * produced under, so this is what makes a cursor issued before a rebuild unusable
 * afterwards even when the surviving paths happen to overlap.
 */
export async function bumpIndexGeneration(connection, workspaceId, nowMs = Date.now()) {
	const { rows } = await connection.query(
		`INSERT INTO ${searchTables.state} (workspace_id, generation, indexed_ms, rebuilt_ms)
		VALUES ($1, 2, $2, $2)
		ON CONFLICT (workspace_id) DO UPDATE
			SET generation = ${searchTables.state}.generation + 1, rebuilt_ms = $2
		RETURNING generation`,
		[workspaceId, nowMs],
	);
	return Number(rows[0].generation);
}

export async function markIndexed(connection, workspaceId, nowMs = Date.now()) {
	await connection.query(
		`INSERT INTO ${searchTables.state} (workspace_id, generation, indexed_ms)
		VALUES ($1, 1, $2)
		ON CONFLICT (workspace_id) DO UPDATE
			SET indexed_ms = GREATEST(${searchTables.state}.indexed_ms, $2)`,
		[workspaceId, nowMs],
	);
}

export async function upsertDocument(connection, document) {
	const {
		workspaceId, fileId, revisionId, path, title, body, truncated = false,
		indexedMs = Date.now(),
	} = document;
	await connection.query(
		`INSERT INTO ${searchTables.documents}
			(workspace_id, file_id, revision_id, path, title, body, truncated, indexed_ms)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		ON CONFLICT (workspace_id, file_id) DO UPDATE SET
			revision_id = EXCLUDED.revision_id,
			path = EXCLUDED.path,
			title = EXCLUDED.title,
			body = EXCLUDED.body,
			truncated = EXCLUDED.truncated,
			indexed_ms = EXCLUDED.indexed_ms`,
		[workspaceId, fileId, revisionId, path, title, body, truncated, indexedMs],
	);
}

export async function deleteDocument(connection, workspaceId, fileId) {
	await connection.query(
		`DELETE FROM ${searchTables.documents} WHERE workspace_id = $1 AND file_id = $2`,
		[workspaceId, fileId],
	);
}

export async function deleteWorkspaceDocuments(connection, workspaceId) {
	await connection.query(`DELETE FROM ${searchTables.documents} WHERE workspace_id = $1`, [workspaceId]);
}

/**
 * Records the desired index state for one file. This runs inside the same
 * transaction as the storage change, so the queue can never disagree with
 * `storage_entries` about what a file is supposed to be.
 *
 * `seq` is the storage change sequence and a row only moves forward: an event that
 * arrives late (or twice) carries an older or equal sequence and is ignored instead
 * of resurrecting a deleted file or overwriting a newer revision.
 */
export async function enqueueIndexUpdate(connection, change) {
	const { workspaceId, fileId, revisionId = null, seq, operation, nowMs = Date.now() } = change;
	if (!Number.isSafeInteger(seq) || seq < 1) {
		throw new Error('A search index job needs the storage change sequence it came from.');
	}
	if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
		throw new Error('A search index job needs a non-negative timestamp in milliseconds.');
	}
	if (operation !== 'upsert' && operation !== 'delete') {
		throw new Error('Unknown search index operation: ' + operation);
	}
	await connection.query(
		`INSERT INTO ${searchTables.jobs}
			(workspace_id, file_id, operation, desired_revision_id, desired_seq, status, attempts, queued_ms, updated_ms)
		VALUES ($1, $2, $3, $4, $5, 'pending', 0, $6, $6)
		ON CONFLICT (workspace_id, file_id) DO UPDATE SET
			operation = EXCLUDED.operation,
			desired_revision_id = EXCLUDED.desired_revision_id,
			desired_seq = EXCLUDED.desired_seq,
			status = 'pending',
			attempts = 0,
			queued_ms = EXCLUDED.queued_ms,
			updated_ms = EXCLUDED.updated_ms
		WHERE ${searchTables.jobs}.desired_seq <= EXCLUDED.desired_seq`,
		[workspaceId, fileId, operation, revisionId, seq, nowMs],
	);
}

/**
 * Applies one claimed job. The row is re-read under FOR UPDATE and the write only
 * happens while the job still carries the sequence it was claimed with, so a job
 * that a newer change already replaced can never write a stale revision.
 */
export async function applyJob(connection, job, document, nowMs = Date.now()) {
	const { rows } = await connection.query(
		`SELECT desired_seq, desired_revision_id FROM ${searchTables.jobs}
		WHERE workspace_id = $1 AND file_id = $2 AND desired_seq = $3 FOR UPDATE`,
		[job.workspaceId, job.fileId, job.desiredSeq],
	);
	if (rows.length === 0) {
		return false;
	}
	if (document === undefined) {
		await deleteDocument(connection, job.workspaceId, job.fileId);
	} else {
		await upsertDocument(connection, { ...document, workspaceId: job.workspaceId, fileId: job.fileId });
	}
	await connection.query(
		`DELETE FROM ${searchTables.jobs} WHERE workspace_id = $1 AND file_id = $2 AND desired_seq = $3`,
		[job.workspaceId, job.fileId, job.desiredSeq],
	);
	await markIndexed(connection, job.workspaceId, nowMs);
	return true;
}

export async function requeueIndexJob(connection, job, nowMs = Date.now()) {
	await connection.query(
		`UPDATE ${searchTables.jobs}
		SET status = 'pending', attempts = attempts + 1, updated_ms = $4
		WHERE workspace_id = $1 AND file_id = $2 AND desired_seq = $3`,
		[job.workspaceId, job.fileId, job.desiredSeq, nowMs],
	);
}

/**
 * Claims the oldest pending jobs of one workspace. A single UPDATE claims them, so
 * two indexers cannot take the same row; a crashed indexer leaves its rows in
 * `running` and the next call reclaims them once `updated_ms` goes stale.
 */
export async function claimIndexJobs(connection, workspaceId, { limit = 25, nowMs = Date.now(), staleMs = 60_000 } = {}) {
	const { rows } = await connection.query(
		`WITH claimed AS (
			SELECT workspace_id, file_id FROM ${searchTables.jobs}
			WHERE workspace_id = $1
				AND (status = 'pending' OR (status = 'running' AND updated_ms <= $2))
			ORDER BY queued_ms, file_id
			LIMIT $3
		)
		UPDATE ${searchTables.jobs} AS jobs
		SET status = 'running', updated_ms = $4
		FROM claimed
		WHERE jobs.workspace_id = claimed.workspace_id AND jobs.file_id = claimed.file_id
		RETURNING jobs.file_id, jobs.operation, jobs.desired_revision_id, jobs.desired_seq, jobs.attempts`,
		[workspaceId, nowMs - staleMs, limit, nowMs],
	);
	return rows.map(row => ({
		workspaceId,
		fileId: row.file_id,
		operation: row.operation,
		desiredRevisionId: row.desired_revision_id,
		desiredSeq: Number(row.desired_seq),
		attempts: Number(row.attempts),
	}));
}

export async function countPendingJobs(connection, workspaceId) {
	const { rows } = await connection.query(
		`SELECT count(*)::int AS pending FROM ${searchTables.jobs} WHERE workspace_id = $1`,
		[workspaceId],
	);
	return rows[0].pending;
}

/**
 * The storage truth for one file, keyed by the stable file ID rather than the path:
 * a rename keeps the ID and changes the path, and the index has to follow the ID.
 */
export async function findIndexedSource(connection, workspaceId, fileId) {
	const { rows } = await connection.query(
		`SELECT e.path, e.revision_id, v.sha256, v.size_bytes
		FROM ${searchTables.entries} e
		LEFT JOIN ${searchTables.versions} v USING (workspace_id, file_id, revision_id)
		WHERE e.workspace_id = $1 AND e.file_id = $2 AND e.kind = 1`,
		[workspaceId, fileId],
	);
	if (rows.length === 0) {
		return undefined;
	}
	const row = rows[0];
	return {
		path: row.path,
		revisionId: row.revision_id,
		sha256: row.sha256,
		sizeBytes: Number(row.size_bytes ?? 0),
	};
}

export async function listIndexableFiles(connection, workspaceId) {
	const { rows } = await connection.query(
		`SELECT e.file_id, e.path, e.revision_id, v.sha256, v.size_bytes
		FROM ${searchTables.entries} e
		LEFT JOIN ${searchTables.versions} v USING (workspace_id, file_id, revision_id)
		WHERE e.workspace_id = $1 AND e.kind = 1
		ORDER BY e.path, e.file_id`,
		[workspaceId],
	);
	return rows.map(row => ({
		fileId: row.file_id,
		path: row.path,
		revisionId: row.revision_id,
		sha256: row.sha256,
		sizeBytes: Number(row.size_bytes ?? 0),
	}));
}

// The excerpt window is cut in the database so answering a page never copies whole
// notes into the process. The line and column are finished in JavaScript because the
// API reports UTF-16 code units while PostgreSQL counts characters.
const windowRadius = 400;

/**
 * One page of hits. The join to `storage_entries` is what makes an out of date
 * document invisible: a row whose cached revision is not the current revision is
 * dropped here instead of being repaired during the query, so a stale index can
 * never answer with content the user can no longer read.
 *
 * The ordering key is (path, file_id). `file_id` is unique inside a workspace, so
 * the key is total and keyset pagination can never repeat or skip a row.
 *
 * Matching uses strpos() on lower() rather than LIKE: a query that contains `%` or
 * `_` stays a literal, and the expression works for Chinese text because it needs no
 * word boundaries.
 */
export async function queryDocuments(connection, { workspaceId, needle, after, limit }) {
	const params = [workspaceId, needle];
	let keyset = '';
	if (after) {
		params.push(after.path, after.fileId);
		keyset = ' AND (e.path, d.file_id) > ($3::text, $4::uuid)';
	}
	params.push(limit + 1);
	const { rows } = await connection.query(
		`WITH scored AS (
			SELECT d.file_id, d.revision_id, e.path, d.indexed_ms, (d.body || '') AS body,
				strpos(lower(e.path), $2) AS path_pos,
				strpos(lower(d.title), $2) AS title_pos,
				strpos(lower(d.body), $2) AS body_pos
			FROM ${searchTables.documents} d
			JOIN ${searchTables.entries} e
				ON e.workspace_id = d.workspace_id AND e.file_id = d.file_id
				AND e.revision_id = d.revision_id AND e.kind = 1
			WHERE d.workspace_id = $1${keyset}
		)
		SELECT file_id, revision_id, path, indexed_ms, path_pos, title_pos, body_pos,
			GREATEST(body_pos - ${windowRadius}, 1) AS window_start,
			substring(body from GREATEST(body_pos - ${windowRadius}, 1) for ${windowRadius * 2}) AS window_text,
			length(left(body, GREATEST(body_pos - ${windowRadius}, 1) - 1))
				- length(replace(left(body, GREATEST(body_pos - ${windowRadius}, 1) - 1), chr(10), '')) AS lines_before
		FROM scored
		WHERE path_pos > 0 OR title_pos > 0 OR body_pos > 0
		ORDER BY path, file_id
		LIMIT $${params.length}`,
		params,
	);
	return {
		rows: rows.slice(0, limit).map(row => ({
			fileId: row.file_id,
			revisionId: row.revision_id,
			path: row.path,
			indexedMs: Number(row.indexed_ms),
			pathPos: Number(row.path_pos),
			titlePos: Number(row.title_pos),
			bodyPos: Number(row.body_pos),
			windowStart: Number(row.window_start),
			windowText: row.window_text ?? '',
			linesBefore: Number(row.lines_before),
		})),
		hasMore: rows.length > limit,
	};
}

/**
 * The number of matching documents, independent of the page. It is a second
 * statement so paging never pays for a full count, and it is capped because the
 * total is only ever displayed.
 */
export async function countDocuments(connection, { workspaceId, needle, maximum = 10_000 }) {
	const { rows } = await connection.query(
		`SELECT count(*)::int AS total FROM (
			SELECT 1 FROM ${searchTables.documents} d
			JOIN ${searchTables.entries} e
				ON e.workspace_id = d.workspace_id AND e.file_id = d.file_id
				AND e.revision_id = d.revision_id AND e.kind = 1
			WHERE d.workspace_id = $1
				AND (strpos(lower(d.path), $2) > 0 OR strpos(lower(d.title), $2) > 0 OR strpos(lower(d.body), $2) > 0)
			LIMIT $3
		) AS matching`,
		[workspaceId, needle, maximum],
	);
	return rows[0].total;
}

/**
 * Republishes every current file as a rebuild job. Runs in the caller's transaction
 * so a crash halfway leaves either the old index or a fully queued rebuild, never a
 * half emptied one.
 *
 * The generation moves forward first: a cursor issued under the previous generation
 * is refused afterwards instead of addressing rows the rebuild moved or removed.
 */
export async function enqueueSearchBaseline(connection, workspaceId, files, nowMs = Date.now()) {
	if (files.length > 0) {
		await connection.query(
			`INSERT INTO ${searchTables.jobs}
				(workspace_id, file_id, operation, desired_revision_id, desired_seq, status, attempts, queued_ms, updated_ms)
			SELECT $1, file.file_id, 'upsert', file.revision_id, $2, 'pending', 0, $3, $3
			FROM unnest($4::uuid[], $5::uuid[]) AS file(file_id, revision_id)`,
			[workspaceId, rebuildSeq, nowMs, files.map(file => file.fileId), files.map(file => file.revisionId)],
		);
	}
}

export async function prepareRebuild(connection, workspaceId, files, nowMs = Date.now()) {
	const generation = await bumpIndexGeneration(connection, workspaceId, nowMs);
	await deleteWorkspaceDocuments(connection, workspaceId);
	await connection.query(`DELETE FROM ${searchTables.jobs} WHERE workspace_id = $1`, [workspaceId]);
	await enqueueSearchBaseline(connection, workspaceId, files, nowMs);
	return generation;
}
