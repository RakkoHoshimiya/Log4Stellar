// PostgreSQL access for the Git integration (docs/git-integration.md §3).
//
// Deliberately small and dependency free: three tables, plain SQL, no ORM. The pool is created
// once per storage configuration and reused, because a pool per request would add a connect
// round trip to every status poll (the work bench polls it while the user edits).

import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { gitError } from './git-contract.mjs';
import { gitSchemaCurrent, migrateGit } from './git-migrate.mjs';

/** Reads `LOG4STELLAR_STORAGE_CONFIG` the same way rustfs-workspace.mjs does. */
export async function readGitStorageSettings(environment = process.env) {
	const configPath = environment.LOG4STELLAR_STORAGE_CONFIG;
	if (!configPath) {
		throw gitError('GitNotConfigured');
	}
	let settings;
	try {
		settings = JSON.parse(await readFile(configPath, 'utf8'));
	} catch {
		throw gitError('GitNotConfigured');
	}
	const postgres = settings.postgres;
	if (!postgres?.host || !postgres.database || !postgres.user || !postgres.password) {
		throw gitError('GitNotConfigured');
	}
	return { configPath, settings, postgres };
}

let cached;
let cachedKey;

/**
 * One pool per storage configuration, migrated on first use with the read-only probe first
 * (§6.1): a workspace that only reads a repository must not run DDL against a database that
 * is already current.
 */
export async function openGitStore(environment = process.env) {
	const { configPath, postgres } = await readGitStorageSettings(environment);
	if (cached && cachedKey === configPath) {
		return cached;
	}
	await closeGitStore();
	const pool = new Pool({ connectionTimeoutMillis: 5000, max: 4, ...postgres });
	try {
		if (!await gitSchemaCurrent(pool)) {
			await migrateGit(pool);
		}
	} catch (error) {
		await pool.end().catch(() => {});
		throw error;
	}
	const store = createStore(pool, configPath);
	cached = store;
	cachedKey = configPath;
	return store;
}

export async function closeGitStore() {
	if (!cached) {
		return;
	}
	const pool = cached.pool;
	cached = undefined;
	cachedKey = undefined;
	await pool.end().catch(() => {});
}

/** Test seam: drop the cached pool without touching the database. */
export function resetGitStoreForTest() {
	return closeGitStore();
}

const repositoryColumns = [
	'workspace_id', 'local_path', 'repository_root', 'default_branch',
	'remote_url', 'remote_kind', 'remote_branch', 'credential_id',
	'bound_by_actor', 'bound_ms', 'updated_ms',
	'last_fetch_ms', 'last_fetch_commit', 'last_push_ms', 'last_push_commit',
];

const credentialColumns = ['workspace_id', 'credential_id', 'kind', 'label', 'sealed', 'created_ms', 'updated_ms'];

const checkpointColumns = [
	'workspace_id', 'checkpoint_id', 'name', 'note', 'commit_sha', 'branch',
	'note_path', 'note_revision_id', 'note_sha256', 'created_by_actor', 'created_ms',
];

function createStore(pool, configPath) {
	const store = {
		pool,
		configPath,
		close: closeGitStore,

		/** The binding for a workspace, or undefined. Never projects `remote_url` outward. */
		async readRepository(workspaceId) {
			const { rows } = await pool.query(
				`SELECT ${repositoryColumns.join(', ')} FROM log4stellar.git_repositories WHERE workspace_id = $1`,
				[workspaceId],
			);
			return rows[0];
		},

		async bindRepository(record) {
			const { rows } = await pool.query(`
				INSERT INTO log4stellar.git_repositories (
					workspace_id, local_path, repository_root, default_branch,
					remote_url, remote_kind, remote_branch, credential_id,
					bound_by_actor, bound_ms, updated_ms
				) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)
				ON CONFLICT (workspace_id) DO UPDATE SET
					local_path = EXCLUDED.local_path,
					repository_root = EXCLUDED.repository_root,
					default_branch = EXCLUDED.default_branch,
					remote_url = EXCLUDED.remote_url,
					remote_kind = EXCLUDED.remote_kind,
					remote_branch = EXCLUDED.remote_branch,
					credential_id = EXCLUDED.credential_id,
					bound_by_actor = EXCLUDED.bound_by_actor,
					bound_ms = EXCLUDED.bound_ms,
					updated_ms = EXCLUDED.updated_ms,
					last_fetch_ms = NULL, last_fetch_commit = NULL,
					last_push_ms = NULL, last_push_commit = NULL
				RETURNING ${repositoryColumns.join(', ')}
			`, [
				record.workspaceId, record.localPath, record.repositoryRoot, record.defaultBranch,
				record.remoteUrl, record.remoteKind, record.remoteBranch, record.credentialId ?? null,
				record.actor, record.now,
			]);
			return rows[0];
		},

		async unbindRepository(workspaceId) {
			const { rowCount } = await pool.query(
				'DELETE FROM log4stellar.git_repositories WHERE workspace_id = $1',
				[workspaceId],
			);
			return rowCount === 1;
		},

		async recordFetch(workspaceId, { commit, now }) {
			await pool.query(`
				UPDATE log4stellar.git_repositories
				SET last_fetch_ms = $2, last_fetch_commit = $3
				WHERE workspace_id = $1
			`, [workspaceId, now, commit ?? null]);
		},

		async recordPush(workspaceId, { commit, now }) {
			await pool.query(`
				UPDATE log4stellar.git_repositories
				SET last_push_ms = $2, last_push_commit = $3
				WHERE workspace_id = $1
			`, [workspaceId, now, commit ?? null]);
		},

		async listCredentials(workspaceId) {
			const { rows } = await pool.query(
				`SELECT workspace_id, credential_id, kind, label, created_ms, updated_ms
				FROM log4stellar.git_credentials WHERE workspace_id = $1 ORDER BY created_ms DESC`,
				[workspaceId],
			);
			return rows;
		},

		/** Includes `sealed`: the caller unseals immediately and must not keep it. */
		async readCredential(workspaceId, credentialId) {
			const { rows } = await pool.query(
				`SELECT ${credentialColumns.join(', ')} FROM log4stellar.git_credentials
				WHERE workspace_id = $1 AND credential_id = $2`,
				[workspaceId, credentialId],
			);
			return rows[0];
		},

		async putCredential(record) {
			const { rows } = await pool.query(`
				INSERT INTO log4stellar.git_credentials (
					workspace_id, credential_id, kind, label, sealed, created_ms, updated_ms
				) VALUES ($1,$2,$3,$4,$5,$6,$6)
				ON CONFLICT (workspace_id, credential_id) DO UPDATE SET
					kind = EXCLUDED.kind,
					label = EXCLUDED.label,
					sealed = EXCLUDED.sealed,
					updated_ms = EXCLUDED.updated_ms
				RETURNING workspace_id, credential_id, kind, label, created_ms, updated_ms
			`, [record.workspaceId, record.credentialId, record.kind, record.label, record.sealed, record.now]);
			return rows[0];
		},

		/**
		 * Deleting a credential that a binding still references would silently break the next
		 * fetch, so the reference is checked first and reported as `409 CredentialInUse`.
		 */
		async deleteCredential(workspaceId, credentialId) {
			const { rows } = await pool.query(
				'SELECT 1 FROM log4stellar.git_repositories WHERE workspace_id = $1 AND credential_id = $2',
				[workspaceId, credentialId],
			);
			if (rows.length > 0) {
				throw gitError('CredentialInUse');
			}
			const { rowCount } = await pool.query(
				'DELETE FROM log4stellar.git_credentials WHERE workspace_id = $1 AND credential_id = $2',
				[workspaceId, credentialId],
			);
			return rowCount === 1;
		},

		async listCheckpoints(workspaceId, limit = 100) {
			const { rows } = await pool.query(
				`SELECT ${checkpointColumns.join(', ')} FROM log4stellar.git_checkpoints
				WHERE workspace_id = $1 ORDER BY created_ms DESC LIMIT $2`,
				[workspaceId, limit],
			);
			return rows;
		},

		async readCheckpoint(workspaceId, checkpointId) {
			const { rows } = await pool.query(
				`SELECT ${checkpointColumns.join(', ')} FROM log4stellar.git_checkpoints
				WHERE workspace_id = $1 AND checkpoint_id = $2`,
				[workspaceId, checkpointId],
			);
			return rows[0];
		},

		async createCheckpoint(record) {
			try {
				const { rows } = await pool.query(`
					INSERT INTO log4stellar.git_checkpoints (
						workspace_id, checkpoint_id, name, note, commit_sha, branch,
						note_path, note_revision_id, note_sha256, created_by_actor, created_ms
					) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
					RETURNING ${checkpointColumns.join(', ')}
				`, [
					record.workspaceId, record.checkpointId, record.name, record.note,
					record.commitSha, record.branch ?? null, record.notePath ?? null,
					record.noteRevisionId ?? null, record.noteSha256 ?? null,
					record.actor, record.now,
				]);
				return rows[0];
			} catch (error) {
				if (error?.code === '23505') {
					throw gitError('CheckpointExists');
				}
				throw error;
			}
		},

		async deleteCheckpoint(workspaceId, checkpointId) {
			const { rowCount } = await pool.query(
				'DELETE FROM log4stellar.git_checkpoints WHERE workspace_id = $1 AND checkpoint_id = $2',
				[workspaceId, checkpointId],
			);
			return rowCount === 1;
		},
	};
	return store;
}
