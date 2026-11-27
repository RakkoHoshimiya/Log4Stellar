import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

const [directory, origin, mode] = process.argv.slice(2);
const password = (await readFile(join(directory, 'password'), 'utf8')).trim();
const login = await fetch(origin + '/login', {
	method: 'POST',
	redirect: 'manual',
	headers: { Origin: origin },
	body: new URLSearchParams({ username: 'admin', password }),
});
assert.equal(login.status, 303);
const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
const headers = { Origin: origin, Cookie: cookie };
let workspace;

function api(path, options = {}) {
	return fetch(origin + path, {
		...options,
		redirect: 'manual',
		headers: {
			...headers,
			...(workspace ? { 'X-Log4Stellar-Workspace': workspace } : {}),
			...options.headers,
		},
		signal: AbortSignal.timeout(30_000),
	});
}

async function expect(response, status) {
	assert.equal(response.status, status, new URL(response.url).pathname);
	return response;
}

async function post(path, body) {
	const response = await expect(await api(path, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	}), 200);
	return response.json();
}

async function writeNote(bytes, etag) {
	const path = '/static/mount/Welcome.md';
	return expect(await api(path + (etag ? '?overwrite=1' : '?create=1'), {
		method: 'PUT',
		headers: {
			'Content-Type': 'application/octet-stream',
			...(etag ? { 'If-Match': etag } : {}),
		},
		body: bytes,
	}), etag ? 200 : 201);
}

const workspaceFile = join(directory, 'workspace-id');
if (mode === 'seed') {
	const session = await (await expect(await api('/api/session'), 200)).json();
	const tenant = await post('/api/v2/management/platform/tenants', {
		name: 'Container fixture', initialAdminId: session.accountId, requestId: randomUUID(),
	});
	const scope = await post('/api/v2/management/tenants/' + tenant.tenantId + '/workspaces', {
		name: 'Container notes', initialOwnerId: session.accountId, requestId: randomUUID(),
	});
	workspace = scope.id;
	assert.ok(workspace);
	await writeFile(workspaceFile, workspace);
	const first = await writeNote('# First container version');
	const etag = first.headers.get('etag');
	assert.ok(etag);
	await writeNote('# Current container version', etag);
} else {
	assert.equal(mode, 'check');
	workspace = await readFile(workspaceFile, 'utf8');
}

const current = await expect(await api('/static/mount/Welcome.md'), 200);
assert.equal(await current.text(), '# Current container version');
const versions = await (await expect(await api('/static/mount/Welcome.md?versions=1'), 200)).json();
assert.equal(versions.length, 2);
const old = versions.find(version => !version.current);
assert.ok(old);
const previous = await expect(await api('/static/mount/Welcome.md?revision=' + old.id), 200);
assert.equal(await previous.text(), '# First container version');
assert.equal((await fetch(origin + '/static/mount/Welcome.md', { redirect: 'manual' })).status, 401);
console.log('PASS login, current note, two revisions, historical read and anonymous rejection ' + mode);
