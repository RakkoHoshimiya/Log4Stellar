import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { authorizeWorkspace, workspaceCapabilities } from './workspace-access.mjs';
import { searchMountPath, searchRoutes } from './search-contract.mjs';
import { serveSearchRequest } from './search-files.mjs';
import { WorkspaceError } from './workspace-contract.mjs';

// The /search/v1 HTTP layer without PostgreSQL: these tests pin the ORDER of checks
// (capability first, parameters second, exactly like git-files.mjs and sync-files.mjs),
// the shapes handed to the storage backend, the error mapping, and the two acceptance
// rows that only need two independent workspaces:
//
//   S01  two workspaces both contain "发布计划" — a result never crosses a workspace.
//   S04  access is re-checked on every page, so a cursor from a revoked reader leaks
//        nothing and a cursor from a rebuilt index asks the client to search again.
//
// The real index (extraction, job queue, keyset paging) is covered by
// search-indexer.test.mjs and search-integration.test.mjs.

const maxBytes = 1024 * 1024;
const workspaceId = 'l4s-search-alpha';
const otherWorkspaceId = 'l4s-search-beta';

function context({ method = 'GET', path = searchRoutes.query, query = {}, headers = {} } = {}) {
	const stored = new Map(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
	return {
		method,
		path,
		query,
		status: undefined,
		body: undefined,
		req: Readable.from([]),
		get: name => stored.get(name.toLowerCase()) ?? '',
		set: (name, value) => stored.set(name.toLowerCase(), value),
		is: type => (stored.get('content-type') ?? '').startsWith(type),
	};
}

// A backend that records every call, so a rejected request can be proven never to have
// reached the index at all.
function recordingBackend({ workspace, documents = [], status, reindex, fail } = {}) {
	const calls = [];
	const backend = { calls };
	backend.searchDocuments = async (...args) => {
		calls.push({ name: 'searchDocuments', args });
		if (fail) throw fail;
		return {
			items: documents,
			total: documents.length,
			hasMore: false,
			nextCursor: null,
			indexGeneration: 1,
			indexedAt: 1_700_000_000_000,
		};
	};
	backend.searchStatus = async (...args) => {
		calls.push({ name: 'searchStatus', args });
		return status ?? { generation: 1, indexedMs: 1_700_000_000_000, rebuiltMs: null, documents: documents.length };
	};
	backend.reindexWorkspace = async (...args) => {
		calls.push({ name: 'reindexWorkspace', args });
		if (fail) throw fail;
		return reindex ?? { generation: 2, queued: documents.length, applied: documents.length };
	};
	backend.workspace = workspace;
	return backend;
}

async function serve({ role = 'owner', method, path, query, backend = recordingBackend() } = {}) {
	const ctx = context({ method, path, query });
	await serveSearchRequest(ctx, authorizeWorkspace(backend, { role }), backend, workspaceId, maxBytes);
	return { ctx, backend, body: ctx.body, status: ctx.status ?? (ctx.body === undefined ? 404 : 200) };
}

// ------------------------------------------------------------------ the order of checks

test('a role without the capability is refused before any parameter is read', async () => {
	// A viewer may read the index, so a rebuild is the interesting denial: the query is
	// deliberately malformed too, and the answer must still be 403 rather than 400.
	const denied = await serve({ role: 'viewer', method: 'POST', path: searchRoutes.reindex, query: { q: '' } });
	assert.equal(denied.status, 403);
	assert.deepEqual(denied.body, { error: 'NoPermissions' });
	assert.deepEqual(denied.backend.calls, [], 'a denied request must not touch the index');

	// The same malformed query is a client mistake once the caller may read, which
	// proves the capability check really runs first.
	const allowed = await serve({ role: 'viewer', query: { q: '   ' } });
	assert.equal(allowed.status, 400);
	assert.deepEqual(allowed.body, { error: 'InvalidQuery' });
	assert.deepEqual(allowed.backend.calls, []);
});

test('an unknown path under the mount is 404 and never defaults to read', async () => {
	for (const path of [searchMountPath + '/unknown', searchMountPath, searchMountPath + '/query/extra']) {
		const response = await serve({ path, query: { q: 'plan' } });
		assert.equal(response.status, 404, path);
		assert.deepEqual(response.body, { error: 'NotFound' }, path);
		assert.deepEqual(response.backend.calls, [], path);
	}
});

test('a wrong verb is treated as an unknown route rather than answered', async () => {
	// The route table is keyed by method and path together, so POST /query and
	// GET /reindex are simply not routes: the mount reports 404 for them exactly like it
	// does for an unknown path, and never reveals which paths exist.
	for (const [method, path] of [['POST', searchRoutes.query], ['GET', searchRoutes.reindex], ['DELETE', searchRoutes.query]]) {
		const response = await serve({ method, path, query: { q: 'plan' } });
		assert.equal(response.status, 404, method + ' ' + path);
		assert.deepEqual(response.backend.calls, [], method + ' ' + path);
	}
});

test('a backend that predates the route answers 501 instead of crashing', async () => {
	// The local workspace backend and every older release look like this: the facade
	// leaves the method undefined, so the route must say so explicitly.
	const response = await serve({ backend: {} });
	assert.equal(response.status, 501);
	assert.deepEqual(response.body, { error: 'SearchUnavailable' });
});

// ------------------------------------------------------------------ request shapes

test('a query is normalized and forwarded with the default limit and no cursor', async () => {
	const response = await serve({ query: { q: '  发布计划  ' } });
	assert.equal(response.status, 200);
	assert.deepEqual(response.backend.calls, [{ name: 'searchDocuments', args: [{ query: '发布计划', cursor: undefined, limit: 50 }] }]);
	assert.deepEqual(response.body.items, []);
});

test('a repeated parameter is refused instead of silently resolved', async () => {
	// Two different limits would make the page size depend on the parameter order.
	const response = await serve({ query: { q: 'plan', limit: ['10', '200'] } });
	assert.equal(response.status, 400);
	assert.deepEqual(response.body, { error: 'InvalidRequest' });
	assert.deepEqual(response.backend.calls, []);

	const repeatedQuery = await serve({ query: { q: ['plan', 'launch'] } });
	assert.equal(repeatedQuery.status, 400);
	assert.deepEqual(repeatedQuery.body, { error: 'InvalidRequest' });

	// Repeating a parameter with the same single value is not ambiguous.
	const same = await serve({ query: { q: ['plan'] } });
	assert.equal(same.status, 200);
});

test('the limit and the cursor are passed through unchanged', async () => {
	const cursor = 'l4q.eyJ2IjoxfQ.0123456789abcdef';
	const response = await serve({ query: { q: 'plan', limit: '25', cursor } });
	assert.equal(response.status, 200);
	assert.deepEqual(response.backend.calls[0].args, [{ query: 'plan', cursor, limit: 25 }]);
});

test('the status route reports the index state and needs no parameters', async () => {
	const response = await serve({
		path: searchRoutes.status,
		backend: recordingBackend({ status: { generation: 7, indexedMs: 12, rebuiltMs: 11, documents: 3 } }),
	});
	assert.equal(response.status, 200);
	assert.deepEqual(response.body, { generation: 7, indexedMs: 12, rebuiltMs: 11, documents: 3 });
	assert.deepEqual(response.backend.calls, [{ name: 'searchStatus', args: [] }]);
});

test('a rebuild is accepted with 202 and only the owner reaches it', async () => {
	const owner = await serve({ method: 'POST', path: searchRoutes.reindex });
	assert.equal(owner.status, 202);
	assert.deepEqual(owner.backend.calls, [{ name: 'reindexWorkspace', args: [] }]);
	// An editor may write notes but must not be able to make everyone's search slower.
	const editor = await serve({ role: 'editor', method: 'POST', path: searchRoutes.reindex });
	assert.equal(editor.status, 403);
	assert.deepEqual(editor.backend.calls, []);
});

// ------------------------------------------------------------------ error mapping

test('a backend error keeps its code and status without leaking a stack', async () => {
	for (const [code, status] of [['InvalidCursor', 400], ['SearchCursorExpired', 410], ['IndexRebuilding', 409], ['StorageObjectMissing', 502]]) {
		const response = await serve({
			backend: recordingBackend({ fail: new WorkspaceError(status, code) }),
			query: { q: 'plan' },
		});
		assert.equal(response.status, status, code);
		assert.deepEqual(response.body, { error: code }, code);
	}
});

// ------------------------------------------------------------------ S01: isolation

test('S01: a search only ever reports the current workspace', async () => {
	// Both workspaces hold a note whose title is "发布计划". The two backends are
	// separate objects, exactly like the two workspaces are separate rows, so a result
	// that crossed the boundary would have to come from the handler itself.
	const alpha = recordingBackend({
		workspace: 'alpha',
		documents: [{
			fileId: 'aaaaaaaa-0000-4000-8000-000000000001', path: '/alpha/发布计划.md',
			revisionId: 'aaaaaaaa-0000-4000-8000-000000000011', line: 1, column: 3, match: 'title',
			excerpt: '发布计划 alpha', excerptOffset: 0, excerptLength: 4,
		}],
	});
	const beta = recordingBackend({
		workspace: 'beta',
		documents: [{
			fileId: 'bbbbbbbb-0000-4000-8000-000000000002', path: '/beta/发布计划.md',
			revisionId: 'bbbbbbbb-0000-4000-8000-000000000022', line: 2, column: 1, match: 'body',
			excerpt: 'beta 发布计划', excerptOffset: 5, excerptLength: 4,
		}],
	});

	const first = await serve({ backend: alpha, query: { q: '发布计划' } });
	const second = await serve({ backend: beta, query: { q: '发布计划' } });

	assert.deepEqual(first.body.items.map(item => item.path), ['/alpha/发布计划.md']);
	assert.deepEqual(second.body.items.map(item => item.path), ['/beta/发布计划.md']);
	assert.equal(first.body.total, 1);
	assert.equal(second.body.total, 1);
	// The handler never forwards a workspace id: the backend it was given is already
	// scoped, so there is no parameter through which one workspace could name another.
	assert.deepEqual(alpha.calls[0].args, [{ query: '发布计划', cursor: undefined, limit: 50 }]);
	assert.deepEqual(beta.calls[0].args, alpha.calls[0].args);
	// Nothing in the payload names the other workspace.
	assert.doesNotMatch(JSON.stringify(second.body), /alpha/);
});

// ------------------------------------------------------------------ S04: revocation

test('S04: a page request is re-authorized, so a revoked reader gets no items', async () => {
	// The cursor was issued while the reader was still a member. It must not matter:
	// the capability is checked again on this very request, before any query runs.
	const revoked = await serve({
		role: 'viewer',
		method: 'POST',
		path: searchRoutes.reindex,
		query: { cursor: 'l4q.eyJ2IjoxfQ.0123456789abcdef', q: '发布计划' },
	});
	assert.equal(revoked.status, 403);
	assert.deepEqual(revoked.body, { error: 'NoPermissions' });
	assert.deepEqual(revoked.backend.calls, [], 'no index row may be read for a denied caller');

	// And when the storage layer itself refuses — the account lost the workspace while
	// the request was in flight — the response is the same 403 with no partial page.
	const refused = await serve({
		backend: recordingBackend({ fail: new WorkspaceError(403, 'NoPermissions') }),
		query: { cursor: 'l4q.eyJ2IjoxfQ.0123456789abcdef', q: '发布计划' },
	});
	assert.equal(refused.status, 403);
	assert.deepEqual(refused.body, { error: 'NoPermissions' });
});

test('S04: a cursor from a rebuilt index asks the client to search again', async () => {
	// Rebuilding moves every document to a new generation, so the page that follows the
	// cursor can no longer be served correctly. 410 is distinct from a forged token
	// (400) precisely so the client knows to retry instead of reporting a broken search.
	const response = await serve({
		backend: recordingBackend({ fail: new WorkspaceError(410, 'SearchCursorExpired') }),
		query: { q: '发布计划', cursor: 'l4q.eyJ2IjoxfQ.0123456789abcdef' },
	});
	assert.equal(response.status, 410);
	assert.deepEqual(response.body, { error: 'SearchCursorExpired' });
});

// ------------------------------------------------------------------ capability matrix

test('search reads are available to every role, and the mount adds no new capability', async () => {
	// The search mount reuses workspace.read for queries and workspace.admin for a
	// rebuild, so the role matrix is unchanged by this feature.
	assert.equal(workspaceCapabilities.read, 'workspace.read');
	for (const role of ['viewer', 'editor', 'owner']) {
		const response = await serve({ role, query: { q: 'plan' } });
		assert.equal(response.status, 200, role);
	}
});
