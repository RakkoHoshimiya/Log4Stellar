// The only module in the Git integration that starts a child process. Every call
// goes through `runGit`, which fixes the argv shape once and for all:
//
//   git -c <override>... <command> <args...>
//
// Two rules are absolute (docs/git-integration.md §5.5): the argument vector is
// always an array — nothing is ever concatenated into a shell string — and the
// repository cannot influence how git runs, because `core.hooksPath` points at an
// empty directory we own and the dangerous config keys are pinned by `-c`.

import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitError, isInsideRoot, locateRepositoryPath, sanitizeGitMessage } from './git-contract.mjs';

export const gitCommand = 'git';

// §5.5. Applied to every invocation, before the subcommand, so a value stored in
// the repository's own config can never win. `core.hooksPath` is filled in once
// the empty hooks directory exists.
const pinnedConfig = Object.freeze([
	['core.fsmonitor', 'false'],
	['uploadpack.packObjectsHook', ''],
	['core.pager', 'cat'],
	['safe.directory', '*'],
	// A repository's own config may not choose the transport program: without this
	// pin `core.sshCommand` would be a "run any command as the service" primitive
	// on the next fetch. The credential path appends its own `core.sshCommand`
	// later, and a later `-c` wins.
	['core.sshCommand', 'ssh'],
]);

const defaultTimeoutMs = 60_000;
const maxOutputBytes = 8 * 1024 * 1024;

let hooksDirectoryPromise;
let workDirectoryPromise;

// §5.6: the service is long-lived and each process creates one hooks directory and
// one scratch directory. Without this hook every start leaves both behind in /tmp,
// which is how a hundred `l4s-git-hooks-*` directories accumulated during development.
function removeOnExit(directory) {
	process.once('exit', () => {
		try {
			rmSync(directory, { recursive: true, force: true });
		} catch {
			// The process is going away; a leftover temp directory must not turn into a
			// shutdown error.
		}
	});
	return directory;
}

/** An empty directory used as `core.hooksPath`: no repository hook ever runs. */
export async function gitHooksDirectory() {
	if (!hooksDirectoryPromise) {
		hooksDirectoryPromise = mkdtemp(join(tmpdir(), 'l4s-git-hooks-')).then(removeOnExit).catch(error => {
			hooksDirectoryPromise = undefined;
			throw error;
		});
	}
	return hooksDirectoryPromise;
}

async function privateWorkDirectory() {
	if (!workDirectoryPromise) {
		workDirectoryPromise = mkdtemp(join(tmpdir(), 'l4s-git-work-')).then(removeOnExit).catch(error => {
			workDirectoryPromise = undefined;
			throw error;
		});
	}
	return workDirectoryPromise;
}

/** Test seam: forget the cached directories so a temp-dir assertion can rerun. */
export function resetGitTemporaryState() {
	hooksDirectoryPromise = undefined;
	workDirectoryPromise = undefined;
}

/**
 * The protocol allowlist of §5.5. `ext::` and `fd::` are never in it, and neither
 * is `file` unless the caller has already proven the remote lives inside an
 * allowed root. `git://` is refused outright (§5.5): unauthenticated and
 * unencrypted.
 */
export function gitAllowedProtocols({ allowFile = false, allowLoopbackHttp = false } = {}) {
	const protocols = ['https', 'ssh'];
	if (allowLoopbackHttp) {
		protocols.push('http');
	}
	if (allowFile) {
		protocols.push('file');
	}
	return protocols.join(':');
}

export function gitEnvironment(extra = {}) {
	return {
		...extra,
		// Pinned environment. A caller cannot widen this by accident because it is
		// rebuilt from scratch on every call, not merged into process.env.
		PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
		LANG: 'C',
		LC_ALL: 'C',
		// Never prompt: a prompt would sit on the socket until the timeout fires.
		GIT_TERMINAL_PROMPT: '0',
		SSH_ASKPASS_REQUIRE: 'never',
		// Ignore /etc/gitconfig and the service account's own dotfiles.
		GIT_CONFIG_NOSYSTEM: '1',
		GIT_ATTR_NOSYSTEM: '1',
	};
}

/**
 * The complete `-c` override list, in the order it is emitted. Exported so a test
 * can assert the guards are really in the argv rather than merely intended.
 */
export async function gitArgumentGuards() {
	const hooks = await gitHooksDirectory();
	return [...pinnedConfig, ['core.hooksPath', hooks]];
}

/** Builds the argv array. Exported so tests can assert the `-c` guards are present. */
export async function gitArgv(args, config = []) {
	const overrides = [...(await gitArgumentGuards()), ...config];
	const argv = [gitCommand];
	for (const [key, value] of overrides) {
		argv.push('-c', key + '=' + value);
	}
	argv.push(...args);
	return argv;
}

export class GitRunResult {
	constructor({ code, signal, stdout, stderr, timedOut, argv }) {
		this.code = code;
		this.signal = signal;
		this.stdout = stdout;
		this.stderr = stderr;
		this.timedOut = timedOut;
		this.argv = argv;
	}
}

/**
 * Runs one git command. Returns the result instead of throwing for a non-zero
 * exit: the caller maps the git messages to error codes, because only the caller
 * knows which operation it asked for.
 */
export async function runGit(args, { cwd, env = {}, config = [], timeoutMs = defaultTimeoutMs, run = spawn } = {}) {
	const argv = await gitArgv(args, config);
	const [command, ...rest] = argv;
	return new Promise((resolve, reject) => {
		let child;
		try {
			child = run(command, rest, {
				cwd,
				env: gitEnvironment(env),
				stdio: ['ignore', 'pipe', 'pipe'],
				windowsHide: true,
			});
		} catch (error) {
			reject(gitError('GitUnavailable'));
			return;
		}
		if (!child?.stdout || !child?.stderr) {
			reject(gitError('GitUnavailable'));
			return;
		}
		const out = [];
		const err = [];
		let outBytes = 0;
		let errBytes = 0;
		let timedOut = false;
		let settled = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill('SIGKILL');
		}, Math.max(1, Math.min(timeoutMs, 600_000)));
		if (typeof timer.unref === 'function') {
			timer.unref();
		}
		child.stdout.on('data', chunk => {
			outBytes += chunk.length;
			if (outBytes <= maxOutputBytes) {
				out.push(chunk);
			}
		});
		child.stderr.on('data', chunk => {
			errBytes += chunk.length;
			if (errBytes <= maxOutputBytes) {
				err.push(chunk);
			}
		});
		const finish = (result) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			resolve(result);
		};
		child.on('error', error => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			reject(error?.code === 'ENOENT' ? gitError('GitUnavailable') : gitError('GitFailed'));
		});
		child.on('close', (code, signal) => finish(new GitRunResult({
			code: code ?? (signal ? 1 : 0),
			signal,
			stdout: Buffer.concat(out).toString('utf8'),
			stderr: Buffer.concat(err).toString('utf8'),
			timedOut,
			argv,
		})));
	});
}

/** One-shot availability probe used by the `GitUnavailable` path and by tests. */
export async function gitAvailable({ run } = {}) {
	try {
		const result = await runGit(['--version'], { run, timeoutMs: 10_000 });
		return result.code === 0;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Repository handles
// ---------------------------------------------------------------------------

/**
 * The four stage check of §5.4, then a snapshot of what kind of repository this
 * is. Stage 4 is `rev-parse --git-dir`: a directory that merely exists is not a
 * repository, and treating it as one would let `status` read arbitrary files.
 */
export async function openGitRepository(requestedPath, roots) {
	const located = await locateRepositoryPath(requestedPath, roots);
	const inside = await runGit(['rev-parse', '--git-dir', '--is-bare-repository', '--absolute-git-dir'], { cwd: located.path });
	if (inside.code !== 0) {
		throw gitError('NotARepository');
	}
	const [gitDirLine, bareLine, absoluteLine] = inside.stdout.split('\n');
	const gitDir = absoluteLine?.trim() || '';
	if (!gitDir) {
		throw gitError('NotARepository');
	}
	// A `.git` *file* can point anywhere (`gitdir: /elsewhere`), so the real git
	// directory has to be re-validated after `realpath`: otherwise a repository
	// inside the root could expose objects from outside it.
	let resolvedGitDir;
	try {
		resolvedGitDir = await realpath(gitDir);
	} catch {
		throw gitError('NotARepository');
	}
	const root = located.root;
	const workTreeInside = isInsideRoot(root, located.path);
	const gitDirInside = isInsideRoot(root, resolvedGitDir);
	if (!workTreeInside || !gitDirInside) {
		throw gitError('InvalidPath');
	}
	const bare = bareLine?.trim() === 'true';
	return {
		root,
		path: located.path,
		gitDir: resolvedGitDir,
		bare,
		gitDirLine: gitDirLine?.trim() ?? '',
	};
}

export async function readRepositoryState(handle) {
	const [head, upstream, branches, commit] = await Promise.all([
		runGit(['symbolic-ref', '--short', '-q', 'HEAD'], { cwd: handle.path }),
		runGit(['rev-parse', '--short', '-q', 'HEAD'], { cwd: handle.path }),
		readBranches(handle),
		readHeadCommit(handle),
	]);
	return {
		bare: handle.bare,
		detached: head.code !== 0,
		branch: head.code === 0 ? head.stdout.trim() : undefined,
		head: upstream.code === 0 ? upstream.stdout.trim() : undefined,
		branches,
		commit,
	};
}

export async function readHeadCommit(handle) {
	const result = await runGit(['log', '-n', '1', '--format=' + commitFormat], { cwd: handle.path });
	if (result.code !== 0) {
		return undefined;
	}
	return parseCommits(result.stdout)[0];
}

const unitSeparator = '\x1f';
const recordSeparator = '\x1e';
const commitFormat = ['%H', '%T', '%P', '%an', '%ae', '%aI', '%s', '%b'].join('%x1f') + '%x1e';

export function parseCommits(stdout) {
	return stdout
		.split(recordSeparator)
		.map(record => record.replace(/^\n+/, ''))
		.filter(record => record.trim() !== '')
		.map(record => {
			const [hash, tree, parents, author, email, date, subject, body] = record.split(unitSeparator);
			return {
				commit: hash,
				tree,
				parents: parents ? parents.split(' ').filter(Boolean) : [],
				author,
				email,
				date,
				subject: subject ?? '',
				body: (body ?? '').replace(/\s+$/, ''),
			};
		});
}

/**
 * `git log` for one revision. A repository with no commits is not an error: it is
 * an empty history, which is exactly what the work bench needs to render.
 */
export async function readLog(handle, { limit = 50, branch, commit } = {}) {
	if (handle.bare && !commit) {
		throw gitError('BareRepository');
	}
	const args = ['log', '--format=' + commitFormat, '-n', String(limit)];
	if (commit) {
		args.push(commit);
	} else if (branch) {
		args.push('refs/heads/' + branch);
	} else {
		args.push('HEAD');
	}
	const result = await runGit(args, { cwd: handle.path });
	if (result.code !== 0) {
		if (/does not have any commits yet|unknown revision|bad revision|ambiguous argument/i.test(result.stderr)) {
			return [];
		}
		throw gitError('GitFailed');
	}
	return parseCommits(result.stdout);
}

export async function readCommit(handle, commit) {
	const result = await runGit(['show', '--no-patch', '--format=' + commitFormat, commit + '^{commit}'], { cwd: handle.path });
	if (result.code !== 0) {
		if (/unknown revision|bad revision|ambiguous argument|not a valid object name/i.test(result.stderr)) {
			throw gitError('CommitNotFound');
		}
		throw gitError('GitFailed');
	}
	const parsed = parseCommits(result.stdout)[0];
	if (!parsed) {
		throw gitError('CommitNotFound');
	}
	return parsed;
}

export async function readCommitFiles(handle, commit, limit = 2000) {
	const result = await runGit(['show', '--name-status', '--format=', '-z', commit + '^{commit}'], { cwd: handle.path });
	if (result.code !== 0) {
		throw gitError('CommitNotFound');
	}
	const parts = result.stdout.split('\x00').filter(part => part !== '');
	const files = [];
	for (let index = 0; index + 1 < parts.length && files.length < limit; index += 2) {
		files.push({ status: parts[index], path: parts[index + 1] });
	}
	return files;
}

export async function readBranches(handle) {
	const result = await runGit(['for-each-ref', '--format=%(refname:short)%00%(objectname)%00%(upstream:short)%00%(HEAD)', 'refs/heads'], { cwd: handle.path });
	if (result.code !== 0) {
		return [];
	}
	return result.stdout
		.split('\n')
		.filter(line => line.trim() !== '')
		.map(line => {
			const [name, commit, upstream, current] = line.split('\x00');
			return { name, commit: (commit ?? '').slice(0, 40), upstream: upstream || undefined, current: current === '*' };
		});
}

export function parsePorcelainStatus(stdout) {
	const parts = stdout.split('\x00');
	const status = { branch: undefined, detached: false, oid: undefined, upstream: undefined, ahead: 0, behind: 0, entries: [] };
	for (let index = 0; index < parts.length; index += 1) {
		const line = parts[index];
		if (!line) {
			continue;
		}
		if (line.startsWith('# ')) {
			const rest = line.slice(2);
			if (rest.startsWith('branch.oid ')) {
				status.oid = rest.slice('branch.oid '.length).trim();
			} else if (rest.startsWith('branch.head ')) {
				const head = rest.slice('branch.head '.length).trim();
				if (head === '(detached)') {
					status.detached = true;
				} else {
					status.branch = head;
				}
			} else if (rest.startsWith('branch.upstream ')) {
				status.upstream = rest.slice('branch.upstream '.length).trim();
			} else if (rest.startsWith('branch.ab ')) {
				const match = /\+(\d+) -(\d+)/.exec(rest);
				if (match) {
					status.ahead = Number(match[1]);
					status.behind = Number(match[2]);
				}
			}
			continue;
		}
		const kind = line[0];
		if (kind === '1') {
			// 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
			const fields = line.split(' ');
			const [xy, sub] = [fields[1], fields[2]];
			const path = fields.slice(8).join(' ');
			status.entries.push({ path, index: xy[0], workTree: xy[1], sub, untracked: false, ignored: false });
			continue;
		}
		if (kind === '2') {
			const fields = line.split(' ');
			const path = fields.slice(9).join(' ');
			const originalPath = parts[index + 1];
			index += 1;
			status.entries.push({ path, originalPath, index: fields[1][0], workTree: fields[1][1], sub: fields[2], untracked: false, ignored: false });
			continue;
		}
		if (kind === 'u') {
			const fields = line.split(' ');
			const path = fields.slice(10).join(' ');
			status.entries.push({ path, index: 'U', workTree: 'U', sub: fields[2], untracked: false, ignored: false, conflicted: true });
			continue;
		}
		if (kind === '?') {
			status.entries.push({ path: line.slice(2), index: '?', workTree: '?', untracked: true, ignored: false });
			continue;
		}
		if (kind === '!') {
			status.entries.push({ path: line.slice(2), index: '!', workTree: '!', untracked: false, ignored: true });
		}
	}
	status.clean = status.entries.filter(entry => !entry.ignored).length === 0;
	return status;
}

export async function readStatus(handle, { limit = 2000 } = {}) {
	if (handle.bare) {
		throw gitError('BareRepository');
	}
	// `--no-optional-locks` keeps a read from refreshing and rewriting the index,
	// which would otherwise take the index lock away from a concurrent write.
	const result = await runGit(['--no-optional-locks', 'status', '--porcelain=v2', '--branch', '-z', '--untracked-files=normal'], { cwd: handle.path });
	if (result.code !== 0) {
		throw gitError('GitFailed');
	}
	const status = parsePorcelainStatus(result.stdout);
	if (status.entries.length > limit) {
		status.truncated = true;
		status.entries = status.entries.slice(0, limit);
	}
	return status;
}

/**
 * Switches the work tree to an existing local branch, or creates one.
 *
 * A dirty work tree is not automatically refused — git only refuses when the
 * switch would overwrite local changes, and the contract (422 `WorkTreeDirty`)
 * describes exactly that refusal, not "any modified file" (§4.3).
 */
export async function switchBranch(handle, name, { create = false, startPoint } = {}) {
	if (handle.bare) {
		throw gitError('BareRepository');
	}
	const args = create ? ['switch', '--create', name] : ['switch', name];
	if (create && startPoint) {
		args.push(startPoint);
	}
	const result = await runGit(args, { cwd: handle.path });
	if (result.code === 0) {
		return readStatus(handle);
	}
	const message = result.stderr;
	const dirty = /local changes to the following files would be overwritten|Please commit your changes or stash them/i.exec(message);
	if (dirty) {
		const error = gitError('WorkTreeDirty');
		error.conflicts = parseSwitchConflicts(message);
		throw error;
	}
	if (/invalid reference|cannot lock ref/i.test(message)) {
		throw gitError('BranchNotFound');
	}
	if (create && /already exists/i.test(message)) {
		throw gitError('BranchExists');
	}
	if (/Your branch is behind|diverged|not fully merged/i.test(message)) {
		throw gitError('NotFastForward');
	}
	throw gitError('GitFailed');
}

function parseSwitchConflicts(stderr) {
	const lines = stderr.split('\n');
	const start = lines.findIndex(line => /would be overwritten/i.test(line));
	const conflicts = [];
	if (start !== -1) {
		for (let index = start + 1; index < lines.length; index += 1) {
			const line = lines[index];
			if (!line.startsWith('\t')) {
				break;
			}
			conflicts.push(line.slice(1).trim());
		}
	}
	return conflicts.slice(0, 200);
}

// ---------------------------------------------------------------------------
// Remote operations
// ---------------------------------------------------------------------------

const authFailureMessages = /authentication failed|could not read (username|password)|permission denied \(publickey\)|invalid username or password|401 unauthorized|403 forbidden|access denied|terminal prompts disabled/i;
const unreachableMessages = /does not appear to be a git repository|could not read from remote repository|repository .* not found|does not exist|connection refused|connection timed out|connection reset|couldn't connect|could not connect|failed to connect|unable to access|remote end hung up|early eof|network is unreachable|could not resolve host|no route to host|transport '[a-z]+' not allowed|not allowed by the protocol allowlist/i;

/** Maps a failed remote command to the documented error code (§4.2). */
export function classifyRemoteFailure(result, { remoteUrl, localPath } = {}) {
	if (result.timedOut) {
		return gitError('RemoteTimeout');
	}
	const message = result.stderr;
	const detail = sanitizeGitMessage(message, { remoteUrl, localPath });
	if (authFailureMessages.test(message)) {
		const error = gitError('RemoteAuthenticationFailed');
		error.detail = detail;
		return error;
	}
	if (unreachableMessages.test(message)) {
		const error = gitError('RemoteUnavailable');
		error.detail = detail;
		return error;
	}
	const error = gitError('GitFailed');
	error.detail = detail;
	return error;
}

/**
 * A credential is injected per invocation and never written into the repository
 * config: an HTTPS token arrives through a throw-away askpass script (the secret is
 * in the environment, not the argv), an SSH key through a 0600 temp file.
 */
export async function withRemoteCredential(credential, work) {
	const directory = await privateWorkDirectory();
	const scratch = await mkdtemp(join(directory, 'cred-'));
	const cleanup = () => rm(scratch, { recursive: true, force: true }).catch(() => {});
	try {
		if (!credential) {
			return await work({ config: [], env: {}, allowFile: false });
		}
		if (credential.kind === 'https-token') {
			const askpass = join(scratch, 'askpass.sh');
			await writeFile(askpass, '#!/bin/sh\nexec printf \'%s\\n\' "$L4S_GIT_TOKEN"\n', { mode: 0o700 });
			return await work({
				config: [['credential.helper', '']],
				env: { GIT_ASKPASS: askpass, L4S_GIT_TOKEN: credential.secret, GIT_CONFIG_COUNT: '0' },
			});
		}
		if (credential.kind === 'ssh-key') {
			const keyPath = join(scratch, 'id_key');
			await writeFile(keyPath, normalizePrivateKey(credential.secret), { mode: 0o600 });
			const sshCommand = ['ssh', '-i', keyPath, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'UserKnownHostsFile=' + join(scratch, 'known_hosts')].join(' ');
			// Later `-c` wins over the earlier one, so this replaces the pinned `ssh`.
			return await work({ config: [['core.sshCommand', sshCommand]], env: {} });
		}
		throw gitError('InvalidCredential');
	} finally {
		await cleanup();
	}
}

function normalizePrivateKey(secret) {
	return secret.endsWith('\n') ? secret : secret + '\n';
}

/** `+refs/heads/*:refs/remotes/origin/*` — the remote label is fixed, not configured. */
export const remoteRefspec = '+refs/heads/*:refs/remotes/origin/*';
export const remoteLabel = 'origin';

export async function fetchRemote(handle, { url, credential, timeoutMs = defaultTimeoutMs, allowFile = false }) {
	return runRemote(handle, {
		url,
		credential,
		allowFile,
		timeoutMs,
		args: ['fetch', '--prune', '--no-tags', url, remoteRefspec],
	});
}

async function runRemote(handle, { url, credential, args, timeoutMs, allowFile }) {
	return withRemoteCredential(credential, async extra => {
		const env = { ...extra.env, GIT_ALLOW_PROTOCOL: gitAllowedProtocols({ allowFile }) };
		const result = await runGit(args, { cwd: handle.path, env, config: extra.config, timeoutMs });
		if (result.code !== 0) {
			throw classifyRemoteFailure(result, { remoteUrl: url, localPath: handle.path });
		}
		return result;
	});
}

export async function readRemoteHead(handle, { url, branch, credential, timeoutMs, allowFile }) {
	return withRemoteCredential(credential, async extra => {
		const result = await runGit(['ls-remote', '--heads', url, 'refs/heads/' + branch], {
			cwd: handle.path,
			env: { ...extra.env, GIT_ALLOW_PROTOCOL: gitAllowedProtocols({ allowFile }) },
			config: extra.config,
			timeoutMs,
		});
		if (result.code !== 0) {
			throw classifyRemoteFailure(result, { remoteUrl: url, localPath: handle.path });
		}
		const line = result.stdout.split('\n').find(entry => entry.trim() !== '');
		if (!line) {
			return undefined;
		}
		return line.split('\t')[0].trim();
	});
}

/**
 * Plain (never forced) push of one branch. `expectedRemote` implements the 412
 * precondition: the caller states which remote commit it believes it is pushing
 * on top of (`null` means "I believe this branch does not exist on the remote
 * yet"), so a concurrent update is a `412 RemoteChanged` the user can diagnose
 * instead of an opaque race. Omitting it skips the check entirely.
 */
export async function pushBranch(handle, { url, branch, commit = 'HEAD', expectedRemote, credential, timeoutMs = defaultTimeoutMs, allowFile = false }) {
	const currentRemote = await readRemoteHead(handle, { url, branch, credential, timeoutMs, allowFile });
	if (expectedRemote !== undefined) {
		const matches = expectedRemote === null ? currentRemote === undefined : currentRemote === expectedRemote;
		if (!matches) {
			throw gitError('RemoteChanged');
		}
	}
	return withRemoteCredential(credential, async extra => {
		const result = await runGit(['push', '--porcelain', url, commit + ':refs/heads/' + branch], {
			cwd: handle.path,
			env: { ...extra.env, GIT_ALLOW_PROTOCOL: gitAllowedProtocols({ allowFile }) },
			config: extra.config,
			timeoutMs,
		});
		if (result.code === 0) {
			return { remote: currentRemote, outcome: 'pushed' };
		}
		return { ...mapPushFailure(result, { url, path: handle.path }), remote: currentRemote };
	});
}

function mapPushFailure(result, context) {
	if (result.timedOut) {
		throw gitError('RemoteTimeout');
	}
	const message = result.stderr;
	const detail = sanitizeGitMessage(message, { remoteUrl: context.url, localPath: context.path });
	if (/\[rejected\].*non-fast-forward|Updates were rejected because|fetch first|non-fast-forward/i.test(message)) {
		const error = gitError('NotFastForward');
		error.detail = detail;
		throw error;
	}
	if (authFailureMessages.test(message)) {
		const error = gitError('RemoteAuthenticationFailed');
		error.detail = detail;
		throw error;
	}
	if (unreachableMessages.test(message)) {
		const error = gitError('RemoteUnavailable');
		error.detail = detail;
		throw error;
	}
	const error = gitError('GitFailed');
	error.detail = detail;
	throw error;
}

/** Warns before a destructive-looking operation: is the branch in sync? */
export async function branchTrackingState(handle, branch) {
	const result = await runGit(['rev-list', '--left-right', '--count', 'refs/heads/' + branch + '...refs/remotes/' + remoteLabel + '/' + branch], { cwd: handle.path });
	if (result.code !== 0) {
		return undefined;
	}
	const [ahead, behind] = result.stdout.trim().split(/\s+/).map(Number);
	return { ahead, behind };
}

export async function repositoryConfigValue(handle, key) {
	const result = await runGit(['config', '--get', key], { cwd: handle.path });
	return result.code === 0 ? result.stdout.trim() : undefined;
}

export async function pathExists(path) {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

export async function writeScratchFile(directory, name, content, mode = 0o600) {
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const target = join(directory, name);
	await writeFile(target, content, { mode });
	return target;
}
