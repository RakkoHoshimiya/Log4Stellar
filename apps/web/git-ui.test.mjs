import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

const code = await readFile(new URL('./workspace-extension/extension.js', import.meta.url), 'utf8');
const sha = 'a'.repeat(40);
const remote = 'b'.repeat(40);
const repository = {
	path: 'repository', head: { branch: 'main', commit: sha },
	remoteBranch: 'main', remoteId: 'configured-remote', lastFetch: { commit: remote },
};
const folder = { uri: { scheme: 'vscode-test-web', authority: 'mount-Owner123.notes' } };
const plain = value => JSON.parse(JSON.stringify(value));

function editor({ action, confirm = true, binding = repository, reject, rejectAt, fetch, branchSelection } = {}) {
	const messages = [];
	const calls = [];
	const picks = [];
	const module = { exports: {} };
	const vscode = {
		env: { language: 'en' },
		EventEmitter: class {},
		window: {
			async showQuickPick(items, options) {
				picks.push(plain({ items, options }));
				return picks.length === 1 ? items.find(item => item.id === action) : items.find(item => item.label === branchSelection);
			},
			async showWarningMessage(message, options, label) {
				messages.push(message);
				return confirm ? label : undefined;
			},
			async showInformationMessage(message) { messages.push(message); },
			async showErrorMessage(message) { messages.push(message); },
		},
	};
	vm.runInNewContext(code, { require: () => vscode, module, URL, URLSearchParams, Headers, fetch });
	const provider = {
		async gitRequest(uri, endpoint, options) {
			assert.equal(uri, folder.uri);
			calls.push(plain({ endpoint, options }));
			if (endpoint === 'repository') {
				return { bound: Boolean(binding), repository: binding };
			}
			if (reject && (rejectAt === undefined || endpoint === rejectAt)) throw new Error(reject);
				if (endpoint === 'branches') return { current: 'main', branches: [
					{ name: 'main', commit: sha, current: true },
					{ name: 'review', commit: remote, current: false },
				] };
			if (endpoint === 'log') return { commits: [{ subject: 'Update notes', commit: sha, author: 'Contributor' }] };
			if (endpoint === 'status') return { workTree: { clean: false, entries: [{ path: 'README.md', index: 'M', workTree: '.' }] } };
			return {};
		},
	};
	return { vscode, messages, calls, picks, exports: module.exports, open: () => module.exports.openGitRepository(provider, folder) };
}

test('Git dashboard reads repository status and log only when selected', async () => {
	const status = editor({ action: 'status' });
	await status.open();
	assert.deepEqual(status.calls.map(call => call.endpoint), ['repository', 'status']);
	assert.deepEqual(status.picks[1].items, [{ label: 'README.md', description: 'M.' }]);
	const log = editor({ action: 'log' });
	await log.open();
	assert.deepEqual(log.calls[1], { endpoint: 'log', options: { query: { limit: '50' } } });
	assert.equal(log.picks[1].items[0].label, 'Update notes');
});

test('Git dashboard asks before Fetch and Push and never submits when cancelled', async () => {
	for (const action of ['fetch', 'push']) {
		const window = editor({ action, confirm: false });
		await window.open();
		assert.deepEqual(window.calls.map(call => call.endpoint), ['repository']);
		assert.equal(window.messages.length, 1);
	}
});

test('Git dashboard pins the confirmed local commit, remote and last fetched revision', async () => {
	const window = editor({ action: 'push' });
	await window.open();
	assert.match(window.messages[0], /Push main at aaaaaaaaaaaa/);
	assert.deepEqual(window.calls[1], { endpoint: 'push', options: { body: {
		branch: 'main', expectedHead: sha, expectedRemoteId: 'configured-remote', expectedRemote: remote,
	} } });
});

test('Git dashboard does not push before fetch and handles a server capability denial', async () => {
	const missing = editor({ action: 'push', binding: { ...repository, lastFetch: null } });
	await missing.open();
	assert.equal(missing.calls.length, 1);
	assert.match(missing.messages[0], /Fetch the configured/);
	const viewer = editor({ action: 'push', reject: 'NoPermissions' });
	await viewer.open();
	assert.match(viewer.messages.at(-1), /does not allow/);
});

test('Git dashboard switches only to a selected local branch', async () => {
	const cancelled = editor({ action: 'switchBranch' });
	await cancelled.open();
	assert.deepEqual(cancelled.calls.map(call => call.endpoint), ['repository', 'branches']);
	const switched = editor({ action: 'switchBranch', branchSelection: 'review' });
	await switched.open();
	assert.deepEqual(switched.picks[1].items.map(item => item.label), ['review']);
	assert.deepEqual(switched.calls.at(-1), { endpoint: 'branch', options: { body: { name: 'review' } } });
	assert.match(switched.messages.at(-1), /Switched to review/);
});

test('Git dashboard distinguishes a dirty tree from a changed remote branch', async () => {
	const dirty = editor({ action: 'switchBranch', branchSelection: 'review', reject: 'WorkTreeDirty', rejectAt: 'branch' });
	await dirty.open();
	assert.match(dirty.messages.at(-1), /Commit or stash/);
	const moved = editor({ action: 'push', reject: 'RemoteChanged' });
	await moved.open();
	assert.match(moved.messages.at(-1), /The remote branch changed/);
	const diverged = editor({ action: 'push', reject: 'NotFastForward' });
	await diverged.open();
	assert.match(diverged.messages.at(-1), /would overwrite remote commits/);
});

test('Git requests use a same-origin URL and scoped workspace and account headers', async () => {
	const requests = [];
	const window = editor({ fetch: async (url, options) => {
		requests.push({ url: url.toString(), options });
		if (url.pathname === '/api/session') return Response.json({ workspaceId: 'notes' });
		return Response.json({ bound: true });
	} });
	const provider = new window.exports.WorkspaceFileSystem('https://workspace.invalid');
	await provider.gitRequest(folder.uri, 'fetch', { body: {} });
	const request = requests[0];
	assert.equal(request.url, 'https://workspace.invalid/git/v1/fetch');
	assert.equal(request.options.method, 'POST');
	assert.equal(request.options.redirect, 'error');
	assert.equal(request.options.headers.get('X-Log4Stellar-Workspace'), 'notes');
	assert.equal(request.options.headers.get('X-Log4Stellar-Workspace-Account'), 'owner123');
	await assert.rejects(provider.gitRequest({ authority: 'mount' }, 'fetch', { body: {} }), /WorkspaceSessionRequired/);
	assert.equal(requests.length, 1);
});


test('a workspace-scoped URI pins the workspace and account across requests', async () => {
  const requests = [];
  const window = editor({ fetch: async (url, options) => {
    requests.push({ url: url.toString(), options });
    return Response.json({ bound: true });
  } });
  const provider = new window.exports.WorkspaceFileSystem('https://workspace.invalid');
  await provider.gitRequest({ authority: 'mount-Owner123.shared-notes' }, 'repository');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.headers.get('X-Log4Stellar-Workspace'), 'shared-notes');
  assert.equal(requests[0].options.headers.get('X-Log4Stellar-Workspace-Account'), 'owner123');
});


test('malformed workspace authorities never fall back to the default workspace', async () => {
  let fetches = 0;
  const window = editor({ fetch: async () => { fetches++; return Response.json({ workspaceId: 'default' }); } });
  const provider = new window.exports.WorkspaceFileSystem('https://workspace.invalid');
  for (const authority of ['mount-owner.', 'mount-owner.bad!id', 'mount-owner.notes.extra', 'mount-.notes']) {
    await assert.rejects(provider.gitRequest({ authority }, 'repository'), /InvalidWorkspaceAuthority/);
  }
  assert.equal(fetches, 0);
});


test('legacy ETags remain isolated for identical paths in different workspaces', async () => {
  const writes = [];
  const window = editor({ fetch: async (_url, options) => {
    const workspace = options.headers.get('X-Log4Stellar-Workspace');
    if (options.method === 'PUT') {
      writes.push({ workspace, etag: options.headers.get('If-Match') });
      return Response.json({ type: 1 }, { headers: { ETag: 'after-' + workspace } });
    }
    return new Response('notes', { headers: { ETag: 'before-' + workspace } });
  } });
  window.vscode.FileChangeType = { Created: 1, Changed: 2 };
  const provider = new window.exports.WorkspaceFileSystem('https://workspace.invalid');
  provider.changes.fire = () => {};
  const uri = name => ({ authority: 'mount-owner.' + name, path: '/note.md', toString() { return this.authority + this.path; } });
  const first = uri('workspace-a');
  const second = uri('workspace-b');
  await provider.readFile(first);
  await provider.readFile(second);
  await provider.writeFile(first, new Uint8Array(), { create: false, overwrite: true });
  await provider.writeFile(second, new Uint8Array(), { create: false, overwrite: true });
  assert.deepEqual(writes, [
    { workspace: 'workspace-a', etag: 'before-workspace-a' },
    { workspace: 'workspace-b', etag: 'before-workspace-b' },
  ]);
});


test('legacy workspace identities are rejected instead of following a changed default', async () => {
  let fetches = 0;
  const window = editor({ fetch: async () => { fetches++; return Response.json({ workspaceId: 'new-default' }); } });
  const provider = new window.exports.WorkspaceFileSystem('https://workspace.invalid');
  await assert.rejects(provider.gitRequest({ authority: 'mount-owner' }, 'repository'), /LegacyWorkspaceIdentityRequiresMigration/);
  assert.equal(fetches, 0);
});


test('cross-workspace moves are rejected before any network request', async () => {
  let fetches = 0;
  const window = editor({ fetch: async () => { fetches++; return Response.json({}); } });
  const provider = new window.exports.WorkspaceFileSystem('https://workspace.invalid');
  await assert.rejects(provider.rename(
    { authority: 'mount-owner.workspace-a', path: '/a.md' },
    { authority: 'mount-owner.workspace-b', path: '/b.md' },
    { overwrite: true },
  ), /CrossWorkspaceMoveUnsupported/);
  assert.equal(fetches, 0);
});
