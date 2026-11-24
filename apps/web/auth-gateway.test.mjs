import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authGateway, workspaceHeader } from './auth-gateway.mjs';
import { createWorkspaceBackends } from './workspace-backends.mjs';

const origin = new URL('https://workspace.invalid');
const user = { id: 'MixedCaseAccount' };
const session = { user, session: { expiresAt: new Date(Date.now() + 100_000).toISOString() } };
const defaultWorkspace = 'log4stellar-main';

function context(path, requestHeaders = {}, { method = 'GET', query = { stat: '1' }, body } = {}) {
	const headers = new Headers(requestHeaders);
	const ctx = {
		secure: true,
		host: origin.host,
		path,
		method,
		query,
		state: {},
		req: { socket: { remoteAddress: '127.0.0.1' } },
		get: name => headers.get(name) ?? '',
		set: (name, value) => headers.set(name, value),
		is: expected => headers.get('content-type')?.startsWith(expected) ?? false,
	};
	if (body !== undefined) {
		ctx.req = Object.assign(body, { socket: { remoteAddress: '127.0.0.1' } });
	}
	return ctx;
}

function backend(label) {
	const calls = [];
	return {
		label,
		calls,
		async stat() {
			calls.push('stat');
			return { type: 1, label };
		},
		async writeFile(path) {
			calls.push('writeFile');
			return { path, etag: 'v1', created: false, size: 0 };
		},
		async close() {
			calls.push('close');
		},
	};
}

function gateway({ matchesWorkspaceAccount = () => true, roles = { [defaultWorkspace]: 3 }, canReadWorkspace = () => true, workspaces } = {}) {
	const opened = [];
	const cache = workspaces ?? createWorkspaceBackends({
		async open(workspaceId) {
			opened.push(workspaceId);
			return backend(workspaceId);
		},
	});
	return {
		cache,
		opened,
		middleware: authGateway({
			auth: { handler: async () => Response.json(session) },
			origin,
			canReadWorkspace,
			matchesWorkspaceAccount,
			defaultWorkspaceId: () => defaultWorkspace,
			workspacesOf: () => [{ id: defaultWorkspace, role: roles[defaultWorkspace] }],
			resolveRole: (_userId, workspaceId) => roles[workspaceId],
			workspaces: cache,
		}, 1024, () => 'en'),
	};
}

/** Same wiring as `gateway`, plus the preview opener that turns the route on. */
function gatewayWithPreview({ openOfficePreview, roles = { [defaultWorkspace]: 3 } } = {}) {
	const opened = [];
	const cache = createWorkspaceBackends({
		async open(workspaceId) {
			opened.push(workspaceId);
			return backend(workspaceId);
		},
	});
	const middleware = authGateway({
		auth: { handler: async () => Response.json(session) },
		origin,
		canReadWorkspace: () => true,
		matchesWorkspaceAccount: () => true,
		defaultWorkspaceId: () => defaultWorkspace,
		workspacesOf: () => Object.keys(roles).map(id => ({ id, role: roles[id] })),
		resolveRole: (_userId, workspaceId) => roles[workspaceId],
		workspaces: cache,
		openOfficePreview,
	}, 1024, () => 'en');
	return { cache, opened, middleware };
}

test('a canonical workspace authority is accepted without normalizing session identity', async () => {
	const { middleware } = gateway({ matchesWorkspaceAccount: (id, authority) => id === user.id && authority === 'mixedcaseaccount' });
	const current = context('/static/mount/note.md', { 'X-Log4Stellar-Workspace-Account': 'mixedcaseaccount' });
	await middleware(current);
	assert.deepEqual(current.body, { type: 1, label: defaultWorkspace });

	const legacy = context('/static/mount/note.md', { 'X-Log4Stellar-Account': 'mixedcaseaccount' });
	await middleware(legacy);
	assert.deepEqual(legacy.body, { type: 1, label: defaultWorkspace });

	const staleSession = context('/api/session', { 'X-Log4Stellar-Account': 'mixedcaseaccount' });
	await middleware(staleSession);
	assert.equal(staleSession.status, 409);
	assert.deepEqual(staleSession.body, { error: 'AccountChanged' });

	const activeSession = context('/api/session', { 'X-Log4Stellar-Account': user.id });
	await middleware(activeSession);
	assert(activeSession.body.remainingMs > 0);
	assert.equal(activeSession.body.workspaceId, defaultWorkspace);
	assert.equal(activeSession.body.accountId, user.id);
	assert.deepEqual(activeSession.body.workspaces, [{ id: defaultWorkspace, role: 3 }]);
});

test('a stale or ambiguous workspace owner cannot act under the active session', async () => {
	const { middleware } = gateway({ matchesWorkspaceAccount: () => false });
	for (const account of ['formeraccount', 'mixedcaseaccount']) {
		const ctx = context('/static/mount/note.md', { 'X-Log4Stellar-Workspace-Account': account });
		await middleware(ctx);
		assert.equal(ctx.status, 409);
		assert.deepEqual(ctx.body, { error: 'AccountChanged' });
	}
	const legacy = context('/static/mount/note.md', { 'X-Log4Stellar-Account': user.id });
	await middleware(legacy);
	assert.equal(legacy.status, 409);
});

test('resolves the workspace from the request header and the matching role', async () => {
	const roles = { [defaultWorkspace]: 3, 'team-notes': 1 };
	const { middleware, opened } = gateway({ roles });
	const viewer = context('/static/mount/note.md', { [workspaceHeader]: 'team-notes' });
	await middleware(viewer);
	assert.equal(viewer.state.workspaceId, 'team-notes');
	assert.equal(viewer.state.workspaceRole, 1);
	assert.deepEqual(opened, ['team-notes']);

	// Without a header the session default workspace is used.
	const implicit = context('/static/mount/note.md');
	await middleware(implicit);
	assert.equal(implicit.state.workspaceId, defaultWorkspace);
	assert.equal(implicit.state.workspaceRole, 3);

	// Report the header value back so clients do not have to guess the casing.
	const mixedCase = context('/static/mount/note.md', { [workspaceHeader]: 'TEAM-Notes' });
	await middleware(mixedCase);
	assert.equal(mixedCase.state.workspaceId, 'team-notes');
});

test('a non-member or unknown workspace is 403 without touching that workspace', async () => {
	const { middleware, opened } = gateway({ roles: { [defaultWorkspace]: 3 } });
	const cases = [
		// The user is simply not a member.
		context('/static/mount/note.md', { [workspaceHeader]: 'someone-elses' }),
		// The header is not a valid workspace ID at all.
		context('/static/mount/note.md', { [workspaceHeader]: '../etc' }),
		context('/static/mount/note.md', { [workspaceHeader]: 'Upper Case' }),
	];
	for (const ctx of cases) {
		await middleware(ctx);
		assert.equal(ctx.status, 403);
		assert.deepEqual(ctx.body, { error: 'NoPermissions' });
	}
	assert.deepEqual(opened, [], 'a workspace the caller may not use must never be opened');

	// A backend that refuses to open is indistinguishable from a missing membership.
	const failing = gateway({
		roles: { 'team-notes': 3 },
		workspaces: createWorkspaceBackends({ open: async () => { throw new Error('The RustFS workspace must be imported before it can be opened.'); } }),
	});
	const unopened = context('/static/mount/note.md', { [workspaceHeader]: 'team-notes' });
	await failing.middleware(unopened);
	assert.equal(unopened.status, 403);
	assert.deepEqual(unopened.body, { error: 'NoPermissions' });
});

test('the login gate means "member of any workspace", not "may read this one"', async () => {
	const { middleware } = gateway({ roles: {}, canReadWorkspace: () => false });
	const workbench = context('/');
	await middleware(workbench);
	assert.equal(workbench.status, 403);

	// A mounted request is decided per workspace, so the login gate must not short-circuit.
	const mounted = context('/static/mount/note.md', { [workspaceHeader]: defaultWorkspace });
	await middleware(mounted);
	assert.equal(mounted.status, 403);
	assert.deepEqual(mounted.body, { error: 'NoPermissions' });
});

test('a viewer cannot write through the gateway', async () => {
	const { middleware, opened } = gateway({ roles: { [defaultWorkspace]: 1 } });
	const ctx = context('/static/mount/note.md', { 'Content-Type': 'text/plain', Origin: origin.origin }, { method: 'PUT', query: {}, body: {} });
	await middleware(ctx);
	assert.equal(ctx.status, 403);
	assert.deepEqual(ctx.body, { error: 'NoPermissions' });

	// The rejected request still released its lease, so the next request reuses the
	// same cached backend instead of opening a second one.
	const allowed = context('/static/mount/note.md');
	await middleware(allowed);
	assert.deepEqual(opened, [defaultWorkspace]);
});

test('holds the backend lease until a live response has finished, and releases once', async () => {
	const cache = createWorkspaceBackends({ open: async workspaceId => backend(workspaceId) });
	// Count the releases: a lease that is released twice would let the cache evict a
	// backend that another request is still using.
	const releases = [];
	const counted = { ...cache, acquire: id => cache.acquire(id), release: id => { releases.push(id); return cache.release(id); } };
	const { middleware } = gateway({ roles: { [defaultWorkspace]: 3 }, workspaces: counted });

	const live = context('/static/mount/note.md');
	const listeners = new Map();
	live.res = {
		writableEnded: false,
		once(event, listener) {
			listeners.set(event, listener);
		},
	};
	await middleware(live);
	assert.deepEqual(live.body, { type: 1, label: defaultWorkspace });
	assert.deepEqual([...listeners.keys()], ['close', 'finish']);
	assert.deepEqual(releases, [], 'a live response keeps its lease');

	// `finish` fires first on a normal response; `close` follows and must not count.
	listeners.get('finish')();
	listeners.get('close')();
	assert.deepEqual(releases, [defaultWorkspace]);

	// A response that already ended releases immediately instead of pinning the slot.
	const ended = context('/static/mount/note.md');
	ended.res = {
		writableEnded: true,
		once: () => assert.fail('an already ended response must not be awaited'),
	};
	await middleware(ended);
	assert.deepEqual(ended.body, { type: 1, label: defaultWorkspace });
	assert.deepEqual(releases, [defaultWorkspace, defaultWorkspace]);

	// Every request takes exactly one lease, so the cache keeps the backend.
	assert.equal(cache.size, 1);
});

test('a response that died before the lease was registered still releases it', async () => {
	// A client that disconnects early leaves `ctx.res` destroyed, so `close` has already
	// fired and `finish` never will. Waiting for either pinned the lease forever and the
	// cache could not evict that backend afterwards (review finding M3.2).
	const { cache, middleware } = gateway({ roles: { [defaultWorkspace]: 3, 'team-notes': 1 } });
	for (const destroyed of [{ destroyed: true }, { writableEnded: true }, { writableFinished: true }]) {
		const ctx = context('/static/mount/note.md');
		ctx.res = { ...destroyed, once: () => assert.fail('a dead response must not be awaited') };
		await middleware(ctx);
		assert.deepEqual(ctx.body, { type: 1, label: defaultWorkspace });
	}

	// Every lease is back, so the next workspace can evict the least recently used one.
	const other = context('/static/mount/note.md', { 'X-Log4Stellar-Workspace': 'team-notes' });
	other.res = { destroyed: true };
	await middleware(other);
	assert.deepEqual(other.body, { type: 1, label: 'team-notes' });
	assert.equal(cache.size, 2, 'nothing is left leased, so nothing is pinned');
	await cache.close();
});

// ---------------------------------------------------------------------------------------
// /sync/v1 mount
// ---------------------------------------------------------------------------------------

test('the sync API is mounted as a sibling of the mount path and takes one lease', async () => {
	const opened = [];
	const syncCalls = [];
	const cache = createWorkspaceBackends({
		async open(workspaceId) {
			opened.push(workspaceId);
			return {
				...backend(workspaceId),
				async syncChanges(args) {
					syncCalls.push(args);
					return { workspaceId, head: 0, fromSeq: 0, toSeq: 0, changes: [], hasMore: false, cursor: 'cursor' };
				},
			};
		},
	});
	const { middleware } = gateway({ roles: { [defaultWorkspace]: 3 }, workspaces: cache });
	const ctx = context('/sync/v1/changes', { [workspaceHeader]: defaultWorkspace }, { query: { limit: '10' } });
	await middleware(ctx);
	assert.equal(ctx.status, 200);
	assert.deepEqual(ctx.body.changes, []);
	assert.equal(syncCalls.length, 1, 'the request reached the sync handler, not the file handler');
	assert.deepEqual(opened, [defaultWorkspace]);
	assert.equal(ctx.state.workspaceId, defaultWorkspace);
	assert.equal(ctx.state.workspaceRole, 3);
	// The lease is held until the response ends, exactly like the mount path.
	assert.equal(cache.size, 1);
	await cache.close();
});

test('a sync write without the expected Origin is rejected before reaching the workspace', async () => {
	const opened = [];
	const cache = createWorkspaceBackends({
		async open(workspaceId) {
			opened.push(workspaceId);
			return { ...backend(workspaceId), async syncMkdir() { assert.fail('must not run'); } };
		},
	});
	const { middleware } = gateway({ roles: { [defaultWorkspace]: 3 }, workspaces: cache });
	const ctx = context('/sync/v1/mkdir', { [workspaceHeader]: defaultWorkspace, 'Content-Type': 'application/json', Origin: 'https://evil.invalid' }, { method: 'POST', query: {}, body: {} });
	await middleware(ctx);
	assert.equal(ctx.status, 403);
	assert.deepEqual(opened, [], 'the cross-origin request must be stopped before the workspace is opened');
	await cache.close();
});

test('a sync request still goes through the capability facade', async () => {
	// Viewers hold workspace.read and workspace.history but not write/delete/restore, so the
	// sync API must deny them exactly like /static/mount does.
	const calls = [];
	const cache = createWorkspaceBackends({
		async open(workspaceId) {
			return {
				...backend(workspaceId),
				async syncMkdir() {
					calls.push('mkdir');
					return { status: 201, body: {} };
				},
			};
		},
	});
	const { middleware } = gateway({ roles: { [defaultWorkspace]: 1 }, workspaces: cache });
	const ctx = context('/sync/v1/mkdir', { [workspaceHeader]: defaultWorkspace, 'Content-Type': 'application/json', Origin: origin.origin }, { method: 'POST', query: {}, body: {} });
	await middleware(ctx);
	assert.equal(ctx.status, 403);
	assert.deepEqual(ctx.body, { error: 'NoPermissions' });
	assert.deepEqual(calls, [], 'the backend must not see an unauthorized write');
	await cache.close();
});

test('every sync route is classified as a workspace request, so it is never a bare 405', async () => {
	// Without the route family in the gateway's classification, POST /sync/v1/... would fall
	// into the "not a route" branch and answer 405 before the workspace is even resolved.
	const cache = createWorkspaceBackends({
		async open(workspaceId) {
			assert.fail('a request without a session must not open ' + workspaceId);
		},
	});
	const middleware = authGateway({
		auth: { handler: async () => Response.json(null) },
		origin,
		canReadWorkspace: () => true,
		matchesWorkspaceAccount: () => true,
		defaultWorkspaceId: () => defaultWorkspace,
		resolveRole: () => 3,
		workspaces: cache,
	}, 1024, () => 'en');
	const ctx = context('/sync/v1/snapshot', { [workspaceHeader]: defaultWorkspace, 'Content-Type': 'application/json', Origin: origin.origin }, { method: 'POST', query: {}, body: {} });
	await middleware(ctx);
	assert.equal(ctx.status, 401, 'unauthenticated, not 405');
});

test('workbench selection checks current membership and rejects invalid workspace IDs', async () => {
  const { middleware } = gateway({ roles: { [defaultWorkspace]: 3, 'shared-notes': 2 } });
  for (const [requested, expected] of [['shared-notes', 200], ['other-notes', 403], ['../bad', 403], [['shared-notes', 'other-notes'], 403]]) {
    const ctx = context('/', {}, { query: { l4sWorkspace: requested } });
    let rendered = false;
    await middleware(ctx, async () => { rendered = true; });
    assert.equal(ctx.status ?? 200, expected);
    assert.equal(rendered, expected === 200);
    if (rendered) assert.equal(ctx.state.workspaceId, requested);
  }
});

test('the workbench workspace parameter does not select a Log4Stellar workspace', async () => {
  const { middleware } = gateway({ roles: { [defaultWorkspace]: 3, 'shared-notes': 2 } });
  const ctx = context('/', {}, { query: { workspace: 'shared-notes' } });
  await middleware(ctx, async () => {});
  assert.equal(ctx.state.workspaceId, defaultWorkspace);
});

// ---------------------------------------------------------------------------------------
// /search/v1 mount
// ---------------------------------------------------------------------------------------

test('the search API is mounted as a sibling of the mount path and takes one lease', async () => {
	const opened = [];
	const searchCalls = [];
	const cache = createWorkspaceBackends({
		async open(workspaceId) {
			opened.push(workspaceId);
			return {
				...backend(workspaceId),
				async searchDocuments(args) {
					searchCalls.push(args);
					return { items: [], total: 0, hasMore: false, nextCursor: null, indexGeneration: 1, indexedAt: 0 };
				},
			};
		},
	});
	const { middleware } = gateway({ roles: { [defaultWorkspace]: 3 }, workspaces: cache });
	const ctx = context('/search/v1/query', { [workspaceHeader]: defaultWorkspace }, { query: { q: '发布计划' } });
	await middleware(ctx);
	assert.equal(ctx.status, 200);
	assert.deepEqual(ctx.body.items, []);
	assert.equal(searchCalls.length, 1, 'the request reached the search handler, not the file handler');
	assert.deepEqual(opened, [defaultWorkspace]);
	assert.equal(ctx.state.workspaceId, defaultWorkspace);
	assert.equal(cache.size, 1);
	await cache.close();
});

test('a search request without a session is unauthorized, never a bare 405', async () => {
	// The route family has to be classified in the gateway, otherwise a GET would fall into
	// the "not a route" branch and answer 405 before the session is looked at.
	const cache = createWorkspaceBackends({
		async open(workspaceId) {
			assert.fail('a request without a session must not open ' + workspaceId);
		},
	});
	const middleware = authGateway({
		auth: { handler: async () => Response.json(null) },
		origin,
		canReadWorkspace: () => true,
		matchesWorkspaceAccount: () => true,
		defaultWorkspaceId: () => defaultWorkspace,
		resolveRole: () => 3,
		workspaces: cache,
	}, 1024, () => 'en');
	const ctx = context('/search/v1/query', { [workspaceHeader]: defaultWorkspace }, { query: { q: 'plan' } });
	await middleware(ctx);
	assert.equal(ctx.status, 401);
});

test('a search request still goes through the capability facade', async () => {
	// A viewer may query the index; a rebuild stays an owner action even though both
	// travel through the same mount.
	const calls = [];
	const cache = createWorkspaceBackends({
		async open(workspaceId) {
			return {
				...backend(workspaceId),
				async searchDocuments() {
					calls.push('searchDocuments');
					return { items: [], total: 0, hasMore: false, nextCursor: null, indexGeneration: 1, indexedAt: 0 };
				},
				async reindexWorkspace() {
					calls.push('reindexWorkspace');
					return { generation: 2, queued: 0, applied: 0 };
				},
			};
		},
	});
	const viewer = gateway({ roles: { [defaultWorkspace]: 1 }, workspaces: cache });
	const queried = context('/search/v1/query', { [workspaceHeader]: defaultWorkspace }, { query: { q: 'plan' } });
	await viewer.middleware(queried);
	assert.equal(queried.status, 200);

	const rebuild = context('/search/v1/reindex', { [workspaceHeader]: defaultWorkspace, 'Content-Type': 'application/json', Origin: origin.origin }, { method: 'POST', query: {}, body: {} });
	await viewer.middleware(rebuild);
	assert.equal(rebuild.status, 403);
	assert.deepEqual(rebuild.body, { error: 'NoPermissions' });
	assert.deepEqual(calls, ['searchDocuments'], 'the backend must not see an unauthorized rebuild');
	await cache.close();
});

test('office previews are unreachable unless the deployment passes an opener', async () => {
	// The feature flag is expressed as the absence of `openOfficePreview`: with no opener
	// the route prefix is not recognized at all, so it falls through to the static app.
	const { middleware, opened } = gateway();
	const ctx = context('/api/v1/office-previews', {}, { method: 'GET', query: {} });
	let rendered = false;
	await middleware(ctx, async () => { rendered = true; });
	assert.equal(rendered, true);
	assert.equal(ctx.status, undefined);
	assert.deepEqual(opened, [], 'no workspace backend is opened for an unknown path');
});

test('an enabled office preview route is authorized per workspace and never writes the mount', async () => {
	const calls = [];
	const { middleware, opened } = gatewayWithPreview({
		openOfficePreview: async scope => {
			calls.push(scope);
			return {};
		},
	});
	const ctx = context('/api/v1/office-previews', { [workspaceHeader]: defaultWorkspace }, { method: 'GET', query: {} });
	await middleware(ctx);
	// A GET on the collection is a 405 from the preview router, which proves the request
	// was dispatched there rather than answered by the mount route.
	assert.equal(ctx.status, 405);
	assert.deepEqual(opened, [defaultWorkspace]);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].workspaceId, defaultWorkspace);

	// A non member never reaches the opener.
	calls.length = 0;
	const outsider = gatewayWithPreview({ openOfficePreview: async scope => { calls.push(scope); return {}; }, roles: {} });
	const denied = context('/api/v1/office-previews', { [workspaceHeader]: defaultWorkspace }, { method: 'GET', query: {} });
	await outsider.middleware(denied);
	assert.equal(denied.status, 403);
	assert.deepEqual(denied.body, { error: 'NoPermissions' });
	assert.equal(calls.length, 0);
});

test('a cross origin preview POST is refused before the opener runs', async () => {
	const calls = [];
	const { middleware } = gatewayWithPreview({
		openOfficePreview: async scope => { calls.push(scope); return {}; },
	});
	const ctx = context('/api/v1/office-previews', {
		[workspaceHeader]: defaultWorkspace,
		Origin: 'https://elsewhere.invalid',
	}, { method: 'POST', query: {}, body: {} });
	await middleware(ctx);
	assert.equal(ctx.status, 403);
	assert.equal(calls.length, 0);
});
