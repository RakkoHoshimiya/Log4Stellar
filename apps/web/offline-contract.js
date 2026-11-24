/**
 * The offline editing contract (docs/web-offline.md).
 *
 * This module is loaded verbatim by the browser and imported by the Node tests, so it
 * may not import anything from `node:` and may not touch `document` at module scope.
 * It holds only constants, scope arithmetic and pure validation: everything that has
 * to agree between the store, the coordinator, the UI and the tests lives here once.
 */

/** Bumped whenever a stored record changes shape; the store migrates or refuses. */
export const offlineSchemaVersion = 1;

export const offlineDatabaseName = 'log4stellar-offline';

/**
 * One object store per kind of record. `drafts` and `outbox` are separate stores but
 * are ALWAYS written in the same transaction: a draft that nobody will ever upload is
 * silently lost, and an outbox row whose draft is missing cannot be replayed or
 * exported, so a split write is a data-loss bug either way.
 */
export const offlineStores = Object.freeze({
	scopes: 'scopes',
	baseDocuments: 'baseDocuments',
	drafts: 'drafts',
	outbox: 'outbox',
	receipts: 'receipts',
	leases: 'leases',
});

/**
 * Key paths and indexes. `baseDocuments` and `drafts` are keyed by a compound string
 * built with `compoundKey`, because IndexedDB keys must be scalars.
 */
export const offlineSchema = Object.freeze([
	Object.freeze({ name: offlineStores.scopes, keyPath: 'key' }),
	Object.freeze({
		name: offlineStores.baseDocuments,
		keyPath: 'key',
		indexes: Object.freeze([{ name: 'byScope', keyPath: 'scopeKey' }]),
	}),
	Object.freeze({
		name: offlineStores.drafts,
		keyPath: 'draftId',
		indexes: Object.freeze([
			{ name: 'byScope', keyPath: 'scopeKey' },
			{ name: 'byScopePath', keyPath: 'scopePath' },
		]),
	}),
	Object.freeze({
		name: offlineStores.outbox,
		keyPath: 'opId',
		indexes: Object.freeze([{ name: 'byScope', keyPath: 'scopeKey' }]),
	}),
	Object.freeze({
		name: offlineStores.receipts,
		keyPath: 'opId',
		indexes: Object.freeze([{ name: 'byScope', keyPath: 'scopeKey' }]),
	}),
	Object.freeze({ name: offlineStores.leases, keyPath: 'key' }),
]);

/**
 * The separator inside a compound key. It is a control character that no workspace
 * path, account id or scope component can contain, so `a + sep + b` never collides
 * with a different `(a, b)` pair.
 */
export const keySeparator = '\u0000';

export function compoundKey(...parts) {
	for (const part of parts) {
		if (typeof part !== 'string') {
			throw new OfflineError(offlineErrorCodes.invalidRecord, 'A compound key part must be a string.');
		}
		if (part.includes(keySeparator)) {
			throw new OfflineError(offlineErrorCodes.invalidRecord, 'A compound key part may not contain the separator.');
		}
	}
	return parts.join(keySeparator);
}

/**
 * Append raw parts to a key that is already composed (a scope key, say) to form a
 * per-scope record key. `compoundKey` deliberately refuses a part containing the
 * separator, which is exactly what a composed key does contain — so a record key cannot
 * be built by calling `compoundKey(scopeKey, path)`, and `extendKey` is the one place
 * that is allowed to add to an existing key.
 */
export function extendKey(base, ...parts) {
	if (typeof base !== 'string' || base === '') {
		throw new OfflineError(offlineErrorCodes.invalidRecord, 'A record key needs a base key.');
	}
	for (const part of parts) {
		if (typeof part !== 'string') {
			throw new OfflineError(offlineErrorCodes.invalidRecord, 'A compound key part must be a string.');
		}
		if (part === '' || part.includes(keySeparator)) {
			throw new OfflineError(offlineErrorCodes.invalidRecord, 'A compound key part may not be empty or contain the separator.');
		}
	}
	return [base, ...parts].join(keySeparator);
}

/**
 * Machine-readable offline error codes. These are client-local: they never travel to
 * the server, and they are never rendered raw — the UI maps them to a sentence.
 */
export const offlineErrorCodes = Object.freeze({
	invalidScope: 'InvalidOfflineScope',
	invalidRecord: 'InvalidOfflineRecord',
	forbiddenPersistence: 'ForbiddenPersistence',
	offlineDisabled: 'OfflineDisabled',
	quotaExceeded: 'QuotaExceeded',
	leaseHeld: 'LeaseHeld',
	scopeLocked: 'ScopeLocked',
	accountChanged: 'AccountChanged',
	offlineExpired: 'OfflineExpired',
	noPermission: 'NoPermissions',
	unknownDraft: 'UnknownDraft',
	schemaTooNew: 'SchemaTooNew',
});

export class OfflineError extends Error {
	constructor(code, detail) {
		super(detail || code);
		this.name = 'OfflineError';
		this.code = code;
	}
}

/**
 * The offline window. A browser that has been offline for longer than this must
 * re-authenticate before replaying, because the server cannot have told us about a
 * revocation in the meantime and the account may no longer exist.
 *
 * 7 days is the default and 30 days is the hard cap: past a month an offline queue is
 * more likely to be stale data than unfinished work, and the task book requires the
 * product decision to be written down rather than implied.
 */
export const offlineWindowLimits = Object.freeze({
	defaultMs: 7 * 24 * 60 * 60 * 1000,
	maxMs: 30 * 24 * 60 * 60 * 1000,
});

/**
 * A shared browser (a lab machine, a kiosk) must not keep workspace bytes on disk by
 * default: the next person at the keyboard would see the previous account's drafts.
 */
export const offlinePolicyDefaults = Object.freeze({
	sharedDevice: false,
	windowMs: offlineWindowLimits.defaultMs,
});

const idPattern = /^[a-z0-9][a-z0-9-]{0,62}$/i;

/**
 * A scope is the tuple that an IndexedDB record belongs to. Two records with the same
 * draft id but a different scope are different records: this is what makes O04 (switch
 * from account A to account B and B must not see A's data) true by construction rather
 * than by remembering to filter.
 */
export function normalizeOfflineScope(scope) {
	if (!scope || typeof scope !== 'object') {
		throw new OfflineError(offlineErrorCodes.invalidScope, 'An offline scope needs an origin and an account.');
	}
	const origin = requireString(scope.origin, 'origin').replace(/\/+$/, '').toLowerCase();
	if (!/^https?:\/\/[^/]+$/.test(origin)) {
		throw new OfflineError(offlineErrorCodes.invalidScope, 'An offline scope origin must be a canonical URL origin.');
	}
	const accountId = requireString(scope.accountId, 'accountId');
	const workspaceId = requireString(scope.workspaceId, 'workspaceId');
	if (!idPattern.test(workspaceId)) {
		throw new OfflineError(offlineErrorCodes.invalidScope, 'An offline scope needs a workspace ID.');
	}
	// The tenant is part of the scope even though today's code always says 'default':
	// a record written before tenants existed must not reappear under a different one.
	const tenantId = requireString(scope.tenantId ?? 'default', 'tenantId');
	const sharedDevice = scope.sharedDevice === true;
	return Object.freeze({ origin, accountId, tenantId, workspaceId, sharedDevice });
}

function requireString(value, name) {
	if (typeof value !== 'string' || value.trim() === '') {
		throw new OfflineError(offlineErrorCodes.invalidScope, 'An offline scope needs a ' + name + '.');
	}
	return value.trim();
}

/** The single string an IndexedDB record is partitioned by. */
export function scopeKeyOf(scope) {
	const normalized = normalizeOfflineScope(scope);
	return compoundKey(normalized.origin, normalized.accountId, normalized.tenantId, normalized.workspaceId);
}

export function sameScope(left, right) {
	if (!left || !right) {
		return false;
	}
	return left.origin === right.origin
		&& left.accountId === right.accountId
		&& left.tenantId === right.tenantId
		&& left.workspaceId === right.workspaceId;
}

/**
 * Offline editing is opt-in per scope, and a scope is enabled only when the caller has
 * explicitly decided so. `sharedDevice` wins over any other setting: the default is
 * "off" and there is no silent upgrade path.
 */
export function offlineEnabled(scope) {
	const normalized = normalizeOfflineScope(scope);
	if (normalized.sharedDevice) {
		return false;
	}
	return true;
}

export function requireOfflineEnabled(scope) {
	if (!offlineEnabled(scope)) {
		throw new OfflineError(offlineErrorCodes.offlineDisabled, 'Offline editing is disabled on a shared browser.');
	}
	return normalizeOfflineScope(scope);
}

/** Clamps a requested window into the supported range, rejecting a non-number. */
export function normalizeOfflineWindow(value) {
	if (value === undefined || value === null) {
		return offlineWindowLimits.defaultMs;
	}
	if (!Number.isSafeInteger(value) || value < 1) {
		throw new OfflineError(offlineErrorCodes.invalidRecord, 'An offline window must be a positive integer of milliseconds.');
	}
	return Math.min(value, offlineWindowLimits.maxMs);
}

/** Draft and operation states. A draft and its operation always move together. */
export const draftStates = Object.freeze({
	saved: 'saved',
	queued: 'queued',
	conflict: 'conflict',
	synced: 'synced',
});
export const opStates = Object.freeze({
	pending: 'pending',
	inflight: 'inflight',
	blocked: 'blocked',
	failed: 'failed',
});
export const opBlockReasons = Object.freeze({
	conflict: 'Conflict',
	noPermission: 'NoPermissions',
	resyncRequired: 'ResyncRequired',
	accountChanged: 'AccountChanged',
	offlineExpired: 'OfflineExpired',
	dependency: 'Dependency',
});

/**
 * Content that may never reach IndexedDB. The list exists because the easiest way to
 * turn a draft cache into a credential leak is to persist the request that produced it:
 * a `fetch` init with its headers, or a presigned object URL, both look like harmless
 * strings until a backup copies them.
 */
export const forbiddenPersistenceKeys = Object.freeze([
	'cookie',
	'set-cookie',
	'authorization',
	'password',
	'token',
	'accesstoken',
	'refreshtoken',
	'sessiontoken',
	'secret',
	'apikey',
	'signedurl',
]);

export const forbiddenPersistencePatterns = Object.freeze([
	/\bBearer\s+[A-Za-z0-9._~+/-]{8,}/,
	/\bX-Amz-(?:Signature|Credential|Security-Token)=/i,
	/\b[A-Za-z0-9_-]{20,}\.(?:eyJ[A-Za-z0-9_-]{8,})\.[A-Za-z0-9_-]{8,}/,
]);

/**
 * Rejects a record that would persist a credential or a capability URL. It walks the
 * record shallowly and checks keys case-insensitively: a nested object is checked by
 * `assertPersistable` too, so the caller cannot launder a token by wrapping it.
 */
export function assertPersistable(record, path = 'record') {
	if (record === null || record === undefined) {
		return record;
	}
	if (typeof record === 'string') {
		for (const pattern of forbiddenPersistencePatterns) {
			if (pattern.test(record)) {
				throw new OfflineError(offlineErrorCodes.forbiddenPersistence, path + ' would persist a credential.');
			}
		}
		return record;
	}
	if (typeof record !== 'object') {
		return record;
	}
	if (Array.isArray(record)) {
		for (const [index, value] of record.entries()) {
			assertPersistable(value, path + '[' + String(index) + ']');
		}
		return record;
	}
	for (const [key, value] of Object.entries(record)) {
		const normalized = key.toLowerCase().replace(/[^a-z]/g, '');
		if (forbiddenPersistenceKeys.includes(normalized)) {
			throw new OfflineError(offlineErrorCodes.forbiddenPersistence, path + '.' + key + ' is a credential field.');
		}
		assertPersistable(value, path + '.' + key);
	}
	return record;
}

/**
 * SHA-256 of the exact bytes that will be uploaded, as lowercase hex. It runs before
 * any transaction is opened: awaiting `crypto.subtle` inside a transaction would let
 * IndexedDB auto-commit an empty one.
 */
export async function digestText(text) {
	if (typeof text !== 'string') {
		throw new OfflineError(offlineErrorCodes.invalidRecord, 'A draft body must be a string.');
	}
	const bytes = new TextEncoder().encode(text);
	const subtle = globalThis.crypto?.subtle;
	if (!subtle) {
		throw new OfflineError(offlineErrorCodes.invalidRecord, 'This browser cannot compute a draft digest.');
	}
	const hash = await subtle.digest('SHA-256', bytes);
	return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Retry backoff. Capped at 15 minutes so a queue that has been blocked overnight still
 * retries promptly once the browser is online again instead of waiting for a day-old
 * exponential term.
 */
export const retryLimits = Object.freeze({ baseMs: 2_000, maxMs: 15 * 60 * 1000, maxAttempts: 20 });

export function retryDelay(attempts) {
	if (!Number.isSafeInteger(attempts) || attempts < 0) {
		throw new OfflineError(offlineErrorCodes.invalidRecord, 'An attempt count must be a non-negative integer.');
	}
	return Math.min(retryLimits.baseMs * 2 ** attempts, retryLimits.maxMs);
}

export function isOfflineError(error) {
	return error instanceof OfflineError || error?.name === 'OfflineError';
}
