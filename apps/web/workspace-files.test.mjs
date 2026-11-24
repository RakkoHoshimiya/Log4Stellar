import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { authorizeWorkspace } from './workspace-access.mjs';
import { WorkspaceError } from './workspace-contract.mjs';
import { serveWorkspaceFile } from './workspace-files.mjs';

const ids = ['67cd53cb-4c6d-4d9e-b204-0f939d31d123', '97393f44-17e2-4e56-9e90-308c638ae206'];

function request({ method = 'POST', path = '/static/mount/', query = { restoreTrashBatch: '1' }, type = 'application/json', body = JSON.stringify(ids) } = {}) {
	const headers = new Map();
	return {
		method, path, query, headers,
		req: Readable.from([Buffer.from(body)]),
		get: key => headers.get(key) ?? '',
		set: (key, value) => headers.set(key, value),
		is: expected => type === expected,
	};
}

test('forwards a complete restore batch as one workspace transaction', async () => {
	const ctx = request();
	const restored = [{ path: '/note.md', type: 1, createdParents: [] }, { path: '/pictures', type: 2, createdParents: [] }];
	const calls = [];
	await serveWorkspaceFile(ctx, authorizeWorkspace({
		async restoreTrashBatch(values) {
			calls.push(values);
			return restored;
		},
	}, { role: 'owner' }), 1024);
	assert.deepEqual(calls, [ids]);
	assert.deepEqual(ctx.body, restored);
});

test('rejects malformed, oversized, non-POST and non-root restore requests', async () => {
	const workspace = authorizeWorkspace({ restoreTrashBatch() { assert.fail('Invalid input reached the workspace'); } }, { role: 'owner' });
	const cases = [
		[request({ method: 'GET' }), 405],
		[request({ path: '/static/mount/note.md' }), 404],
		[request({ type: 'text/plain' }), 415],
		[request({ body: '{"unfinished"' }), 400],
		[request({ body: '[]' }), 400],
		[request({ body: '[42]' }), 400],
		[request({ body: ' '.repeat(1024 * 1024 + 1) }), 413],
	];
	for (const [ctx, status] of cases) {
		await serveWorkspaceFile(ctx, workspace, 1024);
		assert.equal(ctx.status, status);
	}
});

test('preserves a storage conflict and the single-item keep-both route', async () => {
	const batch = request();
	await serveWorkspaceFile(batch, authorizeWorkspace({
		async restoreTrashBatch() { throw new WorkspaceError(409, 'FileExists'); },
	}, { role: 'owner' }), 1024);
	assert.equal(batch.status, 409);
	assert.deepEqual(batch.body, { error: 'FileExists' });

	const single = request({ query: { restoreTrash: ids[0], keepBoth: '1' } });
	await serveWorkspaceFile(single, authorizeWorkspace({
		async restoreTrash(id, keepBoth) {
			assert.equal(id, ids[0]);
			assert.equal(keepBoth, true);
			return { path: '/note (restored).md', type: 1, createdParents: [] };
		},
	}, { role: 'owner' }), 1024);
	assert.equal(single.body.path, '/note (restored).md');
});

test('authorizes before validating parameters, so a viewer PUT is 403 not 415', async () => {
	const workspace = authorizeWorkspace({
		openRead() { assert.fail('A viewer reached storage for a read'); },
		writeFile() { assert.fail('A viewer reached storage for a write'); },
		createDirectory() { assert.fail('A viewer reached storage for a mkdir'); },
		restoreRevision() { assert.fail('A viewer reached storage for a restore'); },
		delete() { assert.fail('A viewer reached storage for a delete'); },
	}, { role: 'viewer' });
	const cases = [
		// A missing content type used to be answered with 415 before authorization.
		request({ method: 'PUT', path: '/static/mount/note.md', query: {}, type: 'text/plain', body: 'ignored' }),
		// An oversized upload used to be answered with 413 before authorization.
		request({ method: 'PUT', path: '/static/mount/note.md', query: {}, type: 'application/octet-stream', body: 'x'.repeat(2048) }),
		// An unsupported operation used to be answered with 400 before authorization.
		request({ method: 'POST', path: '/static/mount/note.md', query: { restoreVersion: 'r1' }, type: 'application/json', body: '{}' }),
		// A missing target used to be answered with 400 before authorization.
		request({ method: 'POST', path: '/static/mount/note.md', query: { rename: '' }, type: 'text/plain', body: '' }),
		// A malformed deletion used to be answered with 400 before authorization.
		request({ method: 'DELETE', path: '/static/mount/note.md', query: {}, type: 'text/plain', body: '' }),
	];
	for (const ctx of cases) {
		await serveWorkspaceFile(ctx, workspace, 1024);
		assert.equal(ctx.status, 403);
		assert.deepEqual(ctx.body, { error: 'NoPermissions' });
	}

	// An unsupported method has no capability to check, so it stays a plain 405 for
	// every role and never reaches storage.
	const patched = request({ method: 'PATCH', path: '/static/mount/note.md', query: {}, type: 'text/plain', body: 'x' });
	await serveWorkspaceFile(patched, workspace, 1024);
	assert.equal(patched.status, 405);
});

test('authorizes before decoding the path, so a viewer cannot probe paths through 400s', async () => {
	const calls = [];
	const record = name => (...args) => {
		calls.push([name, ...args]);
		assert.fail('A viewer reached storage for ' + name);
	};
	const workspace = authorizeWorkspace({
		stat: record('stat'), readDirectory: record('readDirectory'), listFiles: record('listFiles'),
		openRead: record('openRead'), openRevision: record('openRevision'), listVersions: record('listVersions'),
		listTrash: record('listTrash'), writeFile: record('writeFile'), createDirectory: record('createDirectory'),
		rename: record('rename'), delete: record('delete'), restoreRevision: record('restoreRevision'),
		restoreTrash: record('restoreTrash'), restoreTrashBatch: record('restoreTrashBatch'),
	}, { role: 'viewer' });
	// A malformed percent escape used to be decoded before authorization, so a viewer
	// received "400 InvalidPath" instead of "403 NoPermissions" (review finding M1).
	const paths = ['/static/mount/%ZZ', '/static/mount/%E0%A4%A'];
	const methods = [
		{ method: 'PUT', type: 'application/octet-stream', body: 'ignored' },
		{ method: 'POST', query: { rename: '/static/mount/renamed.md' }, type: 'text/plain', body: '' },
		{ method: 'DELETE', type: 'text/plain', body: '' },
	];
	for (const path of paths) {
		for (const { method, query = {}, type, body } of methods) {
			const ctx = request({ method, path, query, type, body });
			await serveWorkspaceFile(ctx, workspace, 1024);
			assert.equal(ctx.status, 403, method + ' ' + path);
			assert.deepEqual(ctx.body, { error: 'NoPermissions' });
		}
	}
	assert.deepEqual(calls, []);
	// A viewer may read, so a malformed path is only decided after authorization and
	// keeps answering 400 there; the check above is about writes only.
	const readable = request({ method: 'GET', path: '/static/mount/%ZZ', query: {}, type: 'text/plain', body: '' });
	await serveWorkspaceFile(readable, authorizeWorkspace({ openRead: () => assert.fail('The path never decoded') }, { role: 'viewer' }), 1024);
	assert.equal(readable.status, 400);
});

test('the capability matrix only advertises search when the backend implements it', async () => {
	// Body-text search is derived data. An older backend — or the local workspace backend —
	// has no `searchDocuments`, and the client must then leave the search surface alone
	// instead of issuing requests that would answer 501.
	const capabilities = async backend => {
		const ctx = request({ method: 'GET', path: '/static/mount/', query: { capabilities: '1' }, body: '' });
		await serveWorkspaceFile(ctx, authorizeWorkspace(backend, { role: 'owner' }), 1024);
		return ctx.body;
	};

	const withSearch = await capabilities({
		async listVersions() { return []; },
		async restoreRevision() { return {}; },
		async listTrash() { return []; },
		async searchDocuments() { return {}; },
	});
	assert.equal(withSearch.search, true);
	assert.equal(withSearch.versionHistory, true);

	const withoutSearch = await capabilities({
		async listVersions() { return []; },
		async restoreRevision() { return {}; },
		async listTrash() { return []; },
	});
	assert.equal(withoutSearch.search, false);
});
