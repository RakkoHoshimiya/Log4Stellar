import { holdTenantStorageReadLock, selectTenantStorage, tenantStorageProfiles } from './tenant-storage.mjs';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
	DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, S3Client,
} from '@aws-sdk/client-s3';

import { createBlobGcStore, readBlobGcWorkspaceCatalog } from './blob-gc-store.mjs';
import { blobGcRetention, resolveBlobGcSettings, scopeWorkspaceId } from './blob-retention.mjs';
import { rustfsWorkspaceBlobPrefix } from './rustfs-blobs.mjs';
import { isValidWorkspaceId, WorkspaceError } from './workspace-contract.mjs';

/**
 * The object-storage collector (task 06, 存储对象清理).
 *
 * It answers one question per object: "can anything still bring this back?" The answer
 * comes from the metadata store, never from the object store, because the object store
 * cannot know what the database is planning to reference.
 *
 * The shape of a run is: plan -> review -> apply, where only apply may delete, and only
 * when both the operator switch (LOG4STELLAR_BLOB_GC_APPLY=1) and a recovery directory
 * are present. `resume` continues a run that was interrupted; it is deliberately the
 * same code path as apply, driven by the states already in the database.
 *
 * Deletion is content-addressed by key `workspaces/<id>/sha256/<digest>` and guarded by
 * an object identity (the provider's ETag or version id). A candidate is only deleted
 * while the store still reports the identity recorded at observation time; if the object
 * was rebuilt in between, the candidate is cancelled instead. Every delete is preceded
 * by a byte-verified recovery copy, because a deletion cannot be undone otherwise.
 */

export const blobGcModes = Object.freeze(['plan', 'review', 'apply', 'resume']);

const digestPattern = /^[0-9a-f]{64}$/;

/** The only object-key shape this collector is allowed to delete. */
export function objectKey(workspaceId, digest, { tenantId } = {}) {
	if (!digestPattern.test(digest)) throw new WorkspaceError(400, 'invalid_digest');
	return rustfsWorkspaceBlobPrefix(workspaceId, tenantId) + digest;
}

/** Recognizes only canonical legacy or managed workspace blob keys. */
export function parseObjectKey(key) {
	if (typeof key !== 'string') return null;
	const match = /^(?:tenants\/(tenant-[0-9a-f]{32})\/)?workspaces\/([^/]+)\/(sha256)\/([0-9a-f]{64})$/.exec(key);
	if (!match) return null;
	const [, tenantId, workspaceId, algorithm, digest] = match;
	if (!isValidWorkspaceId(workspaceId) || match[0] !== key) return null;
	return { workspaceId, digest, algorithm, ...(tenantId ? { tenantId } : {}) };
}

/**
 * A short, safe label for logs. Never the object key, never the bucket, never a
 * credential: a digest prefix is enough to correlate two log lines.
 */
export function redactDigest(digest) {
	return typeof digest === 'string' && digestPattern.test(digest)
		? `sha256:${digest.slice(0, 12)}…`
		: 'sha256:?';
}

/** The failure categories `last_error` may hold. Values only, never free text. */
export const blobGcErrors = Object.freeze({
	copyFailed: 'recovery-copy-failed',
	deleteFailed: 'delete-failed',
	storeFailed: 'store-failed',
	stateConflict: 'state-conflict',
});

function errorCategory(error) {
	// Only a code or a class name ever reaches a log or an error body: a driver or SDK
	// message can embed a connection string, an endpoint or an object key.
	const code = error?.code ?? (error?.name === 'Error' ? '' : error?.name) ?? '';
	if (typeof code === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(code)) return code;
	return 'blob-gc-failed';
}

/**
 * A RustFS/S3 inventory for one workspace.
 *
 * `list` is paginated and returns the provider's identity for each object, which is what
 * makes an exact delete possible later. `deleteExact` re-reads the identity and refuses
 * to delete when it changed, so a rebuilt object survives an interrupted run.
 */
export function openRustfsInventory(settings, workspaceId, { tenantId } = {}) {
	const prefix = rustfsWorkspaceBlobPrefix(workspaceId, tenantId);
	const { endpoint, region = 'us-east-1', bucket, accessKeyId, secretAccessKey } = settings;
	if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
		throw new WorkspaceError(500, 'blob_gc_storage_unconfigured');
	}
	const client = new S3Client({
		endpoint, region, forcePathStyle: true,
		credentials: { accessKeyId, secretAccessKey },
		requestChecksumCalculation: 'WHEN_REQUIRED',
		responseChecksumValidation: 'WHEN_REQUIRED',
	});
	const key = digest => objectKey(workspaceId, digest, { tenantId });
	const scopedVersion = version => version && tenantId ? `${tenantId}|${version}` : version;

	function identity(head) {
		// Prefer an immutable provider version id; otherwise fall back to ETag+size, which
		// changes when the object is rewritten (a content-addressed rebuild keeps the same
		// bytes but is a different object, and must not be deleted by an old candidate).
		const versionId = head.VersionId ?? null;
		if (versionId) return { version: scopedVersion(`version:${versionId}`), versionId };
		const etag = String(head.ETag ?? '').replace(/"/g, '');
		return { version: scopedVersion(etag ? `etag:${etag}:${head.ContentLength ?? 0}` : null), versionId: null };
	}

	async function head(digest) {
		let found;
		try {
			found = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key(digest) }));
		} catch (error) {
			if (error.$metadata?.httpStatusCode === 404) return null;
			throw error;
		}
		return {
			key: key(digest),
			digest,
			sizeBytes: Number(found.ContentLength ?? 0),
			lastModifiedMs: found.LastModified ? found.LastModified.getTime() : null,
			...identity(found),
		};
	}

	return {
		async list(cursor, limit = blobGcRetention.maxInventoryPage) {
			const response = await client.send(new ListObjectsV2Command({
				Bucket: bucket,
				Prefix: prefix,
				MaxKeys: Math.min(Math.max(1, limit), 1000),
				ContinuationToken: cursor ?? undefined,
			}));
			const objects = [];
			let unmanaged = 0;
			for (const item of response.Contents ?? []) {
				const parsed = parseObjectKey(item.Key);
				if (!parsed || parsed.workspaceId !== workspaceId || parsed.tenantId !== tenantId) {
					unmanaged += 1;
					continue;
				}
				const etag = String(item.ETag ?? '').replace(/"/g, '');
				objects.push({
					key: item.Key,
					digest: parsed.digest,
					sizeBytes: Number(item.Size ?? 0),
					lastModifiedMs: item.LastModified ? item.LastModified.getTime() : null,
					version: scopedVersion(etag ? `etag:${etag}:${item.Size ?? 0}` : null),
				});
			}
			return {
				objects,
				unmanaged,
				cursor: response.IsTruncated ? (response.NextContinuationToken ?? null) : null,
			};
		},

		ownsVersion: version => tenantId
			? version?.startsWith(`${tenantId}|`) === true
			: !version?.startsWith('tenant-'),
		head,

		async deleteExact(digest, version) {
			const current = await head(digest);
			if (!current) return { deleted: false, missing: true };
			if (version && current.version && version !== current.version) {
				return { deleted: false, identityChanged: true, current: current.version };
			}
			try {
				await client.send(new DeleteObjectCommand({
					Bucket: bucket,
					Key: key(digest),
					...(current.versionId ? { VersionId: current.versionId } : {}),
				}));
			} catch (error) {
				if (error.$metadata?.httpStatusCode === 404) return { deleted: false, missing: true };
				throw error;
			}
			return { deleted: true };
		},

		/** Writes a byte-verified copy outside the bucket; the only way back after a delete. */
		async copyTo(path, digest, sizeBytes) {
			await mkdir(dirname(path), { recursive: true, mode: 0o700 });
			const response = await client.send(new GetObjectCommand({
				Bucket: bucket, Key: key(digest),
			}));
			if (!response.Body) throw new WorkspaceError(502, 'blob_gc_empty_body');
			const hash = createHash('sha256');
			const temporary = `${path}.partial`;
			try {
				await pipeline(
					response.Body,
					new Transform({
						transform(chunk, _encoding, callback) {
							hash.update(chunk);
							callback(null, chunk);
						},
					}),
					createWriteStream(temporary, { flags: 'w', mode: 0o600 }),
				);
				const actual = hash.digest('hex');
				if (actual !== digest) throw new WorkspaceError(502, 'blob_gc_recovery_copy_mismatch');
				const copy = await stat(temporary);
				if (sizeBytes !== undefined && sizeBytes !== null && copy.size !== Number(sizeBytes)) {
					throw new WorkspaceError(502, 'blob_gc_recovery_copy_size_mismatch');
				}
				await rm(path, { force: true });
				await rename(temporary, path);
				return { path, sizeBytes: copy.size, digest: actual };
			} finally {
				await rm(temporary, { force: true });
			}
		},

		close() {
			client.destroy();
		},
	};
}

function normalizeInventory(inventory, settings, workspaceId) {
	if (typeof inventory === 'function') return inventory(settings, workspaceId);
	if (inventory && typeof inventory === 'object') {
		// A per-workspace map keeps multi-workspace runs from sharing state.
		if (typeof inventory.forWorkspace === 'function') return inventory.forWorkspace(workspaceId);
		return inventory;
	}
	return openRustfsInventory(settings, workspaceId);
}

/**
 * Builds the collector.
 *
 * @param {object} options
 * @param {ReturnType<import('./blob-gc-store.mjs').createBlobGcStore>} options.store
 * @param {object|Function} [options.inventory] an inventory, a `(settings, workspaceId)`
 *   factory, or an object with `forWorkspace(workspaceId)`. Defaults to RustFS.
 * @param {object} [options.settings] resolved retention settings; env is used otherwise.
 * @param {() => number} [options.now] clock injection, so grace periods are testable.
 * @param {(event: object) => void} [options.logger] structured, redacted logging.
 */
export function createBlobGc(options) {
	const store = options.store;
	if (!store || typeof store.beginRun !== 'function') {
		throw new WorkspaceError(500, 'blob_gc_store_required');
	}
	const settings = options.settings ?? resolveBlobGcSettings(options.environment ?? {});
	const now = options.now ?? (() => Date.now());
	const logger = options.logger ?? (() => {});

	function log(event) {
		// Only ever categories, workspace ids and counters reach a log line: an object key
		// or a credential in the log would outlive the process that wrote it.
		logger(event);
	}

	function inventoryFor(workspaceId) {
		return normalizeInventory(options.inventory, settings, workspaceId);
	}

	const opened = new Map();

	function closeInventories() {
		for (const source of new Set(opened.values())) {
			try { source.close?.(); } catch { /* A completed run must remain reportable. */ }
		}
		opened.clear();
	}

	function inventory(workspaceId) {
		if (!opened.has(workspaceId)) opened.set(workspaceId, inventoryFor(workspaceId));
		return opened.get(workspaceId);
	}

	/**
	 * Read-only inventory pass. It may create or refresh `observed` candidate rows (those
	 * are metadata, not object writes) and it never deletes anything, in any mode.
	 */
	async function plan(scope) {
		const policy = settings;
		const startedMs = now();
		const run = await store.beginRun({ scope, mode: 'plan', dryRun: true, startedMs });
		let scanned = 0;
		let unmanaged = 0;
		let protectedCount = 0;
		let candidateCount = 0;
		let candidateBytes = 0;
		try {
			const workspaceIds = await store.workspacesForScope(scope);
			for (const workspaceId of workspaceIds) {
				const source = inventory(workspaceId);
				let cursor = null;
				do {
					const page = await source.list(cursor, policy.maxInventoryPage);
					unmanaged += page.unmanaged ?? 0;
					for (const object of page.objects) {
						scanned += 1;
						const reference = await store.isReferenced(workspaceId, object.digest, { nowMs: startedMs });
						if (reference.referenced) {
							protectedCount += 1;
							continue;
						}
						const currentObject = source.ownsVersion ? await source.head(object.digest) : object;
						if (!currentObject || (source.ownsVersion && !currentObject.version)) continue;
						candidateCount += 1;
						candidateBytes += currentObject.sizeBytes ?? 0;
						// Grace starts at the later of "we first saw it" and "the store says it
						// was last written": an object uploaded a minute ago is not an orphan.
						const lastWrite = currentObject.lastModifiedMs ?? startedMs;
						const firstSeenMs = startedMs;
						const eligibleAfterMs = Math.max(firstSeenMs, lastWrite) + policy.graceMs;
						await store.observeCandidate({
							workspaceId,
							digest: object.digest,
							objectVersion: currentObject.version ?? null,
							sizeBytes: currentObject.sizeBytes ?? 0,
							runId: run.runId,
							reason: 'unreferenced',
							firstSeenMs,
							eligibleAfterMs,
						});
					}
					cursor = page.cursor;
					await store.updateRun(run.runId, {
						inventoryCursor: cursor ?? 'done', updatedMs: now(),
					});
				} while (cursor);
			}
			await store.updateRun(run.runId, {
				state: 'completed',
				candidateCount,
				candidateBytes,
				updatedMs: now(),
			});
			const summary = {
				runId: run.runId,
				scope,
				mode: 'plan',
				dryRun: true,
				deleted: 0,
				scanned,
				unmanaged,
				protected: protectedCount,
				candidates: candidateCount,
				candidateBytes,
				graceMs: policy.graceMs,
			};
			log({ event: 'plan.completed', scope, scanned, candidates: candidateCount, dryRun: true });
			return summary;
		} catch (error) {
			await store.updateRun(run.runId, { state: 'failed', updatedMs: now() }).catch(() => {});
			log({ event: 'plan.failed', scope, category: errorCategory(error) });
			throw error;
		}
	}

	/**
	 * Re-checks every candidate and promotes the ones whose grace period has elapsed.
	 * Still no deletion: `review` is what an operator reads before enabling apply.
	 */
	async function review(scope) {
		const startedMs = now();
		const summary = await reviewInto(scope, startedMs);
		log({ event: 'review.completed', scope, ...summary });
		return summary;
	}

	async function reviewInto(scope, startedMs) {
		const run = await store.beginRun({ scope, mode: 'plan', dryRun: true, startedMs });
		const workspaceIds = await store.workspacesForScope(scope);
		let promoted = 0;
		let cancelled = 0;
		let protectedCount = 0;
		let eligible = 0;
		try {
			for (const workspaceId of workspaceIds) {
				await store.pruneIntents({ nowMs: startedMs, workspaceId });
				const observed = await store.listCandidates(workspaceId, { states: ['observed'], limit: 10000 });
				for (const candidate of observed) {
					const reference = await store.isReferenced(workspaceId, candidate.digest, { nowMs: startedMs });
					if (reference.referenced) {
						protectedCount += 1;
						await store.transitionCandidate({
							workspaceId, digest: candidate.digest,
							from: ['observed'], to: 'cancelled',
							reason: `referenced:${reference.blockers.join(',')}`,
							updatedMs: startedMs,
						});
						cancelled += 1;
						continue;
					}
					if (candidate.eligibleAfterMs > startedMs) continue;
					const promotedRow = await store.transitionCandidate({
						workspaceId, digest: candidate.digest,
						from: ['observed'], to: 'eligible',
						reason: 'grace-elapsed',
						runId: run.runId,
						updatedMs: startedMs,
					});
					if (promotedRow) promoted += 1;
				}
				const totals = await store.candidateTotals(workspaceId);
				eligible += totals.eligible?.candidates ?? 0;
			}
			await store.updateRun(run.runId, { state: 'completed', updatedMs: now() });
			return { runId: run.runId, scope, promoted, cancelled, protected: protectedCount, eligible };
		} catch (error) {
			await store.updateRun(run.runId, { state: 'failed', updatedMs: now() }).catch(() => {});
			throw error;
		}
	}

	/**
	 * Deletes eligible candidates — but only when the operator switch is on. With the
	 * switch off (the default) it behaves exactly like review plus a would-delete report,
	 * so enabling deletion is a separate, deliberate action.
	 */
	async function apply(scope) {
		const startedMs = now();
		const dryRun = settings.apply !== true;
		const run = await store.beginRun({
			scope, mode: 'apply', dryRun, startedMs,
		});
		const workspaceIds = await store.workspacesForScope(scope);
		const results = { deleted: 0, deletedBytes: 0, wouldDelete: 0, cancelled: 0, failed: 0, alreadyMissing: 0 };
		try {
			for (const workspaceId of workspaceIds) {
				const scheduled = await store.listCandidates(workspaceId, {
					states: ['eligible'], eligibleByMs: startedMs, limit: settings.maxSweepBatch,
				});
				for (const candidate of scheduled) {
					const outcome = await sweepCandidate(scope, candidate, { run, dryRun, nowMs: startedMs });
					switch (outcome.action) {
						case 'deleted':
							results.deleted += 1;
							results.deletedBytes += outcome.sizeBytes ?? 0;
							await store.bumpRun(run.runId, {
								deletedCount: 1, deletedBytes: outcome.sizeBytes ?? 0, updatedMs: now(),
							});
							break;
						case 'would-delete':
							results.wouldDelete += 1;
							break;
						case 'cancelled':
							results.cancelled += 1;
							break;
						case 'failed':
							results.failed += 1;
							break;
						case 'already-missing':
							results.alreadyMissing += 1;
							break;
						default:
							break;
					}
				}
			}
			await store.updateRun(run.runId, { state: 'completed', updatedMs: now() });
			const summary = { runId: run.runId, scope, mode: 'apply', dryRun, ...results };
			log({ event: dryRun ? 'apply.dry-run' : 'apply.completed', scope, ...results });
			return summary;
		} catch (error) {
			await store.updateRun(run.runId, { state: 'failed', updatedMs: now() }).catch(() => {});
			log({ event: 'apply.failed', scope, category: errorCategory(error) });
			throw error;
		}
	}

	/**
	 * Continues an interrupted run. `deleting` candidates are the crash window: the object
	 * may or may not already be gone, so the sweep re-reads the provider identity and
	 * never deletes an object it cannot recognise.
	 */
	async function resume(runId) {
		const existing = await store.readRun(runId);
		if (!existing) throw new WorkspaceError(404, 'run_not_found');
		const startedMs = now();
		const dryRun = settings.apply !== true;
		const workspaceIds = await store.workspacesForScope(existing.scope);
		const results = { deleted: 0, deletedBytes: 0, wouldDelete: 0, cancelled: 0, failed: 0, alreadyMissing: 0 };
		await store.updateRun(runId, { state: 'applying', updatedMs: startedMs });
		for (const workspaceId of workspaceIds) {
			const inflight = await store.listCandidates(workspaceId, {
				states: ['deleting', 'eligible'], eligibleByMs: startedMs, limit: settings.maxSweepBatch,
			});
			for (const candidate of inflight) {
				const outcome = await sweepCandidate(existing.scope, candidate, {
					run: existing, dryRun, nowMs: startedMs, resuming: true,
				});
				switch (outcome.action) {
					case 'deleted':
						results.deleted += 1;
						results.deletedBytes += outcome.sizeBytes ?? 0;
						await store.bumpRun(runId, {
							deletedCount: 1, deletedBytes: outcome.sizeBytes ?? 0, updatedMs: now(),
						});
						break;
					case 'would-delete':
						results.wouldDelete += 1;
						break;
					case 'cancelled':
						results.cancelled += 1;
						break;
					case 'failed':
						results.failed += 1;
						break;
					case 'already-missing':
						results.alreadyMissing += 1;
						break;
					default:
						break;
				}
			}
		}
		await store.updateRun(runId, { state: 'completed', updatedMs: now() });
		return { runId, scope: existing.scope, mode: 'resume', dryRun, ...results };
	}

	/**
	 * The single-object safety gate, in order:
	 *   1. is it still unreferenced? (all seven sources, one snapshot)
	 *   2. does the store still report the identity we recorded?
	 *   3. is a recovery copy in place?
	 *   4. fence: mark `deleting` (committed) before touching the object
	 *   5. re-check references after the fence, then delete exactly that object
	 *
	 * @param {string} scope the run scope (`workspace:<id>` or `all`).
	 * @param {{workspaceId: string, digest: string, objectVersion: string | null,
	 *   sizeBytes: number, recoveryPath: string | null}} candidate
	 */
	async function sweepCandidate(scope, candidate, context = {}) {
		const workspaceId = candidate.workspaceId ?? scopeWorkspaceId(scope);
		if (!isValidWorkspaceId(workspaceId) || !digestPattern.test(candidate.digest)) {
			throw new WorkspaceError(400, 'invalid_candidate');
		}
		const sweep = () => sweepUnderFence(scope, candidate, context);
		return store.withWorkspaceLock ? store.withWorkspaceLock(workspaceId, sweep) : sweep();
	}

	async function sweepUnderFence(scope, candidate, context) {
		const workspaceId = candidate.workspaceId ?? scopeWorkspaceId(scope);
		const digest = candidate.digest;
		const nowMs = context.nowMs ?? now();
		const dryRun = context.dryRun ?? settings.apply !== true;
		const run = context.run ?? null;
		if (!workspaceId || !digest) throw new WorkspaceError(400, 'invalid_candidate');
		const source = inventory(workspaceId);

		const current = await store.findCandidate(workspaceId, digest);
		if (!current) return { action: 'cancelled', reason: 'candidate-not-found' };
		const resuming = context.resuming === true || current.state === 'deleting';
		if (!resuming && current.state !== 'eligible') {
			return { action: 'cancelled', reason: `state:${current.state}` };
		}
		if (source.ownsVersion && !source.ownsVersion(current.objectVersion)) {
			await store.transitionCandidate({
				workspaceId, digest, from: ['eligible', 'deleting'], to: 'cancelled',
				reason: 'object-namespace-changed', updatedMs: nowMs,
			});
			return { action: 'cancelled', reason: 'object-namespace-changed' };
		}
		const head = await source.head(digest);

		// A candidate whose object vanished on its own is not a failure and must not stick
		// around: recording it as deleted keeps a retry idempotent.
		if (!head) {
			if (resuming) {
				await store.transitionCandidate({
					workspaceId, digest, from: ['deleting'], to: 'deleted',
					reason: 'already-missing', lastError: null, runId: run?.runId ?? null, updatedMs: nowMs,
				});
				return { action: 'already-missing', sizeBytes: 0 };
			}
			await store.transitionCandidate({
				workspaceId, digest, from: ['eligible'], to: 'cancelled',
				reason: 'object-missing', updatedMs: nowMs,
			});
			return { action: 'cancelled', reason: 'object-missing' };
		}

		// Identity check: an object rewritten since observation is a different object. It is
		// cancelled rather than deleted, which is what protects a rebuilt file (G03).
		if (candidate.objectVersion && head.version && candidate.objectVersion !== head.version) {
			await store.transitionCandidate({
				workspaceId, digest,
				from: resuming ? ['deleting'] : ['eligible'], to: 'cancelled',
				reason: 'object-identity-changed', updatedMs: nowMs,
			});
			return { action: 'cancelled', reason: 'object-identity-changed' };
		}

		const reference = await store.isReferenced(workspaceId, digest, { nowMs });
		if (reference.referenced) {
			// Bidirectional race, collector side: something started referencing the object
			// again (a write intent, a new revision, a hold). Cancel instead of deleting.
			await store.transitionCandidate({
				workspaceId, digest,
				from: resuming ? ['deleting'] : ['eligible'], to: 'cancelled',
				reason: `referenced:${reference.blockers.join(',')}`,
				recoveryPath: null, updatedMs: nowMs,
			});
			log({ event: 'candidate.cancelled', workspaceId, reason: 're-referenced' });
			return { action: 'cancelled', reason: 're-referenced' };
		}

		if (dryRun) {
			// Dry-run stops here: nothing below this line runs without the operator switch.
			return { action: 'would-delete', sizeBytes: head.sizeBytes };
		}

		// Verified recovery copy first: a delete without one cannot be undone, and the task
		// book requires "永久删除前保留经过恢复验证的副本".
		let recoveryPath = current.recoveryPath ?? null;
		if (!recoveryPath) {
			const target = join(orThrow(settings.recoveryDirectory), workspaceId, digest);
			try {
				await source.copyTo(target, digest, head.sizeBytes);
				recoveryPath = target;
			} catch (error) {
				await store.transitionCandidate({
					workspaceId, digest,
					from: resuming ? ['deleting'] : ['eligible'], to: 'failed',
					reason: 'recovery-copy-failed', lastError: blobGcErrors.copyFailed, updatedMs: nowMs,
				});
				log({ event: 'candidate.failed', workspaceId, category: blobGcErrors.copyFailed });
				return { action: 'failed', category: blobGcErrors.copyFailed };
			}
		}

		// The fence: `deleting` is committed before the object is touched, so a resumed run
		// knows a delete may have happened, and a second collector loses the CAS below.
		const fenced = await store.transitionCandidate({
			workspaceId, digest,
			from: resuming ? ['deleting'] : ['eligible'], to: 'deleting',
			reason: 'guarded', recoveryPath,
			objectVersion: candidate.objectVersion ?? head.version ?? null,
			runId: run?.runId ?? null, updatedMs: nowMs,
		});
		if (!fenced && !resuming) return { action: 'cancelled', reason: 'state-conflict' };

		// Final reference check after the fence: a writer that registered an intent while the
		// copy was being made cancels the delete instead of losing its object.
		const afterFence = await store.isReferenced(workspaceId, digest, { nowMs });
		if (afterFence.referenced) {
			await store.transitionCandidate({
				workspaceId, digest, from: ['deleting'], to: 'cancelled',
				reason: `referenced:${afterFence.blockers.join(',')}`, updatedMs: nowMs,
			});
			return { action: 'cancelled', reason: 're-referenced' };
		}

		let deletion;
		try {
			deletion = await source.deleteExact(digest, candidate.objectVersion ?? head.version ?? null);
		} catch (error) {
			await store.transitionCandidate({
				workspaceId, digest, from: ['deleting'], to: 'failed',
				reason: 'delete-failed', lastError: blobGcErrors.deleteFailed, updatedMs: nowMs,
			});
			log({ event: 'candidate.failed', workspaceId, category: blobGcErrors.deleteFailed });
			return { action: 'failed', category: blobGcErrors.deleteFailed };
		}
		if (deletion.identityChanged) {
			await store.transitionCandidate({
				workspaceId, digest, from: ['deleting'], to: 'cancelled',
				reason: 'object-identity-changed', updatedMs: nowMs,
			});
			return { action: 'cancelled', reason: 'object-identity-changed' };
		}
		if (deletion.missing) {
			await store.transitionCandidate({
				workspaceId, digest, from: ['deleting'], to: 'deleted',
				reason: 'already-missing', updatedMs: nowMs,
			});
			return { action: 'already-missing', sizeBytes: 0 };
		}
		await store.transitionCandidate({
			workspaceId, digest, from: ['deleting'], to: 'deleted',
			reason: 'deleted', recoveryPath, runId: run?.runId ?? null, updatedMs: nowMs,
		});
		log({ event: 'candidate.deleted', workspaceId, sizeBytes: head.sizeBytes });
		return { action: 'deleted', sizeBytes: head.sizeBytes };
	}

	function orThrow(value) {
		if (typeof value !== 'string' || !value.trim()) {
			// Reached only when apply was enabled without a recovery directory; the settings
			// resolver rejects that earlier, so this is defence in depth.
			throw new WorkspaceError(500, 'blob_gc_recovery_dir_required');
		}
		return value;
	}

	return {
		settings,
		plan,
		review,
		apply,
		resume,
		sweepCandidate,
		close: closeInventories,
	};
}

/** Convenience wrapper matching the task-book signature `planBlobGc(scope)`. */
export function planBlobGc(scope, options) {
	const collector = createBlobGc(unwrap(options));
	return collector.plan(scope).finally(() => collector.close());
}

export function reviewBlobGc(scope, options) {
	const collector = createBlobGc(unwrap(options));
	return collector.review(scope).finally(() => collector.close());
}

export function applyBlobGc(scope, options) {
	const collector = createBlobGc(unwrap(options));
	return collector.apply(scope).finally(() => collector.close());
}

export function resumeBlobGc(runId, options) {
	const collector = createBlobGc(unwrap(options));
	return collector.resume(runId).finally(() => collector.close());
}

export async function sweepCandidate(scope, candidate, options) {
	const { ...rest } = options ?? {};
	const collector = createBlobGc(unwrap(rest));
	try {
		return await collector.sweepCandidate(scope, candidate, rest.context ?? {});
	} finally {
		collector.close();
	}
}

function unwrap(options) {
	if (!options || typeof options !== 'object') {
		throw new WorkspaceError(500, 'blob_gc_store_required');
	}
	if (!options.store) throw new WorkspaceError(500, 'blob_gc_store_required');
	return options;
}

/** One-line safe rendering for operator output: sigils and counts only. */
export function describeBlobGcSummary(summary) {
	const mode = summary.mode ?? 'plan';
	const state = summary.dryRun === false ? 'apply' : 'dry-run';
	return `${mode} (${state}): scanned=${summary.scanned ?? 0} candidates=${summary.candidates ?? 0} `
		+ `deleted=${summary.deleted ?? 0} wouldDelete=${summary.wouldDelete ?? 0} `
		+ `cancelled=${summary.cancelled ?? 0} failed=${summary.failed ?? 0}`;
}

// ---------------------------------------------------------------------------
// Operator CLI: `node apps/web/blob-gc.mjs <plan|review|apply|resume> [scope|run]`
//
// The default verb is `plan`, and every verb is a dry-run unless
// LOG4STELLAR_BLOB_GC_APPLY=1 is set *and* a recovery directory is configured, so a
// mistyped command can never be the thing that deletes objects.
// ---------------------------------------------------------------------------

async function cliMain(argv = process.argv.slice(2)) {
	const { readFile } = await import('node:fs/promises');
	const { homedir } = await import('node:os');
	const { join: joinPath } = await import('node:path');
	const { Pool } = await import('pg');
	const configPath = process.env.LOG4STELLAR_STORAGE_CONFIG
		?? joinPath(homedir(), '.config', 'log4stellar', 'workspace-storage.json');
	const settings = resolveBlobGcSettings(process.env);
	const [verb = 'plan', target, ...extra] = argv;
	if (extra.length) throw new WorkspaceError(400, 'blob_gc_usage');
	const storage = JSON.parse(await readFile(configPath, 'utf8'));
	const profiles = tenantStorageProfiles(storage);
	const defaultScope = settings.workspaces.length > 0
		? `workspace:${settings.workspaces[0]}`
		: 'all';
	const scope = verb === 'resume' ? null : (target ?? defaultScope);
	const pool = new Pool({ connectionTimeoutMillis: 5000, max: 4, ...storage.postgres });
	let collector;
	let catalogLease;
	try {
		if (process.env.LOG4STELLAR_MANAGED_TENANTS === '1') catalogLease = await holdTenantStorageReadLock(pool);
		const workspaceCatalog = await readBlobGcWorkspaceCatalog(pool, {
			managed: process.env.LOG4STELLAR_MANAGED_TENANTS === '1',
		});
		collector = createBlobGc({
			store: createBlobGcStore(pool, { workspaceCatalog }),
			inventory(_settings, workspaceId) {
				if (!workspaceCatalog.has(workspaceId)) throw new WorkspaceError(404, 'blob_gc_workspace_not_found');
				const tenantId = workspaceCatalog.get(workspaceId);
				return openRustfsInventory(selectTenantStorage(storage.s3, profiles, tenantId), workspaceId, { tenantId });
			},
			settings,
		});
		let summary;
		if (verb === 'plan') summary = await collector.plan(scope);
		else if (verb === 'review') summary = await collector.review(scope);
		else if (verb === 'apply') summary = await collector.apply(scope);
		else if (verb === 'resume') {
			if (!target) throw new WorkspaceError(400, 'blob_gc_usage');
			summary = await collector.resume(target);
		} else throw new WorkspaceError(400, 'blob_gc_unknown_mode');
		console.log(JSON.stringify({ ...summary, summary: describeBlobGcSummary(summary) }, null, 2));
	} finally {
		collector?.close();
		catalogLease?.release(true);
		await pool.end();
	}
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
	cliMain().catch((error) => {
		// Print the category, not the message: a driver error may embed a connection string.
		console.error(JSON.stringify({ error: error?.code ?? error?.name ?? 'blob-gc-failed' }));
		process.exitCode = 1;
	});
}
