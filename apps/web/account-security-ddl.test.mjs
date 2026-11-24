import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { accountSchemaCurrent, ensureAccountSecuritySchema } from './account-security-ddl.mjs';

// The account-security schema is additive and lives in the authentication
// database. These tests use an in-memory database with the same `user` table
// better-auth creates, so they run offline and pin the migration contract:
// a fresh database gains the table, a migrated database performs no writes, and
// an interrupted migration leaves nothing behind.

function open() {
	const database = new DatabaseSync(':memory:');
	database.exec('PRAGMA foreign_keys = ON');
	database.exec('CREATE TABLE user (id TEXT PRIMARY KEY, username TEXT) STRICT');
	return database;
}

function objects(database) {
	return database.prepare("SELECT type, name FROM sqlite_master WHERE name LIKE 'account_%' ORDER BY name").all().map(row => row.type + ':' + row.name);
}

// Counts writes without relying on timing: `PRAGMA data_version` changes when
// another connection commits, so instead we watch the control-flow contract —
// a no-op migration must not enter a transaction at all.
function countingDatabase(database) {
	const calls = [];
	return {
		calls,
		prepare: (...args) => database.prepare(...args),
		exec: sql => {
			calls.push(sql);
			return database.exec(sql);
		},
	};
}

test('a fresh database reports no account-security schema', () => {
	const database = open();
	try {
		const state = accountSchemaCurrent(database);
		assert.equal(state.replayTable, false);
		assert.equal(state.replayIndex, false);
		assert.equal(state.labelTable, false);
		assert.equal(state.labelIndex, false);
		assert.equal(state.twoFactorTable, false);
		assert.equal(state.twoFactorEnabledColumn, false);
		assert.deepEqual(state.missing, [
			'table:account_totp_replay',
			'table:account_session_label',
			'index:account_totp_replay_updated_idx',
			'index:account_session_label_user_idx',
		]);
	} finally {
		database.close();
	}
});

test('the migration creates the replay table and its index', () => {
	const database = open();
	try {
		const result = ensureAccountSecuritySchema(database);
		assert.equal(result.changed, true);
		assert.equal(result.before.replayTable, false);
		assert.equal(result.after.replayTable, true);
		assert.equal(result.after.replayIndex, true);
		assert.deepEqual(objects(database), [
			'table:account_session_label',
			'index:account_session_label_user_idx',
			'table:account_totp_replay',
			'index:account_totp_replay_updated_idx',
		]);
		assert.deepEqual(result.applied, [
			'table:account_totp_replay',
			'table:account_session_label',
			'index:account_totp_replay_updated_idx',
			'index:account_session_label_user_idx',
		]);
	} finally {
		database.close();
	}
});

test('a migrated database is not written to again', () => {
	const database = open();
	try {
		ensureAccountSecuritySchema(database);
		const watched = countingDatabase(database);
		const second = ensureAccountSecuritySchema(watched);
		assert.equal(second.changed, false);
		assert.deepEqual(watched.calls, [], 'the steady state must issue no SQL that could take a write lock');
	} finally {
		database.close();
	}
});

test('the replay table keeps the contract shape', () => {
	const database = open();
	try {
		ensureAccountSecuritySchema(database);
		const columns = database.prepare('PRAGMA table_info(account_totp_replay)').all()
			.map(row => ({ name: row.name, type: row.type, notnull: Number(row.notnull), pk: Number(row.pk) }));
		assert.deepEqual(columns, [
			{ name: 'user_id', type: 'TEXT', notnull: 1, pk: 1 },
			{ name: 'last_used_step', type: 'INTEGER', notnull: 1, pk: 0 },
			{ name: 'updated_at', type: 'INTEGER', notnull: 1, pk: 0 },
		]);
		// STRICT rejects a floating point step, which would silently compare wrong.
		assert.throws(() => database.prepare('INSERT INTO account_totp_replay (user_id, last_used_step, updated_at) VALUES (?, ?, ?)').run('u1', 1.5, 0));
	} finally {
		database.close();
	}
});

test('the migration is safe to run twice in a row on the same handle', () => {
	const database = open();
	try {
		ensureAccountSecuritySchema(database);
		const again = ensureAccountSecuritySchema(database);
		assert.equal(again.changed, false);
		assert.equal(again.after.replayTable, true);
		assert.deepEqual(again.applied, []);
	} finally {
		database.close();
	}
});

test('a database that already has the table is adopted without DDL', () => {
	const database = open();
	try {
		database.exec('CREATE TABLE account_totp_replay (user_id TEXT PRIMARY KEY, last_used_step INTEGER NOT NULL, updated_at INTEGER NOT NULL) STRICT');
		const watched = countingDatabase(database);
		const result = ensureAccountSecuritySchema(watched);
		// The indexes and the label table are still missing, so those run; the
		// pre-existing replay table is never recreated.
		assert.equal(result.changed, true);
		const created = watched.calls.filter(sql => sql.toUpperCase().startsWith('CREATE TABLE'));
		assert.equal(created.length, 1, 'only the missing table may be created');
		assert.match(created[0], /account_session_label/);
		assert.equal(result.after.replayIndex, true);
	} finally {
		database.close();
	}
});

test('a foreign key from the replay table to user is enforced', () => {
	const database = open();
	try {
		ensureAccountSecuritySchema(database);
		assert.throws(() => database.prepare('INSERT INTO account_totp_replay (user_id, last_used_step, updated_at) VALUES (?, ?, ?)').run('missing-user', 1, 0), /FOREIGN KEY/);
	} finally {
		database.close();
	}
});

test('the probe rejects a handle that cannot query', () => {
	assert.throws(() => accountSchemaCurrent({}), TypeError);
	assert.throws(() => ensureAccountSecuritySchema(null), TypeError);
});
