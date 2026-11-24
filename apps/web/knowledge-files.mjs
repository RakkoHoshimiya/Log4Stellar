// HTTP layer of the knowledge index (docs/knowledge-links.md §3). Sibling of /static/mount,
// /sync/v1 and /git/v1: same gateway, same workspace lease, but its own mount point because the
// resources are derived data rather than files.
//
// The order in `serveKnowledgeRequest` is the contract, exactly as in git-files.mjs: the
// capability is resolved from the method and the path, `workspace.require()` decides, and only
// then is a single parameter looked at. An unauthorized caller cannot tell a malformed request
// from a well formed one.
//
// Every response is read-only over the index. The one write the product asks for — rewriting the
// links of every source document after a rename — is deliberately answered with 501, because the
// storage backend cannot commit several notes and their objects in one transaction and a partial
// rewrite reported as success is worse than no rewrite at all (docs/knowledge-links.md §4).

import { linkStatuses } from './knowledge-parser.mjs';
import { applyLinkRewrite, planLinkRewrite, rebuildKnowledgeIndex } from './knowledge-indexer.mjs';
import {
	decodeKnowledgeCursor,
	encodeKnowledgeCursor,
	knowledgePageSize,
} from './knowledge-store.mjs';
import { workspaceCapabilities } from './workspace-access.mjs';
import { WorkspaceError, normalizeWorkspacePath } from './workspace-contract.mjs';

export const knowledgeMountPath = '/api/knowledge';

export const knowledgeRoutes = {
	backlinks: knowledgeMountPath + '/backlinks',
	links: knowledgeMountPath + '/links',
	tags: knowledgeMountPath + '/tags',
	broken: knowledgeMountPath + '/broken',
	renamePlan: knowledgeMountPath + '/rename-plan',
	renameApply: knowledgeMountPath + '/rename-apply',
	reindex: knowledgeMountPath + '/reindex',
};

const maxBodyBytes = 64 * 1024;

// §2.2, same rule as the git route table: the capability is a function of the method and the
// path ONLY, resolved before the query is parsed or the body is read. Anything not listed here
// resolves to undefined, which the handler turns into 404 NotFound — never into a default read.
const routeTable = [
	{ method: 'GET', pattern: /^\/api\/knowledge\/backlinks$/, capability: workspaceCapabilities.read },
	{ method: 'HEAD', pattern: /^\/api\/knowledge\/backlinks$/, capability: workspaceCapabilities.read },
	{ method: 'GET', pattern: /^\/api\/knowledge\/links$/, capability: workspaceCapabilities.read },
	{ method: 'HEAD', pattern: /^\/api\/knowledge\/links$/, capability: workspaceCapabilities.read },
	{ method: 'GET', pattern: /^\/api\/knowledge\/tags$/, capability: workspaceCapabilities.read },
	{ method: 'HEAD', pattern: /^\/api\/knowledge\/tags$/, capability: workspaceCapabilities.read },
	{ method: 'GET', pattern: /^\/api\/knowledge\/tags\/[^/]+$/, capability: workspaceCapabilities.read },
	{ method: 'HEAD', pattern: /^\/api\/knowledge\/tags\/[^/]+$/, capability: workspaceCapabilities.read },
	{ method: 'GET', pattern: /^\/api\/knowledge\/broken$/, capability: workspaceCapabilities.read },
	{ method: 'HEAD', pattern: /^\/api\/knowledge\/broken$/, capability: workspaceCapabilities.read },
	// A rename preview re-reads the index and writes nothing, so a read role may ask for it —
	// the same reasoning as `POST /git/v1/fetch` (git-contract.mjs §2.1).
	{ method: 'POST', pattern: /^\/api\/knowledge\/rename-plan$/, capability: workspaceCapabilities.read },
	// Answering 501 for every caller keeps the surface identical whether or not the caller may
	// write; the write capability is still required so the refusal is not a hint about state.
	{ method: 'POST', pattern: /^\/api\/knowledge\/rename-apply$/, capability: workspaceCapabilities.write },
	{ method: 'POST', pattern: /^\/api\/knowledge\/reindex$/, capability: workspaceCapabilities.write },
];

export function capabilityForKnowledgeRequest(method, pathname) {
	const route = routeTable.find(entry => entry.method === method && entry.pattern.test(pathname));
	return route?.capability;
}

const identifierPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readJson(ctx) {
	if (!ctx.is('application/json')) {
		throw new WorkspaceError(415, 'InvalidContentType');
	}
	return (async () => {
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
	})();
}

function queryString(ctx, name) {
	const value = ctx.query[name];
	if (value === undefined || value === null || value === '') {
		return undefined;
	}
	// A repeated parameter with two different values is ambiguous, not a different request.
	if (Array.isArray(value)) {
		return value.length === 1 ? value[0] : '';
	}
	return String(value);
}

/** File and revision identifiers are opaque UUIDs; anything else is a malformed request. */
function requireIdentifier(value, code = 'InvalidRequest') {
	if (typeof value !== 'string' || !identifierPattern.test(value)) {
		throw new WorkspaceError(400, code);
	}
	return value;
}

function requireStore(store, method) {
	if (!store || typeof store[method] !== 'function') {
		throw new WorkspaceError(501, 'KnowledgeUnavailable');
	}
}

function pageFrom(rows, workspaceId, kind, limit) {
	if (rows.length < limit) {
		return { nextCursor: null };
	}
	const last = rows[rows.length - 1];
	return {
		nextCursor: encodeKnowledgeCursor({
			workspaceId,
			kind,
			path: last.sourcePath ?? '',
			order: [last.line, last.column],
		}),
	};
}

async function backlinks(ctx, store, workspaceId) {
	requireStore(store, 'listBacklinks');
	const fileId = requireIdentifier(queryString(ctx, 'fileId') ?? '', 'InvalidFileId');
	const limit = knowledgePageSize(queryString(ctx, 'limit'));
	const rawCursor = queryString(ctx, 'cursor');
	const cursor = rawCursor === undefined
		? undefined
		: decodeKnowledgeCursor(rawCursor, { workspaceId, kind: 'backlinks' });
	const links = await store.listBacklinks(workspaceId, fileId, { cursor, limit });
	const { nextCursor } = pageFrom(links, workspaceId, 'backlinks', limit);
	ctx.body = { fileId, links, nextCursor };
}

async function sourceLinks(ctx, store, workspaceId) {
	requireStore(store, 'listSourceLinks');
	const fileId = requireIdentifier(queryString(ctx, 'fileId') ?? '', 'InvalidFileId');
	const limit = knowledgePageSize(queryString(ctx, 'limit'));
	const rawCursor = queryString(ctx, 'cursor');
	const cursor = rawCursor === undefined
		? undefined
		: decodeKnowledgeCursor(rawCursor, { workspaceId, kind: 'links' });
	const links = await store.listSourceLinks(workspaceId, fileId, { cursor, limit });
	const { nextCursor } = pageFrom(links, workspaceId, 'links', limit);
	ctx.body = { fileId, links, nextCursor };
}

async function tags(ctx, store, workspaceId) {
	requireStore(store, 'listTags');
	const prefix = queryString(ctx, 'prefix');
	const limit = knowledgePageSize(queryString(ctx, 'limit'));
	ctx.body = { tags: await store.listTags(workspaceId, { prefix, limit }) };
}

async function tagOccurrences(ctx, store, workspaceId, tagKey) {
	requireStore(store, 'listTagOccurrences');
	const includeChildren = queryString(ctx, 'children') === 'true';
	const limit = knowledgePageSize(queryString(ctx, 'limit'));
	if (!tagKey) {
		throw new WorkspaceError(400, 'InvalidRequest');
	}
	const key = decodeURIComponent(tagKey);
	ctx.body = { tagKey: key, occurrences: await store.listTagOccurrences(workspaceId, key, { includeChildren, limit }) };
}

async function broken(ctx, store, workspaceId) {
	requireStore(store, 'listUnresolvedLinks');
	const status = queryString(ctx, 'status');
	if (status !== undefined && !linkStatuses.includes(status)) {
		throw new WorkspaceError(400, 'InvalidRequest');
	}
	const limit = knowledgePageSize(queryString(ctx, 'limit'));
	const rawCursor = queryString(ctx, 'cursor');
	const cursor = rawCursor === undefined
		? undefined
		: decodeKnowledgeCursor(rawCursor, { workspaceId, kind: 'broken' });
	const links = await store.listUnresolvedLinks(workspaceId, { cursor, limit, status });
	const { nextCursor } = pageFrom(links, workspaceId, 'broken', limit);
	ctx.body = { links, nextCursor };
}

async function renamePlan(ctx, store, workspaceId, backend) {
	requireStore(store, 'listLinksToFile');
	const body = await readJson(ctx);
	const fileId = requireIdentifier(body.fileId);
	// The new path is normalised before anything is read: `..`, a backslash or a NUL byte is a
	// malformed request, and a caller who cannot state a valid path cannot receive a plan either.
	const newPath = normalizeWorkspacePath(typeof body.newPath === 'string' ? body.newPath : '');
	const scope = { workspaceId, store, backend };
	ctx.body = await planLinkRewrite(scope, fileId, newPath);
}

async function renameApply(ctx, store, workspaceId, backend) {
	requireStore(store, 'listLinksToFile');
	const body = await readJson(ctx);
	const fileId = requireIdentifier(body.fileId);
	const newPath = normalizeWorkspacePath(typeof body.newPath === 'string' ? body.newPath : '');
	const expectedRevisions = Array.isArray(body.expectedRevisions) ? body.expectedRevisions : [];
	const planId = typeof body.planId === 'string' ? body.planId : undefined;
	const scope = { workspaceId, store, backend };
	ctx.body = await applyLinkRewrite(scope, { fileId, newPath, expectedRevisions, planId });
}

async function reindex(ctx, store, workspaceId, backend) {
	requireStore(store, 'listLiveFiles');
	const body = await readJson(ctx);
	const scope = { workspaceId, store, backend };
	const force = body.force === true;
	const report = await rebuildKnowledgeIndex(scope, { force });
	ctx.body = report;
}

/**
 * Dispatches one `/api/knowledge/*` request. `workspace` is the authorizeWorkspace() facade, so
 * the capability check happens before any parameter is decoded; `backend` is the workspace
 * backend the caller already leased, used to read note bodies while indexing.
 */
export async function serveKnowledgeRequest(ctx, workspace, backend, workspaceId, store) {
	const pathname = ctx.path;
	try {
		const capability = capabilityForKnowledgeRequest(ctx.method, pathname);
		if (!capability) {
			ctx.status = 404;
			ctx.body = { error: 'NotFound' };
			return;
		}
		workspace.require(capability);

		if (pathname === knowledgeRoutes.backlinks) {
			await backlinks(ctx, store, workspaceId);
			return;
		}
		if (pathname === knowledgeRoutes.links) {
			await sourceLinks(ctx, store, workspaceId);
			return;
		}
		if (pathname === knowledgeRoutes.tags) {
			await tags(ctx, store, workspaceId);
			return;
		}
		if (pathname.startsWith(knowledgeRoutes.tags + '/')) {
			const encoded = pathname.slice(knowledgeRoutes.tags.length + 1);
			await tagOccurrences(ctx, store, workspaceId, encoded);
			return;
		}
		if (pathname === knowledgeRoutes.broken) {
			await broken(ctx, store, workspaceId);
			return;
		}
		if (pathname === knowledgeRoutes.renamePlan) {
			await renamePlan(ctx, store, workspaceId, backend);
			return;
		}
		if (pathname === knowledgeRoutes.renameApply) {
			// One source document is written atomically; several are refused with 501 rather than
			// reported as applied, because the backend cannot commit them together with their
			// objects yet (docs/knowledge-links.md §4).
			await renameApply(ctx, store, workspaceId, backend);
			return;
		}
		if (pathname === knowledgeRoutes.reindex) {
			await reindex(ctx, store, workspaceId, backend);
			return;
		}
		ctx.status = 405;
	} catch (error) {
		if (error instanceof WorkspaceError) {
			ctx.status = error.status;
			ctx.body = error.conflicts ? { error: error.code, conflicts: error.conflicts } : { error: error.code };
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

export { linkStatuses as knowledgeLinkStatuses };
