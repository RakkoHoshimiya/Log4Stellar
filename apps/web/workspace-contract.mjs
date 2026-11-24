export class WorkspaceError extends Error {
	constructor(status, code) {
		super(code);
		this.status = status;
		this.code = code;
	}
}

/**
 * The workspace ID storage, object keys and the auth database all share. The local
 * directory backend has no storage-side ID of its own, so this default keeps a
 * single-workspace deployment working without any extra configuration.
 */
export const defaultStorageWorkspaceId = 'log4stellar-main';

const workspaceIdPattern = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function isValidWorkspaceId(value) {
	return typeof value === 'string' && workspaceIdPattern.test(value);
}

/**
 * Resolves the storage workspace ID from an explicit argument, then the
 * LOG4STELLAR_WORKSPACE_ID environment variable, then the compatible default.
 */
export function resolveWorkspaceId({ explicit, environment = {} } = {}) {
	const value = explicit || environment.LOG4STELLAR_WORKSPACE_ID || defaultStorageWorkspaceId;
	if (!isValidWorkspaceId(value)) {
		throw new Error('A workspace ID must contain 1–63 lowercase letters, digits or hyphens.');
	}
	return value;
}

// Include the workspace even when it is the current default: a later
// membership change must never reuse another workspace's editor storage.
export function workbenchAuthority(accountId, workspaceId) {
  if (typeof accountId !== 'string' || !/^[a-z0-9_-]+$/i.test(accountId)
      || !isValidWorkspaceId(workspaceId)) {
    throw new TypeError('Invalid workbench identity');
  }
  return 'mount-' + accountId + '.' + workspaceId;
}

export function normalizeWorkspacePath(path) {
	const parts = path.split('/').filter(Boolean);
	if (parts.some(part => part === '.' || part === '..' || /[\\\0]/.test(part))) {
		throw new WorkspaceError(400, 'InvalidPath');
	}
	return '/' + parts.join('/');
}

export function workspaceUploadLimit() {
	const bytes = Number(process.env.LOG4STELLAR_MAX_UPLOAD_BYTES ?? 512 * 1024 * 1024);
	if (!Number.isSafeInteger(bytes) || bytes < 1) {
		throw new Error('LOG4STELLAR_MAX_UPLOAD_BYTES must be a positive integer.');
	}
	return bytes;
}

// Returns whether an `If-Match` precondition holds for the current entity tag. An absent
// precondition never holds, so a caller that requires one can treat `false` as "reject" while a
// caller that only guards conditional requests checks for absence first. RFC 9110 section 13.1.1
// allows `*` and a list of entity tags, and browsers do resend a stale list after a conflict, so
// match against the current tag instead of comparing one exact string.
export function ifMatchHolds(precondition, currentEtag) {
	if (!precondition) {
		return false;
	}
	const tags = precondition.split(',').map(tag => tag.trim());
	return tags.includes('*') || tags.includes(currentEtag);
}
