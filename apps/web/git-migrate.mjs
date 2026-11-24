// Migration for the Git integration tables (docs/git-integration.md §3, §6).
//
// Same shape as sync-migrate.mjs, for the same reasons:
//
//   1. the schema is additive only (`CREATE TABLE IF NOT EXISTS`), so the previous release
//      — which knows nothing about these tables — keeps reading and writing the database
//      unchanged and a rollback needs no data fixup;
//   2. DDL is never applied unconditionally. `ALTER`/`CREATE` take locks that queue readers
//      behind them, so the cheap catalog probe `gitSchemaCurrent` runs first and the real
//      migration only happens when something is genuinely missing;
//   3. the migration takes the *same* advisory lock id as the storage migration. The two
//      schemas are applied by the same deployment and must not interleave, and reusing the
//      id is what makes a mixed-version fleet (one process on the previous release, one on
//      this one) serialise instead of racing.

import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { migrationLockId } from './sync-migrate.mjs';

export { migrationLockId };

const gitSchema = await readFile(new URL('./git-schema.sql', import.meta.url), 'utf8');

export const gitSchemaTables = [
	'git_repositories',
	'git_credentials',
	'git_checkpoints',
];

/**
 * Applies the git schema to an already configured pool. Idempotent: every statement is
 * `IF NOT EXISTS`, and the advisory lock makes concurrent callers serialise.
 */
export async function migrateGit(pool) {
	const connection = await pool.connect();
	try {
		await connection.query('BEGIN');
		await connection.query('SELECT pg_advisory_xact_lock($1)', [migrationLockId]);
		await connection.query(gitSchema);
		await connection.query('COMMIT');
	} catch (error) {
		await connection.query('ROLLBACK').catch(() => {});
		throw error;
	} finally {
		connection.release();
	}
}

/**
 * Read-only "is the git schema already current?" probe. No DDL, no exclusive lock: it asks
 * the catalogs only, so a workspace that merely reads a repository never blocks writers.
 */
export async function gitSchemaCurrent(pool) {
	const { rows } = await pool.query(`
		SELECT
			to_regclass('log4stellar.git_repositories') IS NOT NULL
			AND to_regclass('log4stellar.git_credentials') IS NOT NULL
			AND to_regclass('log4stellar.git_checkpoints') IS NOT NULL
			AND (
				SELECT count(*) FROM information_schema.columns
				WHERE table_schema = 'log4stellar' AND table_name = 'git_repositories'
					AND column_name IN ('remote_kind', 'remote_branch', 'credential_id', 'last_fetch_commit')
			) = 4
			AND (
				SELECT count(*) FROM information_schema.columns
				WHERE table_schema = 'log4stellar' AND table_name = 'git_checkpoints'
					AND column_name IN ('note_path', 'note_revision_id', 'note_sha256', 'commit_sha', 'branch')
			) = 5
			AS current
	`);
	return rows[0]?.current === true;
}

async function main() {
	const configPath = process.argv[2] ?? process.env.LOG4STELLAR_STORAGE_CONFIG;
	if (!configPath) {
		throw new Error('Usage: node apps/web/git-migrate.mjs <storage.json> (or set LOG4STELLAR_STORAGE_CONFIG)');
	}
	const settings = JSON.parse(await readFile(configPath, 'utf8'));
	if (!settings.postgres?.host || !settings.postgres.database || !settings.postgres.user || !settings.postgres.password) {
		throw new Error('The storage configuration must provide PostgreSQL connection details.');
	}
	const pool = new Pool({ connectionTimeoutMillis: 5000, max: 2, ...settings.postgres });
	try {
		await migrateGit(pool);
		const { rows } = await pool.query(`
			SELECT table_name FROM information_schema.tables
			WHERE table_schema = 'log4stellar' AND table_name = ANY($1::text[])
			ORDER BY table_name
		`, [gitSchemaTables]);
		console.log(`migrated: ${rows.map(row => row.table_name).join(', ') || '(no tables)'}`);
	} finally {
		await pool.end();
	}
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
	await main();
}
