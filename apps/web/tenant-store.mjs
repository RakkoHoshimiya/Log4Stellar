// Tenant identity for the Web service (docs/multi-tenant.md, contract §2).
//
// Tenant identity, memberships, invitations and the audit trail live in the
// authentication database (`auth.sqlite`), not in PostgreSQL, for the same reason
// `account-security-ddl.mjs` does: every one of these tables is written in the same
// transaction as a better-auth row (the membership of the user who accepted an
// invitation, the session that issued it), and splitting the write across two
// databases would make "invitation consumed but membership missing" a reachable
// state. PostgreSQL keeps only the workspace → tenant mapping (`tenant-migrate.mjs`),
// because that mapping has to be readable from the storage layer that owns the
// workspace rows.
//
// Two rules are inherited from the account-security migration and are not optional:
//
// 1. Probe before you migrate. `openAuth()` is on the critical path of every process
//    start, and an unconditional `CREATE TABLE` still takes a write lock even when it
//    is a no-op. `tenantSchemaCurrent` answers from `sqlite_master` alone.
// 2. Additive only. Nothing here drops or renames an object, so the previous release
//    package — which knows nothing about tenants — keeps reading the same database
//    during a rollback.
//
// The `workspace_member.tenant_id` column has existed since the role migration and
// every historical row carries the literal `'default'`. That value is the tenant of
// the single-workspace deployment this release inherits; `legacyTenantId` below names
// it so a migration can create the matching row instead of inventing a second id.

import { WorkspaceError } from './workspace-contract.mjs';

/** The tenant every row written before this release implicitly belongs to. */
export const legacyTenantId = 'default';

// A tenant member is an administrator or an ordinary member. Administration covers
// members, invitations and the audit trail; it deliberately does NOT imply ownership
// of the workspaces inside the tenant, which stay governed by `workspace-access.mjs`.
export const tenantRoles = {
	member: 1,
	admin: 2,
};

export const tenantStatuses = Object.freeze({
	active: 'active',
	suspended: 'suspended',
});

// Invitation lifetime. Long enough to survive a weekend, short enough that a leaked
// link stops working, and deliberately shorter than the 24h default idle session: an
// invitation is a bearer token that grants a membership, so it should never outlive
// the credentials of the person who issued it by much.
export const invitationLifetimeMs = 7 * 24 * 60 * 60 * 1000;
export const invitationMaxLifetimeMs = 30 * 24 * 60 * 60 * 1000;

/** The objects this module is responsible for, in creation order. */
export const tenantSchemaTables = Object.freeze([
	'tenant',
	'tenant_member',
	'tenant_invitation',
	'tenant_audit',
	'tenant_idempotency',
]);

export const tenantSchemaIndexes = Object.freeze([
	'tenant_member_user_idx',
	'tenant_invitation_tenant_idx',
	'tenant_audit_tenant_idx',
]);

const tenantSchemaStatements = Object.freeze([
	`CREATE TABLE IF NOT EXISTS tenant (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
		created_ms INTEGER NOT NULL,
		updated_ms INTEGER NOT NULL
	) STRICT`,
	// `version` is the optimistic-concurrency token changeTenantRole and
	// revokeTenantMember compare against. It is bumped by every write that changes the
	// row, so a client that read role 1 and a client that read role 2 cannot both win.
	`CREATE TABLE IF NOT EXISTS tenant_member (
		tenant_id TEXT NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
		user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
		role INTEGER NOT NULL CHECK (role IN (1, 2)),
		version INTEGER NOT NULL DEFAULT 1,
		created_ms INTEGER NOT NULL,
		updated_ms INTEGER NOT NULL,
		PRIMARY KEY (tenant_id, user_id)
	) STRICT`,
	// The invitation never stores the token, only its digest: this table is included in
	// every backup of the authentication database, and a backup must not be a list of
	// working invitation links.
	`CREATE TABLE IF NOT EXISTS tenant_invitation (
		id TEXT PRIMARY KEY,
		tenant_id TEXT NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
		email TEXT NOT NULL,
		role INTEGER NOT NULL CHECK (role IN (1, 2)),
		token_digest TEXT NOT NULL UNIQUE,
		issued_by TEXT NOT NULL,
		issued_ms INTEGER NOT NULL,
		expires_ms INTEGER NOT NULL,
		accepted_ms INTEGER,
		accepted_by TEXT,
		revoked_ms INTEGER
	) STRICT`,
	// The audit trail is append-only by policy, not by trigger: no code path in this
	// module issues UPDATE or DELETE against it, and `tenant-audit.mjs --verify` checks
	// that a tenant's rows only ever grow.
	`CREATE TABLE IF NOT EXISTS tenant_audit (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		tenant_id TEXT NOT NULL,
		actor_id TEXT NOT NULL,
		action TEXT NOT NULL,
		target TEXT NOT NULL,
		at_ms INTEGER NOT NULL,
		detail TEXT
	) STRICT`,
	// One row per createTenant call that carried an idempotency key. A retried request
	// therefore returns the tenant it already created instead of a second one, and the
	// check is a primary-key lookup inside the same transaction as the insert.
	`CREATE TABLE IF NOT EXISTS tenant_idempotency (
		key TEXT PRIMARY KEY,
		tenant_id TEXT NOT NULL,
		created_ms INTEGER NOT NULL
	) STRICT`,
	'CREATE INDEX IF NOT EXISTS tenant_member_user_idx ON tenant_member (user_id, tenant_id)',
	'CREATE INDEX IF NOT EXISTS tenant_invitation_tenant_idx ON tenant_invitation (tenant_id, issued_ms DESC)',
	'CREATE INDEX IF NOT EXISTS tenant_audit_tenant_idx ON tenant_audit (tenant_id, id DESC)',
]);

function hasObject(database, type, name) {
	const row = database.prepare('SELECT name FROM sqlite_master WHERE type = ? AND name = ?').get(type, name);
	return row !== undefined && row !== null;
}

/**
 * Read-only. Reports which tenant objects exist so the migrator can skip DDL and a
 * diagnostic can explain a half-migrated database without writing to it.
 */
export function tenantSchemaCurrent(database) {
	if (database === undefined || database === null || typeof database.prepare !== 'function') {
		throw new TypeError('tenantSchemaCurrent requires an open database handle');
	}
	const objects = [
		...tenantSchemaTables.map(name => ({ type: 'table', name })),
		...tenantSchemaIndexes.map(name => ({ type: 'index', name })),
	];
	const present = objects.map(object => ({ ...object, present: hasObject(database, object.type, object.name) }));
	return Object.freeze({
		tenants: present.find(entry => entry.name === 'tenant')?.present ?? false,
		members: present.find(entry => entry.name === 'tenant_member')?.present ?? false,
		invitations: present.find(entry => entry.name === 'tenant_invitation')?.present ?? false,
		audit: present.find(entry => entry.name === 'tenant_audit')?.present ?? false,
		idempotency: present.find(entry => entry.name === 'tenant_idempotency')?.present ?? false,
		missing: Object.freeze(present.filter(entry => !entry.present).map(entry => entry.type + ':' + entry.name)),
	});
}

/**
 * Idempotent, additive, cheap when there is nothing to do.
 *
 * Everything happens in one `BEGIN IMMEDIATE`: two processes starting against the same
 * first-run database would otherwise both read "no tenant table" and the loser would
 * die on a duplicate object instead of opening the database — the exact failure the
 * role migration hit with "duplicate column name: role".
 */
export function ensureTenantSchema(database) {
	if (database === undefined || database === null || typeof database.exec !== 'function') {
		throw new TypeError('ensureTenantSchema requires an open database handle');
	}
	const current = tenantSchemaCurrent(database);
	if (current.missing.length === 0) {
		return current;
	}
	database.exec('BEGIN IMMEDIATE');
	try {
		for (const statement of tenantSchemaStatements) {
			database.exec(statement);
		}
		database.exec('COMMIT');
	} catch (error) {
		database.exec('ROLLBACK');
		throw error;
	}
	return tenantSchemaCurrent(database);
}

export function isTenantRole(role) {
	return Number.isInteger(role) && Object.values(tenantRoles).includes(role);
}

/** Accepts a stored level (1/2) or its name ('member'/'admin'); never downgrades. */
export function normalizeTenantRole(role) {
	if (isTenantRole(role)) {
		return role;
	}
	if (typeof role === 'string' && Object.hasOwn(tenantRoles, role)) {
		return tenantRoles[role];
	}
	throw new WorkspaceError(400, 'InvalidTenantRole');
}

/**
 * Uniform concealment (§3): a caller who is not an active member of a tenant gets the
 * same answer whether the tenant does not exist or merely is not theirs. Returning 403
 * for the second case would turn the API into a tenant-existence oracle, and tenant
 * ids are stable identifiers that appear in URLs and audit exports.
 */
function concealed() {
	return new WorkspaceError(404, 'NotFound');
}

function requireHandles({ database, now }) {
	if (database === undefined || database === null || typeof database.prepare !== 'function') {
		throw new TypeError('tenant store requires an open database handle');
	}
	if (typeof now !== 'function') {
		throw new TypeError('tenant store requires a now() clock');
	}
}

/** Digest of an invitation token. Only this value is ever written to the database. */
export async function digestInvitationToken(token) {
	const { createHash } = await import('node:crypto');
	return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Opens the tenant store.
 *
 * Every method takes the acting principal's `userId` as its first or second argument
 * and re-derives their rights from the database on every call: a membership revoked in
 * another process takes effect on the next request instead of at the next restart.
 */
export function openTenantStore({ database, now = Date.now } = {}) {
	requireHandles({ database, now });
	ensureTenantSchema(database);

	const statements = {
		tenantById: database.prepare('SELECT id, name, status, created_ms AS createdMs FROM tenant WHERE id = ?'),
		insertTenant: database.prepare('INSERT INTO tenant (id, name, status, created_ms, updated_ms) VALUES (?, ?, ?, ?, ?)'),
		idempotency: database.prepare('SELECT tenant_id AS tenantId FROM tenant_idempotency WHERE key = ?'),
		recordIdempotency: database.prepare('INSERT INTO tenant_idempotency (key, tenant_id, created_ms) VALUES (?, ?, ?)'),
		// Any row present in `tenant_member` with a role is an active membership: there is
		// no invitation-pending state here, because an invitation that has not been
		// accepted must not confer anything. `tenant` status is checked separately.
		memberRole: database.prepare('SELECT role, version FROM tenant_member WHERE tenant_id = ? AND user_id = ?'),
		tenantIdsOf: database.prepare(`
			SELECT member.tenant_id AS tenantId, member.role AS role, tenant.name AS name, tenant.status AS status
			FROM tenant_member AS member
			JOIN tenant ON tenant.id = member.tenant_id
			WHERE member.user_id = ?
			ORDER BY member.created_ms, member.tenant_id
		`),
		insertMember: database.prepare(`
			INSERT OR IGNORE INTO tenant_member (tenant_id, user_id, role, version, created_ms, updated_ms)
			VALUES (?, ?, ?, 1, ?, ?)
		`),
		updateMemberRole: database.prepare(`
			UPDATE tenant_member SET role = ?, version = version + 1, updated_ms = ?
			WHERE tenant_id = ? AND user_id = ? AND version = ?
		`),
		deleteMember: database.prepare('DELETE FROM tenant_member WHERE tenant_id = ? AND user_id = ?'),
		wasRevoked: database.prepare(`
			SELECT 1 AS found FROM tenant_audit
			WHERE tenant_id = ? AND target = ? AND action = 'member.revoke' LIMIT 1
		`),
		countAdmins: database.prepare('SELECT COUNT(*) AS total FROM tenant_member WHERE tenant_id = ? AND role = ?'),
		listMemberPage: database.prepare(`
			SELECT member.user_id AS userId, member.role AS role, member.version AS version,
				member.created_ms AS createdMs, user.username AS username
			FROM tenant_member AS member
			LEFT JOIN user ON user.id = member.user_id
			WHERE member.tenant_id = ? AND member.user_id > ?
			ORDER BY member.user_id
			LIMIT ?
		`),
		insertInvitation: database.prepare(`
			INSERT INTO tenant_invitation (id, tenant_id, email, role, token_digest, issued_by, issued_ms, expires_ms)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		`),
		invitationByDigest: database.prepare(`
			SELECT id, tenant_id AS tenantId, email, role, expires_ms AS expiresMs, accepted_ms AS acceptedMs, revoked_ms AS revokedMs
			FROM tenant_invitation WHERE token_digest = ?
		`),
		// Single consumption is enforced by the WHERE clause, not by a read-then-write
		// pair: two concurrent accepts both see an unaccepted row, and exactly one UPDATE
		// changes it. The loser observes `changes === 0` and reports the invitation as
		// gone instead of minting a second membership (acceptance case T02).
		consumeInvitation: database.prepare(`
			UPDATE tenant_invitation SET accepted_ms = ?, accepted_by = ?
			WHERE id = ? AND accepted_ms IS NULL AND revoked_ms IS NULL AND expires_ms > ?
		`),
		revokeInvitation: database.prepare(`
			UPDATE tenant_invitation SET revoked_ms = ?
			WHERE tenant_id = ? AND id = ? AND accepted_ms IS NULL AND revoked_ms IS NULL AND expires_ms > ?
		`),
		listPendingInvitations: database.prepare(`
			SELECT id AS invitationId, email, role, expires_ms AS expiresMs
			FROM tenant_invitation
			WHERE tenant_id = ? AND id > ? AND accepted_ms IS NULL AND revoked_ms IS NULL AND expires_ms > ?
			ORDER BY id LIMIT ?
		`),
		// Two "last admin" guards race each other unless both run inside one write
		// transaction: each reads a count that still includes the other, both decrement,
		// and the tenant is left with no administrator (acceptance case T03).
		listAuditPage: database.prepare(`
			SELECT id, actor_id AS actorId, action, target, at_ms AS atMs, detail
			FROM tenant_audit WHERE tenant_id = ? AND id < ?
			ORDER BY id DESC
			LIMIT ?
		`),
		lastAuditId: database.prepare('SELECT MAX(id) AS last FROM tenant_audit WHERE tenant_id = ?'),
		insertAudit: database.prepare(`
			INSERT INTO tenant_audit (tenant_id, actor_id, action, target, at_ms, detail) VALUES (?, ?, ?, ?, ?, ?)
		`),
	};

	function write(action) {
		if (typeof action !== 'function') {
			throw new TypeError('write() requires a transaction body');
		}
		database.exec('BEGIN IMMEDIATE');
		try {
			const result = action();
			database.exec('COMMIT');
			return result;
		} catch (error) {
			database.exec('ROLLBACK');
			throw error;
		}
	}

	function audit(tenantId, actorId, action, target, detail) {
		const at = now();
		statements.insertAudit.run(tenantId, actorId, action, target, at, detail === undefined ? null : JSON.stringify(detail));
		return at;
	}

	/**
	 * Reads a tenant the caller is an active member of, or throws the concealed 404.
	 * Every tenant-scoped entry point starts here, which is what makes the concealment
	 * uniform: there is no second place that could forget it.
	 */
	function membership(userId, tenantId) {
		const tenant = statements.tenantById.get(tenantId);
		if (!tenant) {
			throw concealed();
		}
		const member = statements.memberRole.get(tenantId, userId);
		if (!member) {
			throw concealed();
		}
		if (tenant.status !== tenantStatuses.active) {
			throw concealed();
		}
		return { tenant, role: member.role, version: member.version };
	}

	function requireAdmin(userId, tenantId) {
		const found = membership(userId, tenantId);
		if (found.role !== tenantRoles.admin) {
			// The caller already proved they belong to this tenant, so naming the missing
			// right leaks nothing they did not already know.
			throw new WorkspaceError(403, 'NoPermissions');
		}
		return found;
	}

	return {
		database,
		/**
		 * The tenants this principal can actually enter, which is what GET /api/v1/tenants
		 * returns. Suspended tenants are omitted rather than listed with a flag: a client
		 * that shows a tenant it cannot open offers the user a button that fails.
		 */
		listTenants(userId) {
			if (typeof userId !== 'string' || userId.length === 0) {
				throw new TypeError('listTenants requires a user id');
			}
			return statements.tenantIdsOf.all(userId)
				.filter(row => row.status === tenantStatuses.active)
				.map(row => ({ tenantId: row.tenantId, name: row.name, role: row.role }));
		},

		/**
		 * Creates a tenant and makes `ownerId` its administrator, in one transaction.
		 *
		 * `idempotencyKey` makes the cross-database creation in `tenant-service.mjs`
		 * retryable: the PostgreSQL mapping and this row are written by two systems, and a
		 * client that retries after a timeout must not end up with two tenants.
		 */
		createTenant({ tenantId, name, ownerId, idempotencyKey = null, actorId = ownerId }) {
			if (typeof tenantId !== 'string' || tenantId.length === 0) {
				throw new WorkspaceError(400, 'InvalidTenantId');
			}
			if (typeof name !== 'string' || name.trim().length === 0) {
				throw new WorkspaceError(400, 'InvalidTenantName');
			}
			if (typeof ownerId !== 'string' || ownerId.length === 0) {
				throw new TypeError('createTenant requires an owner id');
			}
			return write(() => {
				if (idempotencyKey !== null) {
					const existing = statements.idempotency.get(idempotencyKey);
					if (existing) {
						const tenant = statements.tenantById.get(existing.tenantId);
						return { tenantId: existing.tenantId, name: tenant?.name ?? name, created: false };
					}
				}
				const existing = statements.tenantById.get(tenantId);
				if (existing) {
					throw new WorkspaceError(409, 'TenantExists');
				}
				const at = now();
				statements.insertTenant.run(tenantId, name.trim(), tenantStatuses.active, at, at);
				statements.insertMember.run(tenantId, ownerId, tenantRoles.admin, at, at);
				if (idempotencyKey !== null) {
					statements.recordIdempotency.run(idempotencyKey, tenantId, at);
				}
				audit(tenantId, actorId, 'tenant.create', ownerId);
				return { tenantId, name: name.trim(), created: true };
			});
		},

		/**
		 * Seeds a tenant row that predates this release, together with the administrators
		 * the migration decided on. Idempotent: an existing tenant keeps its name and its
		 * members, so running the migration twice cannot reset a role an operator has since
		 * changed. This is the only entry point that creates a tenant without an owning
		 * principal, and it is intentionally not reachable over HTTP.
		 */
		seedLegacyTenant({ tenantId = legacyTenantId, name = 'Default', adminIds = [], memberIds = [], actorId = 'migration' } = {}) {
			if (typeof tenantId !== 'string' || tenantId.length === 0) {
				throw new WorkspaceError(400, 'InvalidTenantId');
			}
			return write(() => {
				const existing = statements.tenantById.get(tenantId);
				const at = now();
				if (!existing) {
					statements.insertTenant.run(tenantId, String(name).trim() || 'Default', tenantStatuses.active, at, at);
				}
				// Seeding is ADDITIVE even when the tenant already exists. A deployment is
				// routinely opened before its first account exists (`create-account.mjs` runs
				// `openAuth()` with an empty `user` table), which creates the tenant with no
				// administrators at all. Returning early in that case left the account created
				// a second later as an owner of the workspace but a non-member of the tenant,
				// so `GET /api/v1/tenants` answered `{"tenants":[]}` forever and the sole
				// operator could never administer their own deployment.
				let admins = 0;
				let members = 0;
				const principals = [...adminIds.map(id => [id, tenantRoles.admin]), ...memberIds.map(id => [id, tenantRoles.member])];
				for (const [id, role] of principals) {
					// The append-only revocation record prevents startup from granting old workspace members access again.
					if (typeof id !== 'string' || !id || statements.wasRevoked.get(tenantId, id)) {
						continue;
					}
					if (statements.insertMember.run(tenantId, id, role, at, at).changes === 1) {
						if (role === tenantRoles.admin) {
							admins++;
						} else {
							members++;
						}
					}
				}
				const resolvedName = existing ? existing.name : String(name).trim() || 'Default';
				if (!existing || admins + members > 0) {
					audit(tenantId, actorId, 'tenant.seed', tenantId, { admins, members, created: !existing });
				}
				return { tenantId, name: resolvedName, created: !existing, admins };
			});
		},

		/** The caller's own membership, which the administration UI needs to render. */
		describeMembership(userId, tenantId) {
			const found = membership(userId, tenantId);
			return { tenantId, name: found.tenant.name, role: found.role, version: found.version };
		},

		/**
		 * Keyset pagination over `user_id`, not OFFSET: an operator page that shifts while
		 * a member is added would otherwise show or skip a member.
		 */
		listTenantMembers(userId, tenantId, { cursor = null, limit = 50 } = {}) {
			requireAdmin(userId, tenantId);
			const size = Math.min(Math.max(Number(limit) || 50, 1), 200);
			const after = typeof cursor === 'string' && cursor.length > 0 ? cursor : '';
			const rows = statements.listMemberPage.all(tenantId, after, size + 1);
			const page = rows.slice(0, size).map(row => ({
				userId: row.userId,
				username: row.username ?? null,
				role: row.role,
				version: row.version,
				createdMs: row.createdMs,
			}));
			return {
				members: page,
				nextCursor: rows.length > size ? page[page.length - 1].userId : null,
			};
		},

		/**
		 * Issues an invitation. The caller supplies the already-hashed digest and the
		 * public id, so the store never sees the token and a test can pin both.
		 */
		issueInvitation(userId, tenantId, { invitationId, email, role, tokenDigest, lifetimeMs = invitationLifetimeMs, issuedBy = userId }) {
			requireAdmin(userId, tenantId);
			if (typeof invitationId !== 'string' || invitationId.length === 0) {
				throw new TypeError('issueInvitation requires an invitation id');
			}
			if (typeof email !== 'string' || !email.includes('@')) {
				throw new WorkspaceError(400, 'InvalidEmail');
			}
			if (typeof tokenDigest !== 'string' || !/^[0-9a-f]{64}$/.test(tokenDigest)) {
				throw new WorkspaceError(400, 'InvalidInvitationToken');
			}
			const level = normalizeTenantRole(role);
			if (!(Number.isFinite(lifetimeMs) && lifetimeMs > 0 && lifetimeMs <= invitationMaxLifetimeMs)) {
				throw new WorkspaceError(400, 'InvalidInvitationLifetime');
			}
			return write(() => {
				const at = now();
				try {
					statements.insertInvitation.run(invitationId, tenantId, email.trim().toLowerCase(), level, tokenDigest, issuedBy, at, at + lifetimeMs);
				} catch (error) {
					if (String(error?.message ?? '').includes('UNIQUE')) {
						throw new WorkspaceError(409, 'InvitationExists');
					}
					throw error;
				}
				audit(tenantId, issuedBy, 'invitation.issue', invitationId, { email: email.trim().toLowerCase(), role: level });
				return { invitationId, tenantId, email: email.trim().toLowerCase(), role: level, expiresMs: at + lifetimeMs };
			});
		},

		/**
		 * Consumes an invitation and creates the membership, in one transaction.
		 *
		 * The single-consumption guarantee (T02) is the `WHERE accepted_ms IS NULL` clause
		 * plus `changes === 1`; the membership insert is `INSERT OR IGNORE`, so an existing
		 * member who consumes a second invitation is not duplicated and does not have
		 * their role silently overwritten.
		 */
		acceptInvitation(userId, tokenDigest) {
			if (typeof tokenDigest !== 'string' || !/^[0-9a-f]{64}$/.test(tokenDigest)) {
				throw new WorkspaceError(400, 'InvalidInvitationToken');
			}
			return write(() => {
				const invitation = statements.invitationByDigest.get(tokenDigest);
				if (!invitation) {
					throw concealed();
				}
				const at = now();
				const consumed = statements.consumeInvitation.run(at, userId, invitation.id, at);
				if (consumed.changes !== 1) {
					// Expired, revoked, or already accepted — all indistinguishable to the
					// caller on purpose: "already used" would confirm the token was valid.
					throw concealed();
				}
				const inserted = statements.insertMember.run(invitation.tenantId, userId, invitation.role, at, at);
				audit(invitation.tenantId, userId, 'invitation.accept', invitation.id, { membershipCreated: inserted.changes === 1 });
				return { tenantId: invitation.tenantId, role: invitation.role, membershipCreated: inserted.changes === 1 };
			});
		},

		listPendingInvitations(userId, tenantId, { cursor = '', limit = 50 } = {}) {
			requireAdmin(userId, tenantId);
			const rows = statements.listPendingInvitations.all(tenantId, cursor, now(), limit + 1);
			const invitations = rows.slice(0, limit);
			return { invitations, nextCursor: rows.length > limit ? invitations.at(-1).invitationId : null };
		},

		revokeInvitation(userId, tenantId, invitationId) {
			requireAdmin(userId, tenantId);
			return write(() => {
				const at = now();
				const changes = statements.revokeInvitation.run(at, tenantId, invitationId, at).changes;
				if (changes !== 1) {
					throw new WorkspaceError(409, 'InvitationNotPending');
				}
				audit(tenantId, userId, 'invitation.revoke', invitationId);
				return { invitationId, revoked: true };
			});
		},

		/**
		 * Changes a member's role if and only if the caller's view is still current.
		 *
		 * The last-admin guard runs inside the same write transaction as the update, so
		 * two operators demoting the only two administrators cannot both succeed (T03):
		 * the second one sees the first one's commit.
		 */
		changeTenantRole(userId, tenantId, targetUserId, { role, expectedVersion }) {
			requireAdmin(userId, tenantId);
			const level = normalizeTenantRole(role);
			if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
				throw new WorkspaceError(400, 'InvalidVersion');
			}
			return write(() => {
				const target = statements.memberRole.get(tenantId, targetUserId);
				if (!target) {
					throw new WorkspaceError(404, 'NotFound');
				}
				if (target.version !== expectedVersion) {
					throw new WorkspaceError(409, 'VersionConflict');
				}
				if (target.role === tenantRoles.admin && level !== tenantRoles.admin) {
					const admins = statements.countAdmins.get(tenantId, tenantRoles.admin).total;
					if (admins <= 1) {
						throw new WorkspaceError(409, 'LastAdmin');
					}
				}
				const changes = statements.updateMemberRole.run(level, now(), tenantId, targetUserId, expectedVersion).changes;
				if (changes !== 1) {
					throw new WorkspaceError(409, 'VersionConflict');
				}
				audit(tenantId, userId, 'member.role', targetUserId, { from: target.role, to: level });
				return { userId: targetUserId, role: level, version: expectedVersion + 1 };
			});
		},

		revokeTenantMember(userId, tenantId, targetUserId, { expectedVersion } = {}) {
			requireAdmin(userId, tenantId);
			if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
				throw new WorkspaceError(400, 'InvalidVersion');
			}
			return write(() => {
				const target = statements.memberRole.get(tenantId, targetUserId);
				if (!target) {
					throw new WorkspaceError(404, 'NotFound');
				}
				if (target.version !== expectedVersion) {
					throw new WorkspaceError(409, 'VersionConflict');
				}
				if (target.role === tenantRoles.admin) {
					const admins = statements.countAdmins.get(tenantId, tenantRoles.admin).total;
					if (admins <= 1) {
						throw new WorkspaceError(409, 'LastAdmin');
					}
				}
				const changes = statements.deleteMember.run(tenantId, targetUserId).changes;
				if (changes !== 1) {
					throw new WorkspaceError(409, 'VersionConflict');
				}
				audit(tenantId, userId, 'member.revoke', targetUserId);
				return { userId: targetUserId, revoked: true };
			});
		},

		/** Newest-first keyset pagination over the monotone audit id. */
		listTenantAudit(userId, tenantId, { cursor = null, limit = 100, action = null } = {}) {
			requireAdmin(userId, tenantId);
			const size = Math.min(Math.max(Number(limit) || 100, 1), 500);
			const last = Number.isInteger(cursor) && cursor > 0 ? cursor : (statements.lastAuditId.get(tenantId).last ?? 0) + 1;
			const rows = statements.listAuditPage.all(tenantId, last, size + 1);
			const filtered = action === null ? rows : rows.filter(row => row.action === action);
			const page = filtered.slice(0, size).map(row => ({
				id: row.id,
				actorId: row.actorId,
				action: row.action,
				target: row.target,
				atMs: row.atMs,
				detail: row.detail === null ? null : JSON.parse(row.detail),
			}));
			return {
				entries: page,
				nextCursor: rows.length > size ? page[page.length - 1].id : null,
			};
		},
	};
}
