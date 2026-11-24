import { accountSecuritySchema, assertAdditiveMigration } from './account-security.mjs';
import { WorkspaceError } from './workspace-contract.mjs';

// Schema for the account-security feature lives in the authentication database
// (`auth.sqlite`, driven through `node:sqlite`), not in the PostgreSQL storage
// schema: the replay cursor is keyed by a better-auth user ID and must be written
// in the same transaction as the session row that better-auth's own migrator
// owns. `workspace-schema.sql` therefore stays untouched.
//
// Two rules govern everything here, both of them learned the hard way:
//
// 1. Probe before you migrate. A previous batch ran `ALTER TABLE` on every cold
//    start; the statement still takes a write lock even when it is a no-op, and
//    the measured cost was a 2000ms stall for readers behind it. `openAuth()` is
//    on the critical path of every process start, so the steady state must be a
//    read-only probe that returns immediately.
// 2. Additive only. `assertAdditiveMigration` rejects DROP/RENAME/ALTER-DROP, and
//    the statements are wrapped in a single `BEGIN IMMEDIATE` so a concurrent
//    first start cannot interleave two `CREATE TABLE` attempts and die on a
//    duplicate object — the same failure mode that used to hit
//    `migrateWorkspaceMembers` with "duplicate column name: role".

const objectPattern = /create\s+(table|index)\s+if\s+not\s+exists\s+([a-z0-9_]+)/i;

// Turns a validated CREATE statement into "what to look for" plus "what to run".
// The schema module stays the single source of truth for the SQL itself; this
// only derives the sqlite_master name so the runner can skip a statement whose
// object already exists instead of relying on `IF NOT EXISTS` alone. Skipping is
// what keeps a partially migrated database from rewriting its neighbours.
function describeStatement(statement) {
	const sql = assertAdditiveMigration(statement);
	const match = objectPattern.exec(sql);
	if (!match) {
		throw new WorkspaceError(500, 'UnrecognizedMigrationStatement');
	}
	return Object.freeze({ type: match[1].toLowerCase(), name: match[2], sql });
}

function statementsOf() {
	return Object.freeze([...accountSecuritySchema.ownTables, ...accountSecuritySchema.ownIndexes].map(describeStatement));
}

const statements = statementsOf();

function hasObject(database, type, name) {
	const row = database.prepare('SELECT name FROM sqlite_master WHERE type = ? AND name = ?').get(type, name);
	return row !== undefined && row !== null;
}

function columnNames(database, table) {
	if (!hasObject(database, 'table', table)) {
		return new Set();
	}
	return new Set(database.prepare('PRAGMA table_info(' + table + ')').all().map(row => String(row.name)));
}

function missingObjects(database) {
	return statements.filter(statement => !hasObject(database, statement.type, statement.name));
}

// Read-only. Returns the facts the migrator needs, so callers can log or assert on
// them without ever issuing DDL. Every value is a plain boolean or a sorted array.
export function accountSchemaCurrent(database) {
	if (database === undefined || database === null || typeof database.prepare !== 'function') {
		throw new TypeError('accountSchemaCurrent requires an open database handle');
	}
	const userColumns = columnNames(database, 'user');
	const present = statements.map(statement => ({ type: statement.type, name: statement.name, present: hasObject(database, statement.type, statement.name) }));
	return Object.freeze({
		replayTable: present.find(entry => entry.name === 'account_totp_replay')?.present ?? false,
		replayIndex: present.find(entry => entry.name === 'account_totp_replay_updated_idx')?.present ?? false,
		labelTable: present.find(entry => entry.name === 'account_session_label')?.present ?? false,
		labelIndex: present.find(entry => entry.name === 'account_session_label_user_idx')?.present ?? false,
		twoFactorTable: hasObject(database, 'table', 'twoFactor'),
		twoFactorEnabledColumn: userColumns.has('twoFactorEnabled'),
		missing: Object.freeze(missingObjects(database).map(statement => statement.type + ':' + statement.name)),
	});
}

// Idempotent, additive, and cheap when there is nothing to do: a fully migrated
// database performs a handful of reads and returns `{ changed: false }` without
// taking a write lock. When something is missing the probe is repeated inside
// `BEGIN IMMEDIATE`, because the probe outside the lock can be stale.
export function ensureAccountSecuritySchema(database) {
	if (database === undefined || database === null || typeof database.exec !== 'function') {
		throw new TypeError('ensureAccountSecuritySchema requires an open database handle');
	}
	const before = accountSchemaCurrent(database);
	if (before.missing.length === 0) {
		return Object.freeze({ changed: false, before, after: before, applied: Object.freeze([]) });
	}
	const applied = [];
	database.exec('BEGIN IMMEDIATE');
	let after;
	try {
		// Re-probe under the lock: another process may have won the race between the
		// cheap check above and this transaction.
		for (const statement of missingObjects(database)) {
			database.exec(statement.sql);
			applied.push(statement.type + ':' + statement.name);
		}
		after = accountSchemaCurrent(database);
		if (after.missing.length !== 0) {
			throw new WorkspaceError(500, 'AccountSchemaIncomplete');
		}
		database.exec('COMMIT');
	} catch (error) {
		try {
			database.exec('ROLLBACK');
		} catch {
			// A rollback that fails because the transaction is already gone must not
			// mask the original error.
		}
		throw error;
	}
	return Object.freeze({ changed: applied.length > 0, before, after, applied: Object.freeze(applied) });
}
