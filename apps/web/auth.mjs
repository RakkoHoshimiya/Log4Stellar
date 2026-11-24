import { hash, verify } from '@node-rs/argon2';
import { betterAuth } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import { admin, twoFactor, username } from 'better-auth/plugins';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { clampIdleSeconds, generateRecoveryCodes } from './account-security.mjs';
import { ensureAccountSecuritySchema } from './account-security-ddl.mjs';
import { createChallengeResolver, createAccountSecurityRuntime, sessionCookieName } from './account-security-runtime.mjs';
import { isValidWorkspaceId, resolveWorkspaceId } from './workspace-contract.mjs';
import { isWorkspaceRole, workspaceRoles } from './workspace-access.mjs';
import { legacyTenantId, openTenantStore } from './tenant-store.mjs';

const tenant = 'default';
// Every account used to be recorded as a member of this placeholder workspace. The
// row is kept forever so a release that predates roles can still sign its users in.
// Nothing in this release treats it as a workspace: it opens the old login gate and
// grants nothing else.
export const legacyWorkspace = 'default';
// Which workspace owns the placeholder rows of a historical database. Stored instead
// of inferred, so a second deployment sharing the same `auth.sqlite` cannot adopt the
// legacy accounts and so the owning deployment can still pick up accounts that a
// rolled-back release created in the meantime (contract §7).
export const legacyAdoptionKey = 'legacy_workspace_adoption';
// Per-account record that its placeholder row has already been turned into a
// membership decision. Without it, revoking a member by deleting the canonical row
// would be undone by the next `openAuth()`, because the placeholder row would look
// "unclaimed" again and be adopted back as an owner.
export const legacyMemberKeyPrefix = 'legacy_member_adopted:';
export const workspaceMetaTable = 'workspace_meta';

/**
 * Adds the role column and adopts the placeholder memberships of a historical
 * single-workspace database (contract §7).
 *
 * The placeholder row `(default, default, user)` is deliberately NOT deleted: the
 * previous release package decides whether a user may enter the workbench with
 * `SELECT 1 ... tenant_id='default' AND workspace_id='default' AND user_id=?`.
 * Deleting it would lock every user out after a rollback.
 *
 * `adopt: false` performs the schema upgrade only. Adoption is a decision that must
 * never be taken by a command that was asked to read something (contract §7.1): a
 * read-only `list` that silently binds the whole historical database to one workspace
 * permanently denies those accounts their real workspace afterwards.
 */
export function migrateWorkspaceMembers(database, workspaceId, { adopt = true } = {}) {
	database.exec(`
		CREATE TABLE IF NOT EXISTS workspace_member (
			tenant_id TEXT NOT NULL,
			workspace_id TEXT NOT NULL,
			user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
			role INTEGER NOT NULL DEFAULT 3 CHECK (role IN (1, 2, 3)),
			PRIMARY KEY (tenant_id, workspace_id, user_id)
		) STRICT;
		CREATE TABLE IF NOT EXISTS ${workspaceMetaTable} (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
	`);
	// The column check and the upgrade share one write transaction. Two processes
	// starting against the same pre-role database would otherwise both read "no role
	// column", both run the ALTER, and the loser would die on startup with
	// "duplicate column name: role" instead of opening the database.
	database.exec('BEGIN IMMEDIATE');
	try {
		const columns = database.prepare('PRAGMA table_info(workspace_member)').all().map(column => column.name);
		if (!columns.includes('role')) {
			// Rows that already exist receive the default, which is why every historical
			// member becomes an owner of the storage workspace.
			database.exec('ALTER TABLE workspace_member ADD COLUMN role INTEGER NOT NULL DEFAULT 3 CHECK (role IN (1, 2, 3))');
		}
		database.exec('CREATE INDEX IF NOT EXISTS workspace_account_canonical_idx ON user(id COLLATE NOCASE)');
		database.exec('COMMIT');
	} catch (error) {
		database.exec('ROLLBACK');
		throw error;
	}
	if (adopt) {
		adoptLegacyMembers(database, workspaceId);
	}
}

/**
 * Adopts the placeholder memberships of a single-workspace database into the
 * workspace that owns that database, and nowhere else.
 *
 * The placeholder row is global to the database, not scoped to a workspace, so
 * copying it on every open hands every historical account to whichever workspace is
 * configured next: a second deployment sharing one `auth.sqlite` silently makes all
 * of its users owners of that workspace (contract §6). Two independent guards are
 * needed, because either one alone still leaks:
 *
 * 1. **The database is adopted once.** `workspace_meta` records which workspace owns
 *    the placeholder rows; only that workspace may copy them again. A brand-new or
 *    already claimed database therefore stays inert for every other deployment.
 * 2. **Only accounts nobody has claimed are adopted.** A user is copied only when the
 *    database holds no membership for them at all beyond the placeholder row. An
 *    account that another workspace created (or a release wrote a canonical row for,
 *    or an administrator added) is never adopted, so re-opening the owning database
 *    cannot pull in accounts that belong elsewhere. In practice this is what keeps a
 *    user created by the second deployment from being promoted into the first one.
 *
 * A database without a marker is adopted when no workspace has claimed it yet, or when
 * the only workspace that wrote canonical rows is the caller itself (a database an
 * earlier build of this release already migrated, which leaves no marker). A database
 * claimed by some other workspace, or by several, is never adopted: the safe answer
 * for an ambiguous database is to grant nothing.
 *
 * Both guards run inside `BEGIN IMMEDIATE`, so two processes opening the same database
 * cannot adopt concurrently. The copy uses `INSERT OR IGNORE`, so a role an
 * administrator already set is preserved and repeating the step changes nothing.
 *
 * Returns the workspace ID that owns the placeholder rows, or '' when none does.
 */
function adoptLegacyMembers(database, workspaceId) {
	database.exec('BEGIN IMMEDIATE');
	try {
		const marker = database.prepare(`SELECT value FROM ${workspaceMetaTable} WHERE key = ?`).get(legacyAdoptionKey)?.value;
		// A database that only ever held placeholder memberships is a historical
		// single-workspace database; any other membership proves it is already claimed.
		const claimed = database.prepare('SELECT DISTINCT workspace_id FROM workspace_member WHERE workspace_id <> ? ORDER BY workspace_id')
			.all(legacyWorkspace).map(row => row.workspace_id);
		const adopts = workspaceId !== legacyWorkspace && (marker === undefined
			? claimed.length === 0 || (claimed.length === 1 && claimed[0] === workspaceId)
			: marker === workspaceId);
		if (adopts) {
			// Copy only the placeholder memberships of accounts that no workspace has
			// claimed yet. `NOT EXISTS` is evaluated against the same table, so an account
			// that already carries a canonical row anywhere is left untouched.
			//
			// The third guard is the per-account ledger: an account whose placeholder row
			// was already converted into a membership decision is never adopted a second
			// time. Removing a member works by deleting the canonical row, which leaves
			// the placeholder row behind; without this guard the next open would read that
			// placeholder row as "unclaimed" and silently restore the member as an owner,
			// so revoking access could never take effect (contract §7.1).
			database.prepare(`
				INSERT OR IGNORE INTO workspace_member (tenant_id, workspace_id, user_id, role)
				SELECT member.tenant_id, ?, member.user_id, member.role
				FROM workspace_member AS member
				WHERE member.tenant_id = ? AND member.workspace_id = ?
					AND NOT EXISTS (
						SELECT 1 FROM workspace_member AS other
						WHERE other.tenant_id = member.tenant_id AND other.user_id = member.user_id AND other.workspace_id <> ?
					)
					AND NOT EXISTS (
						SELECT 1 FROM ${workspaceMetaTable} AS decided
						WHERE decided.key = '${legacyMemberKeyPrefix}' || member.user_id
					)
			`).run(workspaceId, tenant, legacyWorkspace, legacyWorkspace);
		}
		// Record every account that carries a canonical membership as decided, including
		// the ones just adopted. An account created by the new code is therefore never
		// adoptable by the owning workspace either, not even after its membership is
		// revoked — only accounts that still hold nothing but a placeholder row (those a
		// rolled-back release created) stay adoptable.
		database.prepare(`
			INSERT OR IGNORE INTO ${workspaceMetaTable} (key, value)
			SELECT '${legacyMemberKeyPrefix}' || member.user_id, MIN(member.workspace_id)
			FROM workspace_member AS member
			WHERE member.workspace_id <> ?
			GROUP BY member.user_id
		`).run(legacyWorkspace);
		const owner = marker ?? (adopts ? workspaceId : claimed.length === 1 ? claimed[0] : '');
		// Record the outcome once so later opens take the same branch. An ambiguous
		// database stays unmarked, which keeps it read-only for every deployment.
		if (marker === undefined && owner !== '') {
			database.prepare(`INSERT INTO ${workspaceMetaTable} (key, value) VALUES (?, ?)`).run(legacyAdoptionKey, owner);
		}
		database.exec('COMMIT');
		return owner;
	} catch (error) {
		database.exec('ROLLBACK');
		throw error;
	}
}

export async function openAuth({ workspaceId = resolveWorkspaceId({ environment: process.env }), adopt = true } = {}) {
	const directory = process.env.LOG4STELLAR_AUTH_DIR;
	const base = process.env.LOG4STELLAR_WEB_ORIGIN;
	if (!directory || !base) {
		throw new Error('Set LOG4STELLAR_AUTH_DIR and LOG4STELLAR_WEB_ORIGIN to run the Web service.');
	}
	if (!isValidWorkspaceId(workspaceId)) {
		throw new Error('LOG4STELLAR_WORKSPACE_ID must be a lowercase storage workspace ID.');
	}
	const origin = new URL(base);
	if (origin.protocol !== 'https:' || origin.origin !== base) {
		throw new Error('LOG4STELLAR_WEB_ORIGIN must be a canonical HTTPS origin.');
	}
	const path = resolve(directory);
	await mkdir(path, { recursive: true, mode: 0o700 });
	const secret = (await readFile(join(path, 'secret'), 'utf8')).trim();
	if (secret.length < 32) {
		throw new Error('The authentication secret must be at least 32 characters long and randomly generated.');
	}
	const database = new DatabaseSync(join(path, 'auth.sqlite'));
	database.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
	const idleSeconds = clampIdleSeconds(Number(process.env.LOG4STELLAR_IDLE_SECONDS ?? 86_400));
	if (!Number.isInteger(idleSeconds) || idleSeconds <= 0) {
		throw new Error('LOG4STELLAR_IDLE_SECONDS must be a positive integer.');
	}
	const auth = betterAuth({
		appName: 'Log4Stellar',
		baseURL: origin.origin,
		secret,
		database,
		telemetry: { enabled: false },
		emailAndPassword: {
			enabled: true,
			disableSignUp: true,
			revokeSessionsOnPasswordReset: true,
			password: {
				hash: value => hash(value, { memoryCost: 19_456, timeCost: 2, parallelism: 1 }),
				verify: ({ hash: digest, password }) => verify(digest, password),
			},
		},
		session: {
			expiresIn: idleSeconds,
			updateAge: 0,
			deferSessionRefresh: true,
			cookieCache: { enabled: false },
		},
		rateLimit: { enabled: true, window: 60, max: 100, customRules: { '/get-session': false, '/sign-in/username': { window: 60, max: 8 } } },
		advanced: { useSecureCookies: true, ipAddress: { ipAddressHeaders: ['x-log4stellar-peer'] } },
		plugins: [
			username(),
			admin(),
			// Second factor for the interactive login gate. The trusted-device cookie is
			// deliberately NOT offered: "remember this device for 30 days" turns two
			// factors into one factor plus a long-lived bearer cookie, and the whole
			// point of this batch is the state between "password accepted" and "second
			// factor accepted" — a trusted device skips that state entirely.
			twoFactor({
				issuer: 'Log4Stellar',
				twoFactorCookieMaxAge: 600,
				// The library's default alphabet is a-zA-Z0-9, which cannot be normalised
				// without ambiguity (I/l/1, O/0) and is compared with a plain `includes`.
				// Our own generator emits the unambiguous 30-symbol alphabet the contract
				// specifies, so what the user is shown, what we compare in constant time,
				// and what the library compares are the same string.
				backupCodeOptions: {
					amount: 10,
					length: 10,
					customBackupCodesGenerate: () => generateRecoveryCodes({ count: 10 }),
				},
				// Library defaults made explicit: five attempts per challenge and a
				// ten-failure / fifteen-minute account lockout. Keeping them explicit
				// means a dependency upgrade cannot silently loosen either.
				accountLockout: { enabled: true, maxFailedAttempts: 10, durationSeconds: 900 },
			}),
		],
	});
	const migration = await getMigrations(auth.options);
	await migration.runMigrations();
	// Runs after the plugin migrator, which is what creates `user` (the replay
	// table's foreign key target) and the `twoFactor` table. Cheap on a database
	// that is already migrated: a handful of reads, no write lock.
	ensureAccountSecuritySchema(database);
	migrateWorkspaceMembers(database, workspaceId, { adopt });
	// Tenant identity lives in the same database for the same reason the account-security
	// tables do: every membership write must share a transaction with a better-auth row.
	// The store is opened here so the schema is ensured exactly once per process, next to
	// the role migration that it complements.
	const tenants = openTenantStore({ database });
	// The single-workspace deployment this release inherits had exactly one implicit
	// tenant, spelled `'default'` in every `workspace_member` row. Seeding it keeps those
	// rows meaningful without a data rewrite, and the administrators are the accounts that
	// already own the configured workspace. Idempotent: a second open keeps the name and
	// any role an operator has since changed.
	try {
		tenants.seedLegacyTenant({
			tenantId: legacyTenantId,
			name: 'Default',
			adminIds: database.prepare(`
				SELECT user_id AS userId FROM workspace_member
				WHERE tenant_id = ? AND workspace_id = ? AND role = ?
				ORDER BY rowid
			`).all(tenant, workspaceId, workspaceRoles.owner).map(row => row.userId),
		});
	} catch (error) {
		// A database whose `workspace_member` table is older than roles (a deployment that
		// never ran the role migration) has no owner rows to seed. Opening must still
		// succeed: tenant administration is additive, and refusing to start would turn an
		// optional feature into an outage.
		if (!(error instanceof Error) || !error.message.includes('no such column: role')) {
			throw error;
		}
	}
	const accountSecurity = createAccountSecurityRuntime({ auth, database, secret, idleSeconds });
	const resolveChallenge = createChallengeResolver({ auth, database });

	const addMember = database.prepare(`
		INSERT OR IGNORE INTO workspace_member (tenant_id, workspace_id, user_id, role) VALUES (?, ?, ?, ?)
	`);
	const findRole = database.prepare('SELECT role FROM workspace_member WHERE tenant_id = ? AND workspace_id = ? AND user_id = ?');
	const findMemberships = database.prepare('SELECT workspace_id, role FROM workspace_member WHERE tenant_id = ? AND user_id = ? ORDER BY rowid');
	const findUser = database.prepare('SELECT id FROM user WHERE username = ? COLLATE NOCASE');
	const findWorkspaceAccounts = database.prepare('SELECT id FROM user WHERE id = ? COLLATE NOCASE LIMIT 2');
	// The login gate accepts only a membership of a real workspace. The placeholder row
	// is a rollback artifact, so a user holding nothing else can sign in nowhere: the
	// alternative is a session whose every mounted request answers 403, which looks
	// like a broken deployment and gives the operator nothing to act on.
	const hasWorkspaceMembership = database.prepare('SELECT 1 FROM workspace_member WHERE tenant_id = ? AND user_id = ? AND workspace_id <> ? LIMIT 1');
	const removeMember = database.prepare('DELETE FROM workspace_member WHERE tenant_id = ? AND workspace_id = ? AND user_id = ?');
	const setMemberRole = database.prepare('UPDATE workspace_member SET role = ? WHERE tenant_id = ? AND workspace_id = ? AND user_id = ?');
	const listMembers = database.prepare(`
		SELECT member.user_id AS userId, user.username AS username, member.role AS role
		FROM workspace_member AS member
		LEFT JOIN user ON user.id = member.user_id
		WHERE member.tenant_id = ? AND member.workspace_id = ?
		ORDER BY member.rowid
	`);
	const listWorkspaces = database.prepare(`
		SELECT workspace_id AS workspaceId, COUNT(*) AS members
		FROM workspace_member
		WHERE tenant_id = ? AND workspace_id <> ?
		GROUP BY workspace_id
		ORDER BY workspace_id
	`);
	const findUserId = database.prepare('SELECT id FROM user WHERE id = ? COLLATE NOCASE OR username = ? COLLATE NOCASE LIMIT 1');
	const recordAdoption = database.prepare(`INSERT OR IGNORE INTO ${workspaceMetaTable} (key, value) VALUES (?, ?)`);

	function roleOf(userId, candidate = workspaceId) {
		// The placeholder row only exists so an older release package can still sign
		// this user in. It never grants access to a real workspace.
		if (candidate === legacyWorkspace && workspaceId !== legacyWorkspace) {
			return undefined;
		}
		const row = findRole.get(tenant, candidate, userId);
		return row && isWorkspaceRole(row.role) ? row.role : undefined;
	}

	// The login gate and the per-request decision must agree: a session is only useful
	// when it can reach at least one workspace, because every mounted request is
	// authorized by the role of the workspace it addresses.
	function canReadWorkspace(userId) {
		if (workspaceId === legacyWorkspace) {
			return Boolean(findMemberships.all(tenant, userId).length);
		}
		return Boolean(hasWorkspaceMembership.get(tenant, userId, legacyWorkspace));
	}

	function resolveMemberId(handle) {
		const row = findUserId.get(handle, handle);
		if (!row) {
			throw new Error('No account matches ' + handle + '.');
		}
		return row.id;
	}

	return {
		auth, origin, path, database, workspaceId, tenant,
		/** Tenant identity, memberships, invitations and the audit trail (docs/multi-tenant.md). */
		tenants,
		/** Account security runtime: TOTP replay guard, recovery codes, sessions. */
		accountSecurity,
		/** Classifies a presented challenge cookie into `{ identifier, userId, expiresAtMs }`. */
		resolveChallenge,
		/** Where the idle clock starts: at second-factor completion, not at password acceptance. */
		idleSeconds,
		/** Login gate: the user belongs to at least one real workspace (contract §4.1). */
		canReadWorkspace,
		resolveRole: roleOf,
		/**
		 * Default workspace: the earliest membership that is not the rollback
		 * placeholder. Insertion order is the join order, so the lowest rowid wins.
		 */
		defaultWorkspaceId(userId) {
			const rows = findMemberships.all(tenant, userId);
			const canonical = rows.filter(row => row.workspace_id !== legacyWorkspace || workspaceId === legacyWorkspace);
			return canonical[0]?.workspace_id;
		},
		workspacesOf(userId) {
			return findMemberships.all(tenant, userId)
				.filter(row => row.workspace_id !== legacyWorkspace || workspaceId === legacyWorkspace)
				.map(row => ({ id: row.workspace_id, role: row.role }));
		},
		matchesWorkspaceAccount(userId, authorityAccount) {
			if (authorityAccount !== userId.toLowerCase()) {
				return false;
			}
			const matches = findWorkspaceAccounts.all(authorityAccount);
			return matches.length === 1 && matches[0].id === userId;
		},
		async createAccount(handle, password) {
			const existing = findUser.get(handle);
			if (existing) {
				throw new Error('The account already exists.');
			}
			const { user } = await auth.api.createUser({
				body: {
					name: handle,
					email: `${handle.toLowerCase()}@log4stellar.invalid`,
					password,
					role: 'user',
					data: { username: handle.toLowerCase(), displayUsername: handle },
				},
			});
			// Write the rollback placeholder row and the canonical row together.
			addMember.run(tenant, legacyWorkspace, user.id, workspaceRoles.owner);
			addMember.run(tenant, workspaceId, user.id, workspaceRoles.owner);
			// Record the decision immediately: if an operator later removes this member,
			// the placeholder row must not be read as an unclaimed history record.
			recordAdoption.run(legacyMemberKeyPrefix + user.id, workspaceId);
			// The tenant was seeded when this connection opened, which on a brand-new
			// deployment happened before any account existed: it therefore has no
			// administrators at all. An account created here owns the configured workspace,
			// and the owners of that workspace ARE the tenant administrators (see the seed in
			// `openAuth`), so add the membership now instead of leaving the sole operator
			// unable to administer their own deployment until a restart.
			tenants.seedLegacyTenant({ tenantId: legacyTenantId, name: 'Default', adminIds: [user.id] });
			return user.id;
		},
		addMember(userId, memberRole = workspaceRoles.viewer, target = workspaceId) {
			if (!isWorkspaceRole(memberRole)) {
				throw new Error('A workspace role must be 1 (viewer), 2 (editor) or 3 (owner).');
			}
			// The placeholder row is the rollback pass-through of the previous release:
			// writing it here would forge a login permit for an account nobody granted
			// anything to, so adding it is just as forbidden as deleting it.
			if (target === legacyWorkspace && workspaceId !== legacyWorkspace) {
				throw new Error('The rollback placeholder row must never be edited as a workspace.');
			}
			addMember.run(tenant, target, userId, memberRole);
			// An explicit membership is a decision too: removing it later must stay removed.
			if (target !== legacyWorkspace) {
				recordAdoption.run(legacyMemberKeyPrefix + userId, target);
			}
		},
		/**
		 * Member management used by the `workspace-members.mjs` operator command
		 * (contract §2: `workspace.admin` covers adding and removing members). Nothing
		 * here is reachable over HTTP in this release, so an operator keeps full control
		 * of who belongs to a workspace without a member-management API to secure first.
		 */
		listMembers(target = workspaceId) {
			if (target === legacyWorkspace && workspaceId !== legacyWorkspace) {
				throw new Error('The rollback placeholder row must never be edited as a workspace.');
			}
			return listMembers.all(tenant, target).map(row => ({ userId: row.userId, username: row.username, role: row.role }));
		},
		listWorkspaces() {
			// Rows come back with a null prototype, which compare badly with literals.
			return listWorkspaces.all(tenant, legacyWorkspace).map(row => ({ workspaceId: row.workspaceId, members: row.members }));
		},
		resolveMemberId,
		/** Removes the canonical membership; the rollback placeholder row is untouched. */
		removeMember(userId, target = workspaceId) {
			if (target === legacyWorkspace && workspaceId !== legacyWorkspace) {
				throw new Error('The rollback placeholder row must never be edited as a workspace.');
			}
			return removeMember.run(tenant, target, userId).changes;
		},
		setMemberRole(userId, memberRole, target = workspaceId) {
			if (!isWorkspaceRole(memberRole)) {
				throw new Error('A workspace role must be 1 (viewer), 2 (editor) or 3 (owner).');
			}
			if (target === legacyWorkspace && workspaceId !== legacyWorkspace) {
				throw new Error('The rollback placeholder row must never be edited as a workspace.');
			}
			return setMemberRole.run(memberRole, tenant, target, userId).changes;
		},
	};
}
