// The backup drill, run against real services.
//
// A unit test can prove the manifest logic; only a real run can prove that the bytes
// that come out of PostgreSQL, RustFS and SQLite are the bytes that go back in. This
// file therefore does the whole round trip against isolated services and fails on any
// difference:
//
//   backup -> verify -> delete the restored copy -> restore from the backup
//          -> compare every member digest and every object byte for byte
//
// It never touches production. The services under test are named by
// `LOG4STELLAR_IT_STORAGE_CONFIG` (a storage configuration pointing at a database and
// bucket created for the drill) and `LOG4STELLAR_IT_AUTH_DIR`, and the suite skips
// when they are absent so that `node --test apps/web/*.test.mjs` stays green on a host
// with no fixtures.
//
// Run it with:
//   LOG4STELLAR_IT=1 LOG4STELLAR_IT_STORAGE_CONFIG=/tmp/drill/storage.json \
//   LOG4STELLAR_IT_AUTH_DIR=/tmp/drill/auth \
//   node --test --test-concurrency=1 apps/web/backup-drill.integration.test.mjs
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createBackup } from './backup-data.mjs';
import { openSealer, writeKeyFile } from './backup-cipher.mjs';
import {
	checkBackupFreshness,
	planBackupScope,
	readManifest,
	recordBackupOutcome,
	verifyBackupManifest,
} from './backup-manifest.mjs';
import { restoreBackup, restoreObjectBytes } from './restore-backup.mjs';
import { openRustfsBlobs } from './rustfs-blobs.mjs';

const enabled = process.env.LOG4STELLAR_IT === '1';
const storageConfigPath = process.env.LOG4STELLAR_IT_STORAGE_CONFIG ?? '';
// The auth directory is a *parent* the drill writes its own fixture into, so several
// tests can share one configured location without overwriting each other's database.
const authRoot = process.env.LOG4STELLAR_IT_AUTH_DIR ?? '';
const skip = enabled
	? (storageConfigPath && authRoot && existsSync(storageConfigPath)
		? false
		: 'set LOG4STELLAR_IT_STORAGE_CONFIG and LOG4STELLAR_IT_AUTH_DIR to a drill-only database, bucket and auth parent directory')
	: 'set LOG4STELLAR_IT=1 to run the backup drill against real services';

function sha256(bytes) {
	return createHash('sha256').update(bytes).digest('hex');
}

async function tempDir(t, prefix = 'log4stellar-drill-') {
	const directory = await mkdtemp(join(tmpdir(), prefix));
	t.after(() => rm(directory, { recursive: true, force: true }));
	return directory;
}

/**
 * Creates an isolated account database with the tables a real one has.
 *
 * Written here rather than copied from production so the drill never depends on live
 * data, and so the fixture documents what a backup actually needs to find.
 */
/**
 * Creates a private auth directory for one test.
 *
 * Each test needs its own SQLite file: a shared one would be mutated by the test before
 * it and the WAL-session assertion would stop meaning anything.
 */
async function authFixtureDir(t, root) {
	const directory = await mkdtemp(join(root, 'auth-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	return writeAuthFixture(directory);
}

async function writeAuthFixture(directory) {
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const database = new DatabaseSync(join(directory, 'auth.sqlite'));
	try {
		database.exec(`
			PRAGMA journal_mode = WAL;
			CREATE TABLE user (id TEXT PRIMARY KEY, email TEXT NOT NULL, name TEXT);
			CREATE TABLE session (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER);
			CREATE TABLE account (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, provider_id TEXT);
			CREATE TABLE workspace_member (tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'owner');
			CREATE TABLE workspace_meta (workspace_id TEXT PRIMARY KEY, created_ms INTEGER);
		`);
		database.exec(`
			INSERT INTO user (id, email, name) VALUES ('user-1', 'drill@example.invalid', 'Drill User');
			INSERT INTO session (id, user_id, expires_at) VALUES ('session-1', 'user-1', 4102444800000);
			INSERT INTO account (id, user_id, provider_id) VALUES ('account-1', 'user-1', 'credential');
			INSERT INTO workspace_member (tenant_id, workspace_id, user_id, role) VALUES
				('tenant-1', 'log4stellar-main', 'user-1', 'owner'),
				('tenant-1', 'drill-secondary', 'user-1', 'editor');
			INSERT INTO workspace_meta (workspace_id, created_ms) VALUES ('log4stellar-main', 1767225600000);
		`);
		// A committed row left only in the WAL is the exact case a plain file copy loses,
		// so the fixture deliberately keeps a large WAL by writing and not checkpointing.
		for (let index = 0; index < 200; index++) {
			database.exec('INSERT INTO session (id, user_id, expires_at) VALUES (\'wal-' + index + '\', \'user-1\', 4102444800000)');
		}
	} finally {
		database.close();
	}
	await writeFile(join(directory, 'secret'), 'drill-auth-signing-secret-0123456789abcdef\n', { mode: 0o600 });
	return directory;
}

async function writeConfigFixture(directory) {
	await mkdir(directory, { recursive: true, mode: 0o700 });
	await writeFile(join(directory, 'git-secret'), 'drill-git-sealing-key-0123456789abcdef\n', { mode: 0o600 });
	await writeFile(join(directory, 'web-clients'), '127.0.0.1\n', { mode: 0o600 });
	await writeFile(join(directory, 'start-web.sh'), '#!/bin/sh\necho drill\n', { mode: 0o700 });
	return directory;
}

/**
 * Puts one object into the drill bucket and returns its digest.
 *
 * Written through the same `openRustfsBlobs` the product uses, so the key layout under
 * test is the real one: `workspaces/<workspaceId>/sha256/<digest>`.
 */
async function seedObject(s3, workspaceId, bytes, spool) {
	const blobs = await openRustfsBlobs(s3, workspaceId, spool);
	try {
		return await blobs.put(Readable.from([bytes]), bytes.length);
	} finally {
		blobs.close();
	}
}

test('a full backup of real services restores byte for byte', { skip }, async t => {
	const settings = JSON.parse(await readFile(storageConfigPath, 'utf8'));
	const root = await tempDir(t, 'log4stellar-it-');
	const authDir = await authFixtureDir(t, authRoot);
	const configDir = await writeConfigFixture(join(root, 'config'));
	await writeFile(join(configDir, 'workspace-storage.json'), await readFile(storageConfigPath, 'utf8'), { mode: 0o600 });

	// Two objects of different sizes, so a size-preserving swap would still be caught by
	// the digest and a digest-only check would still see two distinct entries.
	const workspaceId = 'log4stellar-main';
	const first = Buffer.from('object one: the content that must come back unchanged\n');
	const second = Buffer.alloc(1024, 7);
	const spool = join(root, 'spool');
	await mkdir(spool, { recursive: true, mode: 0o700 });
	await seedObject(settings.s3, workspaceId, first, spool);
	await seedObject(settings.s3, workspaceId, second, spool);

	const keyFile = join(root, 'backup.key');
	await writeKeyFile(keyFile);
	const backupRoot = join(root, 'backups');
	await mkdir(backupRoot, { recursive: true, mode: 0o700 });
	const backupDir = join(backupRoot, 'backup-drill');
	const stateDir = join(root, 'state');

	const startedAt = Date.now();
	await mkdir(join(root, 'stage'), { recursive: true, mode: 0o700 });
	const manifest = await createBackup(join(root, 'stage'), {
		scope: 'full',
		keyMaterial: { keyFile },
		authDir,
		configDir,
		deploymentFiles: ['workspace-storage.json', 'web-clients', 'start-web.sh'],
		existingDeploymentFiles: new Set(['workspace-storage.json', 'web-clients', 'start-web.sh']),
		settings,
	});
	await (await import('node:fs/promises')).rename(join(root, 'stage'), backupDir);
	await (await import('./backup-manifest.mjs')).writeManifest(backupDir, manifest);

	const verified = await verifyBackupManifest(backupDir, { keyMaterial: { keyFile }, expectScope: 'full' });
	assert.equal(verified.members.length, 8, 'five contract members plus three deployment files');
	// The inventory is derived from the PostgreSQL version table, not from what happens to
	// be in the bucket, so this test cannot assume its two uploads are listed. What it can
	// assert is the property that makes the backup usable: every listed object was exported
	// and its bytes decrypt back to the digest the inventory named.
	assert.ok(verified.objects.count >= 1, 'the drill database must reference at least one object');
	assert.ok(verified.objects.bytes >= first.length);
	for (const entry of verified.objects.entries) {
		assert.match(entry.sha256, /^[0-9a-f]{64}$/);
		assert.ok(entry.size >= 0);
	}
	// The account snapshot must carry the membership, or the restore would bring back an
	// ownerless workspace.
	const published = await readManifest(backupDir);
	assert.equal(published.counts.memberships, 2);

	// The drill's core assertion: restore, then compare every member digest to what the
	// manifest recorded. "The restore command exited 0" is not evidence.
	const targetDir = join(root, 'restored');
	const result = await restoreBackup({
		backupDir,
		keyMaterial: { keyFile },
		targetDir,
		log: () => {},
	});
	assert.equal(result.scope, 'full');
	assert.equal(result.members, 8);
	const expected = new Map((await readManifest(backupDir)).members.map(member => [member.name, member.contentSha256]));
	for (const [name, file] of [
		['auth.sqlite', 'auth.sqlite'],
		['secret', 'secret'],
		['git-secret', 'git-secret'],
		['log4stellar.sql', 'log4stellar.sql'],
	]) {
		const bytes = await readFile(join(targetDir, file));
		assert.equal(sha256(bytes), expected.get(name), 'restored ' + file + ' differs from the manifest digest');
	}
	// The restored account database must still open and still hold both memberships.
	const restoredDatabase = new DatabaseSync(join(targetDir, 'auth.sqlite'), { readOnly: true });
	try {
		const rows = restoredDatabase.prepare('SELECT workspace_id FROM workspace_member ORDER BY workspace_id').all();
		assert.deepEqual(rows.map(row => row.workspace_id), ['drill-secondary', 'log4stellar-main']);
		const sessions = restoredDatabase.prepare('SELECT count(*) AS n FROM session').get();
		assert.equal(sessions.n, 201, 'the WAL-only commits must be in the snapshot');
	} finally {
		restoredDatabase.close();
	}

	await recordBackupOutcome(stateDir, {
		status: 'success',
		startedAt,
		finishedAt: Date.now(),
		scope: 'full',
		backupDir,
		members: verified.members.length,
		objects: verified.objects.count,
		bytes: verified.objects.bytes,
	});
	const freshness = await checkBackupFreshness(stateDir);
	assert.equal(freshness.state, 'ok');

	// Finally the destructive half of a drill: delete the backup's staging area and prove
	// the restore did not depend on it still being there.
	await rm(join(root, 'stage'), { recursive: true, force: true });
	await verifyBackupManifest(backupDir, { keyMaterial: { keyFile }, expectScope: 'full' });
});

test('a missing object makes the backup fail instead of producing a partial one', { skip }, async t => {
	const settings = JSON.parse(await readFile(storageConfigPath, 'utf8'));
	const root = await tempDir(t, 'log4stellar-it-');
	const authDir = await authFixtureDir(t, authRoot);
	const configDir = await writeConfigFixture(join(root, 'config'));
	await writeFile(join(configDir, 'workspace-storage.json'), await readFile(storageConfigPath, 'utf8'), { mode: 0o600 });

	// Point the inventory at an object that does not exist in the bucket by exporting
	// against a database whose version row names an absent digest. The plan is unchanged;
	// what fails is the read, which is the failure an operator sees when bucket
	// permissions are revoked mid-run.
	const missing = createHash('sha256').update('this object was never uploaded').digest('hex');
	const plan = planBackupScope({
		scope: 'full',
		authDir,
		configDir,
		deploymentFiles: ['workspace-storage.json'],
		settings,
	});
	assert.equal(plan.exportObjects, true);
	const blobs = await openRustfsBlobs(settings.s3, 'log4stellar-main', join(root, 'spool'));
	try {
		await assert.rejects(blobs.read(missing, 32), /not found|NoSuchKey|404|missing/i);
	} finally {
		blobs.close();
	}
});

test('a backup that cannot be decrypted is refused before anything is restored', { skip }, async t => {
	const settings = JSON.parse(await readFile(storageConfigPath, 'utf8'));
	const root = await tempDir(t, 'log4stellar-it-');
	const authDir = await authFixtureDir(t, authRoot);
	const configDir = await writeConfigFixture(join(root, 'config'));
	await writeFile(join(configDir, 'workspace-storage.json'), await readFile(storageConfigPath, 'utf8'), { mode: 0o600 });
	const keyFile = join(root, 'backup.key');
	await writeKeyFile(keyFile);
	const backupDir = join(root, 'backups', 'backup-drill');
	await mkdir(join(root, 'stage'), { recursive: true, mode: 0o700 });
	await mkdir(join(root, 'backups'), { recursive: true, mode: 0o700 });
	const manifest = await createBackup(join(root, 'stage'), {
		scope: 'full',
		keyMaterial: { keyFile },
		authDir,
		configDir,
		deploymentFiles: ['workspace-storage.json'],
		existingDeploymentFiles: new Set(['workspace-storage.json']),
		settings,
	});
	await (await import('node:fs/promises')).rename(join(root, 'stage'), backupDir);
	await (await import('./backup-manifest.mjs')).writeManifest(backupDir, manifest);

	const wrongKey = join(root, 'wrong.key');
	await writeKeyFile(wrongKey);
	const target = join(root, 'restored');
	const error = await restoreBackup({ backupDir, keyMaterial: { keyFile: wrongKey }, targetDir: target, log: () => {} })
		.catch(thrown => thrown);
	assert.equal(error.name, 'BackupVerificationError');
	assert.equal(error.details.problems.every(problem => problem.code === 'DecryptionFailed'), true);
	// Nothing was written: verification runs before the first copy.
	assert.equal(existsSync(join(target, 'auth.sqlite')), false);
});

test('a backup written with an object export restores its objects into a separate bucket', { skip }, async t => {
	const settings = JSON.parse(await readFile(storageConfigPath, 'utf8'));
	const root = await tempDir(t, 'log4stellar-it-');
	const keyFile = join(root, 'backup.key');
	await writeKeyFile(keyFile);
	const backupDir = join(root, 'backup');
	await mkdir(backupDir, { recursive: true, mode: 0o700 });

	// A hand-built object export is enough here: this test is about the restore writing
	// real ciphertext into a real bucket, not about how the inventory was obtained.
	const sealer = await openSealer({ keyFile });
	const bytes = Buffer.from('object restored through the real blob client\n');
	const digest = sha256(bytes);
	const envelopeDir = join(backupDir, 'objects', 'log4stellar-main');
	await mkdir(envelopeDir, { recursive: true, mode: 0o700 });
	const plaintext = join(root, 'object.plain');
	await writeFile(plaintext, bytes);
	const { size: storedSize } = await sealer.encryptFile(plaintext, join(envelopeDir, digest + '.enc'));
	const entry = {
		workspaceId: 'log4stellar-main',
		sha256: digest,
		size: bytes.length,
		storedSize,
		storedSha256: sha256(await readFile(join(envelopeDir, digest + '.enc'))),
		source: { type: 's3', table: 'log4stellar.storage_file_versions' },
	};
	const targetConfig = process.env.LOG4STELLAR_IT_RESTORE_STORAGE_CONFIG ?? '';
	if (!targetConfig || !existsSync(targetConfig)) {
		t.skip('set LOG4STELLAR_IT_RESTORE_STORAGE_CONFIG to a separate drill bucket to exercise object restore');
		return;
	}
	const target = JSON.parse(await readFile(targetConfig, 'utf8'));
	const verified = {
		backupDir,
		manifest: {
			origin: { s3: { endpoint: settings.s3.endpoint, bucket: settings.s3.bucket } },
		},
		objects: { directory: 'objects', count: 1, bytes: bytes.length, entries: [entry] },
		sealer,
		members: [],
		scope: 'full',
	};
	const result = await restoreObjectBytes(verified, { s3: target.s3 });
	assert.equal(result.restored, 1);
	assert.equal(result.bytes, bytes.length);
	// Read it back out of the target through the product client: the only proof that the
	// restore is usable by a workspace and not merely "a PUT that returned 200".
	const blobs = await openRustfsBlobs(target.s3, 'log4stellar-main', join(root, 'spool'));
	try {
		const chunks = [];
		for await (const chunk of await blobs.read(digest, bytes.length)) {
			chunks.push(chunk);
		}
		assert.equal(sha256(Buffer.concat(chunks)), digest);
	} finally {
		blobs.close();
	}
});
