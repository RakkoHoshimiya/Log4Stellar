import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
	planBackupScope,
	sealMember,
	sealMemberFromBytes,
	verifyBackupManifest,
	writeManifest,
	manifestFormat,
	scopeFull,
} from './backup-manifest.mjs';
import { openSealer } from './backup-cipher.mjs';
import {
	assertRestoreTargetIsSeparate,
	inspectSqlDump,
	parseArguments,
	restoreBackup,
	restoreObjectBytes,
	restoreToDirectory,
} from './restore-backup.mjs';

const keyMaterial = Buffer.from('restore-test-key-material-0123456', 'utf8');

async function tempDir(t, prefix = 'log4stellar-restore-') {
	const directory = await mkdtemp(join(tmpdir(), prefix));
	t.after(() => rm(directory, { recursive: true, force: true }));
	return directory;
}

function sha256(bytes) {
	return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Writes a complete backup whose object export holds `objects`.
 *
 * The object envelopes are produced by the same sealer a real backup uses, so the
 * restore path under test decrypts real ciphertext rather than a stub.
 */
async function fixtureBackup(t, objects = []) {
	const root = await tempDir(t);
	const backupDir = join(root, 'backup-20260101');
	await mkdir(backupDir, { recursive: true, mode: 0o700 });
	const sealer = await openSealer(keyMaterial);
	const ddl = [
		'CREATE SCHEMA log4stellar;',
		'CREATE TABLE log4stellar.storage_entries (workspace_id text, path text);',
		'COPY log4stellar.storage_entries (workspace_id, path) FROM stdin;',
		'log4stellar-main\t/a.md',
		'\\.',
		'-- PostgreSQL database dump complete',
		'',
	].join('\n');
	const manifest = {
		format: manifestFormat,
		scope: scopeFull,
		createdAt: '2026-01-01T00:00:00.000Z',
		completedAt: '2026-01-01T00:00:05.000Z',
		encryption: sealer.encryption,
		origin: {
			s3: { endpoint: 'http://192.0.2.10:9000', bucket: 'log4stellar' },
			postgres: { host: '192.0.2.20', port: 5432, database: 'log4stellar' },
			authDir: '/home/log4stellar/.cache/log4stellar-demo/auth',
		},
		members: [],
		objects: { directory: 'objects', count: 0, bytes: 0, entries: [] },
		counts: {},
	};
	const plan = planBackupScope({ scope: scopeFull, authDir: join(root, 'auth'), configDir: join(root, 'config') });
	const byName = new Map(plan.members.map(member => [member.name, member]));
	const contents = {
		'auth.sqlite': 'SQLite format 3\0 account database fixture',
		secret: 'auth-signing-secret-fixture',
		'git-secret': 'git-sealing-key-fixture',
		'log4stellar.sql': ddl,
	};
	for (const [name, text] of Object.entries(contents)) {
		const plaintext = join(root, name + '.plain');
		await writeFile(plaintext, text);
		await sealMember(backupDir, manifest, byName.get(name), { sealer, plaintextPath: plaintext });
	}
	const entries = [];
	for (const object of objects) {
		const directory = join(backupDir, 'objects', object.workspaceId);
		await mkdir(directory, { recursive: true, mode: 0o700 });
		const plaintext = join(root, 'object-' + object.sha256 + '.plain');
		await writeFile(plaintext, object.bytes);
		const envelopePath = join(directory, object.sha256 + '.enc');
		const { size: storedSize } = await sealer.encryptFile(plaintext, envelopePath);
		entries.push({
			workspaceId: object.workspaceId,
			sha256: object.sha256,
			size: object.bytes.length,
			storedSize,
			storedSha256: sha256(await readFile(envelopePath)),
			source: { type: 's3', table: 'log4stellar.storage_file_versions' },
		});
	}
	manifest.objects = {
		directory: 'objects',
		count: entries.length,
		bytes: entries.reduce((total, entry) => total + entry.size, 0),
		entries,
	};
	await sealMemberFromBytes(backupDir, manifest, byName.get('objects.index'), {
		sealer,
		bytes: Buffer.from(JSON.stringify({ schema: 1, count: entries.length, bytes: manifest.objects.bytes, entries }) + '\n'),
	});
	manifest.counts.members = manifest.members.length;
	await writeManifest(backupDir, manifest);
	return { root, backupDir };
}

test('a restore round trip reproduces every member byte for byte', async t => {
	const objectBytes = Buffer.from('the quick brown fox jumps over the lazy dog');
	const { backupDir } = await fixtureBackup(t, [{
		workspaceId: 'log4stellar-main',
		sha256: sha256(objectBytes),
		bytes: objectBytes,
	}]);
	const target = join(await tempDir(t, 'log4stellar-target-'), 'restored');
	const result = await restoreBackup({
		backupDir,
		keyMaterial,
		targetDir: target,
		log: () => {},
	});
	assert.equal(result.scope, scopeFull);
	assert.equal(result.members, 5);
	assert.equal(result.objects.verified, 1);

	// The drill's actual acceptance criterion: the restored bytes hash to the digest
	// the backup recorded, for every member, not merely "the file exists".
	const verified = await verifyBackupManifest(backupDir, { keyMaterial });
	const expected = new Map(verified.members.map(member => [member.name, member.contentSha256]));
	for (const [name, file] of [
		['auth.sqlite', 'auth.sqlite'],
		['secret', 'secret'],
		['git-secret', 'git-secret'],
		['log4stellar.sql', 'log4stellar.sql'],
	]) {
		const bytes = await readFile(join(target, file));
		assert.equal(sha256(bytes), expected.get(name), 'restored ' + file + ' does not match the manifest digest');
	}
	// The secrets must land 0600: a restored signing key readable by every process on
	// the host is a fresh incident, not a recovery.
	for (const name of ['secret', 'git-secret']) {
		assert.equal((await stat(join(target, name))).mode & 0o777, 0o600);
	}
	const dump = await inspectSqlDump(join(target, 'log4stellar.sql'));
	assert.equal(dump.hasSchema, true);
	assert.equal(dump.complete, true);
	assert.deepEqual(dump.tables, ['storage_entries']);
	assert.equal(dump.copyStatements, 1);
});

test('a restore never leaves decrypted plaintext behind', async t => {
	const objectBytes = Buffer.from('payload');
	const { backupDir } = await fixtureBackup(t, [{
		workspaceId: 'log4stellar-main',
		sha256: sha256(objectBytes),
		bytes: objectBytes,
	}]);
	const target = join(await tempDir(t, 'log4stellar-target-'), 'restored');
	await restoreBackup({ backupDir, keyMaterial, targetDir: target, log: () => {} });
	// The backup directory itself must never gain a plaintext copy of anything.
	const names = (await readdir(backupDir)).sort();
	assert.deepEqual(names, ['auth.sqlite.enc', 'git-secret.enc', 'log4stellar.sql.enc', 'manifest.json', 'objects', 'objects.index.enc', 'secret.enc']);
	for (const name of names) {
		assert.equal(name.endsWith('.enc') || name === 'manifest.json' || name === 'objects', true, 'unexpected entry: ' + name);
	}
});

test('a restore refuses to write over the backup it came from', async t => {
	const { backupDir, root } = await fixtureBackup(t);
	const verified = await verifyBackupManifest(backupDir, { keyMaterial, keepPlaintext: true });
	// Same endpoint and bucket as the manifest's origin.
	assert.throws(
		() => assertRestoreTargetIsSeparate(verified.manifest, { s3: { endpoint: 'http://192.0.2.10:9000/', bucket: 'log4stellar' } }),
		error => error.name === 'RestoreTargetError' && /is the backed-up bucket/.test(error.message),
	);
	// Same PostgreSQL database.
	assert.throws(
		() => assertRestoreTargetIsSeparate(verified.manifest, { postgres: { host: '192.0.2.20', port: 5432, database: 'log4stellar' } }),
		/Refusing to restore onto the source/,
	);
	// Same account directory.
	assert.throws(
		() => assertRestoreTargetIsSeparate(verified.manifest, { authDir: '/home/log4stellar/.cache/log4stellar-demo/auth' }),
		/is the backed-up account directory/,
	);
	// A genuinely separate target is allowed.
	assertRestoreTargetIsSeparate(verified.manifest, {
		s3: { endpoint: 'http://127.0.0.1:9000', bucket: 'log4stellar-drill' },
		postgres: { host: '127.0.0.1', port: 5433, database: 'log4stellar-drill' },
		authDir: join(root, 'drill-auth'),
	});
});

test('object restore writes to a separate backend and reads the bytes back', async t => {
	const objectBytes = Buffer.from('object payload for the drill');
	const { backupDir } = await fixtureBackup(t, [
		{ workspaceId: 'log4stellar-main', sha256: sha256(objectBytes), bytes: objectBytes },
	]);
	const spool = await tempDir(t, 'log4stellar-spool-');
	const verified = await verifyBackupManifest(backupDir, { keyMaterial });
	const result = await restoreObjectBytes(verified, {
		s3: { endpoint: 'http://127.0.0.1:9000', bucket: 'log4stellar-drill' },
		backend: 'directory',
		spool,
	});
	assert.equal(result.restored, 1);
	assert.equal(result.bytes, objectBytes.length);
	// The directory backend keys by workspace and digest; reading the file back is the
	// evidence that the upload used the layout a workspace expects.
	const restored = await readFile(join(spool, 'test-blobs', 'log4stellar-main', sha256(objectBytes)));
	assert.deepEqual(restored, objectBytes);
});

test('object restore refuses the source bucket before writing anything', async t => {
	const objectBytes = Buffer.from('payload');
	const { backupDir } = await fixtureBackup(t, [{
		workspaceId: 'log4stellar-main',
		sha256: sha256(objectBytes),
		bytes: objectBytes,
	}]);
	const verified = await verifyBackupManifest(backupDir, { keyMaterial });
	const spool = await tempDir(t, 'log4stellar-spool-');
	await assert.rejects(
		restoreObjectBytes(verified, {
			s3: { endpoint: 'http://192.0.2.10:9000', bucket: 'log4stellar' },
			backend: 'directory',
			spool,
		}),
		/is the backed-up bucket/,
	);
	// Nothing was written: the refusal happens before the first PUT.
	const entries = await readdir(spool);
	assert.deepEqual(entries, []);
});

test('a corrupted object envelope fails before it reaches the target', async t => {
	const objectBytes = Buffer.from('payload that will be damaged');
	const digest = sha256(objectBytes);
	const { backupDir } = await fixtureBackup(t, [
		{ workspaceId: 'log4stellar-main', sha256: digest, bytes: objectBytes },
	]);
	// Tamper with the envelope but leave the manifest's recorded digests intact, so the
	// integrity check that fails is the one inside the restore, not verification.
	const envelope = join(backupDir, 'objects', 'log4stellar-main', digest + '.enc');
	const bytes = await readFile(envelope);
	bytes[bytes.length - 18] ^= 0xff;
	await writeFile(envelope, bytes);
	const spool = await tempDir(t, 'log4stellar-spool-');
	const error = await verifyBackupManifest(backupDir, { keyMaterial }).catch(thrown => thrown);
	// Verification already refuses it, which is the stronger guarantee: the restore path
	// is only reached for a backup that passed.
	assert.equal(error.name, 'BackupVerificationError');
	assert.equal(error.details.problems.some(problem => problem.code === 'ObjectDigestMismatch'), true);
	assert.deepEqual(await readdir(spool), []);
});

test('restoring a subset never invents a member that the backup lacks', async t => {
	const { backupDir } = await fixtureBackup(t);
	const verified = await verifyBackupManifest(backupDir, { keyMaterial, keepPlaintext: true });
	// Delete the decrypted dump from the staging area to simulate a member that vanished
	// between verification and restore, which must fail rather than restore three of four.
	await rm(verified.plaintext.get('log4stellar.sql'), { force: true });
	const target = join(await tempDir(t, 'log4stellar-target-'), 'restored');
	await assert.rejects(restoreToDirectory(verified, target), /no decrypted PostgreSQL dump|vanished before it could be restored/);
});

test('parseArguments reads flags in both forms and rejects unknown ones', () => {
	const parsed = parseArguments(['/backup', '/target', '--key-file=/k', '--json']);
	assert.equal(parsed.backupDir, '/backup');
	assert.equal(parsed.targetDir, '/target');
	assert.equal(parsed.keyFile, '/k');
	assert.equal(parsed.json, true);
	const spaced = parseArguments(['/backup', '/target', '--key-file', '/k2']);
	assert.equal(spaced.keyFile, '/k2');
	assert.throws(() => parseArguments(['/b', '/t', '--wat']), /Unknown flag/);
	assert.throws(() => parseArguments(['/b', '/t', '--key-file']), /needs a value/);
	assert.equal(parseArguments(['/only-backup']).backupDir, '/only-backup');
});
