import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { openRustfsBlobs } from './rustfs-blobs.mjs';
import { openRustfsWorkspace } from './rustfs-workspace.mjs';
import { selectTenantStorage } from './tenant-storage.mjs';
import { WorkspaceError } from './workspace-contract.mjs';

const schema = await readFile(new URL('./managed-workspaces.sql', import.meta.url), 'utf8');
const prefix = 'log4stellar.managed_';
const members = prefix + 'tenant_members';
const grants = prefix + 'workspace_members';
const workspaces = prefix + 'workspaces';
const tenants = prefix + 'tenants';
const invites = prefix + 'invitations';
const security = prefix + 'tenant_security';
const admins = 'log4stellar.platform_admins';

const denied = () => new WorkspaceError(403, 'NoPermissions');
const missing = () => new WorkspaceError(404, 'NotFound');
const collision = () => new WorkspaceError(409, 'VersionConflict');
const newId = kind => kind + '-' + randomUUID().replaceAll('-', '');

async function one(db, sql, args) {
	return (await db.query(sql, args)).rows[0];
}

async function transaction(pool, work) {
	const connection = await pool.connect();
	try {
		await connection.query('BEGIN');
		const result = await work(connection);
		await connection.query('COMMIT');
		return result;
	} catch (error) {
		await connection.query('ROLLBACK').catch(() => {});
		throw error;
	} finally {
		connection.release();
	}
}

function requireText(value, code) {
	if (typeof value !== 'string' || !value.trim() || value.trim().length > 128) {
		throw new WorkspaceError(400, code);
	}
	return value.trim();
}

function expectVersion(row, expectedVersion) {
	if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
		throw new WorkspaceError(400, 'InvalidVersion');
	}
	if ((row?.version ?? 0) !== expectedVersion) {
		throw collision();
	}
}

async function platformRole(db, actor) {
	return Boolean(await one(db, `SELECT 1 FROM ${admins} WHERE user_id=$1`, [actor]));
}

async function membership(db, userId, tenantId) {
	const row = await one(db, `
		SELECT t.id AS "tenantId", t.name, m.role, m.version FROM ${members} m
		JOIN ${tenants} t ON t.id=m.tenant_id WHERE m.user_id=$1 AND m.tenant_id=$2
	`, [userId, tenantId]);
	if (!row) {
		throw missing();
	}
	return row;
}

async function tenantWrite(db, actor, tenantId) {
	// All changes within a tenant take the parent row first. Administrator and
	// owner checks therefore observe the final state of any preceding change.
	await one(db, `SELECT id FROM ${tenants} WHERE id=$1 FOR UPDATE`, [tenantId]);
	if ((await membership(db, actor, tenantId)).role !== 2) {
		throw denied();
	}
}

async function audit(db, tenantId, actor, action, target, detail = null) {
	await db.query(`
		INSERT INTO ${prefix}audit(tenant_id,actor_id,action,target,detail,at_ms) VALUES ($1,$2,$3,$4,$5,$6)
	`, [tenantId, actor, action, target, detail, Date.now()]);
}

async function replayable(db, actor, operation, requestId, data, run) {
	const key = requireText(requestId, 'InvalidIdempotencyKey');
	const fingerprint = createHash('sha256').update(JSON.stringify(data)).digest('hex');
	await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [JSON.stringify([actor, operation, key])]);
	const stored = await one(db, `SELECT fingerprint,result FROM ${prefix}operations
		WHERE actor_id=$1 AND operation=$2 AND request_key=$3`, [actor, operation, key]);
	if (stored) {
		if (stored.fingerprint !== fingerprint) {
			throw collision();
		}
		return stored.result;
	}
	const result = await run();
	await db.query(`INSERT INTO ${prefix}operations VALUES ($1,$2,$3,$4,$5)`, [actor, operation, key, fingerprint, result]);
	return result;
}

export async function openManagedWorkspaces(pool, { profiles = {} } = {}) {
	await transaction(pool, async db => {
		await db.query('SELECT pg_advisory_xact_lock(926445021)');
		await db.query(schema);
	});

	return {
		isPlatformAdmin: userId => platformRole(pool, userId),
		describeMembership: (userId, tenantId) => membership(pool, userId, tenantId),
		async bootstrapPlatformAdmin(userId) {
			return transaction(pool, async db => {
				await db.query('SELECT pg_advisory_xact_lock(926445022)');
				if (await one(db, `SELECT 1 FROM ${admins} LIMIT 1`, [])) {
					throw new WorkspaceError(409, 'PlatformAlreadyInitialized');
				}
				await db.query(`INSERT INTO ${admins}(user_id) VALUES ($1)`, [userId]);
			});
		},
		async createTenantWithAdmin(actor, { name, initialAdminId, requestId }) {
			name = requireText(name, 'InvalidTenantName');
			initialAdminId = requireText(initialAdminId, 'InvalidUserId');
			return transaction(pool, async db => {
				if (!await platformRole(db, actor)) {
					throw denied();
				}
				return replayable(db, actor, 'tenant.create', requestId, [name, initialAdminId], async () => {
					if (!await one(db, 'SELECT id FROM public."user" WHERE id=$1', [initialAdminId])) {
						throw missing();
					}
					const tenantId = newId('tenant');
					await db.query(`INSERT INTO ${tenants}(id,name) VALUES ($1,$2)`, [tenantId, name]);
					await db.query(`INSERT INTO ${members}(tenant_id,user_id,role) VALUES ($1,$2,2)`, [tenantId, initialAdminId]);
					await audit(db, tenantId, actor, 'tenant.create', initialAdminId, { name });
					return { tenantId, name };
				});
			});
		},
		async createTenantWorkspace(actor, tenantId, { name, initialOwnerId, requestId }) {
			name = requireText(name, 'InvalidWorkspaceName');
			initialOwnerId = requireText(initialOwnerId, 'InvalidUserId');
			return transaction(pool, async db => {
				await tenantWrite(db, actor, tenantId);
				return replayable(db, actor, 'workspace.create', requestId, [tenantId, name, initialOwnerId], async () => {
					await membership(db, initialOwnerId, tenantId);
					const id = newId('workspace');
					const now = Date.now();
					await db.query('INSERT INTO log4stellar.storage_workspaces(id,created_ms) VALUES ($1,$2)', [id, now]);
					await db.query(`INSERT INTO log4stellar.storage_entries
						(workspace_id,path,parent_path,name,file_id,revision_id,kind,created_ms,modified_ms)
						VALUES ($1,'/',NULL,'',$2,$3,2,$4,$4)`, [id, randomUUID(), randomUUID(), now]);
					await db.query(`INSERT INTO ${workspaces}(id,tenant_id,name) VALUES ($1,$2,$3)`, [id, tenantId, name]);
					await db.query(`INSERT INTO ${grants}(tenant_id,workspace_id,user_id,role) VALUES ($1,$2,$3,3)`,
						[tenantId, id, initialOwnerId]);
					await audit(db, tenantId, actor, 'workspace.create', id, { name, initialOwnerId });
					return { id, name, tenantId };
				});
			});
		},
		async setWorkspaceMemberRole(actor, tenantId, workspaceId, userId, { role, expectedVersion }) {
			if (![null, 1, 2, 3].includes(role)) {
				throw new WorkspaceError(400, 'InvalidWorkspaceRole');
			}
			return transaction(pool, async db => {
				await tenantWrite(db, actor, tenantId);
				if (!await one(db, `SELECT id FROM ${workspaces} WHERE tenant_id=$1 AND id=$2`, [tenantId, workspaceId])) {
					throw missing();
				}
				await membership(db, userId, tenantId);
				const row = await one(db, `SELECT role,version FROM ${grants} WHERE workspace_id=$1 AND user_id=$2`, [workspaceId, userId]);
				expectVersion(row, expectedVersion);
				if (row?.role === 3 && role !== 3 && !await one(db,
					`SELECT 1 FROM ${grants} WHERE workspace_id=$1 AND user_id<>$2 AND role=3 LIMIT 1`, [workspaceId, userId])) {
					throw new WorkspaceError(409, 'LastWorkspaceOwner');
				}
				let version = 0;
				if (role === null) {
					await db.query(`DELETE FROM ${grants} WHERE workspace_id=$1 AND user_id=$2`, [workspaceId, userId]);
				} else {
					({ version } = await one(db, `INSERT INTO ${grants}(tenant_id,workspace_id,user_id,role)
						VALUES ($1,$2,$3,$4) ON CONFLICT (workspace_id,user_id)
						DO UPDATE SET role=EXCLUDED.role,version=EXCLUDED.version RETURNING version`,
					[tenantId, workspaceId, userId, role]));
				}
				await audit(db, tenantId, actor, 'workspace.member.role', workspaceId, { userId, before: row?.role ?? null, after: role });
				return { userId, role, version };
			});
		},
		async platformDirectory(actor) {
			if (!await platformRole(pool, actor)) {
				throw denied();
			}
			const { rows: records } = await pool.query(`SELECT id AS "tenantId",name FROM ${tenants} ORDER BY name,id`);
			const { rows: accounts } = await pool.query('SELECT id AS "userId",username FROM public."user" ORDER BY username,id');
			return { tenants: records, accounts };
		},
		async listTenantMembers(actor, tenantId) {
			if ((await membership(pool, actor, tenantId)).role !== 2) {
				throw denied();
			}
			const { rows } = await pool.query(`SELECT m.user_id AS "userId",u.username,m.role,m.version
				FROM ${members} m JOIN public."user" u ON u.id=m.user_id WHERE tenant_id=$1 ORDER BY username,u.id`, [tenantId]);
			return rows;
		},
		async readTenantAudit(actor, tenantId, before) {
			if ((await membership(pool, actor, tenantId)).role !== 2) {
				throw denied();
			}
			const { rows } = await pool.query(`SELECT id,actor_id AS "actorId",action,target,detail,at_ms AS "atMs"
				FROM ${prefix}audit WHERE tenant_id=$1 AND ($2::bigint IS NULL OR id<$2)
				ORDER BY id DESC LIMIT 51`, [tenantId, before]);
			const entries = rows.slice(0, 50).map(item => ({ ...item, atMs: Number(item.atMs) }));
			return { entries, nextCursor: rows.length > 50 ? entries.at(-1).id : null };
		},
		async listPendingInvitations(actor, tenantId) {
			if ((await membership(pool, actor, tenantId)).role !== 2) {
				throw denied();
			}
			const { rows } = await pool.query(`SELECT id AS "invitationId",email,role,expires_ms AS "expiresMs"
				FROM ${invites} WHERE tenant_id=$1 AND used_at IS NULL AND revoked_at IS NULL AND expires_ms>$2
				ORDER BY expires_ms,id`, [tenantId, Date.now()]);
			return rows.map(row => ({ ...row, expiresMs: Number(row.expiresMs) }));
		},
		async revokeInvitation(actor, tenantId, invitationId) {
			return transaction(pool, async db => {
				await tenantWrite(db, actor, tenantId);
				const changed = await one(db, `UPDATE ${invites} SET revoked_at=now()
					WHERE tenant_id=$1 AND id=$2 AND used_at IS NULL AND revoked_at IS NULL AND expires_ms>$3
					RETURNING id`, [tenantId, invitationId, Date.now()]);
				if (!changed) {
					throw missing();
				}
				await audit(db, tenantId, actor, 'invitation.revoke', invitationId);
				return { invitationId };
			});
		},
		async requiresSecondFactor(tenantId) {
			return (await one(pool, `SELECT require_second_factor FROM ${security} WHERE tenant_id=$1`, [tenantId]))?.require_second_factor === true;
		},
		async readTenantSecurity(actor, tenantId) {
			await membership(pool, actor, tenantId);
			return await one(pool, `SELECT require_second_factor AS "requireSecondFactor", version FROM ${security} WHERE tenant_id=$1`, [tenantId])
				?? { requireSecondFactor: false, version: 0 };
		},
		async setTenantSecurity(actor, tenantId, { requireSecondFactor, expectedVersion }) {
			if (typeof requireSecondFactor !== 'boolean') throw new WorkspaceError(400, 'InvalidRequest');
			return transaction(pool, async db => {
				await tenantWrite(db, actor, tenantId);
				const previous = await one(db, `SELECT version FROM ${security} WHERE tenant_id=$1`, [tenantId]);
				expectVersion(previous, expectedVersion);
				const record = await one(db, `
					INSERT INTO ${security}(tenant_id, require_second_factor) VALUES ($1,$2)
					ON CONFLICT (tenant_id) DO UPDATE SET require_second_factor=EXCLUDED.require_second_factor, version=EXCLUDED.version
					RETURNING require_second_factor AS "requireSecondFactor", version
				`, [tenantId, requireSecondFactor]);
				await audit(db, tenantId, actor, 'tenant.security.changed', tenantId, { requireSecondFactor });
				return record;
			});
		},
		async listTenants(userId) {
			const { rows } = await pool.query(`SELECT t.id AS "tenantId", t.name, m.role
				FROM ${members} m JOIN ${tenants} t ON t.id=m.tenant_id WHERE m.user_id=$1 ORDER BY t.id`, [userId]);
			return rows;
		},
		async listManagedWorkspaces(actor, tenantId) {
			if ((await membership(pool, actor, tenantId)).role !== 2) {
				throw denied();
			}
			const { rows } = await pool.query(`SELECT id,name FROM ${workspaces} WHERE tenant_id=$1 ORDER BY name,id`, [tenantId]);
			return rows;
		},
		async listWorkspaceGrants(actor, tenantId, workspaceId) {
			if ((await membership(pool, actor, tenantId)).role !== 2) {
				throw denied();
			}
			if (!await one(pool, `SELECT 1 FROM ${workspaces} WHERE tenant_id=$1 AND id=$2`, [tenantId, workspaceId])) {
				throw missing();
			}
			const { rows } = await pool.query(`SELECT u.username,m.user_id AS "userId",g.role,g.version
				FROM ${members} m JOIN public."user" u ON u.id=m.user_id
				LEFT JOIN ${grants} g ON g.workspace_id=$2 AND g.tenant_id=m.tenant_id AND g.user_id=m.user_id
				WHERE m.tenant_id=$1 ORDER BY u.username,u.id`, [tenantId, workspaceId]);
			return rows;
		},
		async issueInvitation(actor, tenantId, { email, role }) {
			email = requireText(email, 'InvalidEmail').toLowerCase();
			if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
				throw new WorkspaceError(400, 'InvalidEmail');
			}
			if (![1, 2].includes(role)) {
				throw new WorkspaceError(400, 'InvalidTenantRole');
			}
			return transaction(pool, async db => {
				await tenantWrite(db, actor, tenantId);
				const invitationId = newId('invite');
				const token = randomBytes(32).toString('base64url');
				const expiresMs = Date.now() + 7 * 86400_000;
				await db.query(`INSERT INTO ${invites}(id,tenant_id,email,role,token_digest,expires_ms) VALUES ($1,$2,$3,$4,$5,$6)`,
					[invitationId, tenantId, email, role, createHash('sha256').update(token).digest('hex'), expiresMs]);
				await audit(db, tenantId, actor, 'invitation.issue', invitationId, { email, role });
				return { invitationId, token, expiresMs };
			});
		},
		async acceptInvitation(actor, token) {
			const digest = createHash('sha256').update(requireText(token, 'InvalidInvitationToken')).digest('hex');
			return transaction(pool, async db => {
				const invite = await one(db, `SELECT tenant_id FROM ${invites} WHERE token_digest=$1`, [digest]);
				if (!invite) {
					throw missing();
				}
				await one(db, `SELECT id FROM ${tenants} WHERE id=$1 FOR UPDATE`, [invite.tenant_id]);
				const accepted = await one(db, `UPDATE ${invites} SET used_at=now()
					WHERE token_digest=$1 AND used_at IS NULL AND revoked_at IS NULL AND expires_ms>$2 RETURNING id,role`,
				[digest, Date.now()]);
				if (!accepted) {
					throw missing();
				}
				await db.query(`INSERT INTO ${members}(tenant_id,user_id,role) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
					[invite.tenant_id, actor, accepted.role]);
				await audit(db, invite.tenant_id, actor, 'invitation.accept', accepted.id);
				return { tenantId: invite.tenant_id };
			});
		},
		async changeTenantMember(actor, tenantId, userId, { role, expectedVersion }) {
			if (![null, 1, 2].includes(role)) {
				throw new WorkspaceError(400, 'InvalidTenantRole');
			}
			return transaction(pool, async db => {
				await tenantWrite(db, actor, tenantId);
				const row = await membership(db, userId, tenantId);
				expectVersion(row, expectedVersion);
				if (row.role === 2 && role !== 2 && !await one(db,
					`SELECT 1 FROM ${members} WHERE tenant_id=$1 AND user_id<>$2 AND role=2 LIMIT 1`, [tenantId, userId])) {
					throw new WorkspaceError(409, 'LastAdmin');
				}
				if (role === null) {
					const lastOwner = await one(db, `SELECT 1 FROM ${grants} g
						WHERE g.tenant_id=$1 AND g.user_id=$2 AND g.role=3 AND NOT EXISTS (
							SELECT 1 FROM ${grants} other WHERE other.workspace_id=g.workspace_id AND other.user_id<>$2 AND other.role=3
						) LIMIT 1`, [tenantId,userId]);
					if (lastOwner) {
						throw new WorkspaceError(409, 'LastWorkspaceOwner');
					}
					await db.query(`DELETE FROM ${members} WHERE tenant_id=$1 AND user_id=$2`, [tenantId,userId]);
				} else {
					await db.query(`UPDATE ${members} SET role=$3,version=nextval('log4stellar.managed_member_version')
						WHERE tenant_id=$1 AND user_id=$2`, [tenantId,userId,role]);
				}
				await audit(db, tenantId, actor, role === null ? 'member.revoke' : 'member.role', userId, { from: row.role, to: role });
				return { userId, role };
			});
		},
		async workspacesOf(userId) {
			const { rows } = await pool.query(`SELECT w.id,w.name,w.tenant_id AS "tenantId",g.role
				FROM ${grants} g JOIN ${workspaces} w ON w.id=g.workspace_id WHERE g.user_id=$1 ORDER BY w.id`, [userId]);
			return rows;
		},
		async resolveRole(userId, workspaceId) {
			return (await one(pool, `SELECT role FROM ${grants} WHERE user_id=$1 AND workspace_id=$2`, [userId, workspaceId]))?.role;
		},
		async openWorkspace(workspaceId) {
			const record = await one(pool, `SELECT tenant_id FROM ${workspaces} WHERE id=$1`, [workspaceId]);
			if (!record) {
				throw missing();
			}
			return openRustfsWorkspace(workspaceId, {
				createBlobs: (settings, id, spool) => openRustfsBlobs(selectTenantStorage(settings, profiles, record.tenant_id), id, spool, { tenantId: record.tenant_id }),
			});
		},
		async readWorkspaceMapping(workspaceId) {
			return one(pool, `SELECT tenant_id AS "tenantId",'active' AS status FROM ${workspaces} WHERE id=$1`, [workspaceId]);
		},
	};
}
