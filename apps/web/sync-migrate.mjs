// Storage migration for the incremental sync tables (contract §2.1).
//
// This module is the single place that changes the database schema, and it is used twice:
//
//   1. by the server, automatically, when a workspace backend opens (rustfs-workspace.mjs);
//   2. by an operator, standalone: `node apps/web/sync-migrate.mjs [storage.json]`.
//
// Both paths take the same advisory lock, so a deploy that starts several processes at once
// migrates exactly once and the others wait. The statements are all `CREATE ... IF NOT EXISTS`
// or `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, so re-running is a no-op.
//
// Additive only: no existing column is altered or dropped. That is what lets the previous
// release (web-markdown-preview-01, which only knows the five original tables) keep reading and
// writing the same database during a rollback.

import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';

// The same advisory lock id the pre-existing migration used. Reusing it is deliberate: the two
// schemas must be applied in order by exactly one process, and a second lock id would allow the
// old and new migration to interleave.
export const migrationLockId = 467209224;

const baseSchema = await readFile(new URL('./workspace-schema.sql', import.meta.url), 'utf8');
const syncSchema = await readFile(new URL('./sync-schema.sql', import.meta.url), 'utf8');

const schemaName = 'log4stellar';

/**
 * Apply the storage schema to an already configured pool.
 *
 * Idempotent and concurrency safe: every process that calls this serialises on the advisory
 * lock, and the DDL itself is `IF NOT EXISTS` throughout.
 */
export async function migrateStorage(pool) {
	const connection = await pool.connect();
	try {
		await connection.query('BEGIN');
		await connection.query('SELECT pg_advisory_xact_lock($1)', [migrationLockId]);
		await connection.query(baseSchema);
		await connection.query(syncSchema);
		await connection.query('COMMIT');
	} catch (error) {
		await connection.query('ROLLBACK').catch(() => {});
		throw error;
	} finally {
		connection.release();
	}
}

/** The objects this migration is responsible for, for operator output and tests. */
export const syncSchemaTables = [
	'storage_change_heads',
	'storage_changes',
	'storage_snapshots',
	'storage_snapshot_entries',
];

/**
 * The shape sync-schema.sql is supposed to leave behind, transcribed from the DDL one statement
 * at a time. `storageSchemaCurrent()` verifies every entry, and the "the expectation table
 * covers the whole schema file" test parses sync-schema.sql and fails when the two drift apart.
 *
 * Why a full transcription instead of a couple of spot checks: `CREATE TABLE IF NOT EXISTS` and
 * `ALTER TABLE .. ADD COLUMN IF NOT EXISTS` cannot change an existing column's type, default or
 * nullability, cannot re-create a dropped index, and cannot add a PRIMARY KEY, UNIQUE or CHECK to
 * a table that already exists. Every one of those deviations therefore survives the migration
 * untouched. A probe that only looked for "do the tables exist" reported such a database as
 * current and skipped the migration forever, so the half-migrated state became permanent: the
 * idempotency index stayed gone (duplicate keys accepted, §5.1 broken), a dropped column turned
 * every sync request into a 42703, and nothing ever noticed.
 *
 * Foreign keys are deliberately not probed. A missing FK cannot change any behaviour the sync
 * endpoints serve (every read is workspace-scoped, and the writer always creates the workspace
 * row first), and re-creating one would need a full table rewrite — the very thing this additive
 * migration promises never to do.
 */
export const syncSchemaExpectations = {
	columns: {
		storage_change_heads: [
			{ name: 'workspace_id', type: 'text', nullable: false, default: null },
			{ name: 'seq', type: 'bigint', nullable: false, default: '0' },
			{ name: 'retained_floor', type: 'bigint', nullable: false, default: '1' },
			{ name: 'updated_ms', type: 'bigint', nullable: false, default: null },
		],
		storage_changes: [
			{ name: 'workspace_id', type: 'text', nullable: false, default: null },
			{ name: 'seq', type: 'bigint', nullable: false, default: null },
			{ name: 'change_id', type: 'uuid', nullable: false, default: null },
			{ name: 'kind', type: 'text', nullable: false, default: null },
			{ name: 'entry_kind', type: 'smallint', nullable: false, default: null },
			{ name: 'path', type: 'text', nullable: false, default: null },
			{ name: 'from_path', type: 'text', nullable: true, default: null },
			{ name: 'conflict_path', type: 'text', nullable: true, default: null },
			{ name: 'file_id', type: 'uuid', nullable: true, default: null },
			{ name: 'revision_id', type: 'uuid', nullable: true, default: null },
			{ name: 'parent_revision_id', type: 'uuid', nullable: true, default: null },
			{ name: 'sha256', type: 'text', nullable: true, default: null },
			{ name: 'size_bytes', type: 'bigint', nullable: true, default: null },
			{ name: 'trash_id', type: 'uuid', nullable: true, default: null },
			{ name: 'device_id', type: 'text', nullable: true, default: null },
			{ name: 'idempotency_key', type: 'text', nullable: true, default: null },
			{ name: 'idempotency_fingerprint', type: 'text', nullable: true, default: null },
			{ name: 'created_ms', type: 'bigint', nullable: false, default: null },
			// Added by the two ALTER TABLE .. ADD COLUMN IF NOT EXISTS statements below: the
			// contract DDL keeps no room for the operation group id (§8.6) or the client's
			// declared base revision (§8.7).
			{ name: 'op_id', type: 'uuid', nullable: true, default: null },
			{ name: 'base_revision', type: 'uuid', nullable: true, default: null },
		],
		storage_snapshots: [
			{ name: 'id', type: 'uuid', nullable: false, default: null },
			{ name: 'workspace_id', type: 'text', nullable: false, default: null },
			{ name: 'seq', type: 'bigint', nullable: false, default: null },
			{ name: 'entry_count', type: 'integer', nullable: false, default: null },
			{ name: 'created_ms', type: 'bigint', nullable: false, default: null },
			{ name: 'expires_ms', type: 'bigint', nullable: false, default: null },
		],
		storage_snapshot_entries: [
			{ name: 'snapshot_id', type: 'uuid', nullable: false, default: null },
			{ name: 'path', type: 'text', nullable: false, default: null },
			{ name: 'kind', type: 'smallint', nullable: false, default: null },
			{ name: 'file_id', type: 'uuid', nullable: false, default: null },
			{ name: 'revision_id', type: 'uuid', nullable: false, default: null },
			{ name: 'sha256', type: 'text', nullable: true, default: null },
			{ name: 'size_bytes', type: 'bigint', nullable: true, default: null },
			{ name: 'modified_ms', type: 'bigint', nullable: false, default: null },
		],
	},
	indexes: [
		{
			name: 'storage_changes_idempotency_idx',
			table: 'storage_changes',
			unique: true,
			columns: ['workspace_id', 'idempotency_key'],
		},
		{
			name: 'storage_changes_created_idx',
			table: 'storage_changes',
			unique: false,
			columns: ['workspace_id', 'created_ms'],
		},
		{
			name: 'storage_changes_path_idx',
			table: 'storage_changes',
			unique: false,
			columns: ['workspace_id', 'path', 'seq'],
		},
		{
			name: 'storage_changes_op_idx',
			table: 'storage_changes',
			unique: false,
			columns: ['workspace_id', 'op_id'],
		},
		{
			name: 'storage_snapshots_workspace_idx',
			table: 'storage_snapshots',
			unique: false,
			columns: ['workspace_id', 'expires_ms'],
		},
	],
	// PRIMARY KEY / UNIQUE: matched by definition, not by name, because PostgreSQL picks the
	// index name and re-creating the constraint under a friendlier name is still correct.
	constraints: [
		{ table: 'storage_change_heads', type: 'p', definition: 'PRIMARY KEY (workspace_id)' },
		{ table: 'storage_changes', type: 'p', definition: 'PRIMARY KEY (workspace_id, seq)' },
		{ table: 'storage_changes', type: 'u', definition: 'UNIQUE (workspace_id, change_id)' },
		{ table: 'storage_snapshots', type: 'p', definition: 'PRIMARY KEY (id)' },
		{ table: 'storage_snapshot_entries', type: 'p', definition: 'PRIMARY KEY (snapshot_id, path)' },
	],
	// CHECK constraints, matched by the column they guard. `literals` pins the value domain of
	// the enumerated columns so that replacing `CHECK (kind IN (...))` with some other predicate
	// is not mistaken for the real constraint.
	checks: [
		{ table: 'storage_change_heads', column: 'seq' },
		{ table: 'storage_change_heads', column: 'retained_floor' },
		{ table: 'storage_changes', column: 'kind', literals: ["'file.created'", "'file.conflicted'"] },
		{ table: 'storage_changes', column: 'entry_kind', literals: ['1', '2'] },
		{ table: 'storage_changes', column: 'seq' },
		{ table: 'storage_changes', column: 'sha256' },
		{ table: 'storage_changes', column: 'size_bytes' },
		{ table: 'storage_changes', column: 'idempotency_fingerprint' },
		{ table: 'storage_snapshots', column: 'seq' },
		{ table: 'storage_snapshots', column: 'entry_count' },
		{ table: 'storage_snapshot_entries', column: 'kind', literals: ['1', '2'] },
		{ table: 'storage_snapshot_entries', column: 'sha256' },
		{ table: 'storage_snapshot_entries', column: 'size_bytes' },
	],
};

const allIndexNames = syncSchemaExpectations.indexes.map(index => index.name);

// One statement, one connection: the probe must stay cheap (it runs on every cold workspace
// open) and must never take a lock. `pool.query` on a multi-statement string is avoided, and
// three concurrent queries would each want their own connection.
const catalogSql = `
	WITH present AS (
		SELECT class.relname AS name
		FROM pg_class class
		JOIN pg_namespace namespace ON namespace.oid = class.relnamespace
		WHERE namespace.nspname = $1 AND class.relkind = 'r' AND class.relname = ANY($2::text[])
	)
	SELECT
		(SELECT coalesce(json_agg(present.name), '[]'::json) FROM present) AS tables,
		(SELECT coalesce(json_agg(json_build_object(
				'table', columns.table_name,
				'name', columns.column_name,
				'type', columns.data_type,
				'nullable', columns.is_nullable,
				'default', columns.column_default
			)), '[]'::json)
			FROM information_schema.columns columns
			WHERE columns.table_schema = $1 AND columns.table_name = ANY($2::text[])) AS columns,
		(SELECT coalesce(json_agg(json_build_object(
				'table', indexes.tablename,
				'name', indexes.indexname,
				'definition', indexes.indexdef
			)), '[]'::json)
			FROM pg_indexes indexes
			WHERE indexes.schemaname = $1 AND indexes.indexname = ANY($3::text[])) AS indexes,
		(SELECT coalesce(json_agg(json_build_object(
				'table', rel.relname,
				'name', con.conname,
				'type', con.contype,
				'definition', pg_get_constraintdef(con.oid)
			)), '[]'::json)
			FROM pg_constraint con
			JOIN pg_class rel ON rel.oid = con.conrelid
			JOIN pg_namespace namespace ON namespace.oid = rel.relnamespace
			WHERE namespace.nspname = $1
				AND rel.relname = ANY($2::text[])
				AND con.contype IN ('p', 'u', 'c')) AS constraints
`;

/** Whitespace-insensitive comparison of a catalog definition against the expected text. */
function normalise(text) {
	return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/** True when `column` appears as a whole word/identifier token inside a constraint definition. */
function mentions(definition, column) {
	return normalise(definition)
		.split(/[^A-Za-z0-9_]+/)
		.includes(column);
}

/**
 * Column expressions of a `CREATE INDEX` definition, without sort direction or operator class.
 *
 * `pg_indexes.indexdef` renders `(workspace_id, path, seq DESC)`, and the direction is
 * interchangeable for the lookups these indexes serve, so only the column list is compared.
 */
function indexColumns(definition) {
	// A partial index renders as `.. (cols) WHERE (predicate)`; only the column list matters.
	const text = normalise(definition).split(/\bWHERE\b/)[0];
	const open = text.indexOf('(');
	const close = text.lastIndexOf(')');
	if (open === -1 || close <= open) {
		return [];
	}
	return text
		.slice(open + 1, close)
		.split(',')
		.map(part => normalise(part).split(/\s+/)[0])
		.filter(Boolean);
}

function describeExpected(column) {
	const parts = [column.type];
	parts.push(column.nullable ? 'NULL' : 'NOT NULL');
	if (column.default !== null) {
		parts.push(`DEFAULT ${column.default}`);
	}
	return parts.join(' ');
}

/** Reads the catalogs the probe compares against. Read-only: no DDL, no lock, no writer wait. */
export async function readStorageCatalog(connection) {
	const { rows } = await connection.query(catalogSql, [schemaName, syncSchemaTables, allIndexNames]);
	return rows[0] ?? {};
}

/**
 * Compares a catalog reading against `syncSchemaExpectations`.
 *
 * Returns one problem per deviation, each tagged with whether `migrateStorage()` could possibly
 * fix it. Only "the object is absent" is repairable: the migration is additive and every
 * statement is `IF NOT EXISTS`, so an object that exists with the wrong shape is invisible to it.
 *
 * Separated from the query so the decision can be driven by a literal catalog in a unit test —
 * the alternative is a fake `pg` object, which would test the mock rather than the rule.
 */
export function compareStorageSchema(catalog) {
	if (!catalog) {
		// No reading at all (connection lost mid-probe) must never look like a current schema.
		return { current: false, problems: [] };
	}
	const presentTables = new Set(catalog.tables ?? []);
	const columns = new Map();
	for (const row of catalog.columns ?? []) {
		columns.set(`${row.table}\u0000${row.name}`, row);
	}
	const indexes = new Map((catalog.indexes ?? []).map(row => [row.name, row]));
	const constraints = catalog.constraints ?? [];
	const problems = [];

	for (const table of syncSchemaTables) {
		if (!presentTables.has(table)) {
			// Report the table alone: listing its columns and indexes too would bury the cause.
			problems.push({
				table,
				object: table,
				repairable: true,
				message: `table ${schemaName}.${table} is missing`,
			});
			continue;
		}
		for (const column of syncSchemaExpectations.columns[table]) {
			const found = columns.get(`${table}\u0000${column.name}`);
			if (!found) {
				problems.push({
					table,
					object: `${table}.${column.name}`,
					repairable: true,
					message: `column ${schemaName}.${table}.${column.name} is missing (expected ${describeExpected(column)})`,
				});
				continue;
			}
			if (found.type !== column.type) {
				problems.push({
					table,
					object: `${table}.${column.name}`,
					repairable: false,
					message: `column ${schemaName}.${table}.${column.name} has type ${found.type}, expected ${column.type}`,
				});
			}
			if ((found.nullable === 'YES') !== column.nullable) {
				problems.push({
					table,
					object: `${table}.${column.name}`,
					repairable: false,
					message: `column ${schemaName}.${table}.${column.name} is ${found.nullable === 'YES' ? 'nullable' : 'NOT NULL'}, expected ${column.nullable ? 'nullable' : 'NOT NULL'}`,
				});
			}
			const liveDefault = found.default === null || found.default === undefined ? null : String(found.default);
			if (liveDefault !== column.default) {
				problems.push({
					table,
					object: `${table}.${column.name}`,
					repairable: false,
					message: `column ${schemaName}.${table}.${column.name} has default ${liveDefault ?? '(none)'}, expected ${column.default ?? '(none)'}`,
				});
			}
		}
	}

	for (const index of syncSchemaExpectations.indexes) {
		const found = indexes.get(index.name);
		if (!found) {
			if (!presentTables.has(index.table)) {
				continue;
			}
			problems.push({
				table: index.table,
				object: index.name,
				repairable: true,
				message: `index ${schemaName}.${index.name} is missing (expected ${index.unique ? 'UNIQUE ' : ''}on (${index.columns.join(', ')}))`,
			});
			continue;
		}
		const definition = normalise(found.definition);
		const isUnique = /\bCREATE UNIQUE INDEX\b/.test(definition);
		if (index.unique && !isUnique) {
			problems.push({
				table: index.table,
				object: index.name,
				repairable: false,
				message: `index ${schemaName}.${index.name} is not UNIQUE; §5.1 needs the unique key index`,
			});
		}
		const liveColumns = indexColumns(found.definition);
		if (found.table !== index.table || liveColumns.join(', ') !== index.columns.join(', ')) {
			problems.push({
				table: index.table,
				object: index.name,
				repairable: false,
				message: `index ${schemaName}.${index.name} covers (${liveColumns.join(', ') || 'nothing parseable'}) on ${found.table}, expected (${index.columns.join(', ')}) on ${index.table}`,
			});
		}
	}

	for (const expected of syncSchemaExpectations.constraints) {
		if (!presentTables.has(expected.table)) {
			continue; // CREATE TABLE supplies these constraints.
		}
		const found = constraints.some(row => row.table === expected.table
			&& row.type === expected.type
			&& normalise(row.definition) === expected.definition);
		if (!found) {
			problems.push({
				table: expected.table,
				object: `${expected.table}:${expected.definition}`,
				repairable: false,
				message: `constraint ${expected.definition} on ${schemaName}.${expected.table} is missing`,
			});
		}
	}

	for (const expected of syncSchemaExpectations.checks) {
		if (!presentTables.has(expected.table)) {
			continue; // CREATE TABLE supplies these constraints.
		}
		const found = constraints.some(row => {
			if (row.table !== expected.table || row.type !== 'c') {
				return false;
			}
			const definition = normalise(row.definition);
			if (!mentions(definition, expected.column)) {
				return false;
			}
			return (expected.literals ?? []).every(literal => definition.includes(literal));
		});
		if (!found) {
			problems.push({
				table: expected.table,
				object: `${expected.table}.${expected.column}:check`,
				repairable: false,
				message: `CHECK constraint on ${schemaName}.${expected.table}.${expected.column} is missing or no longer checks ${expected.column}${expected.literals ? ` against ${expected.literals.join('/')}` : ''}`,
			});
		}
	}

	return { current: problems.length === 0, problems };
}

/** One probe: read the catalogs, then compare them. */
export async function inspectStorageSchema(pool) {
	return compareStorageSchema(await readStorageCatalog(pool));
}

/**
 * "Is the schema already current?" probe.
 *
 * Every ALTER TABLE .. ADD COLUMN IF NOT EXISTS takes AccessExclusiveLock even when the column
 * is already there, and the whole migration holds that lock for the duration of both schema
 * files. Running it unconditionally on every cold workspace open therefore queued a DDL
 * request behind any in-flight reader and then blocked every reader behind the DDL — a
 * snapshot request could stall the next workspace open and everything after it.
 *
 * This probe reads catalogs only: no DDL, no exclusive lock, no waiting on a writer.
 */
export async function storageSchemaCurrent(pool) {
	const { current } = await inspectStorageSchema(pool);
	return current;
}

/** Formats the deviations for an operator-facing error message. */
function describeProblems(problems) {
	return problems.map(problem => `  - ${problem.message}`).join('\n');
}

/**
 * Brings the schema up to date, or refuses to start.
 *
 * The old contract was "probe, and if it says stale, migrate" — which silently accepted every
 * deviation the additive migration cannot repair. Those deviations do not just linger: a lost
 * idempotency index makes §5.1 untrue, a wrong bigint/text type makes the seq arithmetic
 * meaningless, a missing backstop column turns every sync request into a 42703. So a deviation
 * that DDL cannot repair is refused outright, with the exact table and column named, instead of
 * being reported as "fine, nothing to do".
 *
 * Failing here means `openRustfsWorkspace()` fails, which is exactly when the surface that would
 * otherwise 500 on every request gets a chance to say why.
 */
export async function ensureStorageSchema(pool) {
	const probe = await inspectStorageSchema(pool);
	if (probe.current) {
		return { migrated: false, problems: [] };
	}
	const unfixable = probe.problems.filter(problem => !problem.repairable);
	if (unfixable.length) {
		throw new Error(
			'The storage schema does not match sync-schema.sql, and the additive migration cannot repair these deviations:\n'
			+ `${describeProblems(unfixable)}\n`
			+ 'Fix them by hand (ALTER TABLE / ALTER COLUMN / CREATE INDEX) before opening a workspace. '
			+ 'Refusing to start rather than serving a half-migrated schema.',
		);
	}
	await migrateStorage(pool);
	const verified = await inspectStorageSchema(pool);
	if (!verified.current) {
		throw new Error(
			'The storage migration ran but the schema is still not what sync-schema.sql declares:\n'
			+ `${describeProblems(verified.problems)}\n`
			+ 'Refusing to start rather than serving a half-migrated schema.',
		);
	}
	return { migrated: true, problems: [] };
}

async function main() {
	const configPath = process.argv[2] ?? process.env.LOG4STELLAR_STORAGE_CONFIG;
	if (!configPath) {
		throw new Error('Usage: node apps/web/sync-migrate.mjs <storage.json> (or set LOG4STELLAR_STORAGE_CONFIG)');
	}
	const settings = JSON.parse(await readFile(configPath, 'utf8'));
	if (!settings.postgres?.host || !settings.postgres.database || !settings.postgres.user || !settings.postgres.password) {
		throw new Error('The storage configuration must provide PostgreSQL connection details.');
	}
	const pool = new Pool({ connectionTimeoutMillis: 5000, max: 2, ...settings.postgres });
	try {
		await ensureStorageSchema(pool);
		const { rows } = await pool.query(`
			SELECT table_name FROM information_schema.tables
			WHERE table_schema = 'log4stellar' AND table_name = ANY($1::text[])
			ORDER BY table_name
		`, [syncSchemaTables]);
		console.log(`migrated: ${rows.map(row => row.table_name).join(', ') || '(no tables)'}`);
	} finally {
		await pool.end();
	}
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
	await main();
}
