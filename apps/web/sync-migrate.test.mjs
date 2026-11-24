// The schema probe is a pure comparison over a catalog reading, and the decision it drives
// ("migrate", or "refuse to start") is the difference between a service that self-heals and one
// that serves a half-migrated schema forever. Both halves are tested here without a database:
// the comparison against literal catalogs, and the decision against a tiny fake pool.
//
// The end-to-end half — that the catalogs really report what this test assumes — lives in
// sync-integration.test.mjs, which mutates a real PostgreSQL catalog inside a rolled-back
// transaction.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	compareStorageSchema,
	ensureStorageSchema,
	syncSchemaExpectations,
	syncSchemaTables,
} from './sync-migrate.mjs';

/**
 * A catalog reading for a database that exactly matches sync-schema.sql, derived from the
 * expectation table. `sync-schema.test.mjs` independently proves that table matches the SQL
 * file, so deriving the fixture from it cannot quietly bless a wrong expectation.
 */
function healthyCatalog() {
	const columns = [];
	for (const [table, declared] of Object.entries(syncSchemaExpectations.columns)) {
		for (const column of declared) {
			columns.push({
				table,
				name: column.name,
				type: column.type,
				nullable: column.nullable ? 'YES' : 'NO',
				default: column.default,
			});
		}
	}
	const indexes = syncSchemaExpectations.indexes.map(index => ({
		table: index.table,
		name: index.name,
		definition: `CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX ${index.name} `
			+ `ON log4stellar.${index.table} USING btree (${index.columns.join(', ')})`,
	}));
	const constraints = [];
	for (const expected of syncSchemaExpectations.constraints) {
		constraints.push({ table: expected.table, name: `${expected.table}_${expected.type}`, type: expected.type, definition: expected.definition });
	}
	for (const expected of syncSchemaExpectations.checks) {
		const definition = expected.literals
			? `CHECK ((${expected.column} = ANY (ARRAY[${expected.literals.join(', ')}])))`
			: `CHECK ((${expected.column} >= 0))`;
		constraints.push({
			table: expected.table,
			name: `${expected.table}_${expected.column}_check`,
			type: 'c',
			definition,
		});
	}
	return { tables: [...syncSchemaTables], columns, indexes, constraints };
}

/** Applies `mutate` to a fresh healthy catalog and returns the probe's verdict. */
function verdict(mutate) {
	const catalog = healthyCatalog();
	mutate(catalog);
	return compareStorageSchema(catalog);
}

function messages(result) {
	return result.problems.map(problem => problem.message).join('\n');
}

test('a catalog that matches sync-schema.sql is current', () => {
	const result = compareStorageSchema(healthyCatalog());
	assert.deepEqual(result.problems, []);
	assert.equal(result.current, true);
});

test('a missing table is repairable, and reported once rather than once per column', () => {
	const result = verdict(catalog => {
		catalog.tables = catalog.tables.filter(table => table !== 'storage_snapshots');
	});
	assert.equal(result.current, false);
	assert.equal(result.problems.length, 1, messages(result));
	assert.equal(result.problems[0].repairable, true);
	assert.match(result.problems[0].message, /log4stellar\.storage_snapshots is missing/);
});

test('a legacy catalog with no sync tables can be migrated', () => {
	const result = compareStorageSchema({ tables: [], columns: [], indexes: [], constraints: [] });
	assert.equal(result.current, false);
	assert.deepEqual(result.problems.map(({ table, object, repairable }) => [table, object, repairable]),
		syncSchemaTables.map(table => [table, table, true]));
});

test('the most damaging deviation of all — the dropped idempotency index — is caught', () => {
	// With this index gone, sync-schema.sql cannot re-create it (the duplicate rows a retry race
	// left behind make CREATE UNIQUE INDEX fail with 23505), so a probe that missed it turned
	// "§5.1: one row per key" into a documented promise the database no longer keeps.
	const result = verdict(catalog => {
		catalog.indexes = catalog.indexes.filter(index => index.name !== 'storage_changes_idempotency_idx');
	});
	assert.equal(result.current, false);
	assert.equal(result.problems[0].repairable, true);
	assert.match(messages(result), /storage_changes_idempotency_idx is missing/);
});

test('an index that exists but lost UNIQUE is not repairable', () => {
	const result = verdict(catalog => {
		const index = catalog.indexes.find(candidate => candidate.name === 'storage_changes_idempotency_idx');
		index.definition = index.definition.replace('CREATE UNIQUE INDEX', 'CREATE INDEX');
	});
	assert.equal(result.current, false);
	assert.equal(result.problems[0].repairable, false);
	assert.match(messages(result), /is not UNIQUE/);
});

test('an index rebuilt over the wrong columns is caught', () => {
	const result = verdict(catalog => {
		const index = catalog.indexes.find(candidate => candidate.name === 'storage_changes_path_idx');
		index.definition = 'CREATE INDEX storage_changes_path_idx ON log4stellar.storage_changes USING btree (workspace_id, created_ms)';
	});
	assert.equal(result.current, false);
	assert.match(messages(result), /storage_changes_path_idx covers/);
});

test('every deviation the adversarial review produced is reported as not current', () => {
	// One row per measured false positive: dropping or altering the object and asserting the
	// probe notices. This is the regression table for the entire class of bug.
	const deviations = [
		['seq: bigint -> text', catalog => {
			catalog.columns.find(column => column.table === 'storage_change_heads' && column.name === 'seq').type = 'text';
		}, /storage_change_heads\.seq has type text, expected bigint/, false],
		['retained_floor: default 1 -> 0', catalog => {
			catalog.columns.find(column => column.table === 'storage_change_heads' && column.name === 'retained_floor').default = '0';
		}, /retained_floor has default 0, expected 1/, false],
		['heads.seq: default 0 -> 1', catalog => {
			catalog.columns.find(column => column.table === 'storage_change_heads' && column.name === 'seq').default = '1';
		}, /storage_change_heads\.seq has default 1, expected 0/, false],
		['retained_floor: NOT NULL -> nullable', catalog => {
			catalog.columns.find(column => column.table === 'storage_change_heads' && column.name === 'retained_floor').nullable = 'YES';
		}, /retained_floor is nullable, expected NOT NULL/, false],
		['op_id: uuid -> text', catalog => {
			catalog.columns.find(column => column.table === 'storage_changes' && column.name === 'op_id').type = 'text';
		}, /storage_changes\.op_id has type text, expected uuid/, false],
		['all five indexes dropped', catalog => {
			catalog.indexes = [];
		}, /storage_changes_idempotency_idx is missing/, true],
		['storage_snapshots.entry_count dropped', catalog => {
			catalog.columns = catalog.columns.filter(column => !(column.table === 'storage_snapshots' && column.name === 'entry_count'));
		}, /storage_snapshots\.entry_count is missing/, true],
		['snapshot_entries primary key dropped', catalog => {
			catalog.constraints = catalog.constraints.filter(constraint => constraint.definition !== 'PRIMARY KEY (snapshot_id, path)');
		}, /PRIMARY KEY \(snapshot_id, path\)/, false],
		['storage_changes.device_id dropped', catalog => {
			catalog.columns = catalog.columns.filter(column => !(column.table === 'storage_changes' && column.name === 'device_id'));
		}, /storage_changes\.device_id is missing/, true],
		['storage_changes.change_id dropped', catalog => {
			catalog.columns = catalog.columns.filter(column => !(column.table === 'storage_changes' && column.name === 'change_id'));
		}, /storage_changes\.change_id is missing/, true],
		['storage_snapshot_entries.kind dropped', catalog => {
			catalog.columns = catalog.columns.filter(column => !(column.table === 'storage_snapshot_entries' && column.name === 'kind'));
		}, /storage_snapshot_entries\.kind is missing/, true],
		['storage_snapshots.expires_ms dropped', catalog => {
			catalog.columns = catalog.columns.filter(column => !(column.table === 'storage_snapshots' && column.name === 'expires_ms'));
		}, /storage_snapshots\.expires_ms is missing/, true],
		['the kind CHECK dropped', catalog => {
			catalog.constraints = catalog.constraints.filter(constraint =>
				!(constraint.table === 'storage_changes' && constraint.type === 'c' && /file\.created/.test(constraint.definition)));
		}, /CHECK constraint on log4stellar\.storage_changes\.kind/, false],
		['the UNIQUE (workspace_id, change_id) constraint dropped', catalog => {
			catalog.constraints = catalog.constraints.filter(constraint => constraint.definition !== 'UNIQUE (workspace_id, change_id)');
		}, /UNIQUE \(workspace_id, change_id\)/, false],
	];

	for (const [label, mutate, pattern, repairable] of deviations) {
		const result = verdict(mutate);
		assert.equal(result.current, false, `${label} must not read as "current"`);
		assert.ok(result.problems.length > 0, `${label} produced no problem`);
		assert.match(messages(result), pattern, `${label}: ${messages(result)}`);
		assert.equal(
			result.problems.some(problem => problem.repairable === repairable),
			true,
			`${label} should be reported as ${repairable ? 'repairable' : 'not repairable'}: ${messages(result)}`,
		);
	}
});

test('a catalog that could not be read is never "current"', () => {
	// A failed probe must fail closed: reporting "current" on no reading would skip the
	// migration and then serve 42703s from a schema nobody checked.
	assert.equal(compareStorageSchema(undefined).current, false);
	assert.equal(compareStorageSchema({}).current, false);
});

/**
 * Fake pool for the decision test. `catalogs` are returned in order, one per probe; the
 * migration itself only has to run without throwing.
 */
function fakePool(catalogs) {
	let probes = 0;
	const statements = [];
	const pool = {
		statements,
		async query() {
			const catalog = catalogs[Math.min(probes, catalogs.length - 1)];
			probes++;
			return { rows: [catalog] };
		},
		async connect() {
			return {
				async query(sql) {
					statements.push(String(sql).trim().split('\n')[0]);
					return { rows: [] };
				},
				release() {},
			};
		},
	};
	return pool;
}

test('ensureStorageSchema does nothing when the schema is current', async () => {
	const pool = fakePool([healthyCatalog()]);
	const result = await ensureStorageSchema(pool);
	assert.deepEqual(result, { migrated: false, problems: [] });
	assert.deepEqual(pool.statements, [], 'a current schema must not run any DDL');
});

test('ensureStorageSchema repairs a missing object and re-verifies it', async () => {
	const stale = healthyCatalog();
	stale.tables = stale.tables.filter(table => table !== 'storage_snapshots');
	const pool = fakePool([stale, healthyCatalog()]);
	const result = await ensureStorageSchema(pool);
	assert.equal(result.migrated, true);
	assert.ok(pool.statements.includes('BEGIN'), 'the repair path must run the migration');
});

test('ensureStorageSchema refuses to start when the migration cannot repair the deviation', async () => {
	// The whole point of the hardening: a wrong type is invisible to CREATE TABLE IF NOT EXISTS,
	// so "run the migration and hope" leaves it in place forever. It has to be a hard failure
	// that names the table and column, not a silent skip.
	const stale = healthyCatalog();
	stale.columns.find(column => column.table === 'storage_change_heads' && column.name === 'seq').type = 'text';
	const pool = fakePool([stale, healthyCatalog()]);
	await assert.rejects(
		() => ensureStorageSchema(pool),
		error => {
			assert.match(error.message, /cannot repair/);
			assert.match(error.message, /storage_change_heads\.seq has type text, expected bigint/);
			return true;
		},
	);
	assert.deepEqual(pool.statements, [], 'refusing must not run a migration that cannot help');
});

test('ensureStorageSchema refuses to start when the migration ran and the schema is still wrong', async () => {
	// The repairable-then-still-broken case: the migration completed but the catalog did not
	// change (a concurrent rollback, a permission problem, a lock timeout swallowed by DDL).
	const stale = healthyCatalog();
	stale.indexes = stale.indexes.filter(index => index.name !== 'storage_changes_idempotency_idx');
	const pool = fakePool([stale, stale]);
	await assert.rejects(
		() => ensureStorageSchema(pool),
		error => {
			assert.match(error.message, /migration ran but the schema is still not/);
			assert.match(error.message, /storage_changes_idempotency_idx is missing/);
			return true;
		},
	);
	assert.ok(pool.statements.includes('BEGIN'), 'the repair must have been attempted before re-verifying');
});
