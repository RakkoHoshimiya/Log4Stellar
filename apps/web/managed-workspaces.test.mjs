import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { Readable } from 'node:stream';
import { betterAuth } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import { username } from 'better-auth/plugins';
import { Pool } from 'pg';
import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { managedWorkspacePath, serveManagedWorkspaceRequest } from './managed-workspace-files.mjs';
import { openManagedWorkspaces } from './managed-workspaces.mjs';
import { ensureStorageSchema } from './sync-migrate.mjs';

const skip = process.env.LOG4STELLAR_MANAGED_IT !== '1' && 'requires a fresh isolated PostgreSQL database';
const code = expected => error => error.code === expected;

async function request(store, principalId, method, path, body) {
	const ctx = {
		path: managedWorkspacePath + path,
		method,
		is: () => body !== undefined,
		req: Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]),
	};
	await serveManagedWorkspaceRequest(ctx, { store, principalId });
	return { status: ctx.status, body: ctx.body };
}

async function checkAttachment(store, workspaceId, bytes) {
	const workspace = await store.openWorkspace(workspaceId);
	try {
		assert.equal((await workspace.stat('/')).type, 2);
		await workspace.writeFile('/same-name.pdf', Readable.from([bytes]), { create: true, maxBytes: 1024 });
		const content = await workspace.openRead('/same-name.pdf');
		const chunks = [];
		for await (const chunk of await content.stream()) {
			chunks.push(chunk);
		}
		assert.deepEqual(Buffer.concat(chunks), bytes);
	} finally {
		await workspace.close();
	}
}

test('an empty PostgreSQL database provisions and isolates two tenant workspaces', { skip }, async () => {
	const config = JSON.parse(await readFile(process.env.LOG4STELLAR_STORAGE_CONFIG, 'utf8'));
	assert.equal(config.postgres.host, '127.0.0.1');
	assert.equal(config.postgres.database, 'managed_acceptance');
	const pool = new Pool(config.postgres);
	try {
		const auth = betterAuth({
			baseURL: 'https://127.0.0.1:19692', database: pool,
			secret: 'isolated-test-secret-unused-outside-this-fixture',
			emailAndPassword: { enabled: true }, plugins: [username()],
		});
		await (await getMigrations(auth.options)).runMigrations();
		await pool.query('CREATE SCHEMA IF NOT EXISTS log4stellar');
		await ensureStorageSchema(pool);
		const ids = {};
		for (const handle of ['platform', 'admina', 'adminb', 'member']) {
			const { user } = await auth.api.signUpEmail({
				body: { name: handle, username: handle, email: handle + '@example.test', password: 'fixture-password-only' },
			});
			ids[handle] = user.id;
		}
		const store = await openManagedWorkspaces(pool);
		await store.bootstrapPlatformAdmin(ids.platform);
		await assert.rejects(store.bootstrapPlatformAdmin(ids.member), code('PlatformAlreadyInitialized'));
		const alphaInput = { name: 'Alpha', initialAdminId: ids.admina, requestId: 'alpha' };
		await assert.rejects(store.createTenantWithAdmin(ids.member, alphaInput), code('NoPermissions'));
		const [alpha, replay] = await Promise.all([
			store.createTenantWithAdmin(ids.platform, alphaInput),
			store.createTenantWithAdmin(ids.platform, alphaInput),
		]);
		assert.deepEqual(replay, alpha);
		await assert.rejects(store.createTenantWithAdmin(ids.platform, { ...alphaInput, name: 'Changed' }), code('VersionConflict'));
		const beta = await store.createTenantWithAdmin(ids.platform, { name: 'Beta', initialAdminId: ids.adminb, requestId: 'beta' });
		const workspace = await store.createTenantWorkspace(ids.admina, alpha.tenantId, {
			name: 'Notes', initialOwnerId: ids.admina, requestId: 'notes-alpha',
		});
		const second = await store.createTenantWorkspace(ids.adminb, beta.tenantId, {
			name: 'Notes', initialOwnerId: ids.adminb, requestId: 'notes-beta',
		});
		assert.notEqual(second.id, workspace.id);
		assert.equal(await store.resolveRole(ids.platform, workspace.id), undefined);
		assert.equal(await store.resolveRole(ids.admina, second.id), undefined);
		assert.deepEqual((await store.workspacesOf(ids.admina)).map(row => row.id), [workspace.id]);
		await checkAttachment(store, workspace.id, Buffer.from([0, 1, 2]));
		await checkAttachment(store, second.id, Buffer.from([3, 4, 5]));
		const { s3 } = config;
		const client = new S3Client({ endpoint: s3.endpoint, region: s3.region, credentials: s3, forcePathStyle: true });
		try {
			const objects = await client.send(new ListObjectsV2Command({ Bucket: s3.bucket }));
			const keys = objects.Contents.map(object => object.Key);
			assert.equal(keys.length, 2);
			assert.ok(keys.some(key => key.startsWith(`tenants/${alpha.tenantId}/workspaces/${workspace.id}/sha256/`)));
			assert.ok(keys.some(key => key.startsWith(`tenants/${beta.tenantId}/workspaces/${second.id}/sha256/`)));
		} finally { client.destroy(); }
		assert.equal((await request(store, undefined, 'GET', '/platform')).status, 401);
		assert.equal((await request(store, ids.admina, 'GET', '/platform')).status, 403);
		assert.equal((await request(store, ids.adminb, 'GET', '/tenants/' + alpha.tenantId + '/workspaces')).status, 404);
		assert.equal((await request(store, ids.platform, 'GET', '/platform')).body.tenants.length, 2);
		assert.deepEqual((await request(store, ids.admina, 'GET', '/tenants/' + alpha.tenantId + '/workspaces')).body.workspaces, [
			{ id: workspace.id, name: 'Notes' },
		]);

		const invitation = await store.issueInvitation(ids.admina, alpha.tenantId, { email: 'member@example.test', role: 1 });
		assert.deepEqual(await store.acceptInvitation(ids.member, invitation.token), { tenantId: alpha.tenantId });
		await assert.rejects(store.acceptInvitation(ids.member, invitation.token), code('NotFound'));
		assert.equal(await store.resolveRole(ids.member, workspace.id), undefined);
		const grant = await store.setWorkspaceMemberRole(ids.admina, alpha.tenantId, workspace.id, ids.member, { role: 1, expectedVersion: 0 });
		const concurrent = await Promise.allSettled([2, 3].map(role => store.setWorkspaceMemberRole(
			ids.admina, alpha.tenantId, workspace.id, ids.member, { role, expectedVersion: grant.version })));
		assert.equal(concurrent.filter(result => result.status === 'fulfilled').length, 1);
		assert.equal(concurrent.find(result => result.status === 'rejected').reason.code, 'VersionConflict');
		const owner = (await store.listWorkspaceGrants(ids.adminb, beta.tenantId, second.id)).find(row => row.userId === ids.adminb);
		await assert.rejects(store.setWorkspaceMemberRole(ids.adminb, beta.tenantId, second.id, ids.adminb, {
			role: 1, expectedVersion: owner.version,
		}), code('LastWorkspaceOwner'));
		const member = await store.describeMembership(ids.member, alpha.tenantId);
		await store.changeTenantMember(ids.admina, alpha.tenantId, ids.member, { role: null, expectedVersion: member.version });
		assert.equal(await store.resolveRole(ids.member, workspace.id), undefined);
		assert.deepEqual(await store.listTenants(ids.member), []);
	} finally {
		await pool.end();
	}
});
