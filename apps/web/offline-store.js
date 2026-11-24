/**
 * IndexedDB persistence for offline editing (docs/web-offline.md §2).
 *
 * This module is loaded in the workbench and in a browser test, so it never imports
 * `node:` and never refers to `window` at module scope. It takes its `indexedDB` handle
 * by injection for exactly one reason: a Node test can pass a fake implementation and
 * still exercise the real transaction orchestration, which is where the data-loss bugs
 * live. A test that mocked the orchestration itself would prove nothing.
 */

import {
	OfflineError,
	offlineErrorCodes,
	offlineSchema,
	offlineStores,
	offlineSchemaVersion,
	offlineDatabaseName,
	requireOfflineEnabled,
	scopeKeyOf,
	extendKey,
	draftStates,
	opStates,
	assertPersistable,
	digestText,
	retryDelay,
	retryLimits,
	normalizeOfflineWindow,
	offlineWindowLimits,
} from './offline-contract.js';

/**
 * Requests always resolve to a value instead of rejecting, so the caller can await a
 * batch inside one transaction without a rejected request aborting the transaction at
 * an unpredictable point.
 */
function requestToPromise(request) {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

function transactionDone(transaction) {
	return new Promise((resolve, reject) => {
		transaction.oncomplete = () => resolve();
		transaction.onerror = () => reject(transaction.error);
		transaction.onabort = () => reject(transaction.error || new OfflineError(offlineErrorCodes.invalidRecord, 'The offline transaction was aborted.'));
	});
}

/**
 * Opens (and upgrades) the database. The upgrade path is additive: a store or index
 * that is only in the new schema is created, and nothing is ever deleted, because a
 * rollback to the previous build must still find its own records. A database written by
 * a NEWER build is refused by name rather than opened and misread.
 */
export async function openOfflineDatabase({ indexedDB, name = offlineDatabaseName, version = offlineSchemaVersion } = {}) {
	if (!indexedDB || typeof indexedDB.open !== 'function') {
		throw new OfflineError(offlineErrorCodes.offlineDisabled, 'This browser does not provide IndexedDB.');
	}
	const request = indexedDB.open(name, version);
	request.onupgradeneeded = event => {
		const database = request.result;
		// A downgrade (oldVersion > version) reaches this branch with `event.oldVersion`
		// greater than our schema; refuse rather than deleting stores the other build owns.
		if (event.oldVersion > version) {
			throw new OfflineError(offlineErrorCodes.schemaTooNew, 'The offline cache was written by a newer build.');
		}
		for (const store of offlineSchema) {
			const objectStore = database.objectStoreNames.contains(store.name)
				? request.transaction.objectStore(store.name)
				: database.createObjectStore(store.name, { keyPath: store.keyPath });
			for (const index of store.indexes ?? []) {
				if (!objectStore.indexNames.contains(index.name)) {
					objectStore.createIndex(index.name, index.keyPath, { unique: false });
				}
			}
		}
	};
	const database = await requestToPromise(request);
	const actual = database.version;
	if (actual > version) {
		database.close();
		throw new OfflineError(offlineErrorCodes.schemaTooNew, 'The offline cache was written by a newer build.');
	}
	return database;
}

/**
 * The store a single scope talks to. Everything it writes is prefixed with that scope,
 * so two accounts in one browser can never read each other's rows even if a query for
 * gets the filter wrong: the key itself is partitioned.
 */
export async function openOfflineStore({ scope, indexedDB = globalThis.indexedDB, policy = {}, now = Date.now, database: provided } = {}) {
	const normalized = requireOfflineEnabled(scope);
	const windowMs = normalizeOfflineWindow(policy.windowMs);
	const database = provided ?? await openOfflineDatabase({ indexedDB });
	const scopeKey = scopeKeyOf(normalized);

	/**
	 * Records the scope the first time it is used. The record carries the window and the
	 * moment it was first seen, which is what `verifyReplayScope` compares against: the
	 * expiry is anchored to the FIRST offline write, not to the last one, so a queue
	 * cannot be kept alive forever by editing it again every day.
	 */
	async function registerScope() {
		const transaction = database.transaction([offlineStores.scopes], 'readwrite');
		const store = transaction.objectStore(offlineStores.scopes);
		const existing = await requestToPromise(store.get(scopeKey));
		if (!existing) {
			const at = now();
			store.put({
				key: scopeKey,
				origin: normalized.origin,
				accountId: normalized.accountId,
				tenantId: normalized.tenantId,
				workspaceId: normalized.workspaceId,
				schemaVersion: offlineSchemaVersion,
				windowMs,
				firstUsedMs: at,
				expiresMs: at + windowMs,
				locked: false,
				lockReason: null,
			});
		}
		await transactionDone(transaction);
	}

	async function readScopeRecord() {
		const transaction = database.transaction([offlineStores.scopes], 'readonly');
		const record = await requestToPromise(transaction.objectStore(offlineStores.scopes).get(scopeKey));
		return record ?? undefined;
	}

	/**
	 * The cached base document for a path: the revision the browser last saw from the
	 * server plus the bytes. A draft's `baseRevision` must come from here, never from
	 * "whatever the server says now", or an offline edit would claim to be based on a
	 * revision the user never saw.
	 */
	async function recordBaseDocument({ path, revisionId, text, digest, modifiedMs }) {
		const value = {
			key: extendKey(scopeKey, path),
			scopeKey,
			path,
			revisionId,
			text,
			digest,
			modifiedMs: modifiedMs ?? now(),
			cachedMs: now(),
		};
		assertPersistable(value, 'baseDocument');
		const transaction = database.transaction([offlineStores.baseDocuments], 'readwrite');
		transaction.objectStore(offlineStores.baseDocuments).put(value);
		await transactionDone(transaction);
		return value;
	}

	async function readBaseDocument(path) {
		const transaction = database.transaction([offlineStores.baseDocuments], 'readonly');
		const record = await requestToPromise(transaction.objectStore(offlineStores.baseDocuments).get(extendKey(scopeKey, path)));
		return record ?? undefined;
	}

	async function listBaseDocuments() {
		const transaction = database.transaction([offlineStores.baseDocuments], 'readonly');
		const index = transaction.objectStore(offlineStores.baseDocuments).index('byScope');
		return await requestToPromise(index.getAll(IDBKeyRangeOnly(scopeKey)));
	}

	/**
	 * Saves the draft AND enqueues its operation in ONE transaction.
	 *
	 * The single transaction is the whole point of this function: a draft with no outbox
	 * row is invisible to the coordinator (silently never uploaded), and an outbox row
	 * with no draft cannot be replayed or exported. Both halves are written together or
	 * neither is.
	 *
	 * `opId` is generated once by the caller and carried through every retry, so a
	 * replayed upload is the same logical operation to the server as well.
	 */
	async function persistDraftAndEnqueue({ path, text, baseRevision, opId, idempotencyKey, mode = 'save', digest, deviceId }) {
		if (typeof path !== 'string' || !path.startsWith('/')) {
			throw new OfflineError(offlineErrorCodes.invalidRecord, 'A draft needs an absolute workspace path.');
		}
		if (typeof opId !== 'string' || opId === '') {
			throw new OfflineError(offlineErrorCodes.invalidRecord, 'A draft needs an operation ID.');
		}
		const bodyDigest = digest ?? await digestText(text);
		const at = now();
		const draftId = extendKey(scopeKey, path);
		const draft = {
			draftId,
			scopeKey,
			scopePath: extendKey(scopeKey, path),
			path,
			text,
			digest: bodyDigest,
			baseRevision: baseRevision ?? null,
			mode,
			state: draftStates.queued,
			opId,
			createdMs: at,
			updatedMs: at,
		};
		const operation = {
			opId,
			scopeKey,
			path,
			draftId,
			// The idempotency key is generated once and stored; a retry re-sends it byte for
			// byte. A fresh key per attempt would turn one user edit into several versions.
			idempotencyKey,
			baseRevision: baseRevision ?? null,
			mode,
			digest: bodyDigest,
			size: new TextEncoder().encode(text).length,
			deviceId: deviceId ?? null,
			state: opStates.pending,
			blockedReason: null,
			attempts: 0,
			nextRetryAt: at,
			dependsOn: [],
			createdMs: at,
			updatedMs: at,
		};
		assertPersistable(draft, 'draft');
		assertPersistable(operation, 'outbox');
		const transaction = database.transaction([offlineStores.drafts, offlineStores.outbox, offlineStores.scopes], 'readwrite');
		transaction.objectStore(offlineStores.drafts).put(draft);
		transaction.objectStore(offlineStores.outbox).put(operation);
		await transactionDone(transaction);
		await registerScope();
		return { draft, operation };
	}

	async function readDraft(path) {
		const transaction = database.transaction([offlineStores.drafts], 'readonly');
		const record = await requestToPromise(transaction.objectStore(offlineStores.drafts).get(extendKey(scopeKey, path)));
		return record ?? undefined;
	}

	async function readDraftById(draftId) {
		const transaction = database.transaction([offlineStores.drafts], 'readonly');
		const record = await requestToPromise(transaction.objectStore(offlineStores.drafts).get(draftId));
		return record ?? undefined;
	}

	async function listDrafts() {
		const transaction = database.transaction([offlineStores.drafts], 'readonly');
		const index = transaction.objectStore(offlineStores.drafts).index('byScope');
		return await requestToPromise(index.getAll(IDBKeyRangeOnly(scopeKey)));
	}

	async function listOutbox() {
		const transaction = database.transaction([offlineStores.outbox], 'readonly');
		const index = transaction.objectStore(offlineStores.outbox).index('byScope');
		return await requestToPromise(index.getAll(IDBKeyRangeOnly(scopeKey)));
	}

	async function readOperation(opId) {
		const transaction = database.transaction([offlineStores.outbox], 'readonly');
		const record = await requestToPromise(transaction.objectStore(offlineStores.outbox).get(opId));
		return record ?? undefined;
	}

	/**
	 * Applies a confirmed receipt. The receipt, the new base document, the draft state and
	 * the removal of the outbox row all happen in one transaction, because a crash between
	 * "receipt written" and "outbox row removed" would otherwise either replay a committed
	 * operation or lose the confirmation the user needs to see.
	 */
	async function applyReceipt({ opId, result }) {
		const transaction = database.transaction(
			[offlineStores.receipts, offlineStores.baseDocuments, offlineStores.drafts, offlineStores.outbox],
			'readwrite',
		);
		const operations = transaction.objectStore(offlineStores.outbox);
		const operation = await requestToPromise(operations.get(opId));
		if (!operation) {
			throw new OfflineError(offlineErrorCodes.invalidRecord, 'No queued operation with that ID.');
		}
		const at = now();
		const receipt = {
			opId,
			scopeKey,
			path: operation.path,
			seq: result.seq ?? null,
			changeId: result.changeId ?? null,
			revisionId: result.revisionId ?? null,
			fileId: result.fileId ?? null,
			etag: result.etag ?? null,
			sha256: result.sha256 ?? null,
			replayed: result.replayed === true,
			appliedMs: at,
		};
		assertPersistable(receipt, 'receipt');
		transaction.objectStore(offlineStores.receipts).put(receipt);
		const draft = await requestToPromise(transaction.objectStore(offlineStores.drafts).get(operation.draftId));
		if (draft) {
			// One draft per path holds the newest local text, and several queued operations
			// can reference it. Marking it `synced` on the first receipt would tell the user
			// their work landed while a later save of the same file is still pending, so the
			// draft only becomes `synced` when this was the last operation for that path.
			const queued = await requestToPromise(transaction.objectStore(offlineStores.outbox).index('byScope').getAll(IDBKeyRangeOnly(scopeKey)));
			const stillQueued = queued.filter(candidate => candidate.opId !== opId
				&& candidate.draftId === operation.draftId
				&& candidate.state !== opStates.blocked
				&& candidate.state !== opStates.failed);
			transaction.objectStore(offlineStores.drafts).put({
				...draft,
				state: stillQueued.length === 0 ? draftStates.synced : draft.state,
				updatedMs: at,
			});
		}
		if (result.text !== undefined && result.revisionId) {
			transaction.objectStore(offlineStores.baseDocuments).put({
				key: extendKey(scopeKey, operation.path),
				scopeKey,
				path: operation.path,
				revisionId: result.revisionId,
				text: result.text,
				digest: result.sha256 ?? null,
				modifiedMs: at,
				cachedMs: at,
			});
		}
		operations.delete(opId);
		await transactionDone(transaction);
		return receipt;
	}

	async function readReceipt(opId) {
		const transaction = database.transaction([offlineStores.receipts], 'readonly');
		const record = await requestToPromise(transaction.objectStore(offlineStores.receipts).get(opId));
		return record ?? undefined;
	}

	/**
	 * Marks an operation blocked and, in the same transaction, moves its draft to the
	 * matching state. A conflict must leave the draft in `conflict` (so the user can still
	 * export it), while a permission failure locks the scope so nothing else replays.
	 */
	async function blockOperation({ opId, reason, retryAt }) {
		const transaction = database.transaction([offlineStores.outbox, offlineStores.drafts], 'readwrite');
		const operations = transaction.objectStore(offlineStores.outbox);
		const operation = await requestToPromise(operations.get(opId));
		if (!operation) {
			throw new OfflineError(offlineErrorCodes.invalidRecord, 'No queued operation with that ID.');
		}
		const at = now();
		const attempts = operation.attempts + 1;
		const nextRetryAt = retryAt ?? at + retryDelay(attempts);
		operations.put({
			...operation,
			state: opStates.blocked,
			blockedReason: reason,
			attempts,
			nextRetryAt,
			updatedMs: at,
		});
		const draft = await requestToPromise(transaction.objectStore(offlineStores.drafts).get(operation.draftId));
		if (draft) {
			transaction.objectStore(offlineStores.drafts).put({
				...draft,
				state: reason === 'Conflict' ? draftStates.conflict : draft.state,
				updatedMs: at,
			});
		}
		await transactionDone(transaction);
		return { attempts, nextRetryAt };
	}

	/**
	 * Records a transient failure (no server answer at all). The attempt count moves on and
	 * the retry time is pushed out, but the operation stays `pending`: an absent network is
	 * not a reason to stop trying, and after `retryLimits.maxAttempts` the UI says so
	 * instead of the queue spinning forever in silence.
	 */
	async function noteAttempt({ opId, nextRetryAt }) {
		const transaction = database.transaction([offlineStores.outbox], 'readwrite');
		const operations = transaction.objectStore(offlineStores.outbox);
		const operation = await requestToPromise(operations.get(opId));
		if (!operation) {
			throw new OfflineError(offlineErrorCodes.invalidRecord, 'No queued operation with that ID.');
		}
		const at = now();
		const attempts = operation.attempts + 1;
		const giveUp = attempts >= retryLimits.maxAttempts;
		operations.put({
			...operation,
			state: giveUp ? opStates.failed : opStates.pending,
			attempts,
			nextRetryAt: nextRetryAt ?? at + retryDelay(attempts),
			updatedMs: at,
		});
		await transactionDone(transaction);
		return { attempts, giveUp };
	}

	/** Locks the scope after an authorization answer: no further replay until re-auth. */
	async function lockScope(reason) {
		const transaction = database.transaction([offlineStores.scopes], 'readwrite');
		const store = transaction.objectStore(offlineStores.scopes);
		const scopeRecord = await requestToPromise(store.get(scopeKey));
		if (scopeRecord) {
			store.put({ ...scopeRecord, locked: true, lockReason: reason, lockedMs: now() });
		}
		await transactionDone(transaction);
	}

	async function unlockScope() {
		const transaction = database.transaction([offlineStores.scopes], 'readwrite');
		const store = transaction.objectStore(offlineStores.scopes);
		const scopeRecord = await requestToPromise(store.get(scopeKey));
		if (scopeRecord) {
			store.put({ ...scopeRecord, locked: false, lockReason: null, lockedMs: null });
		}
		await transactionDone(transaction);
	}

	/**
	 * Exports a draft as a downloadable text. Export is the guaranteed escape hatch: every
	 * failure mode in the task book ends with "the user can still export the draft", so it
	 * must work even when the scope is locked, the schema is newer, or replay is paused.
	 */
	async function exportDraft(path) {
		const draft = await readDraft(path);
		if (!draft) {
			throw new OfflineError(offlineErrorCodes.unknownDraft, 'No draft for ' + path + '.');
		}
		return {
			fileName: exportFileName(path, draft.updatedMs),
			text: draft.text,
			digest: draft.digest,
			path: draft.path,
			baseRevision: draft.baseRevision,
			updatedMs: draft.updatedMs,
			state: draft.state,
		};
	}

	async function exportAllDrafts() {
		const drafts = await listDrafts();
		return drafts.map(draft => ({
			fileName: exportFileName(draft.path, draft.updatedMs),
			text: draft.text,
			digest: draft.digest,
			path: draft.path,
			baseRevision: draft.baseRevision,
			updatedMs: draft.updatedMs,
			state: draft.state,
		}));
	}

	async function countOutbox() {
		const operations = await listOutbox();
		return {
			total: operations.length,
			pending: operations.filter(operation => operation.state === opStates.pending).length,
			blocked: operations.filter(operation => operation.state === opStates.blocked).length,
			failed: operations.filter(operation => operation.state === opStates.failed).length,
		};
	}

	/**
	 * Removes a draft the user has explicitly discarded. Only the draft record: an outbox
	 * row for the same path is the caller's to resolve first, because deleting an
	 * operation that may already be in flight is how a save is lost after being made.
	 */
	async function deleteDraft(path) {
		const transaction = database.transaction([offlineStores.drafts], 'readwrite');
		const drafts = transaction.objectStore(offlineStores.drafts);
		const draft = await requestToPromise(drafts.get(extendKey(scopeKey, path)));
		if (draft) {
			drafts.delete(draft.draftId);
		}
		await transactionDone(transaction);
		return draft !== undefined;
	}

	async function close() {
		database.close();
	}

	return Object.freeze({
		scope: normalized,
		scopeKey,
		windowMs,
		database,
		registerScope,
		readScopeRecord,
		recordBaseDocument,
		readBaseDocument,
		listBaseDocuments,
		persistDraftAndEnqueue,
		readDraft,
		readDraftById,
		listDrafts,
		listOutbox,
		readOperation,
		applyReceipt,
		readReceipt,
		blockOperation,
		noteAttempt,
		lockScope,
		unlockScope,
		exportDraft,
		exportAllDrafts,
		deleteDraft,
		countOutbox,
		close,
	});
}

/**
 * A file name a user can save and a reviewer can trace: the original name, a marker, and
 * the moment the draft was last touched, in a sortable stamp. The workspace path itself
 * is not part of the name because `/` is not legal in a file name on either desktop OS.
 */
export function exportFileName(path, updatedMs) {
	const slash = path.lastIndexOf('/');
	const base = slash === -1 ? path : path.slice(slash + 1);
	const dot = base.lastIndexOf('.');
	const stem = dot <= 0 ? base : base.slice(0, dot);
	const extension = dot <= 0 ? '' : base.slice(dot);
	const stamp = new Date(updatedMs).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
	return stem + ' (offline ' + stamp + ')' + extension;
}

/**
 * `getAll` on an index needs a key range even when the key is a single value; the
 * workbench has IDBKeyRange but a Node test does not, so this helper degrades to the
 * exact key when the global is missing.
 */
function IDBKeyRangeOnly(key) {
	if (typeof globalThis.IDBKeyRange?.only === 'function') {
		return globalThis.IDBKeyRange.only(key);
	}
	return key;
}

export { offlineWindowLimits };
