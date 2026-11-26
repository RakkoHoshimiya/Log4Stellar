import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertRestoreTargetIsSeparate } from './restore-backup.mjs';
import { publicTenantStorageProfiles, selectTenantStorage, tenantStorageProfiles } from './tenant-storage.mjs';

const tenant = 'tenant-' + 'a'.repeat(32);
const other = 'tenant-' + 'b'.repeat(32);
const shared = { endpoint: 'https://store.example', bucket: 'shared', accessKeyId: 'fixture', secretAccessKey: 'fixture' };
const dedicated = { ...shared, bucket: 'dedicated' };

test('only the tenant configured for a dedicated bucket uses it', () => {
	const profiles = tenantStorageProfiles({ s3: shared, tenantStorage: { [tenant]: dedicated } });
	assert.equal(selectTenantStorage(shared, profiles, tenant), dedicated);
	assert.equal(selectTenantStorage(shared, profiles, other), shared);
	assert.equal(selectTenantStorage(shared, profiles), shared);
	assert.deepEqual(publicTenantStorageProfiles(profiles), {
		[tenant]: { endpoint: dedicated.endpoint, region: null, bucket: dedicated.bucket },
	});
});

test('rejects reused or malformed dedicated storage configuration', () => {
	assert.throws(() => tenantStorageProfiles({ s3: shared, tenantStorage: { [tenant]: shared } }), /separate bucket/);
	assert.throws(() => tenantStorageProfiles({ s3: shared, tenantStorage: { [tenant]: dedicated, [other]: dedicated } }), /separate bucket/);
	assert.throws(() => tenantStorageProfiles({ s3: shared, tenantStorage: { [tenant]: { ...dedicated, endpoint: 'file:///tmp' } } }), /endpoint/);
});

test('restore refuses any destination which is a source tenant bucket', () => {
	const manifest = { origin: { s3: shared, tenantStorage: { [tenant]: dedicated } } };
	assert.throws(() => assertRestoreTargetIsSeparate(manifest, { s3: dedicated }), /backed-up bucket/);
	assert.throws(() => assertRestoreTargetIsSeparate(manifest, { tenantStorage: { [other]: dedicated } }), /backed-up bucket/);
	assert.doesNotThrow(() => assertRestoreTargetIsSeparate(manifest, { s3: { ...shared, bucket: 'rehydrated' } }));
});
