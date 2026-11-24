import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { legacyAdoptionKey, legacyMemberKeyPrefix, legacyWorkspace, migrateWorkspaceMembers, openAuth } from './auth.mjs';
import { workspaceRoles } from './workspace-access.mjs';

const storageWorkspace = 'log4stellar-main';
const execFileAsync = promisify(execFile);

function database() {
	const database = new DatabaseSync(':memory:');
	database.exec('CREATE TABLE user (id TEXT PRIMARY KEY, username TEXT) STRICT');
	database.exec("INSERT INTO user (id, username) VALUES ('user-a', 'user-a'), ('user-b', 'user-b'), ('user-c', 'user-c')");
	return database;
}

function rows(database) {
	return database.prepare('SELECT tenant_id, workspace_id, user_id, role FROM workspace_member ORDER BY workspace_id, user_id').all()
		.map(row => ({ ...row }));
}

function meta(database) {
	return database.prepare('SELECT key, value FROM workspace_meta ORDER BY key').all().map(row => ({ ...row }));
}

/** The per-account ledger that keeps a revoked membership revoked. */
function decisions(database) {
	return meta(database).filter(row => row.key.startsWith(legacyMemberKeyPrefix));
}

/**
 * Builds the table the previous release created, which has no `role` column.
 */
function createHistoricalTable(database) {
	database.exec(`
		CREATE TABLE workspace_member (
			tenant_id TEXT NOT NULL,
			workspace_id TEXT NOT NULL,
			user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
			PRIMARY KEY (tenant_id, workspace_id, user_id)
		) STRICT;
	`);
}

/** Fills a historical table with one placeholder row per user. */
function historical(database, userIds) {
	createHistoricalTable(database);
	for (const userId of userIds) {
		database.prepare("INSERT INTO workspace_member (tenant_id, workspace_id, user_id) VALUES ('default', 'default', ?)").run(userId);
	}
}

test('an existing placeholder row is upgraded in place and copied to the storage workspace', () => {
	const base = database();
	// Exactly the table shape the previous release created, already populated.
	historical(base, ['user-a']);

	migrateWorkspaceMembers(base, storageWorkspace);

	assert.deepEqual(rows(base), [
		// The placeholder row survives so a rollback to the previous release package
		// keeps every user signed in: it only checks workspace_id = 'default'.
		{ tenant_id: 'default', workspace_id: 'default', user_id: 'user-a', role: workspaceRoles.owner },
		// The canonical row carries the storage workspace ID used by everything else.
		{ tenant_id: 'default', workspace_id: storageWorkspace, user_id: 'user-a', role: workspaceRoles.owner },
	]);
});

test('the migration is idempotent and keeps an existing canonical role', () => {
	const base = database();
	migrateWorkspaceMembers(base, storageWorkspace);
	base.exec("INSERT INTO workspace_member (tenant_id, workspace_id, user_id, role) VALUES ('default', 'default', 'user-a', 3)");
	base.exec(`INSERT INTO workspace_member (tenant_id, workspace_id, user_id, role) VALUES ('default', '${storageWorkspace}', 'user-a', 1)`);

	migrateWorkspaceMembers(base, storageWorkspace);

	// INSERT OR IGNORE must not downgrade or upgrade a role an administrator set.
	assert.deepEqual(rows(base), [
		{ tenant_id: 'default', workspace_id: 'default', user_id: 'user-a', role: workspaceRoles.owner },
		{ tenant_id: 'default', workspace_id: storageWorkspace, user_id: 'user-a', role: workspaceRoles.viewer },
	]);
});

test('a deployment whose workspace ID is the placeholder does not duplicate rows', () => {
	const base = database();
	migrateWorkspaceMembers(base, legacyWorkspace);
	base.exec("INSERT INTO workspace_member (tenant_id, workspace_id, user_id, role) VALUES ('default', 'default', 'user-a', 3)");
	migrateWorkspaceMembers(base, legacyWorkspace);
	assert.deepEqual(rows(base), [{ tenant_id: 'default', workspace_id: 'default', user_id: 'user-a', role: workspaceRoles.owner }]);
});

test('a second workspace on a shared database never adopts the legacy accounts', () => {
	const base = database();
	historical(base, ['user-a']);
	migrateWorkspaceMembers(base, 'workspace-a');
	// Another deployment opens the same `auth.sqlite` with its own workspace ID.
	migrateWorkspaceMembers(base, 'workspace-b');

	// Only workspace-a owns the placeholder rows; workspace-b stays empty, so a user
	// created before roles existed cannot reach it (contract §6).
	assert.deepEqual(rows(base), [
		{ tenant_id: 'default', workspace_id: 'default', user_id: 'user-a', role: workspaceRoles.owner },
		{ tenant_id: 'default', workspace_id: 'workspace-a', user_id: 'user-a', role: workspaceRoles.owner },
	]);
	assert.deepEqual(meta(base), [
		{ key: legacyMemberKeyPrefix + 'user-a', value: 'workspace-a' },
		{ key: legacyAdoptionKey, value: 'workspace-a' },
	]);
});

test('a workspace that does not own the placeholder rows never adopts a straggler', () => {
	const base = database();
	historical(base, ['user-a']);
	migrateWorkspaceMembers(base, 'workspace-a');
	// An account created while the previous release package was running only has the
	// placeholder row. It looks unclaimed to a second workspace that shares this
	// database, which is exactly the cross-tenant takeover (review finding M2).
	base.exec("INSERT INTO workspace_member (tenant_id, workspace_id, user_id) VALUES ('default', 'default', 'user-b')");

	migrateWorkspaceMembers(base, 'workspace-b');

	// The first gate is the adoption marker: workspace-b is not the owner, so it must
	// not adopt anything, and it must not claim ownership either.
	assert.deepEqual(rows(base).filter(row => row.workspace_id === 'workspace-b'), []);
	assert.deepEqual(meta(base), [
		{ key: legacyMemberKeyPrefix + 'user-a', value: 'workspace-a' },
		{ key: legacyAdoptionKey, value: 'workspace-a' },
	]);
});

test('the owner adopts only the accounts no workspace has claimed yet', () => {
	const base = database();
	historical(base, ['user-a']);
	migrateWorkspaceMembers(base, 'workspace-a');
	// A rollback to the previous release package creates two more accounts there: the
	// old code only writes placeholder rows. One of them was meanwhile also added to
	// a different workspace, so it must never be pulled into workspace-a.
	base.exec("INSERT INTO workspace_member (tenant_id, workspace_id, user_id, role) VALUES ('default', 'default', 'user-b', 3)");
	base.exec("INSERT INTO workspace_member (tenant_id, workspace_id, user_id, role) VALUES ('default', 'default', 'user-c', 3)");
	base.exec("INSERT INTO workspace_member (tenant_id, workspace_id, user_id, role) VALUES ('default', 'workspace-c', 'user-c', 1)");
	migrateWorkspaceMembers(base, 'workspace-a');

	assert.deepEqual(rows(base).filter(row => row.workspace_id === 'workspace-a'), [
		// The account created while the rolled-back package was running is picked up...
		{ tenant_id: 'default', workspace_id: 'workspace-a', user_id: 'user-a', role: workspaceRoles.owner },
		{ tenant_id: 'default', workspace_id: 'workspace-a', user_id: 'user-b', role: workspaceRoles.owner },
		// ...but the one that belongs to another workspace is not.
	]);
	assert.deepEqual(rows(base).filter(row => row.workspace_id === 'workspace-c'), [
		{ tenant_id: 'default', workspace_id: 'workspace-c', user_id: 'user-c', role: workspaceRoles.viewer },
	]);
	// The rollback placeholder rows survive untouched in every case.
	assert.deepEqual(rows(base).filter(row => row.workspace_id === legacyWorkspace).map(row => row.user_id), ['user-a', 'user-b', 'user-c']);
});

test('a database written by the first release of this task is attributed to its workspace', () => {
	const base = database();
	historical(base, ['user-a']);
	// Shape left behind by the build that copied placeholder rows without recording an
	// owner: canonical rows exist, `workspace_meta` does not.
	migrateWorkspaceMembers(base, 'workspace-a');
	base.exec('DROP TABLE workspace_meta');
	base.exec("INSERT INTO workspace_member (tenant_id, workspace_id, user_id, role) VALUES ('default', 'default', 'user-b', 3)");
	migrateWorkspaceMembers(base, 'workspace-a');
	migrateWorkspaceMembers(base, 'workspace-b');

	// The workspace that already owns rows keeps the database, adopts the account the
	// rollback created, and the other deployment still gets nothing.
	assert.deepEqual(rows(base).filter(row => row.workspace_id === 'workspace-a').map(row => row.user_id), ['user-a', 'user-b']);
	assert.deepEqual(rows(base).filter(row => row.workspace_id === 'workspace-b'), []);
	assert.deepEqual(meta(base).filter(row => row.key === legacyAdoptionKey), [{ key: legacyAdoptionKey, value: 'workspace-a' }]);
});

test('the adoption marker is written once and is idempotent', () => {
	const base = database();
	historical(base, ['user-a']);
	migrateWorkspaceMembers(base, 'workspace-a');
	migrateWorkspaceMembers(base, 'workspace-a');
	migrateWorkspaceMembers(base, 'workspace-a');
	assert.deepEqual(meta(base).filter(row => row.key === legacyAdoptionKey), [{ key: legacyAdoptionKey, value: 'workspace-a' }]);
	assert.deepEqual(decisions(base), [{ key: legacyMemberKeyPrefix + 'user-a', value: 'workspace-a' }]);
	// Repeating the migration must not create a second membership either.
	assert.equal(rows(base).filter(row => row.workspace_id === 'workspace-a').length, 1);
});

test('a membership an operator removed is not restored by the next open', () => {
	const base = database();
	historical(base, ['user-a']);
	migrateWorkspaceMembers(base, 'workspace-a');
	assert.deepEqual(rows(base).filter(row => row.workspace_id === 'workspace-a').map(row => row.user_id), ['user-a']);

	// Revoking a member is the only way to take access away, and it works by deleting
	// the canonical row: the rollback placeholder row has to stay for the old gate.
	base.exec("DELETE FROM workspace_member WHERE workspace_id = 'workspace-a' AND user_id = 'user-a'");
	migrateWorkspaceMembers(base, 'workspace-a');

	// The placeholder row would look unclaimed again, so without the per-account ledger
	// the next open would hand the revoked user owner access back (review finding H1).
	assert.deepEqual(rows(base).filter(row => row.workspace_id === 'workspace-a'), []);
	assert.deepEqual(rows(base).filter(row => row.workspace_id === legacyWorkspace).map(row => row.user_id), ['user-a']);
});

test('a demoted membership keeps the role the operator set', () => {
	const base = database();
	historical(base, ['user-a']);
	migrateWorkspaceMembers(base, 'workspace-a');
	base.exec("UPDATE workspace_member SET role = 1 WHERE workspace_id = 'workspace-a' AND user_id = 'user-a'");
	migrateWorkspaceMembers(base, 'workspace-a');
	assert.deepEqual(rows(base).filter(row => row.workspace_id === 'workspace-a'), [
		{ tenant_id: 'default', workspace_id: 'workspace-a', user_id: 'user-a', role: workspaceRoles.viewer },
	]);
});

test('a database opened under the placeholder ID stays claimable', () => {
	const base = database();
	historical(base, ['user-a']);
	// Old packages and a bare `create-account.mjs` run with the historical default.
	migrateWorkspaceMembers(base, legacyWorkspace);
	assert.deepEqual(meta(base), []);
	migrateWorkspaceMembers(base, 'workspace-a');
	assert.deepEqual(rows(base).filter(row => row.workspace_id === 'workspace-a').map(row => row.user_id), ['user-a']);
});

test('the role column rejects values outside the documented levels', () => {
	const base = database();
	migrateWorkspaceMembers(base, storageWorkspace);
	assert.throws(
		() => base.exec(`INSERT INTO workspace_member (tenant_id, workspace_id, user_id, role) VALUES ('default', '${storageWorkspace}', 'user-a', 9)`),
		/CHECK constraint failed/,
	);
});

test('concurrent first starts of a pre-role database all succeed', async t => {
	// Two processes used to interleave the "is there a role column?" read with the
	// ALTER TABLE, so the loser of the race died on startup with
	// "duplicate column name: role" (review finding H3). Real processes are needed
	// because node:sqlite is synchronous within one thread.
	const directory = await mkdtemp(join(tmpdir(), 'l4s-race-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const file = join(directory, 'auth.sqlite');
	const seed = new DatabaseSync(file);
	seed.exec('PRAGMA journal_mode = WAL');
	seed.exec('CREATE TABLE user (id TEXT PRIMARY KEY, username TEXT) STRICT');
	seed.exec("INSERT INTO user (id, username) VALUES ('user-a', 'user-a')");
	createHistoricalTable(seed);
	seed.prepare("INSERT INTO workspace_member (tenant_id, workspace_id, user_id) VALUES ('default', 'default', 'user-a')").run();
	seed.close();

	const script = `
		import { DatabaseSync } from 'node:sqlite';
		import { migrateWorkspaceMembers } from ${JSON.stringify(new URL('./auth.mjs', import.meta.url).href)};
		const database = new DatabaseSync(process.argv[1]);
		database.exec('PRAGMA busy_timeout = 10000');
		migrateWorkspaceMembers(database, 'workspace-a');
		database.close();
	`;
	const children = Array.from({ length: 8 }, () => execFileAsync(process.execPath, ['--input-type=module', '--eval', script, file]));
	const results = await Promise.all(children);
	for (const { stderr } of results) {
		assert.equal(stderr, '');
	}

	const check = new DatabaseSync(file);
	t.after(() => check.close());
	assert.deepEqual(check.prepare('SELECT workspace_id, user_id, role FROM workspace_member ORDER BY workspace_id').all().map(row => ({ ...row })), [
		{ workspace_id: 'default', user_id: 'user-a', role: workspaceRoles.owner },
		{ workspace_id: 'workspace-a', user_id: 'user-a', role: workspaceRoles.owner },
	]);
});

async function openTestAuth(t) {
	const directory = await mkdtemp(join(tmpdir(), 'l4s-auth-'));
	await writeFile(join(directory, 'secret'), randomBytes(48).toString('hex'), { mode: 0o600 });
	const previous = { directory: process.env.LOG4STELLAR_AUTH_DIR, origin: process.env.LOG4STELLAR_WEB_ORIGIN };
	process.env.LOG4STELLAR_AUTH_DIR = directory;
	process.env.LOG4STELLAR_WEB_ORIGIN = 'https://workspace.invalid';
	const auth = await openAuth({ workspaceId: storageWorkspace });
	t.after(async () => {
		for (const [name, value] of [['LOG4STELLAR_AUTH_DIR', previous.directory], ['LOG4STELLAR_WEB_ORIGIN', previous.origin]]) {
			if (value === undefined) {
				delete process.env[name];
			} else {
				process.env[name] = value;
			}
		}
		auth.database.close();
		await rm(directory, { recursive: true, force: true });
	});
	return { directory, auth };
}

/** Inserts the minimum row better-auth requires so foreign keys stay satisfiable. */
function insertUser(auth, id) {
	const now = Date.now();
	auth.database.prepare('INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 0, ?, ?)')
		.run(id, id, id + '@log4stellar.invalid', now, now);
}

test('the login gate means membership in at least one workspace, not this workspace', async t => {
	const { auth } = await openTestAuth(t);
	// A brand new account is a member of the storage workspace, so it passes the gate.
	assert.equal(auth.canReadWorkspace('nobody'), false);
	assert.equal(auth.workspaceId, storageWorkspace);
	// A user with no rows at all cannot read any workspace.
	assert.equal(auth.resolveRole('nobody', storageWorkspace), undefined);
	assert.equal(auth.defaultWorkspaceId('nobody'), undefined);

	// Membership of a workspace the deployment does not serve still satisfies the
	// login gate, while per-request authorization stays a no-op for that workspace.
	insertUser(auth, 'user-x');
	auth.database.prepare("INSERT INTO workspace_member (tenant_id, workspace_id, user_id, role) VALUES ('default', 'other-workspace', 'user-x', 1)").run();
	assert.equal(auth.canReadWorkspace('user-x'), true);
	assert.equal(auth.resolveRole('user-x', storageWorkspace), undefined);
	assert.equal(auth.defaultWorkspaceId('user-x'), 'other-workspace');
	assert.deepEqual(auth.workspacesOf('user-x'), [{ id: 'other-workspace', role: 1 }]);
});

test('the placeholder row never grants access to a real workspace', async t => {
	const { auth } = await openTestAuth(t);
	insertUser(auth, 'user-legacy');
	// A user who only carries the rollback placeholder row is a member of nothing real.
	auth.database.prepare("INSERT INTO workspace_member (tenant_id, workspace_id, user_id, role) VALUES ('default', 'default', 'user-legacy', 3)").run();
	// The login gate agrees with the per-request decision: a session that could not
	// open a single workspace is refused at the login page instead of answering 403 to
	// every request afterwards (review finding H2).
	assert.equal(auth.canReadWorkspace('user-legacy'), false);
	assert.equal(auth.resolveRole('user-legacy', 'default'), undefined);
	assert.equal(auth.resolveRole('user-legacy', storageWorkspace), undefined);
	// The placeholder is not a real workspace, so it is not a usable default either.
	assert.equal(auth.defaultWorkspaceId('user-legacy'), undefined);
	assert.deepEqual(auth.workspacesOf('user-legacy'), []);
});

test('the runtime placeholder deployment resolves the historical rows', async t => {
	const directory = await mkdtemp(join(tmpdir(), 'l4s-auth-'));
	await writeFile(join(directory, 'secret'), randomBytes(48).toString('hex'), { mode: 0o600 });
	const previous = { directory: process.env.LOG4STELLAR_AUTH_DIR, origin: process.env.LOG4STELLAR_WEB_ORIGIN };
	process.env.LOG4STELLAR_AUTH_DIR = directory;
	process.env.LOG4STELLAR_WEB_ORIGIN = 'https://workspace.invalid';
	const auth = await openAuth({ workspaceId: legacyWorkspace });
	t.after(async () => {
		for (const [name, value] of [['LOG4STELLAR_AUTH_DIR', previous.directory], ['LOG4STELLAR_WEB_ORIGIN', previous.origin]]) {
			if (value === undefined) {
				delete process.env[name];
			} else {
				process.env[name] = value;
			}
		}
		auth.database.close();
		await rm(directory, { recursive: true, force: true });
	});
	insertUser(auth, 'user-legacy');
	auth.database.prepare("INSERT INTO workspace_member (tenant_id, workspace_id, user_id, role) VALUES ('default', 'default', 'user-legacy', 3)").run();
	// Started under the placeholder ID, the historical row *is* the served workspace,
	// so it may be used; nothing is adopted and no owner is recorded.
	assert.equal(auth.canReadWorkspace('user-legacy'), true);
	assert.equal(auth.resolveRole('user-legacy', legacyWorkspace), workspaceRoles.owner);
	assert.equal(auth.defaultWorkspaceId('user-legacy'), legacyWorkspace);
	assert.deepEqual(meta(auth.database).filter(row => row.key === legacyAdoptionKey), []);
});

test('adding a member never overwrites the role already granted', async t => {
	const { auth } = await openTestAuth(t);
	insertUser(auth, 'user-m');
	auth.addMember('user-m', workspaceRoles.editor, storageWorkspace);
	assert.equal(auth.resolveRole('user-m', storageWorkspace), workspaceRoles.editor);
	auth.addMember('user-m', workspaceRoles.viewer, storageWorkspace);
	assert.equal(auth.resolveRole('user-m', storageWorkspace), workspaceRoles.editor);
	assert.throws(() => auth.addMember('user-m', 7, storageWorkspace), /viewer/);
});

test('operator member management lists, adds, re-roles and removes members', async t => {
	const { auth } = await openTestAuth(t);
	insertUser(auth, 'user-op');
	assert.deepEqual(auth.listMembers(storageWorkspace), []);
	assert.equal(auth.removeMember('user-op', storageWorkspace), 0);
	assert.equal(auth.setMemberRole('user-op', workspaceRoles.viewer, storageWorkspace), 0);

	auth.addMember(auth.resolveMemberId('user-op'), workspaceRoles.viewer, storageWorkspace);
	assert.deepEqual(auth.listMembers(storageWorkspace), [{ userId: 'user-op', username: null, role: workspaceRoles.viewer }]);
	assert.deepEqual(auth.listWorkspaces(), [{ workspaceId: storageWorkspace, members: 1 }]);

	assert.equal(auth.setMemberRole('user-op', workspaceRoles.owner, storageWorkspace), 1);
	assert.equal(auth.resolveRole('user-op', storageWorkspace), workspaceRoles.owner);
	// The rollback placeholder row is not a workspace an operator may edit.
	assert.throws(() => auth.setMemberRole('user-op', workspaceRoles.owner, legacyWorkspace), /placeholder/);
	assert.throws(() => auth.removeMember('user-op', legacyWorkspace), /placeholder/);
	assert.throws(() => auth.listMembers(legacyWorkspace), /placeholder/);

	assert.equal(auth.removeMember('user-op', storageWorkspace), 1);
	assert.equal(auth.resolveRole('user-op', storageWorkspace), undefined);
	// Losing the last real membership also fails the login gate, so the operator sees a
	// forbidden login page instead of a workbench whose every request returns 403.
	assert.equal(auth.canReadWorkspace('user-op'), false);
});
