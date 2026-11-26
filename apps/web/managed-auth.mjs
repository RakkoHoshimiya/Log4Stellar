import { readFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { getMigrations } from 'better-auth/db/migration';
import { Pool } from 'pg';
import { createAccountSecurityRuntime, createChallengeResolver } from './account-security-runtime.mjs';
import { openPostgresAccountSecurity } from './postgres-account-security.mjs';
import { clampIdleSeconds } from './account-security.mjs';
import { createApplicationAuth } from './auth.mjs';
import { openManagedWorkspaces } from './managed-workspaces.mjs';
import { holdTenantStorageReadLock, tenantStorageProfiles } from './tenant-storage.mjs';
import { ensureStorageSchema } from './sync-migrate.mjs';

export async function openManagedAuth(environment = process.env, { serve = false } = {}) {
	const origin = new URL(environment.LOG4STELLAR_WEB_ORIGIN);
	if (origin.protocol !== 'https:' || origin.origin !== environment.LOG4STELLAR_WEB_ORIGIN) {
		throw new Error('Set a canonical HTTPS origin for the managed runtime.');
	}
	const path = resolve(environment.LOG4STELLAR_AUTH_DIR);
	await mkdir(path, { recursive: true, mode: 0o700 });
	const secret = (await readFile(join(path, 'secret'), 'utf8')).trim();
	if (secret.length < 32) {
		throw new Error('Set a randomly generated authentication secret.');
	}
	const idleSeconds = clampIdleSeconds(Number(environment.LOG4STELLAR_IDLE_SECONDS ?? 86_400));
	if (!Number.isInteger(idleSeconds) || idleSeconds <= 0) {
		throw new Error('LOG4STELLAR_IDLE_SECONDS must be a positive integer.');
	}
	const storage = JSON.parse(await readFile(environment.LOG4STELLAR_STORAGE_CONFIG, 'utf8'));
	const profiles = tenantStorageProfiles(storage);
	const pool = new Pool({ connectionTimeoutMillis: 5000, ...storage.postgres, max: 4 });
	let servingConnection;
	try {
		if (serve) {
			servingConnection = await holdTenantStorageReadLock(pool);
			servingConnection.once('error', () => process.kill(process.pid, 'SIGTERM'));
		}
		const auth = createApplicationAuth({ database: pool, origin, secret, idleSeconds });
		const migrationLock = await pool.connect();
		try {
			await migrationLock.query('SELECT pg_advisory_lock(926445020)');
			await (await getMigrations(auth.options)).runMigrations();
		} finally {
			await migrationLock.query('SELECT pg_advisory_unlock(926445020)').catch(() => {});
			migrationLock.release();
		}
		await pool.query('CREATE SCHEMA IF NOT EXISTS log4stellar');
		await ensureStorageSchema(pool);
		const managedWorkspaces = await openManagedWorkspaces(pool, { profiles });
		const securityDatabase = await openPostgresAccountSecurity(pool);
		return {
			auth, origin, path, managedWorkspaces,
			accountSecurity: createAccountSecurityRuntime({ auth, database: securityDatabase, secret, idleSeconds }),
			hasSecondFactor: (session) => securityDatabase.hasSecondFactor(session.session.id, session.user.id),
			resolveChallenge: createChallengeResolver({ auth, database: securityDatabase }),
			resolveRole: managedWorkspaces.resolveRole,
			workspacesOf: managedWorkspaces.workspacesOf,
			tenants: managedWorkspaces,
			readWorkspaceMapping: managedWorkspaces.readWorkspaceMapping,
			async defaultWorkspaceId(userId) {
				return (await managedWorkspaces.workspacesOf(userId))[0]?.id;
			},
			matchesWorkspaceAccount: (userId, authority) => userId.toLowerCase() === authority,
			async createAccount(username, password) {
				const { user } = await auth.api.createUser({
					body: { name: username, email: username + '@log4stellar.invalid', password, role: 'user',
						data: { username, displayUsername: username } },
				});
				return user.id;
			},
			async close() {
				servingConnection?.release(true);
				await pool.end();
			},
		};
	} catch (error) {
		servingConnection?.release(true);
		await pool.end();
		throw error;
	}
}
