import { WorkspaceError } from './workspace-contract.mjs';

// Role levels and capability names come from docs/workspace-access.md. A role may
// only perform the capabilities listed here; capabilities are the single unit of
// authorization, never the HTTP method or the URL on its own.
export const workspaceRoles = {
	viewer: 1,
	editor: 2,
	owner: 3,
};

export const workspaceCapabilities = {
	read: 'workspace.read',
	history: 'workspace.history',
	write: 'workspace.write',
	delete: 'workspace.delete',
	restore: 'workspace.restore',
	admin: 'workspace.admin',
	// docs/git-integration.md §2.1. Reading a repository, its commits and its work
	// tree state is not the same right as moving refs, so git is split three ways
	// instead of reusing read/write/admin: fetch is a read (it only rewrites
	// refs/remotes/*), push and branch switching are writes, and binding a
	// repository or storing a credential is owner-only administration.
	gitRead: 'workspace.git.read',
	gitWrite: 'workspace.git.write',
	gitAdmin: 'workspace.git.admin',
};

const granted = new Map([
	[workspaceRoles.viewer, new Set([
		workspaceCapabilities.read,
		workspaceCapabilities.history,
		workspaceCapabilities.gitRead,
	])],
	[workspaceRoles.editor, new Set([
		workspaceCapabilities.read,
		workspaceCapabilities.history,
		workspaceCapabilities.write,
		workspaceCapabilities.delete,
		workspaceCapabilities.restore,
		workspaceCapabilities.gitRead,
		workspaceCapabilities.gitWrite,
	])],
	[workspaceRoles.owner, new Set(Object.values(workspaceCapabilities))],
]);

// Backend methods each capability gates. A method the backend does not implement
// is left undefined on the facade so callers can keep probing for it.
const backendMethods = {
	[workspaceCapabilities.read]: ['stat', 'readDirectory', 'listFiles', 'openRead', 'openRevision', 'searchDocuments', 'searchStatus'],
	[workspaceCapabilities.history]: ['listVersions', 'listTrash'],
	[workspaceCapabilities.write]: ['writeFile', 'createDirectory', 'rename'],
	[workspaceCapabilities.delete]: ['delete'],
	[workspaceCapabilities.restore]: ['restoreRevision', 'restoreTrash', 'restoreTrashBatch'],
	// Rebuilding the search index rewrites derived state for the whole workspace, so it
	// sits behind the same admin capability the owner already holds; no role gained a
	// capability here, the method was merely attached to an existing one.
	[workspaceCapabilities.admin]: ['reindexWorkspace'],
	// The git gateway wraps a git backend with the same facade, so these names are
	// gated by exactly the same `require()` path as storage (§2.2) instead of a
	// second hand written check.
	[workspaceCapabilities.gitRead]: ['gitRepository', 'gitStatus', 'gitLog', 'gitBranches', 'gitCommit', 'gitCheckpoints', 'gitCredentials', 'gitFetch'],
	[workspaceCapabilities.gitWrite]: ['gitPush', 'gitSwitchBranch', 'gitCreateCheckpoint', 'gitDeleteCheckpoint'],
	[workspaceCapabilities.gitAdmin]: ['gitBindRepository', 'gitUnbindRepository', 'gitPutCredential', 'gitDeleteCredential'],
};

export function isWorkspaceRole(role) {
	return Number.isInteger(role) && granted.has(role);
}

/**
 * Accepts a stored role level (1/2/3) or its documented name ('viewer', ...) and
 * returns the numeric level. Anything else is invalid, never silently downgraded.
 */
export function normalizeWorkspaceRole(role) {
	if (isWorkspaceRole(role)) {
		return role;
	}
	if (typeof role === 'string' && Object.hasOwn(workspaceRoles, role)) {
		return workspaceRoles[role];
	}
	throw new Error('Unknown workspace role: ' + String(role));
}

export function allowsWorkspace(role, capability) {
	return granted.get(role)?.has(capability) === true;
}

/**
 * Maps one request shape to the capability it needs (contract §3). The result only
 * depends on the method, the query and whether the request addresses the workspace
 * root, so it can be resolved before any parameter validation or storage access.
 *
 * `isRoot` mirrors the branch conditions in the handler: the capability listing and
 * the recycle bin are root-only requests, and a non-root `?trash=1` falls through to
 * reading a file. Resolving it to `read` therefore describes what the handler will
 * actually do; mapping every `?trash=1` to `history` would let a role that may read
 * history but not files read a file. Returns undefined for an unsupported method.
 */
export function capabilityForRequest(method, query, { isRoot = true } = {}) {
	switch (method) {
		case 'GET':
		case 'HEAD':
			if ((query.capabilities === '1' || query.trash === '1') && isRoot) {
				return workspaceCapabilities.history;
			}
			if (query.versions === '1') {
				return workspaceCapabilities.history;
			}
			return workspaceCapabilities.read;
		case 'PUT':
			return workspaceCapabilities.write;
		case 'POST':
			// An unrecognized POST still needs write capability so a viewer cannot
			// use the resulting 400 to probe which operations exist.
			if (query.restoreVersion !== undefined || query.restoreTrash !== undefined || query.restoreTrashBatch !== undefined) {
				return workspaceCapabilities.restore;
			}
			return workspaceCapabilities.write;
		case 'DELETE':
			return workspaceCapabilities.delete;
		default:
			return undefined;
	}
}

/**
 * Wraps a workspace backend so that every call is gated by the caller's role. The
 * facade is the only way workspace handlers reach storage: an unauthorized call
 * throws WorkspaceError(403, 'NoPermissions') without touching the backend.
 */
export function authorizeWorkspace(backend, { role } = {}) {
	if (!backend || typeof backend !== 'object') {
		throw new Error('A workspace backend is required to authorize a request.');
	}
	const level = normalizeWorkspaceRole(role);
	const facade = {
		role: level,
		capabilities: [...granted.get(level)],
		/** Throws unless the role may perform the capability. Performs no I/O. */
		require(capability) {
			if (!allowsWorkspace(level, capability)) {
				throw new WorkspaceError(403, 'NoPermissions');
			}
		},
	};
	for (const [capability, names] of Object.entries(backendMethods)) {
		for (const name of names) {
			if (typeof backend[name] !== 'function') {
				continue;
			}
			facade[name] = (...args) => {
				facade.require(capability);
				return backend[name](...args);
			};
		}
	}
	return facade;
}
