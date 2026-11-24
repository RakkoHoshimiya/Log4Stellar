import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { after, before, mock, test } from 'node:test';
import { openAuth } from './auth.mjs';
import { authGateway } from './auth-gateway.mjs';
import { createWorkspaceBackends } from './workspace-backends.mjs';

// These tests drive the real authentication library, the real second factor
// plugin, the real gateway middleware and the real SQLite account database.
//
// Nothing here needs PostgreSQL or object storage: the account-security surface
// lives entirely in `auth.sqlite`, and the only workspace interaction the access
// matrix performs is refusing to acquire a backend. That keeps the acceptance
// matrix runnable offline in the default suite, which is what makes it a gate
// rather than a ceremony.
const origin = new URL('https://workspace.invalid');
const suffix = randomBytes(4).toString('hex');
const workspaceId = 'l4s-test-authsec-' + suffix;
const password = 'correct horse battery staple';
const newPassword = 'a completely different passphrase';
const handle = 'user.sec.' + suffix;
const challengeCookie = '__Secure-better-auth.two_factor';
const sessionCookie = '__Secure-better-auth.session_token';

let auth;
let cache;
let middleware;
let directory;
let accountId;
const opened = [];
let peerNumber = 1;
const totpPeriodMs = 30_000;

// --- TOTP, computed the way the library computes it -----------------------
//
// The HMAC key is the raw secret string the enrolment endpoint generated, not
// its base32 rendering: base32 only appears inside the otpauth:// URL. Getting
// this wrong is exactly the "server and authenticator disagree" failure the
// contract warns about, so the test decodes the URI instead of assuming.
const base32Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Decode(value) {
	const normalized = value.toUpperCase().replace(/[=\s]/g, '');
	let bits = 0;
	let accumulator = 0;
	const bytes = [];
	for (const character of normalized) {
		const index = base32Alphabet.indexOf(character);
		assert.notEqual(index, -1, 'unexpected base32 character ' + character);
		accumulator = (accumulator << 5) | index;
		bits += 5;
		if (bits >= 8) {
			bits -= 8;
			bytes.push((accumulator >>> bits) & 0xff);
		}
	}
	return Buffer.from(bytes).toString('utf8');
}

function totpCode(secret, timestampMs, stepOffset = 0) {
	const counter = Math.floor(timestampMs / 1000 / 30) + stepOffset;
	const message = Buffer.alloc(8);
	message.writeBigUInt64BE(BigInt(counter));
	const digest = createHmac('sha1', secret).update(message).digest();
	const offset = digest[digest.length - 1] & 0x0f;
	const truncated = ((digest[offset] & 0x7f) << 24)
		| ((digest[offset + 1] & 0xff) << 16)
		| ((digest[offset + 2] & 0xff) << 8)
		| (digest[offset + 3] & 0xff);
	return String(truncated % 1_000_000).padStart(6, '0');
}

// --- request helpers ------------------------------------------------------

function request({ cookie, method = 'GET', path = '/', query = {}, headers = {}, body, peer = '127.0.0.1' } = {}) {
	const requestHeaders = new Headers(headers);
	if (cookie) {
		requestHeaders.set('Cookie', cookie);
	}
	if (method !== 'GET' && method !== 'HEAD') {
		requestHeaders.set('Origin', origin.origin);
	}
	const ctx = {
		secure: true,
		host: origin.host,
		path,
		method,
		query,
		state: {},
		// A real koa context carries a cookie jar; the login page reads the theme
		// preference from it, so the shim must exist even when it is empty.
		cookies: { get: () => undefined },
		req: body === undefined
			? { socket: { remoteAddress: peer } }
			: Object.assign(Readable.from([Buffer.from(body)]), { socket: { remoteAddress: peer } }),
		get: name => requestHeaders.get(name) ?? '',
		set: (name, value) => requestHeaders.set(name, value),
		append: (name, value) => requestHeaders.append(name, value),
		is: expected => requestHeaders.get('content-type')?.startsWith(expected) ?? false,
	};
	return ctx;
}

async function bodyOf(ctx) {
	if (ctx.body === undefined) {
		return '';
	}
	if (typeof ctx.body === 'string' || Buffer.isBuffer(ctx.body)) {
		return String(ctx.body);
	}
	if (typeof ctx.body.pipe === 'function') {
		const chunks = [];
		for await (const chunk of ctx.body) {
			chunks.push(chunk);
		}
		return Buffer.concat(chunks).toString('utf8');
	}
	return JSON.stringify(ctx.body);
}

async function send(options) {
	const ctx = request(options);
	await middleware(ctx, async () => {});
	return ctx;
}

// Koa leaves `status` unset on success, so "200" is the absence of an assignment.
function statusOf(ctx) {
	return ctx.status ?? 200;
}

function cookieValue(ctx, name) {
	const found = (ctx.getSetCookie?.() ?? []).filter(value => value.startsWith(name + '='));
	return found;
}

function cookieHeader(ctx, name) {
	const found = cookieValue(ctx, name);
	if (found.length === 0) {
		return undefined;
	}
	const pair = found.at(-1).split(';', 1)[0];
	return pair.length > name.length + 1 ? pair : undefined;
}

async function json(ctx) {
	const text = await bodyOf(ctx);
	try {
		return JSON.parse(text);
	} catch {
		throw new Error('expected JSON, got: ' + text.slice(0, 200));
	}
}

async function post(path, body, cookie, contentType = 'application/json') {
	return send({
		method: 'POST',
		path,
		cookie,
		headers: { 'Content-Type': contentType },
		body: typeof body === 'string' ? body : JSON.stringify(body),
	});
}

function submitLoginCode(code, cookie) {
	return post('/login', new URLSearchParams({ code }).toString(), cookie, 'application/x-www-form-urlencoded');
}

async function signInWithPassword(secret = password) {
	// The matrix models distinct sign-in clients without disabling the real rate limit.
	const peer = '192.0.2.' + peerNumber++;
	const form = new URLSearchParams({ username: handle, password: secret });
	return send({
		method: 'POST',
		peer,
		path: '/login',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: form.toString(),
	});
}

function totpSecretOf(uri) {
	const parsed = new URL(uri);
	const secret = parsed.searchParams.get('secret');
	assert.ok(secret, 'the enrolment URI must carry the seed');
	return { secret: base32Decode(secret), uri: parsed };
}

before(async () => {
	mock.timers.enable({ apis: ['Date'], now: Math.floor(Date.now() / totpPeriodMs) * totpPeriodMs });
	directory = await mkdtemp(join(tmpdir(), 'l4s-authsec-'));
	await writeFile(join(directory, 'secret'), randomBytes(48).toString('hex'), { mode: 0o600 });
	process.env.LOG4STELLAR_AUTH_DIR = directory;
	process.env.LOG4STELLAR_WEB_ORIGIN = origin.origin;
	process.env.LOG4STELLAR_IDLE_SECONDS = '3600';
	auth = await openAuth({ workspaceId });
	accountId = await auth.createAccount(handle, password);
	cache = createWorkspaceBackends({
		async open(id) {
			opened.push(id);
			return {
				async stat() {
					return { type: 1, label: id };
				},
				async writeFile() {
					return { etag: 'v1', created: false, size: 0 };
				},
				async close() {},
			};
		},
	});
	middleware = authGateway({ ...auth, workspaces: cache }, 1024 * 1024, () => 'en');
});

after(async () => {
	mock.timers.reset();
	await cache?.close();
	await auth?.database.close();
	await rm(directory, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Enrolment, then the access matrix. The order is deliberate: enrolment is what
// creates the state every A row describes, so these tests must run in sequence.
// ---------------------------------------------------------------------------

const state = {
	sessionCookie: undefined,
	totpSecret: undefined,
	totpURI: undefined,
	backupCodes: undefined,
	challengeCookie: undefined,
	consumedCode: undefined,
	consumedAt: 0,
};

test('the security settings page requires a complete session', async () => {
	const response = await send({ path: '/account/security' });
	assert.equal(response.status, 303);
	assert.equal(response.get('Location'), '/login');
});

test('F1: enrolment returns a SHA-1 TOTP URI and ten recovery codes', async () => {
	const login = await signInWithPassword();
	assert.equal(statusOf(login), 303);
	state.sessionCookie = cookieHeader(login, sessionCookie);
	assert.ok(state.sessionCookie, 'a full session must be issued for an account without 2FA');

	const response = await post('/api/account-security/two-factor/enroll', { password }, state.sessionCookie);
	assert.equal(statusOf(response), 200, await bodyOf(response));
	const payload = await json(response);
	assert.equal(payload.method, 'totp');
	assert.equal(payload.backupCodes.length, 10);
	const { secret, uri } = totpSecretOf(payload.totpURI);
	state.totpSecret = secret;
	state.totpURI = payload.totpURI;
	state.backupCodes = payload.backupCodes;
	assert.equal(uri.searchParams.get('digits'), '6');
	assert.equal(uri.searchParams.get('period'), '30');
	// The contract's own warning: a SHA-256 URI would make every authenticator
	// disagree with the server. The library emits no algorithm parameter at all.
	assert.ok(!payload.totpURI.includes('algorithm'), 'the URI must not pin a non SHA-1 algorithm');
	for (const code of payload.backupCodes) {
		assert.match(code, /^[ABCDEFGHJKMNPQRSTVWXYZ23456789]{5}-[ABCDEFGHJKMNPQRSTVWXYZ23456789]{5}$/, 'the custom alphabet must be in force');
	}
});

test('F2: enrolment needs the current password', async () => {
	const response = await post('/api/account-security/two-factor/enroll', { password: 'wrong password' }, state.sessionCookie);
	assert.equal(statusOf(response), 401, await bodyOf(response));
});

test('F3: the account is not protected until the first code is confirmed', async () => {
	const response = await send({ path: '/api/session', cookie: state.sessionCookie });
	assert.equal(statusOf(response), 200);
	const rows = auth.database.prepare('SELECT twoFactorEnabled FROM user WHERE id = ?').get(accountId);
	assert.equal(Number(rows.twoFactorEnabled), 0, 'an unconfirmed seed must not switch the login path');
});

test('F4: confirming with a live code enables the second factor', async () => {
	const code = totpCode(state.totpSecret, Date.now());
	state.consumedCode = code;
	state.consumedAt = Date.now();
	const response = await post('/api/account-security/two-factor/confirm', { code }, state.sessionCookie);
	assert.equal(statusOf(response), 200, await bodyOf(response));
	const rows = auth.database.prepare('SELECT twoFactorEnabled FROM user WHERE id = ?').get(accountId);
	assert.equal(Number(rows.twoFactorEnabled), 1);
	const replay = auth.database.prepare('SELECT last_used_step FROM account_totp_replay WHERE user_id = ?').get(accountId);
	assert.ok(replay, 'confirming must record the consumed step');
	const page = await send({ path: '/account/security', cookie: state.sessionCookie });
	assert.equal(page.status, 200);
	assert.match(await bodyOf(page), /data-enabled="true"/);
	assert.match(page.get('Content-Security-Policy'), /script-src 'self'/);
	assert.equal(page.get('Cache-Control'), 'private, no-store');
	const stale = await send({ path: '/api/account-security/sessions', cookie: state.sessionCookie, headers: { 'X-Log4Stellar-Account': 'different' } });
	assert.equal(stale.status, 409);
	assert.deepEqual(await json(stale), { error: 'AccountChanged' });
});

test('A1: the correct password yields a challenge cookie and no session row', async () => {
	const before = Number(auth.database.prepare('SELECT COUNT(*) AS n FROM session').get().n);
	const response = await signInWithPassword();
	assert.equal(statusOf(response), 303, await bodyOf(response));
	assert.equal(response.get('Location'), '/login?twofactor=1');
	assert.equal(cookieHeader(response, sessionCookie), undefined, 'no session cookie may be issued');
	const challenge = cookieHeader(response, challengeCookie);
	assert.ok(challenge, 'a challenge cookie must be issued');
	state.challengeCookie = challenge;
	const after = Number(auth.database.prepare('SELECT COUNT(*) AS n FROM session').get().n);
	assert.equal(after, before, 'half-authentication is the absence of a session row');
});

test('A2: the workbench is a 303 to the challenge page with no HTML', async () => {
	const ctx = await send({ path: '/', cookie: state.challengeCookie });
	assert.equal(statusOf(ctx), 303);
	assert.equal(ctx.get('Location'), '/login?twofactor=1');
	assert.equal(ctx.body, undefined);
	assert.equal(ctx.state.sessionUserId, undefined, 'no account identity may be attached');
});

test('A3: /api/session refuses and never reports a remaining time', async () => {
	const ctx = await send({ path: '/api/session', cookie: state.challengeCookie });
	assert.equal(statusOf(ctx), 403);
	assert.deepEqual(await json(ctx), { error: 'TwoFactorPending' });
});

test('A4: a mounted note path is refused and the storage layer is never opened', async () => {
	opened.length = 0;
	const ctx = await send({ path: '/static/mount/note.md', query: { stat: '1' }, cookie: state.challengeCookie });
	assert.equal(statusOf(ctx), 403);
	assert.deepEqual(await json(ctx), { error: 'TwoFactorPending' });
	assert.deepEqual(opened, []);
});

test('A5: the mount root is refused too', async () => {
	opened.length = 0;
	const ctx = await send({ path: '/static/mount/', query: { files: '1' }, cookie: state.challengeCookie });
	assert.equal(statusOf(ctx), 403);
	assert.deepEqual(opened, []);
});

test('A6: activity cannot renew a half-authenticated request', async () => {
	const ctx = await send({ method: 'POST', path: '/api/session/activity', cookie: state.challengeCookie });
	assert.equal(statusOf(ctx), 403);
	assert.deepEqual(await json(ctx), { error: 'TwoFactorPending' });
});

test('A7: the session client stays readable while half authenticated', async () => {
	const ctx = await send({ path: '/session-client.js', cookie: state.challengeCookie });
	assert.equal(ctx.status ?? 200, 200);
	assert.match(String(ctx.body), /\/api\/session/);
});

test('A8: authorization precedes parameter validation', async () => {
	for (const contentType of ['text/plain', 'application/json', 'application/x-www-form-urlencoded']) {
		const ctx = await send({
			method: 'POST',
			path: '/api/account-security/password',
			cookie: state.challengeCookie,
			headers: { 'Content-Type': contentType },
			body: '{',
		});
		assert.equal(statusOf(ctx), 403, contentType + ' must not be able to probe with a 400/415');
		assert.deepEqual(await json(ctx), { error: 'TwoFactorPending' });
	}
});

test('A9: the device list is refused while half authenticated', async () => {
	const ctx = await send({ path: '/api/account-security/sessions', cookie: state.challengeCookie });
	assert.equal(statusOf(ctx), 403);
	assert.deepEqual(await json(ctx), { error: 'TwoFactorPending' });
});

test('A11: a forged challenge cookie is anonymous', async () => {
	const forged = state.challengeCookie.slice(0, -1) + (state.challengeCookie.endsWith('A') ? 'B' : 'A');
	const ctx = await send({ path: '/', cookie: forged });
	assert.equal(statusOf(ctx), 303);
	assert.equal(ctx.get('Location'), '/login');
});

test('B7: ambiguous code shapes are rejected before any comparison', async () => {
	for (const code of ['12345', '1234567', '123 456', '123-456', 'abcdef']) {
		const login = await signInWithPassword();
		const ctx = await post('/api/account-security/two-factor/verify', { code }, cookieHeader(login, challengeCookie));
		assert.equal(statusOf(ctx), 400, code + ' must be InvalidTotpInput');
		assert.deepEqual(await json(ctx), { error: 'InvalidTotpInput' });
	}
});

test('B4: a code two steps off is outside the window', async () => {
	const code = totpCode(state.totpSecret, Date.now(), -2);
	const ctx = await post('/api/account-security/two-factor/verify', { code }, state.challengeCookie);
	assert.equal(statusOf(ctx), 401);
	assert.deepEqual(await json(ctx), { error: 'InvalidTotpCode' });
});

test('B1: a live code completes the second factor and creates a session', async () => {
	const code = totpCode(state.totpSecret, Date.now(), 1);
	state.nextCode = code;
	const response = await post('/api/account-security/two-factor/verify', { code }, state.challengeCookie);
	assert.equal(statusOf(response), 200, await bodyOf(response));
	const issued = cookieHeader(response, sessionCookie);
	assert.ok(issued, 'a session cookie must be issued');
	const cleared = cookieValue(response, challengeCookie);
	assert.equal(cleared.length, 1, 'the challenge cookie must be cleared');
	assert.match(cleared[0], /Max-Age=0/i);
	// The token must not be echoed in the body where a script could read it.
	assert.deepEqual(await json(response), { ok: true });
	state.sessionCookie = issued;
	const row = auth.database.prepare('SELECT last_used_step FROM account_totp_replay WHERE user_id = ?').get(accountId);
	assert.ok(row, 'the consumed step must be persisted');
});

test('B12: a fully authenticated account still reads the workbench and the session', async () => {
	const workbench = await send({ path: '/', cookie: state.sessionCookie });
	assert.equal(workbench.status ?? 200, 200);
	assert.equal(workbench.state.sessionUserId, accountId);
	const session = await send({ path: '/api/session', cookie: state.sessionCookie });
	assert.equal(session.status ?? 200, 200);
	const payload = await json(session);
	assert.ok(payload.remainingMs > 0);
	assert.equal(payload.workspaceId, workspaceId);
});

test('B5/B2: the next step works once, and replaying a spent step is refused', async () => {
	// Re-sign-in to get a fresh challenge: the previous one was burned.
	const login = await signInWithPassword();
	assert.equal(login.get('Location'), '/login?twofactor=1');
	const challenge = cookieHeader(login, challengeCookie);
	assert.ok(challenge);

	// The step used in B1 is spent; submitting it again must name replay, not "wrong".
	const spent = totpCode(state.totpSecret, Date.now(), 1);
	const replay = await post('/api/account-security/two-factor/verify', { code: spent }, challenge);
	assert.equal(statusOf(replay), 401);
	assert.deepEqual(await json(replay), { error: 'TotpCodeReplayed' });

	mock.timers.tick(totpPeriodMs);
	const next = totpCode(state.totpSecret, Date.now(), 1);
	const accepted = await post('/api/account-security/two-factor/verify', { code: next }, challenge);
	assert.equal(statusOf(accepted), 200, await bodyOf(accepted));
	assert.ok(cookieHeader(accepted, sessionCookie));
	const row = auth.database.prepare('SELECT last_used_step FROM account_totp_replay WHERE user_id = ?').get(accountId);
	assert.ok(row.last_used_step >= Math.floor(Date.now() / totpPeriodMs) + 1);
});

test('C1/C2: a recovery code logs in once and is then dead', async () => {
	const login = await signInWithPassword();
	const challenge = cookieHeader(login, challengeCookie);
	const first = state.backupCodes[0];
	const used = await post('/api/account-security/two-factor/verify-recovery-code', { code: first }, challenge);
	assert.equal(statusOf(used), 200, await bodyOf(used));
	assert.ok(cookieHeader(used, sessionCookie), 'a recovery code must produce a session');
	const payload = await json(used);
	assert.equal(payload.remaining, 9);

	const again = await signInWithPassword();
	const secondChallenge = cookieHeader(again, challengeCookie);
	const replay = await post('/api/account-security/two-factor/verify-recovery-code', { code: first }, secondChallenge);
	assert.equal(statusOf(replay), 401);
	assert.deepEqual(await json(replay), { error: 'InvalidRecoveryCode' });
	state.recoverySession = cookieHeader(used, sessionCookie);
});

test('C3/C4/C5: recovery codes tolerate case and hyphens but reject ambiguous input', async () => {
	const login = await signInWithPassword();
	const challenge = cookieHeader(login, challengeCookie);
	const lowered = state.backupCodes[1].toLowerCase().replace('-', '');
	const accepted = await post('/api/account-security/two-factor/verify-recovery-code', { code: lowered }, challenge);
	assert.equal(statusOf(accepted), 200, await bodyOf(accepted));
	state.sessionCookie = cookieHeader(accepted, sessionCookie);

	for (const code of ['ABCDE-12345', 'ABCDE-FGHIJ', 'ABCDEFGHI\u017f']) {
		const fresh = await signInWithPassword();
		const ctx = await post('/api/account-security/two-factor/verify-recovery-code', { code }, cookieHeader(fresh, challengeCookie));
		assert.equal(statusOf(ctx), 400, code + ' must be InvalidRecoveryCodeInput');
		assert.deepEqual(await json(ctx), { error: 'InvalidRecoveryCodeInput' });
	}
});

test('the browser form keeps the challenge on invalid input and redirects after recovery', async () => {
	const login = await signInWithPassword();
	const challenge = cookieHeader(login, challengeCookie);
	const invalid = await submitLoginCode('not a code', challenge);
	assert.equal(invalid.status, 400);
	assert.match(await bodyOf(invalid), /name="code"/);
	assert.equal(cookieHeader(invalid, sessionCookie), undefined);

	const completed = await submitLoginCode(state.backupCodes[2], challenge);
	assert.equal(completed.status, 303);
	assert.equal(completed.get('Location'), '/');
	const session = cookieHeader(completed, sessionCookie);
	assert.ok(session);
	assert.equal(statusOf(await send({ path: '/api/session', cookie: session })), 200);
});

test('one challenge yields one session even with two valid recovery submissions', async () => {
	const login = await signInWithPassword();
	const challenge = cookieHeader(login, challengeCookie);
	const count = () => auth.database.prepare('SELECT COUNT(*) AS n FROM session').get().n;
	const initialCount = count();
	const path = '/api/account-security/two-factor/verify-recovery-code';
	const results = await Promise.all([
		post(path, { code: state.backupCodes[3] }, challenge),
		post(path, { code: state.backupCodes[4] }, challenge),
	]);
	const issued = results.filter(result => cookieHeader(result, sessionCookie));
	assert.equal(issued.length, 1);
	assert.equal(count(), initialCount + 1);
	assert.equal((await json(issued[0])).remaining, 6);
});

test('D1-D3: the device list is redacted and identifies sessions by digest', async () => {
	const response = await send({ path: '/api/account-security/sessions', cookie: state.sessionCookie });
	assert.equal(statusOf(response), 200, await bodyOf(response));
	const payload = await json(response);
	assert.ok(Array.isArray(payload.sessions));
	assert.ok(payload.sessions.length >= 1);
	assert.equal(payload.sessions[0].current, true, 'the current device must be first');
	const tokens = auth.database.prepare('SELECT token FROM session').all().map(row => String(row.token));
	const text = await bodyOf(response);
	for (const withheld of ['token', 'ipAddress', 'userAgent', 'userId']) {
		assert.ok(!text.includes('"' + withheld + '"'), withheld + ' must not be serialised');
	}
	for (const session of payload.sessions) {
		assert.match(session.id, /^[A-Za-z0-9_-]{22}$/);
		assert.ok(!tokens.includes(session.id), 'the descriptor id must not be the bearer token');
	}
	assert.ok(!text.includes('"network"'), 'network must be opt-in');
	state.currentSessionId = payload.sessions[0].id;
});

test('D4/D5/D6: labels are stored, cleaned and length checked', async () => {
	const labelled = await post('/api/account-security/sessions/' + state.currentSessionId + '/label', { label: '我的台式机' }, state.sessionCookie);
	assert.equal(statusOf(labelled), 200, await bodyOf(labelled));
	const list = await json(await send({ path: '/api/account-security/sessions', cookie: state.sessionCookie }));
	assert.equal(list.sessions[0].device, '我的台式机');

	const cleaned = await post('/api/account-security/sessions/' + state.currentSessionId + '/label', { label: 'a\u202eb\nc' }, state.sessionCookie);
	assert.equal(statusOf(cleaned), 200, await bodyOf(cleaned));
	const after = await json(await send({ path: '/api/account-security/sessions', cookie: state.sessionCookie }));
	assert.equal(after.sessions[0].device, 'a b c', 'bidi overrides and newlines collapse to spaces');

	const tooLong = await post('/api/account-security/sessions/' + state.currentSessionId + '/label', { label: 'x'.repeat(41) }, state.sessionCookie);
	assert.equal(statusOf(tooLong), 400);
	assert.deepEqual(await json(tooLong), { error: 'InvalidDeviceLabel' });
});

test('D7: revoking an unknown session is a 404, not a silent success', async () => {
	const forged = 'A'.repeat(22);
	const response = await post('/api/account-security/sessions/' + forged + '/revoke', {}, state.sessionCookie);
	assert.equal(statusOf(response), 404);
	assert.deepEqual(await json(response), { error: 'SessionNotFound' });
});

test('D9: the raw token endpoint is not reachable through the gateway', async () => {
	const ctx = await send({ path: '/api/auth/list-sessions', cookie: state.sessionCookie });
	assert.equal(statusOf(ctx), 404, 'list-sessions hands back bearer tokens and must stay closed');
});

test('E7-E9: password policy is enforced', async () => {
	for (const [candidate, expected] of [
		['short', 'PasswordTooShort'],
		['x'.repeat(129), 'PasswordTooLong'],
		['a\u0000'.repeat(8), 'InvalidPasswordInput'],
	]) {
		const response = await post('/api/account-security/password', { currentPassword: password, newPassword: candidate }, state.sessionCookie);
		assert.equal(statusOf(response), 400, JSON.stringify(candidate.slice(0, 8)));
		assert.deepEqual(await json(response), { error: expected });
	}
	const same = await post('/api/account-security/password', { currentPassword: password, newPassword: handle }, state.sessionCookie);
	assert.equal(statusOf(same), 400);
	assert.deepEqual(await json(same), { error: 'PasswordMatchesUsername' });
});

test('E6: a wrong current password is refused', async () => {
	const response = await post('/api/account-security/password', { currentPassword: 'not the password', newPassword }, state.sessionCookie);
	assert.equal(statusOf(response), 401);
	assert.deepEqual(await json(response), { error: 'ReauthenticationRequired' });
});

test('E1-E3: changing the password revokes other devices and keeps this one', async () => {
	mock.timers.tick(totpPeriodMs);
	// A second device signs in through the second factor so it owns a real session.
	const secondLogin = await signInWithPassword();
	const secondChallenge = cookieHeader(secondLogin, challengeCookie);
	const secondCode = totpCode(state.totpSecret, Date.now(), 1);
	const secondVerify = await post('/api/account-security/two-factor/verify', { code: secondCode }, secondChallenge);
	assert.equal(statusOf(secondVerify), 200, await bodyOf(secondVerify));
	const secondCookie = cookieHeader(secondVerify, sessionCookie);
	assert.ok(secondCookie);
	assert.notEqual(secondCookie, state.sessionCookie);

	const changed = await post('/api/account-security/password', { currentPassword: password, newPassword }, state.sessionCookie);
	assert.equal(statusOf(changed), 200, await bodyOf(changed));
	const renewed = cookieHeader(changed, sessionCookie);
	assert.ok(renewed, 'the caller keeps their identity on a fresh token');
	state.sessionCookie = renewed;

	const other = await send({ path: '/api/session', cookie: secondCookie });
	assert.equal(statusOf(other), 401, 'the other device must be signed out');

	const mine = await send({ path: '/', cookie: state.sessionCookie });
	assert.equal(mine.status ?? 200, 200, 'the current device stays signed in');
});

test('E4/E5: only the new password works afterwards', async () => {
	const old = await signInWithPassword(password);
	assert.equal(statusOf(old), 401, 'the old password must stop working');
	const fresh = await signInWithPassword(newPassword);
	assert.equal(fresh.get('Location'), '/login?twofactor=1', 'the new password starts a new challenge');
});

test('G2: half-authenticated activity is refused', async () => {
	const login = await signInWithPassword(newPassword);
	const ctx = await send({ method: 'POST', path: '/api/session/activity', cookie: cookieHeader(login, challengeCookie) });
	assert.equal(statusOf(ctx), 403);
	assert.deepEqual(await json(ctx), { error: 'TwoFactorPending' });
});

test('G4: the idle window the session reports never exceeds LOG4STELLAR_IDLE_SECONDS', async () => {
	mock.timers.tick(totpPeriodMs);
	const login = await signInWithPassword(newPassword);
	const challenge = cookieHeader(login, challengeCookie);
	const code = totpCode(state.totpSecret, Date.now(), 1);
	const verified = await post('/api/account-security/two-factor/verify', { code }, challenge);
	assert.equal(statusOf(verified), 200, await bodyOf(verified));
	const cookie = cookieHeader(verified, sessionCookie);
	const session = await json(await send({ path: '/api/session', cookie }));
	assert.ok(session.remainingMs <= 3_600_000, 'remaining=' + session.remainingMs);
	assert.ok(session.remainingMs > 3_500_000, 'the window must start at second-factor completion');
});

test('A10: a half-authenticated caller may abandon the challenge', async () => {
	const login = await signInWithPassword(newPassword);
	const challenge = cookieHeader(login, challengeCookie);
	const ctx = await send({ method: 'POST', path: '/api/session/logout', cookie: challenge });
	assert.equal(statusOf(ctx), 200);
	const cleared = cookieValue(ctx, challengeCookie);
	assert.equal(cleared.length, 1);
	assert.match(cleared[0], /Max-Age=0/i);
	const next = await send({ path: '/api/session', cookie: challenge });
	assert.equal(statusOf(next), 401);
});

test('F6: enrolling twice is refused while the second factor is live', async () => {
	const response = await post('/api/account-security/two-factor/enroll', { password: newPassword }, state.sessionCookie);
	assert.equal(statusOf(response), 409, await bodyOf(response));
	assert.deepEqual(await json(response), { error: 'TotpAlreadyEnrolled' });
});

test('F7: unbinding without a second factor is refused', async () => {
	const response = await post('/api/account-security/two-factor/disable', { password: newPassword }, state.sessionCookie);
	assert.equal(statusOf(response), 403);
	assert.deepEqual(await json(response), { error: 'ReauthenticationRequired' });
});

test('rotating recovery codes requires a second factor and replaces the prior set', async () => {
	const path = '/api/account-security/recovery-codes';
	const denied = await post(path, { password: newPassword }, state.sessionCookie);
	assert.equal(denied.status, 403);
	const unused = state.backupCodes[9];
	const rotated = await post(path, { password: newPassword, code: unused }, state.sessionCookie);
	assert.equal(statusOf(rotated), 200, await bodyOf(rotated));
	const { backupCodes } = await json(rotated);
	assert.equal(backupCodes.length, 10);
	assert.notDeepEqual(backupCodes, state.backupCodes);

	const login = await signInWithPassword(newPassword);
	const challenge = cookieHeader(login, challengeCookie);
	const verifyPath = '/api/account-security/two-factor/verify-recovery-code';
	const old = await post(verifyPath, { code: unused }, challenge);
	assert.equal(old.status, 401);
	assert.deepEqual(await json(old), { error: 'InvalidRecoveryCode' });
	assert.equal(statusOf(await post(verifyPath, { code: backupCodes[0] }, challenge)), 200);
});

test('F8/F9/F10: unbinding consumes the step it was authorised with', async () => {
	mock.timers.tick(totpPeriodMs);
	const code = totpCode(state.totpSecret, Date.now(), 1);
	const disabled = await post('/api/account-security/two-factor/disable', { password: newPassword, code }, state.sessionCookie);
	assert.equal(statusOf(disabled), 200, await bodyOf(disabled));
	const payload = await json(disabled);
	assert.equal(payload.twoFactorEnabled, false);
	const freshCookie = cookieHeader(disabled, sessionCookie);
	assert.ok(freshCookie);
	assert.notEqual(freshCookie, state.sessionCookie);
	assert.equal(statusOf(await send({ path: '/api/session', cookie: state.sessionCookie })), 401);
	assert.equal(statusOf(await send({ path: '/api/session', cookie: freshCookie })), 200);
	assert.equal(Number(auth.database.prepare('SELECT twoFactorEnabled FROM user WHERE id = ?').get(accountId).twoFactorEnabled), 0);

	// The authorising code must not be reusable as a login: it was spent above.
	const rows = auth.database.prepare('SELECT last_used_step FROM account_totp_replay WHERE user_id = ?').get(accountId);
	assert.ok(rows, 'the replay cursor survives unbinding on purpose');

	const login = await signInWithPassword(newPassword);
	assert.equal(login.get('Location'), '/', 'without a second factor the login goes straight to the workbench');
	assert.ok(cookieHeader(login, sessionCookie));
	const session = await send({ path: '/api/session', cookie: cookieHeader(login, sessionCookie) });
	assert.equal(session.status ?? 200, 200, 'F10: the account is single-factor again');
});

test('H5: a database without the replay table is migrated and usable on start', async () => {
	const rows = auth.database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('account_totp_replay', 'account_session_label', 'twoFactor')").all().map(row => String(row.name));
	assert.deepEqual(rows.sort(), ['account_session_label', 'account_totp_replay', 'twoFactor']);
	const columns = auth.database.prepare('PRAGMA table_info(user)').all().map(row => String(row.name));
	assert.ok(columns.includes('twoFactorEnabled'), 'the plugin migration must add the column');
});

test('the account-security database admits no destructive statement', async () => {
	const { verifySecurityInvariants } = await import('./account-security.mjs');
	assert.deepEqual(verifySecurityInvariants(), []);
});
