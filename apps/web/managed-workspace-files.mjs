import { WorkspaceError } from './workspace-contract.mjs';

export const managedWorkspacePath = '/api/v2/management';

async function readBody(ctx) {
	if (!ctx.is('application/json')) {
		throw new WorkspaceError(415, 'InvalidContentType');
	}
	const chunks = [];
	let bytes = 0;
	for await (const chunk of ctx.req) {
		bytes += chunk.length;
		if (bytes > 16_384) {
			throw new WorkspaceError(413, 'RequestTooLarge');
		}
		chunks.push(chunk);
	}
	try {
		const payload = JSON.parse(Buffer.concat(chunks));
		if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
			return payload;
		}
	} catch {
		// Invalid requests return a stable code.
	}
	throw new WorkspaceError(400, 'InvalidRequest');
}

function auditCursor(ctx) {
	const cursor = ctx.query?.cursor ?? null;
	if (cursor !== null && (typeof cursor !== 'string' || !/^\d{1,18}$/.test(cursor))) {
		throw new WorkspaceError(400, 'InvalidCursor');
	}
	return cursor;
}

const routes = [
	['GET', /^\/platform$/, (store, actor) => store.platformDirectory(actor)],
	['POST', /^\/platform\/tenants$/, async (store, actor, ctx) => store.createTenantWithAdmin(actor, await readBody(ctx))],
	['GET', /^\/tenants$/, async (store, actor) => ({
		tenants: await store.listTenants(actor), platformAdmin: await store.isPlatformAdmin(actor),
	})],
	['GET', /^\/workspaces$/, async (store, actor) => ({ workspaces: await store.workspacesOf(actor) })],
	['POST', /^\/invitations\/accept$/, async (store, actor, ctx) => store.acceptInvitation(actor, (await readBody(ctx)).token)],
	['GET', /^\/tenants\/([^/]+)\/security$/, (store, actor, _ctx, tenantId) =>
		store.readTenantSecurity(actor, tenantId)],
	['PUT', /^\/tenants\/([^/]+)\/security$/, async (store, actor, ctx, tenantId) =>
		store.setTenantSecurity(actor, tenantId, await readBody(ctx))],
	['GET', /^\/tenants\/([^/]+)\/members$/, async (store, actor, _ctx, tenantId) => ({
		members: await store.listTenantMembers(actor, tenantId),
	})],
	['PUT', /^\/tenants\/([^/]+)\/members\/([^/]+)$/, async (store, actor, ctx, tenantId, userId) =>
		store.changeTenantMember(actor, tenantId, userId, await readBody(ctx))],
	['GET', /^\/tenants\/([^/]+)\/invitations$/, async (store, actor, _ctx, tenantId) => ({
		invitations: await store.listPendingInvitations(actor, tenantId),
	})],
	['POST', /^\/tenants\/([^/]+)\/invitations$/, async (store, actor, ctx, tenantId) =>
		store.issueInvitation(actor, tenantId, await readBody(ctx))],
	['DELETE', /^\/tenants\/([^/]+)\/invitations\/([^/]+)$/, (store, actor, _ctx, tenantId, invitationId) =>
		store.revokeInvitation(actor, tenantId, invitationId)],
	['GET', /^\/tenants\/([^/]+)\/audit$/, (store, actor, ctx, tenantId) =>
		store.readTenantAudit(actor, tenantId, auditCursor(ctx))],
	['GET', /^\/tenants\/([^/]+)\/workspaces$/, async (store, actor, _ctx, tenantId) => ({
		workspaces: await store.listManagedWorkspaces(actor, tenantId),
	})],
	['POST', /^\/tenants\/([^/]+)\/workspaces$/, async (store, actor, ctx, tenantId) =>
		store.createTenantWorkspace(actor, tenantId, await readBody(ctx))],
	['GET', /^\/tenants\/([^/]+)\/workspaces\/([^/]+)\/members$/, async (store, actor, _ctx, tenantId, workspaceId) => ({
		members: await store.listWorkspaceGrants(actor, tenantId, workspaceId),
	})],
	['PUT', /^\/tenants\/([^/]+)\/workspaces\/([^/]+)\/members\/([^/]+)$/, async (store, actor, ctx, tenantId, workspaceId, userId) =>
		store.setWorkspaceMemberRole(actor, tenantId, workspaceId, userId, await readBody(ctx))],
];

export async function serveManagedWorkspaceRequest(ctx, { store, principalId, hasSecondFactor = async () => false }) {
	try {
		if (!principalId) {
			throw new WorkspaceError(401, 'AuthenticationRequired');
		}
		const path = ctx.path.slice(managedWorkspacePath.length);
		for (const [method, pattern, handler] of routes) {
			if (ctx.method !== method) {
				continue;
			}
			const params = pattern.exec(path);
			if (params) {
				const tenant = /^\/tenants\/([^/]+)\/(.+)$/.exec(path);
				const policyRoute = tenant?.[2] === 'security';
				if (tenant && !(policyRoute && method === 'GET')) {
					await store.describeMembership(principalId, tenant[1]);
					if ((policyRoute || await store.requiresSecondFactor(tenant[1])) && !await hasSecondFactor()) {
						throw new WorkspaceError(403, 'TenantSecondFactorRequired');
					}
				}
				ctx.body = await handler(store, principalId, ctx, ...params.slice(1));
				if (policyRoute && method === 'GET') {
					ctx.body = { ...ctx.body, verifiedSession: await hasSecondFactor() };
				}
				if (path === '/workspaces' && !await hasSecondFactor()) {
					const allowed = [];
					for (const workspace of ctx.body.workspaces) {
						if (!await store.requiresSecondFactor(workspace.tenantId)) allowed.push(workspace);
					}
					ctx.body = { workspaces: allowed };
				}
				ctx.status = 200;
				return;
			}
		}
		throw new WorkspaceError(404, 'NotFound');
	} catch (error) {
		if (!(error instanceof WorkspaceError)) {
			throw error;
		}
		ctx.status = error.status;
		ctx.body = { error: error.code };
	}
}
