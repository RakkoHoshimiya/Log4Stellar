/**
 * Replay coordination for offline editing (docs/web-offline.md §3).
 *
 * The coordinator owns one scope at a time and is the only thing that may POST an
 * outbox row. It is deliberately transport-agnostic: the caller injects `commit(op)`
 * and `authenticate()`, so the same code path is exercised by a Node test with a fake
 * server and by the workbench with `fetch`.
 */

import {
	OfflineError,
	offlineErrorCodes,
	draftStates,
	opStates,
	opBlockReasons,
	normalizeOfflineScope,
	sameScope,
	scopeKeyOf,
	retryLimits,
} from './offline-contract.js';

/**
 * The browser lease. Two tabs of the same account share one IndexedDB scope, and if both
 * drained the outbox they would race to submit the same operation. The lease is a
 * single row with a holder and an expiry; a dead tab's lease is taken over once it
 * lapses, which is why the timestamp is stored rather than a boolean.
 */
export const leaseLimits = Object.freeze({ durationMs: 30_000, renewWithinMs: 10_000 });

/**
 * Turns an IndexedDB request into a promise. `IDBRequest` is not a thenable in a real
 * browser, so reading `.then()` off it works only against a mock — which is exactly how
 * a lease bug reaches production with green tests.
 */
function requestResult(request) {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

/**
 * Re-verifies the account, tenant and workspace before anything is replayed.
 *
 * This is the function that makes O04 true: a queue written by account A can only be
 * drained while the session still belongs to A in the same workspace. A mismatch is a
 * hard stop (`AccountChanged`), not a retry, because retrying an operation under a
 * different identity would either fail forever or — worse — write A's content into B's
 * workspace if the ids ever collided.
 */
export async function verifyReplayScope({ scope, authenticate, now = Date.now }) {
	const normalized = normalizeOfflineScope(scope);
	if (typeof authenticate !== 'function') {
		throw new OfflineError(offlineErrorCodes.invalidRecord, 'Replay needs an authenticate callback.');
	}
	const session = await authenticate();
	if (!session) {
		throw new OfflineError(offlineErrorCodes.accountChanged, 'The session ended before replay.');
	}
	if (session.ok !== true) {
		throw new OfflineError(offlineErrorCodes.accountChanged, 'The session could not be re-verified before replay.');
	}
	const current = {
		origin: String(session.origin ?? normalized.origin).replace(/\/+$/, '').toLowerCase(),
		accountId: session.accountId,
		tenantId: session.tenantId ?? 'default',
		workspaceId: session.workspaceId,
	};
	if (!sameScope(normalized, current)) {
		throw new OfflineError(offlineErrorCodes.accountChanged, 'The session belongs to a different account or workspace.');
	}
	// The same monotonic clock the store uses for its window; `Date.now` outside is a
	// mistake that only shows up when a clock jump silently expires a queue.
	const at = typeof now === 'function' ? now() : now;
	if (typeof session.expiresMs === 'number' && at > session.expiresMs) {
		throw new OfflineError(offlineErrorCodes.offlineExpired, 'The offline window expired; sign in again.');
	}
	return Object.freeze({
		scope: normalized,
		scopeKey: scopeKeyOf(normalized),
		remainingMs: typeof session.expiresMs === 'number' ? Math.max(0, session.expiresMs - at) : null,
	});
}

/**
 * Classifies a server answer into the four outcomes the coordinator acts on. Everything
 * the sync contract can answer maps to exactly one of: committed, replayed, conflict,
 * blocked, retry.
 */
export function classifyCommit({ status, body }) {
	if (status === 200 || status === 201) {
		return { outcome: 'committed', replayed: body?.replayed === true, body };
	}
	if (status === 409) {
		const code = body?.error;
		if (code === 'IdempotencyKeyReused') {
			// The key exists with a DIFFERENT fingerprint: the client sent a different body
			// under a key the server already answered. Retrying cannot fix it and silently
			// minting a new key would create a second version, so it is a hard stop.
			return { outcome: 'blocked', reason: opBlockReasons.accountChanged, body };
		}
		return { outcome: 'conflict', reason: opBlockReasons.conflict, body };
	}
	if (status === 401 || status === 403) {
		return { outcome: 'blocked', reason: opBlockReasons.noPermission, body };
	}
	if (status === 410) {
		return { outcome: 'blocked', reason: opBlockReasons.resyncRequired, body };
	}
	if (status === 428 || status === 400) {
		// A protocol error in a stored operation can never succeed on retry; it must be
		// surfaced, not looped, or the queue head blocks every later edit forever.
		return { outcome: 'blocked', reason: opBlockReasons.dependency, body };
	}
	if (status === 413) {
		return { outcome: 'blocked', reason: opBlockReasons.dependency, body };
	}
	if (status === 429 || status >= 500) {
		return { outcome: 'retry', body };
	}
	return { outcome: 'retry', body };
}

/**
 * Runs one replay pass for a scope. It returns a summary instead of throwing on a
 * blocked operation: a queue with a conflicted head still has to be able to report
 * itself, and the UI shows the reason rather than a stack trace.
 */
export async function drainOutbox({
	store,
	scope,
	authenticate,
	commit,
	acquireLease,
	releaseLease,
	now = Date.now,
	maxOperations = 50,
} = {}) {
	if (!store || typeof store.listOutbox !== 'function') {
		throw new OfflineError(offlineErrorCodes.invalidRecord, 'Replay needs an offline store.');
	}
	if (typeof commit !== 'function') {
		throw new OfflineError(offlineErrorCodes.invalidRecord, 'Replay needs a commit callback.');
	}
	const summary = { replayed: 0, committed: 0, conflicts: 0, blocked: 0, retried: 0, skipped: 0, stopReason: null };

	const scopeRecord = await store.readScopeRecord();
	if (scopeRecord?.locked) {
		throw new OfflineError(offlineErrorCodes.scopeLocked, 'The offline queue is locked: ' + String(scopeRecord.lockReason ?? 'unknown') + '.');
	}
	const verification = await verifyReplayScope({ scope, authenticate, now });
	const at = typeof now === 'function' ? now() : now;
	if (typeof scopeRecord?.expiresMs === 'number' && at > scopeRecord.expiresMs) {
		await store.lockScope(opBlockReasons.offlineExpired);
		throw new OfflineError(offlineErrorCodes.offlineExpired, 'The offline window expired; sign in and export the draft.');
	}

	const lease = typeof acquireLease === 'function' ? await acquireLease() : { acquired: true };
	if (!lease?.acquired) {
		summary.stopReason = 'lease';
		return summary;
	}
	try {
		const operations = (await store.listOutbox())
			.filter(operation => operation.state === opStates.pending)
			.sort((left, right) => left.createdMs - right.createdMs || left.opId.localeCompare(right.opId));
		let processed = 0;
		for (const operation of operations) {
			if (processed >= maxOperations) {
				summary.stopReason = 'cap';
				break;
			}
			if (operation.nextRetryAt > at) {
				summary.skipped += 1;
				continue;
			}
			// The list was read once, before the first upload. A conflict on one path
			// blocks its dependents in the database while this loop is already holding the
			// earlier snapshot, so the state is re-read before sending: submitting a save
			// whose base revision a sibling just invalidated is the one way this loop could
			// overwrite the other side of a conflict.
			if (typeof store.readOperation === 'function') {
				const current = await store.readOperation(operation.opId);
				if (!current || current.state !== opStates.pending) {
					summary.skipped += 1;
					continue;
				}
			}
			processed += 1;
			const answer = await commit(operation);
			const classification = classifyCommit(answer);
			if (classification.outcome === 'committed') {
				await applyCommitReceipt({
					store,
					operation,
					result: answer.body ?? {},
					text: answer.text,
					now,
				});
				if (classification.replayed) {
					summary.replayed += 1;
				} else {
					summary.committed += 1;
				}
				continue;
			}
			if (classification.outcome === 'conflict') {
				await handleConflict({ store, operation, response: answer.body ?? {}, now });
				summary.conflicts += 1;
				// A conflict pauses only the operations that depend on this path; the rest of
				// the queue is independent work the user still expects to land.
				continue;
			}
			if (classification.outcome === 'blocked') {
				await store.blockOperation({ opId: operation.opId, reason: classification.reason });
				summary.blocked += 1;
				if (classification.reason === opBlockReasons.noPermission || classification.reason === opBlockReasons.offlineExpired) {
					await store.lockScope(classification.reason);
					summary.stopReason = classification.reason;
					break;
				}
				if (classification.reason === opBlockReasons.resyncRequired) {
					summary.stopReason = classification.reason;
					break;
				}
				continue;
			}
			const attempt = await store.noteAttempt({ opId: operation.opId });
			summary.retried += 1;
			if (attempt.giveUp) {
				summary.stopReason = 'giveUp';
				break;
			}
		}
	} finally {
		if (typeof releaseLease === 'function') {
			await releaseLease(lease);
		}
	}
	return Object.freeze({ ...summary, verification });
}

/**
 * Persists a confirmed result. The receipt is written with the operation removed in one
 * transaction (see `store.applyReceipt`), so a crash cannot leave a queue entry that
 * already landed on the server.
 */
export async function applyCommitReceipt({ store, operation, result, text, now = Date.now }) {
	if (!store || typeof store.applyReceipt !== 'function') {
		throw new OfflineError(offlineErrorCodes.invalidRecord, 'Applying a receipt needs an offline store.');
	}
	const receipt = await store.applyReceipt({
		opId: operation.opId,
		result: {
			seq: result.seq,
			changeId: result.changeId,
			revisionId: result.revisionId,
			fileId: result.fileId,
			etag: result.etag,
			sha256: result.sha256,
			replayed: result.replayed === true,
			text,
		},
	});
	return receipt;
}

/**
 * Keeps both sides of a conflict.
 *
 * The draft is NOT deleted and is NOT marked synced: the user's text stays in the draft
 * table (exportable, and re-submittable once they choose), while the server's version is
 * described in the block reason. Dependent operations on the same path are blocked in
 * the same pass so the queue cannot reorder around the conflict and make a later save
 * look like it was based on a revision that no longer exists.
 */
export async function handleConflict({ store, operation, response, now = Date.now }) {
	if (!store || typeof store.blockOperation !== 'function') {
		throw new OfflineError(offlineErrorCodes.invalidRecord, 'Handling a conflict needs an offline store.');
	}
	const at = typeof now === 'function' ? now() : now;
	const blocked = await store.blockOperation({ opId: operation.opId, reason: opBlockReasons.conflict, retryAt: at });
	const dependents = (await store.listOutbox()).filter(candidate => candidate.opId !== operation.opId
		&& candidate.path === operation.path
		&& candidate.state === opStates.pending);
	for (const dependent of dependents) {
		await store.blockOperation({ opId: dependent.opId, reason: opBlockReasons.dependency, retryAt: at });
	}
	return Object.freeze({
		draftPreserved: true,
		conflictPath: response.conflictPath ?? null,
		currentRevision: response.currentRevision ?? null,
		serverSeq: response.seq ?? null,
		blockedDependents: dependents.length,
	});
}

/**
 * Acquires the single-writer lease. `writerId` is a per-tab random string; a lease whose
 * holder is this tab can be renewed, and one whose expiry has passed is taken over —
 * the alternative (a tab that crashed holding the lease) would wedge the queue forever.
 */
export function createLeaseManager({ store, writerId, now = Date.now, durationMs = leaseLimits.durationMs } = {}) {
	if (typeof writerId !== 'string' || writerId === '') {
		throw new OfflineError(offlineErrorCodes.invalidRecord, 'A lease needs a writer ID.');
	}
	const key = 'lease:' + store.scopeKey;
	return Object.freeze({
		writerId,
		async acquire() {
			const at = now();
			const readTransaction = store.database.transaction(['leases'], 'readwrite');
			const existing = await requestResult(readTransaction.objectStore('leases').get(key));
			const holder = existing?.holder;
			const expired = !existing || existing.expiresMs <= at;
			if (!expired && holder !== writerId) {
				return { acquired: false, holder, expiresMs: existing.expiresMs };
			}
			const expiresMs = at + durationMs;
			const transaction = store.database.transaction(['leases'], 'readwrite');
			transaction.objectStore('leases').put({ key, holder: writerId, expiresMs, acquiredMs: at });
			await new Promise((resolve, reject) => {
				transaction.oncomplete = () => resolve();
				transaction.onerror = () => reject(transaction.error);
				transaction.onabort = () => reject(transaction.error);
			});
			return { acquired: true, holder: writerId, expiresMs };
		},
		async release() {
			const transaction = store.database.transaction(['leases'], 'readwrite');
			const leases = transaction.objectStore('leases');
			const existing = await requestResult(leases.get(key));
			if (existing?.holder === writerId) {
				leases.delete(key);
			}
			await new Promise((resolve, reject) => {
				transaction.oncomplete = () => resolve();
				transaction.onerror = () => reject(transaction.error);
				transaction.onabort = () => reject(transaction.error);
			});
		},
	});
}

/**
 * Retry budget the UI uses to decide whether to nag. It is exported so the test can
 * assert the threshold rather than hard-coding a number twice.
 */
export const offlineRetryCeiling = retryLimits.maxAttempts;

export { draftStates, opStates, opBlockReasons };
