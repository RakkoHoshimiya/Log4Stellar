import { WorkspaceError } from './workspace-contract.mjs';

export const tenantMaintenanceLock = 926445027;

export async function holdTenantStorageReadLock(pool) {
	const connection = await pool.connect();
	try {
		const { rows: [lock] } = await connection.query('SELECT pg_try_advisory_lock_shared($1) AS acquired', [tenantMaintenanceLock]);
		if (!lock.acquired) throw new WorkspaceError(409, 'TenantMaintenanceInProgress');
		return connection;
	} catch (error) {
		connection.release(true);
		throw error;
	}
}

const tenantIdPattern = /^tenant-[a-f0-9]{32}$/;
const bucketPattern = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

export function storageIdentity(profile) {
	const url = new URL(profile.endpoint);
	return url.origin + '/' + profile.bucket;
}

export function tenantStorageProfiles(storage) {
	const profiles = storage.tenantStorage ?? {};
	if (typeof profiles !== 'object' || Array.isArray(profiles)) {
		throw new Error('Invalid tenant storage profiles');
	}
	const used = new Set();
	if (storage.s3?.endpoint && storage.s3?.bucket) used.add(storageIdentity(storage.s3));
	for (const [tenantId, profile] of Object.entries(profiles)) {
		if (!tenantIdPattern.test(tenantId) || !profile || !bucketPattern.test(profile.bucket ?? '') ||
			typeof profile.accessKeyId !== 'string' || !profile.accessKeyId ||
			typeof profile.secretAccessKey !== 'string' || !profile.secretAccessKey) {
			throw new Error('Invalid tenant storage profile');
		}
		const url = new URL(profile.endpoint);
		if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
			url.pathname !== '/' || url.search || url.hash) {
			throw new Error('Invalid tenant storage endpoint');
		}
		const identity = storageIdentity(profile);
		if (used.has(identity)) throw new Error('Each tenant storage profile requires a separate bucket');
		used.add(identity);
	}
	return profiles;
}

export function selectTenantStorage(defaultStorage, profiles, tenantId) {
	return tenantId && Object.hasOwn(profiles, tenantId) ? profiles[tenantId] : defaultStorage;
}

export function publicTenantStorageProfiles(profiles) {
	return Object.fromEntries(Object.entries(profiles).map(([id, { endpoint, region, bucket }]) => [
		id, { endpoint, region: region ?? null, bucket },
	]));
}
