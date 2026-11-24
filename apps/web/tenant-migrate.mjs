// Tenant mapping migration for PostgreSQL (docs/multi-tenant.md §3, contract §3).
//
// Same shape as sync-migrate.mjs and git-migrate.mjs, for the same three reasons:
//
//   1. the schema is additive only (`CREATE TABLE IF NOT EXISTS`), so the previous
//      release — which knows nothing about tenants — keeps reading and writing the
//      database unchanged and a rollback needs no data fixup;
//   2. DDL is never applied unconditionally. `CREATE`/`ALTER` take locks that queue
//      readers behind them, so the cheap catalog probe `tenantSchemaCurrent` runs first
//      and the real migration only happens when something is genuinely missing;
//   3. the migration takes the *same* advisory lock id as the storage and git
//      migrations. The three schemas are applied by the same deployment and must not
//      interleave; reusing the id is what makes a mixed-version fleet serialise instead
//      of racing.
//
// This module owns two tables and nothing else:
//
//   storage_tenant_map     — workspace → tenant, per workspace, with a status that can
//                            be `pending`/`failed` so a half-finished cross-database
//                            creation fails closed (acceptance case T04).
//   storage_tenant_intent  — the idempotency ledger, keyed by the client's key.
//
// The tenant identity itself lives in auth.sqlite (see tenant-store.mjs).

import { readFile } from 'node:fs/promises';
import { migrationLockId } from './sync-migrate.mjs';

export { migrationLockId };

const tenantSchema = await readFile(new URL('./tenant-schema.sql', import.meta.url), 'utf8');

export const tenantMappingTables = Object.freeze([
	'storage_tenant_map',
	'storage_tenant_intent',
]);

/** The statuses a workspace mapping may hold, transcribed from the DDL. */
export const tenantMappingStatuses = Object.freeze(['pending', 'active', 'failed']);
export const tenantIntentStates = Object.freeze(['pending', 'committed', 'abandoned']);

/**
 * What `tenant-schema.sql` is supposed to leave behind, transcribed from the DDL. The
 * test suite compares a fake catalog against this table, and `tenant-schema.test.mjs`
 * independently proves the table matches the SQL file — so neither side can drift
 * without a failure.
 */
export const tenantSchemaExpectations = Object.freeze({
	'storage_tenant_map': Object.freeze(['workspace_id', 'tenant_id', 'status', 'created_ms', 'updated_ms']),
	'storage_tenant_intent': Object.freeze(['idempotency_key', 'operation', 'tenant_id', 'workspace_id', 'state', 'created_ms', 'updated_ms']),
});

export const tenantSchemaIndexes = Object.freeze(['storage_tenant_map_tenant_idx']);

/**
 * Applies the tenant schema to an already configured pool. Idempotent: every statement
 * is `IF NOT EXISTS`, and the advisory lock makes concurrent callers serialise.
 */
export async function migrateTenant(pool) {
	const connection = await pool.connect();
	try {
		await connection.query('BEGIN');
		await connection.query('SELECT pg_advisory_xact_lock($1)', [migrationLockId]);
		await connection.query(tenantSchema);
		await connection.query('COMMIT');
	} catch (error) {
		await connection.query('ROLLBACK').catch(() => {});
		throw error;
	} finally {
		connection.release();
	}
}

/**
 * Read-only "is the tenant schema already current?" probe. No DDL, no exclusive lock:
 * it asks the catalogs only, so a workspace that merely reads a note never blocks
 * writers.
 */
export async function tenantSchemaCurrent(pool) {
	const { rows } = await pool.query(`
		SELECT
			to_regclass('log4stellar.storage_tenant_map') IS NOT NULL
			AND to_regclass('log4stellar.storage_tenant_intent') IS NOT NULL
			AND to_regclass('log4stellar.storage_tenant_map_tenant_idx') IS NOT NULL
			AS current
	`);
	return rows[0]?.current === true;
}

/**
 * Compares a catalog reading against `tenantSchemaExpectations`. Pure, so the test suite
 * can exercise the "refuse to start" decision without a database. Returns the sorted
 * list of problems; an empty list means the schema is current.
 */
export function compareTenantSchema(catalog) {
	if (catalog === undefined || catalog === null || typeof catalog !== 'object') {
		throw new TypeError('compareTenantSchema requires a catalog reading');
	}
	const problems = [];
	for (const [table, columns] of Object.entries(tenantSchemaExpectations)) {
		const present = catalog[table];
		if (!present) {
			problems.push('missing table: ' + table);
			continue;
		}
		const have = new Set(present);
		const missing = columns.filter(column => !have.has(column));
		if (missing.length > 0) {
			problems.push('missing columns in ' + table + ': ' + missing.join(', '));
		}
	}
	for (const index of tenantSchemaIndexes) {
		if (!catalog.indexes?.includes(index)) {
			problems.push('missing index: ' + index);
		}
	}
	return problems.sort();
}

/** Reads the live catalog into the shape `compareTenantSchema` expects. */
export async function readTenantCatalog(connection) {
	const tables = await connection.query(`
		SELECT table_name AS name, array_agg(column_name::text ORDER BY column_name) AS columns
		FROM information_schema.columns
		WHERE table_schema = 'log4stellar' AND table_name = ANY($1::text[])
		GROUP BY table_name
	`, [Object.keys(tenantSchemaExpectations)]);
	const indexes = await connection.query(`
		SELECT indexname AS name FROM pg_indexes
		WHERE schemaname = 'log4stellar' AND indexname = ANY($1::text[])
	`, [tenantSchemaIndexes]);
	const catalog = { indexes: indexes.rows.map(row => row.name) };
	for (const row of tables.rows) {
		catalog[row.name] = row.columns;
	}
	return catalog;
}

/**
 * Ensures the tenant schema, choosing the cheapest path that is still safe: probe the
 * catalog first, migrate only when something is missing, and re-probe afterwards so a
 * silent no-op migration cannot be mistaken for success.
 */
export async function ensureTenantSchema(pool) {
	if (await tenantSchemaCurrent(pool)) {
		return { migrated: false, current: true };
	}
	await migrateTenant(pool);
	const connection = await pool.connect();
	try {
		const problems = compareTenantSchema(await readTenantCatalog(connection));
		if (problems.length > 0) {
			throw new Error('Tenant schema is still not current after migrating: ' + problems.join('; '));
		}
	} finally {
		connection.release();
	}
	return { migrated: true, current: true };
}

/**
 * Records the tenant a workspace belongs to. Used both by the adoption of the legacy
 * single-tenant deployment and by cross-database creation, which writes the mapping as
 * `pending` first and flips it to `active` only after the SQLite transaction commits
 * (acceptance case T04).
 */
export async function bindWorkspaceTenant(pool, { workspaceId, tenantId, status = 'active', nowMs = Date.now() } = {}) {
	if (typeof workspaceId !== 'string' || workspaceId.length === 0) {
		throw new TypeError('bindWorkspaceTenant requires a workspace id');
	}
	if (typeof tenantId !== 'string' || tenantId.length === 0) {
		throw new TypeError('bindWorkspaceTenant requires a tenant id');
	}
	if (!tenantMappingStatuses.includes(status)) {
		throw new TypeError('Unknown tenant mapping status: ' + String(status));
	}
	const { rows } = await pool.query(`
		INSERT INTO log4stellar.storage_tenant_map (workspace_id, tenant_id, status, created_ms, updated_ms)
		VALUES ($1, $2, $3, $4, $4)
		ON CONFLICT (workspace_id) DO UPDATE
			SET tenant_id = EXCLUDED.tenant_id, status = EXCLUDED.status, updated_ms = EXCLUDED.updated_ms
		RETURNING workspace_id AS "workspaceId", tenant_id AS "tenantId", status
	`, [workspaceId, tenantId, status, nowMs]);
	return rows[0];
}

/**
 * Records a cross-database creation intent.
 *
 * Every write that spans the two databases starts here: the intent row is written first,
 * the other database is mutated, and the intent is then flipped to `committed` (or left
 * `pending` for a retry to find). A client that retries with the same key therefore finds
 * the earlier attempt instead of starting a second one.
 *
 * `operation` is part of the key's namespace so that creating a tenant and binding a
 * workspace never consume each other's keys, and it is stored rather than inferred so an
 * operator reading the table can tell what an orphaned `pending` row was trying to do.
 *
 * A tenant creation has no workspace yet, so `workspace_id` is the empty string there —
 * the column is `NOT NULL` but the empty string is a legitimate "not applicable", which
 * keeps a single table for both kinds of intent instead of a second near-identical one.
 */
export async function recordTenantIntent(pool, { idempotencyKey, operation, tenantId, workspaceId = '', state = 'pending', nowMs = Date.now() } = {}) {
	if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0) {
		throw new TypeError('recordTenantIntent requires an idempotency key');
	}
	if (typeof operation !== 'string' || operation.length === 0) {
		throw new TypeError('recordTenantIntent requires an operation');
	}
	if (typeof tenantId !== 'string' || tenantId.length === 0) {
		throw new TypeError('recordTenantIntent requires a tenant id');
	}
	if (!tenantIntentStates.includes(state)) {
		throw new TypeError('Unknown tenant intent state: ' + String(state));
	}
	const { rows } = await pool.query(`
		INSERT INTO log4stellar.storage_tenant_intent
			(idempotency_key, operation, tenant_id, workspace_id, state, created_ms, updated_ms)
		VALUES ($1, $2, $3, $4, $5, $6, $6)
		ON CONFLICT (idempotency_key) DO UPDATE
			SET state = EXCLUDED.state, updated_ms = EXCLUDED.updated_ms
		RETURNING idempotency_key AS "idempotencyKey", operation, tenant_id AS "tenantId",
			workspace_id AS "workspaceId", state
	`, [idempotencyKey, operation, tenantId, workspaceId, state, nowMs]);
	return rows[0];
}

/**
 * Adopts the single legacy workspace into the legacy tenant.
 *
 * This is the one mapping write the Web process performs on its own: a deployment that
 * predates tenants has exactly one workspace and exactly one implicit tenant (spelled
 * `'default'` in every `workspace_member` row), so binding them is the identity mapping,
 * not a decision. It is idempotent and refuses to overwrite a different tenant, so a
 * second start is a no-op and a misconfigured second workspace surfaces as an error at
 * start-up rather than as a workspace that quietly belongs to the wrong tenant.
 */
export async function bindLegacyWorkspaceTenant(mapping, workspaceId, { tenantId = 'default', nowMs = Date.now() } = {}) {
	const existing = await mapping.read(workspaceId);
	if (existing) {
		if (existing.tenantId !== tenantId) {
			throw new Error('Workspace ' + workspaceId + ' already belongs to tenant ' + existing.tenantId + '.');
		}
		return existing;
	}
	return mapping.bind({ workspaceId, tenantId, status: 'active', nowMs });
}

/** The mapping for one workspace, or null when this database has never heard of it. */
export async function readWorkspaceTenant(pool, workspaceId) {
	const { rows } = await pool.query(`
		SELECT workspace_id AS "workspaceId", tenant_id AS "tenantId", status
		FROM log4stellar.storage_tenant_map WHERE workspace_id = $1
	`, [workspaceId]);
	return rows[0] ?? null;
}

/**
 * Opens a small dedicated pool for the workspace → tenant mapping, from
 * `LOG4STELLAR_STORAGE_CONFIG`.
 *
 * The mapping is read on the tenant API path, which does not otherwise open a workspace
 * backend: opening one would create a `max: 8` pool and an object-store client for a
 * request that only needs one row. This pool is deliberately small (`max: 2`) and exists
 * only while the Web process does. The schema is ensured on open, through the shared
 * advisory lock, so the mapping table is present before the first request.
 *
 * Returns `null` when no storage configuration is set — the local-directory deployment
 * has no PostgreSQL and therefore no mapping. Callers must treat `null` as "the mapping
 * gate cannot be evaluated", which resolves a workspace-scoped tenant request to the
 * concealed 404 rather than to an allow.
 */
export async function openTenantMappingReader({ configPath = process.env.LOG4STELLAR_STORAGE_CONFIG } = {}) {
	if (!configPath) {
		return null;
	}
	const { readFile } = await import('node:fs/promises');
	const { Pool } = await import('pg');
	const settings = JSON.parse(await readFile(configPath, 'utf8'));
	const postgres = settings.postgres;
	if (!postgres?.host || !postgres.database || !postgres.user || !postgres.password) {
		throw new Error('The storage configuration must provide PostgreSQL connection details.');
	}
	const pool = new Pool({ connectionTimeoutMillis: 5000, max: 2, ...postgres });
	await ensureTenantSchema(pool);
	return {
		async read(workspaceId) {
			// One query per call, never a cached row: a mapping that was reassigned or failed
			// must stop opening the workspace at the next request, not at the next restart.
			return readWorkspaceTenant(pool, workspaceId);
		},
		bind(mapping) {
			return bindWorkspaceTenant(pool, mapping);
		},
		recordIntent(intent) {
			return recordTenantIntent(pool, intent);
		},
		close() {
			return pool.end();
		},
	};
}
