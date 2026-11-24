import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
	classifyRemoteFailure,
	fetchRemote,
	gitArgumentGuards,
	openGitRepository,
	pushBranch,
	readBranches,
	readLog,
	readRemoteHead,
	readStatus,
	runGit,
	switchBranch,
} from './git-repository.mjs';
import { gitRoots, parseGitRemote, resolveWithinRoot } from './git-contract.mjs';

// Everything in this file runs against real `git` and throwaway directories under /tmp; it
// needs neither PostgreSQL nor the network. It is the proof file for the four hard security
// constraints of docs/git-integration.md §5.4/§5.5: the four-layer path check, the pinned
// `core.hooksPath`, the protocol allowlist, and the subprocess timeout.

const gitEnv = {
	...process.env,
	GIT_AUTHOR_NAME: 'Test',
	GIT_AUTHOR_EMAIL: 'test@example.invalid',
	GIT_COMMITTER_NAME: 'Test',
	GIT_COMMITTER_EMAIL: 'test@example.invalid',
	GIT_CONFIG_NOSYSTEM: '1',
};

/** Runs plain git (no service pins) — used to build fixtures and to prove a control case. */
function plain(args, cwd) {
	return new Promise((resolve, reject) => {
		const child = spawn('git', args, { cwd, env: gitEnv, stdio: ['ignore', 'pipe', 'pipe'] });
		const out = [];
		const err = [];
		child.stdout.on('data', chunk => out.push(chunk));
		child.stderr.on('data', chunk => err.push(chunk));
		child.once('error', reject);
		child.once('close', code => resolve({
			code,
			stdout: Buffer.concat(out).toString('utf8').trim(),
			stderr: Buffer.concat(err).toString('utf8').trim(),
		}));
	});
}

async function makeRoot() {
	return mkdtemp(join(tmpdir(), 'l4s-git-test-'));
}

/** A work-tree repository with one commit and a `main` branch. */
async function makeRepository(root, name, { branch = 'main' } = {}) {
	const path = join(root, name);
	await mkdir(path, { recursive: true });
	await plain(['init', '--quiet', '--initial-branch=' + branch], path);
	await writeFile(join(path, 'README.md'), '# ' + name + '\n');
	await plain(['add', '.'], path);
	await plain(['commit', '--quiet', '-m', 'initial commit'], path);
	return path;
}

async function makeBare(root, name, { branch = 'main' } = {}) {
	const path = join(root, name + '.git');
	await mkdir(path, { recursive: true });
	await plain(['init', '--quiet', '--bare'], path);
	// A bare remote's HEAD decides what a `clone` checks out; pin it so the fixtures
	// behave like a normal remote instead of an unborn `master`.
	await plain(['symbolic-ref', 'HEAD', 'refs/heads/' + branch], path);
	return path;
}

async function commitFile(repo, file, content, message) {
	await writeFile(join(repo, file), content);
	await plain(['add', '--', file], repo);
	await plain(['commit', '--quiet', '-m', message], repo);
}

async function headOf(repo, ref = 'HEAD') {
	const result = await plain(['rev-parse', ref], repo);
	return result.stdout;
}

const cleanups = [];
test.after(async () => {
	await Promise.all(cleanups.map(path => rm(path, { recursive: true, force: true })));
});

async function root() {
	const path = await makeRoot();
	cleanups.push(path);
	return path;
}

// ---------------------------------------------------------------- four-layer path validation

test('a path outside every configured root is refused before git is ever asked', async () => {
	const allowed = await root();
	const other = await root();
	await makeRepository(other, 'repo');
	await assert.rejects(
		openGitRepository(join(other, 'repo'), [allowed]),
		error => error.code === 'InvalidPath' && error.status === 400,
	);
});

test('a `..` escape is refused even when it resolves inside a root by accident', async () => {
	const allowed = await root();
	await makeRepository(allowed, 'repo');
	// The literal string escapes the root and then comes back: the contract refuses the
	// traversal instead of normalizing it into an acceptable path.
	assert.throws(() => resolveWithinRoot([allowed], '../' + allowed.split('/').pop() + '/repo'), error => error.code === 'InvalidPath');
	assert.throws(
		() => resolveWithinRoot([allowed], join(allowed, '..', 'elsewhere')),
		error => error.code === 'InvalidPath',
	);
});

test('a symlink that points outside the root is refused after realpath', async () => {
	const allowed = await root();
	const outside = await root();
	await makeRepository(outside, 'secret');
	// Stage 2 of §5.4: the requested path is inside the root, but its real target is not.
	await symlink(join(outside, 'secret'), join(allowed, 'escape'));
	await assert.rejects(
		openGitRepository(join(allowed, 'escape'), [allowed]),
		error => error.code === 'InvalidPath',
	);
});

test('a `.git` file that redirects the git directory outside the root is refused', async () => {
	const allowed = await root();
	const outside = await root();
	const victim = await makeRepository(outside, 'victim');
	// A hand written `.git` *file* is the documented gitfile escape: `--absolute-git-dir`
	// follows it outside the root, so the fourth layer must re-check the result.
	const fake = join(allowed, 'fake');
	await mkdir(fake, { recursive: true });
	await writeFile(join(fake, '.git'), 'gitdir: ' + join(victim, '.git') + '\n');
	await assert.rejects(
		openGitRepository(fake, [allowed]),
		error => error.code === 'InvalidPath',
	);
});

test('a directory inside the root that is not a repository is 422 NotARepository', async () => {
	const allowed = await root();
	await mkdir(join(allowed, 'plain'), { recursive: true });
	await assert.rejects(
		openGitRepository(join(allowed, 'plain'), [allowed]),
		error => error.code === 'NotARepository' && error.status === 422,
	);
	// A bare repository is a valid remote but not a valid workspace binding (§1.4).
	const bare = await makeBare(allowed, 'remote');
	const opened = await openGitRepository(bare, [allowed]);
	assert.equal(opened.bare, true);
});

test('a legitimate repository inside the root is accepted and exposes its state', async () => {
	const allowed = await root();
	const repo = await makeRepository(allowed, 'repo');
	const opened = await openGitRepository(repo, [allowed]);
	assert.equal(opened.bare, false);
	assert.equal(opened.root, allowed);
	assert.equal(opened.path, repo);
	// The caller must not receive the absolute path in a response; it is reported relative.
	assert.equal(opened.path.startsWith(opened.root), true);
});

// ---------------------------------------------------------------- pinned core.hooksPath

test('a repository pre-push hook never runs, while the same hook runs without the pin', async () => {
	const allowed = await root();
	const repo = await makeRepository(allowed, 'repo');
	const remote = await makeBare(allowed, 'remote');
	const marker = join(allowed, 'hook-ran');
	const hooks = join(repo, '.git', 'hooks');
	await writeFile(join(hooks, 'pre-push'), '#!/bin/sh\ntouch ' + marker + '\n');
	await chmod(join(hooks, 'pre-push'), 0o755);

	const handle = await openGitRepository(repo, [allowed]);
	await pushBranch(handle, { url: remote, branch: 'main', allowFile: true });
	// §5.5: `core.hooksPath` points at an empty directory we own, so a repository's own
	// hook is not even looked up. This is the assertion that the pin is real, not cosmetic.
	assert.equal(existsSync(marker), false);

	// Control: the very same hook does run under plain `git push`, which proves the test
	// above is not passing because the hook was broken.
	const control = await plain(['push', remote, 'HEAD:refs/heads/control'], repo);
	assert.equal(control.code, 0, control.stderr);
	assert.equal(existsSync(marker), true);
});

test('the temporary hooks directory does not survive the process that created it', async () => {
	// §5.6: a long-lived service creates exactly one hooks directory and one scratch
	// directory. Leaving them behind on exit is how a hundred `l4s-git-hooks-*` entries
	// piled up in /tmp during development, so the cleanup is pinned by a real exit.
	const script = `
		const { gitHooksDirectory } = await import(${JSON.stringify(new URL('./git-repository.mjs', import.meta.url).href)});
		process.stdout.write(await gitHooksDirectory());
	`;
	const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
		env: { ...process.env, TMPDIR: tmpdir() },
		stdio: ['ignore', 'pipe', 'inherit'],
	});
	const directory = await new Promise((resolve, reject) => {
		const out = [];
		child.stdout.on('data', chunk => out.push(chunk));
		child.once('error', reject);
		child.once('close', code => (code === 0 ? resolve(Buffer.concat(out).toString('utf8').trim()) : reject(new Error('child exited ' + code))));
	});
	assert.match(directory, /l4s-git-hooks-/);
	// A short grace period: the exit hook runs synchronously, but the kernel may still be
	// finishing the unlink when the child's `close` event reaches us.
	for (let attempt = 0; attempt < 50 && existsSync(directory); attempt++) {
		await new Promise(resolve => setTimeout(resolve, 20));
	}
	assert.equal(existsSync(directory), false, 'the hooks directory leaked: ' + directory);
});

test('the dangerous config keys are pinned ahead of the repository config', async () => {
	const guards = await gitArgumentGuards();
	assert.equal(guards.some(entry => entry[0] === 'core.hooksPath'), true);
	const keys = guards.map(entry => entry[0]);
	for (const key of ['core.fsmonitor', 'uploadpack.packObjectsHook', 'core.pager', 'core.sshCommand']) {
		assert.equal(keys.includes(key), true, 'missing pin for ' + key);
	}
	// A repository may set `core.sshCommand` in its own config; the pinned value must win
	// because the pins are emitted before the caller's config and before the subcommand.
	const { gitArgv } = await import('./git-repository.mjs');
	const argv = await gitArgv(['fetch'], [['core.sshCommand', 'false']]);
	const hookIndex = argv.indexOf('core.hooksPath=' + guards.find(entry => entry[0] === 'core.hooksPath')[1]);
	assert.ok(hookIndex > 0);
	assert.ok(argv.indexOf('core.fsmonitor=false') < hookIndex);
	// The caller's value comes last, so git lets it override the pin — which is why the
	// only caller allowed to set these keys is the credential path itself.
	assert.deepEqual(argv.slice(-3), ['-c', 'core.sshCommand=false', 'fetch']);
});

// ---------------------------------------------------------------- protocol allowlist

test('an argument carrying shell metacharacters reaches git as one literal argv entry', async () => {
	const allowed = await root();
	const repo = await makeRepository(allowed, 'repo');
	const victim = join(allowed, 'injected');
	// If anything ever joined the argv into a string and handed it to a shell, this
	// would create the file. Recorded spawn options also prove there is no `shell: true`.
	const seen = [];
	const recordingSpawn = (command, args, options) => {
		seen.push({ command, args, options });
		return spawn(command, args, options);
	};
	const result = await runGit(['rev-parse', '--verify', '--quiet', 'x; touch ' + victim], {
		cwd: repo,
		run: recordingSpawn,
	});
	assert.notEqual(result.code, 0, 'a nonsense ref must not resolve');
	assert.equal(existsSync(victim), false, 'the metacharacters were executed by a shell');
	assert.equal(seen.length, 1);
	assert.equal(seen[0].command, 'git');
	assert.equal(Array.isArray(seen[0].args), true);
	// The whole hostile string is a single element of the array, not three.
	assert.equal(seen[0].args.includes('x; touch ' + victim), true);
	assert.equal(Object.hasOwn(seen[0].options ?? {}, 'shell'), false);
	// And the argv builder never folds the subcommand into one string either.
	assert.equal((await runGit(['--version'], { cwd: repo })).argv.at(-1), '--version');
});

test('an ext:: transport helper cannot be pushed to and never executes its payload', async () => {
	const allowed = await root();
	const repo = await makeRepository(allowed, 'repo');
	const handle = await openGitRepository(repo, [allowed]);
	const victim = join(allowed, 'pwned');
	const payload = 'sh -c "touch ' + victim + '"';
	// Two independent layers, both pinned by their own assertion. First the request
	// contract refuses to parse a transport helper at all: `ext::` is not a scheme we
	// accept, so the service never even reaches git with it.
	assert.throws(() => parseGitRemote('ext::' + payload), error => error.code === 'InvalidRemote');
	// Second, in case a caller passes a raw url straight to the repository module (which
	// is what the test asserts below), the protocol allowlist stops git from expanding it.
	await assert.rejects(
		pushBranch(handle, { url: 'ext::' + payload, branch: 'main', allowFile: false }),
		error => error.code === 'RemoteUnavailable'
			&& error.status === 502
			&& /transport 'ext' not allowed/.test(String(error.detail)),
	);
	// The payload's only job was to create this file; it must not exist.
	assert.equal(existsSync(victim), false);
});

test('a file:// remote outside the roots is refused even though file is a legal scheme', async () => {
	const allowed = await root();
	const repo = await makeRepository(allowed, 'repo');
	const handle = await openGitRepository(repo, [allowed]);
	// `allowFile: false` is what the service passes when the remote did not pass the
	// four-layer check; /etc is obviously outside every root. The refusal has to be the
	// allowlist itself, so the code is pinned to 502 and the detail names the transport.
	await assert.rejects(
		fetchRemote(handle, { url: 'file:///etc/passwd', allowFile: false }),
		error => error.code === 'RemoteUnavailable'
			&& error.status === 502
			&& /transport 'file' not allowed/.test(String(error.detail)),
	);
	// Positive control: the very same transport is permitted once the caller proves the
	// remote is a repository inside the root, which shows the refusal above is the
	// allowlist and not an accident of /etc not being a repository.
	const remote = await makeBare(allowed, 'inside-remote');
	await pushBranch(handle, { url: remote, branch: 'main', allowFile: true });
	assert.equal(await readRemoteHead(handle, { url: remote, branch: 'main', allowFile: true }), await headOf(repo));
	// And with the check skipped it is refused even though the path is a valid repository.
	await assert.rejects(
		fetchRemote(handle, { url: remote, allowFile: false }),
		error => error.code === 'RemoteUnavailable' && /transport 'file' not allowed/.test(String(error.detail)),
	);
});

test('the allowlist is exactly https and ssh for a remote that did not pass the path check', async () => {
	// Verified through the environment the real calls use: `git://` (unauthenticated) and
	// `ext::` are never present.
	const { gitAllowedProtocols } = await import('./git-repository.mjs');
	assert.deepEqual(gitAllowedProtocols().split(':').sort(), ['https', 'ssh']);
});

// ---------------------------------------------------------------- timeout

test('a hanging git process is killed and reported as 504 RemoteTimeout', async () => {
	let childPid;
	const fakeRun = (command, args, options) => {
		// A real child process that never finishes playing git, so the timeout path is
		// exercised against the same spawn/kill machinery production uses.
		const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], options);
		childPid = child.pid;
		return child;
	};
	const started = Date.now();
	const result = await runGit(['fetch', 'https://example.com/x.git'], { run: fakeRun, timeoutMs: 300 });
	assert.equal(result.timedOut, true);
	assert.equal(result.signal, 'SIGKILL');
	assert.ok(Date.now() - started < 5000);
	// The child must actually be gone, not merely abandoned by the promise.
	await new Promise(resolve => setTimeout(resolve, 100));
	assert.equal(existsSync('/proc/' + childPid), false, 'the killed child is still running');
});

// ---------------------------------------------------------------- status, log, branches

test('status reports a clean tree, then the individual modifications of a dirty one', async () => {
	const allowed = await root();
	const repo = await makeRepository(allowed, 'repo');
	const handle = await openGitRepository(repo, [allowed]);

	const clean = await readStatus(handle);
	assert.equal(clean.clean, true);
	assert.deepEqual(clean.entries, []);
	assert.equal(clean.branch, 'main');

	await writeFile(join(repo, 'README.md'), '# changed\n');
	await writeFile(join(repo, 'untracked.md'), 'new\n');
	const dirty = await readStatus(handle);
	assert.equal(dirty.clean, false);
	const paths = dirty.entries.map(entry => entry.path).sort();
	assert.deepEqual(paths, ['README.md', 'untracked.md']);
	assert.equal(dirty.entries.find(entry => entry.path === 'README.md').workTree, 'M');
});

test('log and branches report the real history', async () => {
	const allowed = await root();
	const repo = await makeRepository(allowed, 'repo');
	await commitFile(repo, 'a.txt', 'a\n', 'second commit');
	await plain(['branch', 'side'], repo);
	const handle = await openGitRepository(repo, [allowed]);

	const log = await readLog(handle, { limit: 10 });
	assert.equal(log.length, 2);
	assert.equal(log[0].subject, 'second commit');
	assert.equal(log[1].subject, 'initial commit');
	assert.equal(/^[0-9a-f]{40}$/.test(log[0].commit), true);

	const branches = await readBranches(handle);
	assert.deepEqual(branches.map(entry => entry.name).sort(), ['main', 'side']);
	assert.equal(branches.find(entry => entry.current).name, 'main');
});

// ---------------------------------------------------------------- branch switching

test('switching to a branch whose checkout would overwrite local changes is 422, and the tree is untouched', async () => {
	const allowed = await root();
	const repo = await makeRepository(allowed, 'repo');
	await plain(['switch', '--quiet', '--create', 'side'], repo);
	await commitFile(repo, 'shared.txt', 'side version\n', 'side changes shared.txt');
	await plain(['switch', '--quiet', 'main'], repo);
	await writeFile(join(repo, 'shared.txt'), 'main version\n');
	await plain(['add', 'shared.txt'], repo);
	await plain(['commit', '--quiet', '-m', 'main changes shared.txt'], repo);
	// Now the two branches differ in the same file; a dirty edit of it blocks the switch.
	await writeFile(join(repo, 'shared.txt'), 'uncommitted local edit\n');

	const before = await readFile(join(repo, 'shared.txt'), 'utf8');
	const statusBefore = await plain(['status', '--porcelain'], repo);
	const handle = await openGitRepository(repo, [allowed]);
	await assert.rejects(
		switchBranch(handle, 'side'),
		error => {
			assert.equal(error.code, 'WorkTreeDirty');
			assert.equal(error.status, 422);
			assert.deepEqual(error.conflicts, ['shared.txt']);
			return true;
		},
	);
	// §8.3 of the acceptance matrix: the working tree is byte-identical afterwards.
	assert.equal(await readFile(join(repo, 'shared.txt'), 'utf8'), before);
	assert.equal((await plain(['status', '--porcelain'], repo)).stdout, statusBefore.stdout);
	assert.equal((await plain(['rev-parse', '--abbrev-ref', 'HEAD'], repo)).stdout, 'main');
});

test('a successful switch changes HEAD and the reported status together', async () => {
	const allowed = await root();
	const repo = await makeRepository(allowed, 'repo');
	await plain(['switch', '--quiet', '--create', 'side'], repo);
	await commitFile(repo, 'side.txt', 'side\n', 'side commit');
	const sideHead = await headOf(repo);
	await plain(['switch', '--quiet', 'main'], repo);
	const handle = await openGitRepository(repo, [allowed]);

	const status = await switchBranch(handle, 'side');
	assert.equal(status.branch, 'side');
	assert.equal(status.clean, true);
	// The service must agree with the real repository, not with its own bookkeeping.
	assert.equal(await headOf(repo), sideHead);
	assert.equal(await plain(['rev-parse', '--abbrev-ref', 'HEAD'], repo).then(result => result.stdout), 'side');
	const branches = await readBranches(handle);
	assert.equal(branches.find(entry => entry.current).name, 'side');
});

test('switching to a ref that does not exist is 404 BranchNotFound, creating an existing one is 409', async () => {
	const allowed = await root();
	const repo = await makeRepository(allowed, 'repo');
	const handle = await openGitRepository(repo, [allowed]);
	await assert.rejects(
		switchBranch(handle, 'no-such-branch'),
		error => error.code === 'BranchNotFound' && error.status === 404,
	);
	await assert.rejects(
		switchBranch(handle, 'main', { create: true }),
		error => error.code === 'BranchExists' && error.status === 409,
	);
});

// ---------------------------------------------------------------- remote round trips

test('a fetch brings remote commits into refs/remotes/origin without touching the working tree', async () => {
	const allowed = await root();
	const repo = await makeRepository(allowed, 'repo');
	const remote = await makeBare(allowed, 'remote');
	await plain(['push', '--quiet', remote, 'main:refs/heads/main'], repo);
	// A second clone advances the remote behind our back.
	const other = join(allowed, 'other');
	await plain(['clone', '--quiet', remote, other], allowed);
	await commitFile(other, 'remote-only.txt', 'x\n', 'remote commit');
	await plain(['push', '--quiet', remote, 'main:refs/heads/main'], other);
	const remoteHead = await plain(['rev-parse', 'refs/heads/main'], remote);

	const handle = await openGitRepository(repo, [allowed]);
	await fetchRemote(handle, { url: remote, allowFile: true });
	const tracking = await plain(['rev-parse', 'refs/remotes/origin/main'], repo);
	assert.equal(tracking.stdout, remoteHead.stdout);
	// Fetch must not have moved the local branch or written to the index.
	assert.equal(await headOf(repo), await plain(['rev-parse', 'main'], repo).then(result => result.stdout));
	assert.equal((await readStatus(handle)).clean, true);
});

test('a push advances the remote, and a non-fast-forward push is refused without moving the ref', async () => {
	const allowed = await root();
	const repo = await makeRepository(allowed, 'repo');
	const remote = await makeBare(allowed, 'remote');
	const handle = await openGitRepository(repo, [allowed]);

	await pushBranch(handle, { url: remote, branch: 'main', allowFile: true });
	const afterFirst = await plain(['rev-parse', 'refs/heads/main'], remote);
	assert.equal(afterFirst.stdout, await headOf(repo));
	assert.equal(await readRemoteHead(handle, { url: remote, branch: 'main', allowFile: true }), afterFirst.stdout);

	// Another actor rewrites the remote branch.
	const other = join(allowed, 'other');
	await plain(['clone', '--quiet', remote, other], allowed);
	await commitFile(other, 'theirs.txt', 'theirs\n', 'diverging commit');
	await plain(['push', '--quiet', remote, 'main:refs/heads/main'], other);
	const remoteHeadBefore = (await plain(['rev-parse', 'refs/heads/main'], remote)).stdout;
	assert.notEqual(remoteHeadBefore, afterFirst.stdout);

	// Our local commit is not a descendant of the new remote head.
	await commitFile(repo, 'ours.txt', 'ours\n', 'our own commit');
	await assert.rejects(
		pushBranch(handle, { url: remote, branch: 'main', allowFile: true }),
		error => error.code === 'NotFastForward' && error.status === 409,
	);
	// §8.2 of the acceptance matrix: the remote ref did not move.
	assert.equal((await plain(['rev-parse', 'refs/heads/main'], remote)).stdout, remoteHeadBefore);
});

test('an unreachable remote is 502 RemoteUnavailable and never 401/403', async () => {
	const allowed = await root();
	const repo = await makeRepository(allowed, 'repo');
	const handle = await openGitRepository(repo, [allowed]);
	const missing = join(allowed, 'no-such-remote.git');
	await assert.rejects(
		fetchRemote(handle, { url: missing, allowFile: true }),
		error => {
			assert.equal(error.code, 'RemoteUnavailable');
			// The whole point of the mapping: a transport failure is not an auth failure of
			// the note service, so it must not surface as 401 or 403.
			assert.equal(error.status, 502);
			assert.notEqual(error.status, 401);
			assert.notEqual(error.status, 403);
			// The absolute local path of the remote is scrubbed out of the detail.
			assert.equal(error.detail.includes(missing), false);
			return true;
		},
	);
});

test('connection-level failures are classified as remote problems, never as our own 500', () => {
	// Verbatim git 2.43.0 stderr, captured by pointing a bound repository at
	// https://127.0.0.1:9 during the acceptance walkthrough (docs/git-integration.md §8.1).
	const cases = [
		["fatal: unable to access 'https://127.0.0.1:9/none.git/': Failed to connect to 127.0.0.1 port 9 after 0 ms: Couldn't connect to server", 'RemoteUnavailable'],
		["ssh: connect to host 127.0.0.1 port 1: Connection refused\nfatal: Could not read from remote repository.", 'RemoteUnavailable'],
		["fatal: '/gone/app.git' does not appear to be a git repository\nfatal: Could not read from remote repository.", 'RemoteUnavailable'],
		["fatal: unable to access 'https://example.invalid/x.git/': Could not resolve host: example.invalid", 'RemoteUnavailable'],
		["remote: Invalid username or password.\nfatal: Authentication failed for 'https://example.invalid/x.git/'", 'RemoteAuthenticationFailed'],
		["git@example.invalid: Permission denied (publickey).\nfatal: Could not read from remote repository.", 'RemoteAuthenticationFailed'],
	];
	for (const [stderr, expected] of cases) {
		const error = classifyRemoteFailure({ code: 128, stderr, stdout: '', timedOut: false }, {});
		assert.equal(error.code, expected, stderr);
		assert.equal(error.status, 502, stderr);
	}
	// A failure that is genuinely ours (not a transport problem) stays a 500.
	assert.equal(classifyRemoteFailure({ code: 1, stderr: 'fatal: bad object HEAD', stdout: '', timedOut: false }, {}).code, 'GitFailed');
});

test('a remote that exists but denies access is reported as a remote failure, not as ours', async () => {
	const allowed = await root();
	const repo = await makeRepository(allowed, 'repo');
	const remote = await makeBare(allowed, 'locked');
	await plain(['push', '--quiet', remote, 'main:refs/heads/main'], repo);
	await chmod(remote, 0o000);
	try {
		const handle = await openGitRepository(repo, [allowed]);
		await assert.rejects(
			fetchRemote(handle, { url: remote, allowFile: true }),
			error => error.status === 502 && ['RemoteUnavailable', 'RemoteAuthenticationFailed'].includes(error.code),
		);
	} finally {
		await chmod(remote, 0o755);
	}
});

test('pushBranch refuses a stale expectedRemote with 412 before trying', async () => {
	const allowed = await root();
	const repo = await makeRepository(allowed, 'repo');
	const remote = await makeBare(allowed, 'remote');
	const handle = await openGitRepository(repo, [allowed]);
	// Nothing has been pushed yet, so a precondition that names a commit cannot hold.
	await assert.rejects(
		pushBranch(handle, { url: remote, branch: 'main', expectedRemote: 'a'.repeat(40), allowFile: true }),
		error => error.code === 'RemoteChanged' && error.status === 412,
	);
	// `expectedRemote: null` means "the branch must not exist on the remote yet".
	await pushBranch(handle, { url: remote, branch: 'main', expectedRemote: null, allowFile: true });
	assert.equal((await plain(['rev-parse', 'refs/heads/main'], remote)).stdout, await headOf(repo));
});

test('pushBranch sends the selected commit even when HEAD advances', async () => {
	const allowed = await root();
	const repository = await makeRepository(allowed, 'repo');
	const remote = await makeBare(allowed, 'remote');
	const handle = await openGitRepository(repository, [allowed]);
	const selected = await headOf(repository);
	await commitFile(repository, 'later.txt', 'later\n', 'A later commit');
	await pushBranch(handle, { url: remote, branch: 'main', commit: selected, expectedRemote: null, allowFile: true });
	assert.equal(await headOf(remote, 'refs/heads/main'), selected);
	assert.notEqual(await headOf(repository), selected);
});
