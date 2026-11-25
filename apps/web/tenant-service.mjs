// Tenant-scoped authorization for the Web service (docs/multi-tenant.md §2, contract §3).
//
// This module is the one place a request is turned into a tenant scope. Everything that
// touches a tenant resource — files, versions, trash, sync, git, search, preview and the
// asynchronous workers — is expected to call `resolveTenantScope` and then hand the
// resulting scope to a store that requires it, instead of re-deriving "is this workspace
// mine" from a workspace id.
//
// The reason it is a single function rather than a helper per surface is the failure this
// feature exists to prevent: a second copy of the rule is a second place to forget it, and
// the one that forgets is the one that leaks another tenant's notes. Acceptance case T01
// (cross-tenant object and audit access) is only provable if every surface resolves the
// same way.
//
// The decision is a chain of four conjuncts, and the order matters:
//
//   1. the caller is an *active member of the tenant*   (auth.sqlite)
//   2. the workspace is *mapped to that tenant, active*  (PostgreSQL)
//   3. the caller holds a *role in that workspace*       (auth.sqlite)
//   4. that role *grants the capability*                 (workspace-access.mjs)
//
// Failing 1 or 2 is reported as a uniform 404: the caller has not proved they may know the
// resource exists. Failing 3 or 4 is a 403, because by then the caller has already proved
// they belong to the tenant and the workspace, so naming the missing right leaks nothing.

import { WorkspaceError, isValidWorkspaceId } from './workspace-contract.mjs';
import { allowsWorkspace, isWorkspaceRole, workspaceCapabilities } from './workspace-access.mjs';
import { tenantRoles } from './tenant-store.mjs';

/**
 * The capabilities that address a tenant rather than a workspace. They are named here so
 * `tenant-files.mjs` can route on the same vocabulary the rest of the service uses, and so
 * a test can assert that a workspace role cannot reach a tenant endpoint and vice versa.
 */
export const tenantCapabilities = Object.freeze({
	read: 'tenant.read',
	admin: 'tenant.admin',
});

/** Who may do what inside a tenant, as opposed to inside one of its workspaces. */
export function allowsTenant(role, capability) {
	if (role === undefined || role === null) {
		return false;
	}
	if (capability === tenantCapabilities.read) {
		return true;
	}
	if (capability === tenantCapabilities.admin) {
		// Only the numeric admin level, imported through the store's own constant so a
		// future third level cannot be added in one place and forgotten here.
		return role === tenantRoles.admin;
	}
	return false;
}

function concealed() {
	return new WorkspaceError(404, 'NotFound');
}

/**
 * Resolves the scope of a tenant-scoped request.
 *
 * `store` is an `openTenantStore` handle; `readWorkspaceMapping(workspaceId)` answers with
 * the workspace → tenant row (or null) and is injected rather than imported so this module
 * stays free of a database handle of its own; `resolveWorkspaceRole(userId, workspaceId)` is
 * the auth callback that answers with a workspace role level or `undefined`. All three are
 * injected so the test suite can drive this against in-memory doubles.
 *
 * Returns a frozen scope object. The scope carries the tenant id, the workspace id, the
 * principal and the membership version — nothing else, because anything more would be a
 * cached copy of a decision that must be re-made per request.
 */
export async function resolveTenantScope({ store, readWorkspaceMapping, principalId, tenantId, workspaceId = null, capability = null, resolveWorkspaceRole }) {
	if (typeof principalId !== 'string' || principalId.length === 0) {
		throw new TypeError('resolveTenantScope requires a principal id');
	}
	if (typeof tenantId !== 'string' || tenantId.length === 0) {
		throw new WorkspaceError(400, 'InvalidTenantId');
	}
	if (store === undefined || store === null || typeof store.describeMembership !== 'function') {
		throw new TypeError('resolveTenantScope requires a tenant store');
	}

	// There are two capability vocabularies and they must not be mixed: a tenant
	// capability on a workspace-scoped call would be unheld by every workspace role, which
	// answers "nobody may do this" instead of naming the wiring mistake. The namespace is
	// therefore derived from the call shape, and the default in each namespace is its read
	// capability.
	const tenantScoped = workspaceId === null || workspaceId === undefined;
	const requested = capability ?? (tenantScoped ? tenantCapabilities.read : workspaceCapabilities.read);
	const tenantNamespace = requested.startsWith('tenant.');
	if (tenantScoped !== tenantNamespace) {
		throw new TypeError('resolveTenantScope received a capability from the wrong namespace: ' + requested);
	}

	// (1) Active tenant membership. `describeMembership` already conceals a missing tenant,
	// a missing membership and a suspended tenant behind the same 404.
	const membership = store.describeMembership(principalId, tenantId);
	// A tenant-scoped call also has to satisfy the tenant-level right it names; a
	// workspace-scoped call stops at membership here and is gated by the workspace role in
	// step (4), because a workspace role is not a tenant capability.
	if (tenantScoped && !allowsTenant(membership.role, requested)) {
		throw new WorkspaceError(403, 'NoPermissions');
	}
	capability = requested;

	// A tenant-scoped call stops here: it has no workspace, so there is no third and
	// fourth conjunct to evaluate. The scope records `workspaceId: null` explicitly rather
	// than omitting the key, so a caller that destructures it cannot mistake absence for
	// "no restriction".
	if (workspaceId === null || workspaceId === undefined) {
		return Object.freeze({
			tenantId,
			workspaceId: null,
			principalId,
			tenantRole: membership.role,
			workspaceRole: null,
			membershipVersion: membership.version,
			capability,
		});
	}

	if (!isValidWorkspaceId(workspaceId)) {
		throw new WorkspaceError(400, 'InvalidWorkspaceId');
	}
	if (typeof readWorkspaceMapping !== 'function') {
		throw new TypeError('resolveTenantScope requires readWorkspaceMapping to resolve a workspace');
	}

	// (2) The workspace must be mapped to *this* tenant and the mapping must be active. A
	// workspace that exists but is unmapped, mapped elsewhere, still pending, or failed is
	// concealed for the same reason a missing tenant is: otherwise the endpoint answers
	// "this workspace exists but is not yours", which is a cross-tenant existence oracle.
	const mapping = await readWorkspaceMapping(workspaceId);
	if (!mapping || mapping.tenantId !== tenantId || mapping.status !== 'active') {
		throw concealed();
	}

	// (3) The caller must hold a workspace role. A tenant administrator is deliberately not
	// granted one implicitly: tenant administration is governance of people, not access to
	// their notes, and the audit trail must show a real membership before content is read.
	const workspaceRole = resolveWorkspaceRole(principalId, workspaceId);
	if (!isWorkspaceRole(workspaceRole)) {
		throw new WorkspaceError(403, 'NoPermissions');
	}

	// (4) That role must grant the capability the request needs.
	if (!allowsWorkspace(workspaceRole, capability)) {
		throw new WorkspaceError(403, 'NoPermissions');
	}

	return Object.freeze({
		tenantId,
		workspaceId,
		principalId,
		tenantRole: membership.role,
		workspaceRole,
		membershipVersion: membership.version,
		capability,
	});
}

/**
 * Fails a request that names a workspace belonging to a different tenant than the one in
 * the URL. This is the shape every tenant-scoped route needs: the workspace id may come
 * from a header, a query parameter or a path segment, and the tenant id from the path.
 * Keeping the comparison here means a route cannot compare the two in the wrong order or
 * compare one of them to itself.
 */
export function requireWorkspaceTenant(scope, expectedWorkspaceId) {
	if (scope === undefined || scope === null || scope.workspaceId === null) {
		throw new WorkspaceError(400, 'WorkspaceRequired');
	}
	if (scope.workspaceId !== expectedWorkspaceId) {
		throw concealed();
	}
	return scope;
}

/**
 * The permission matrix the release package ships (`tenant-matrix.mjs --markdown`). It is
 * data, not prose, so the document under `apps/web/docs/multi-tenant.md` can be checked
 * against it instead of restating it by hand.
 */
export const tenantPermissionMatrix = Object.freeze([
	Object.freeze({ surface: 'GET /api/v1/tenants', tenantCapability: tenantCapabilities.read, workspaceCapability: null, note: 'returns only the caller\'s own memberships' }),
	Object.freeze({ surface: 'POST /api/v1/tenants', tenantCapability: null, workspaceCapability: null, note: 'platform administrator only; idempotent by request key' }),
	Object.freeze({ surface: 'GET /api/v1/tenants/:id/members', tenantCapability: tenantCapabilities.admin, workspaceCapability: null }),
	Object.freeze({ surface: 'GET /api/v1/tenants/:id/invitations', tenantCapability: tenantCapabilities.admin, workspaceCapability: null }),
	Object.freeze({ surface: 'POST /api/v1/tenants/:id/invitations', tenantCapability: tenantCapabilities.admin, workspaceCapability: null }),
	Object.freeze({ surface: 'DELETE /api/v1/tenants/:id/invitations/:invitationId', tenantCapability: tenantCapabilities.admin, workspaceCapability: null }),
	Object.freeze({ surface: 'POST /api/v1/invitations/accept', tenantCapability: null, workspaceCapability: null, note: 'the bearer token is the credential; no session membership is read' }),
	Object.freeze({ surface: 'PATCH /api/v1/tenants/:id/members/:userId', tenantCapability: tenantCapabilities.admin, workspaceCapability: null }),
	Object.freeze({ surface: 'DELETE /api/v1/tenants/:id/members/:userId', tenantCapability: tenantCapabilities.admin, workspaceCapability: null }),
	Object.freeze({ surface: 'GET /api/v1/tenants/:id/audit', tenantCapability: tenantCapabilities.admin, workspaceCapability: null }),
	Object.freeze({ surface: 'GET /api/v1/tenants/:id/workspaces', tenantCapability: tenantCapabilities.read, workspaceCapability: 'workspace.read' }),
	// One route, two capabilities: the tenant gate is always `tenant.read`, and the
	// workspace capability is chosen by the query string (`history=1`/`versions=1` asks
	// for `workspace.history`), exactly like `capabilityForRequest` in
	// workspace-access.mjs. Listing it twice would suggest two routes exist.
	Object.freeze({ surface: 'GET /api/v1/tenants/:id/workspaces/:workspaceId', tenantCapability: tenantCapabilities.read, workspaceCapability: 'workspace.read (or workspace.history with history=1/versions=1)' }),
]);
