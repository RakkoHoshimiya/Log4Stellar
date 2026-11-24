import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { legacyAdoptionKey, legacyMemberKeyPrefix, openAuth } from './auth.mjs';

const execFileAsync = promisify(execFile);
const memberCli = fileURLToPath(new URL('./workspace-members.mjs', import.meta.url));
const importCli = fileURLToPath(new URL('./import-workspace.mjs', import.meta.url));
const origin = 'https://workspace.invalid';
const storageWorkspace = 'log4stellar-main';

function insertAccount(database, id) {
	const now = Date.now();
	database.prepare('INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 0, ?, ?)')
		.run(id, id, `${id}@log4stellar.invalid`, now, now);
}

function rows(directory) {
	const database = new DatabaseSync(join(directory, 'auth.sqlite'));
	try {
		// `SELECT *` because a command that never opened the database leaves the file in
		// the legacy shape, which has no `role` column at all.
		return database.prepare('SELECT * FROM workspace_member ORDER BY workspace_id, user_id')
			.all().map(row => {
				const copy = { ...row };
				if (!Object.hasOwn(copy, 'role')) {
					// The legacy table has no role; report it as absent instead of guessing.
					copy.role = null;
				}
				return copy;
			});
	} finally {
		database.close();
	}
}

function meta(directory) {
	const database = new DatabaseSync(join(directory, 'auth.sqlite'));
	try {
		const exists = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workspace_meta'").get();
		if (!exists) {
			return undefined;
		}
		return database.prepare('SELECT key, value FROM workspace_meta ORDER BY key').all().map(row => ({ ...row }));
	} finally {
		database.close();
	}
}

/** Whether the previous release would let this account into the workbench. */
function rollbackGate(directory, userId) {
	const database = new DatabaseSync(join(directory, 'auth.sqlite'));
	try {
		const row = database.prepare(`SELECT 1 AS granted FROM workspace_member
			WHERE tenant_id = 'default' AND workspace_id = 'default' AND user_id = ?`).get(userId);
		return row !== undefined;
	} finally {
		database.close();
	}
}

/**
 * A database in the shape the previous release left behind: no `workspace_meta`
 * table, no `role` column, and one placeholder row per account (contract §7).
 */
async function openLegacyFixture(t, handles) {
	const directory = await mkdtemp(join(tmpdir(), 'l4s-members-'));
	const saved = {
		auth: process.env.LOG4STELLAR_AUTH_DIR,
		origin: process.env.LOG4STELLAR_WEB_ORIGIN,
		storage: process.env.LOG4STELLAR_STORAGE_CONFIG,
		workspace: process.env.LOG4STELLAR_WORKSPACE_ID,
	};
	process.env.LOG4STELLAR_AUTH_DIR = directory;
	process.env.LOG4STELLAR_WEB_ORIGIN = origin;
	// The member command must work for the local backend too, which has no storage
	// registry and no LOG4STELLAR_STORAGE_CONFIG.
	delete process.env.LOG4STELLAR_STORAGE_CONFIG;
	delete process.env.LOG4STELLAR_WORKSPACE_ID;
	await writeFile(join(directory, 'secret'), randomBytes(48).toString('hex'), { mode: 0o600 });
	t.after(async () => {
		for (const [key, value] of [
			['LOG4STELLAR_AUTH_DIR', saved.auth],
			['LOG4STELLAR_WEB_ORIGIN', saved.origin],
			['LOG4STELLAR_STORAGE_CONFIG', saved.storage],
			['LOG4STELLAR_WORKSPACE_ID', saved.workspace],
		]) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
		await rm(directory, { recursive: true, force: true });
	});

	const account = await openAuth({ workspaceId: storageWorkspace });
	try {
		for (const handle of handles) {
			insertAccount(account.database, handle);
			account.database.prepare('INSERT INTO workspace_member (tenant_id, workspace_id, user_id, role) VALUES (?, ?, ?, ?)')
				.run('default', 'default', handle, 3);
		}
	} finally {
		account.database.close();
	}
	const database = new DatabaseSync(join(directory, 'auth.sqlite'));
	try {
		database.exec('DROP TABLE workspace_meta');
		database.exec("DELETE FROM workspace_member WHERE workspace_id <> 'default'");
		database.exec('ALTER TABLE workspace_member DROP COLUMN role');
	} finally {
		database.close();
	}
	return directory;
}

/** Creates an account without any membership row, the way `create-account.mjs` would. */
async function addAccount(directory, handle) {
	// Written with `node:sqlite` directly: opening the file through `openAuth()` would
	// re-run the migration and turn the legacy fixture into a current one.
	const database = new DatabaseSync(join(directory, 'auth.sqlite'));
	try {
		insertAccount(database, handle);
	} finally {
		database.close();
	}
}

/** Runs an operator CLI exactly as an operator would. */
async function run(file, args, directory) {
	const env = { ...process.env, LOG4STELLAR_AUTH_DIR: directory, LOG4STELLAR_WEB_ORIGIN: origin };
	delete env.LOG4STELLAR_STORAGE_CONFIG;
	delete env.LOG4STELLAR_WORKSPACE_ID;
	try {
		const { stdout, stderr } = await execFileAsync(process.execPath, [file, ...args], { env });
		return { code: 0, stdout, stderr };
	} catch (error) {
		return { code: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
	}
}

test('the member command refuses to treat the rollback placeholder as a workspace', async t => {
	const directory = await openLegacyFixture(t, ['alice']);
	const before = rows(directory);

	for (const args of [['list', '--workspace', 'default'], ['remove', 'alice', '--workspace', 'default']]) {
		const { code, stdout, stderr } = await run(memberCli, args, directory);
		assert.equal(code, 1, `${args.join(' ')} must fail`);
		assert.equal(stdout, '', 'the command must print nothing before it refuses');
		assert.match(stderr, /placeholder row default is never edited as a workspace/);
	}

	// The rejection happens before the database is opened, so even the schema upgrade
	// of `openAuth()` did not run: nothing about the rollback row changed.
	assert.deepEqual(rows(directory), before);
	assert.equal(meta(directory), undefined, 'no workspace_meta table may appear on a refused command');
	assert.equal(rollbackGate(directory, 'alice'), true);
});

test('member management never edits the rollback placeholder row', async t => {
	const directory = await openLegacyFixture(t, ['alice']);

	// Revoking the member is a write, so it adopts the historical rows first and then
	// deletes the canonical copy. The placeholder row must survive: it is what keeps
	// `alice` able to sign in after a rollback to the previous release.
	const removed = await run(memberCli, ['remove', 'alice'], directory);
	assert.equal(removed.code, 0, removed.stderr);
	assert.match(removed.stdout, /Removed alice from log4stellar-main\./);
	assert.equal(rollbackGate(directory, 'alice'), true, 'the rollback row must survive a revocation');
	assert.deepEqual(rows(directory), [{ tenant_id: 'default', workspace_id: 'default', user_id: 'alice', role: 3 }]);

	const account = await openAuth({ workspaceId: storageWorkspace, adopt: false });
	try {
		for (const action of [
			() => account.listMembers('default'),
			() => account.setMemberRole('alice', 1, 'default'),
			() => account.removeMember('alice', 'default'),
			() => account.addMember('alice', 1, 'default'),
		]) {
			assert.throws(action, /The rollback placeholder row must never be edited as a workspace\./);
		}
		assert.equal(account.canReadWorkspace('alice'), false);
		assert.equal(account.resolveRole('alice', storageWorkspace), undefined);
		// The revocation stays revoked despite the placeholder row still being there.
		assert.equal(account.resolveRole('alice', 'default'), undefined);
	} finally {
		account.database.close();
	}
	assert.deepEqual(rows(directory), [{ tenant_id: 'default', workspace_id: 'default', user_id: 'alice', role: 3 }]);
});

test('adding a member never forges the rollback placeholder row', async t => {
	const directory = await openLegacyFixture(t, ['alice']);
	await addAccount(directory, 'dave');

	const added = await run(memberCli, ['add', 'dave', '--role', 'viewer'], directory);
	assert.equal(added.code, 0, added.stderr);
	assert.match(added.stdout, /Added dave to log4stellar-main as viewer\./);
	assert.equal(rows(directory).some(row => row.workspace_id === 'default' && row.user_id === 'dave'), false);
	assert.equal(rollbackGate(directory, 'dave'), false);
	assert.equal(rows(directory).find(row => row.workspace_id === storageWorkspace && row.user_id === 'dave')?.role, 1);

	const account = await openAuth({ workspaceId: storageWorkspace, adopt: false });
	try {
		assert.throws(() => account.addMember('dave', 1, 'default'), /The rollback placeholder row must never be edited as a workspace\./);
	} finally {
		account.database.close();
	}
	assert.equal(rollbackGate(directory, 'dave'), false);
});

test('reading members never adopts the historical database', async t => {
	const directory = await openLegacyFixture(t, ['alice']);

	for (const args of [['workspaces'], ['list'], ['list', '--workspace', 'example-workspace']]) {
		const result = await run(memberCli, args, directory);
		assert.equal(result.code, 0, result.stderr);
		assert.deepEqual(rows(directory), [{ tenant_id: 'default', workspace_id: 'default', user_id: 'alice', role: 3 }],
			`${args.join(' ')} must not copy the placeholder row`);
		assert.deepEqual(meta(directory), [], `${args.join(' ')} must not record an adoption decision`);
	}

	// The binding is still available to the deployment that owns the database: a read
	// only reports, it never spends the one-time decision on a workspace chosen by
	// whoever happened to run the command.
	const owner = await openAuth({ workspaceId: 'example-workspace' });
	try {
		assert.equal(owner.resolveRole('alice', 'example-workspace'), 3);
	} finally {
		owner.database.close();
	}
	assert.deepEqual(meta(directory), [
		{ key: legacyMemberKeyPrefix + 'alice', value: 'example-workspace' },
		{ key: legacyAdoptionKey, value: 'example-workspace' },
	]);
});

test('writing members is the explicit act that adopts the historical database', async t => {
	const directory = await openLegacyFixture(t, ['alice']);
	await addAccount(directory, 'dave');

	const added = await run(memberCli, ['add', 'dave', '--role', 'viewer'], directory);
	assert.equal(added.code, 0, added.stderr);
	const account = await openAuth({ workspaceId: storageWorkspace, adopt: false });
	try {
		assert.equal(account.resolveRole('alice', storageWorkspace), 3, 'the historical owner must be adopted');
	} finally {
		account.database.close();
	}
	assert.deepEqual(meta(directory), [
		{ key: legacyMemberKeyPrefix + 'alice', value: storageWorkspace },
		{ key: legacyMemberKeyPrefix + 'dave', value: storageWorkspace },
		{ key: legacyAdoptionKey, value: storageWorkspace },
	]);
});

test('the adoption decision belongs to the deployment workspace, not to the target', async t => {
	const directory = await openLegacyFixture(t, ['alice']);
	await addAccount(directory, 'dave');

	// `--workspace` names the workspace whose member list is edited. It must not be
	// handed to `openAuth()`: that would make the database's one-time adoption belong
	// to whichever workspace this particular command happened to name.
	const added = await run(memberCli, ['add', 'dave', '--workspace', 'example-workspace'], directory);
	assert.equal(added.code, 0, added.stderr);
	assert.match(added.stdout, /Added dave to example-workspace as viewer\./);
	// The ledger records what the write decided (dave now belongs to
	// `example-workspace`), while the one-time adoption of the historical rows stays
	// with the workspace this deployment serves.
	assert.deepEqual(meta(directory), [
		{ key: legacyMemberKeyPrefix + 'alice', value: storageWorkspace },
		{ key: legacyMemberKeyPrefix + 'dave', value: 'example-workspace' },
		{ key: legacyAdoptionKey, value: storageWorkspace },
	], 'the historical rows are adopted by the deployment workspace, not by example-workspace');
	// `alice` came from the historical database and is adopted by the deployment
	// workspace; `dave` is a new account with no placeholder row, so the only thing he
	// gets is the membership the command was actually asked to write.
	assert.deepEqual(rows(directory), [
		{ tenant_id: 'default', workspace_id: 'default', user_id: 'alice', role: 3 },
		{ tenant_id: 'default', workspace_id: 'example-workspace', user_id: 'dave', role: 1 },
		{ tenant_id: 'default', workspace_id: storageWorkspace, user_id: 'alice', role: 3 },
	]);
});

test('the importer accepts a trailing --owner and rejects a malformed one', async t => {
	const directory = await mkdtemp(join(tmpdir(), 'l4s-import-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	await writeFile(join(directory, 'note.md'), '# note\n');

	// Past argv parsing the importer needs a storage backend, so the arguments are
	// correct exactly when it fails for a reason other than the usage message.
	const accepted = await run(importCli, [directory, 'example-workspace', '--owner', 'example_user'], directory);
	assert.equal(accepted.code, 1);
	assert.doesNotMatch(accepted.stderr, /Usage: node apps\/web\/import-workspace\.mjs/);

	for (const args of [
		[directory, 'example-workspace', '--owner'],
		[directory, 'example-workspace', '--owner', 'example_user', 'extra'],
		[directory, 'example-workspace', '--owner', 'example_user', '--owner', 'second_user'],
	]) {
		const result = await run(importCli, args, directory);
		assert.equal(result.code, 1);
		assert.match(result.stderr, /Usage: node apps\/web\/import-workspace\.mjs/, args.join(' '));
	}
});
