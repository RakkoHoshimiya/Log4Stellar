// Migration for the Office preview tables (§3), same shape as git-migrate.mjs:
//
//   1. additive only (`CREATE TABLE IF NOT EXISTS`), so a rollback to the previous
//      release needs no data fixup;
//   2. never unconditional DDL: `officePreviewSchemaCurrent` is a read-only catalog
//      probe and the real migration runs only when something is missing, because
//      `CREATE`/`ALTER` take locks that queue readers behind them;
//   3. the *same* advisory lock id as the storage and git migrations. All three
//      schemas are applied by one deployment and must not interleave, and reusing the
//      id is what makes a mixed-version fleet serialise instead of racing.

import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { migrationLockId } from './sync-migrate.mjs';

export { migrationLockId };

const officeSchema = await readFile(new URL('./office-preview-schema.sql', import.meta.url), 'utf8');

export const officePreviewSchemaTables = [
	'office_previews',
	'office_preview_slots',
];

/**
 * Applies the office preview schema to an already configured pool. Idempotent: every
 * statement is `IF NOT EXISTS`, and the advisory lock serialises concurrent callers.
 */
export async function migrateOfficePreviews(pool) {
	const connection = await pool.connect();
	try {
		await connection.query('BEGIN');
		await connection.query('SELECT pg_advisory_xact_lock($1)', [migrationLockId]);
		await connection.query(officeSchema);
		await connection.query('COMMIT');
	} catch (error) {
		await connection.query('ROLLBACK').catch(() => {});
		throw error;
	} finally {
		connection.release();
	}
}

/**
 * Read-only "is the office preview schema already current?" probe. No DDL and no
 * exclusive lock: it asks the catalogs only, so a deployment that merely reads a
 * preview never blocks a writer.
 */
export async function officePreviewSchemaCurrent(pool) {
	const { rows } = await pool.query(`
		SELECT
			to_regclass('log4stellar.office_previews') IS NOT NULL
			AND to_regclass('log4stellar.office_preview_slots') IS NOT NULL
			AND (
				SELECT count(*) FROM information_schema.columns
				WHERE table_schema = 'log4stellar' AND table_name = 'office_previews'
					AND column_name IN (
						'preview_id', 'workspace_id', 'file_id', 'revision_id', 'source_sha256',
						'profile_fingerprint', 'preview_key', 'state', 'attempt_id', 'attempt_count',
						'lease_until_ms', 'size_bytes', 'reserved_bytes', 'object_key', 'retryable',
						'error_code', 'created_ms', 'updated_ms', 'last_access_ms'
					)
			) = 19
			AND (
				SELECT count(*) FROM pg_indexes
				WHERE schemaname = 'log4stellar' AND tablename = 'office_previews'
					AND indexname IN (
						'office_previews_dedupe_idx', 'office_previews_queue_idx',
						'office_previews_lease_idx', 'office_previews_cache_idx'
					)
			) = 4
			AS current
	`);
	return rows[0]?.current === true;
}

async function main() {
	const configPath = process.argv[2] ?? process.env.LOG4STELLAR_STORAGE_CONFIG;
	if (!configPath) {
		throw new Error('Usage: node apps/web/office-preview-migrate.mjs <storage.json> (or set LOG4STELLAR_STORAGE_CONFIG)');
	}
	const settings = JSON.parse(await readFile(configPath, 'utf8'));
	if (!settings.postgres?.host || !settings.postgres.database || !settings.postgres.user || !settings.postgres.password) {
		throw new Error('The storage configuration must provide PostgreSQL connection details.');
	}
	const pool = new Pool({ connectionTimeoutMillis: 5000, max: 2, ...settings.postgres });
	try {
		await migrateOfficePreviews(pool);
		const { rows } = await pool.query(`
			SELECT table_name FROM information_schema.tables
			WHERE table_schema = 'log4stellar' AND table_name = ANY($1::text[])
			ORDER BY table_name
		`, [officePreviewSchemaTables]);
		console.log(`migrated: ${rows.map(row => row.table_name).join(', ') || '(no tables)'}`);
	} finally {
		await pool.end();
	}
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
	await main();
}
