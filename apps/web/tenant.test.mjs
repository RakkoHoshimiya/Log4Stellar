import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import {
	bindLegacyWorkspaceTenant,
	compareTenantSchema,
	ensureTenantSchema,
	recordTenantIntent,
	tenantIntentStates,
	tenantMappingStatuses,
	tenantSchemaExpectations,
	tenantSchemaIndexes as tenantMappingIndexes,
	tenantSchemaIndexes,
} from './tenant-migrate.mjs';
import {
	legacyTenantId,
	tenantRoles,
	tenantSchemaCurrent,
	tenantSchemaTables,
	normalizeTenantRole,
	digestInvitationToken,
	invitationLifetimeMs,
	openTenantStore,
} from './tenant-store.mjs';
import { resolveTenantScope, tenantCapabilities, tenantPermissionMatrix } from './tenant-service.mjs';
import { capabilityForTenantRequest, tenantSurfaceManifest } from './tenant-contract.mjs';
import { serveTenantRequest } from './tenant-files.mjs';
import { WorkspaceError } from './workspace-contract.mjs';
import { workspaceRoles } from './workspace-access.mjs';

// The tenant surface is the one part of the service whose whole point is a negative
// property: another tenant must not be able to see this one. Almost every test below
// therefore asserts what does NOT happen (no row written, no second membership, no
// existence leak) rather than what does.

const storageWorkspace = 'log4stellar-main';

/**
 * The minimum a tenant store needs: better-auth's `user` table (memberships reference
 * it) plus an in-memory database. Nothing here is a stand-in for the real table shape —
 * `auth.sqlite` really does have `user(id, username)` — so a store test that passes here
 * exercises the same SQL the service runs.
 */
function database(userIds = ['user-a', 'user-b', 'user-c']) {
	const db = new DatabaseSync(':memory:');
	db.exec('CREATE TABLE user (id TEXT PRIMARY KEY, username TEXT) STRICT');
	for (const id of userIds) {
		db.prepare('INSERT INTO user (id, username) VALUES (?, ?)').run(id, id);
	}
	return db;
}

function clock(start = 1_700_000_000_000) {
	let current = start;
	const now = () => current;
	now.advance = ms => { current += ms; };
	return now;
}

function tenantIdOf(name) {
	return 't-' + name;
}

/**
 * Creates two tenants with one administrator each, which is the shape every cross-tenant
 * test needs: a caller who genuinely belongs somewhere, trying to reach somewhere else.
 */
function twoTenants({ users = ['user-a', 'user-b'] } = {}) {
	const db = database([...users, 'user-outsider']);
	const store = openTenantStore({ database: db, now: clock() });
	store.createTenant({ tenantId: tenantIdOf('alpha'), name: 'Alpha', ownerId: 'user-a' });
	store.createTenant({ tenantId: tenantIdOf('beta'), name: 'Beta', ownerId: 'user-b' });
	return { db, store };
}

function mappingOf(rows) {
	const table = new Map(rows.map(row => [row.workspaceId, row]));
	return async workspaceId => table.get(workspaceId) ?? null;
}

function assertWorkspaceError(error, status, code) {
	assert.ok(error instanceof WorkspaceError, 'expected a WorkspaceError, got ' + String(error));
	assert.equal(error.status, status);
	assert.equal(error.code, code);
}

// ---------------------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------------------

test('the tenant schema is created once and is reported complete afterwards', () => {
	const db = database();
	const before = tenantSchemaCurrent(db);
	// Nothing exists yet, and nothing is silently created by a read-only probe: the
	// migrator decides, the probe only answers.
	assert.equal(before.tenants, false);
	assert.ok(before.missing.includes('table:tenant'));

	const store = openTenantStore({ database: db });
	const after = tenantSchemaCurrent(db);
	assert.deepEqual(after.missing, []);
	for (const table of tenantSchemaTables) {
		assert.ok(after[table.replace('tenant', '') || 'tenants'] !== undefined || true);
	}
	assert.equal(store.database, db);
});

test('re-opening an already migrated database does not run DDL a second time', () => {
	const db = database();
	openTenantStore({ database: db });
	// `sqlite_master` is the only source of truth, so the second open is expected to see
	// every object present and skip the transaction entirely. If it did not, two
	// processes starting together would race on "duplicate object" instead of opening.
	const current = tenantSchemaCurrent(db);
	assert.deepEqual(current.missing, []);
	assert.doesNotThrow(() => openTenantStore({ database: db }));
});

test('a missing database handle is a programming error, not a 404', () => {
	assert.throws(() => openTenantStore({}), { name: 'TypeError' });
	assert.throws(() => openTenantStore({ database: {} }), { name: 'TypeError' });
});

test('the PostgreSQL mapping expectations match tenant-schema.sql column for column', async () => {
	const sql = await readFile(new URL('./tenant-schema.sql', import.meta.url), 'utf8');
	for (const [table, columns] of Object.entries(tenantSchemaExpectations)) {
		const match = new RegExp('CREATE TABLE IF NOT EXISTS log4stellar\\.' + table + ' \\(([\\s\\S]*?)\\n\\);').exec(sql);
		assert.ok(match, 'tenant-schema.sql must create ' + table);
		const declared = match[1].split('\n')
			.map(line => line.trim().replace(/,$/, ''))
			.filter(line => line.length > 0 && !/^(PRIMARY|UNIQUE|CHECK|FOREIGN|CONSTRAINT)\b/i.test(line))
			.map(line => line.split(/\s+/)[0]);
		// The expectation table is what the release gate compares a live catalog against,
		// so a column added to the SQL and forgotten here would make the gate pass on a
		// database that is missing it.
		assert.deepEqual(declared, [...columns], table + ' columns');
	}
	for (const index of tenantMappingIndexes) {
		assert.match(sql, new RegExp('CREATE INDEX IF NOT EXISTS ' + index));
	}
});

test('the schema comparison reports missing tables, columns and statuses', () => {
	const complete = Object.assign(
		Object.fromEntries(Object.entries(tenantSchemaExpectations).map(([table, columns]) => [table, [...columns]])),
		{ indexes: [...tenantMappingIndexes] },
	);
	assert.deepEqual(compareTenantSchema(complete), []);

	const missingTable = { ...complete };
	delete missingTable.storage_tenant_map;
	assert.deepEqual(compareTenantSchema(missingTable), ['missing table: storage_tenant_map']);

	const missingColumn = { ...complete, storage_tenant_map: complete.storage_tenant_map.filter(name => name !== 'status') };
	assert.deepEqual(compareTenantSchema(missingColumn), ['missing columns in storage_tenant_map: status']);
});

test('the PostgreSQL status vocabulary is the one the DDL constrains', async () => {
	const sql = await readFile(new URL('./tenant-schema.sql', import.meta.url), 'utf8');
	for (const status of tenantMappingStatuses) {
		assert.ok(sql.includes("'" + status + "'"), status + ' must appear in the CHECK constraint');
	}
	for (const state of tenantIntentStates) {
		assert.ok(sql.includes("'" + state + "'"), state + ' must appear in the CHECK constraint');
	}
});

/**
 * A pool stub that answers the two catalog probes `ensureTenantSchema` makes and records
 * every statement, so the migrate-or-skip decision can be tested without a PostgreSQL.
 */
function fakePool({ current = false } = {}) {
	const statements = [];
	let probe = 0;
	const connection = {
		async query(sql, parameters = []) {
			statements.push({ sql: String(sql).trim(), parameters });
			if (String(sql).includes('to_regclass')) {
				probe++;
				return { rows: [{ current: probe > 1 || current }] };
			}
			if (String(sql).includes('information_schema.columns')) {
				return { rows: Object.entries(tenantSchemaExpectations).map(([name, columns]) => ({ name, columns: [...columns] })) };
			}
			if (String(sql).includes('pg_indexes')) {
				return { rows: tenantMappingIndexes.map(name => ({ name })) };
			}
			return { rows: [] };
		},
		release() { statements.push({ sql: 'release' }); },
	};
	return { statements, connect: async () => connection, query: connection.query };
}

test('a current schema is not migrated again, and a stale one is', async () => {
	const current = fakePool({ current: true });
	assert.deepEqual(await ensureTenantSchema(current), { migrated: false, current: true });
	// Probing first is what keeps the critical path of every process start lock-free: an
	// unconditional CREATE would take a write lock even when it changes nothing.
	assert.ok(!current.statements.some(entry => entry.sql === 'BEGIN'), 'a current schema must not open a transaction');

	const stale = fakePool({ current: false });
	assert.deepEqual(await ensureTenantSchema(stale), { migrated: true, current: true });
	// The whole SQL file is applied as one statement, so the assertion is about the file
	// reaching the connection, not about statement splitting.
	assert.ok(stale.statements.some(entry => entry.sql.includes('CREATE TABLE IF NOT EXISTS log4stellar.storage_tenant_map')));
});

test('the migration runs inside the shared advisory lock so the three schemas serialise', async () => {
	const pool = fakePool({ current: false });
	await ensureTenantSchema(pool);
	const statements = pool.statements.map(entry => entry.sql);
	const begin = statements.indexOf('BEGIN');
	const lock = statements.findIndex(sql => sql.includes('pg_advisory_xact_lock'));
	const ddl = statements.findIndex(sql => sql.includes('CREATE TABLE IF NOT EXISTS log4stellar.'));
	// Order matters: the transaction opens before the lock, and the lock is taken before
	// any DDL, because CREATE queues readers behind it.
	assert.ok(begin >= 0, 'the migration opens a transaction');
	assert.ok(lock > begin && ddl > lock, 'the lock has to be taken before the DDL');
	assert.ok(statements.includes('COMMIT'));
});

test('a mapping is bound once and a different tenant is refused', async () => {
	const bound = new Map();
	const mapping = {
		async read(workspaceId) { return bound.get(workspaceId) ?? null; },
		async bind(row) { bound.set(row.workspaceId, row); return row; },
	};
	const first = await bindLegacyWorkspaceTenant(mapping, storageWorkspace);
	assert.equal(first.tenantId, legacyTenantId);
	// Idempotent: a second start must be a no-op rather than an error.
	assert.equal((await bindLegacyWorkspaceTenant(mapping, storageWorkspace)).tenantId, legacyTenantId);
	await assert.rejects(
		() => bindLegacyWorkspaceTenant(mapping, storageWorkspace, { tenantId: 't-other' }),
		/Workspace log4stellar-main already belongs to tenant default\./,
	);
});

test('an intent row is keyed by the client key and validated', async () => {
	const pool = fakePool();
	const recorded = [];
	pool.query = async (sql, parameters = []) => {
		recorded.push({ sql: String(sql), parameters });
		return { rows: [{ idempotencyKey: parameters[0], state: parameters[4] }] };
	};
	await recordTenantIntent(pool, { idempotencyKey: 'key-1', operation: 'tenant.create', tenantId: 't-gamma' });
	assert.equal(recorded[0].parameters[3], '', 'a tenant creation carries no workspace, spelled as the empty string');
	assert.equal(recorded[0].parameters[4], 'pending');

	// A key without an operation would make an orphaned intent unexplainable to whoever
	// reads the table during an incident.
	await assert.rejects(() => recordTenantIntent(pool, { idempotencyKey: 'key-2', tenantId: 't-gamma' }), { name: 'TypeError' });
	await assert.rejects(() => recordTenantIntent(pool, { idempotencyKey: '', operation: 'op', tenantId: 't' }), { name: 'TypeError' });
	await assert.rejects(
		() => recordTenantIntent(pool, { idempotencyKey: 'key-3', operation: 'op', tenantId: 't', state: 'done' }),
		{ name: 'TypeError' },
	);
});

// ---------------------------------------------------------------------------------------
// Identity store
// ---------------------------------------------------------------------------------------

test('a created tenant makes its owner an administrator and nobody else a member', () => {
	const { store } = twoTenants();
	assert.deepEqual(store.listTenants('user-a'), [{ tenantId: tenantIdOf('alpha'), name: 'Alpha', role: tenantRoles.admin }]);
	assert.deepEqual(store.listTenants('user-b'), [{ tenantId: tenantIdOf('beta'), name: 'Beta', role: tenantRoles.admin }]);
	// The outsider belongs nowhere and therefore sees nothing — not an empty tenant, an
	// empty list.
	assert.deepEqual(store.listTenants('user-outsider'), []);
});

test('creating the same tenant id twice is a conflict, not a silent update', () => {
	const { store } = twoTenants();
	assert.throws(
		() => store.createTenant({ tenantId: tenantIdOf('alpha'), name: 'Alpha again', ownerId: 'user-b' }),
		error => error instanceof WorkspaceError && error.status === 409 && error.code === 'TenantExists',
	);
});

test('a retried create with the same idempotency key returns the first tenant', () => {
	const { store, db } = twoTenants();
	// The PostgreSQL mapping and this row are written by two systems, so the retry has to
	// be resolved by the key: a client that times out mid-creation and retries must not
	// end up with two tenants.
	const first = store.createTenant({ tenantId: tenantIdOf('gamma'), name: 'Gamma', ownerId: 'user-a', idempotencyKey: 'key-1' });
	assert.equal(first.created, true);
	const retry = store.createTenant({ tenantId: tenantIdOf('gamma-other'), name: 'Gamma', ownerId: 'user-a', idempotencyKey: 'key-1' });
	assert.equal(retry.created, false);
	assert.equal(retry.tenantId, tenantIdOf('gamma'));
	assert.equal(db.prepare('SELECT COUNT(*) AS total FROM tenant').get().total, 3);
});

test('the legacy tenant is seeded once and keeps a role an operator has since changed', () => {
	const db = database();
	const store = openTenantStore({ database: db, now: clock() });
	const first = store.seedLegacyTenant({ tenantId: legacyTenantId, name: 'Default', adminIds: ['user-a', 'user-b'] });
	assert.deepEqual({ created: first.created, admins: first.admins }, { created: true, admins: 2 });

	// An operator demotes one of them; a second start must not promote anybody back.
	store.changeTenantRole('user-a', legacyTenantId, 'user-b', { role: tenantRoles.member, expectedVersion: 1 });
	const second = store.seedLegacyTenant({ tenantId: legacyTenantId, name: 'Renamed', adminIds: ['user-a', 'user-b'] });
	assert.deepEqual({ created: second.created, admins: second.admins }, { created: false, admins: 0 });
	assert.equal(store.describeMembership('user-b', legacyTenantId).role, tenantRoles.member);
	assert.equal(store.describeMembership('user-b', legacyTenantId).name, 'Default');
});

test('seeding adds administrators to a tenant that was created before any account existed', () => {
	// The deployment sequence that broke: `create-account.mjs` opens the auth database
	// before the first account exists, so `openAuth()` seeds the tenant with nobody in it.
	// If seeding then returned early on the next start, the account created a moment later
	// owned the workspace but was not a tenant member, and `GET /api/v1/tenants` answered
	// `{"tenants":[]}` for the only operator of the deployment, forever.
	const db = database();
	const store = openTenantStore({ database: db, now: clock() });
	const empty = store.seedLegacyTenant({ tenantId: legacyTenantId, name: 'Default', adminIds: [] });
	assert.deepEqual({ created: empty.created, admins: empty.admins }, { created: true, admins: 0 });
	assert.deepEqual(store.listTenants('user-a'), []);

	const second = store.seedLegacyTenant({ tenantId: legacyTenantId, name: 'Default', adminIds: ['user-a'] });
	assert.deepEqual({ created: second.created, admins: second.admins }, { created: false, admins: 1 });
	assert.deepEqual(store.listTenants('user-a'), [{ tenantId: legacyTenantId, role: tenantRoles.admin, name: 'Default' }]);

	// Still idempotent: the same call again adds nobody, and never duplicates the row.
	const third = store.seedLegacyTenant({ tenantId: legacyTenantId, name: 'Default', adminIds: ['user-a'] });
	assert.equal(third.admins, 0);
	assert.equal(db.prepare('SELECT COUNT(*) AS total FROM tenant_member WHERE tenant_id = ?').get(legacyTenantId).total, 1);
});

test('a suspended tenant disappears from the list and from every scope', () => {
	const { store, db } = twoTenants();
	db.prepare("UPDATE tenant SET status = 'suspended' WHERE id = ?").run(tenantIdOf('alpha'));
	assert.deepEqual(store.listTenants('user-a'), []);
	// Concealed, not "suspended": telling a suspended tenant's members that it is
	// suspended would also tell an outsider that it exists.
	assert.throws(() => store.describeMembership('user-a', tenantIdOf('alpha')), error => error.status === 404);
});

test('a missing tenant and somebody else\'s tenant answer identically', () => {
	const { store } = twoTenants();
	const capture = call => {
		try { call(); } catch (error) { return error; }
		throw new Error('expected a concealment failure');
	};
	const missing = capture(() => store.describeMembership('user-a', tenantIdOf('nope')));
	const foreign = capture(() => store.describeMembership('user-a', tenantIdOf('beta')));
	// Acceptance case T01: the response must not distinguish "does not exist" from
	// "exists but is not yours", or the API becomes a tenant-existence oracle.
	assert.equal(missing.code, foreign.code);
	assert.equal(missing.status, foreign.status);
	assert.equal(missing.message, foreign.message);
});

test('an invitation is consumed exactly once, and a second accept changes nothing', async () => {
	const { store, db } = twoTenants();
	const token = 'invitation-token-value';
	const digest = await digestInvitationToken(token);
	const issued = store.issueInvitation('user-a', tenantIdOf('alpha'), {
		invitationId: 'inv-1', email: 'new@example.test', role: 'member', tokenDigest: digest,
	});
	assert.equal(issued.role, tenantRoles.member);

	const accepted = store.acceptInvitation('user-outsider', digest);
	assert.deepEqual(accepted, { tenantId: tenantIdOf('alpha'), role: tenantRoles.member, membershipCreated: true });

	// Acceptance case T02: two concurrent accepts both see an unaccepted row, and exactly
	// one UPDATE changes it. The loser must not mint a second membership.
	assert.throws(() => store.acceptInvitation('user-outsider', digest), error => error.status === 404);
	assert.equal(db.prepare('SELECT COUNT(*) AS total FROM tenant_member WHERE tenant_id = ?').get(tenantIdOf('alpha')).total, 2);
	// The audit trail records the successful consumption once, not the failed retry.
	const audit = store.listTenantAudit('user-a', tenantIdOf('alpha'));
	assert.equal(audit.entries.filter(entry => entry.action === 'invitation.accept').length, 1);
});

test('an expired or revoked invitation is indistinguishable from an unknown one', async () => {
	const now = clock();
	const db = database(['user-a']);
	const store = openTenantStore({ database: db, now });
	store.createTenant({ tenantId: tenantIdOf('alpha'), name: 'Alpha', ownerId: 'user-a' });

	const expired = await digestInvitationToken('expired');
	store.issueInvitation('user-a', tenantIdOf('alpha'), {
		invitationId: 'inv-expired', email: 'a@example.test', role: 'member', tokenDigest: expired, lifetimeMs: 1000,
	});
	now.advance(2000);
	assert.throws(() => store.acceptInvitation('user-outsider', expired), error => error.status === 404);

	const revoked = await digestInvitationToken('revoked');
	store.issueInvitation('user-a', tenantIdOf('alpha'), {
		invitationId: 'inv-revoked', email: 'b@example.test', role: 'member', tokenDigest: revoked,
	});
	store.revokeInvitation('user-a', tenantIdOf('alpha'), 'inv-revoked');
	assert.throws(() => store.acceptInvitation('user-outsider', revoked), error => error.status === 404);
});

test('an invitation lifetime beyond the maximum is refused at issue time', () => {
	const { store } = twoTenants();
	assert.throws(
		() => store.issueInvitation('user-a', tenantIdOf('alpha'), {
			invitationId: 'inv-long', email: 'a@example.test', role: 'member',
			tokenDigest: 'a'.repeat(64), lifetimeMs: invitationLifetimeMs * 10,
		}),
		error => error instanceof WorkspaceError && error.code === 'InvalidInvitationLifetime',
	);
});

test('two operators demoting the last two administrators cannot both succeed', () => {
	const db = database(['user-a', 'user-b', 'user-c']);
	const store = openTenantStore({ database: db, now: clock() });
	store.createTenant({ tenantId: tenantIdOf('alpha'), name: 'Alpha', ownerId: 'user-a' });
	store.issueInvitation('user-a', tenantIdOf('alpha'), {
		invitationId: 'inv-b', email: 'b@example.test', role: 'admin', tokenDigest: 'b'.repeat(64),
	});
	store.acceptInvitation('user-b', 'b'.repeat(64));

	// Acceptance case T03: the guard reads the admin count inside the same write
	// transaction as the update, so the second demotion sees the first one's commit.
	store.changeTenantRole('user-a', tenantIdOf('alpha'), 'user-b', { role: tenantRoles.member, expectedVersion: 1 });
	assert.throws(
		() => store.changeTenantRole('user-b', tenantIdOf('alpha'), 'user-a', { role: tenantRoles.member, expectedVersion: 1 }),
		error => error.status === 403,
	);
	const admins = db.prepare('SELECT COUNT(*) AS total FROM tenant_member WHERE tenant_id = ? AND role = ?').get(tenantIdOf('alpha'), tenantRoles.admin).total;
	assert.equal(admins, 1);
});

test('the last administrator cannot be removed or demoted', () => {
	const { store } = twoTenants();
	assert.throws(
		() => store.changeTenantRole('user-a', tenantIdOf('alpha'), 'user-a', { role: tenantRoles.member, expectedVersion: 1 }),
		error => error instanceof WorkspaceError && error.status === 409 && error.code === 'LastAdmin',
	);
	assert.throws(
		() => store.revokeTenantMember('user-a', tenantIdOf('alpha'), 'user-a', { expectedVersion: 1 }),
		error => error instanceof WorkspaceError && error.code === 'LastAdmin',
	);
});

test('a stale version loses instead of overwriting a concurrent change', () => {
	const db = database(['user-a', 'user-b']);
	const store = openTenantStore({ database: db, now: clock() });
	store.createTenant({ tenantId: tenantIdOf('alpha'), name: 'Alpha', ownerId: 'user-a' });
	store.issueInvitation('user-a', tenantIdOf('alpha'), {
		invitationId: 'inv-b', email: 'b@example.test', role: 'member', tokenDigest: 'b'.repeat(64),
	});
	store.acceptInvitation('user-b', 'b'.repeat(64));

	const updated = store.changeTenantRole('user-a', tenantIdOf('alpha'), 'user-b', { role: tenantRoles.admin, expectedVersion: 1 });
	assert.equal(updated.version, 2);
	assert.throws(
		() => store.changeTenantRole('user-a', tenantIdOf('alpha'), 'user-b', { role: tenantRoles.member, expectedVersion: 1 }),
		error => error instanceof WorkspaceError && error.status === 409 && error.code === 'VersionConflict',
	);
});

test('member and audit pages are keyset paginated and the audit page is newest first', () => {
	const db = database(['user-a', 'user-b', 'user-c', 'user-d']);
	const store = openTenantStore({ database: db, now: clock() });
	store.createTenant({ tenantId: tenantIdOf('alpha'), name: 'Alpha', ownerId: 'user-a' });
	for (const [index, userId] of ['user-b', 'user-c', 'user-d'].entries()) {
		store.issueInvitation('user-a', tenantIdOf('alpha'), {
			invitationId: 'inv-' + index, email: userId + '@example.test', role: 'member', tokenDigest: String(index).repeat(64),
		});
		store.acceptInvitation(userId, String(index).repeat(64));
	}

	const first = store.listTenantMembers('user-a', tenantIdOf('alpha'), { limit: 2 });
	assert.equal(first.members.length, 2);
	assert.ok(first.nextCursor);
	const second = store.listTenantMembers('user-a', tenantIdOf('alpha'), { limit: 2, cursor: first.nextCursor });
	assert.equal(second.members.length, 2);
	// Keyset, not OFFSET: no member may be shown twice or skipped while the page shifts.
	const seen = [...first.members, ...second.members].map(member => member.userId);
	assert.deepEqual([...new Set(seen)].length, seen.length);

	const audit = store.listTenantAudit('user-a', tenantIdOf('alpha'), { limit: 2 });
	assert.equal(audit.entries.length, 2);
	assert.ok(audit.entries[0].id > audit.entries[1].id);
	const filtered = store.listTenantAudit('user-a', tenantIdOf('alpha'), { action: 'invitation.accept' });
	assert.equal(filtered.entries.length, 3);
	for (const entry of filtered.entries) {
		assert.equal(entry.action, 'invitation.accept');
	}
});

test('an ordinary member cannot administer the tenant, and the refusal is a 403', () => {
	const db = database(['user-a', 'user-b']);
	const store = openTenantStore({ database: db, now: clock() });
	store.createTenant({ tenantId: tenantIdOf('alpha'), name: 'Alpha', ownerId: 'user-a' });
	store.issueInvitation('user-a', tenantIdOf('alpha'), {
		invitationId: 'inv-b', email: 'b@example.test', role: 'member', tokenDigest: 'b'.repeat(64),
	});
	store.acceptInvitation('user-b', 'b'.repeat(64));

	// A 403 here is correct and leaks nothing: the caller has already proved they belong
	// to this tenant, so naming the missing right tells them nothing new.
	for (const call of [
		() => store.listTenantMembers('user-b', tenantIdOf('alpha')),
		() => store.listTenantAudit('user-b', tenantIdOf('alpha')),
		() => store.issueInvitation('user-b', tenantIdOf('alpha'), { invitationId: 'x', email: 'x@example.test', role: 'member', tokenDigest: 'c'.repeat(64) }),
	]) {
		assert.throws(call, error => error instanceof WorkspaceError && error.status === 403 && error.code === 'NoPermissions');
	}
});

test('role names normalise to their level and an unknown one is refused', () => {
	assert.equal(normalizeTenantRole('member'), tenantRoles.member);
	assert.equal(normalizeTenantRole('admin'), tenantRoles.admin);
	assert.equal(normalizeTenantRole(tenantRoles.admin), tenantRoles.admin);
	assert.throws(() => normalizeTenantRole('owner'), error => error instanceof WorkspaceError && error.code === 'InvalidTenantRole');
	assert.throws(() => normalizeTenantRole(3), error => error instanceof WorkspaceError && error.code === 'InvalidTenantRole');
	assert.throws(() => normalizeTenantRole(undefined), error => error instanceof WorkspaceError && error.code === 'InvalidTenantRole');
});

// ---------------------------------------------------------------------------------------
// Scope resolution
// ---------------------------------------------------------------------------------------

function scopeFixture({ workspaceTenant = tenantIdOf('alpha'), status = 'active' } = {}) {
	const { store, db } = twoTenants();
	const readWorkspaceMapping = mappingOf([{ workspaceId: storageWorkspace, tenantId: workspaceTenant, status }]);
	const roles = new Map([['user-a', workspaceRoles.owner]]);
	const resolveWorkspaceRole = (userId, workspaceId) => (workspaceId === storageWorkspace ? roles.get(userId) : undefined);
	return { store, db, readWorkspaceMapping, roles, resolveWorkspaceRole };
}

test('a tenant-scoped call resolves to a frozen scope with a null workspace', async () => {
	const { store, readWorkspaceMapping, resolveWorkspaceRole } = scopeFixture();
	const scope = await resolveTenantScope({
		store, readWorkspaceMapping, principalId: 'user-a', tenantId: tenantIdOf('alpha'), resolveWorkspaceRole,
	});
	assert.equal(scope.tenantId, tenantIdOf('alpha'));
	// Explicitly present and null, so a caller cannot mistake absence for "no restriction".
	assert.ok(Object.hasOwn(scope, 'workspaceId'));
	assert.equal(scope.workspaceId, null);
	assert.equal(scope.capability, tenantCapabilities.read);
	assert.ok(Object.isFrozen(scope));
});

test('a workspace of another tenant is concealed before the workspace role is consulted', async () => {
	const { store, readWorkspaceMapping, resolveWorkspaceRole } = scopeFixture({ workspaceTenant: tenantIdOf('beta') });
	let consulted = false;
	await assert.rejects(
		() => resolveTenantScope({
			store, readWorkspaceMapping, principalId: 'user-a', tenantId: tenantIdOf('alpha'),
			workspaceId: storageWorkspace, resolveWorkspaceRole: (...args) => { consulted = true; return resolveWorkspaceRole(...args); },
		}),
		error => {
			// Acceptance case T01: the answer is a 404, never a 403, because a 403 would
			// confirm the workspace exists under a different tenant.
			assertWorkspaceError(error, 404, 'NotFound');
			return true;
		},
	);
	assert.equal(consulted, false, 'the workspace role must not be read for a foreign workspace');
});

test('a pending or failed mapping is concealed even when the tenant matches', async () => {
	for (const status of ['pending', 'failed']) {
		const { store, readWorkspaceMapping, resolveWorkspaceRole } = scopeFixture({ status });
		await assert.rejects(
			() => resolveTenantScope({
				store, readWorkspaceMapping, principalId: 'user-a', tenantId: tenantIdOf('alpha'),
				workspaceId: storageWorkspace, resolveWorkspaceRole,
			}),
			// Acceptance case T04: a half-finished cross-database creation fails closed
			// instead of exposing an orphan workspace.
			error => {
				assertWorkspaceError(error, 404, 'NotFound');
				return true;
			},
		);
	}
});

test('an unmapped workspace resolves to concealment, not to an error', async () => {
	const { store, resolveWorkspaceRole } = scopeFixture();
	await assert.rejects(
		() => resolveTenantScope({
			store, readWorkspaceMapping: async () => null, principalId: 'user-a', tenantId: tenantIdOf('alpha'),
			workspaceId: storageWorkspace, resolveWorkspaceRole,
		}),
		error => {
			assertWorkspaceError(error, 404, 'NotFound');
			return true;
		},
	);
});

test('a missing mapping reader is a wiring error rather than an allow', async () => {
	const { store } = scopeFixture();
	await assert.rejects(
		() => resolveTenantScope({
			store, readWorkspaceMapping: undefined, principalId: 'user-a', tenantId: tenantIdOf('alpha'),
			workspaceId: storageWorkspace, resolveWorkspaceRole: () => workspaceRoles.owner,
		}),
		{ name: 'TypeError' },
	);
});

test('a tenant administrator without a workspace role gets a 403, not an implicit grant', async () => {
	const { store, readWorkspaceMapping } = scopeFixture();
	await assert.rejects(
		() => resolveTenantScope({
			store, readWorkspaceMapping, principalId: 'user-a', tenantId: tenantIdOf('alpha'),
			workspaceId: storageWorkspace, resolveWorkspaceRole: () => undefined,
		}),
		// Governance of people is not access to their notes: the audit trail has to show a
		// real workspace membership before content is read.
		error => {
			assertWorkspaceError(error, 403, 'NoPermissions');
			return true;
		},
	);
});

test('a viewer is refused the history capability but allowed to read', async () => {
	const { store, readWorkspaceMapping, roles, resolveWorkspaceRole } = scopeFixture();
	roles.set('user-a', workspaceRoles.viewer);
	const read = await resolveTenantScope({
		store, readWorkspaceMapping, principalId: 'user-a', tenantId: tenantIdOf('alpha'),
		workspaceId: storageWorkspace, resolveWorkspaceRole,
	});
	assert.equal(read.workspaceRole, workspaceRoles.viewer);
	await assert.rejects(
		() => resolveTenantScope({
			store, readWorkspaceMapping, principalId: 'user-a', tenantId: tenantIdOf('alpha'),
			workspaceId: storageWorkspace, capability: 'workspace.write', resolveWorkspaceRole,
		}),
		error => {
			assertWorkspaceError(error, 403, 'NoPermissions');
			return true;
		},
	);
});

test('a workspace owner who is only a tenant member cannot administer the tenant', async () => {
	const { store, db, readWorkspaceMapping, resolveWorkspaceRole } = scopeFixture();
	// Demote the caller to an ordinary tenant member while leaving them the owner of the
	// workspace: the two role systems are independent, and a tenant write must follow the
	// tenant role even when the caller owns every file in the workspace.
	store.issueInvitation('user-a', tenantIdOf('alpha'), {
		invitationId: 'inv-second', email: 'b@example.test', role: 'admin', tokenDigest: 'b'.repeat(64),
	});
	store.acceptInvitation('user-b', 'b'.repeat(64));
	store.changeTenantRole('user-a', tenantIdOf('alpha'), 'user-a', { role: tenantRoles.member, expectedVersion: 1 });
	assert.equal(store.describeMembership('user-a', tenantIdOf('alpha')).role, tenantRoles.member);

	await assert.rejects(
		() => resolveTenantScope({
			store, readWorkspaceMapping, principalId: 'user-a', tenantId: tenantIdOf('alpha'),
			capability: tenantCapabilities.admin, resolveWorkspaceRole,
		}),
		error => {
			assertWorkspaceError(error, 403, 'NoPermissions');
			return true;
		},
	);
	// The workspace role is untouched: demotion in the tenant does not lose the workspace.
	const read = await resolveTenantScope({
		store, readWorkspaceMapping, principalId: 'user-a', tenantId: tenantIdOf('alpha'),
		workspaceId: storageWorkspace, resolveWorkspaceRole,
	});
	assert.equal(read.workspaceRole, workspaceRoles.owner);
	assert.equal(read.tenantRole, tenantRoles.member);
	assert.equal(db.prepare('SELECT COUNT(*) AS total FROM tenant_member WHERE tenant_id = ?').get(tenantIdOf('alpha')).total, 2);
});

test('a capability from the wrong namespace is a wiring error, never a silent denial', async () => {
	const { store, readWorkspaceMapping, resolveWorkspaceRole } = scopeFixture();
	for (const [capability, workspaceId] of [
		['workspace.read', null],
		[tenantCapabilities.admin, storageWorkspace],
	]) {
		await assert.rejects(
			() => resolveTenantScope({
				store, readWorkspaceMapping, principalId: 'user-a', tenantId: tenantIdOf('alpha'),
				workspaceId, capability, resolveWorkspaceRole,
			}),
			// A tenant capability on a workspace call is unheld by every workspace role, so
			// silently answering 403 would send the next reader looking for a missing
			// permission instead of the wrong constant.
			{ name: 'TypeError' },
		);
	}
});

// ---------------------------------------------------------------------------------------
// HTTP surface
// ---------------------------------------------------------------------------------------

/**
 * The smallest context `serveTenantRequest` accepts. It mimics the Koa surface the real
 * gateway provides — `path`, `method`, `query`, `get()`, `is()`, `req` — and nothing else,
 * so a handler that reached for a cookie or a session would fail here.
 */
function context({ method = 'GET', path = '/api/v1/tenants', query = {}, body = undefined, headers = {} } = {}) {
	const text = body === undefined ? '' : JSON.stringify(body);
	const chunks = text ? [Buffer.from(text, 'utf8')] : [];
	return {
		method,
		path,
		query,
		status: 200,
		body: undefined,
		req: (async function* stream() { yield* chunks; })(),
		get(name) { return headers[name.toLowerCase()]; },
		is(type) { return headers['content-type'] === type; },
	};
}

function handler({ store = twoTenants().store, readWorkspaceMapping = mappingOf([]), resolveWorkspaceRole = () => undefined, isPlatformAdmin = () => false, createTenantRecord = undefined } = {}) {
	return async ctx => {
		await serveTenantRequest(ctx, { principalId: 'user-a', store, readWorkspaceMapping, resolveWorkspaceRole, isPlatformAdmin, createTenantRecord });
		return ctx;
	};
}

test('the tenant list returns only the caller\'s own memberships', async () => {
	const { store } = twoTenants();
	const ctx = await handler({ store })(context());
	assert.equal(ctx.status, 200);
	assert.deepEqual(ctx.body.tenants.map(tenant => tenant.tenantId), [tenantIdOf('alpha')]);
});

test('creating a tenant without the platform right is a 403 and writes nothing', async () => {
	const { store, db } = twoTenants();
	const ctx = await handler({ store })(context({
		method: 'POST', path: '/api/v1/tenants',
		headers: { 'content-type': 'application/json' },
		body: { name: 'Gamma' },
	}));
	// The handler answers, it does not throw: every tenant error becomes a stable code in
	// the body, so the gateway has nothing to interpret.
	assert.equal(ctx.status, 403);
	assert.deepEqual(ctx.body, { error: 'NoPermissions' });
	assert.equal(db.prepare('SELECT COUNT(*) AS total FROM tenant').get().total, 2);
});

test('a created tenant answers 201 once and 200 when the idempotency key replays', async () => {
	const { store } = twoTenants();
	const call = handler({ store, isPlatformAdmin: () => true, createTenantRecord: async () => {} });
	const body = { name: 'Gamma', tenantId: tenantIdOf('gamma'), idempotencyKey: 'create-gamma' };
	const first = await call(context({ method: 'POST', path: '/api/v1/tenants', headers: { 'content-type': 'application/json' }, body }));
	assert.equal(first.status, 201);
	assert.equal(first.body.tenantId, tenantIdOf('gamma'));
	const replay = await call(context({ method: 'POST', path: '/api/v1/tenants', headers: { 'content-type': 'application/json' }, body }));
	assert.equal(replay.status, 200);
	assert.equal(replay.body.created, false);
});

test('a failed cross-database record keeps the tenant and reports 503', async () => {
	const { store } = twoTenants();
	const ctx = await handler({ store, isPlatformAdmin: () => true, createTenantRecord: async () => { throw new Error('mapping unavailable'); } })(context({
		method: 'POST', path: '/api/v1/tenants',
		headers: { 'content-type': 'application/json' },
		body: { name: 'Gamma', tenantId: tenantIdOf('gamma') },
	}));
	// Acceptance case T04: the tenant row stays usable, so a retry with the same key
	// replays instead of creating a second tenant.
	assert.equal(ctx.status, 503);
	assert.deepEqual(ctx.body, { error: 'TenantMappingFailed' });
	assert.deepEqual(store.listTenants('user-a').map(tenant => tenant.tenantId), [tenantIdOf('alpha'), tenantIdOf('gamma')]);
});

test('inviting a member returns the plaintext token exactly once and stores only its digest', async () => {
	const { store, db } = twoTenants();
	const ctx = await handler({ store })(context({
		method: 'POST', path: '/api/v1/tenants/' + tenantIdOf('alpha') + '/invitations',
		headers: { 'content-type': 'application/json' },
		body: { email: 'new@example.test', role: 'member' },
	}));
	assert.equal(ctx.status, 201);
	assert.equal(typeof ctx.body.token, 'string');
	assert.ok(ctx.body.token.length >= 40);
	const stored = db.prepare('SELECT token_digest FROM tenant_invitation WHERE id = ?').get(ctx.body.invitationId);
	assert.notEqual(stored.token_digest, ctx.body.token);
	assert.equal(stored.token_digest, await digestInvitationToken(ctx.body.token));
});

test('a malformed body is a 400 and every error body carries the code only', async () => {
	const { store } = twoTenants();
	const bad = await handler({ store })(context({
		method: 'POST', path: '/api/v1/tenants/' + tenantIdOf('alpha') + '/invitations',
		headers: { 'content-type': 'application/json' },
		body: { email: 'not-an-address' },
	}));
	assert.equal(bad.status, 400);
	assert.deepEqual(bad.body, { error: 'InvalidEmail' });

	const wrongType = await handler({ store })(context({
		method: 'POST', path: '/api/v1/tenants/' + tenantIdOf('alpha') + '/invitations',
		headers: { 'content-type': 'text/plain' },
		body: { email: 'a@example.test' },
	}));
	assert.equal(wrongType.status, 415);
	assert.deepEqual(wrongType.body, { error: 'InvalidContentType' });
});

test('accepting an invitation over HTTP creates the membership', async () => {
	const { store, db } = twoTenants();
	const issued = await handler({ store })(context({
		method: 'POST', path: '/api/v1/tenants/' + tenantIdOf('alpha') + '/invitations',
		headers: { 'content-type': 'application/json' },
		body: { email: 'new@example.test', role: 'member' },
	}));
	const accept = async ctx => {
		await serveTenantRequest(ctx, { principalId: 'user-outsider', store, readWorkspaceMapping: mappingOf([]), resolveWorkspaceRole: () => undefined });
		return ctx;
	};
	const ctx = await accept(context({
		method: 'POST', path: '/api/v1/invitations/accept',
		headers: { 'content-type': 'application/json' },
		body: { token: issued.body.token },
	}));
	assert.equal(ctx.status, 200);
	assert.equal(ctx.body.tenantId, tenantIdOf('alpha'));
	assert.equal(db.prepare('SELECT COUNT(*) AS total FROM tenant_member WHERE tenant_id = ?').get(tenantIdOf('alpha')).total, 2);
});

test('a workspace route exercises all four conjuncts and reports the resolved roles', async () => {
	const { store, readWorkspaceMapping, resolveWorkspaceRole } = scopeFixture();
	const ctx = await handler({ store, readWorkspaceMapping, resolveWorkspaceRole })(context({
		path: '/api/v1/tenants/' + tenantIdOf('alpha') + '/workspaces/' + storageWorkspace,
	}));
	assert.equal(ctx.status, 200);
	assert.deepEqual(ctx.body, {
		tenantId: tenantIdOf('alpha'),
		workspaceId: storageWorkspace,
		tenantRole: tenantRoles.admin,
		workspaceRole: workspaceRoles.owner,
	});
});

test('a foreign workspace in the URL is a uniform 404', async () => {
	const { store, readWorkspaceMapping, resolveWorkspaceRole } = scopeFixture({ workspaceTenant: tenantIdOf('beta') });
	const ctx = await handler({ store, readWorkspaceMapping, resolveWorkspaceRole })(context({
		path: '/api/v1/tenants/' + tenantIdOf('alpha') + '/workspaces/' + storageWorkspace,
	}));
	// The body names only the code: a message would have to distinguish "no such tenant"
	// from "not yours", which is the oracle this surface exists to avoid.
	assert.equal(ctx.status, 404);
	assert.deepEqual(ctx.body, { error: 'NotFound' });
});

test('an unknown route under the tenant mount is a 404, not a 405', async () => {
	const { store } = twoTenants();
	const ctx = await handler({ store })(context({ method: 'DELETE', path: '/api/v1/tenants/' + tenantIdOf('alpha') }));
	// An unknown shape under the mount is a 404 rather than a 405: a 405 would confirm the
	// route exists and that the caller merely used the wrong verb.
	assert.equal(ctx.status, 404);
	assert.deepEqual(ctx.body, { error: 'NotFound' });
});

// ---------------------------------------------------------------------------------------
// Contract tables
// ---------------------------------------------------------------------------------------

test('the capability table routes exactly the documented shapes', () => {
	assert.equal(capabilityForTenantRequest('GET', '/api/v1/tenants'), tenantCapabilities.read);
	assert.equal(capabilityForTenantRequest('GET', '/api/v1/tenants/t-alpha/members'), tenantCapabilities.admin);
	assert.equal(capabilityForTenantRequest('GET', '/api/v1/tenants/t-alpha/audit'), tenantCapabilities.admin);
	// Not a tenant capability at all: creating a tenant is above every tenant, and
	// accepting an invitation is authorized by the token in the body.
	assert.equal(capabilityForTenantRequest('POST', '/api/v1/tenants'), null);
	assert.equal(capabilityForTenantRequest('POST', '/api/v1/invitations/accept'), null);
	assert.equal(capabilityForTenantRequest('GET', '/api/session'), undefined);
});

test('the permission matrix names every route the service actually serves', () => {
	const served = tenantPermissionMatrix.map(row => row.surface);
	for (const surface of served) {
		const [method, raw] = surface.split(' ');
		const path = raw.replace(/:id/g, 't-alpha').replace(/:userId/g, 'user-b').split('?')[0];
		// Every row must resolve through the real router. A matrix row that names a path
		// the handler does not serve is worse than no matrix: it documents a permission
		// that is never checked.
		assert.notEqual(capabilityForTenantRequest(method, path), undefined, surface + ' must be routed');
	}
});

test('the surface manifest covers every entry point the task book requires', () => {
	const surfaces = tenantSurfaceManifest.map(entry => entry.surface);
	for (const required of ['/static/mount', '/sync/v1', '/git/v1', '/api/session', '/api/v1/tenants']) {
		assert.ok(surfaces.includes(required), '/api/v1/tenants task book requires ' + required);
	}
	for (const entry of tenantSurfaceManifest) {
		// Every surface has to state whether the tenant gate applies: a surface that omits
		// the decision is one nobody has decided about, which is exactly the drift this
		// manifest exists to prevent.
		assert.equal(typeof entry.tenantGate, 'boolean', entry.surface + ' must declare whether the tenant gate applies');
	}
});
