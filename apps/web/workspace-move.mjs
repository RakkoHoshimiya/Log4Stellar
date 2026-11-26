import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { openRustfsBlobs } from './rustfs-blobs.mjs';
import { syncRetention } from './sync-contract.mjs';
import { selectTenantStorage, tenantMaintenanceLock, tenantStorageProfiles } from './tenant-storage.mjs';
import { isValidWorkspaceId, WorkspaceError } from './workspace-contract.mjs';

const tenantPattern = /^tenant-[a-f0-9]{32}$/;
const moveIdPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

async function ensureNoGitBindings(db, workspaceId) {
	for (const table of ['git_repositories', 'git_credentials', 'git_checkpoints']) {
		const { rows: [presence] } = await db.query('SELECT to_regclass($1) IS NOT NULL AS present', ['log4stellar.' + table]);
		if (presence.present && (await db.query(`SELECT 1 FROM log4stellar.${table} WHERE workspace_id=$1 LIMIT 1`, [workspaceId])).rowCount) {
			throw new WorkspaceError(409, 'WorkspaceHasGitData');
		}
	}
}

async function copyObjects(config, profiles, { workspaceId, sourceTenant, targetTenant }, rows) {
	const spool = await mkdtemp(join(tmpdir(), 'log4stellar-workspace-move-'));
	let source;
	let target;
	try {
		source = await openRustfsBlobs(selectTenantStorage(config.s3, profiles, sourceTenant), workspaceId, spool, { tenantId: sourceTenant });
		target = await openRustfsBlobs(selectTenantStorage(config.s3, profiles, targetTenant), workspaceId, spool, { tenantId: targetTenant });
		for (const { sha256, size_bytes } of rows) {
			const size = Number(size_bytes);
			if (!Number.isSafeInteger(size) || size < 0) throw new WorkspaceError(409, 'InvalidObjectSize');
			const input = await source.read(sha256, size);
			try {
				const copied = await target.put(input, size);
				if (copied.digest !== sha256 || copied.size !== size) throw new WorkspaceError(502, 'StorageIntegrityMismatch');
			} finally {
				input.destroy();
			}
			const hash = createHash('sha256');
			for await (const bytes of await target.read(sha256, size)) hash.update(bytes);
			if (hash.digest('hex') !== sha256) throw new WorkspaceError(502, 'StorageIntegrityMismatch');
		}
	} finally {
		source?.close();
		target?.close();
		await rm(spool, { recursive: true, force: true });
	}
}

const inventory = `
	SELECT sha256, size_bytes FROM log4stellar.storage_file_versions WHERE workspace_id=$1
	UNION
	SELECT e.sha256, e.size_bytes FROM log4stellar.storage_snapshots s
	JOIN log4stellar.storage_snapshot_entries e ON e.snapshot_id=s.id
	WHERE s.workspace_id=$1 AND s.expires_ms>$2 AND e.sha256 IS NOT NULL
	UNION
	SELECT sha256, size_bytes FROM log4stellar.storage_changes
	WHERE workspace_id=$1 AND created_ms>$3 AND sha256 IS NOT NULL
	ORDER BY sha256
`;

export async function moveManagedWorkspace(config, options) {
	const { workspaceId, sourceTenant, targetTenant, sourceAdmin, targetAdmin, moveId, apply = false } = options;
	if (!isValidWorkspaceId(workspaceId) || !tenantPattern.test(sourceTenant) || !tenantPattern.test(targetTenant)
		|| sourceTenant === targetTenant || !sourceAdmin || !targetAdmin || !moveIdPattern.test(moveId)) {
		throw new WorkspaceError(400, 'InvalidWorkspaceMove');
	}
	const profiles = tenantStorageProfiles(config);
	const pool = new Pool({ ...config.postgres, max: 1, connectionTimeoutMillis: 5000 });
	try {
		const db = await pool.connect();
		try {
			await db.query('BEGIN');
			const { rows: [lock] } = await db.query('SELECT pg_try_advisory_xact_lock($1) AS acquired', [tenantMaintenanceLock]);
			if (!lock.acquired) throw new WorkspaceError(409, 'ManagedWebMustBeStopped');
			await db.query('SELECT id FROM log4stellar.managed_tenants WHERE id=ANY($1) ORDER BY id FOR UPDATE', [[sourceTenant, targetTenant]]);
			const grants = await db.query(`SELECT tenant_id FROM log4stellar.managed_tenant_members
				WHERE role=2 AND ((tenant_id=$1 AND user_id=$2) OR (tenant_id=$3 AND user_id=$4))`,
				[sourceTenant, sourceAdmin, targetTenant, targetAdmin]);
			if (grants.rowCount !== 2) throw new WorkspaceError(403, 'TenantAdministratorsRequired');
			const { rows: [prior] } = await db.query('SELECT * FROM log4stellar.managed_workspace_moves WHERE id=$1', [moveId]);
			const { rows: [workspace] } = await db.query('SELECT tenant_id FROM log4stellar.managed_workspaces WHERE id=$1 FOR UPDATE', [workspaceId]);
			if (prior) {
				if (prior.workspace_id !== workspaceId || prior.source_tenant_id !== sourceTenant ||
					prior.target_tenant_id !== targetTenant || workspace?.tenant_id !== targetTenant) {
					throw new WorkspaceError(409, 'WorkspaceMoveStateChanged');
				}
				return { workspaceId, moveId, alreadyMoved: true };
			}
			if (workspace?.tenant_id !== sourceTenant) throw new WorkspaceError(409, 'WorkspaceMoveStateChanged');
			await ensureNoGitBindings(db, workspaceId);
			const now = Date.now();
			const { rows } = await db.query(inventory, [workspaceId, now, now - syncRetention.changesTtlMs]);
			const result = { workspaceId, sourceTenant, targetTenant, moveId, objects: rows.length, applied: apply };
			if (!apply) return result;
			await copyObjects(config, profiles, options, rows);
			await db.query('DELETE FROM log4stellar.managed_workspace_members WHERE workspace_id=$1', [workspaceId]);
			await db.query('UPDATE log4stellar.managed_workspaces SET tenant_id=$2 WHERE id=$1', [workspaceId,targetTenant]);
			await db.query(`INSERT INTO log4stellar.managed_workspace_members (tenant_id,workspace_id,user_id,role)
				VALUES ($1,$2,$3,3)`, [targetTenant,workspaceId,targetAdmin]);
			await db.query(`INSERT INTO log4stellar.managed_workspace_moves (id,workspace_id,source_tenant_id,target_tenant_id)
				VALUES ($1,$2,$3,$4)`, [moveId,workspaceId,sourceTenant,targetTenant]);
			for (const [tenant, actor] of [[sourceTenant, sourceAdmin], [targetTenant, targetAdmin]]) {
				await db.query(`INSERT INTO log4stellar.managed_audit(tenant_id,actor_id,action,target,detail,at_ms)
					VALUES ($1,$2,'workspace.tenant.moved',$3,$4,$5)`, [tenant,actor,workspaceId,{ moveId },Date.now()]);
			}
			await db.query('COMMIT');
			return result;
		} finally {
			await db.query('ROLLBACK').catch(() => {});
			db.release();
		}
	} finally {
		await pool.end();
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		const [workspaceId, sourceTenant, targetTenant, sourceAdmin, targetAdmin, moveId, mode, ...extra] = process.argv.slice(2);
		if (extra.length || (mode && mode !== '--apply') || process.env.LOG4STELLAR_MANAGED_TENANTS !== '1') {
			throw new WorkspaceError(400, 'InvalidWorkspaceMove');
		}
		const config = JSON.parse(await readFile(process.env.LOG4STELLAR_STORAGE_CONFIG, 'utf8'));
		const result = await moveManagedWorkspace(config, { workspaceId,sourceTenant,targetTenant,sourceAdmin,targetAdmin,moveId,apply: mode === '--apply' });
		console.log(JSON.stringify(result));
	} catch (error) {
		console.error(JSON.stringify({ error: error.code ?? error.name }));
		process.exitCode = 1;
	}
}
