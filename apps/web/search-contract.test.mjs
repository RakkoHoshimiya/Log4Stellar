import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	capabilityForSearchRequest, decodeSearchCursor, encodeSearchCursor, normalizeSearchLimit,
	normalizeSearchQuery, queryFingerprint, searchError, searchErrorCodes, searchErrorStatus,
	searchLimits, searchMatchText, searchMountPath, searchRoutes,
} from './search-contract.mjs';
import { workspaceCapabilities } from './workspace-access.mjs';
import { WorkspaceError } from './workspace-contract.mjs';

const workspaceId = 'l4s-unit-search';
const otherWorkspace = 'l4s-unit-other';

function statusOf(work) {
	try {
		work();
	} catch (error) {
		assert.ok(error instanceof WorkspaceError, 'expected a WorkspaceError, got ' + error);
		return error.status;
	}
	throw new Error('expected the call to throw');
}

test('the search routes map to a capability before any parameter is parsed', () => {
	// Only the two documented verbs are routed. A PUT or a DELETE on the same path is
	// answered 405, and an unknown path is answered 404 — neither is ever read.
	assert.equal(capabilityForSearchRequest('GET', searchRoutes.query), workspaceCapabilities.read);
	assert.equal(capabilityForSearchRequest('HEAD', searchRoutes.query), workspaceCapabilities.read);
	assert.equal(capabilityForSearchRequest('GET', searchRoutes.status), workspaceCapabilities.read);
	assert.equal(capabilityForSearchRequest('POST', searchRoutes.reindex), workspaceCapabilities.admin);
	assert.equal(capabilityForSearchRequest('POST', searchRoutes.query), undefined);
	assert.equal(capabilityForSearchRequest('GET', searchRoutes.reindex), undefined);
	assert.equal(capabilityForSearchRequest('GET', searchMountPath + '/unknown'), undefined);
	assert.equal(capabilityForSearchRequest('GET', searchMountPath), undefined);
	// A sibling mount must not be captured by the search table.
	assert.equal(capabilityForSearchRequest('GET', '/static/mount/'), undefined);
	assert.equal(capabilityForSearchRequest('GET', '/search/v1/query/extra'), undefined);
});

test('every error code has a status and an unknown one is refused loudly', () => {
	assert.equal(searchErrorStatus.InvalidQuery, 400);
	assert.equal(searchErrorStatus.NoPermissions, 403);
	assert.equal(searchErrorStatus.NotFound, 404);
	assert.equal(searchErrorStatus.SearchCursorExpired, 410);
	assert.equal(searchErrorStatus.SearchUnavailable, 501);
	assert.deepEqual([...searchErrorCodes].sort(), Object.keys(searchErrorStatus).sort());
	for (const code of searchErrorCodes) {
		assert.equal(statusOf(() => { throw searchError(code); }), searchErrorStatus[code], code);
	}
	// A typo in an error code must fail at the call site, not turn into a 500 later.
	assert.throws(() => searchError('NotARealCode'), /Unknown search error code/);
});

test('a query is trimmed, NFC-normalized and bounded', () => {
	assert.equal(normalizeSearchQuery('  发布计划  '), '发布计划');
	// A decomposed form would not match the composed text in the index.
	assert.equal(normalizeSearchQuery('e\u0301'), 'é');
	assert.equal(normalizeSearchQuery('Launch'), 'Launch');
	for (const value of ['', '   ', undefined, null, 42, 'x'.repeat(searchLimits.maxQueryLength + 1)]) {
		assert.equal(statusOf(() => normalizeSearchQuery(value)), 400, String(value));
	}
	// A control character can never appear in an indexed note, so it is refused instead
	// of silently matching nothing.
	assert.equal(statusOf(() => normalizeSearchQuery('a\u0000b')), 400);
	assert.equal(statusOf(() => normalizeSearchQuery('a\nb')), 400);
	// Exactly at the cap is still accepted.
	assert.equal(normalizeSearchQuery('y'.repeat(searchLimits.maxQueryLength)).length, searchLimits.maxQueryLength);
});

test('a limit defaults, accepts a valid number and refuses everything else', () => {
	assert.equal(normalizeSearchLimit(undefined), searchLimits.defaultLimit);
	assert.equal(normalizeSearchLimit(''), searchLimits.defaultLimit);
	assert.equal(normalizeSearchLimit('1'), 1);
	assert.equal(normalizeSearchLimit(String(searchLimits.maxLimit)), searchLimits.maxLimit);
	for (const value of ['0', '-1', '1.5', 'abc', String(searchLimits.maxLimit + 1), '1e3']) {
		assert.equal(statusOf(() => normalizeSearchLimit(value)), 400, value);
	}
});

test('the SQL needle is the lower-cased query, so both sides agree', () => {
	assert.equal(searchMatchText('Launch Plan'), 'launch plan');
	// Chinese has no case, so it must survive unchanged — otherwise strpos() would look
	// for a different string than the one the user typed.
	assert.equal(searchMatchText('发布计划'), '发布计划');
	assert.equal(queryFingerprint('发布计划'), queryFingerprint('发布计划'));
	assert.notEqual(queryFingerprint('发布计划'), queryFingerprint('发布計劃'));
	assert.match(queryFingerprint('Launch'), /^[0-9a-f]{16}$/);
});

test('a cursor round-trips and keeps its position', () => {
	const cursor = encodeSearchCursor({
		workspaceId, generation: 3, query: '发布计划', path: '/notes/plan.md', fileId: 'a5f7c1d0-0000-4000-8000-000000000001',
	});
	assert.deepEqual(
		decodeSearchCursor(cursor, { workspaceId, generation: 3, query: '发布计划' }),
		{ path: '/notes/plan.md', fileId: 'a5f7c1d0-0000-4000-8000-000000000001', generation: 3 },
	);
	// The token must not be readable as the text it points at, and it must stay short
	// enough for a query string.
	assert.match(cursor, /^l4q\.[A-Za-z0-9_-]+\.[0-9a-f]{16}$/);
	assert.ok(cursor.length <= searchLimits.cursorMaxLength);
});

test('a cursor cannot be moved to another workspace or another query', () => {
	const cursor = encodeSearchCursor({
		workspaceId, generation: 1, query: '发布计划', path: '/a.md', fileId: 'a5f7c1d0-0000-4000-8000-000000000002',
	});
	// Cross workspace reuse is a client mistake and a possible probe, so it is 400.
	assert.equal(statusOf(() => decodeSearchCursor(cursor, { workspaceId: otherWorkspace })), 400);
	// Paging the same position with a different query is also a client mistake.
	assert.equal(statusOf(() => decodeSearchCursor(cursor, { workspaceId, query: '别的' })), 400);
});

test('a cursor from a previous index generation is 410, not 400', () => {
	const cursor = encodeSearchCursor({
		workspaceId, generation: 1, query: 'plan', path: '/a.md', fileId: 'a5f7c1d0-0000-4000-8000-000000000003',
	});
	// A rebuild moved the document set under this cursor: the client has to search again,
	// so it must be able to tell this apart from a forged token.
	assert.equal(statusOf(() => decodeSearchCursor(cursor, { workspaceId, generation: 2, query: 'plan' })), 410);
});

test('a cursor expires and a tampered one is refused', () => {
	const issued = Date.now();
	const cursor = encodeSearchCursor({
		workspaceId, generation: 1, query: 'plan', path: '/a.md',
		fileId: 'a5f7c1d0-0000-4000-8000-000000000004', nowMs: issued,
	});
	assert.equal(
		statusOf(() => decodeSearchCursor(cursor, { workspaceId, nowMs: issued + searchLimits.cursorTtlMs + 1 })),
		410,
	);
	for (const value of ['', 'l4q', 'l4q..', 'nope.abc.def', cursor.slice(0, -1), cursor + 'x', 'l4q.' + cursor.split('.')[1] + '.' + '0'.repeat(16)]) {
		assert.equal(statusOf(() => decodeSearchCursor(value, { workspaceId })), 400, value);
	}
});
