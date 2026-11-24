// Constants, validators and error semantics for the workspace full text search
// API (task 01 全文搜索). This module is pure: it never touches the file system,
// the database or a blob store, so every rule here can be exercised cheaply and
// every route is mapped to a capability before any I/O happens.
//
// The search surface is a sibling of /static/mount, /sync/v1 and /git/v1. It has
// its own cursors: a pagination position must be bound to the workspace, the
// query and the index generation it was produced by, because the document set can
// change under a client that keeps paging.

import { createHash } from 'node:crypto';
import { workspaceCapabilities } from './workspace-access.mjs';
import { WorkspaceError } from './workspace-contract.mjs';

// Sibling of /static/mount, /sync/v1 and /git/v1: notes are read through the
// storage API, the index is derived data, and the two must never be routed
// together.
export const searchMountPath = '/search/v1';

export const searchRoutes = Object.freeze({
	query: searchMountPath + '/query',
	reindex: searchMountPath + '/reindex',
	status: searchMountPath + '/status',
});

// The capability is a function of the method and the path ONLY: it must be
// resolvable before the query is parsed. Anything that is not listed resolves to
// undefined, which the handler turns into 404 NotFound — never into a default of
// "read". Searching notes uses the read capability the mount already grants, and
// rebuilding the index uses the admin capability because it rewrites derived
// state for the whole workspace.
const searchRouteTable = [
	{ method: 'GET', pattern: /^\/search\/v1\/query$/, capability: workspaceCapabilities.read },
	{ method: 'HEAD', pattern: /^\/search\/v1\/query$/, capability: workspaceCapabilities.read },
	{ method: 'GET', pattern: /^\/search\/v1\/status$/, capability: workspaceCapabilities.read },
	{ method: 'HEAD', pattern: /^\/search\/v1\/status$/, capability: workspaceCapabilities.read },
	{ method: 'POST', pattern: /^\/search\/v1\/reindex$/, capability: workspaceCapabilities.admin },
];

export function capabilityForSearchRequest(method, pathname) {
	for (const route of searchRouteTable) {
		if (route.method === method && route.pattern.test(pathname)) {
			return route.capability;
		}
	}
	return undefined;
}

export const searchErrorStatus = Object.freeze({
	InvalidRequest: 400,
	InvalidQuery: 400,
	InvalidLimit: 400,
	InvalidCursor: 400,
	InvalidPath: 400,
	NoPermissions: 403,
	NotFound: 404,
	SearchUnavailable: 501,
	// The index was rebuilt (or the cursor aged out) after this page was handed
	// out: the client must run the query again instead of paging from it. 410 is
	// used so a stale cursor can never be mistaken for an authorization failure.
	SearchCursorExpired: 410,
	IndexRebuilding: 409,
});

export const searchErrorCodes = Object.freeze(Object.keys(searchErrorStatus));

export function searchError(code) {
	const status = searchErrorStatus[code];
	if (!status) {
		throw new Error('Unknown search error code: ' + code);
	}
	return new WorkspaceError(status, code);
}

/**
 * Bounds the API enforces. `maxDocumentBytes` and `maxBodyChars` cap the derived
 * copy so a single huge note cannot make the index unbounded; `truncated` on a
 * document records that the cap applied, and the note itself is never touched.
 */
export const searchLimits = Object.freeze({
	defaultLimit: 50,
	maxLimit: 200,
	maxQueryLength: 256,
	maxDocumentBytes: 1024 * 1024,
	maxBodyChars: 200_000,
	maxExcerptChars: 200,
	maxPathChars: 4096,
	cursorMaxLength: 1024,
	cursorTtlMs: 60 * 60 * 1000,
});

/**
 * A query is matched as a literal, case-insensitive substring. The empty query is
 * refused rather than answered with the whole workspace: an empty pattern in a
 * search UI means "nothing typed yet", and replying with 200 plus every note
 * would make the cheapest request the most expensive one.
 */
export function normalizeSearchQuery(value) {
	if (typeof value !== 'string') {
		throw searchError('InvalidQuery');
	}
	const query = value.normalize('NFC').trim();
	if (query.length === 0 || query.length > searchLimits.maxQueryLength) {
		throw searchError('InvalidQuery');
	}
	// Control characters (including NUL) cannot appear in a note that extractMarkdown
	// would index, so they are refused instead of silently matching nothing.
	for (const character of query) {
		const code = character.codePointAt(0);
		if (code < 0x20 || code === 0x7f) {
			throw searchError('InvalidQuery');
		}
	}
	return query;
}

export function normalizeSearchLimit(value) {
	if (value === undefined || value === '') {
		return searchLimits.defaultLimit;
	}
	const limit = Number(value);
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > searchLimits.maxLimit) {
		throw searchError('InvalidLimit');
	}
	return limit;
}

/** Lower-cased form used by the SQL predicate; kept here so both sides agree. */
export function searchMatchText(query) {
	return query.toLowerCase();
}

export function queryFingerprint(query) {
	return createHash('sha256').update(query, 'utf8').digest('hex').slice(0, 16);
}

const cursorPrefix = 'l4q';
const cursorVersion = 1;

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

function splitToken(value) {
	if (typeof value !== 'string' || value === '' || value.length > searchLimits.cursorMaxLength) {
		throw searchError('InvalidCursor');
	}
	const parts = value.split('.');
	if (parts.length !== 3 || parts[0] !== cursorPrefix || tokenChecksum(parts[1]) !== parts[2]) {
		throw searchError('InvalidCursor');
	}
	return parts[1];
}

/**
 * A cursor names the last (path, fileId) a client has seen, plus the workspace,
 * query and index generation it belongs to. The checksum makes a truncated or
 * hand-edited token detectable before it reaches the database, and the workspace,
 * query and generation fields make a token from another context unusable even if
 * it verifies.
 */
export function encodeSearchCursor({ workspaceId, generation, query, path, fileId, nowMs = Date.now() }) {
	if (typeof workspaceId !== 'string' || workspaceId === '') {
		throw new Error('A search cursor needs a workspace ID.');
	}
	if (!Number.isSafeInteger(generation) || generation < 1) {
		throw new Error('A search cursor needs a positive index generation.');
	}
	if (typeof path !== 'string' || typeof fileId !== 'string') {
		throw new Error('A search cursor needs the last path and file ID of the page.');
	}
	const payload = {
		v: cursorVersion,
		w: workspaceId,
		g: generation,
		q: queryFingerprint(query),
		p: path,
		f: fileId,
		e: nowMs + searchLimits.cursorTtlMs,
	};
	return joinToken(toBase64Url(JSON.stringify(payload)));
}

export function decodeSearchCursor(value, { workspaceId, generation, query, nowMs = Date.now() } = {}) {
	let payload;
	try {
		payload = JSON.parse(fromBase64Url(splitToken(value)));
	} catch (error) {
		if (error instanceof WorkspaceError) {
			throw error;
		}
		throw searchError('InvalidCursor');
	}
	if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
		throw searchError('InvalidCursor');
	}
	if (payload.v !== cursorVersion
		|| typeof payload.w !== 'string'
		|| !Number.isSafeInteger(payload.g)
		|| typeof payload.q !== 'string'
		|| typeof payload.p !== 'string'
		|| typeof payload.f !== 'string'
		|| !Number.isSafeInteger(payload.e)) {
		throw searchError('InvalidCursor');
	}
	// A cursor from another workspace, a different query or a previous index
	// generation cannot describe a position in this result set. A different query
	// is a client bug, so it is 400; a rebuilt index is expected drift, so it is
	// 410 and the client re-runs the search.
	if (workspaceId !== undefined && payload.w !== workspaceId) {
		throw searchError('InvalidCursor');
	}
	if (query !== undefined && payload.q !== queryFingerprint(query)) {
		throw searchError('InvalidCursor');
	}
	if (generation !== undefined && payload.g !== generation) {
		throw searchError('SearchCursorExpired');
	}
	if (nowMs > payload.e) {
		throw searchError('SearchCursorExpired');
	}
	return Object.freeze({ path: payload.p, fileId: payload.f, generation: payload.g });
}
