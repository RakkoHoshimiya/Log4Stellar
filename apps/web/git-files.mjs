// HTTP layer of the Git integration (docs/git-integration.md §4). Sibling of
// /static/mount and /sync/v1: same gateway, same lease, different conflict
// semantics, so it is a separate mount point instead of a sub-resource.
//
// The order in `serveGitRequest` is the contract: the capability is resolved
// from the method and the path, `workspace.require()` decides, and only then is
// a single parameter looked at. An unauthorized caller therefore cannot tell a
// malformed request from a well formed one (§2.2).

import { capabilityForGitRequest, gitError, normalizeGitLimit, gitPageLimits } from './git-contract.mjs';
import { WorkspaceError } from './workspace-contract.mjs';

export const gitPath = '/git/v1';

const maxBodyBytes = 1024 * 1024;

async function readJson(ctx) {
	if (!ctx.is('application/json')) {
		throw new WorkspaceError(415, 'InvalidContentType');
	}
	const chunks = [];
	let size = 0;
	for await (const chunk of ctx.req) {
		size += chunk.length;
		if (size > maxBodyBytes) {
			throw new WorkspaceError(413, 'RequestTooLarge');
		}
		chunks.push(chunk);
	}
	const text = Buffer.concat(chunks).toString('utf8');
	if (!text.trim()) {
		return {};
	}
	let value;
	try {
		value = JSON.parse(text);
	} catch {
		throw new WorkspaceError(400, 'InvalidRequest');
	}
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		throw new WorkspaceError(400, 'InvalidRequest');
	}
	return value;
}

// A git backend that predates this route (an older storage module) answers 501 instead of
// crashing, exactly like `SyncUnavailable` in sync-files.mjs.
function requireGitBackend(backend, method) {
	if (typeof backend[method] !== 'function') {
		throw new WorkspaceError(501, 'GitUnavailable');
	}
}

function queryString(ctx, name) {
	const value = ctx.query[name];
	if (value === undefined || value === null || value === '') {
		return undefined;
	}
	// `ctx.query` gives an array for a repeated parameter; a single element is not a
	// different request, but two different values are ambiguous and must be refused.
	return Array.isArray(value) ? (value.length === 1 ? value[0] : '') : String(value);
}

function requireText(value, code) {
	if (typeof value !== 'string' || value === '') {
		throw gitError(code);
	}
	return value;
}

function optionalBoolean(value, code) {
	if (value === undefined || value === null) {
		return false;
	}
	if (typeof value !== 'boolean') {
		throw gitError(code);
	}
	return value;
}

function checkpointIdOf(path) {
	return path.slice((gitPath + '/checkpoints/').length);
}

/**
 * Serves one /git/v1 request. `workspace` is the facade produced by
 * `authorizeWorkspace(gitBackend, { role })`, so every backend call below has
 * already passed through the capability matrix; this function never makes an
 * authorization decision of its own.
 */
export async function serveGitRequest(ctx, workspace, backend, workspaceId, maxBytes) {
	// The gateway passes the workspace id and the upload limit for symmetry with
	// serveSyncRequest(); this route needs neither (the backend is already scoped to the
	// workspace, and no body here carries file content).
	void workspaceId;
	void maxBytes;
	try {
		const capability = capabilityForGitRequest(ctx.method, ctx.path);
		if (capability === undefined) {
			throw new WorkspaceError(404, 'NotFound');
		}
		if (!workspace.require) {
			throw new Error('The workspace must be wrapped by authorizeWorkspace().');
		}
		workspace.require(capability);

		const path = ctx.path;

		if ((ctx.method === 'GET' || ctx.method === 'HEAD') && path === gitPath + '/repository') {
			requireGitBackend(backend, 'gitRepository');
			ctx.body = await backend.gitRepository();
			ctx.status = 200;
			return;
		}

		if ((ctx.method === 'GET' || ctx.method === 'HEAD') && path === gitPath + '/status') {
			requireGitBackend(backend, 'gitStatus');
			ctx.body = await backend.gitStatus();
			ctx.status = 200;
			return;
		}

		if ((ctx.method === 'GET' || ctx.method === 'HEAD') && path === gitPath + '/log') {
			requireGitBackend(backend, 'gitLog');
			const limit = normalizeGitLimit(queryString(ctx, 'limit'), {
				fallback: gitPageLimits.defaultLogSize,
				maximum: gitPageLimits.maxLogSize,
			});
			const branch = queryString(ctx, 'branch');
			const commit = queryString(ctx, 'commit');
			// The query string is parsed only after the capability check; a repeated parameter
			// arrives as '' and is refused by the validators instead of being silently dropped.
			ctx.body = await backend.gitLog({
				limit,
				branch: branch === undefined ? undefined : requireText(branch, 'InvalidBranch'),
				commit: commit === undefined ? undefined : requireText(commit, 'InvalidCommit'),
			});
			ctx.status = 200;
			return;
		}

		if ((ctx.method === 'GET' || ctx.method === 'HEAD') && path === gitPath + '/branches') {
			requireGitBackend(backend, 'gitBranches');
			ctx.body = await backend.gitBranches();
			ctx.status = 200;
			return;
		}

		if ((ctx.method === 'GET' || ctx.method === 'HEAD') && path.startsWith(gitPath + '/commit/')) {
			requireGitBackend(backend, 'gitCommit');
			const commit = path.slice((gitPath + '/commit/').length);
			ctx.body = await backend.gitCommit({ commit: requireText(commit, 'InvalidCommit') });
			ctx.status = 200;
			return;
		}

		if ((ctx.method === 'GET' || ctx.method === 'HEAD') && path === gitPath + '/checkpoints') {
			requireGitBackend(backend, 'gitCheckpoints');
			ctx.body = await backend.gitCheckpoints();
			ctx.status = 200;
			return;
		}

		if ((ctx.method === 'GET' || ctx.method === 'HEAD') && path.startsWith(gitPath + '/checkpoints/')) {
			requireGitBackend(backend, 'gitCheckpoints');
			const checkpointId = checkpointIdOf(path);
			const listed = await backend.gitCheckpoints();
			const checkpoint = listed.checkpoints.find(entry => entry.checkpointId === checkpointId);
			if (!checkpoint) {
				throw gitError('CheckpointNotFound');
			}
			ctx.body = checkpoint;
			ctx.status = 200;
			return;
		}

		if ((ctx.method === 'GET' || ctx.method === 'HEAD') && path === gitPath + '/credentials') {
			requireGitBackend(backend, 'gitCredentials');
			ctx.body = await backend.gitCredentials();
			ctx.status = 200;
			return;
		}

		if (ctx.method === 'POST' && path === gitPath + '/fetch') {
			requireGitBackend(backend, 'gitFetch');
			ctx.body = await backend.gitFetch();
			ctx.status = 200;
			return;
		}

		if (ctx.method === 'POST' && path === gitPath + '/push') {
			requireGitBackend(backend, 'gitPush');
			const body = await readJson(ctx);
			// §1.3: there is no force push. The field exists in the schema only so an
			// implementation that adds it later cannot silently ignore it today.
			if (Object.hasOwn(body, 'force') && body.force !== false) {
				if (body.force === true) {
					throw gitError('ForcePushNotAllowed');
				}
				throw gitError('InvalidRequest');
			}
			ctx.body = await backend.gitPush({
				branch: body.branch === undefined || body.branch === null ? undefined : requireText(body.branch, 'InvalidBranch'),
				...(body.expectedHead === undefined ? {} : { expectedHead: requireText(body.expectedHead, 'InvalidCommit') }),
				...(body.expectedRemoteId === undefined ? {} : { expectedRemoteId: requireText(body.expectedRemoteId, 'InvalidRemote') }),
				// `expectedRemote: null` means "the branch must not exist on the remote yet", so
				// the field is only forwarded when it is present in the body at all.
				...(Object.hasOwn(body, 'expectedRemote')
					? { expectedRemote: body.expectedRemote === null ? null : requireText(body.expectedRemote, 'InvalidCommit') }
					: {}),
			});
			ctx.status = 200;
			return;
		}

		if (ctx.method === 'POST' && path === gitPath + '/branch') {
			requireGitBackend(backend, 'gitSwitchBranch');
			const body = await readJson(ctx);
			const create = optionalBoolean(body.create, 'InvalidRequest');
			ctx.body = await backend.gitSwitchBranch({
				name: requireText(body.name, 'InvalidBranch'),
				create,
				...(create && body.startPoint !== undefined && body.startPoint !== null
					? { startPoint: requireText(body.startPoint, 'InvalidCommit') }
					: {}),
			});
			ctx.status = 200;
			return;
		}

		if (ctx.method === 'POST' && path === gitPath + '/checkpoints') {
			requireGitBackend(backend, 'gitCreateCheckpoint');
			const body = await readJson(ctx);
			ctx.body = await backend.gitCreateCheckpoint({
				name: requireText(body.name, 'InvalidName'),
				note: body.note === undefined || body.note === null ? '' : body.note,
				commit: body.commit === undefined || body.commit === null ? undefined : requireText(body.commit, 'InvalidCommit'),
				notePath: body.notePath === undefined || body.notePath === null ? undefined : requireText(body.notePath, 'InvalidPath'),
				branch: body.branch === undefined || body.branch === null ? undefined : requireText(body.branch, 'InvalidBranch'),
			});
			ctx.status = 201;
			return;
		}

		if (ctx.method === 'DELETE' && path.startsWith(gitPath + '/checkpoints/')) {
			requireGitBackend(backend, 'gitDeleteCheckpoint');
			ctx.body = await backend.gitDeleteCheckpoint({ checkpointId: checkpointIdOf(path) });
			ctx.status = 200;
			return;
		}

		if (ctx.method === 'PUT' && path === gitPath + '/repository') {
			requireGitBackend(backend, 'gitBindRepository');
			const body = await readJson(ctx);
			ctx.body = await backend.gitBindRepository({
				path: requireText(body.path, 'InvalidPath'),
				remote: body.remote === undefined || body.remote === null ? undefined : requireText(body.remote, 'InvalidRemote'),
				remoteBranch: body.remoteBranch === undefined || body.remoteBranch === null ? undefined : requireText(body.remoteBranch, 'InvalidBranch'),
				defaultBranch: body.defaultBranch === undefined || body.defaultBranch === null ? undefined : requireText(body.defaultBranch, 'InvalidBranch'),
				credentialId: body.credentialId === undefined || body.credentialId === null ? undefined : requireText(body.credentialId, 'InvalidCredential'),
			});
			ctx.status = 200;
			return;
		}

		if (ctx.method === 'DELETE' && path === gitPath + '/repository') {
			requireGitBackend(backend, 'gitUnbindRepository');
			ctx.body = await backend.gitUnbindRepository();
			ctx.status = 200;
			return;
		}

		if (ctx.method === 'PUT' && path === gitPath + '/credentials') {
			requireGitBackend(backend, 'gitPutCredential');
			const body = await readJson(ctx);
			ctx.body = await backend.gitPutCredential({
				credentialId: body.credentialId === undefined || body.credentialId === null ? undefined : requireText(body.credentialId, 'InvalidCredential'),
				kind: requireText(body.kind, 'InvalidCredential'),
				label: requireText(body.label, 'InvalidCredential'),
				secret: requireText(body.secret, 'InvalidCredential'),
			});
			ctx.status = 201;
			return;
		}

		if (ctx.method === 'DELETE' && path.startsWith(gitPath + '/credentials/')) {
			requireGitBackend(backend, 'gitDeleteCredential');
			const credentialId = path.slice((gitPath + '/credentials/').length);
			ctx.body = await backend.gitDeleteCredential({ credentialId: requireText(credentialId, 'InvalidCredential') });
			ctx.status = 200;
			return;
		}

		ctx.status = 405;
	} catch (error) {
		if (error instanceof WorkspaceError) {
			ctx.status = error.status;
			// `detail` is already sanitized by the repository layer (§5.2): no remote URL, no
			// credential and no host path survives in it. It is the only extra field, and it is
			// only present for the remote-facing failures where the operator needs the reason.
			ctx.body = error.detail ? { error: error.code, detail: error.detail } : { error: error.code };
			return;
		}
		if (error instanceof URIError) {
			ctx.status = 400;
			ctx.body = { error: 'InvalidPath' };
			return;
		}
		throw error;
	}
}
