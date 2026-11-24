// The storage probe is the only thing standing between a half-migrated database and the sync
// API. It used to check five things, so twelve-plus realistic breakages — a dropped unique index,
// a bigint turned into text, a default changed under it — read as "current" and the migration was
// skipped forever. This suite is the tripwire for that class of bug: it parses sync-schema.sql
// itself and fails when the probe's table-driven expectation does not cover every declared
// column, index and constraint. Adding DDL to the schema file without teaching the probe about it
// now breaks a test instead of silently disabling a check.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { syncSchemaExpectations, syncSchemaTables } from './sync-migrate.mjs';

const schemaSql = await readFile(new URL('./sync-schema.sql', import.meta.url), 'utf8');

/** Removes `-- ` comments without disturbing string literals such as `'file.created'`. */
function stripComments(sql) {
	return sql.split('\n').map(line => {
		let quote = false;
		for (let index = 0; index < line.length; index++) {
			if (line[index] === "'") {
				quote = !quote;
			} else if (!quote && line.startsWith('--', index)) {
				return line.slice(0, index);
			}
		}
		return line;
	}).join('\n');
}

/** Splits on a separator that is not inside parentheses, brackets or quotes. */
function splitTopLevel(text, separator = ',') {
	const parts = [];
	let depth = 0;
	let quote = false;
	let current = '';
	for (const character of text) {
		if (character === "'") {
			quote = !quote;
		} else if (!quote && character === '(') {
			depth++;
		} else if (!quote && character === ')') {
			depth--;
		}
		if (!quote && depth === 0 && character === separator) {
			parts.push(current);
			current = '';
			continue;
		}
		current += character;
	}
	parts.push(current);
	return parts.map(part => part.trim()).filter(Boolean);
}

/** `{ name, body }` for every `CREATE TABLE IF NOT EXISTS log4stellar.<name> ( <body> )`. */
function parseSchemaTables(sql) {
	const tables = [];
	const pattern = /CREATE TABLE IF NOT EXISTS\s+log4stellar\.(\w+)\s*\(([\s\S]*?)\n\);/g;
	for (const match of sql.matchAll(pattern)) {
		tables.push({ name: match[1], body: match[2] });
	}
	return tables;
}

/** Column items of a CREATE TABLE body, with the raw text of any inline constraint. */
function parseColumns(body) {
	const columns = [];
	for (const item of splitTopLevel(body)) {
		const first = item.split(/\s+/)[0].toLowerCase();
		if (['primary', 'unique', 'constraint', 'foreign', 'check', 'exclude'].includes(first)) {
			continue;
		}
		const name = item.split(/\s+/)[0];
		const rest = item.slice(name.length).trim();
		const type = rest.split(/\s+/)[0];
		columns.push({ name, type, text: rest });
	}
	return columns;
}

const schemaTables = parseSchemaTables(stripComments(schemaSql));

test('the schema parser sees the tables sync-schema.sql declares', () => {
	// A parser that silently matches nothing would make every assertion below vacuous.
	assert.deepEqual(schemaTables.map(table => table.name).sort(), [...syncSchemaTables].sort());
});

test('every table in sync-schema.sql is probed', () => {
	for (const table of schemaTables) {
		assert.ok(
			syncSchemaTables.includes(table.name),
			`sync-schema.sql creates ${table.name} but syncSchemaTables does not probe it`,
		);
		assert.ok(
			syncSchemaExpectations.columns[table.name],
			`sync-schema.sql creates ${table.name} but the probe has no column expectations for it`,
		);
	}
});

test('every column declared in a CREATE TABLE is probed with its declared type', () => {
	const covered = [];
	for (const table of schemaTables) {
		const declared = parseColumns(table.body);
		assert.ok(declared.length > 0, `parsed no columns out of ${table.name}; the parser is broken`);
		for (const column of declared) {
			const expected = syncSchemaExpectations.columns[table.name]
				.find(candidate => candidate.name === column.name);
			assert.ok(
				expected,
				`${table.name}.${column.name} is declared in sync-schema.sql but not probed; a dropped `
				+ 'column would still read as "schema current"',
			);
			assert.equal(
				expected.type,
				column.type,
				`${table.name}.${column.name}: sync-schema.sql declares ${column.type} but the probe expects ${expected.type}`,
			);
			// NOT NULL is what makes a missing value fail loudly at write time; a relaxed
			// constraint cannot be re-tightened by CREATE TABLE IF NOT EXISTS. An inline
			// PRIMARY KEY implies NOT NULL without spelling it out.
			const nullable = !/\bNOT NULL\b/i.test(column.text) && !/\bPRIMARY KEY\b/i.test(column.text);
			assert.equal(
				expected.nullable,
				nullable,
				`${table.name}.${column.name}: nullability drifted from sync-schema.sql`,
			);
			covered.push(`${table.name}.${column.name}`);
		}
	}
	assert.ok(covered.length >= 33, `expected to cover the whole schema, covered only ${covered.length} columns`);
});

test('the two ALTER TABLE ADD COLUMN statements are probed as columns', () => {
	const added = [...stripComments(schemaSql).matchAll(
		/ALTER TABLE\s+log4stellar\.(\w+)\s+ADD COLUMN IF NOT EXISTS\s+(\w+)\s+(\w+)/g,
	)].map(match => ({ table: match[1], name: match[2], type: match[3] }));
	assert.equal(added.length, 2, 'sync-schema.sql should add exactly op_id and base_revision');

	for (const column of added) {
		const expected = syncSchemaExpectations.columns[column.table]
			.find(candidate => candidate.name === column.name);
		assert.ok(expected, `${column.table}.${column.name} is added by ALTER TABLE but not probed`);
		assert.equal(expected.type, column.type, `${column.table}.${column.name} type drifted from the DDL`);
	}
});

test('the probe does not expect columns that sync-schema.sql never declares', () => {
	// The reverse direction: an expectation for a column nobody creates makes the probe report
	// every healthy database as stale, which is its own outage.
	const declared = new Map(schemaTables.map(table => [
		table.name,
		new Set(parseColumns(table.body).map(column => column.name)),
	]));
	// The two additive ALTER TABLE statements extend storage_changes as well.
	for (const match of stripComments(schemaSql).matchAll(
		/ALTER TABLE\s+log4stellar\.(\w+)\s+ADD COLUMN IF NOT EXISTS\s+(\w+)/g,
	)) {
		declared.get(match[1])?.add(match[2]);
	}
	for (const [table, columns] of Object.entries(syncSchemaExpectations.columns)) {
		assert.ok(declared.has(table), `the probe has column expectations for undeclared table ${table}`);
		for (const column of columns) {
			assert.ok(
				declared.get(table).has(column.name),
				`the probe expects ${table}.${column.name}, but sync-schema.sql never declares it`,
			);
		}
	}
});

test('every index in sync-schema.sql is probed, including its uniqueness', () => {
	const indexes = [...stripComments(schemaSql).matchAll(
		/CREATE\s+(UNIQUE\s+)?INDEX IF NOT EXISTS\s+(\w+)\s+ON\s+log4stellar\.(\w+)\s*\(([^)]*)\)/g,
	)].map(match => ({
		name: match[2],
		table: match[3],
		unique: Boolean(match[1]),
		columns: match[4].split(',').map(part => part.trim().split(/\s+/)[0]).filter(Boolean),
	}));
	assert.equal(indexes.length, 5, 'sync-schema.sql should declare five indexes');

	for (const index of indexes) {
		const expected = syncSchemaExpectations.indexes.find(candidate => candidate.name === index.name);
		assert.ok(expected, `index ${index.name} is declared but not probed`);
		assert.equal(expected.table, index.table, `${index.name}: probed under the wrong table`);
		assert.equal(expected.unique, index.unique, `${index.name}: uniqueness drifted from the DDL`);
		assert.deepEqual(expected.columns, index.columns, `${index.name}: probed columns drifted from the DDL`);
	}
});

test('the idempotency index is probed as UNIQUE and partial', () => {
	// This one index is the entire §5.1 guarantee ("one row per idempotency key"). Without the
	// UNIQUE, a retry racing its original inserts a second row and the replay lookup answers
	// with two different results. It is the highest-consequence object the probe checks.
	const expected = syncSchemaExpectations.indexes.find(index => index.name === 'storage_changes_idempotency_idx');
	assert.ok(expected, 'the idempotency index must be probed');
	assert.equal(expected.unique, true);
	assert.deepEqual(expected.columns, ['workspace_id', 'idempotency_key']);
	assert.match(stripComments(schemaSql), /storage_changes_idempotency_idx[\s\S]*?WHERE idempotency_key IS NOT NULL/);
});

test('every inline CHECK constraint in sync-schema.sql is probed', () => {
	const checks = [];
	for (const table of schemaTables) {
		for (const column of parseColumns(table.body)) {
			if (/\bCHECK\b/i.test(column.text)) {
				checks.push({ table: table.name, column: column.name });
			}
		}
	}
	assert.ok(checks.length >= 13, `expected at least 13 inline CHECKs, found ${checks.length}`);

	for (const check of checks) {
		const expected = syncSchemaExpectations.checks.find(candidate =>
			candidate.table === check.table && candidate.column === check.column);
		assert.ok(
			expected,
			`${check.table}.${check.column} has a CHECK in sync-schema.sql but the probe does not verify it`,
		);
	}
});

test('the enumerated kind columns probe their literal value domain', () => {
	// A CHECK on `kind` that lost its literals would still be "a CHECK mentioning kind", so the
	// expectation records which literals must survive.
	const kindChecks = syncSchemaExpectations.checks.filter(check => check.column === 'kind');
	assert.equal(kindChecks.length, 2, 'both kind columns are enumerated');
	for (const check of kindChecks) {
		assert.ok(check.literals?.length, `${check.table}.kind must pin its literals`);
	}
	const changeKinds = syncSchemaExpectations.checks
		.find(check => check.table === 'storage_changes' && check.column === 'kind').literals;
	assert.deepEqual(changeKinds, ["'file.created'", "'file.conflicted'"]);
});

test('the primary keys and the unique change_id constraint are probed', () => {
	const definitions = syncSchemaExpectations.constraints.map(constraint => constraint.definition);
	for (const definition of [
		'PRIMARY KEY (workspace_id)',
		'PRIMARY KEY (workspace_id, seq)',
		'UNIQUE (workspace_id, change_id)',
		'PRIMARY KEY (id)',
		'PRIMARY KEY (snapshot_id, path)',
	]) {
		assert.ok(definitions.includes(definition), `the probe does not verify ${definition}`);
	}

	// ... and the DDL really declares them, so the expectation is not fictional.
	const sql = stripComments(schemaSql);
	assert.match(sql, /PRIMARY KEY \(workspace_id, seq\)/);
	assert.match(sql, /UNIQUE \(workspace_id, change_id\)/);
	assert.match(sql, /PRIMARY KEY \(snapshot_id, path\)/);
});

test('the operators of a half-migration are all covered by the probe', () => {
	// Every deviation the adversarial review produced, mapped to the expectation that catches it.
	// A regression that drops one of these lines turns the corresponding probe back into a
	// false positive, so this list is asserted rather than assumed.
	const guards = [
		['seq type', () => syncSchemaExpectations.columns.storage_change_heads.some(c => c.name === 'seq' && c.type === 'bigint')],
		['retained_floor default', () => syncSchemaExpectations.columns.storage_change_heads.some(c => c.name === 'retained_floor' && c.default === '1')],
		['heads seq default', () => syncSchemaExpectations.columns.storage_change_heads.some(c => c.name === 'seq' && c.default === '0')],
		['retained_floor not null', () => syncSchemaExpectations.columns.storage_change_heads.some(c => c.name === 'retained_floor' && c.nullable === false)],
		['op_id type', () => syncSchemaExpectations.columns.storage_changes.some(c => c.name === 'op_id' && c.type === 'uuid')],
		['idempotency index', () => syncSchemaExpectations.indexes.some(i => i.name === 'storage_changes_idempotency_idx')],
		['all five indexes', () => syncSchemaExpectations.indexes.length === 5],
		['snapshots.entry_count', () => syncSchemaExpectations.columns.storage_snapshots.some(c => c.name === 'entry_count')],
		['snapshot_entries primary key', () => syncSchemaExpectations.constraints.some(c => c.definition === 'PRIMARY KEY (snapshot_id, path)')],
		['changes.device_id', () => syncSchemaExpectations.columns.storage_changes.some(c => c.name === 'device_id')],
		['changes.change_id', () => syncSchemaExpectations.columns.storage_changes.some(c => c.name === 'change_id')],
		['snapshot_entries.kind', () => syncSchemaExpectations.columns.storage_snapshot_entries.some(c => c.name === 'kind')],
		['snapshots.expires_ms', () => syncSchemaExpectations.columns.storage_snapshots.some(c => c.name === 'expires_ms')],
		['kind CHECK', () => syncSchemaExpectations.checks.some(c => c.table === 'storage_changes' && c.column === 'kind')],
	];
	for (const [label, guard] of guards) {
		assert.ok(guard(), `the probe lost its guard for: ${label}`);
	}
});
