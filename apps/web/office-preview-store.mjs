// PostgreSQL access for Office previews (§3, §5).
//
// Three invariants live here, and only here:
//
//   1. **Dedupe is a database fact.** `office_previews` has a UNIQUE index over the
//      five column key from the task book, so two concurrent requests for the same
//      version can never create two jobs — the second one either finds the row or
//      loses the insert and re-reads it.
//   2. **One conversion runs at a time in the whole deployment.** Before a worker may
//      start a process it must take the `conversion` row of `office_preview_slots`
//      with a lease, and it renews that lease in the same transaction that renews the
//      job lease. A second process on another node simply does not get the slot.
//   3. **Only the current attempt may publish.** `finalizePreview` matches on
//      `attempt_id` as well as `preview_id`, and the row must still be `running`, so a
//      worker whose lease expired (and was recovered by another worker) cannot
//      overwrite the newer result. The object key it uploaded is attempt specific, so
//      the losing worker cleans up its own bytes and nothing else.

import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { WorkspaceError } from './workspace-contract.mjs';
import { officePreviewSchemaCurrent, migrateOfficePreviews } from './office-preview-migrate.mjs';
import {
	officePreviewStates as states,
	previewNotFound,
	queueFull,
} from './office-preview-contract.mjs';

const previews = 'log4stellar.office_previews';
const slots = 'log4stellar.office_preview_slots';
const versions = 'log4stellar.storage_file_versions';
const entries = 'log4stellar.storage_entries';

export async function readOfficePreviewSettings(environment = process.env) {
	const configPath = environment.LOG4STELLAR_STORAGE_CONFIG;
	if (!configPath) {
		throw new WorkspaceError(503, 'PreviewUnavailable');
	}
	let settings;
	try {
		settings = JSON.parse(await readFile(configPath, 'utf8'));
	} catch {
		throw new WorkspaceError(503, 'PreviewUnavailable');
	}
	const postgres = settings.postgres;
	if (!postgres?.host || !postgres.database || !postgres.user || !postgres.password) {
		throw new WorkspaceError(503, 'PreviewUnavailable');
	}
	return { configPath, settings, postgres };
}

function describe(row) {
	if (!row) {
		return undefined;
	}
	return {
		previewId: row.preview_id,
		workspaceId: row.workspace_id,
		fileId: row.file_id,
		revisionId: row.revision_id,
		sourceSha256: row.source_sha256,
		profileFingerprint: row.profile_fingerprint,
		previewKey: row.preview_key,
		state: row.state,
		attemptId: row.attempt_id,
		attemptCount: row.attempt_count,
		leaseUntilMs: row.lease_until_ms === null ? null : Number(row.lease_until_ms),
		sizeBytes: Number(row.size_bytes),
		reservedBytes: Number(row.reserved_bytes),
		objectKey: row.object_key,
		retryable: row.retryable,
		errorCode: row.error_code,
		createdMs: Number(row.created_ms),
		updatedMs: Number(row.updated_ms),
		lastAccessMs: Number(row.last_access_ms),
	};
}

let cached;
let cachedKey;

/** One pool per storage configuration, migrated on first use behind the catalog probe. */
export async function openOfficePreviewStore(environment = process.env) {
	const { configPath, postgres } = await readOfficePreviewSettings(environment);
	if (cached && cachedKey === configPath) {
		return cached;
	}
	await closeOfficePreviewStore();
	const pool = new Pool({ connectionTimeoutMillis: 5000, max: 4, ...postgres });
	try {
		if (!await officePreviewSchemaCurrent(pool)) {
			await migrateOfficePreviews(pool);
		}
	} catch (error) {
		await pool.end().catch(() => {});
		throw error;
	}
	cached = createOfficePreviewStore(pool, configPath);
	cachedKey = configPath;
	return cached;
}

export async function closeOfficePreviewStore() {
	if (!cached) {
		return;
	}
	const pool = cached.pool;
	cached = undefined;
	cachedKey = undefined;
	await pool.end().catch(() => {});
}

/** Test seam: drop the cached pool without touching the database. */
export function resetOfficePreviewStoreForTest() {
	return closeOfficePreviewStore();
}

export function createOfficePreviewStore(pool, configPath) {
	async function transaction(action) {
		const connection = await pool.connect();
		try {
			await connection.query('BEGIN');
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

	async function byKey(connection, source, profileFingerprint) {
		const { rows } = await connection.query(`
			SELECT * FROM ${previews}
			WHERE workspace_id = $1 AND file_id = $2 AND revision_id = $3
				AND source_sha256 = $4 AND profile_fingerprint = $5
			FOR UPDATE
		`, [source.workspaceId, source.fileId, source.revisionId, source.sha256, profileFingerprint]);
		return rows[0];
	}

	async function queueDepth(connection) {
		const { rows } = await connection.query(
			`SELECT count(*)::int AS depth FROM ${previews} WHERE state = $1`, [states.queued]);
		return rows[0]?.depth ?? 0;
	}

	/**
	 * Recovers expired leases. A `running` row whose lease ran out is either put back
	 * in the queue (it may still be retried) or failed with `PreviewTimeout`; the stale
	 * conversion slot is dropped at the same time. Declared as a plain function rather
	 * than a method so `claimPreviewJob` can call it without relying on `this`.
	 */
	async function releaseExpiredLeases(nowMs = Date.now(), maxAttempts = 3) {
		return transaction(async connection => {
			const { rows } = await connection.query(`
				UPDATE ${previews}
				SET state = CASE WHEN attempt_count >= $2 THEN 'failed' ELSE 'queued' END,
					error_code = CASE WHEN attempt_count >= $2 THEN 'PreviewTimeout' ELSE NULL END,
					retryable = attempt_count < $2,
					attempt_id = NULL, lease_until_ms = NULL, reserved_bytes = 0,
					updated_ms = $1
				WHERE state = 'running' AND lease_until_ms < $1
				RETURNING preview_id, state
			`, [nowMs, maxAttempts]);
			await connection.query(`DELETE FROM ${slots} WHERE slot = 'conversion' AND lease_until_ms < $1`, [nowMs]);
			return rows.length;
		});
	}

	return {
		pool,
		configPath,
		close: () => pool.end().catch(() => {}),

		/** Inserts the schema if it is missing; used by tests and by the CLI path. */
		async migrate() {
			await migrateOfficePreviews(pool);
		},

		async schemaCurrent() {
			return officePreviewSchemaCurrent(pool);
		},

		/**
		 * Authoritative source metadata: the digest and size of an *exact* revision.
		 * This is the only place `source_sha256` comes from — a client can never supply
		 * it, so a cache key can never be steered (§5).
		 */
		async findVersionSource(workspaceId, fileId, revisionId) {
			const { rows } = await pool.query(`
				SELECT v.file_id, v.revision_id, v.sha256, v.size_bytes, e.path
				FROM ${versions} v
				LEFT JOIN ${entries} e ON e.workspace_id = v.workspace_id AND e.file_id = v.file_id
				WHERE v.workspace_id = $1 AND v.file_id = $2 AND v.revision_id = $3
			`, [workspaceId, fileId, revisionId]);
			const row = rows[0];
			if (!row) {
				return undefined;
			}
			return {
				workspaceId,
				fileId: row.file_id,
				revisionId: row.revision_id,
				sha256: row.sha256,
				sizeBytes: Number(row.size_bytes),
				path: row.path ?? undefined,
			};
		},

		/** Current revision of a file, still present in the workspace tree. */
		async currentVersionSource(workspaceId, fileId) {
			const { rows } = await pool.query(`
				SELECT v.file_id, v.revision_id, v.sha256, v.size_bytes, e.path
				FROM ${entries} e JOIN ${versions} v
					ON v.workspace_id = e.workspace_id AND v.file_id = e.file_id AND v.revision_id = e.revision_id
				WHERE e.workspace_id = $1 AND e.file_id = $2 AND e.kind = 1
			`, [workspaceId, fileId]);
			const row = rows[0];
			if (!row) {
				return undefined;
			}
			return {
				workspaceId,
				fileId: row.file_id,
				revisionId: row.revision_id,
				sha256: row.sha256,
				sizeBytes: Number(row.size_bytes),
				path: row.path ?? undefined,
			};
		},

		/** Cheap existence test used to re-check read access on every poll. */
		/**
		 * Resolves a workspace path to the authoritative metadata of one revision. This is
		 * the path-addressed twin of `currentVersionSource`, used by the web entry point:
		 * the extension knows the file's path, never its `fileId`, and the server must be
		 * the one that turns a path into the identity stored in the queue.
		 */
		async sourceByPath(workspaceId, path, revisionId) {
			const { rows } = await pool.query(`
				SELECT e.file_id, v.revision_id, v.sha256, v.size_bytes, e.path
				FROM ${entries} e JOIN ${versions} v
					ON v.workspace_id = e.workspace_id AND v.file_id = e.file_id
				WHERE e.workspace_id = $1 AND e.path = $2 AND e.kind = 1
					AND v.revision_id = COALESCE($3, e.revision_id)
			`, [workspaceId, path, revisionId ?? null]);
			const row = rows[0];
			if (!row) {
				return undefined;
			}
			return {
				workspaceId,
				fileId: row.file_id,
				revisionId: row.revision_id,
				sha256: row.sha256,
				sizeBytes: Number(row.size_bytes),
				path: row.path,
			};
		},

		async versionExists(workspaceId, fileId, revisionId) {
			const { rows } = await pool.query(`
				SELECT 1 FROM ${versions}
				WHERE workspace_id = $1 AND file_id = $2 AND revision_id = $3
			`, [workspaceId, fileId, revisionId]);
			return rows.length > 0;
		},

		/**
		 * §5 `getOrEnqueuePreview`. Returns the existing row, a re-queued row, or a new
		 * one; it never creates a second job for the same key and never lets the queue
		 * exceed `maxQueued` waiting jobs.
		 */
		async getOrEnqueuePreview({ source, profileFingerprint, previewKey, maxQueued, nowMs = Date.now() }) {
			return transaction(async connection => {
				const existing = await byKey(connection, source, profileFingerprint);
				if (existing) {
					const row = describe(existing);
					if (row.state === states.ready) {
						await connection.query(
							`UPDATE ${previews} SET last_access_ms = $2 WHERE preview_id = $1`, [row.previewId, nowMs]);
						return { ...row, lastAccessMs: nowMs, enqueued: false };
					}
					if (row.state === states.queued || row.state === states.running) {
						// A concurrent request while a job is already in flight is the
						// idempotent case: same id, same revision, nothing new starts.
						await connection.query(
							`UPDATE ${previews} SET last_access_ms = $2 WHERE preview_id = $1`, [row.previewId, nowMs]);
						return { ...row, lastAccessMs: nowMs, enqueued: false };
					}
					if (row.state === states.failed && !row.retryable) {
						// Permanent failure: report it, never convert it again (§5).
						return { ...row, enqueued: false };
					}
					// `evicted`, or a retryable failure below the attempt cap: rebuild.
					const depth = await queueDepth(connection);
					if (depth >= maxQueued) {
						throw queueFull();
					}
					const { rows } = await connection.query(`
						UPDATE ${previews}
						SET state = $2, attempt_id = NULL, lease_until_ms = NULL, error_code = NULL,
							retryable = false, reserved_bytes = 0, size_bytes = 0, object_key = NULL,
							updated_ms = $3, last_access_ms = $3
						WHERE preview_id = $1
						RETURNING *
					`, [row.previewId, states.queued, nowMs]);
					return { ...describe(rows[0]), enqueued: true };
				}

				const depth = await queueDepth(connection);
				if (depth >= maxQueued) {
					throw queueFull();
				}
				const previewId = randomUUID();
				const { rows } = await connection.query(`
					INSERT INTO ${previews} (
						preview_id, workspace_id, file_id, revision_id, source_sha256, profile_fingerprint,
						preview_key, state, attempt_count, size_bytes, reserved_bytes,
						created_ms, updated_ms, last_access_ms
					) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, 0, 0, $9, $9, $9)
					ON CONFLICT (workspace_id, file_id, revision_id, source_sha256, profile_fingerprint)
					DO NOTHING
					RETURNING *
				`, [
					previewId, source.workspaceId, source.fileId, source.revisionId,
					source.sha256, profileFingerprint, previewKey, states.queued, nowMs,
				]);
				if (rows[0]) {
					return { ...describe(rows[0]), enqueued: true };
				}
				// A concurrent request inserted the same key first: adopt its row.
				const raced = await byKey(connection, source, profileFingerprint);
				if (!raced) {
					throw new WorkspaceError(503, 'PreviewUnavailable');
				}
				return { ...describe(raced), enqueued: false };
			});
		},

		/** Status read used by the poll endpoint; touches the LRU timestamp. */
		async getPreview(workspaceId, previewId, nowMs = Date.now()) {
			const { rows } = await pool.query(`
				UPDATE ${previews} SET last_access_ms = $3
				WHERE preview_id = $1 AND workspace_id = $2
				RETURNING *
			`, [previewId, workspaceId, nowMs]);
			return describe(rows[0]);
		},

		async getPreviewByObject(workspaceId, previewId) {
			const { rows } = await pool.query(
				`SELECT * FROM ${previews} WHERE preview_id = $1 AND workspace_id = $2`, [previewId, workspaceId]);
			return describe(rows[0]);
		},

		async getPreviewByKey(workspaceId, previewKey) {
			const { rows } = await pool.query(
				`SELECT * FROM ${previews} WHERE workspace_id = $1 AND preview_key = $2`, [workspaceId, previewKey]);
			return describe(rows[0]);
		},

		async queueDepth() {
			return queueDepth(pool);
		},

		/**
		 * §5 `claimPreviewJob`. Recovers expired leases, takes the deployment-wide
		 * conversion slot and then claims the oldest queued preview. Returns
		 * `undefined` when there is nothing to do *or* when another worker holds the
		 * slot — both cases mean "do not start a process".
		 */
		async claimPreviewJob({ workerId, leaseMs, maxAttempts = 3, nowMs = Date.now() }) {
			await releaseExpiredLeases(nowMs, maxAttempts);
			return transaction(async connection => {
				const slot = await connection.query(`
					INSERT INTO ${slots} (slot, owner_id, acquired_ms, lease_until_ms)
					VALUES ('conversion', $1, $2, $3)
					ON CONFLICT (slot) DO UPDATE
						SET owner_id = EXCLUDED.owner_id, acquired_ms = EXCLUDED.acquired_ms,
							lease_until_ms = EXCLUDED.lease_until_ms
						WHERE ${slots}.lease_until_ms < $2
					RETURNING owner_id
				`, [workerId, nowMs, nowMs + leaseMs]);
				if (slot.rows[0]?.owner_id !== workerId) {
					return undefined;
				}
				const { rows } = await connection.query(`
					SELECT p.*, e.path AS source_path FROM ${previews} p
					LEFT JOIN ${entries} e
						ON e.workspace_id = p.workspace_id AND e.file_id = p.file_id
					WHERE p.state = $1
					ORDER BY p.created_ms, p.preview_id
					LIMIT 1
					FOR UPDATE OF p SKIP LOCKED
				`, [states.queued]);
				const row = rows[0];
				if (!row) {
					await connection.query(`DELETE FROM ${slots} WHERE slot = 'conversion' AND owner_id = $1`, [workerId]);
					return undefined;
				}
				const attemptId = randomUUID();
				const claimed = await connection.query(`
					UPDATE ${previews}
					SET state = $2, attempt_id = $3, attempt_count = attempt_count + 1,
						lease_until_ms = $4, updated_ms = $5, reserved_bytes = 0
					WHERE preview_id = $1
					RETURNING *
				`, [row.preview_id, states.running, attemptId, nowMs + leaseMs, nowMs]);
				return { ...describe(claimed.rows[0]), workerId, sourcePath: row.source_path ?? undefined };
			});
		},

		/** Renews the job lease and the conversion slot in one transaction. */
		async renewLease({ previewId, attemptId, workerId, leaseMs, nowMs = Date.now() }) {
			return transaction(async connection => {
				const { rows } = await connection.query(`
					UPDATE ${previews} SET lease_until_ms = $4, updated_ms = $5
					WHERE preview_id = $1 AND attempt_id = $2 AND state = $3
					RETURNING preview_id
				`, [previewId, attemptId, states.running, nowMs + leaseMs, nowMs]);
				if (rows.length === 0) {
					return false;
				}
				await connection.query(`
					UPDATE ${slots} SET lease_until_ms = $3
					WHERE slot = 'conversion' AND owner_id = $1 AND lease_until_ms > $2
				`, [workerId, nowMs, nowMs + leaseMs]);
				return true;
			});
		},

		/**
		 * §5 "超时会话或进程崩溃后，过期的租约必须被回收". Exposed for the worker's
		 * housekeeping loop; delegates to the module level implementation so the claim
		 * path and this entry point can never drift apart.
		 */
		async releaseExpiredLeases(nowMs = Date.now(), maxAttempts = 3) {
			return releaseExpiredLeases(nowMs, maxAttempts);
		},

		/** Drops a slot this worker no longer needs (nothing to convert, or shutting down). */
		async releaseSlot(workerId, nowMs = Date.now()) {
			await pool.query(`DELETE FROM ${slots} WHERE slot = 'conversion' AND owner_id = $1`, [workerId]);
			return nowMs;
		},

		/**
		 * §5 `reserveCacheBudgetOrEvictReadyEntries`. Accounting is per workspace:
		 * published `size_bytes` plus in-flight `reserved_bytes`. The caller evicts when
		 * `ok` is false and retries, so this method never deletes an object itself.
		 */
		async reserveCache({ previewId, attemptId, bytes, budgetBytes, nowMs = Date.now() }) {
			return transaction(async connection => {
				const { rows } = await connection.query(`
					SELECT
						COALESCE(SUM(size_bytes), 0)::bigint AS held,
						COALESCE(SUM(reserved_bytes), 0)::bigint AS reserved
					FROM ${previews}
					WHERE workspace_id = (SELECT workspace_id FROM ${previews} WHERE preview_id = $1)
						AND state IN ('ready', 'running')
				`, [previewId]);
				const held = Number(rows[0]?.held ?? 0) + Number(rows[0]?.reserved ?? 0);
				if (held + bytes > budgetBytes) {
					return { ok: false, held, budgetBytes };
				}
				const updated = await connection.query(`
					UPDATE ${previews} SET reserved_bytes = $3, updated_ms = $4
					WHERE preview_id = $1 AND attempt_id = $2 AND state = 'running'
					RETURNING preview_id
				`, [previewId, attemptId, bytes, nowMs]);
				return updated.rows.length > 0 ? { ok: true, held } : { ok: false, held };
			});
		},

		/** Ready rows that may be evicted, least recently used first. */
		async evictionCandidates(workspaceId, { limit = 64 } = {}) {
			const { rows } = await pool.query(`
				SELECT preview_id, object_key, size_bytes, last_access_ms, profile_fingerprint
				FROM ${previews}
				WHERE workspace_id = $1 AND state = 'ready' AND object_key IS NOT NULL
				ORDER BY last_access_ms, preview_id
				LIMIT $2
			`, [workspaceId, limit]);
			return rows.map(row => ({
				previewId: row.preview_id,
				objectKey: row.object_key,
				sizeBytes: Number(row.size_bytes),
				lastAccessMs: Number(row.last_access_ms),
				profileFingerprint: row.profile_fingerprint,
			}));
		},

		/**
		 * Marks an evicted row. The row is kept as a tombstone so the dedupe key still
		 * resolves and a later request re-queues the same version instead of creating a
		 * second job for it.
		 */
		async markEvicted(previewId, nowMs = Date.now()) {
			await pool.query(`
				UPDATE ${previews}
				SET state = 'evicted', size_bytes = 0, reserved_bytes = 0, object_key = NULL,
					updated_ms = $2
				WHERE preview_id = $1 AND state = 'ready'
			`, [previewId, nowMs]);
		},

		/**
		 * §5 `finalizePreview`. Only the attempt that still owns an unexpired lease may
		 * publish. Returns `false` when the attempt lost its lease — the caller must then
		 * delete the object it uploaded, which is safe because the key is attempt
		 * specific and therefore nobody else references it.
		 */
		async finalizePreview({ previewId, attemptId, objectKey, sizeBytes, nowMs = Date.now() }) {
			const { rows } = await pool.query(`
				UPDATE ${previews}
				SET state = 'ready', size_bytes = $3, reserved_bytes = 0, object_key = $4,
					error_code = NULL, retryable = false, attempt_id = NULL, lease_until_ms = NULL,
					updated_ms = $5, last_access_ms = $5
				WHERE preview_id = $1 AND attempt_id = $2 AND state = 'running' AND lease_until_ms >= $5
				RETURNING *
			`, [previewId, attemptId, sizeBytes, objectKey, nowMs]);
			return rows[0] ? describe(rows[0]) : undefined;
		},

		/**
		 * §5 `failPreviewAttempt`. A transient failure (worker died, disk full, timeout)
		 * goes back to the queue until the attempt cap; anything else is final, so a
		 * corrupt or password protected document is never converted in a loop.
		 */
		async failPreviewAttempt({ previewId, attemptId, errorCode, retryable, maxAttempts, nowMs = Date.now() }) {
			const { rows } = await pool.query(`
				UPDATE ${previews}
				SET state = CASE WHEN $3 AND attempt_count < $4 THEN 'queued' ELSE 'failed' END,
					error_code = CASE WHEN $3 AND attempt_count < $4 THEN NULL ELSE $5 END,
					retryable = $3 AND attempt_count < $4,
					attempt_id = NULL, lease_until_ms = NULL, reserved_bytes = 0,
					updated_ms = $6
				WHERE preview_id = $1 AND attempt_id = $2 AND state = 'running'
				RETURNING state, error_code
			`, [previewId, attemptId, retryable, maxAttempts, errorCode, nowMs]);
			return rows[0];
		},

		/** Test/maintenance: remove every row of one workspace. */
		async deleteWorkspace(workspaceId) {
			await pool.query(`DELETE FROM ${previews} WHERE workspace_id = $1`, [workspaceId]);
		},
	};
}
