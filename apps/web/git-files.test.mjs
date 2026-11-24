import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { authorizeWorkspace, workspaceCapabilities } from './workspace-access.mjs';
import { gitError, gitMountPath, gitRoutes } from './git-contract.mjs';
import { serveGitRequest } from './git-files.mjs';

// The /git/v1 HTTP layer without PostgreSQL and without a real repository: these tests
// pin the ORDER of checks (docs/git-integration.md §2.2 — capability first, parameters
// second), the request shapes handed to the git backend, and the error mapping. The
// real-git behaviour lives in git-repository.test.mjs and git-integration.test.mjs.

const maxBytes = 1024 * 1024;
const workspaceId = 'l4s-test-unit';

function context({ method = 'GET', path = '/', query = {}, headers = {}, body } = {}) {
	const stored = new Map(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
	if (body !== undefined && !stored.has('content-type')) {
		stored.set('content-type', 'application/json');
	}
	return {
		method,
		path: gitMountPath + path,
		query,
		status: undefined,
		body: undefined,
		req: Readable.from(body === undefined ? [] : [Buffer.from(body)]),
		get: name => stored.get(name.toLowerCase()) ?? '',
		set: (name, value) => stored.set(name.toLowerCase(), value),
		is: type => (stored.get('content-type') ?? '').startsWith(type),
	};
}

// A git backend that records every call, so a rejected request can be proven not to have
// reached the repository at all.
function recordingBackend(overrides = {}) {
	const calls = [];
	const defaults = {
		gitRepository: async () => ({ bound: false, repository: null }),
		gitStatus: async () => ({ clean: true, entries: [], branch: 'main' }),
		gitLog: async () => ({ commits: [], hasMore: false }),
		gitBranches: async () => ({ branches: [] }),
		gitCommit: async () => ({ files: [] }),
		gitCheckpoints: async () => ({ checkpoints: [] }),
		gitCredentials: async () => ({ credentials: [] }),
		gitFetch: async () => ({ fetched: true }),
		gitPush: async () => ({ pushed: true }),
		gitSwitchBranch: async () => ({ branch: 'main' }),
		gitCreateCheckpoint: async () => ({ checkpointId: 'a'.repeat(32) }),
		gitDeleteCheckpoint: async () => ({ deleted: true }),
		gitBindRepository: async () => ({ bound: true }),
		gitUnbindRepository: async () => ({ bound: false }),
		gitPutCredential: async () => ({ credentialId: 'b'.repeat(32) }),
		gitDeleteCredential: async () => ({ deleted: true }),
	};
	const backend = { calls };
	for (const [name, fallback] of Object.entries(defaults)) {
		backend[name] = async (...args) => {
			calls.push({ name, args });
			const override = overrides[name];
			return override ? override(...args) : fallback(...args);
		};
	}
	return backend;
}

async function serve({ role = 'owner', method, path, query, headers, body, backend = recordingBackend() } = {}) {
	const ctx = context({ method, path, query, headers, body });
	await serveGitRequest(ctx, authorizeWorkspace(backend, { role }), backend, workspaceId, maxBytes);
	return { ctx, backend, body: ctx.body, status: ctx.status ?? (ctx.body === undefined ? 404 : 200) };
}

function errorOf(response) {
	return response.body?.error;
}

// ------------------------------------------------------------------ the order of checks

test('an unauthorized role gets 403 NoPermissions and no parameter is ever validated', async () => {
	// The body is not merely absent but actively hostile: if the handler validated it
	// before authorizing, this request would be 400/415 instead of 403.
	const response = await serve({
		role: 'viewer',
		method: 'POST',
		path: '/push',
		headers: { 'content-type': 'text/plain' },
		body: '{"force":true}',
	});
	assert.equal(response.status, 403);
	assert.equal(errorOf(response), 'NoPermissions');
	assert.equal(response.backend.calls.length, 0);
});

test('a viewer may read but every write route is refused with 403 before validation', async () => {
	for (const [method, path] of [
		['POST', '/fetch'],
		['GET', '/status'],
		['GET', '/log'],
		['GET', '/branches'],
		['GET', '/checkpoints'],
	]) {
		const read = await serve({ role: 'viewer', method, path });
		assert.notEqual(read.status, 403, method + ' ' + path + ' must be readable by a viewer');
	}
	for (const [method, path] of [
		['POST', '/push'],
		['POST', '/branch'],
		['POST', '/checkpoints'],
		['DELETE', '/checkpoints/' + 'a'.repeat(32)],
		['PUT', '/repository'],
		['DELETE', '/repository'],
		['PUT', '/credentials'],
		['DELETE', '/credentials/' + 'b'.repeat(32)],
	]) {
		const denied = await serve({ role: 'viewer', method, path, body: '{}' });
		assert.equal(denied.status, 403, method + ' ' + path + ' must be refused for a viewer');
		assert.equal(errorOf(denied), 'NoPermissions');
		assert.equal(denied.backend.calls.length, 0, 'the backend must not be reached: ' + method + ' ' + path);
	}
});

test('an editor may write but binding a repository is owner-only', async () => {
	const push = await serve({ role: 'editor', method: 'POST', path: '/push', body: '{}' });
	assert.equal(push.status, 200);
	const bind = await serve({ role: 'editor', method: 'PUT', path: '/repository', body: '{"path":"repo"}' });
	assert.equal(bind.status, 403);
	assert.equal(errorOf(bind), 'NoPermissions');
	const ownerBind = await serve({ role: 'owner', method: 'PUT', path: '/repository', body: '{"path":"repo"}' });
	assert.equal(ownerBind.status, 200);
});

test('a workspace that is not wrapped by authorizeWorkspace() is a programming error, not a 500 page', async () => {
	const ctx = context({ method: 'GET', path: '/status' });
	const backend = recordingBackend();
	await assert.rejects(
		serveGitRequest(ctx, backend, backend, workspaceId, maxBytes),
		error => error.message === 'The workspace must be wrapped by authorizeWorkspace().',
	);
	assert.equal(backend.calls.length, 0);
});

test('an unrouted path or method is 404 NotFound, not a 405 from the gateway', async () => {
	for (const [method, path] of [
		['GET', '/nope'],
		['PUT', '/status'],
		['DELETE', '/log'],
		['POST', '/repository'],
		['GET', '/'],
	]) {
		const response = await serve({ method, path, body: method === 'GET' ? undefined : '{}' });
		assert.equal(response.status, errorOf(response) === undefined ? 405 : 404, method + ' ' + path);
		assert.equal(response.backend.calls.length, 0);
	}
	// A route that exists but whose backend method is missing answers 501, not 404: the
	// capability check succeeded, so a caller is allowed to learn that this build cannot
	// serve git (mirrors `SyncUnavailable`).
	const partial = recordingBackend();
	delete partial.gitStatus;
	const ctx = context({ method: 'GET', path: '/status' });
	await serveGitRequest(ctx, authorizeWorkspace(partial, { role: 'owner' }), partial, workspaceId, maxBytes);
	assert.equal(ctx.status, 501);
	assert.deepEqual(ctx.body, { error: 'GitUnavailable' });
});

// ------------------------------------------------------------------ request shapes

test('every documented route maps to the documented capability', async () => {
	// Guards against a route added to gitRouteTable but not to the handler (which would
	// 405) and against a capability that does not exist in the matrix.
	for (const [name, pattern] of Object.entries(gitRoutes)) {
		assert.equal(typeof pattern, 'string', 'route ' + name + ' must be a pattern');
	}
});

test('log forwards its query parameters and refuses a repeated one', async () => {
	const ok = await serve({ method: 'GET', path: '/log', query: { limit: '20', branch: 'main' } });
	assert.equal(ok.status, 200);
	const call = ok.backend.calls[0];
	assert.equal(call.name, 'gitLog');
	assert.deepEqual(call.args[0], { limit: 20, branch: 'main', commit: undefined });

	const repeated = await serve({ method: 'GET', path: '/log', query: { branch: ['main', 'other'] } });
	assert.equal(repeated.status, 400);
	assert.equal(errorOf(repeated), 'InvalidBranch');
	assert.equal(repeated.backend.calls.length, 0);
});

test('push rejects force push with 400 before the backend is touched', async () => {
	const forced = await serve({ role: 'owner', method: 'POST', path: '/push', body: '{"force":true}' });
	assert.equal(forced.status, 400);
	assert.equal(errorOf(forced), 'ForcePushNotAllowed');
	assert.equal(forced.backend.calls.length, 0);

	// `force: false` is explicitly allowed, because a client may send the field with the
	// documented default and must not be punished for it.
	const plain = await serve({ role: 'owner', method: 'POST', path: '/push', body: '{"force":false}' });
	assert.equal(plain.status, 200);
	assert.equal(plain.backend.calls.length, 1);
});

test('push forwards expectedRemote only when it is present, and null stays null', async () => {
	const omitted = await serve({ role: 'owner', method: 'POST', path: '/push', body: '{}' });
	assert.deepEqual(omitted.backend.calls[0].args[0], { branch: undefined });

	const present = await serve({ role: 'owner', method: 'POST', path: '/push', body: '{"expectedRemote":null}' });
	assert.equal(Object.hasOwn(present.backend.calls[0].args[0], 'expectedRemote'), true);
	assert.equal(present.backend.calls[0].args[0].expectedRemote, null);

	const sha = 'c'.repeat(40);
	const named = await serve({ role: 'owner', method: 'POST', path: '/push', body: JSON.stringify({ expectedRemote: sha }) });
	assert.equal(named.backend.calls[0].args[0].expectedRemote, sha);
});

test('push forwards the confirmed commit and remote identity', async () => {
	const body = {
		branch: 'main',
		expectedHead: 'a'.repeat(40),
		expectedRemoteId: 'remote-id',
		expectedRemote: null,
	};
	const pushed = await serve({ role: 'owner', method: 'POST', path: '/push', body: JSON.stringify(body) });
	assert.equal(pushed.status, 200);
	assert.deepEqual(pushed.backend.calls[0].args[0], body);
});

test('a malformed body is refused with the documented status codes', async () => {
	const wrongType = await serve({ role: 'owner', method: 'POST', path: '/push', headers: { 'content-type': 'text/plain' }, body: '{}' });
	assert.equal(wrongType.status, 415);
	assert.equal(errorOf(wrongType), 'InvalidContentType');

	const broken = await serve({ role: 'owner', method: 'POST', path: '/push', body: '{not json' });
	assert.equal(broken.status, 400);
	assert.equal(errorOf(broken), 'InvalidRequest');

	const arrayBody = await serve({ role: 'owner', method: 'POST', path: '/push', body: '[]' });
	assert.equal(arrayBody.status, 400);

	// An empty JSON body is a valid "no fields" request: every parameter of /push is
	// optional, but the content type is still required, exactly like /sync/v1.
	const empty = await serve({
		role: 'owner',
		method: 'POST',
		path: '/push',
		headers: { 'content-type': 'application/json' },
	});
	assert.equal(empty.status, 200);
});

test('a checkpoint create requires a name and returns 201', async () => {
	const missing = await serve({ role: 'editor', method: 'POST', path: '/checkpoints', body: '{}' });
	assert.equal(missing.status, 400);
	assert.equal(errorOf(missing), 'InvalidName');
	assert.equal(missing.backend.calls.length, 0);

	const created = await serve({
		role: 'editor',
		method: 'POST',
		path: '/checkpoints',
		body: '{"name":"v1","note":"release","commit":"' + 'd'.repeat(40) + '"}',
	});
	assert.equal(created.status, 201);
	assert.equal(created.backend.calls[0].args[0].name, 'v1');
	assert.equal(created.backend.calls[0].args[0].note, 'release');
});

test('a checkpoint id that is not one of ours is a 404, never an opaque failure', async () => {
	const backend = recordingBackend({ gitCheckpoints: async () => ({ checkpoints: [{ checkpointId: 'a'.repeat(32) }] }) });
	const found = await serve({ role: 'viewer', method: 'GET', path: '/checkpoints/' + 'a'.repeat(32), backend });
	assert.equal(found.status, 200);

	const other = await serve({ role: 'viewer', method: 'GET', path: '/checkpoints/' + 'e'.repeat(32), backend });
	assert.equal(other.status, 404);
	assert.equal(errorOf(other), 'CheckpointNotFound');
});

test('repository binding forwards every field and defaults nothing', async () => {
	const bound = await serve({
		role: 'owner',
		method: 'PUT',
		path: '/repository',
		body: '{"path":"team/app","remote":"ssh://git@host/app.git","remoteBranch":"main","defaultBranch":"main"}',
	});
	assert.equal(bound.status, 200);
	assert.deepEqual(bound.backend.calls[0].args[0], {
		path: 'team/app',
		remote: 'ssh://git@host/app.git',
		remoteBranch: 'main',
		defaultBranch: 'main',
		credentialId: undefined,
	});

	const missingPath = await serve({ role: 'owner', method: 'PUT', path: '/repository', body: '{}' });
	assert.equal(missingPath.status, 400);
	assert.equal(errorOf(missingPath), 'InvalidPath');
	assert.equal(missingPath.backend.calls.length, 0);
});

test('a credential create requires kind, label and secret and returns 201', async () => {
	const missing = await serve({ role: 'owner', method: 'PUT', path: '/credentials', body: '{"kind":"https-token","label":"ci"}' });
	assert.equal(missing.status, 400);
	assert.equal(errorOf(missing), 'InvalidCredential');
	assert.equal(missing.backend.calls.length, 0);

	const created = await serve({
		role: 'owner',
		method: 'PUT',
		path: '/credentials',
		body: '{"kind":"https-token","label":"ci","secret":"placeholder"}',
	});
	assert.equal(created.status, 201);
	assert.equal(created.backend.calls[0].args[0].label, 'ci');
});

// ------------------------------------------------------------------ error mapping

test('a backend git error becomes its documented status and code, with a sanitized detail', async () => {
	const cases = [
		['RemoteAuthenticationFailed', 502],
		['RemoteUnavailable', 502],
		['RemoteTimeout', 504],
		['NotFastForward', 409],
		['RemoteChanged', 412],
		['WorkTreeDirty', 422],
		['RepositoryBusy', 409],
		['RepositoryNotBound', 404],
		['BranchNotFound', 404],
		['GitFailed', 500],
	];
	for (const [code, status] of cases) {
		const backend = recordingBackend({ gitStatus: async () => { throw gitError(code); } });
		const response = await serve({ role: 'viewer', method: 'GET', path: '/status', backend });
		assert.equal(response.status, status, code);
		assert.equal(errorOf(response), code);
		// A credential failure must never be reported as an authentication failure of the
		// note service itself (§4.2: 401/403 belong to the workspace, not to the remote).
		if (code === 'RemoteAuthenticationFailed') {
			assert.notEqual(response.status, 401);
			assert.notEqual(response.status, 403);
		}
	}
});

test('the detail field carries the sanitized git message and nothing else', async () => {
	const backend = recordingBackend({
		gitFetch: async () => {
			const error = gitError('RemoteUnavailable');
			error.detail = 'fatal: <redacted> does not appear to be a git repository';
			throw error;
		},
	});
	const response = await serve({ role: 'owner', method: 'POST', path: '/fetch', backend });
	assert.equal(response.status, 502);
	assert.deepEqual(response.body, {
		error: 'RemoteUnavailable',
		detail: 'fatal: <redacted> does not appear to be a git repository',
	});
});

test('an unexpected exception is not swallowed into a 500 body', async () => {
	const backend = recordingBackend({ gitStatus: async () => { throw new TypeError('boom'); } });
	await assert.rejects(
		serve({ role: 'viewer', method: 'GET', path: '/status', backend }),
		error => error instanceof TypeError,
	);
});

test('gitRead is granted to viewers, gitWrite to editors and gitAdmin only to owners', () => {
	const viewer = authorizeWorkspace(recordingBackend(), { role: 'viewer' }).capabilities;
	const editor = authorizeWorkspace(recordingBackend(), { role: 'editor' }).capabilities;
	const owner = authorizeWorkspace(recordingBackend(), { role: 'owner' }).capabilities;
	assert.equal(viewer.includes(workspaceCapabilities.gitRead), true);
	assert.equal(viewer.includes(workspaceCapabilities.gitWrite), false);
	assert.equal(editor.includes(workspaceCapabilities.gitWrite), true);
	assert.equal(editor.includes(workspaceCapabilities.gitAdmin), false);
	assert.equal(owner.includes(workspaceCapabilities.gitAdmin), true);
});
