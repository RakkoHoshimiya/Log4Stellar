// Shared vocabulary of the multi-tenant API (docs/multi-tenant.md §4).
//
// Kept separate from `tenant-files.mjs` for the reason `sync-contract.mjs` and
// `git-contract.mjs` are separate from their handlers: the capability map and the page
// limits are the parts a test can check without a server, a database or a session. The
// handler is allowed to be wrong about how it routes; the contract is not allowed to be
// ambiguous about what a route needs.

import { tenantCapabilities } from './tenant-service.mjs';

export const tenantRoutePaths = Object.freeze({
	list: '/api/v1/tenants',
	members: '/api/v1/tenants/:tenantId/members',
	invitations: '/api/v1/tenants/:tenantId/invitations',
	invitation: '/api/v1/tenants/:tenantId/invitations/:invitationId',
	member: '/api/v1/tenants/:tenantId/members/:userId',
	audit: '/api/v1/tenants/:tenantId/audit',
	accept: '/api/v1/invitations/accept',
	workspaces: '/api/v1/tenants/:tenantId/workspaces',
	workspace: '/api/v1/tenants/:tenantId/workspaces/:workspaceId',
});

/**
 * Page sizes. The defaults are what the administration UI requests; the maxima are the
 * caps it can ask for. Enforcing a maximum here rather than in the store means a hostile
 * client cannot make one request cost an unbounded number of rows, and the store's own
 * clamp is then only a second line of defence instead of the contract.
 */
export const tenantPageLimits = Object.freeze({
	defaultMembers: 50,
	maxMembers: 200,
	defaultAudit: 100,
	maxAudit: 500,
});

/**
 * Deliberately permissive: the authoritative check is what better-auth does when an
 * address is registered, and a stricter regex here would reject addresses that library
 * accepts (sub-addressing with '+', internationalized domains). What this rejects is the
 * shape that cannot be an address at all.
 */
export const tenantEmailPattern = /^[^\s@]+@[^\s@]+$/;

/**
 * Maps one tenant API request to the capability it needs, before any parameter is
 * validated. `undefined` means "no such route", which the handler turns into a 404.
 *
 * Two entries return `null` on purpose:
 *
 *   * `POST /api/v1/tenants` is platform administration, which is a deployment policy
 *     rather than a tenant right — there is no tenant whose scope could grant it.
 *   * `POST /api/v1/invitations/accept` is authorized by the token in the body. It needs a
 *     session (the membership row is keyed by the accepting account) but no membership,
 *     because holding one already would make accepting a no-op.
 */
export function capabilityForTenantRequest(method, pathname) {
	if (typeof pathname !== 'string' || !pathname.startsWith('/api/v1/')) {
		return undefined;
	}
	if (pathname === tenantRoutePaths.accept) {
		return method === 'POST' ? null : undefined;
	}
	if (pathname === tenantRoutePaths.list) {
		if (method === 'GET' || method === 'HEAD') {
			return tenantCapabilities.read;
		}
		return method === 'POST' ? null : undefined;
	}
	const rest = pathname.slice('/api/v1/tenants/'.length).split('/').filter(part => part.length > 0);
	if (rest.length === 2 && rest[1] === 'members') {
		return method === 'GET' || method === 'HEAD' ? tenantCapabilities.admin : undefined;
	}
	if (rest.length === 2 && rest[1] === 'invitations') {
		return ['GET', 'HEAD', 'POST'].includes(method) ? tenantCapabilities.admin : undefined;
	}
	if (rest.length === 3 && rest[1] === 'invitations') {
		return method === 'DELETE' ? tenantCapabilities.admin : undefined;
	}
	if (rest.length === 3 && rest[1] === 'members') {
		return method === 'PATCH' || method === 'DELETE' ? tenantCapabilities.admin : undefined;
	}
	if (rest.length === 2 && rest[1] === 'audit') {
		return method === 'GET' || method === 'HEAD' ? tenantCapabilities.admin : undefined;
	}
	if (rest.length === 2 && rest[1] === 'workspaces') {
		return method === 'GET' || method === 'HEAD' ? tenantCapabilities.read : undefined;
	}
	if (rest.length === 3 && rest[1] === 'workspaces') {
		// Content read, resolved one level deeper by the handler: the workspace capability
		// depends on the query string, exactly like `capabilityForRequest` in
		// workspace-access.mjs. The tenant capability is the outer gate.
		return method === 'GET' || method === 'HEAD' ? tenantCapabilities.read : undefined;
	}
	return undefined;
}

/**
 * Every tenant-scoped route, with the capability it needs and the acceptance case that
 * covers it. `tenant-matrix.mjs --markdown` renders this, so the document cannot claim a
 * matrix the code does not implement.
 */
export const tenantSurfaceMatrix = Object.freeze([
	Object.freeze({ method: 'GET', path: tenantRoutePaths.list, capability: tenantCapabilities.read, acceptance: 'T01' }),
	Object.freeze({ method: 'POST', path: tenantRoutePaths.list, capability: 'platform.admin', acceptance: 'T04' }),
	Object.freeze({ method: 'GET', path: tenantRoutePaths.members, capability: tenantCapabilities.admin, acceptance: 'T02' }),
	Object.freeze({ method: 'GET', path: tenantRoutePaths.invitations, capability: tenantCapabilities.admin, acceptance: 'T02' }),
	Object.freeze({ method: 'GET', path: tenantRoutePaths.workspaces, capability: tenantCapabilities.read, acceptance: 'T01' }),
	Object.freeze({ method: 'POST', path: tenantRoutePaths.invitations, capability: tenantCapabilities.admin, acceptance: 'T02' }),
	Object.freeze({ method: 'DELETE', path: tenantRoutePaths.invitation, capability: tenantCapabilities.admin, acceptance: 'T02' }),
	Object.freeze({ method: 'PATCH', path: tenantRoutePaths.member, capability: tenantCapabilities.admin, acceptance: 'T03' }),
	Object.freeze({ method: 'DELETE', path: tenantRoutePaths.member, capability: tenantCapabilities.admin, acceptance: 'T03' }),
	Object.freeze({ method: 'GET', path: tenantRoutePaths.audit, capability: tenantCapabilities.admin, acceptance: 'T01' }),
	Object.freeze({ method: 'POST', path: tenantRoutePaths.accept, capability: 'invitation.token', acceptance: 'T02' }),
	Object.freeze({ method: 'GET', path: tenantRoutePaths.workspace, capability: tenantCapabilities.read, acceptance: 'T01' }),
]);

/**
 * The request surfaces that read or write tenant content, and what each one resolves to.
 * This is the "manifest of authorized request surfaces" the task book asks for in phase 3:
 * a surface that is missing from this list is one nobody has decided about yet, and the
 * test suite asserts every entry names a real capability.
 */
export const tenantSurfaceManifest = Object.freeze([
	Object.freeze({ surface: '/static/mount', resolves: 'workspace role, per request', tenantGate: true }),
	Object.freeze({ surface: '/sync/v1', resolves: 'workspace role, per request', tenantGate: true }),
	Object.freeze({ surface: '/git/v1', resolves: 'workspace role, per request', tenantGate: true }),
	Object.freeze({ surface: '/api/session', resolves: 'session only; no tenant content', tenantGate: false }),
	Object.freeze({ surface: '/api/v1/tenants', resolves: 'tenant scope', tenantGate: true }),
	Object.freeze({ surface: '/api/search', resolves: 'workspace role, per request', tenantGate: true }),
	Object.freeze({ surface: '/api/v1/office-previews', resolves: 'workspace role, per request', tenantGate: true }),
]);
