// HTTP layer of the workspace full text search (docs: task 01 全文搜索). Sibling of
// /static/mount, /sync/v1 and /git/v1: same gateway, same lease, but it answers from
// the derived index instead of from the stored notes.
//
// The order in `serveSearchRequest` is the contract, copied from git-files.mjs and
// sync-files.mjs: the capability is resolved from the method and the path alone,
// `workspace.require()` decides, and only then is a single parameter looked at. An
// unauthorized caller therefore cannot tell a malformed request from a well formed
// one. Nothing here makes an authorization decision of its own.

import { capabilityForSearchRequest, searchError, normalizeSearchLimit, normalizeSearchQuery } from './search-contract.mjs';
import { WorkspaceError } from './workspace-contract.mjs';

export const searchPath = '/search/v1';

const searchEndpoints = Object.freeze({
	query: searchPath + '/query',
	reindex: searchPath + '/reindex',
	status: searchPath + '/status',
});

// A storage backend that predates this route (an older release, or the local
// workspace backend) answers 501 instead of crashing, exactly like
// `SyncUnavailable` and `GitUnavailable`.
function requireSearchBackend(backend, method) {
	if (typeof backend[method] !== 'function') {
		throw searchError('SearchUnavailable');
	}
}

function queryString(ctx, name) {
	const value = ctx.query[name];
	if (value === undefined || value === null || value === '') {
		return undefined;
	}
	// `ctx.query` gives an array for a repeated parameter. Repeating a parameter with one
	// value is not a different request, but two values are ambiguous: picking either one
	// would make the answer depend on parsing order, so the request is refused instead.
	if (Array.isArray(value)) {
		if (value.length !== 1) {
			throw searchError('InvalidRequest');
		}
		return String(value[0]);
	}
	return String(value);
}

/**
 * Serves one /search/v1 request. `workspace` is the facade produced by
 * `authorizeWorkspace(backend, { role })`, so every backend call below has already
 * passed through the capability matrix; `backend` is the same object the facade wraps
 * and is only used to decide whether this storage implementation supports search at
 * all.
 *
 * The result is plain JSON: excerpts are text and the client highlights by offset. No
 * markup is ever built here, so a note containing HTML cannot inject anything.
 */
export async function serveSearchRequest(ctx, workspace, backend, workspaceId, maxBytes) {
	// The gateway passes the workspace id and the upload limit for symmetry with
	// serveSyncRequest(); this route needs neither. The backend is already scoped to the
	// workspace, and no request here carries file content.
	void workspaceId;
	void maxBytes;
	try {
		const capability = capabilityForSearchRequest(ctx.method, ctx.path);
		if (capability === undefined) {
			throw searchError('NotFound');
		}
		if (!workspace.require) {
			throw new Error('The workspace must be wrapped by authorizeWorkspace().');
		}
		workspace.require(capability);

		const path = ctx.path;

		if ((ctx.method === 'GET' || ctx.method === 'HEAD') && path === searchEndpoints.query) {
			requireSearchBackend(backend, 'searchDocuments');
			// The capability is already granted at this point, so an empty or oversized
			// query is answered 400: it is a client mistake, not an authorization fact.
			const query = normalizeSearchQuery(queryString(ctx, 'q'));
			const limit = normalizeSearchLimit(queryString(ctx, 'limit'));
			const cursor = queryString(ctx, 'cursor');
			ctx.body = await workspace.searchDocuments({ query, cursor, limit });
			ctx.status = 200;
			return;
		}

		if ((ctx.method === 'GET' || ctx.method === 'HEAD') && path === searchEndpoints.status) {
			requireSearchBackend(backend, 'searchStatus');
			ctx.body = await workspace.searchStatus();
			ctx.status = 200;
			return;
		}

		if (ctx.method === 'POST' && path === searchEndpoints.reindex) {
			requireSearchBackend(backend, 'reindexWorkspace');
			// Rebuilding rewrites derived state for the whole workspace, so it is an admin
			// action: a reader cannot make everyone's search slower.
			ctx.body = await workspace.reindexWorkspace();
			ctx.status = 202;
			return;
		}

		ctx.status = 405;
	} catch (error) {
		if (error instanceof WorkspaceError) {
			ctx.status = error.status;
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
