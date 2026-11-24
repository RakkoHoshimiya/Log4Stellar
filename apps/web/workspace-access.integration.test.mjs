import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { after, before, test } from 'node:test';
import { Pool } from 'pg';
import { openAuth } from './auth.mjs';
import { authGateway, workspaceHeader } from './auth-gateway.mjs';
import { openDirectoryBlobs } from './test-support/directory-blobs.mjs';
import { workspaceRoles } from './workspace-access.mjs';
import { createWorkspaceBackends } from './workspace-backends.mjs';

// These tests drive the real authentication library, the real gateway middleware and
// the real PostgreSQL storage layer. They are opt-in so the default suite stays fast
// and offline: LOG4STELLAR_IT=1 node --test apps/web/*.test.mjs
//
// Requirements (see the delivery notes): LOG4STELLAR_STORAGE_CONFIG must point at a
// copy of the storage JSON whose directory is writable, because the blob spool is
// derived from it. Object bytes always go to directory-backed test blobs, never to
// the shared bucket.
const enabled = process.env.LOG4STELLAR_IT === '1';
const skip = enabled ? false : 'set LOG4STELLAR_IT=1 to run the PostgreSQL integration tests';
const origin = new URL('https://workspace.invalid');
const suffix = randomBytes(4).toString('hex');
const workspaceA = 'l4s-test-a-' + suffix;
const workspaceB = 'l4s-test-b-' + suffix;
const password = 'correct horse battery staple';
// The authentication library restricts usernames to letters, digits, dots and
// underscores, so the account handles cannot reuse the workspace ID shape.
const handleA = 'user.a.' + suffix;
const handleB = 'user.b.' + suffix;
const markerA = 'A-CONTENT-' + randomUUID();
const markerB = 'B-CONTENT-' + randomUUID();
const markerTrash = 'B-TRASHED-CONTENT-' + randomUUID();
const trashId = randomUUID();

let auth;
let storage;
let settings;
let cache;
let middleware;
let directory;
let ownerA;
let outsider;
let bFile;
let bRevision;
let bFileId;

function mount({ cookie, workspace, method = 'GET', path = '/', query = {}, headers = {}, body }) {
	const requestHeaders = new Headers(headers);
	if (cookie) {
		requestHeaders.set('Cookie', cookie);
	}
	if (workspace) {
		requestHeaders.set(workspaceHeader, workspace);
	}
	if (method !== 'GET' && method !== 'HEAD') {
		requestHeaders.set('Origin', origin.origin);
	}
	const ctx = {
		secure: true,
		host: origin.host,
		path: '/static/mount' + path,
		method,
		query,
		state: {},
		req: body === undefined ? { socket: { remoteAddress: '127.0.0.1' } } : Object.assign(Readable.from([Buffer.from(body)]), { socket: { remoteAddress: '127.0.0.1' } }),
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

// The sign-in endpoint is rate limited, so each account signs in at most once and
// the resulting cookie is reused, exactly as a browser would.
const cookies = new Map();

async function signIn(username) {
	const cached = cookies.get(username);
	if (cached !== undefined) {
		return cached;
	}
	const response = await auth.auth.handler(new Request(new URL('/api/auth/sign-in/username', origin), {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Origin: origin.origin, 'x-log4stellar-peer': '127.0.0.1' },
		body: JSON.stringify({ username, password }),
	}));
	assert.equal(response.status, 200, await response.text());
	const cookie = response.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ');
	cookies.set(username, cookie);
	return cookie;
}

async function assertForbidden(response, secrets) {
	assert.equal(response.status, 403, 'expected 403, body was ' + JSON.stringify(response.body));
	assert.deepEqual(response.body, { error: 'NoPermissions' });
	const text = await bodyOf({ body: response.body });
	for (const secret of secrets) {
		assert.ok(!text.includes(secret), 'the response leaked workspace content');
	}
}

before(async () => {
	if (!enabled) {
		return;
	}
	const configPath = process.env.LOG4STELLAR_STORAGE_CONFIG;
	assert.ok(configPath, 'LOG4STELLAR_STORAGE_CONFIG must point at the storage configuration');
	settings = JSON.parse(await readFile(configPath, 'utf8'));
	storage = new Pool({ connectionTimeoutMillis: 5000, max: 4, ...settings.postgres });

	directory = await mkdtemp(join(tmpdir(), 'l4s-auth-'));
	await writeFile(join(directory, 'secret'), randomBytes(48).toString('hex'), { mode: 0o600 });
	process.env.LOG4STELLAR_AUTH_DIR = directory;
	process.env.LOG4STELLAR_WEB_ORIGIN = origin.origin;
	process.env.LOG4STELLAR_IDLE_SECONDS = '600';
	auth = await openAuth({ workspaceId: workspaceA });

	// Build two independent workspaces with real PostgreSQL metadata and
	// directory-backed blobs, exactly as a deployment would after an import.
	const seed = await mkdtemp(join(tmpdir(), 'l4s-seed-'));
	const seedA = join(seed, 'a');
	const seedB = join(seed, 'b');
	await mkdir(seedA);
	await mkdir(seedB);
	await writeFile(join(seedA, 'note-a.md'), '# ' + markerA);
	await writeFile(join(seedB, 'secret-b.md'), '# ' + markerB);
	await writeFile(join(seedB, 'tossed-b.md'), '# ' + markerTrash);
	const { openRustfsWorkspace } = await import('./rustfs-workspace.mjs');
	for (const [id, root] of [[workspaceA, seedA], [workspaceB, seedB]]) {
		const importer = await openRustfsWorkspace(id, { importing: true, createBlobs: openDirectoryBlobs });
		await importer.importDirectory(root, 1024 * 1024);
		await importer.close();
	}
	await rm(seed, { recursive: true, force: true });

	const bBackend = await openRustfsWorkspace(workspaceB, { createBlobs: openDirectoryBlobs });
	bFile = await bBackend.stat('/secret-b.md');
	bRevision = (await bBackend.listVersions('/secret-b.md'))[0].id;
	await bBackend.delete('/tossed-b.md', false, trashId);
	assert.equal((await bBackend.listTrash()).length, 1);
	await bBackend.close();
	bFileId = bFile.etag.slice(1, -1);

	ownerA = await auth.createAccount(handleA, password);
	outsider = await auth.createAccount(handleB, password);
	assert.equal(auth.resolveRole(ownerA, workspaceA), workspaceRoles.owner);
	assert.equal(auth.resolveRole(outsider, workspaceB), undefined, 'the outsider must not be a member of B');

	cache = createWorkspaceBackends({
		open: id => openRustfsWorkspace(id, { createBlobs: openDirectoryBlobs }),
	});
	middleware = authGateway({ ...auth, workspaces: cache }, 1024 * 1024, () => 'en');
});

after(async () => {
	if (!enabled) {
		return;
	}
	await cache?.close();
	// The test account fixture only ever touches rows for its own temporary workspaces.
	// The incremental-sync tables are new in this release and reference storage_workspaces,
	// so they have to go first. The five original tables keep their schema untouched.
	for (const table of [
		'storage_snapshot_entries', 'storage_snapshots', 'storage_changes', 'storage_change_heads',
		'storage_trash_entries', 'storage_trash', 'storage_file_versions', 'storage_entries',
	]) {
		const column = table === 'storage_trash_entries'
			? 'trash_id IN (SELECT id FROM log4stellar.storage_trash WHERE workspace_id = ANY($1::text[]))'
			: table === 'storage_snapshot_entries'
				? 'snapshot_id IN (SELECT id FROM log4stellar.storage_snapshots WHERE workspace_id = ANY($1::text[]))'
				: 'workspace_id = ANY($1::text[])';
		await storage.query('DELETE FROM log4stellar.' + table + ' WHERE ' + column, [[workspaceA, workspaceB]]);
	}
	await storage.query('DELETE FROM log4stellar.storage_workspaces WHERE id = ANY($1::text[])', [[workspaceA, workspaceB]]);
	await storage.end();
	await rm(join(storageSpoolDirectory(), 'test-blobs', workspaceA), { recursive: true, force: true });
	await rm(join(storageSpoolDirectory(), 'test-blobs', workspaceB), { recursive: true, force: true });
	await auth?.database.close();
	await rm(directory, { recursive: true, force: true });
});

function storageSpoolDirectory() {
	return join(dirname(process.env.LOG4STELLAR_STORAGE_CONFIG), 'spool');
}

test('a member reads their own workspace through the gateway', { skip }, async () => {
	const cookie = await signIn(handleA);
	const ctx = mount({ cookie, workspace: workspaceA, path: '/note-a.md' });
	await middleware(ctx, async () => {});
	assert.equal(ctx.status, 200);
	assert.match(await bodyOf(ctx), new RegExp(markerA));
	assert.equal(ctx.state.workspaceId, workspaceA);
	assert.equal(ctx.state.workspaceRole, workspaceRoles.owner);
});

test('another workspace ID is 403 and never leaks its contents (contract §6)', { skip }, async () => {
	const cookie = await signIn(handleB);
	const requests = [
		{ method: 'GET', path: '/secret-b.md' },
		{ method: 'GET', path: '/secret-b.md', query: { revision: bRevision } },
		{ method: 'GET', path: '/secret-b.md', query: { versions: '1' } },
		{ method: 'GET', path: '/', query: { trash: '1' } },
		{ method: 'GET', path: '/', query: { files: '1', pattern: 'secret' } },
		{ method: 'GET', path: '/secret-b.md', query: { stat: '1' } },
		{ method: 'DELETE', path: '/secret-b.md', query: { trashId: randomUUID() } },
		{ method: 'POST', path: '/', query: { restoreTrash: trashId, keepBoth: '0' } },
		{ method: 'POST', path: '/', query: { restoreTrashBatch: '1' }, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify([trashId]) },
		{ method: 'POST', path: '/secret-b.md', query: { restoreVersion: bRevision }, headers: { 'If-Match': bFile.etag } },
		{ method: 'PUT', path: '/injected.md', headers: { 'Content-Type': 'application/octet-stream' }, body: markerB },
	];
	for (const request of requests) {
		const ctx = mount({ cookie, workspace: workspaceB, ...request });
		await middleware(ctx, async () => {});
		await assertForbidden(ctx, [markerB, markerTrash, bFileId, bRevision, trashId]);
	}
	// The metadata queries above must not have changed B: it is still intact.
	const { openRustfsWorkspace } = await import('./rustfs-workspace.mjs');
	const probe = await openRustfsWorkspace(workspaceB, { createBlobs: openDirectoryBlobs });
	try {
		assert.equal((await probe.stat('/secret-b.md')).etag, bFile.etag);
		assert.equal((await probe.listTrash()).length, 1);
		// The rejected batch restore must not have removed the trashed entry either.
		assert.equal((await probe.readDirectory('/')).length, 1);
	} finally {
		await probe.close();
	}
});

test('the login gate no longer decides per-workspace access', { skip }, async () => {
	// The outsider is a member of workspace A only, so the login gate must accept the
	// session while the workspace-scoped decision rejects workspace B.
	assert.equal(auth.canReadWorkspace(outsider), true);
	const cookie = await signIn(handleB);
	const permitted = mount({ cookie, workspace: workspaceA, path: '/note-a.md' });
	await middleware(permitted, async () => {});
	assert.equal(permitted.status, 200);
	assert.equal((await bodyOf(permitted)).includes(markerA), true);

	const denied = mount({ cookie, workspace: workspaceB, path: '/secret-b.md' });
	await middleware(denied, async () => {});
	await assertForbidden(denied, [markerB]);
});

test('an unknown workspace ID is indistinguishable from a forbidden one', { skip }, async () => {
	const cookie = await signIn(handleA);
	for (const workspace of ['l4s-test-missing-' + suffix, 'log4stellar-main', 'Upper Case', '../etc']) {
		const ctx = mount({ cookie, workspace, path: '/note-a.md' });
		await middleware(ctx, async () => {});
		await assertForbidden(ctx, [markerA, markerB]);
	}
});

test('a viewer is rejected with 403 before the request parameters are validated', { skip }, async () => {
	auth.addMember(outsider, workspaceRoles.viewer, workspaceB);
	assert.equal(auth.resolveRole(outsider, workspaceB), workspaceRoles.viewer);
	const cookie = await signIn(handleB);

	// A viewer may read, which proves the membership itself is recognised.
	const readable = mount({ cookie, workspace: workspaceB, path: '/secret-b.md' });
	await middleware(readable, async () => {});
	assert.equal(readable.status, 200);
	assert.equal(await bodyOf(readable), '# ' + markerB);

	const rejected = [
		// A wrong content type would otherwise be a 415 before the capability check.
		{ method: 'PUT', path: '/viewer.md', headers: { 'Content-Type': 'text/plain' }, body: 'nope' },
		// An oversized body would otherwise be a 413.
		{ method: 'PUT', path: '/viewer.md', headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(2 * 1024 * 1024) }, body: 'x' },
		// An unsupported operation would otherwise be a 400.
		{ method: 'POST', path: '/', query: { rename: '/secret-b.md' }, body: '' },
		{ method: 'POST', path: '/', query: { mkdir: '1' }, body: '' },
		{ method: 'DELETE', path: '/secret-b.md' },
	];
	for (const request of rejected) {
		const ctx = mount({ cookie, workspace: workspaceB, ...request });
		await middleware(ctx, async () => {});
		await assertForbidden(ctx, [markerB, markerTrash]);
	}

	const { openRustfsWorkspace } = await import('./rustfs-workspace.mjs');
	const unchanged = await openRustfsWorkspace(workspaceB, { createBlobs: openDirectoryBlobs });
	try {
		assert.equal((await unchanged.stat('/secret-b.md')).etag, bFile.etag, 'a rejected write must not change storage');
	} finally {
		await unchanged.close();
	}
});

test('an editor may write, and the write lands in the addressed workspace only', { skip }, async () => {
	auth.addMember(ownerA, workspaceRoles.editor, workspaceB);
	const cookie = await signIn(handleA);
	const written = markerB + '-editor-' + suffix;
	const ctx = mount({
		cookie,
		workspace: workspaceB,
		method: 'PUT',
		path: '/editor.md',
		query: { create: '1' },
		headers: { 'Content-Type': 'application/octet-stream' },
		body: written,
	});
	await middleware(ctx, async () => {});
	// A created file answers 201; an overwrite answers 200.
	assert.equal(ctx.status, 201, JSON.stringify(ctx.body));
	assert.equal(ctx.body.created, true);
	assert.equal(ctx.state.workspaceId, workspaceB);

	const { openRustfsWorkspace } = await import('./rustfs-workspace.mjs');
	const probe = await openRustfsWorkspace(workspaceB, { createBlobs: openDirectoryBlobs });
	try {
		assert.equal((await probe.stat('/editor.md')).size, Buffer.byteLength(written));
	} finally {
		await probe.close();
	}
	const aBackend = await openRustfsWorkspace(workspaceA, { createBlobs: openDirectoryBlobs });
	try {
		await assert.rejects(aBackend.stat('/editor.md'), /FileNotFound|not found/i);
	} finally {
		await aBackend.close();
	}
});

test('a second deployment sharing the auth database cannot adopt the first one\'s accounts', { skip }, async () => {
	// One `auth.sqlite`, two deployments with different storage workspace IDs. This is
	// the regression the migration guard exists for: copying the placeholder row on
	// every open would hand every account of the first deployment to the second one.
	const soloA = await auth.createAccount('user.d.' + suffix, password);
	assert.equal(auth.resolveRole(soloA, workspaceA), workspaceRoles.owner);

	const second = await openAuth({ workspaceId: workspaceB });
	try {
		assert.equal(second.workspaceId, workspaceB);
		// The account created under workspace A stays invisible to workspace B...
		assert.equal(second.resolveRole(soloA, workspaceB), undefined, 'the second deployment adopted the first one\'s account');
		// ...while still being a member of its own workspace and passing the login gate.
		assert.equal(second.resolveRole(soloA, workspaceA), workspaceRoles.owner);
		assert.equal(second.canReadWorkspace(soloA), true);

		// An account created by the second deployment only belongs to workspace B.
		const latecomer = await second.createAccount('user.c.' + suffix, password);
		assert.equal(second.resolveRole(latecomer, workspaceB), workspaceRoles.owner);
		assert.equal(second.resolveRole(latecomer, workspaceA), undefined);

		// Re-opening the first deployment must not adopt that account either.
		const reopened = await openAuth({ workspaceId: workspaceA });
		try {
			assert.equal(reopened.resolveRole(latecomer, workspaceA), undefined, 'the first deployment adopted an account created elsewhere');
			assert.equal(reopened.resolveRole(soloA, workspaceA), workspaceRoles.owner);
			// Every account still carries the rollback placeholder row, so the previous
			// release package keeps letting all of them sign in.
			const gate = reopened.database.prepare("SELECT user_id FROM workspace_member WHERE tenant_id = 'default' AND workspace_id = 'default' ORDER BY user_id").all()
				.map(row => row.user_id);
			const accounts = reopened.database.prepare('SELECT id FROM user ORDER BY id').all().map(row => row.id);
			assert.deepEqual(gate, accounts);
		} finally {
			reopened.database.close();
		}

		// The same guarantee holds at the HTTP layer: the account created under
		// workspace B gets 403 when it asks this gateway for workspace A. The gateway
		// under test serves workspace A, so its own default workspace is A.
		const cookie = await signIn('user.c.' + suffix);
		const denied = mount({ cookie, workspace: workspaceA, path: '/note-a.md' });
		await middleware(denied, async () => {});
		await assertForbidden(denied, [markerA]);

		// And the reverse direction: A's account cannot reach workspace B.
		const other = await signIn('user.d.' + suffix);
		const rejected = mount({ cookie: other, workspace: workspaceB, path: '/secret-b.md' });
		await middleware(rejected, async () => {});
		await assertForbidden(rejected, [markerB, markerTrash]);
	} finally {
		second.database.close();
	}
});

test('the default workspace is the earliest membership, and /api/session reports it', { skip }, async () => {
	const cookie = await signIn(handleA);
	const ctx = {
		secure: true,
		host: origin.host,
		path: '/api/session',
		method: 'GET',
		query: {},
		state: {},
		req: { socket: { remoteAddress: '127.0.0.1' } },
		get: name => name === 'Cookie' ? cookie : '',
		set: () => {},
		append: () => {},
		is: () => false,
	};
	await middleware(ctx, async () => {});
	// A successful handler leaves the status unset; the framework answers 200.
	assert.equal(ctx.status, undefined);
	assert.equal(ctx.body.workspaceId, workspaceA);
	assert.equal(typeof ctx.body.remainingMs, 'number');
});

test('the member command refuses a workspace that was never imported', { skip }, async () => {
	const { execFile } = await import('node:child_process');
	const { promisify } = await import('node:util');
	const missing = 'l4s-test-missing-' + suffix;
	const cli = new URL('./workspace-members.mjs', import.meta.url).pathname;
	const run = async args => {
		try {
			const { stdout } = await promisify(execFile)(process.execPath, [cli, ...args], { env: { ...process.env } });
			return { code: 0, stdout };
		} catch (error) {
			return { code: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
		}
	};

	// A member row for a workspace the storage backend never created logs the account
	// in and then answers every mount with 403 (contract §7.1), so the write is refused
	// before it happens.
	const added = await run(['add', handleB, '--role', 'owner', '--workspace', missing]);
	assert.equal(added.code, 1, 'adding a member to a missing workspace must fail');
	assert.match(added.stderr, new RegExp('The workspace ' + missing + ' has not been imported'));
	assert.equal((await storage.query('SELECT 1 FROM log4stellar.storage_workspaces WHERE id = $1', [missing])).rowCount, 0);

	const account = await openAuth({ workspaceId: workspaceA, adopt: false });
	try {
		assert.equal(account.listMembers(missing).length, 0, 'no member row may be written for a missing workspace');
		assert.equal(account.resolveRole(outsider, missing), undefined);
	} finally {
		account.database.close();
	}

	// The same command against a real workspace still works, so the guard is about
	// existence and not about the shape of the ID.
	const granted = await run(['add', handleB, '--role', 'viewer', '--workspace', workspaceB]);
	assert.equal(granted.code, 0, granted.stderr);
	assert.match(granted.stdout, new RegExp('Added ' + handleB + ' to ' + workspaceB + ' as viewer\\.'));
	const check = await openAuth({ workspaceId: workspaceA, adopt: false });
	try {
		assert.equal(check.resolveRole(outsider, workspaceB), workspaceRoles.viewer);
	} finally {
		check.database.close();
	}
});
