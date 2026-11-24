import {
	capabilityForSyncRequest,
	decodeCursor,
	decodePageToken,
	isUuid,
	normalizeDeviceId,
	idempotencyFingerprint,
	normalizePageSize,
	requireBaseRevision,
	requireIdempotencyKey,
	requireUploadMode,
	syncHeaders,
	syncPageLimits,
} from './sync-contract.mjs';
import { WorkspaceError } from './workspace-contract.mjs';

// The sync API is a sibling of /static/mount, not a child: the two have different conflict
// semantics (412 vs 409, docs/incremental-sync.md §6.2) and must never be routed together.
export const syncPath = '/sync/v1';

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
	try {
		const value = JSON.parse(text);
		if (value === null || typeof value !== 'object' || Array.isArray(value)) {
			throw new WorkspaceError(400, 'InvalidRequest');
		}
		return value;
	} catch (error) {
		if (error instanceof WorkspaceError) {
			throw error;
		}
		throw new WorkspaceError(400, 'InvalidRequest');
	}
}

// Mutations share one header contract: a device slug is optional, the idempotency key is
// optional outside PUT (docs/incremental-sync.md §8.6 only promises `replayed` for the
// others), and a cursor may arrive either as a query parameter or as the documented header.
function deviceOf(ctx) {
	return normalizeDeviceId(ctx.get(syncHeaders.device));
}

function keyOf(ctx) {
	const raw = ctx.get(syncHeaders.idempotencyKey);
	return raw === undefined || raw === null || raw === '' ? undefined : requireIdempotencyKey(raw);
}

// The contract fingerprints the method, the target path, the base revision, the device,
// and the request's outcome-changing flags (§5.2) so that a retry of the SAME request
// replays while a different request under the same key is rejected. PUT derives its
// fingerprint from the streamed digest plus its `mode`; the other mutations have no
// content, so the request shape (including `overwrite` / `keepBoth`) is the whole identity.
// `overwrite` and `keepBoth` are not decoration: same key with overwrite flipped from
// false to true is a different request, and replaying the first answer would tell the
// client "done" about a replacement that never ran.
function fingerprintOf(method, path, { targetPath, baseRevision, device, mode, overwrite, keepBoth } = {}) {
	return idempotencyFingerprint({ method, path, targetPath, baseRevision, device, mode, overwrite, keepBoth });
}

function baseRevisionOf(ctx, required) {
	const raw = ctx.get(syncHeaders.baseRevision);
	if (raw === undefined || raw === null || raw === '') {
		return required ? requireBaseRevision(raw) : null;
	}
	return requireBaseRevision(raw);
}

function cursorOf(ctx, workspaceId, { required = false } = {}) {
	const raw = ctx.query.cursor ?? ctx.get(syncHeaders.cursor);
	if (raw === undefined || raw === null || raw === '') {
		if (required) {
			throw new WorkspaceError(400, 'InvalidCursor');
		}
		return null;
	}
	// decodeCursor() performs the §3 validation order: length, three segments, checksum
	// BEFORE JSON.parse, payload shape. Semantic checks (retention, head, expiry) happen in
	// the backend, because they need the stored head (§3.3).
	return decodeCursor(raw, { workspaceId });
}

// A backend that predates the sync API (the local-disk demo backend) has none of the
// sync* methods. Answering 501 beats a 500 from calling an undefined function, and the
// capability check still runs first, so an unauthorized caller cannot probe for support.
function requireSyncBackend(backend, method) {
	if (typeof backend[method] !== 'function') {
		throw new WorkspaceError(501, 'SyncUnavailable');
	}
}

export async function serveSyncRequest(ctx, workspace, backend, workspaceId, maxBytes) {
	try {
		// §8 preamble: the capability check runs before any parameter validation, so an
		// unauthorized caller learns nothing about the request shape.
		const capability = capabilityForSyncRequest(ctx.method, ctx.path);
		if (capability === undefined) {
			throw new WorkspaceError(404, 'NotFound');
		}
		if (!workspace.require) {
			throw new Error('The workspace must be wrapped by authorizeWorkspace().');
		}
		workspace.require(capability);

		const path = ctx.path;
		if (ctx.method === 'GET' && path === '/sync/v1/changes') {
			requireSyncBackend(backend, 'syncChanges');
			const limit = normalizePageSize(ctx.query.limit);
			const cursor = cursorOf(ctx, workspaceId);
			ctx.body = await backend.syncChanges({ cursor, limit });
			ctx.status = 200;
			return;
		}

		if (ctx.method === 'POST' && path === '/sync/v1/snapshot') {
			requireSyncBackend(backend, 'syncSnapshot');
			const body = await readJson(ctx);
			const limit = normalizePageSize(body.limit, { maximum: syncPageLimits.maxSnapshotSize });
			ctx.body = await backend.syncSnapshot({ limit });
			ctx.status = 201;
			return;
		}

		if (ctx.method === 'GET' && path.startsWith('/sync/v1/snapshot/')) {
			requireSyncBackend(backend, 'syncSnapshotPage');
			const snapshotId = path.slice('/sync/v1/snapshot/'.length).toLowerCase();
			const token = ctx.query.token;
			const limit = normalizePageSize(ctx.query.limit, { maximum: syncPageLimits.maxSnapshotSize });
			// An absent token starts at the first path; a present one must belong to this
			// snapshot (§4.3), otherwise a token from another snapshot silently resumes here.
			const lastPath = token === undefined || token === null || token === ''
				? ''
				: decodePageToken(token, { snapshotId }).lastPath;
			const page = await backend.syncSnapshotPage({ snapshotId, lastPath, limit });
			ctx.body = {
				snapshotId: page.snapshotId,
				seq: page.seq,
				entryCount: page.entryCount,
				expiresAt: page.expiresAt,
				entries: page.entries,
				pageToken: page.pageToken,
				hasMore: page.hasMore,
			};
			ctx.status = 200;
			return;
		}

		if (ctx.method === 'PUT' && path === '/sync/v1/file') {
			requireSyncBackend(backend, 'syncPutFile');
			const mode = requireUploadMode(ctx.query.mode);
			const baseRevision = baseRevisionOf(ctx, mode === 'save');
			const idempotencyKey = requireIdempotencyKey(ctx.get(syncHeaders.idempotencyKey));
			const device = deviceOf(ctx);
			if (!ctx.is('application/octet-stream')) {
				throw new WorkspaceError(415, 'InvalidContentType');
			}
			const length = Number(ctx.get('Content-Length') ?? 0);
			if (length > maxBytes) {
				throw new WorkspaceError(413, 'FileTooLarge');
			}
			if (ctx.query.path === undefined || ctx.query.path === null || ctx.query.path === '') {
				throw new WorkspaceError(400, 'InvalidPath');
			}
			const result = await backend.syncPutFile({
				path: ctx.query.path,
				mode,
				baseRevision,
				idempotencyKey,
				device,
				source: ctx.req,
				maxBytes,
			});
			ctx.status = result.status;
			ctx.body = result.body;
			if (result.body.etag) {
				ctx.set('ETag', result.body.etag);
			}
			return;
		}

		if (ctx.method === 'DELETE' && path === '/sync/v1/file') {
			requireSyncBackend(backend, 'syncDelete');
			const body = ctx.is('application/json') ? await readJson(ctx) : {};
			const target = ctx.query.path ?? body.path;
			if (typeof target !== 'string' || target === '') {
				throw new WorkspaceError(400, 'InvalidPath');
			}
			const recursive = ctx.query.recursive === '1' || ctx.query.recursive === 'true' || body.recursive === true;
			const device = deviceOf(ctx);
			const result = await backend.syncDelete({
				path: target,
				recursive,
				idempotencyKey: keyOf(ctx),
				fingerprint: fingerprintOf('DELETE', target, { targetPath: recursive ? '*' : null, device }),
				device,
			});
			ctx.status = result.status;
			ctx.body = result.body;
			return;
		}

		if (ctx.method === 'POST' && path === '/sync/v1/rename') {
			requireSyncBackend(backend, 'syncRename');
			const body = await readJson(ctx);
			if (typeof body.from !== 'string' || typeof body.to !== 'string' || !body.from || !body.to) {
				throw new WorkspaceError(400, 'InvalidPath');
			}
			const device = deviceOf(ctx);
			const result = await backend.syncRename({
				from: body.from,
				to: body.to,
				overwrite: body.overwrite === true,
				idempotencyKey: keyOf(ctx),
				fingerprint: fingerprintOf('POST', body.from, { targetPath: body.to, device, overwrite: body.overwrite === true }),
				device,
			});
			ctx.status = result.status;
			ctx.body = result.body;
			return;
		}

		if (ctx.method === 'POST' && path === '/sync/v1/mkdir') {
			requireSyncBackend(backend, 'syncMkdir');
			const body = await readJson(ctx);
			if (typeof body.path !== 'string' || body.path === '') {
				throw new WorkspaceError(400, 'InvalidPath');
			}
			const device = deviceOf(ctx);
			const result = await backend.syncMkdir({
				path: body.path,
				idempotencyKey: keyOf(ctx),
				fingerprint: fingerprintOf('POST', body.path, { device }),
				device,
			});
			ctx.status = result.status;
			ctx.body = result.body;
			return;
		}

		if (ctx.method === 'POST' && path === '/sync/v1/restore') {
			requireSyncBackend(backend, 'syncRestore');
			const body = await readJson(ctx);
			if (typeof body.trashId !== 'string' || !isUuid(body.trashId)) {
				throw new WorkspaceError(400, 'InvalidTrashId');
			}
			const device = deviceOf(ctx);
			const result = await backend.syncRestore({
				trashId: body.trashId,
				keepBoth: body.keepBoth === true,
				idempotencyKey: keyOf(ctx),
				fingerprint: fingerprintOf('POST', '/sync/v1/restore', { targetPath: body.trashId, device, keepBoth: body.keepBoth === true }),
				device,
			});
			ctx.status = result.status;
			ctx.body = result.body;
			return;
		}

		if (ctx.method === 'POST' && path === '/sync/v1/rollback') {
			requireSyncBackend(backend, 'syncRollback');
			const body = await readJson(ctx);
			if (typeof body.path !== 'string' || body.path === '') {
				throw new WorkspaceError(400, 'InvalidPath');
			}
			if (!isUuid(body.revisionId)) {
				throw new WorkspaceError(400, 'InvalidRevision');
			}
			// §8.6 gives rollback a baseRevision: rolling back onto a path that moved on is a
			// stale-write attempt, and the caller must say which state it saw.
			const baseRevision = requireBaseRevision(body.baseRevision ?? ctx.get(syncHeaders.baseRevision));
			const device = deviceOf(ctx);
			const result = await backend.syncRollback({
				path: body.path,
				revisionId: body.revisionId,
				baseRevision,
				idempotencyKey: keyOf(ctx),
				fingerprint: fingerprintOf('POST', body.path, { targetPath: body.revisionId, baseRevision, device }),
				device,
			});
			ctx.status = result.status;
			ctx.body = result.body;
			return;
		}

		if (ctx.method === 'GET' && path === '/sync/v1/conflicts') {
			requireSyncBackend(backend, 'syncConflicts');
			const limit = normalizePageSize(ctx.query.limit);
			const cursor = cursorOf(ctx, workspaceId);
			ctx.body = await backend.syncConflicts({ cursor, limit });
			ctx.status = 200;
			return;
		}

		if (ctx.method === 'GET' && path === '/sync/v1/conflict') {
			requireSyncBackend(backend, 'syncConflict');
			const target = ctx.query.path;
			if (typeof target !== 'string' || target === '') {
				throw new WorkspaceError(400, 'InvalidPath');
			}
			ctx.body = await backend.syncConflict({ path: target });
			ctx.status = 200;
			return;
		}

		ctx.status = 405;
	} catch (error) {
		if (error instanceof WorkspaceError) {
			ctx.status = error.status;
			ctx.body = { error: error.code };
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
