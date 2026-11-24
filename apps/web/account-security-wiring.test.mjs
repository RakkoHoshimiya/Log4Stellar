import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { authGateway, workspaceHeader } from './auth-gateway.mjs';
import { createWorkspaceBackends } from './workspace-backends.mjs';

// Contract §13.1: a password-correct-but-not-second-factored request must reach
// nothing. In this project the half-authenticated state is not a weak session —
// the authentication library deletes the session row and hands back a 600 second
// challenge cookie instead — so `get-session` answers null and the only evidence
// of the state is that cookie.
//
// These tests drive the middleware alone (no database, no better-auth) so they
// can pin the *order* of operations, which is the part that keeps regressing:
// authorization has to be decided before a single byte of the request body is
// parsed, otherwise a 400/415 becomes a probe for internal state.
const origin = new URL('https://workspace.invalid');
const user = { id: 'AccountAlpha', username: 'account.alpha' };
const defaultWorkspace = 'log4stellar-main';
const challengeCookie = '__Secure-better-auth.two_factor';
const sessionCookie = '__Secure-better-auth.session_token';

function session({ expired = false } = {}) {
	return {
		user,
		session: { expiresAt: new Date(Date.now() + (expired ? -1000 : 100_000)).toISOString() },
	};
}

function makeContext(path, { method = 'GET', header = {}, query = {}, body, state } = {}) {
	const headers = new Headers(header);
	const reads = [];
	const ctx = {
		secure: true,
		host: origin.host,
		path,
		method,
		query,
		state: state ?? {},
		reads,
		req: { socket: { remoteAddress: '127.0.0.1' } },
		get: name => headers.get(name) ?? '',
		set: (name, value) => headers.set(name, value),
		append: (name, value) => headers.append(name, value),
		vary: name => headers.append('Vary', name),
		is: expected => {
			reads.push('is:' + expected);
			return headers.get('content-type')?.startsWith(expected) ?? false;
		},
	};
	if (body !== undefined) {
		ctx.req = Object.assign(Readable.from([Buffer.from(body)]), { socket: { remoteAddress: '127.0.0.1' } });
	}
	return ctx;
}

// Koa defaults an unset status to 200; the middleware only assigns a status when it
// wants something other than success.
function statusOf(ctx) {
	return ctx.status ?? 200;
}

function cookiesOf(ctx) {
	return ctx.getSetCookie?.() ?? [];
}

function backend(label) {
	return {
		label,
		async stat() {
			return { type: 1, label };
		},
		async writeFile(path) {
			return { path, etag: 'v1', created: false, size: 0 };
		},
		async close() {},
	};
}

// `mode` decides what the authentication library reports:
//   'full'    — a live session
//   'half'    — no session row, but a valid challenge cookie is presented
//   'anon'    — nothing at all
//   'forged'  — a challenge cookie that fails verification
//   'stale'   — a challenge cookie whose verification row has expired
function gateway({ mode = 'full', expired = false, workspaces, resolveChallenge, accountSecurity } = {}) {
	const opened = [];
	const authCalls = [];
	const cache = workspaces ?? createWorkspaceBackends({
		async open(workspaceId) {
			opened.push(workspaceId);
			return backend(workspaceId);
		},
	});
	const challenge = resolveChallenge ?? ((value, nowMs) => {
		if (mode === 'half') {
			return { identifier: '2fa-' + value, expiresAtMs: nowMs + 600_000 };
		}
		if (mode === 'stale') {
			return { identifier: '2fa-' + value, expiresAtMs: nowMs - 1 };
		}
		return undefined;
	});
	return {
		opened,
		authCalls,
		middleware: authGateway({
			auth: {
				async handler(request) {
					authCalls.push({ url: new URL(request.url).pathname, method: request.method });
					if (request.method === 'POST') {
						return Response.json({ ok: true });
					}
					return Response.json(mode === 'full' ? session({ expired }) : null);
				},
			},
			origin,
			canReadWorkspace: () => true,
			matchesWorkspaceAccount: () => true,
			defaultWorkspaceId: () => defaultWorkspace,
			workspacesOf: () => [{ id: defaultWorkspace, role: 3 }],
			resolveRole: () => 3,
			workspaces: cache,
			resolveChallenge: challenge,
			accountSecurity,
		}, 1024, () => 'en'),
	};
}

function request(mode, path, options = {}) {
	const header = { ...(options.header ?? {}) };
	if (mode === 'half' || mode === 'stale') {
		header.Cookie = challengeCookie + '=2fa-abcdefghijklmnopqrst.signature';
	}
	if (mode === 'forged') {
		header.Cookie = challengeCookie + '=2fa-abcdefghijklmnopqrst.forged';
	}
	if (mode === 'full') {
		header.Cookie = sessionCookie + '=session-token.signature';
	}
	if (options.method && options.method !== 'GET' && options.method !== 'HEAD') {
		header.Origin = origin.origin;
	}
	return makeContext(path, { ...options, header });
}

async function run(gatewayInstance, ctx) {
	await gatewayInstance.middleware(ctx, async () => {});
	return ctx;
}

// --- A1's observable core: the gateway must never mint a session for half auth --

test('A2: the workbench redirects a half-authenticated request to the challenge page', async () => {
	const { middleware } = gateway({ mode: 'half' });
	const ctx = await run({ middleware }, request('half', '/'));
	assert.equal(ctx.status, 303);
	assert.equal(ctx.get('Location'), '/login?twofactor=1');
	assert.equal(ctx.body, undefined, 'no workbench HTML may be produced');
});

test('A3: /api/session answers 403 TwoFactorPending and never reports a remaining time', async () => {
	const { middleware } = gateway({ mode: 'half' });
	const ctx = await run({ middleware }, request('half', '/api/session'));
	assert.equal(ctx.status, 403);
	assert.deepEqual(ctx.body, { error: 'TwoFactorPending' });
	assert.ok(!JSON.stringify(ctx.body).includes('remainingMs'));
});

test('A4: a mounted note path is 403 and no workspace backend is ever opened', async () => {
	const { middleware, opened, authCalls } = gateway({ mode: 'half' });
	const ctx = await run({ middleware }, request('half', '/static/mount/notes/secret.md', { query: { stat: '1' } }));
	assert.equal(ctx.status, 403);
	assert.deepEqual(ctx.body, { error: 'TwoFactorPending' });
	assert.deepEqual(opened, [], 'the storage layer must not be reached at all');
	// get-session is the only authentication call; nothing note-shaped is attempted.
	assert.deepEqual(authCalls.map(call => call.url), ['/api/auth/get-session']);
});

test('A5: the mount root is 403 for half-auth, not a directory listing', async () => {
	const { middleware, opened } = gateway({ mode: 'half' });
	const ctx = await run({ middleware }, request('half', '/static/mount/', { query: { files: '1' } }));
	assert.equal(ctx.status, 403);
	assert.deepEqual(ctx.body, { error: 'TwoFactorPending' });
	assert.deepEqual(opened, []);
});

test('A6: activity cannot renew a half-authenticated request', async () => {
	const { middleware, authCalls } = gateway({ mode: 'half' });
	const ctx = await run({ middleware }, request('half', '/api/session/activity', { method: 'POST' }));
	assert.equal(ctx.status, 403);
	assert.deepEqual(ctx.body, { error: 'TwoFactorPending' });
	// The refresh is a POST to get-session; it must not have happened.
	assert.ok(!authCalls.some(call => call.method === 'POST'), 'the gift of extra idle time must be refused');
});

test('A7: the session client script stays readable while half authenticated', async () => {
	const { middleware } = gateway({ mode: 'half' });
	const ctx = await run({ middleware }, request('half', '/session-client.js'));
	assert.equal(statusOf(ctx), 200);
	assert.match(String(ctx.body), /\/api\/session/);
});

test('A8: authorization precedes parameter validation, so a malformed body is 403 not 400/415', async () => {
	for (const shape of [
		{ header: { 'Content-Type': 'text/plain' }, body: 'not a form at all' },
		{ header: { 'Content-Type': 'application/json' }, body: '{' },
		{ header: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'x'.repeat(4096) },
	]) {
		const { middleware } = gateway({ mode: 'half' });
		const ctx = await run({ middleware }, request('half', '/api/account-security/password', { method: 'POST', ...shape }));
		assert.equal(ctx.status, 403, 'half-auth must be refused before the body is looked at');
		assert.deepEqual(ctx.body, { error: 'TwoFactorPending' });
		assert.deepEqual(ctx.reads, [], 'no content-type negotiation may happen before authorization');
	}
});

test('A9: the device list is not readable while half authenticated', async () => {
	const { middleware } = gateway({ mode: 'half' });
	const ctx = await run({ middleware }, request('half', '/api/account-security/sessions'));
	assert.equal(ctx.status, 403);
	assert.deepEqual(ctx.body, { error: 'TwoFactorPending' });
});

test('A10: a half-authenticated user may abandon the challenge, which clears the cookie', async () => {
	const { middleware } = gateway({ mode: 'half' });
	const ctx = await run({ middleware }, request('half', '/api/session/logout', { method: 'POST' }));
	assert.equal(ctx.status, 200);
	const cleared = cookiesOf(ctx).filter(value => value.startsWith(challengeCookie + '='));
	assert.equal(cleared.length, 1, 'the challenge cookie must be cleared');
	assert.match(cleared[0], /Max-Age=0/i);
});

test('A11: a forged challenge cookie is anonymous, not half', async () => {
	const { middleware } = gateway({ mode: 'forged' });
	const workbench = await run({ middleware }, request('forged', '/'));
	assert.equal(workbench.status, 303);
	assert.equal(workbench.get('Location'), '/login');
	const api = await run({ middleware }, request('forged', '/api/session'));
	assert.equal(api.status, 401);
});

test('A12: an expired challenge is anonymous, not half', async () => {
	const { middleware } = gateway({ mode: 'stale' });
	const ctx = await run({ middleware }, request('stale', '/'));
	assert.equal(ctx.status, 303);
	assert.equal(ctx.get('Location'), '/login', 'an expired challenge must not name the challenge page');
});

test('§5.3: /sync/v1 is a notes surface and is refused while half authenticated', async () => {
	const { middleware } = gateway({ mode: 'half' });
	for (const [method, path] of [['GET', '/sync/v1/changes'], ['POST', '/sync/v1/snapshot'], ['GET', '/sync/v1/snapshot/abc']]) {
		const ctx = await run({ middleware }, request('half', path, { method }));
		assert.equal(ctx.status, 403, method + ' ' + path);
		assert.deepEqual(ctx.body, { error: 'TwoFactorPending' });
	}
});

test('§5.3: the plugin two-factor endpoints are not reachable by an unauthenticated caller', async () => {
	for (const mode of ['anon', 'half']) {
		const { middleware, authCalls } = gateway({ mode });
		const ctx = await run({ middleware }, request(mode, '/api/auth/two-factor/enable', { method: 'POST' }));
		assert.notEqual(ctx.status, 200, mode + ' must not reach the plugin');
		assert.ok(!authCalls.some(call => call.url.startsWith('/api/auth/two-factor')), 'the plugin must not be proxied for ' + mode);
	}
});

test('§5.3: /api/auth/list-sessions is never proxied, even for a full session', async () => {
	const { middleware, authCalls } = gateway({ mode: 'full' });
	const ctx = await run({ middleware }, request('full', '/api/auth/list-sessions'));
	assert.notEqual(ctx.status, 200, 'the raw token endpoint must not be exposed');
	assert.ok(!authCalls.some(call => call.url.includes('list-sessions')));
});

test('a full session still reads notes, so the new gate did not break the happy path', async () => {
	const { middleware, opened } = gateway({ mode: 'full' });
	const ctx = await run({ middleware }, request('full', '/static/mount/note.md', { query: { stat: '1' } }));
	assert.equal(statusOf(ctx), 200);
	assert.deepEqual(ctx.body, { type: 1, label: defaultWorkspace });
	assert.deepEqual(opened, [defaultWorkspace]);
});

test('a full session keeps the remaining idle time and workspace contract', async () => {
	const { middleware } = gateway({ mode: 'full' });
	const ctx = await run({ middleware }, request('full', '/api/session'));
	assert.equal(statusOf(ctx), 200);
	assert.ok(ctx.body.remainingMs > 0);
	assert.equal(ctx.body.workspaceId, defaultWorkspace);
	assert.equal(ctx.body.accountId, user.id);
	assert.deepEqual(ctx.body.workspaces, [{ id: defaultWorkspace, role: 3 }]);
});

test('an anonymous request to the workbench goes to the plain login page', async () => {
	const { middleware } = gateway({ mode: 'anon' });
	const ctx = await run({ middleware }, request('anon', '/'));
	assert.equal(ctx.status, 303);
	assert.equal(ctx.get('Location'), '/login');
});

test('the workbench HTML is only produced for a full session', async () => {
	const { middleware } = gateway({ mode: 'full' });
	const ctx = await run({ middleware }, request('full', '/'));
	assert.equal(statusOf(ctx), 200);
	assert.equal(ctx.state.sessionUserId, user.id);
});

test('half-auth cannot smuggle a workspace choice through the mount header', async () => {
	const { middleware, opened } = gateway({ mode: 'half' });
	const ctx = await run({ middleware }, request('half', '/static/mount/note.md', { header: { [workspaceHeader]: 'log4stellar-main' } }));
	assert.equal(ctx.status, 403);
	assert.deepEqual(opened, []);
});
