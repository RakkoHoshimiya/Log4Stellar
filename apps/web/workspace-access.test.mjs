import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import {
	allowsWorkspace,
	authorizeWorkspace,
	capabilityForRequest,
	isWorkspaceRole,
	normalizeWorkspaceRole,
	workspaceCapabilities,
	workspaceRoles,
} from './workspace-access.mjs';
import { WorkspaceError } from './workspace-contract.mjs';
import { serveWorkspaceFile } from './workspace-files.mjs';

// Every request shape from docs/workspace-access.md §3, with the capability the
// contract assigns to it. The matrix test drives the real handler with each one.
const shapes = [
	{ name: 'GET capabilities', method: 'GET', path: '/static/mount/', query: { capabilities: '1' }, capability: 'history' },
	{ name: 'HEAD capabilities', method: 'HEAD', path: '/static/mount/', query: { capabilities: '1' }, capability: 'history' },
	{ name: 'GET trash', method: 'GET', path: '/static/mount/', query: { trash: '1' }, capability: 'history' },
	{ name: 'GET versions', method: 'GET', path: '/static/mount/note.md', query: { versions: '1' }, capability: 'history' },
	{ name: 'GET revision', method: 'GET', path: '/static/mount/note.md', query: { revision: 'r1' }, capability: 'read' },
	{ name: 'GET stat', method: 'GET', path: '/static/mount/note.md', query: { stat: '1' }, capability: 'read' },
	{ name: 'GET readdir', method: 'GET', path: '/static/mount/', query: { readdir: '' }, capability: 'read' },
	{ name: 'GET files', method: 'GET', path: '/static/mount/', query: { files: '1' }, capability: 'read' },
	{ name: 'GET content', method: 'GET', path: '/static/mount/note.md', query: {}, capability: 'read' },
	{ name: 'HEAD content', method: 'HEAD', path: '/static/mount/note.md', query: {}, capability: 'read' },
	{ name: 'PUT content', method: 'PUT', path: '/static/mount/note.md', query: {}, capability: 'write' },
	{ name: 'POST mkdir', method: 'POST', path: '/static/mount/folder', query: { mkdir: '1' }, capability: 'write' },
	{ name: 'POST rename', method: 'POST', path: '/static/mount/note.md', query: { rename: '/renamed.md' }, capability: 'write' },
	{ name: 'POST restoreVersion', method: 'POST', path: '/static/mount/note.md', query: { restoreVersion: 'r1' }, capability: 'restore' },
	{ name: 'POST restoreTrash', method: 'POST', path: '/static/mount/', query: { restoreTrash: '67cd53cb-4c6d-4d9e-b204-0f939d31d123' }, capability: 'restore' },
	{ name: 'POST restoreTrashBatch', method: 'POST', path: '/static/mount/', query: { restoreTrashBatch: '1' }, capability: 'restore' },
	{ name: 'DELETE', method: 'DELETE', path: '/static/mount/note.md', query: {}, capability: 'delete' },
];

const expectedByRole = {
	viewer: ['read', 'history', 'gitRead'],
	editor: ['read', 'history', 'write', 'delete', 'restore', 'gitRead', 'gitWrite'],
	owner: ['read', 'history', 'write', 'delete', 'restore', 'admin', 'gitRead', 'gitWrite', 'gitAdmin'],
};

function recordedBackend() {
	const calls = [];
	const record = name => (...args) => {
		calls.push([name, ...args]);
		if (name === 'listVersions') {
			return [];
		}
		if (name === 'listTrash') {
			return [];
		}
		if (name === 'openRead' || name === 'openRevision') {
			return { etag: 'etag', size: 0, close: async () => {}, stream: async () => Readable.from([]) };
		}
		if (name === 'writeFile' || name === 'restoreRevision') {
			return { etag: 'etag', created: false, size: 0 };
		}
		if (name === 'restoreTrash') {
			return { path: '/note.md', type: 1, createdParents: [] };
		}
		if (name === 'restoreTrashBatch') {
			return [];
		}
		return undefined;
	};
	const backend = { calls };
	for (const name of ['stat', 'readDirectory', 'listFiles', 'openRead', 'openRevision', 'listVersions', 'listTrash', 'writeFile', 'createDirectory', 'rename', 'delete', 'restoreRevision', 'restoreTrash', 'restoreTrashBatch']) {
		backend[name] = record(name);
	}
	return backend;
}

function context({ method, path, query }) {
	const headers = new Map([['Origin', 'https://workspace.invalid']]);
	return {
		method,
		path,
		query,
		headers,
		req: Readable.from([Buffer.from('[]')]),
		get: name => headers.get(name) ?? '',
		set: (name, value) => headers.set(name, value),
		is: expected => expected === 'application/octet-stream' || expected === 'application/json',
	};
}

test('capabilityForRequest matches the contract table for every shape', () => {
	for (const shape of shapes) {
		assert.equal(capabilityForRequest(shape.method, shape.query), workspaceCapabilities[shape.capability], shape.name);
	}
	// An unknown POST needs write capability so a viewer cannot probe operations.
	assert.equal(capabilityForRequest('POST', { somethingElse: '1' }), workspaceCapabilities.write);
	// An unsupported method has no capability; the handler answers 405 for everyone.
	assert.equal(capabilityForRequest('PATCH', {}), undefined);
	assert.equal(capabilityForRequest('OPTIONS', {}), undefined);
	// A non-root `?trash=1` falls through to reading a file, so it needs read rather
	// than history; otherwise a role that may read history but not files could read one.
	assert.equal(capabilityForRequest('GET', { trash: '1' }, { isRoot: false }), workspaceCapabilities.read);
	assert.equal(capabilityForRequest('GET', { capabilities: '1' }, { isRoot: false }), workspaceCapabilities.read);
	// A version listing is a history request at any path.
	assert.equal(capabilityForRequest('GET', { versions: '1' }, { isRoot: false }), workspaceCapabilities.history);
});

test('the capability matrix admits exactly the documented requests per role', async () => {
	for (const [roleName, grantedNames] of Object.entries(expectedByRole)) {
		const granted = new Set(grantedNames.map(name => workspaceCapabilities[name]));
		assert.deepEqual([...authorizeWorkspace({}, { role: roleName }).capabilities].sort(), [...granted].sort(), roleName);
		for (const shape of shapes) {
			const backend = recordedBackend();
			const ctx = context(shape);
			await serveWorkspaceFile(ctx, authorizeWorkspace(backend, { role: roleName }), 1024);
			const allowed = granted.has(workspaceCapabilities[shape.capability]);
			if (allowed) {
				assert.notEqual(ctx.status, 403, roleName + ' should reach ' + shape.name);
			} else {
				assert.equal(ctx.status, 403, roleName + ' must not reach ' + shape.name);
				assert.deepEqual(ctx.body, { error: 'NoPermissions' }, shape.name);
				assert.deepEqual(backend.calls, [], roleName + ' touched storage for ' + shape.name);
			}
		}
	}
});

test('the facade rejects an unknown role instead of defaulting to anything', () => {
	assert.throws(() => authorizeWorkspace({}, { role: 'admin' }), /Unknown workspace role/);
	assert.throws(() => authorizeWorkspace({}, { role: 4 }), /Unknown workspace role/);
	assert.throws(() => authorizeWorkspace({}, {}), /Unknown workspace role/);
	assert.throws(() => authorizeWorkspace(undefined, { role: 'owner' }), /workspace backend is required/);
	assert.equal(normalizeWorkspaceRole('editor'), workspaceRoles.editor);
	assert.equal(normalizeWorkspaceRole(workspaceRoles.viewer), workspaceRoles.viewer);
});

test('role helpers answer only for known roles and capabilities', () => {
	assert.equal(isWorkspaceRole(workspaceRoles.viewer), true);
	assert.equal(isWorkspaceRole(0), false);
	assert.equal(isWorkspaceRole('owner'), false);
	assert.equal(allowsWorkspace(workspaceRoles.viewer, workspaceCapabilities.write), false);
	assert.equal(allowsWorkspace(workspaceRoles.editor, workspaceCapabilities.write), true);
	assert.equal(allowsWorkspace(workspaceRoles.editor, workspaceCapabilities.admin), false);
	assert.equal(allowsWorkspace(workspaceRoles.owner, workspaceCapabilities.admin), true);
	assert.equal(allowsWorkspace(99, workspaceCapabilities.read), false);
});

test('require() throws a 403 WorkspaceError without calling the backend', () => {
	const backend = recordedBackend();
	const facade = authorizeWorkspace(backend, { role: 'viewer' });
	assert.throws(() => facade.require(workspaceCapabilities.delete), error => {
		assert(error instanceof WorkspaceError);
		assert.equal(error.status, 403);
		assert.equal(error.code, 'NoPermissions');
		return true;
	});
	facade.require(workspaceCapabilities.read);
	assert.deepEqual(backend.calls, []);
});

test('a gated method refuses before delegating and passes through when allowed', async () => {
	const backend = recordedBackend();
	const viewer = authorizeWorkspace(backend, { role: 'viewer' });
	// The refusal is synchronous because it performs no I/O; an `await` on it still
	// surfaces the same rejection to a caller that treats the method as async.
	for (const call of [
		() => viewer.writeFile('/note.md', Readable.from([])),
		() => viewer.delete('/note.md'),
		() => viewer.restoreTrash('id'),
		() => viewer.createDirectory('/folder'),
		() => viewer.rename('/a.md', '/b.md'),
	]) {
		assert.throws(call, error => error instanceof WorkspaceError && error.status === 403);
	}
	assert.deepEqual(backend.calls, []);

	await viewer.stat('/note.md');
	assert.deepEqual(backend.calls.map(([name]) => name), ['stat']);

	const editor = authorizeWorkspace(backend, { role: 'editor' });
	assert.throws(() => editor.require(workspaceCapabilities.admin), /NoPermissions/);
	await editor.rename('/a.md', '/b.md');
	assert.deepEqual(backend.calls.at(-1), ['rename', '/a.md', '/b.md']);
});

test('methods the backend does not implement stay absent on the facade', () => {
	const facade = authorizeWorkspace({ stat: async () => ({ type: 1 }) }, { role: 'owner' });
	assert.equal(typeof facade.stat, 'function');
	assert.equal(facade.writeFile, undefined);
	assert.equal(facade.listTrash, undefined);
	// The local backend has no version history, which the capabilities probe reports.
	assert.equal(facade.listVersions, undefined);
});
