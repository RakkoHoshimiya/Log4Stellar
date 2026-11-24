// Constants, validators and error semantics for the Git integration API
// (docs/git-integration.md). This module is pure: it never touches the file
// system, the database or a child process, so every rule here can be exercised
// cheaply and every route is mapped to a capability before any I/O happens.

import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { isAbsolute, posix, relative, resolve, sep } from 'node:path';
import { workspaceCapabilities } from './workspace-access.mjs';
import { WorkspaceError } from './workspace-contract.mjs';

// Sibling of /static/mount and /sync/v1: the three have different conflict
// semantics and must never be routed together (docs/git-integration.md §7.1).
export const gitMountPath = '/git/v1';

export const gitRoutes = {
	repository: gitMountPath + '/repository',
	status: gitMountPath + '/status',
	log: gitMountPath + '/log',
	branches: gitMountPath + '/branches',
	commit: gitMountPath + '/commit/',
	checkpoints: gitMountPath + '/checkpoints',
	credentials: gitMountPath + '/credentials',
	fetch: gitMountPath + '/fetch',
	push: gitMountPath + '/push',
	branch: gitMountPath + '/branch',
};

// §2.2. The capability is a function of the method and the path ONLY: it must be
// resolvable before the body is read, before the query is parsed and before a
// path parameter is decoded. Anything that is not listed resolves to undefined,
// which the handler turns into 404 NotFound — never into a default of "read".
const gitRouteTable = [
	{ method: 'GET', pattern: /^\/git\/v1\/repository$/, capability: workspaceCapabilities.gitRead },
	{ method: 'HEAD', pattern: /^\/git\/v1\/repository$/, capability: workspaceCapabilities.gitRead },
	{ method: 'GET', pattern: /^\/git\/v1\/status$/, capability: workspaceCapabilities.gitRead },
	{ method: 'HEAD', pattern: /^\/git\/v1\/status$/, capability: workspaceCapabilities.gitRead },
	{ method: 'GET', pattern: /^\/git\/v1\/log$/, capability: workspaceCapabilities.gitRead },
	{ method: 'HEAD', pattern: /^\/git\/v1\/log$/, capability: workspaceCapabilities.gitRead },
	{ method: 'GET', pattern: /^\/git\/v1\/branches$/, capability: workspaceCapabilities.gitRead },
	{ method: 'HEAD', pattern: /^\/git\/v1\/branches$/, capability: workspaceCapabilities.gitRead },
	{ method: 'GET', pattern: /^\/git\/v1\/commit\/[^/]+$/, capability: workspaceCapabilities.gitRead },
	{ method: 'HEAD', pattern: /^\/git\/v1\/commit\/[^/]+$/, capability: workspaceCapabilities.gitRead },
	{ method: 'GET', pattern: /^\/git\/v1\/checkpoints$/, capability: workspaceCapabilities.gitRead },
	{ method: 'HEAD', pattern: /^\/git\/v1\/checkpoints$/, capability: workspaceCapabilities.gitRead },
	{ method: 'GET', pattern: /^\/git\/v1\/checkpoints\/[^/]+$/, capability: workspaceCapabilities.gitRead },
	{ method: 'HEAD', pattern: /^\/git\/v1\/checkpoints\/[^/]+$/, capability: workspaceCapabilities.gitRead },
	{ method: 'GET', pattern: /^\/git\/v1\/credentials$/, capability: workspaceCapabilities.gitRead },
	{ method: 'HEAD', pattern: /^\/git\/v1\/credentials$/, capability: workspaceCapabilities.gitRead },
	// fetch only rewrites refs/remotes/* and FETCH_HEAD: it never touches the work
	// tree, a local branch or the remote, so a read role may run it (§2.1).
	{ method: 'POST', pattern: /^\/git\/v1\/fetch$/, capability: workspaceCapabilities.gitRead },
	{ method: 'POST', pattern: /^\/git\/v1\/push$/, capability: workspaceCapabilities.gitWrite },
	{ method: 'POST', pattern: /^\/git\/v1\/branch$/, capability: workspaceCapabilities.gitWrite },
	{ method: 'POST', pattern: /^\/git\/v1\/checkpoints$/, capability: workspaceCapabilities.gitWrite },
	{ method: 'DELETE', pattern: /^\/git\/v1\/checkpoints\/[^/]+$/, capability: workspaceCapabilities.gitWrite },
	{ method: 'PUT', pattern: /^\/git\/v1\/repository$/, capability: workspaceCapabilities.gitAdmin },
	{ method: 'DELETE', pattern: /^\/git\/v1\/repository$/, capability: workspaceCapabilities.gitAdmin },
	{ method: 'PUT', pattern: /^\/git\/v1\/credentials$/, capability: workspaceCapabilities.gitAdmin },
	{ method: 'DELETE', pattern: /^\/git\/v1\/credentials\/[^/]+$/, capability: workspaceCapabilities.gitAdmin },
];

export function capabilityForGitRequest(method, pathname) {
	const route = gitRouteTable.find(entry => entry.method === method && entry.pattern.test(pathname));
	return route?.capability;
}

// §4.1. `422` had no meaning anywhere in apps/web before this module (grep for
// 422 returns nothing), so this contract claims it: "the request is well formed
// and authorized, but the local repository state makes the operation
// impossible". 409 means "read again and retry", 412 means "declarative
// precondition does not hold", 410 is taken by the sync cursor contract.
export const gitErrorStatus = {
	InvalidRequest: 400,
	InvalidPath: 400,
	InvalidBranch: 400,
	InvalidCommit: 400,
	InvalidName: 400,
	InvalidCredential: 400,
	InvalidRemote: 400,
	ForcePushNotAllowed: 400,
	NoPermissions: 403,
	NotFound: 404,
	RepositoryNotBound: 404,
	CheckpointNotFound: 404,
	CommitNotFound: 404,
	BranchNotFound: 404,
	CheckpointExists: 409,
	NotFastForward: 409,
	RepositoryBusy: 409,
	CredentialInUse: 409,
	RepositoryImmutable: 409,
	BranchExists: 409,
	RemoteChanged: 412,
	HeadChanged: 412,
	RequestTooLarge: 413,
	InvalidContentType: 415,
	WorkTreeDirty: 422,
	NotARepository: 422,
	BareRepository: 422,
	RepositoryLocked: 422,
	GitFailed: 500,
	GitUnavailable: 501,
	RemoteUnavailable: 502,
	RemoteAuthenticationFailed: 502,
	GitNotConfigured: 503,
	RemoteTimeout: 504,
};

export const gitErrorCodes = Object.freeze(Object.keys(gitErrorStatus));

export function gitError(code) {
	const status = gitErrorStatus[code];
	if (!status) {
		throw new Error('Unknown git error code: ' + code);
	}
	return new WorkspaceError(status, code);
}

// A branch name that git will accept, restricted to what this API can pass as a
// single argv element. The full grammar lives in `git check-ref-format`; this is
// the documented subset (§5.5) and rejects every character that would either be
// rejected by git anyway or look like a crafted argument.
export function gitBranchNameValid(name) {
	if (typeof name !== 'string' || name.length === 0 || name.length > 255) {
		return false;
	}
	if (name.startsWith('-') || name.startsWith('/') || name.endsWith('/') || name.endsWith('.')) {
		return false;
	}
	if (name === 'HEAD' || name.includes('..') || name.includes('@{') || name.includes('//')) {
		return false;
	}
	// eslint-disable-next-line no-control-regex
	return !/[\s~^:?*[\\\x00-\x1f\x7f]/.test(name);
}

export function requireBranchName(value, code = 'InvalidBranch') {
	if (!gitBranchNameValid(value)) {
		throw gitError(code);
	}
	return value;
}

export const gitShaPattern = /^[0-9a-f]{40}$/;

export function requireCommitSha(value, code = 'InvalidCommit') {
	if (typeof value !== 'string' || !gitShaPattern.test(value)) {
		throw gitError(code);
	}
	return value;
}

export function isCommitSha(value) {
	return typeof value === 'string' && gitShaPattern.test(value);
}

// Checkpoint names are user-visible labels, not git refs: keep them printable,
// trim the ends and bound the length so a name can never become a query payload.
export function normalizeCheckpointName(value) {
	if (typeof value !== 'string') {
		throw gitError('InvalidName');
	}
	// eslint-disable-next-line no-control-regex
	const name = value.replace(/[\x00-\x1f\x7f]/g, '').trim();
	if (name.length === 0 || name.length > 120) {
		throw gitError('InvalidName');
	}
	return name;
}

export const gitCredentialKinds = Object.freeze(['ssh-key', 'https-token']);
export const gitSecretLimit = 8192;

export function requireCredentialKind(value) {
	if (!gitCredentialKinds.includes(value)) {
		throw gitError('InvalidCredential');
	}
	return value;
}

export const gitRemoteSchemes = Object.freeze(['file', 'https', 'ssh', 'git', 'http']);

function isLoopbackHost(host) {
	if (!host) {
		return false;
	}
	const bare = host.replace(/^\[|\]$/g, '').toLowerCase();
	return bare === 'localhost' || bare === '::1' || /^127(?:\.\d{1,3}){3}$/.test(bare);
}

/**
 * Splits a remote URL into the parts this contract cares about and rejects
 * everything else. `ext::sh -c …` and `fd::` are refused here (and again by
 * GIT_ALLOW_PROTOCOL, §5.5) so a crafted remote can never become a command.
 *
 * Plain `http` is accepted for loopback hosts only. It exists because a real
 * "the remote rejected my credential" round trip is the only honest way to
 * exercise that acceptance scenario, and a plaintext token must never leave the
 * machine. Anything that is not a loopback http URL needs https.
 */
export function parseGitRemote(url) {
	if (typeof url !== 'string' || url.length === 0 || url.length > 2048) {
		throw gitError('InvalidRemote');
	}
	if (/[\x00-\x1f\x7f\s]/.test(url)) {
		throw gitError('InvalidRemote');
	}
	// `ext::cmd` and `fd::3` are *transport helpers*, not scp-like remotes: the
	// double colon is the marker, and it must be refused before the scp regex
	// below can mistake `fd` for a host name.
	if (url.includes('::')) {
		throw gitError('InvalidRemote');
	}
	const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(url);
	const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(url);
	if (!scheme && scp) {
		// scp-like git@host:path is ssh transport without a scheme.
		return { kind: 'ssh', url, userinfo: undefined, host: scp[1], path: scp[2] };
	}
	if (!scheme) {
		// A bare path is only a file remote when it is absolute; relative remotes
		// would resolve against the server process cwd, which nobody can predict.
		if (!isAbsolute(url)) {
			throw gitError('InvalidRemote');
		}
		return { kind: 'file', url, userinfo: undefined, path: url };
	}
	const kind = scheme[1].toLowerCase();
	if (!gitRemoteSchemes.includes(kind)) {
		throw gitError('InvalidRemote');
	}
	let parsed;
	try {
		parsed = new URL(url);
	} catch {
		throw gitError('InvalidRemote');
	}
	if (kind === 'file') {
		return { kind, url, userinfo: undefined, path: decodeURIComponent(parsed.pathname) };
	}
	if (kind === 'http' && !isLoopbackHost(parsed.hostname)) {
		throw gitError('InvalidRemote');
	}
	const userinfo = parsed.username ? decodeURIComponent(parsed.username) + (parsed.password ? ':' + decodeURIComponent(parsed.password) : '') : undefined;
	// The stored URL never carries userinfo: credentials live in git_credentials
	// and are injected per call, so a token can never end up in .git/config.
	parsed.username = '';
	parsed.password = '';
	return { kind, url: parsed.href, userinfo, host: parsed.host, path: parsed.pathname };
}

/**
 * Stable, non-reversible handle for a remote URL: the identifier a response, a
 * log line or a report may carry instead of the URL itself (§5.3). Salting is not
 * needed — the input is a URL, not a guessable secret — but the digest must never
 * be reversible, so only 16 hex characters of SHA-256 are kept.
 */
export function remoteIdentity(url) {
	return createHash('sha256').update(String(url)).digest('hex').slice(0, 16);
}

// §5.3: nothing that reaches a response, a log line or a delivery report may
// carry a credential, a remote URL or a server path. The child process stderr is
// the one place where all three can leak, so it is scrubbed before it is used.
const tokenShapes = [
	/gh[pousr]_[A-Za-z0-9]{20,}/g,
	/xox[abuspr]-[A-Za-z0-9-]{10,}/g,
	/AKIA[0-9A-Z]{16}/g,
	/(?:token|password|passwd|secret|key)=[^&\s"']+/gi,
	/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

export function sanitizeGitMessage(message, { remoteUrl, localPath } = {}) {
	if (typeof message !== 'string') {
		return '';
	}
	let text = message.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
	const scrub = [remoteUrl, localPath].filter(value => typeof value === 'string' && value.length > 1);
	for (const value of scrub) {
		text = text.split(value).join('<redacted>');
		text = text.split('file://' + value).join('<redacted>');
	}
	// Strip userinfo from any URL that survived.
	text = text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, '$1');
	// A `file://` URL names an absolute host path, which §5.3 forbids in a
	// response; it is scrubbed even when the caller did not pass it explicitly.
	text = text.replace(/\bfile:\/\/[^\s"']+/gi, '<redacted>');
	// A truncated key loses its END marker, so the pair pattern below cannot
	// match it and the bare marker has to go on its own.
	text = text.replace(/-----(?:BEGIN|END)[A-Z ]*PRIVATE KEY-----/g, '<redacted>');
	// Drop query strings: they are where tokens hide in HTTPS remotes.
	text = text.replace(/(\bhttps?:\/\/[^\s?]+)\?[^\s]*/gi, '$1');
	for (const shape of tokenShapes) {
		text = text.replace(shape, '<redacted>');
	}
	return text.replace(/\s+/g, ' ').trim().slice(0, 400);
}

// §5.4: everything the API can associate must live under an explicitly allowed
// root. A missing configuration is a configuration error, never a permissive
// default — an unset allowlist must not mean "the whole file system".
export async function gitRoots(environment, workspaceId) {
	let configured;
	try {
		configured = JSON.parse(environment.LOG4STELLAR_GIT_WORKSPACE_ROOTS ?? 'null');
	} catch {
		throw gitError('GitNotConfigured');
	}
	if (!configured || typeof configured !== 'object' || Array.isArray(configured) || !Object.hasOwn(configured, workspaceId)) {
		throw gitError('GitNotConfigured');
	}
	const grants = [];
	try {
		for (const [workspace, roots] of Object.entries(configured)) {
			if (!Array.isArray(roots) || !roots.length || roots.some(root => typeof root !== 'string' || !isAbsolute(root))) {
				throw gitError('GitNotConfigured');
			}
			for (const root of roots) {
				grants.push({ workspace, root: await realpath(root) });
			}
		}
	} catch {
		throw gitError('GitNotConfigured');
	}
	const own = grants.filter(grant => grant.workspace === workspaceId);
	const others = grants.filter(grant => grant.workspace !== workspaceId);
	if (own.some(({ root }) => others.some(other => isInsideRoot(root, other.root) || isInsideRoot(other.root, root)))) {
		throw gitError('GitNotConfigured');
	}
	return [...new Set(own.map(grant => grant.root))];
}

/**
 * Stage 1 and 3 of the four stage check (§5.4). `resolve` normalizes `..` before
 * the comparison, so the string form of the check cannot be fooled; the symlink
 * form is handled by the caller after `realpath`.
 */
export function resolveWithinRoot(roots, requested) {
	if (typeof requested !== 'string' || requested.length === 0) {
		throw gitError('InvalidPath');
	}
	if (requested.includes('\x00')) {
		throw gitError('InvalidPath');
	}
	const normalized = posix.normalize(requested.replaceAll('\\', '/'));
	if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
		throw gitError('InvalidPath');
	}
	if (isAbsolute(normalized)) {
		// An absolute path is accepted only when it is inside a configured root; it
		// is the operator's own string, so matching the prefix is the whole check.
		for (const root of roots) {
			const trimmed = resolve(root);
			if (normalized === trimmed) {
				return { root: trimmed, relative: '.' };
			}
			const inside = relative(trimmed, normalized);
			if (inside && !inside.startsWith('..') && !isAbsolute(inside)) {
				return { root: trimmed, relative: inside };
			}
		}
		throw gitError('InvalidPath');
	}
	return { root: undefined, relative: normalized };
}

export function isInsideRoot(root, candidate) {
	const difference = relative(root, candidate);
	return !isAbsolute(difference) && difference !== '..' && !difference.startsWith('..' + sep);
}

/**
 * The four layers of §5.4, in order: allowed root -> realpath -> still under the
 * root -> is a git repository (checked by the caller, which owns the child
 * process). Missing any one of them is an arbitrary path read.
 */
export async function locateRepositoryPath(requested, roots) {
	const { root, relative: inner } = resolveWithinRoot(roots, requested);
	const candidates = root ? [resolve(root, inner)] : roots.map(candidateRoot => resolve(candidateRoot, inner));
	for (const candidate of candidates) {
		let resolved;
		try {
			resolved = await realpath(candidate);
		} catch {
			continue;
		}
		for (const candidateRoot of roots) {
			let resolvedRoot;
			try {
				resolvedRoot = await realpath(candidateRoot);
			} catch {
				continue;
			}
			if (isInsideRoot(resolvedRoot, resolved)) {
				return { root: resolvedRoot, path: resolved };
			}
		}
	}
	throw gitError('InvalidPath');
}

/**
 * A file remote must point at a bare repository that lives under an allowed root,
 * with the same four stage check as a work tree (§5.4). Otherwise `file:///etc`
 * or `file://$HOME/.ssh` would let an admin pull arbitrary host bytes into a
 * repository the workspace can then read.
 */
export async function locateFileRemote(url, roots) {
	const parsed = parseGitRemote(url);
	if (parsed.kind !== 'file') {
		return parsed;
	}
	const resolved = await locateRepositoryPath(parsed.path, roots);
	return { ...parsed, path: resolved.path };
}

/** Relative form of a stored path, for responses: never echo a server path. */
export function displayRepositoryPath(root, absolutePath) {
	if (!root || !absolutePath) {
		return '.';
	}
	const inside = relative(root, absolutePath);
	return inside === '' ? '.' : inside.split(sep).join('/');
}

export const gitPageLimits = Object.freeze({ defaultLogSize: 50, maxLogSize: 200, maxStatusEntries: 2000, maxCommitFiles: 2000 });

export function normalizeGitLimit(value, { fallback = gitPageLimits.defaultLogSize, maximum = gitPageLimits.maxLogSize } = {}) {
	if (value === undefined || value === null || value === '') {
		return fallback;
	}
	const limit = Number(value);
	if (!Number.isSafeInteger(limit) || limit < 1) {
		throw gitError('InvalidRequest');
	}
	return Math.min(limit, maximum);
}
