// HTTP layer of the multi-tenant API (docs/multi-tenant.md §4).
//
// Sibling of /static/mount, /sync/v1 and /git/v1: same gateway, same session, different
// resource shape, so it is a separate mount point rather than a sub-resource of a
// workspace. The order of operations follows git-files.mjs, which is the precedent that
// matters: the capability is resolved from the method and the path *first*, the scope is
// resolved second, and only then is a single request parameter looked at. An unauthorized
// caller therefore cannot tell a malformed request from a well-formed one.
//
// Two rules are specific to this surface:
//
//   * Every tenant-scoped read goes through `resolveTenantScope`, so a tenant the caller
//     does not belong to is a uniform 404 and never a 403. A 403 would confirm the tenant
//     exists, and tenant ids appear in URLs, exports and audit rows (acceptance case T01).
//   * The invitation-accept endpoint is the one route with no tenant in its URL and no
//     membership precondition: the bearer token in the body *is* the credential. It still
//     requires a session, because the membership row it creates is keyed by the accepting
//     account, and accepting an invitation without being signed in would have to invent a
//     principal.

import { WorkspaceError } from './workspace-contract.mjs';
import { capabilityForTenantRequest, tenantPageLimits, tenantEmailPattern } from './tenant-contract.mjs';
import { resolveTenantScope, tenantCapabilities } from './tenant-service.mjs';
import { digestInvitationToken, normalizeTenantRole } from './tenant-store.mjs';

export const tenantPath = '/api/v1/tenants';
export const invitationAcceptPath = '/api/v1/invitations/accept';

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

// A tenant id is an unguessable opaque identifier, not a name: it is generated once and
// never derived from the display name, because the display name is user input and a
// derived id would let one tenant claim another's identifier by renaming itself.
const tenantIdPattern = /^[a-z0-9][a-z0-9-]{0,62}$/;

function requireTenantId(value) {
	if (typeof value !== 'string' || !tenantIdPattern.test(value)) {
		throw new WorkspaceError(400, 'InvalidTenantId');
	}
	return value;
}

function requireText(value, code, { max = 256 } = {}) {
	if (typeof value !== 'string') {
		throw new WorkspaceError(400, code);
	}
	const trimmed = value.trim();
	if (trimmed.length === 0 || trimmed.length > max) {
		throw new WorkspaceError(400, code);
	}
	return trimmed;
}

function requireEmail(value) {
	if (typeof value !== 'string' || !tenantEmailPattern.test(value.trim())) {
		throw new WorkspaceError(400, 'InvalidEmail');
	}
	return value.trim().toLowerCase();
}

function requireVersion(value) {
	if (!Number.isInteger(value) || value < 1) {
		throw new WorkspaceError(400, 'InvalidVersion');
	}
	return value;
}

// Splits /api/v1/tenants/<id>/<segment>/<rest...> into its parts without throwing: the
// caller decides whether a shape is a 404 (unknown route) or a 400 (known route, bad id).
function segmentsOf(path) {
	const rest = path.slice(tenantPath.length);
	const parts = rest.split('/').filter(part => part.length > 0).map(part => decodeURIComponent(part));
	return parts;
}

function limitOf(query, fallback, maximum) {
	const raw = query.limit;
	if (raw === undefined || raw === '') {
		return fallback;
	}
	const value = Number(raw);
	if (!Number.isInteger(value) || value < 1 || value > maximum) {
		throw new WorkspaceError(400, 'InvalidLimit');
	}
	return value;
}

/**
 * Serves one tenant API request.
 *
 * `principalId` is the authenticated account, always supplied by the gateway: this module
 * never reads a cookie or a session. `store` is the tenant store, `readWorkspaceMapping` the
 * callback that resolves the workspace → tenant row, `resolveWorkspaceRole` the auth callback,
 * `createTenantRecord` the cross-database bookkeeping, and `isPlatformAdmin` the separate
 * decision "may this account create tenants at all" — kept as a callback because it is
 * deployment policy, not tenant policy.
 */
export async function serveTenantRequest(ctx, { principalId, store, readWorkspaceMapping, resolveWorkspaceRole, isPlatformAdmin, createTenantRecord }) {
	try {
		const capability = capabilityForTenantRequest(ctx.method, ctx.path);
		if (capability === undefined) {
			throw new WorkspaceError(404, 'NotFound');
		}

		// Invitation acceptance is addressed by token, not by tenant, so it is dispatched
		// before anything tries to read a tenant id out of the path.
		if (ctx.path === invitationAcceptPath) {
			if (ctx.method !== 'POST') {
				throw new WorkspaceError(405, 'MethodNotAllowed');
			}
			const body = await readJson(ctx);
			const token = requireText(body.token, 'InvalidInvitationToken', { max: 512 });
			const accepted = store.acceptInvitation(principalId, await digestInvitationToken(token));
			ctx.body = accepted;
			ctx.status = 200;
			return;
		}

		const segments = segmentsOf(ctx.path);

		// GET /api/v1/tenants — the caller's own memberships. No tenant id, no scope: it is
		// the discovery call a client makes before it knows which tenants exist.
		if (segments.length === 0) {
			if (ctx.method === 'GET' || ctx.method === 'HEAD') {
				ctx.body = { tenants: store.listTenants(principalId) };
				ctx.status = 200;
				return;
			}
			if (ctx.method === 'POST') {
				if (typeof isPlatformAdmin !== 'function' || !isPlatformAdmin(principalId)) {
					// Not "forbidden for this tenant" but "forbidden for this deployment":
					// creating a tenant is above every tenant, so no tenant scope exists to
					// check and the answer is a plain 403.
					throw new WorkspaceError(403, 'NoPermissions');
				}
				const body = await readJson(ctx);
				const requestedId = body.tenantId === undefined ? null : requireTenantId(body.tenantId);
				const tenantId = requestedId ?? randomTenantId();
				const idempotencyKey = typeof body.idempotencyKey === 'string' && body.idempotencyKey.length > 0
					? requireText(body.idempotencyKey, 'InvalidIdempotencyKey', { max: 128 })
					: null;
				const created = await createTenantWithMapping({
					store, createTenantRecord, tenantId, name: requireText(body.name, 'InvalidTenantName', { max: 128 }),
					ownerId: principalId, idempotencyKey,
				});
				ctx.body = created;
				ctx.status = created.created ? 201 : 200;
				return;
			}
			throw new WorkspaceError(405, 'MethodNotAllowed');
		}

		const tenantId = requireTenantId(segments[0]);

		// GET /api/v1/tenants/:id/members — administration only.
		if (segments.length === 2 && segments[1] === 'members') {
			const scope = await resolveTenantScope({ store, readWorkspaceMapping, principalId, tenantId, capability: tenantCapabilities.admin, resolveWorkspaceRole });
			if (ctx.method === 'GET' || ctx.method === 'HEAD') {
				const page = store.listTenantMembers(principalId, scope.tenantId, {
					cursor: typeof ctx.query.cursor === 'string' ? ctx.query.cursor : null,
					limit: limitOf(ctx.query, tenantPageLimits.defaultMembers, tenantPageLimits.maxMembers),
				});
				ctx.body = page;
				ctx.status = 200;
				return;
			}
			throw new WorkspaceError(405, 'MethodNotAllowed');
		}

		// POST /api/v1/tenants/:id/invitations — the token is generated here, returned once,
		// and stored only as a digest.
		if (segments.length === 2 && segments[1] === 'invitations' && ctx.method === 'POST') {
			const scope = await resolveTenantScope({ store, readWorkspaceMapping, principalId, tenantId, capability: tenantCapabilities.admin, resolveWorkspaceRole });
			const body = await readJson(ctx);
			const email = requireEmail(body.email);
			const role = normalizeTenantRole(body.role ?? 'member');
			const token = randomToken();
			const issued = store.issueInvitation(principalId, scope.tenantId, {
				invitationId: randomTenantId(),
				email,
				role,
				tokenDigest: await digestInvitationToken(token),
				lifetimeMs: body.lifetimeMs === undefined ? undefined : body.lifetimeMs,
			});
			// The plaintext token leaves the process exactly once, in this response. It is
			// not logged, not audited and not stored: the audit row records the invitation
			// id, which is enough to correlate a later acceptance with who issued it.
			ctx.body = { ...issued, token };
			ctx.status = 201;
			return;
		}

		// DELETE /api/v1/tenants/:id/invitations/:invitationId — withdraw a pending invite.
		if (segments.length === 3 && segments[1] === 'invitations' && ctx.method === 'DELETE') {
			const scope = await resolveTenantScope({ store, readWorkspaceMapping, principalId, tenantId, capability: tenantCapabilities.admin, resolveWorkspaceRole });
			ctx.body = store.revokeInvitation(principalId, scope.tenantId, requireTenantId(segments[2]));
			ctx.status = 200;
			return;
		}

		// PATCH / DELETE /api/v1/tenants/:id/members/:userId
		if (segments.length === 3 && segments[1] === 'members') {
			const scope = await resolveTenantScope({ store, readWorkspaceMapping, principalId, tenantId, capability: tenantCapabilities.admin, resolveWorkspaceRole });
			const targetUserId = requireText(segments[2], 'InvalidUserId', { max: 128 });
			if (ctx.method === 'PATCH') {
				const body = await readJson(ctx);
				ctx.body = store.changeTenantRole(principalId, scope.tenantId, targetUserId, {
					role: normalizeTenantRole(body.role),
					// The version may arrive in the body or as an If-Match-like header; the
					// body wins, because a proxy is allowed to strip unknown headers.
					expectedVersion: requireVersion(body.version ?? Number(ctx.get('X-Log4Stellar-Member-Version'))),
				});
				ctx.status = 200;
				return;
			}
			if (ctx.method === 'DELETE') {
				ctx.body = store.revokeTenantMember(principalId, scope.tenantId, targetUserId, {
					expectedVersion: requireVersion(Number(ctx.query.version ?? ctx.get('X-Log4Stellar-Member-Version'))),
				});
				ctx.status = 200;
				return;
			}
			throw new WorkspaceError(405, 'MethodNotAllowed');
		}

		// GET /api/v1/tenants/:id/audit — administration only, newest first.
		if (segments.length === 2 && segments[1] === 'audit' && (ctx.method === 'GET' || ctx.method === 'HEAD')) {
			const scope = await resolveTenantScope({ store, readWorkspaceMapping, principalId, tenantId, capability: tenantCapabilities.admin, resolveWorkspaceRole });
			const rawCursor = ctx.query.cursor;
			const cursor = typeof rawCursor === 'string' && /^\d+$/.test(rawCursor) ? Number(rawCursor) : null;
			ctx.body = store.listTenantAudit(principalId, scope.tenantId, {
				cursor,
				limit: limitOf(ctx.query, tenantPageLimits.defaultAudit, tenantPageLimits.maxAudit),
				action: typeof ctx.query.action === 'string' && ctx.query.action.length > 0 ? ctx.query.action : null,
			});
			ctx.status = 200;
			return;
		}

		// GET /api/v1/tenants/:id/workspaces/:workspaceId — the tenant's view of one
		// workspace. It is the only route that exercises all four conjuncts of
		// resolveTenantScope, which is why the acceptance test for cross-tenant access
		// (T01) is written against it.
		if (segments.length === 3 && segments[1] === 'workspaces' && (ctx.method === 'GET' || ctx.method === 'HEAD')) {
			const scope = await resolveTenantScope({
				store, readWorkspaceMapping, principalId, tenantId,
				workspaceId: segments[2],
				capability: tenantWorkspaceCapability(ctx.query),
				resolveWorkspaceRole,
			});
			ctx.body = {
				tenantId: scope.tenantId,
				workspaceId: scope.workspaceId,
				tenantRole: scope.tenantRole,
				workspaceRole: scope.workspaceRole,
			};
			ctx.status = 200;
			return;
		}

		throw new WorkspaceError(404, 'NotFound');
	} catch (error) {
		if (error instanceof WorkspaceError) {
			ctx.status = error.status;
			// The body is the stable code only: a message may carry the tenant name, the
			// invited address or the reason an invitation was refused, and none of that
			// belongs in a response to a caller who has not been authorized for it.
			ctx.body = { error: error.code };
			return;
		}
		throw error;
	}
}

// The workspace-scoped tenant route needs the workspace capability, not the tenant one:
// reading a member list is governance, reading the notes inside a workspace is content.
function tenantWorkspaceCapability(query) {
	if (query.history === '1' || query.versions === '1') {
		return 'workspace.history';
	}
	return 'workspace.read';
}

/**
 * Creates a tenant and records the mapping, in the one order that fails closed.
 *
 * The PostgreSQL mapping is written first and SQLite second, deliberately: a workspace
 * that exists without a tenant membership is invisible (the mapping gate in
 * `resolveTenantScope` refuses it), while a tenant membership without a workspace would
 * open a workspace id that has no rows behind it. If the SQLite transaction then fails,
 * the mapping is flipped to `failed` and the caller sees the error, so a retry with the
 * same idempotency key updates the existing row instead of creating a second tenant
 * (acceptance case T04).
 */
async function createTenantWithMapping({ store, createTenantRecord, tenantId, name, ownerId, idempotencyKey }) {
	const created = store.createTenant({ tenantId, name, ownerId, idempotencyKey });
	if (!created.created) {
		// A replay of a request that already succeeded. Nothing is written a second time.
		return created;
	}
	if (typeof createTenantRecord === 'function') {
		try {
			await createTenantRecord({ tenantId, idempotencyKey });
		} catch {
			// The tenant row exists and is usable; only the cross-database bookkeeping failed.
			// Throwing here would leave the caller believing nothing was created, so the
			// failure is reported and the tenant stays — a second attempt with the same key
			// replays it instead of creating a second tenant.
			throw new WorkspaceError(503, 'TenantMappingFailed');
		}
	}
	return created;
}

function randomTenantId() {
	return 't-' + randomToken().slice(0, 24);
}

function randomToken() {
	// 32 bytes of CSPRNG output, base64url, no padding: long enough that a guessing
	// attacker gets nothing, and URL-safe so it can travel in a query string.
	const bytes = new Uint8Array(32);
	globalThis.crypto.getRandomValues(bytes);
	return Buffer.from(bytes).toString('base64url');
}
