import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workspaceCapabilities, workspaceRoles, authorizeWorkspace, allowsWorkspace } from './workspace-access.mjs';
import {
	capabilityForGitRequest,
	gitError,
	gitErrorStatus,
	gitMountPath,
	gitPageLimits,
	gitRoots,
	gitRoutes,
	isCommitSha,
	normalizeCheckpointName,
	normalizeGitLimit,
	parseGitRemote,
	remoteIdentity,
	requireBranchName,
	requireCommitSha,
	sanitizeGitMessage,
} from './git-contract.mjs';
import { gitAllowedProtocols, gitArgv } from './git-repository.mjs';

// Pure-function coverage for the Git contract (docs/git-integration.md §2, §4, §5). Nothing
// here touches PostgreSQL, the file system or a child process, so the whole file runs in the
// default suite.

test('the git capabilities are separate read, write and admin units', () => {
	assert.equal(workspaceCapabilities.gitRead, 'workspace.git.read');
	assert.equal(workspaceCapabilities.gitWrite, 'workspace.git.write');
	assert.equal(workspaceCapabilities.gitAdmin, 'workspace.git.admin');
	// Watching commits and fetching is a viewer's right; moving a work tree is not.
	assert.equal(allowsWorkspace(workspaceRoles.viewer, workspaceCapabilities.gitRead), true);
	assert.equal(allowsWorkspace(workspaceRoles.viewer, workspaceCapabilities.gitWrite), false);
	assert.equal(allowsWorkspace(workspaceRoles.viewer, workspaceCapabilities.gitAdmin), false);
	assert.equal(allowsWorkspace(workspaceRoles.editor, workspaceCapabilities.gitWrite), true);
	assert.equal(allowsWorkspace(workspaceRoles.editor, workspaceCapabilities.gitAdmin), false);
	assert.equal(allowsWorkspace(workspaceRoles.owner, workspaceCapabilities.gitAdmin), true);
});

test('every git route is mapped to a capability and nothing else resolves', () => {
	const routeCapability = (method, path) => capabilityForGitRequest(method, path);
	assert.equal(routeCapability('GET', gitRoutes.repository), workspaceCapabilities.gitRead);
	assert.equal(routeCapability('GET', gitRoutes.status), workspaceCapabilities.gitRead);
	assert.equal(routeCapability('GET', gitRoutes.log), workspaceCapabilities.gitRead);
	assert.equal(routeCapability('GET', gitRoutes.branches), workspaceCapabilities.gitRead);
	assert.equal(routeCapability('GET', gitRoutes.commit + 'a'.repeat(40)), workspaceCapabilities.gitRead);
	assert.equal(routeCapability('GET', gitRoutes.checkpoints), workspaceCapabilities.gitRead);
	assert.equal(routeCapability('GET', gitRoutes.checkpoints + '/' + 'b'.repeat(32)), workspaceCapabilities.gitRead);
	assert.equal(routeCapability('GET', gitRoutes.credentials), workspaceCapabilities.gitRead);
	// fetch rewrites refs/remotes/* only, so a read role may run it.
	assert.equal(routeCapability('POST', gitRoutes.fetch), workspaceCapabilities.gitRead);
	assert.equal(routeCapability('POST', gitRoutes.push), workspaceCapabilities.gitWrite);
	assert.equal(routeCapability('POST', gitRoutes.branch), workspaceCapabilities.gitWrite);
	assert.equal(routeCapability('POST', gitRoutes.checkpoints), workspaceCapabilities.gitWrite);
	assert.equal(routeCapability('DELETE', gitRoutes.checkpoints + '/' + 'b'.repeat(32)), workspaceCapabilities.gitWrite);
	assert.equal(routeCapability('PUT', gitRoutes.repository), workspaceCapabilities.gitAdmin);
	assert.equal(routeCapability('DELETE', gitRoutes.repository), workspaceCapabilities.gitAdmin);
	assert.equal(routeCapability('PUT', gitRoutes.credentials), workspaceCapabilities.gitAdmin);
	assert.equal(routeCapability('DELETE', gitRoutes.credentials + '/' + 'b'.repeat(32)), workspaceCapabilities.gitAdmin);
	// Anything unlisted must stay undefined so the handler can answer 404 instead of
	// defaulting to a read.
	assert.equal(routeCapability('GET', gitMountPath + '/nope'), undefined);
	assert.equal(routeCapability('GET', gitMountPath), undefined);
	assert.equal(routeCapability('PATCH', gitRoutes.push), undefined);
	assert.equal(routeCapability('GET', gitRoutes.push), undefined);
	assert.equal(routeCapability('DELETE', gitRoutes.repository + '/x'), undefined);
});

test('the facade gates git methods per role and hides what the backend lacks', () => {
	const backend = {
		gitStatus: async () => ({}),
		gitPush: async () => ({}),
		gitBindRepository: async () => ({}),
	};
	assert.deepEqual(
		authorizeWorkspace(backend, { role: 'viewer' }).capabilities.filter(name => name.startsWith('workspace.git')),
		[workspaceCapabilities.gitRead],
	);
	const editor = authorizeWorkspace(backend, { role: 'editor' });
	assert.equal(typeof editor.gitPush, 'function');
	assert.throws(() => editor.require(workspaceCapabilities.gitAdmin), error => error.status === 403 && error.code === 'NoPermissions');
	// The facade exposes a method whenever the backend implements it and refuses the CALL,
	// so a viewer can probe for gitStatus (and is refused 403) without a second code path.
	assert.throws(() => editor.gitBindRepository(), error => error.status === 403 && error.code === 'NoPermissions');
	assert.throws(() => authorizeWorkspace(backend, { role: 'viewer' }).gitPush(), error => error.status === 403);
	// A method the backend does not implement is absent, exactly as for storage methods.
	assert.equal(authorizeWorkspace({}, { role: 'owner' }).gitStatus, undefined);
});

test('error codes keep the documented status mapping', () => {
	assert.equal(gitErrorStatus.NoPermissions, 403);
	assert.equal(gitErrorStatus.RepositoryNotBound, 404);
	assert.equal(gitErrorStatus.CheckpointExists, 409);
	assert.equal(gitErrorStatus.NotFastForward, 409);
	assert.equal(gitErrorStatus.RepositoryBusy, 409);
	assert.equal(gitErrorStatus.RemoteChanged, 412);
	assert.equal(gitErrorStatus.RequestTooLarge, 413);
	assert.equal(gitErrorStatus.WorkTreeDirty, 422);
	assert.equal(gitErrorStatus.RemoteUnavailable, 502);
	assert.equal(gitErrorStatus.RemoteAuthenticationFailed, 502);
	assert.equal(gitErrorStatus.RemoteTimeout, 504);
	// 410 belongs to the sync cursor contract and must never be reused here.
	assert.equal(Object.values(gitErrorStatus).includes(410), false);
	const error = gitError('WorkTreeDirty');
	assert.equal(error.status, 422);
	assert.equal(error.code, 'WorkTreeDirty');
	assert.throws(() => gitError('NotACode'), /Unknown git error code/);
});

test('branch names that git would misread as an option or a ref expression are refused', () => {
	for (const name of ['main', 'feat/git-integration', 'release-1.2', 'a_b.c']) {
		assert.equal(requireBranchName(name), name);
	}
	for (const name of ['', '-x', '--upload-pack=evil', '/lead', 'trail/', 'a..b', 'a b', 'a~1', 'a^', 'a:b', 'a?b', 'a*b', 'a[b', 'HEAD', 'x@{0}', 'a//b', 'trail.', 'a\x00b', 'a\nb']) {
		assert.throws(() => requireBranchName(name), error => error.code === 'InvalidBranch', 'accepted ' + JSON.stringify(name));
	}
	assert.equal(requireBranchName('anything', 'InvalidRequest').toString, String.prototype.toString);
	assert.throws(() => requireBranchName('', 'InvalidRequest'), error => error.code === 'InvalidRequest');
});

test('commit ids must be a full lowercase sha', () => {
	assert.equal(isCommitSha('a'.repeat(40)), true);
	assert.equal(isCommitSha('A'.repeat(40)), false);
	assert.equal(isCommitSha('a'.repeat(39)), false);
	assert.equal(isCommitSha('a'.repeat(41)), false);
	assert.throws(() => requireCommitSha('HEAD'), error => error.code === 'InvalidCommit');
});

test('checkpoint names are trimmed and stripped of control characters', () => {
	assert.equal(normalizeCheckpointName('  v1.0  '), 'v1.0');
	assert.throws(() => normalizeCheckpointName(''), error => error.code === 'InvalidName');
	assert.throws(() => normalizeCheckpointName('x'.repeat(121)), error => error.code === 'InvalidName');
	assert.throws(() => normalizeCheckpointName(undefined), error => error.code === 'InvalidName');
});

test('remote URLs are parsed into transports and never keep their userinfo', () => {
	assert.equal(parseGitRemote('https://example.com/x.git').kind, 'https');
	assert.equal(parseGitRemote('ssh://git@example.com:22/x.git').kind, 'ssh');
	assert.equal(parseGitRemote('git@example.com:x.git').kind, 'ssh');
	assert.equal(parseGitRemote('/srv/git/x.git').kind, 'file');
	// A token embedded in an HTTPS remote must not survive into the stored URL.
	const withToken = parseGitRemote('https://user:ghp_' + 'a'.repeat(36) + '@example.com/x.git');
	assert.equal(withToken.url.includes('ghp_'), false);
	assert.equal(withToken.url.includes('user'), false);
	assert.equal(withToken.userinfo.startsWith('user:'), true);
	// `ext::` is a remote code execution transport and is not in the scheme list.
	assert.throws(() => parseGitRemote('ext::sh -c touch%/tmp/pwned'), error => error.code === 'InvalidRemote');
	assert.throws(() => parseGitRemote('fd::7'), error => error.code === 'InvalidRemote');
	assert.throws(() => parseGitRemote('relative/path.git'), error => error.code === 'InvalidRemote');
	assert.throws(() => parseGitRemote('https://example.com/x .git'), error => error.code === 'InvalidRemote');
	assert.throws(() => parseGitRemote(''), error => error.code === 'InvalidRemote');
	assert.throws(() => parseGitRemote('x'.repeat(2049)), error => error.code === 'InvalidRemote');
	// Plain http is only for loopback, so a remote can never downgrade to cleartext.
	assert.equal(parseGitRemote('http://127.0.0.1:8080/x.git').kind, 'http');
	assert.throws(() => parseGitRemote('http://example.com/x.git'), error => error.code === 'InvalidRemote');
});

test('the remote identity is a stable hash, not the URL', () => {
	const id = remoteIdentity('/srv/git/x.git');
	assert.equal(id, remoteIdentity('/srv/git/x.git'));
	assert.notEqual(id, remoteIdentity('/srv/git/y.git'));
	assert.equal(/^[0-9a-f]{16}$/.test(id), true);
	const url = '/srv/git/x.git';
	assert.equal(id === url, false);
});

test('the protocol allowlist is https and ssh unless file was proven safe', () => {
	assert.equal(gitAllowedProtocols(), 'https:ssh');
	assert.equal(gitAllowedProtocols({ allowFile: true }), 'https:ssh:file');
	assert.equal(gitAllowedProtocols({ allowLoopbackHttp: true }), 'https:ssh:http');
	// Never present, in any configuration: ext, fd, and the unauthenticated git://.
	for (const allowFile of [false, true]) {
		const list = gitAllowedProtocols({ allowFile });
		assert.equal(list.split(':').includes('ext'), false);
		assert.equal(list.split(':').includes('fd'), false);
		assert.equal(list.split(':').includes('git'), false);
	}
});

test('git argv always carries the config overrides before the subcommand', async () => {
	const argv = await gitArgv(['status', '--porcelain=v2'], [['credential.helper', '']]);
	assert.equal(argv[0], 'git');
	// The pins come first so a value stored in the repository's own config cannot win.
	const pairs = {};
	for (let index = 1; index < argv.length - 2; index += 2) {
		if (argv[index] === '-c') {
			const [key, value] = argv[index + 1].split('=');
			pairs[key] = value;
		}
	}
	assert.equal(pairs['core.fsmonitor'], 'false');
	assert.equal(pairs['uploadpack.packObjectsHook'], '');
	assert.equal(pairs['core.pager'], 'cat');
	assert.equal(typeof pairs['core.hooksPath'], 'string');
	assert.equal(pairs['credential.helper'], '');
	assert.equal(argv.at(-2), 'status');
	assert.equal(argv.at(-1), '--porcelain=v2');
});

test('configured roots are exclusive to a workspace, including their resolved paths', async t => {
	const root = await mkdtemp(join(tmpdir(), 'log4stellar-git-roots-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	const a = join(root, 'a');
	const b = join(root, 'b');
	const alias = join(root, 'alias');
	await Promise.all([mkdir(a), mkdir(b)]);
	await symlink(a, alias);
	const settings = entries => ({ LOG4STELLAR_GIT_WORKSPACE_ROOTS: JSON.stringify(entries) });
	const unconfigured = error => error.code === 'GitNotConfigured';
	assert.deepEqual(await gitRoots(settings({ a: [a], b: [b] }), 'a'), [a]);
	await assert.rejects(gitRoots(settings({ b: [b] }), 'a'), unconfigured);
	await assert.rejects(gitRoots(settings({ a: [a], b: [alias] }), 'a'), unconfigured);
	await assert.rejects(gitRoots(settings({ a: [a], b: [root] }), 'a'), unconfigured);
	await assert.rejects(gitRoots(settings({ a: ['relative/path'] }), 'a'), unconfigured);
	await assert.rejects(gitRoots({}, 'a'), unconfigured);
});

test('git diagnostics are scrubbed before they reach a response or a log', () => {
	const remote = 'https://example.com/team/repo.git';
	const token = 'ghp_' + 'A'.repeat(36);
	const raw = [
		"fatal: could not read from '" + remote + "?access_token=" + token + "'",
		'remote: Authentication failed for ' + remote,
		'error: pathspec /srv/git/private/repo did not match',
		'\x1b[31merror:\x1b[0m unable to access',
		'Authorization: Bearer ' + token,
		'-----BEGIN OPENSSH PRIVATE KEY-----',
	].join('\n');
	const text = sanitizeGitMessage(raw, { remoteUrl: remote, localPath: '/srv/git/private/repo' });
	assert.equal(text.includes(remote), false);
	assert.equal(text.includes('access_token'), false);
	assert.equal(text.includes(token), false);
	assert.equal(text.includes('/srv/git/private/repo'), false);
	assert.equal(text.includes('\x1b['), false);
	assert.equal(text.includes('BEGIN OPENSSH PRIVATE KEY'), false);
	// A bare `file://` URL is scrubbed even when the caller did not pass it explicitly.
	assert.equal(sanitizeGitMessage('fatal: file:///srv/secret/x.git not found').includes('/srv/secret/x.git'), false);
	assert.equal(sanitizeGitMessage(undefined), '');
	assert.equal(sanitizeGitMessage('a'.repeat(1000)).length <= 400, true);
});

test('paging limits are validated, not trusted', () => {
	assert.equal(normalizeGitLimit(undefined), gitPageLimits.defaultLogSize);
	assert.equal(normalizeGitLimit('25'), 25);
	assert.equal(normalizeGitLimit(10_000), gitPageLimits.maxLogSize);
	assert.throws(() => normalizeGitLimit('0'), error => error.code === 'InvalidRequest');
	assert.throws(() => normalizeGitLimit('-1'), error => error.code === 'InvalidRequest');
	assert.throws(() => normalizeGitLimit('many'), error => error.code === 'InvalidRequest');
	assert.throws(() => normalizeGitLimit('1.5'), error => error.code === 'InvalidRequest');
});
