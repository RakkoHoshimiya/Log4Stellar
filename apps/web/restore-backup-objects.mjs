// Restores verified immutable object bytes into an operator-selected RustFS target.
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openRustfsBlobs } from './rustfs-blobs.mjs';
import { digestFile } from './web-release.mjs';
import { isValidWorkspaceId } from './workspace-contract.mjs';

const [source, target, ...extra] = process.argv.slice(2);
if (!source || !target || extra.length) {
	throw new Error('Usage: node apps/web/restore-backup-objects.mjs <complete backup directory> <target storage config>');
}
const backup = resolve(source);
const manifest = JSON.parse(await readFile(join(backup, 'manifest.json'), 'utf8'));
const { s3 } = JSON.parse(await readFile(target, 'utf8'));
if (manifest.objectExport?.directory !== 'objects') {
	throw new Error('The backup contains storage metadata without the object bytes.');
}
if (new URL(s3.endpoint).href === new URL(manifest.storage.s3.endpoint).href && s3.bucket === manifest.storage.s3.bucket) {
	throw new Error('Choose a separate restore bucket or endpoint.');
}
const inventoryPath = join(backup, 'objects.json');
if (await digestFile(inventoryPath) !== manifest.artifacts.inventory?.sha256) {
	throw new Error('Backup object inventory digest mismatch.');
}
const inventory = JSON.parse(await readFile(inventoryPath, 'utf8'));
if (!Array.isArray(inventory) || inventory.length !== manifest.objectExport.count) {
	throw new Error('Backup object inventory count mismatch.');
}
const seen = new Set();
const objects = [];
for (const { workspaceId, sha256, size } of inventory) {
	if (!isValidWorkspaceId(workspaceId) || !/^[a-f0-9]{64}$/.test(sha256) || !Number.isSafeInteger(size) || size < 0) {
		throw new Error('Invalid reference in backup object inventory.');
	}
	const key = workspaceId + '/' + sha256;
	if (seen.has(key)) {
		throw new Error('Duplicate reference in backup object inventory: ' + key);
	}
	seen.add(key);
	const file = join(backup, 'objects', workspaceId, sha256);
	if ((await stat(file)).size !== size || await digestFile(file) !== sha256) {
		throw new Error('Backup object contents do not match: ' + key);
	}
	objects.push({ workspaceId, sha256, size, file });
}

const spool = await mkdtemp(join(tmpdir(), 'log4stellar-object-restore-'));
let blobs;
let active;
try {
	for (const { workspaceId, sha256, size, file } of objects) {
		if (workspaceId !== active) {
			blobs?.close();
			blobs = await openRustfsBlobs(s3, workspaceId, spool);
			active = workspaceId;
		}
		const stream = createReadStream(file);
		try {
			const result = await blobs.put(stream, size);
			if (result.digest !== sha256 || result.size !== size) {
				throw new Error('Restore object no longer matches inventory: ' + sha256);
			}
			const hash = createHash('sha256');
			let restoredSize = 0;
			for await (const chunk of await blobs.read(sha256, size)) {
				hash.update(chunk);
				restoredSize += chunk.length;
			}
			if (restoredSize !== size || hash.digest('hex') !== sha256) {
				throw new Error('Restore target bytes do not match the backup: ' + sha256);
			}
		} finally {
			stream.destroy();
		}
	}
	console.log('Verified and restored ' + objects.length + ' immutable storage objects.');
} finally {
	blobs?.close();
	await rm(spool, { recursive: true, force: true });
}
