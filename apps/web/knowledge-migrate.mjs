// Migration for the knowledge index tables (docs/knowledge-links.md §2).
//
// Same shape as sync-migrate.mjs and git-migrate.mjs, for the same reasons:
//
//   1. the schema is additive only (`CREATE TABLE IF NOT EXISTS`), so the previous release
//      — which knows nothing about these tables — keeps reading and writing the database
//      unchanged and a rollback needs no data fixup;
//   2. DDL is never applied unconditionally. `CREATE` takes locks that queue readers behind
//      them, so the cheap catalog probe `knowledgeSchemaCurrent` runs first and the real
//      migration only happens when something is genuinely missing;
//   3. the migration takes the *same* advisory lock id as the storage migration. The two
//      schemas are applied by the same deployment and must not interleave, and reusing the
//      id is what makes a mixed-version fleet serialise instead of racing.

import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { migrationLockId } from './sync-migrate.mjs';

export { migrationLockId };

const knowledgeSchema = await readFile(new URL('./knowledge-schema.sql', import.meta.url), 'utf8');

export const knowledgeSchemaTables = [
	'knowledge_links',
	'knowledge_tags',
	'knowledge_index_state',
];

/**
 * Applies the knowledge schema to an already configured pool. Idempotent: every statement is
 * `IF NOT EXISTS`, and the advisory lock makes concurrent callers serialise.
 */
export async function migrateKnowledge(pool) {
	const connection = await pool.connect();
	try {
		await connection.query('BEGIN');
		await connection.query('SELECT pg_advisory_xact_lock($1)', [migrationLockId]);
		await connection.query(knowledgeSchema);
		await connection.query('COMMIT');
	} catch (error) {
		await connection.query('ROLLBACK').catch(() => {});
		throw error;
	} finally {
		connection.release();
	}
}

/**
 * Read-only "is the knowledge schema already current?" probe. No DDL, no exclusive lock: it
 * asks the catalogs only, so a workspace that merely reads a backlink list never blocks
 * writers, and a deployment that was never migrated does not pay for DDL until it is needed.
 */
export async function knowledgeSchemaCurrent(pool) {
	const { rows } = await pool.query(`
		SELECT
			to_regclass('log4stellar.knowledge_links') IS NOT NULL
			AND to_regclass('log4stellar.knowledge_tags') IS NOT NULL
			AND to_regclass('log4stellar.knowledge_index_state') IS NOT NULL
			AND (
				SELECT count(*) FROM information_schema.columns
				WHERE table_schema = 'log4stellar' AND table_name = 'knowledge_links'
					AND column_name IN (
						'source_revision_id', 'link_kind', 'target_raw', 'target_path',
						'target_name', 'target_file_id', 'status', 'candidate_count', 'indexed_ms'
					)
			) = 9
			AND (
				SELECT count(*) FROM information_schema.columns
				WHERE table_schema = 'log4stellar' AND table_name = 'knowledge_tags'
					AND column_name IN ('revision_id', 'tag', 'tag_key', 'indexed_ms')
			) = 4
			AND (
				SELECT count(*) FROM information_schema.columns
				WHERE table_schema = 'log4stellar' AND table_name = 'knowledge_index_state'
					AND column_name IN ('revision_id', 'parser_version', 'link_count', 'tag_count', 'indexed_ms')
			) = 5
			AS current
	`);
	return rows[0]?.current === true;
}

async function main() {
	const configPath = process.argv[2] ?? process.env.LOG4STELLAR_STORAGE_CONFIG;
	if (!configPath) {
		throw new Error('Usage: node apps/web/knowledge-migrate.mjs <storage.json> (or set LOG4STELLAR_STORAGE_CONFIG)');
	}
	const settings = JSON.parse(await readFile(configPath, 'utf8'));
	if (!settings.postgres?.host || !settings.postgres.database || !settings.postgres.user || !settings.postgres.password) {
		throw new Error('The storage configuration must provide PostgreSQL connection details.');
	}
	const pool = new Pool({ connectionTimeoutMillis: 5000, max: 2, ...settings.postgres });
	try {
		await migrateKnowledge(pool);
		const { rows } = await pool.query(`
			SELECT table_name FROM information_schema.tables
			WHERE table_schema = 'log4stellar' AND table_name = ANY($1::text[])
			ORDER BY table_name
		`, [knowledgeSchemaTables]);
		console.log(`migrated: ${rows.map(row => row.table_name).join(', ') || '(no tables)'}`);
	} finally {
		await pool.end();
	}
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
	await main();
}
