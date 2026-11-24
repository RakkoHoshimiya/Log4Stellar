/**
 * The workbench file-system provider adapter for offline editing
 * (docs/web-offline.md §5).
 *
 * The editor already knows how to talk to a provider; this file is the seam between that
 * provider API and the IndexedDB store. It is deliberately the thinnest layer in the
 * feature: every rule about what may be persisted, who may replay, and when a draft is
 * gone lives in `offline-contract.js`, `offline-store.js` and `offline-coordinator.js`.
 *
 * The provider API is asynchronous and byte-oriented (`Uint8Array`), the store is
 * text-oriented, so the conversion happens here and only here.
 */

import {
	OfflineError,
	offlineErrorCodes,
	opStates,
	assertPersistable,
} from './offline-contract.js';

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function requirePath(path) {
	if (typeof path !== 'string' || !path.startsWith('/')) {
		throw new OfflineError(offlineErrorCodes.invalidRecord, 'Offline editing needs an absolute workspace path.');
	}
	return path;
}

function toBytes(value) {
	if (value instanceof Uint8Array) {
		return value;
	}
	if (typeof value === 'string') {
		return encoder.encode(value);
	}
	if (value && typeof value.byteLength === 'number' && typeof Uint8Array.from === 'function') {
		return new Uint8Array(value);
	}
	throw new OfflineError(offlineErrorCodes.invalidRecord, 'Offline writing needs bytes or text.');
}

/**
 * Reads the document the editor may open while offline.
 *
 * The order matters and is the whole design: a draft wins over the cached base document,
 * because the draft is the user's newer work and showing them the server's older copy
 * would look like the edit was thrown away. The base document wins over nothing at all,
 * because an empty buffer in an editor is indistinguishable from "the file is empty" and
 * the next keystroke would save an empty file.
 */
export async function readCachedDocument({ store, path }) {
	requirePath(path);
	const draft = await store.readDraft(path);
	if (draft) {
		return Object.freeze({
			path,
			bytes: toBytes(draft.text),
			source: 'draft',
			state: draft.state,
			baseRevision: draft.baseRevision,
			digest: draft.digest,
			updatedMs: draft.updatedMs,
		});
	}
	const base = await store.readBaseDocument(path);
	if (base) {
		return Object.freeze({
			path,
			bytes: toBytes(base.text),
			source: 'cache',
			state: 'cached',
			baseRevision: base.revisionId,
			digest: base.digest,
			updatedMs: base.modifiedMs,
		});
	}
	return undefined;
}

/**
 * Writes an edit to the local store. It never touches the network: the upload is the
 * coordinator's job, and keeping the two apart is what lets a save succeed in a tunnel.
 *
 * `opId` and `idempotencyKey` are supplied by the caller when it has them (a retried
 * save must not mint new ones) and derived only when it does not.
 */
export async function writeOfflineDraft({ store, path, bytes, baseRevision, opId, idempotencyKey, mode = 'save', deviceId }) {
	requirePath(path);
	const text = typeof bytes === 'string' ? bytes : decoder.decode(toBytes(bytes));
	const saved = await store.persistDraftAndEnqueue({
		path,
		text,
		baseRevision: baseRevision ?? null,
		opId: opId ?? newOperationId(),
		idempotencyKey: idempotencyKey ?? newIdempotencyKey(),
		mode,
		deviceId,
	});
	return Object.freeze({ path, state: saved.draft.state, opId: saved.operation.opId, digest: saved.draft.digest });
}

/**
 * Caches a server document as the base an offline edit will be built on. It is called
 * when a document is opened online, not when it is saved: the base revision must be the
 * one the user actually saw.
 */
export async function cacheServerDocument({ store, path, bytes, revisionId, digest, modifiedMs }) {
	requirePath(path);
	const text = typeof bytes === 'string' ? bytes : decoder.decode(toBytes(bytes));
	return await store.recordBaseDocument({ path, revisionId, text, digest, modifiedMs });
}

/**
 * Describes what the workbench should draw for one path, without rendering it. The
 * banner view model is built from a whole scope (see `offline-ui.js`); this answers the
 * narrower question a single open document asks.
 */
export async function documentStatus({ store, path }) {
	requirePath(path);
	const draft = await store.readDraft(path);
	const operation = draft?.opId ? await store.readOperation(draft.opId) : undefined;
	if (!draft) {
		const base = await store.readBaseDocument(path);
		return Object.freeze({ path, status: base ? 'cached' : 'absent', operation: null });
	}
	return Object.freeze({
		path,
		status: draft.state,
		operation: operation
			? Object.freeze({ opId: operation.opId, state: operation.state, blockedReason: operation.blockedReason ?? null, attempts: operation.attempts })
			: null,
	});
}

/**
 * Drops a draft once the user has resolved it. Export is checked by the caller (the UI
 * refuses "keep theirs" without one); this only refuses to delete work that is still
 * queued, because that would be the one irreversible loss in the feature.
 */
export async function discardDraft({ store, path }) {
	requirePath(path);
	const draft = await store.readDraft(path);
	if (!draft) {
		return Object.freeze({ path, discarded: false, reason: 'absent' });
	}
	const operation = draft.opId ? await store.readOperation(draft.opId) : undefined;
	if (operation && (operation.state === opStates.pending || operation.state === opStates.inflight)) {
		throw new OfflineError(offlineErrorCodes.unknownDraft, 'The draft is still queued; resolve or export it first.');
	}
	await store.deleteDraft(path);
	return Object.freeze({ path, discarded: true, exportedText: draft.text });
}

/**
 * A scope is only persisted when the browser is not shared. The provider asks this
 * before it writes anything, so the answer reaches the user as a banner instead of a
 * failed keystroke.
 */
export function canUseOffline({ scope }) {
	try {
		const record = { sharedDevice: scope?.sharedDevice === true };
		assertPersistable(record, 'scope');
		return record.sharedDevice === false && typeof scope?.accountId === 'string' && scope.accountId !== '';
	} catch {
		return false;
	}
}

function randomToken() {
	// `crypto.randomUUID` exists in every browser this feature targets; the fallback keeps
	// a test or an old WebView working rather than throwing on the first keystroke.
	if (typeof globalThis.crypto?.randomUUID === 'function') {
		return globalThis.crypto.randomUUID();
	}
	return String(Date.now()) + '-' + String(Math.random()).slice(2, 12);
}

export function newOperationId() {
	return 'op-' + randomToken();
}

export function newIdempotencyKey() {
	return 'key-' + randomToken();
}
