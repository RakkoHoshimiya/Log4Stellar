import { createHash } from 'node:crypto';
import { extname } from 'node:path';

import { WorkspaceError } from './workspace-contract.mjs';

/**
 * The incremental sync contract (docs/incremental-sync.md). This module only holds
 * constants and pure validation helpers: it never touches PostgreSQL, RustFS or the
 * workspace backend, so both the server implementation and the two clients can
 * import the exact same rules.
 */

/** Every sync route lives under this prefix, next to (not inside) /static/mount. */
export const syncMountPath = '/sync/v1';

export const syncRoutes = Object.freeze({
	snapshot: '/sync/v1/snapshot',
	snapshotPage: '/sync/v1/snapshot/:snapshotId',
	changes: '/sync/v1/changes',
	file: '/sync/v1/file',
	rename: '/sync/v1/rename',
	mkdir: '/sync/v1/mkdir',
	restore: '/sync/v1/restore',
	rollback: '/sync/v1/rollback',
	conflicts: '/sync/v1/conflicts',
	conflict: '/sync/v1/conflict',
});

/** Request headers the sync API understands, in addition to the workspace header. */
export const syncHeaders = Object.freeze({
	device: 'X-Log4Stellar-Device',
	baseRevision: 'X-Log4Stellar-Base-Revision',
	idempotencyKey: 'Idempotency-Key',
	cursor: 'X-Log4Stellar-Cursor',
});

/** The capability each sync endpoint needs (docs/workspace-access.md §3). */
export const syncCapabilities = Object.freeze({
	snapshot: 'workspace.read',
	snapshotPage: 'workspace.read',
	changes: 'workspace.read',
	file: 'workspace.write',
	delete: 'workspace.delete',
	restore: 'workspace.restore',
	conflict: 'workspace.history',
});

/**
 * method + pathname → capability. Like `capabilityForRequest` in workspace-access.mjs
 * this only looks at the method and the route, so the gateway can authorize before
 * any parameter validation, and it returns undefined for a route we do not serve.
 */
const syncRouteTable = Object.freeze([
	{ method: 'POST', pattern: /^\/sync\/v1\/snapshot$/, capability: syncCapabilities.snapshot },
	{ method: 'GET', pattern: /^\/sync\/v1\/snapshot\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i, capability: syncCapabilities.snapshotPage },
	{ method: 'GET', pattern: /^\/sync\/v1\/changes$/, capability: syncCapabilities.changes },
	{ method: 'GET', pattern: /^\/sync\/v1\/conflicts$/, capability: syncCapabilities.conflict },
	{ method: 'GET', pattern: /^\/sync\/v1\/conflict$/, capability: syncCapabilities.conflict },
	{ method: 'PUT', pattern: /^\/sync\/v1\/file$/, capability: syncCapabilities.file },
	{ method: 'DELETE', pattern: /^\/sync\/v1\/file$/, capability: syncCapabilities.delete },
	{ method: 'POST', pattern: /^\/sync\/v1\/rename$/, capability: syncCapabilities.file },
	{ method: 'POST', pattern: /^\/sync\/v1\/mkdir$/, capability: syncCapabilities.file },
	{ method: 'POST', pattern: /^\/sync\/v1\/restore$/, capability: 'workspace.restore' },
	{ method: 'POST', pattern: /^\/sync\/v1\/rollback$/, capability: 'workspace.restore' },
]);

export function capabilityForSyncRequest(method, pathname) {
	if (typeof method !== 'string' || typeof pathname !== 'string') {
		return undefined;
	}
	for (const route of syncRouteTable) {
		if (route.method === method && route.pattern.test(pathname)) {
			return route.capability;
		}
	}
	return undefined;
}

/**
 * Machine-readable sync error codes. `syncErrorStatus` is the status code each one
 * is answered with; adding a code means adding a row in both objects.
 */
export const syncErrorCodes = Object.freeze({
	resyncRequired: 'ResyncRequired',
	invalidCursor: 'InvalidCursor',
	invalidPageToken: 'InvalidPageToken',
	invalidSnapshot: 'InvalidSnapshot',
	invalidPageSize: 'InvalidPageSize',
	invalidIdempotencyKey: 'InvalidIdempotencyKey',
	idempotencyKeyReused: 'IdempotencyKeyReused',
	baseRevisionRequired: 'BaseRevisionRequired',
	baseRevisionInvalid: 'BaseRevisionInvalid',
	conflict: 'SyncConflict',
	conflictNameExhausted: 'ConflictNameExhausted',
	invalidDevice: 'InvalidDevice',
	invalidChangeKind: 'InvalidChangeKind',
	invalidUploadMode: 'InvalidUploadMode',
	snapshotTooLarge: 'SnapshotTooLarge',
});

export const syncErrorStatus = Object.freeze({
	ResyncRequired: 410,
	InvalidCursor: 400,
	InvalidPageToken: 400,
	InvalidSnapshot: 410,
	InvalidPageSize: 400,
	InvalidIdempotencyKey: 400,
	IdempotencyKeyReused: 409,
	BaseRevisionRequired: 428,
	BaseRevisionInvalid: 400,
	SyncConflict: 409,
	ConflictNameExhausted: 409,
	InvalidDevice: 400,
	InvalidChangeKind: 400,
	InvalidUploadMode: 400,
	SnapshotTooLarge: 413,
});

/**
 * Every kind of logical change recorded in storage_changes. Save, rename, delete,
 * restore and rollback are all separate kinds so a client can apply them without
 * guessing: a rename keeps file_id and only moves the path.
 */
export const changeKinds = Object.freeze([
	'file.created',
	'file.saved',
	'file.renamed',
	'file.deleted',
	'file.restored',
	'file.rolledback',
	'file.conflicted',
	'directory.created',
	'directory.renamed',
	'directory.deleted',
]);

const kindSet = new Set(changeKinds);

export function isChangeKind(value) {
	return kindSet.has(value);
}

export function requireChangeKind(value) {
	if (!isChangeKind(value)) {
		throw new WorkspaceError(400, syncErrorCodes.invalidChangeKind);
	}
	return value;
}

/** Page size bounds: the change stream is small rows, a snapshot page is not. */
export const syncPageLimits = Object.freeze({
	defaultSize: 200,
	maxSize: 500,
	maxSnapshotSize: 1000,
});

/**
 * Clamps a requested page size into the supported range. A missing value uses the
 * default; a value that is not a positive integer is rejected instead of silently
 * replaced, because a client that asks for `limit=0` has a bug.
 */
export function normalizePageSize(value, { maximum = syncPageLimits.maxSize } = {}) {
	if (value === undefined || value === null || value === '') {
		return syncPageLimits.defaultSize;
	}
	const size = typeof value === 'number' ? value : Number(value);
	if (!Number.isSafeInteger(size) || size < 1) {
		throw new WorkspaceError(400, syncErrorCodes.invalidPageSize);
	}
	return Math.min(size, maximum);
}

/**
 * Idempotency keys are client-generated and must survive a retry byte for byte, so
 * they are restricted to an unambiguous, copy-paste-safe alphabet.
 */
export const idempotencyKeyLimits = Object.freeze({ minLength: 8, maxLength: 200 });

const idempotencyKeyPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export function isValidIdempotencyKey(value) {
	if (typeof value !== 'string') {
		return false;
	}
	if (value.length < idempotencyKeyLimits.minLength || value.length > idempotencyKeyLimits.maxLength) {
		return false;
	}
	return idempotencyKeyPattern.test(value);
}

export function requireIdempotencyKey(value) {
	if (!isValidIdempotencyKey(value)) {
		throw new WorkspaceError(400, syncErrorCodes.invalidIdempotencyKey);
	}
	return value;
}

/**
 * The device ID ends up inside a file name when a conflict copy is created, so it
 * is restricted to the same alphabet a workspace ID uses.
 */
export const maxDeviceIdLength = 32;

const deviceIdPattern = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/** Used when a client omits the device header: the name stays deterministic. */
export const fallbackDeviceId = 'device';

export function isValidDeviceId(value) {
	if (typeof value !== 'string' || value.length < 1 || value.length > maxDeviceIdLength) {
		return false;
	}
	return deviceIdPattern.test(value);
}

export function normalizeDeviceId(value) {
	if (value === undefined || value === null || value === '') {
		return fallbackDeviceId;
	}
	if (!isValidDeviceId(value)) {
		throw new WorkspaceError(400, syncErrorCodes.invalidDevice);
	}
	return value;
}

const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export function isUuid(value) {
	return typeof value === 'string' && uuidPattern.test(value);
}

/**
 * A save must name the revision it was based on. A missing value is a protocol
 * error (428, the client forgot), while a malformed value is a plain 400.
 */
export function requireBaseRevision(value) {
	if (value === undefined || value === null || value === '') {
		throw new WorkspaceError(syncErrorStatus.BaseRevisionRequired, syncErrorCodes.baseRevisionRequired);
	}
	if (!isUuid(value)) {
		throw new WorkspaceError(syncErrorStatus.BaseRevisionInvalid, syncErrorCodes.baseRevisionInvalid);
	}
	return value.toLowerCase();
}

/**
 * Fingerprint of everything that changes the logical result of an idempotent
 * request. A retry with the same key but a different fingerprint is rejected with
 * 409 instead of silently overwriting the first result.
 *
 * Every field below is here because two requests that differ ONLY in it produce a
 * different outcome. `mode` decides whether a PUT may create a path or must move an
 * existing revision forward; `overwrite` decides whether a rename replaces the target
 * or conflicts; `keepBoth` decides whether a restore keeps the incumbent bytes as a
 * conflict copy or replaces them. Leaving any of the three out of the fingerprint made
 * the second request look like a retry of the first: it was answered 200 + replayed
 * with the FIRST result, while the flag the client sent was never honoured.
 */
export function idempotencyFingerprint(fields) {
	if (!fields || typeof fields !== 'object') {
		throw new Error('An idempotency fingerprint needs the request fields.');
	}
	const canonical = JSON.stringify([
		String(fields.method ?? ''),
		String(fields.path ?? ''),
		fields.baseRevision ?? null,
		fields.digest ?? null,
		fields.size ?? null,
		fields.targetPath ?? null,
		fields.device ?? null,
		fields.mode ?? null,
		fields.overwrite ?? null,
		fields.keepBoth ?? null,
	]);
	return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * A save names the revision it was based on; a create must not name one, because
 * the file has no revision yet. Keeping them as two explicit modes is what lets the
 * server tell "someone else already created this path" from "someone else moved it
 * forward", and both answers are a conflict copy, not an overwrite.
 */
export const syncUploadModes = Object.freeze(['create', 'save']);

export function requireUploadMode(value) {
	const mode = value === undefined || value === null || value === '' ? 'save' : value;
	if (!syncUploadModes.includes(mode)) {
		throw new WorkspaceError(400, 'InvalidUploadMode');
	}
	return mode;
}

/**
 * Retention bounds. They are part of the contract because a client has to know how
 * long a cursor stays usable: past these limits the server answers ResyncRequired
 * and the client must take a fresh snapshot instead of resuming.
 */
export const syncRetention = Object.freeze({
	snapshotTtlMs: 6 * 60 * 60 * 1000,
	changesTtlMs: 30 * 24 * 60 * 60 * 1000,
	idempotencyTtlMs: 30 * 24 * 60 * 60 * 1000,
	maxChangesPerWorkspace: 200000,
	maxSnapshotEntries: 100000,
});

const cursorPrefix = 'l4s';
const cursorVersion = 1;
const cursorKinds = Object.freeze(['changes', 'snapshot']);
const maxCursorLength = 512;

function toBase64Url(value) {
	return Buffer.from(value, 'utf8').toString('base64url');
}

function fromBase64Url(value) {
	return Buffer.from(value, 'base64url').toString('utf8');
}

function tokenChecksum(body) {
	return createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 16);
}

function joinToken(body) {
	return cursorPrefix + '.' + body + '.' + tokenChecksum(body);
}

function splitToken(value, code) {
	if (typeof value !== 'string' || value === '' || value.length > maxCursorLength) {
		throw new WorkspaceError(syncErrorStatus[code], code);
	}
	const parts = value.split('.');
	if (parts.length !== 3 || parts[0] !== cursorPrefix) {
		throw new WorkspaceError(syncErrorStatus[code], code);
	}
	if (tokenChecksum(parts[1]) !== parts[2]) {
		throw new WorkspaceError(syncErrorStatus[code], code);
	}
	return parts[1];
}

function parseToken(body, code) {
	let payload;
	try {
		payload = JSON.parse(fromBase64Url(body));
	} catch {
		throw new WorkspaceError(syncErrorStatus[code], code);
	}
	if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
		throw new WorkspaceError(syncErrorStatus[code], code);
	}
	if (payload.v !== cursorVersion) {
		throw new WorkspaceError(syncErrorStatus[code], code);
	}
	return payload;
}

/**
 * A cursor is an opaque, versioned token that names the last sequence a client has
 * applied plus the workspace it belongs to. The checksum makes a truncated or
 * hand-edited cursor fail here instead of being interpreted as "start from 0".
 */
export function encodeCursor({ workspaceId, kind = 'changes', seq, expiresMs }) {
	if (typeof workspaceId !== 'string' || workspaceId === '') {
		throw new Error('A cursor needs a workspace ID.');
	}
	if (!cursorKinds.includes(kind)) {
		throw new Error('Unknown cursor kind: ' + String(kind) + '.');
	}
	if (!Number.isSafeInteger(seq) || seq < 0) {
		throw new Error('A cursor sequence must be a non-negative integer.');
	}
	const payload = kind === 'snapshot'
		? { v: cursorVersion, k: kind, w: workspaceId, s: seq, e: requireExpiry(expiresMs) }
		: { v: cursorVersion, k: kind, w: workspaceId, s: seq };
	const token = joinToken(toBase64Url(JSON.stringify(payload)));
	if (token.length > maxCursorLength) {
		throw new Error('A cursor may not exceed ' + String(maxCursorLength) + ' characters.');
	}
	return token;
}

function requireExpiry(expiresMs) {
	if (!Number.isSafeInteger(expiresMs) || expiresMs < 0) {
		throw new Error('A snapshot cursor needs an absolute expiry in milliseconds.');
	}
	return expiresMs;
}

export function decodeCursor(value, { workspaceId } = {}) {
	const payload = parseToken(splitToken(value, syncErrorCodes.invalidCursor), syncErrorCodes.invalidCursor);
	if (!cursorKinds.includes(payload.k)) {
		throw new WorkspaceError(syncErrorStatus.InvalidCursor, syncErrorCodes.invalidCursor);
	}
	if (typeof payload.w !== 'string' || payload.w === '') {
		throw new WorkspaceError(syncErrorStatus.InvalidCursor, syncErrorCodes.invalidCursor);
	}
	if (workspaceId !== undefined && payload.w !== workspaceId) {
		throw new WorkspaceError(syncErrorStatus.InvalidCursor, syncErrorCodes.invalidCursor);
	}
	if (!Number.isSafeInteger(payload.s) || payload.s < 0) {
		throw new WorkspaceError(syncErrorStatus.InvalidCursor, syncErrorCodes.invalidCursor);
	}
	if (payload.k === 'snapshot') {
		if (!Number.isSafeInteger(payload.e) || payload.e < 0) {
			throw new WorkspaceError(syncErrorStatus.InvalidCursor, syncErrorCodes.invalidCursor);
		}
	} else if (payload.e !== undefined) {
		throw new WorkspaceError(syncErrorStatus.InvalidCursor, syncErrorCodes.invalidCursor);
	}
	return Object.freeze({ kind: payload.k, workspaceId: payload.w, seq: payload.s, expiresMs: payload.e });
}

/**
 * A well-formed cursor may still be useless: if the change rows at or below it have
 * been pruned, the client cannot resume from it and must be told to resync instead
 * of receiving a gap.
 */
export function requireRetainedCursor(cursor, firstRetainedSeq) {
	if (!Number.isSafeInteger(firstRetainedSeq) || firstRetainedSeq < 1) {
		throw new Error('The first retained sequence must be a positive integer.');
	}
	if (cursor.seq < firstRetainedSeq - 1) {
		throw new WorkspaceError(syncErrorStatus.ResyncRequired, syncErrorCodes.resyncRequired);
	}
	return cursor;
}

/**
 * A cursor may not name a sequence the workspace has not reached. Without this guard
 * a client that sends a huge sequence would silently skip every future change,
 * because "everything after 10^12" is always empty. A well-formed cursor can only be
 * ahead of the head if the server lost history, so the answer is a resync, not a 400:
 * the client did nothing wrong and can still fully recover.
 */
export function requireHeadCursor(cursor, headSeq) {
	if (!Number.isSafeInteger(headSeq) || headSeq < 0) {
		throw new Error('The workspace head sequence must be a non-negative integer.');
	}
	if (cursor.seq > headSeq) {
		throw new WorkspaceError(syncErrorStatus.ResyncRequired, syncErrorCodes.resyncRequired);
	}
	return cursor;
}

/**
 * A snapshot cursor pins a client to the sequence the snapshot was taken at, but only
 * until the snapshot's window closes: past that point the change rows the client never
 * replayed may already be pruned, so resuming would silently drop them.
 */
export function requireLiveCursor(cursor, nowMs) {
	if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
		throw new Error('The current time must be a non-negative integer in milliseconds.');
	}
	if (cursor.kind === 'snapshot' && nowMs > cursor.expiresMs) {
		throw new WorkspaceError(syncErrorStatus.ResyncRequired, syncErrorCodes.resyncRequired);
	}
	return cursor;
}

/** The snapshot page token is a separate kind so the two can never be confused. */
export function encodePageToken({ snapshotId, lastPath = '' }) {
	if (!isUuid(snapshotId)) {
		throw new Error('A page token needs a snapshot UUID.');
	}
	if (typeof lastPath !== 'string') {
		throw new Error('A page token needs the last path of the page.');
	}
	const payload = { v: cursorVersion, k: 'page', i: snapshotId.toLowerCase(), p: lastPath };
	return joinToken(toBase64Url(JSON.stringify(payload)));
}

export function decodePageToken(value, { snapshotId } = {}) {
	const payload = parseToken(splitToken(value, syncErrorCodes.invalidPageToken), syncErrorCodes.invalidPageToken);
	if (payload.k !== 'page' || !isUuid(payload.i) || typeof payload.p !== 'string') {
		throw new WorkspaceError(syncErrorStatus.InvalidPageToken, syncErrorCodes.invalidPageToken);
	}
	if (snapshotId !== undefined && payload.i !== String(snapshotId).toLowerCase()) {
		throw new WorkspaceError(syncErrorStatus.InvalidPageToken, syncErrorCodes.invalidPageToken);
	}
	return Object.freeze({ snapshotId: payload.i, lastPath: payload.p });
}

/**
 * The conflict copy name. It is derived only from the original path, the device and
 * a timestamp, so a retried request produces the same name; two devices conflict
 * into two different names because their device IDs differ.
 */
export function formatConflictTimestamp(timestampMs) {
	if (!Number.isSafeInteger(timestampMs) || timestampMs < 0) {
		throw new Error('A conflict timestamp must be a non-negative integer in milliseconds.');
	}
	return new Date(timestampMs).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

export const maxConflictIndex = 100;

function conflictSuffix(device, timestampMs, index) {
	const stamp = formatConflictTimestamp(timestampMs);
	const base = ' (conflict ' + device + ' ' + stamp;
	return index <= 1 ? base + ')' : base + ' ' + String(index) + ')';
}

/**
 * `/notes/plan.md` + `(device = phone, index = 1)` becomes
 * `/notes/plan (conflict phone 20260101T120000Z).md`. The extension is preserved
 * exactly the way the existing keep-both restore does it, so Office, image and
 * video attachments keep a name their viewer still opens.
 */
export function conflictPath(path, { device = fallbackDeviceId, timestampMs, index = 1 } = {}) {
	if (typeof path !== 'string' || !path.startsWith('/')) {
		throw new Error('A conflict path must be an absolute workspace path.');
	}
	if (!isValidDeviceId(device)) {
		throw new WorkspaceError(syncErrorStatus.InvalidDevice, syncErrorCodes.invalidDevice);
	}
	if (!Number.isSafeInteger(index) || index < 1 || index > maxConflictIndex) {
		throw new Error('A conflict index must be between 1 and ' + String(maxConflictIndex) + '.');
	}
	const extension = extname(path);
	const stem = extension === '' ? path : path.slice(0, -extension.length);
	return stem + conflictSuffix(device, timestampMs, index) + extension;
}

/**
 * Picks the first conflict path that is still free. The caller passes a synchronous
 * `isTaken(path)` probe that reads the already-locked workspace transaction, so two
 * concurrent saves cannot pick the same name.
 */
export function nextConflictPath(path, { device = fallbackDeviceId, timestampMs, isTaken } = {}) {
	if (typeof isTaken !== 'function') {
		throw new Error('Picking a conflict path needs an isTaken probe.');
	}
	for (let index = 1; index <= maxConflictIndex; index += 1) {
		const candidate = conflictPath(path, { device, timestampMs, index });
		if (!isTaken(candidate)) {
			return candidate;
		}
	}
	throw new WorkspaceError(syncErrorStatus.ConflictNameExhausted, syncErrorCodes.conflictNameExhausted);
}
