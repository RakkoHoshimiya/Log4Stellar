import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
	BackupVerificationError,
	RestoreTargetError,
	defaultMaxAgeMs,
	digestBytes,
	formatDuration,
	manifestFormat,
	planBackupScope,
	pruneBackups,
	readManifest,
	recordBackupOutcome,
	requiredMembersFor,
	scopeFull,
	scopeLimited,
	sealMember,
	sealMemberFromBytes,
	verifyBackupManifest,
	checkBackupFreshness,
	writeManifest,
} from './backup-manifest.mjs';
import { backupCipher, isEncryptedFile, openSealer, reopenSealer, resolveKeyMaterial, writeKeyFile } from './backup-cipher.mjs';

const keyMaterial = Buffer.from('test-key-material-0123456789abcdef', 'utf8');

async function tempDir(t, prefix = 'log4stellar-backup-') {
	const directory = await mkdtemp(join(tmpdir(), prefix));
	t.after(() => rm(directory, { recursive: true, force: true }));
	return directory;
}

/**
 * Builds a small but structurally complete backup under `directory`.
 *
 * It writes real encrypted members rather than fixture bytes, because every test here
 * asserts something about verification, and verification of a hand-written manifest
 * would only test the test.
 */
async function fixtureBackup(t, options = {}) {
	const root = await tempDir(t);
	const backupDir = join(root, 'backup-20260101-000000');
	await mkdir(backupDir, { recursive: true, mode: 0o700 });
	const sealer = await openSealer(keyMaterial);
	const manifest = {
		format: manifestFormat,
		schema: 1,
		backupId: 'backup-20260101-000000',
		scope: options.scope ?? scopeFull,
		createdAt: '2026-01-01T00:00:00.000Z',
		completedAt: '2026-01-01T00:00:10.000Z',
		encryption: sealer.encryption,
		origin: {
			s3: { endpoint: 'http://192.0.2.10:9000', bucket: 'log4stellar' },
			postgres: { host: '192.0.2.20', port: 5432, database: 'log4stellar' },
		},
		counts: { members: 0 },
		members: [],
		objects: { directory: 'objects', count: 0, bytes: 0, entries: [] },
		notes: [],
	};
	const plan = planBackupScope({
		scope: manifest.scope,
		authDir: join(root, 'auth'),
		configDir: join(root, 'config'),
	});
	const byName = new Map(plan.members.map(member => [member.name, member]));
	for (const [name, contents] of Object.entries(options.contents ?? {})) {
		const member = byName.get(name);
		assert.ok(member, 'the fixture asked for a member the contract does not declare: ' + name);
		const plaintext = join(root, name.replace(/\//g, '-') + '.plain');
		await writeFile(plaintext, contents);
		await sealMember(backupDir, manifest, member, { sealer, plaintextPath: plaintext });
	}
	const index = Buffer.from(JSON.stringify({ schema: 1, count: manifest.objects.count, bytes: manifest.objects.bytes, entries: [] }) + '\n');
	await sealMemberFromBytes(backupDir, manifest, byName.get('objects.index'), { sealer, bytes: index });
	manifest.counts.members = manifest.members.length;
	await writeManifest(backupDir, manifest);
	return { root, backupDir, manifest, sealer };
}

test('planBackupScope requires every mandatory member for a full backup', () => {
	const plan = planBackupScope({ scope: scopeFull, authDir: '/a', configDir: '/c', settings: { s3: { endpoint: 'http://s', bucket: 'b' } } });
	const names = plan.members.map(member => member.name);
	assert.deepEqual(names.slice(0, 5), ['auth.sqlite', 'secret', 'git-secret', 'log4stellar.sql', 'objects.index']);
	assert.equal(plan.exportObjects, true);
	// The plan must record provenance, not just names: an operator recovering from a
	// report needs to know which member came out of which file or table.
	const postgres = plan.members.find(member => member.name === 'log4stellar.sql');
	assert.equal(postgres.source.type, 'postgres');
	assert.equal(postgres.source.schema, 'log4stellar');
	assert.ok(postgres.source.tables.includes('storage_file_versions'));
	const gitSecret = plan.members.find(member => member.name === 'git-secret');
	assert.equal(gitSecret.source.type, 'file');
	assert.equal(gitSecret.source.path, '/c/git-secret');
});

test('a full backup refuses to plan without the object export', () => {
	assert.throws(
		() => planBackupScope({ scope: scopeFull, exportObjects: false }),
		/A full backup must export the referenced objects/,
	);
	assert.throws(() => planBackupScope({ scope: 'everything' }), /must be "full" or "limited"/);
});

test('a limited backup warns that it cannot restore file contents', () => {
	const plan = planBackupScope({ scope: scopeLimited });
	assert.equal(plan.exportObjects, false);
	assert.equal(plan.objects.required, false);
	assert.match(plan.warnings.join(' '), /cannot restore file contents/);
});

test('a deployment file name may not escape the config directory', () => {
	assert.throws(() => planBackupScope({ scope: scopeFull, deploymentFiles: ['../etc/passwd'] }), /plain file name/);
	assert.throws(() => planBackupScope({ scope: scopeFull, deploymentFiles: ['/etc/passwd'] }), /plain file name/);
});

test('requiredMembersFor never depends on a manifest', () => {
	assert.deepEqual(requiredMembersFor(scopeFull), ['auth.sqlite', 'secret', 'git-secret', 'log4stellar.sql', 'objects.index']);
	assert.deepEqual(requiredMembersFor(scopeLimited), requiredMembersFor(scopeFull));
	assert.throws(() => requiredMembersFor('partial'), /Unknown backup scope/);
});

test('a complete backup verifies, and verification returns provenance for each member', async t => {
	const { backupDir } = await fixtureBackup(t, {
		contents: {
			'auth.sqlite': 'sqlite-bytes',
			secret: 'auth-secret-bytes',
			'git-secret': 'git-secret-bytes',
			'log4stellar.sql': 'CREATE SCHEMA log4stellar;\n',
		},
	});
	const verified = await verifyBackupManifest(backupDir, { keyMaterial });
	assert.equal(verified.scope, scopeFull);
	assert.equal(verified.members.length, 5);
	for (const member of verified.members) {
		assert.equal(member.source.type === 'file' || member.source.type === 'postgres', true);
		assert.match(member.sha256, /^[0-9a-f]{64}$/);
		assert.match(member.contentSha256, /^[0-9a-f]{64}$/);
	}
});

test('verification fails loudly when a required member is missing from the manifest', async t => {
	const { backupDir } = await fixtureBackup(t, {
		contents: { 'auth.sqlite': 'a', secret: 'b', 'git-secret': 'c', 'log4stellar.sql': 'd' },
	});
	// Drop the PostgreSQL dump from both the manifest and the disk, which is what a
	// truncated run looks like.
	const manifest = JSON.parse(await readFile(join(backupDir, 'manifest.json'), 'utf8'));
	const removed = manifest.members.find(member => member.name === 'log4stellar.sql');
	assert.ok(removed, 'the fixture must have written the PostgreSQL dump');
	manifest.members = manifest.members.filter(member => member.name !== 'log4stellar.sql');
	await rm(join(backupDir, removed.file), { force: true });
	await writeManifest(backupDir, manifest);

	const error = await verifyBackupManifest(backupDir, { keyMaterial }).catch(thrown => thrown);
	assert.ok(error instanceof BackupVerificationError);
	assert.equal(error.details.problems.some(problem => problem.code === 'MemberMissing'
		&& problem.message.includes('log4stellar.sql')), true);
});

test('verification fails loudly when a member file on disk is missing', async t => {
	const { backupDir } = await fixtureBackup(t, {
		contents: { 'auth.sqlite': 'a', secret: 'b', 'git-secret': 'c', 'log4stellar.sql': 'd' },
	});
	const manifest = JSON.parse(await readFile(join(backupDir, 'manifest.json'), 'utf8'));
	const secretMember = manifest.members.find(member => member.name === 'secret');
	await rm(join(backupDir, secretMember.file), { force: true });
	const error = await verifyBackupManifest(backupDir, { keyMaterial }).catch(thrown => thrown);
	assert.equal(error.details.problems.some(problem => problem.code === 'MemberMissing'), true);
});

test('verification detects a flipped byte without needing the key', async t => {
	const { backupDir } = await fixtureBackup(t, {
		contents: { 'auth.sqlite': 'a'.repeat(64), secret: 'b', 'git-secret': 'c', 'log4stellar.sql': 'd' },
	});
	const manifest = JSON.parse(await readFile(join(backupDir, 'manifest.json'), 'utf8'));
	const member = manifest.members.find(entry => entry.name === 'secret');
	const path = join(backupDir, member.file);
	const bytes = await readFile(path);
	bytes[bytes.length - 1] ^= 0xff;
	await writeFile(path, bytes);

	// No key: the ciphertext digest alone must catch it, otherwise a corrupted backup
	// would only be discovered by an operator who happened to have the key handy.
	const error = await verifyBackupManifest(backupDir, {}).catch(thrown => thrown);
	assert.equal(error.details.problems[0].code, 'DigestMismatch');
	assert.match(error.message, /secret/);
});

test('verification detects a swapped member of equal size only with the key', async t => {
	const { backupDir } = await fixtureBackup(t, {
		contents: { 'auth.sqlite': 'aaaa', secret: 'bbbb', 'git-secret': 'cccc', 'log4stellar.sql': 'dddd' },
	});
	const manifest = JSON.parse(await readFile(join(backupDir, 'manifest.json'), 'utf8'));
	const first = manifest.members.find(entry => entry.name === 'secret');
	const second = manifest.members.find(entry => entry.name === 'git-secret');
	// Swap the files and correct the ciphertext digests, so only a key-holding
	// verification can tell that "secret" is no longer the account signing key.
	const firstBytes = await readFile(join(backupDir, first.file));
	const secondBytes = await readFile(join(backupDir, second.file));
	await writeFile(join(backupDir, first.file), secondBytes);
	await writeFile(join(backupDir, second.file), firstBytes);
	for (const [member, bytes] of [[first, secondBytes], [second, firstBytes]]) {
		member.sha256 = digestBytes(bytes);
		member.size = bytes.length;
	}
	await writeManifest(backupDir, manifest);
	const error = await verifyBackupManifest(backupDir, { keyMaterial }).catch(thrown => thrown);
	assert.ok(error instanceof BackupVerificationError);
	assert.equal(error.details.problems.some(problem => problem.code === 'ContentDigestMismatch'), true);
});

test('verification refuses a backup encrypted under a different key', async t => {
	const { backupDir } = await fixtureBackup(t, {
		contents: { 'auth.sqlite': 'a', secret: 'b', 'git-secret': 'c', 'log4stellar.sql': 'd' },
	});
	const error = await verifyBackupManifest(backupDir, {
		keyMaterial: Buffer.from('a-completely-different-passphrase', 'utf8'),
	}).catch(thrown => thrown);
	assert.equal(error.details.problems.some(problem => problem.code === 'DecryptionFailed'), true);
});

test('a metadata-only backup is refused unless the caller accepts it', async t => {
	const { backupDir } = await fixtureBackup(t, {
		scope: scopeLimited,
		contents: { 'auth.sqlite': 'a', secret: 'b', 'git-secret': 'c', 'log4stellar.sql': 'd' },
	});
	const refused = await verifyBackupManifest(backupDir, { keyMaterial }).catch(thrown => thrown);
	assert.equal(refused.details.problems.some(problem => problem.code === 'MetadataOnly'), true);
	const accepted = await verifyBackupManifest(backupDir, { keyMaterial, allowMetadataOnly: true });
	assert.equal(accepted.scope, scopeLimited);
});

test('a manifest format this build does not know is refused, not guessed', async t => {
	const { backupDir } = await fixtureBackup(t, {
		contents: { 'auth.sqlite': 'a', secret: 'b', 'git-secret': 'c', 'log4stellar.sql': 'd' },
	});
	const manifest = JSON.parse(await readFile(join(backupDir, 'manifest.json'), 'utf8'));
	manifest.format = 1;
	await writeManifest(backupDir, manifest);
	const error = await readManifest(backupDir).catch(thrown => thrown);
	assert.equal(error.code, 'ManifestUnsupported');
	assert.match(error.message, /restore a pre-v2 backup with the release that wrote it/);
});

test('an unsafe member path in a manifest is rejected', async t => {
	const { backupDir } = await fixtureBackup(t, {
		contents: { 'auth.sqlite': 'a', secret: 'b', 'git-secret': 'c', 'log4stellar.sql': 'd' },
	});
	const manifest = JSON.parse(await readFile(join(backupDir, 'manifest.json'), 'utf8'));
	manifest.members[0].file = '../../etc/passwd';
	await writeManifest(backupDir, manifest);
	const error = await verifyBackupManifest(backupDir, {}).catch(thrown => thrown);
	assert.equal(error.details.problems.some(problem => problem.code === 'MemberInvalid'), true);
});

test('an object missing from the export fails verification', async t => {
	const root = await tempDir(t);
	const backupDir = join(root, 'backup-x');
	await mkdir(backupDir, { recursive: true });
	const sealer = await openSealer(keyMaterial);
	const digest = createHash('sha256').update('hello').digest('hex');
	const manifest = {
		format: manifestFormat,
		scope: scopeFull,
		createdAt: '2026-01-01T00:00:00.000Z',
		completedAt: '2026-01-01T00:00:01.000Z',
		encryption: sealer.encryption,
		members: [],
		objects: {
			directory: 'objects',
			count: 1,
			bytes: 5,
			entries: [{
				workspaceId: 'log4stellar-main',
				sha256: digest,
				size: 5,
				storedSize: 999,
				storedSha256: digest,
				source: { type: 's3', table: 'log4stellar.storage_file_versions' },
			}],
		},
	};
	const plan = planBackupScope({ scope: scopeFull, authDir: join(root, 'a'), configDir: join(root, 'c') });
	const byName = new Map(plan.members.map(member => [member.name, member]));
	for (const name of ['auth.sqlite', 'secret', 'git-secret', 'log4stellar.sql']) {
		const plaintext = join(root, name + '.plain');
		await writeFile(plaintext, name);
		await sealMember(backupDir, manifest, byName.get(name), { sealer, plaintextPath: plaintext });
	}
	await sealMemberFromBytes(backupDir, manifest, byName.get('objects.index'), { sealer, bytes: Buffer.from('[]') });
	await writeManifest(backupDir, manifest);
	const error = await verifyBackupManifest(backupDir, {}).catch(thrown => thrown);
	assert.equal(error.details.problems.some(problem => problem.code === 'ObjectMissing'), true);
});

test('a manifest that drops objects is caught by the sealed index', async t => {
	const root = await tempDir(t);
	const backupDir = join(root, 'backup-x');
	await mkdir(backupDir, { recursive: true });
	const sealer = await openSealer(keyMaterial);
	const digest = createHash('sha256').update('hello').digest('hex');
	const entry = {
		workspaceId: 'log4stellar-main',
		sha256: digest,
		size: 5,
		storedSize: 999,
		storedSha256: digest,
		source: { type: 's3', table: 'log4stellar.storage_file_versions' },
	};
	const manifest = {
		format: manifestFormat,
		scope: scopeFull,
		createdAt: '2026-01-01T00:00:00.000Z',
		completedAt: '2026-01-01T00:00:01.000Z',
		encryption: sealer.encryption,
		members: [],
		objects: { directory: 'objects', count: 1, bytes: 5, entries: [entry] },
	};
	const plan = planBackupScope({ scope: scopeFull, authDir: join(root, 'a'), configDir: join(root, 'c') });
	const byName = new Map(plan.members.map(member => [member.name, member]));
	for (const name of ['auth.sqlite', 'secret', 'git-secret', 'log4stellar.sql']) {
		const plaintext = join(root, name + '.plain');
		await writeFile(plaintext, name);
		await sealMember(backupDir, manifest, byName.get(name), { sealer, plaintextPath: plaintext });
	}
	// The sealed index still lists the object; the manifest no longer does. Only the
	// cross-check between the two representations can see this edit.
	await sealMemberFromBytes(backupDir, manifest, byName.get('objects.index'), {
		sealer,
		bytes: Buffer.from(JSON.stringify({ schema: 1, count: 1, bytes: 5, entries: [entry] }) + '\n'),
	});
	manifest.objects = { directory: 'objects', count: 0, bytes: 0, entries: [] };
	await writeManifest(backupDir, manifest);
	const error = await verifyBackupManifest(backupDir, { keyMaterial }).catch(thrown => thrown);
	assert.equal(error.details.problems.some(problem => problem.code === 'ObjectIndexMismatch'), true);
});

test('recordBackupOutcome keeps the last success through a failure and raises an alert', async t => {
	const stateDir = await tempDir(t, 'log4stellar-state-');
	const success = await recordBackupOutcome(stateDir, {
		status: 'success',
		startedAt: Date.parse('2026-01-01T00:00:00.000Z'),
		finishedAt: Date.parse('2026-01-01T00:01:00.000Z'),
		backupDir: '/backups/backup-1',
		objects: 3,
		bytes: 30,
	});
	assert.equal(success.state.lastSuccess.backupDir, '/backups/backup-1');
	assert.equal(success.state.consecutiveFailures, 0);

	const failure = await recordBackupOutcome(stateDir, {
		status: 'failure',
		startedAt: Date.parse('2026-01-01T05:00:00.000Z'),
		finishedAt: Date.parse('2026-01-01T05:00:02.000Z'),
		error: { message: 'bucket read denied', code: 'AccessDenied' },
	});
	assert.equal(failure.state.lastSuccess.backupDir, '/backups/backup-1', 'a failure must not erase the last success');
	assert.equal(failure.state.consecutiveFailures, 1);
	assert.equal(failure.alert.message, 'bucket read denied');
	assert.equal(failure.alert.code, 'AccessDenied');

	const lines = (await readFile(join(stateDir, 'outcomes.jsonl'), 'utf8')).trim().split('\n');
	assert.equal(lines.length, 2);
	assert.equal(JSON.parse(lines[1]).status, 'failure');
	const alert = JSON.parse(await readFile(join(stateDir, 'alert.json'), 'utf8'));
	assert.equal(alert.consecutiveFailures, 1);
});

test('recordBackupOutcome refuses an unknown status', async t => {
	const stateDir = await tempDir(t, 'log4stellar-state-');
	await assert.rejects(recordBackupOutcome(stateDir, { status: 'maybe' }), /must be "success" or "failure"/);
});

test('freshness reports never, ok and stale with an operator-readable age', async t => {
	const stateDir = await tempDir(t, 'log4stellar-state-');
	const never = await checkBackupFreshness(stateDir);
	assert.equal(never.state, 'never');
	assert.equal(never.fresh, false);
	assert.match(never.reason, /No successful backup has ever been recorded/);

	await recordBackupOutcome(stateDir, {
		status: 'success',
		finishedAt: Date.parse('2026-01-01T00:00:00.000Z'),
	});
	const fresh = await checkBackupFreshness(stateDir, { now: Date.parse('2026-01-01T02:00:00.000Z') });
	assert.equal(fresh.state, 'ok');
	assert.equal(fresh.ageText, '2h');
	assert.equal(fresh.fresh, true);

	const stale = await checkBackupFreshness(stateDir, { now: Date.parse('2026-01-03T00:00:00.000Z') });
	assert.equal(stale.state, 'stale');
	assert.equal(stale.overdue, true);
	assert.equal(stale.ageText, '2d');
	assert.match(stale.reason, /past the 36h window/);
});

test('freshness honours a custom window and rejects a nonsensical one', async t => {
	const stateDir = await tempDir(t, 'log4stellar-state-');
	await recordBackupOutcome(stateDir, { status: 'success', finishedAt: Date.parse('2026-01-01T00:00:00.000Z') });
	const stale = await checkBackupFreshness(stateDir, { now: Date.parse('2026-01-01T00:30:00.000Z'), maxAgeMs: 60_000 });
	assert.equal(stale.state, 'stale');
	await assert.rejects(checkBackupFreshness(stateDir, { maxAgeMs: 0 }), /positive number of milliseconds/);
});

test('freshness reports consecutive failures without changing the last success age', async t => {
	const stateDir = await tempDir(t, 'log4stellar-state-');
	await recordBackupOutcome(stateDir, { status: 'success', finishedAt: Date.parse('2026-01-01T00:00:00.000Z') });
	for (let index = 0; index < 3; index++) {
		await recordBackupOutcome(stateDir, {
			status: 'failure',
			finishedAt: Date.parse('2026-01-01T03:0' + index + ':00.000Z'),
			error: { message: 'denied' },
		});
	}
	const freshness = await checkBackupFreshness(stateDir, { now: Date.parse('2026-01-01T04:00:00.000Z') });
	assert.equal(freshness.consecutiveFailures, 3);
	assert.equal(freshness.lastSuccessAt, '2026-01-01T00:00:00.000Z');
	assert.equal(freshness.ageText, '4h');
});

test('formatDuration reads the way an operator writes it', () => {
	assert.equal(formatDuration(45_000), '45s');
	assert.equal(formatDuration(60_000), '1m');
	assert.equal(formatDuration(90_000), '1m30s');
	assert.equal(formatDuration(2 * 3_600_000 + 13 * 60_000), '2h13m');
	assert.equal(formatDuration(50 * 3_600_000), '2d2h');
	assert.equal(defaultMaxAgeMs, 36 * 60 * 60 * 1000);
});

test('pruneBackups keeps the newest backup even when everything is past retention', async t => {
	const root = await tempDir(t, 'log4stellar-prune-');
	const sealer = await openSealer(keyMaterial);
	for (const [name, completedAt] of [
		['backup-20260101', '2026-01-01T00:00:00.000Z'],
		['backup-20260102', '2026-01-02T00:00:00.000Z'],
		['backup-20260103', '2026-01-03T00:00:00.000Z'],
	]) {
		const directory = join(root, name);
		await mkdir(directory, { recursive: true });
		await writeManifest(directory, {
			format: manifestFormat,
			scope: scopeFull,
			createdAt: completedAt,
			completedAt,
			encryption: sealer.encryption,
			members: [],
			objects: { directory: 'objects', count: 0, bytes: 0, entries: [] },
		});
	}
	await mkdir(join(root, 'not-a-backup'), { recursive: true });
	const result = await pruneBackups(root, { keep: 1, now: Date.parse('2026-06-01T00:00:00.000Z'), maxAgeMs: 1000 });
	assert.deepEqual(result.removed, ['backup-20260102', 'backup-20260101']);
	assert.deepEqual(result.kept, ['backup-20260103']);
	const remaining = (await readdir(root)).sort();
	assert.deepEqual(remaining, ['backup-20260103', 'not-a-backup']);
});

test('pruneBackups honours keep without deleting anything inside the window', async t => {
	const root = await tempDir(t, 'log4stellar-prune-');
	const sealer = await openSealer(keyMaterial);
	for (const day of ['01', '02', '03']) {
		const directory = join(root, 'backup-202601' + day);
		await mkdir(directory, { recursive: true });
		await writeManifest(directory, {
			format: manifestFormat,
			scope: scopeFull,
			createdAt: '2026-01-' + day + 'T00:00:00.000Z',
			completedAt: '2026-01-' + day + 'T00:00:00.000Z',
			encryption: sealer.encryption,
			members: [],
			objects: { directory: 'objects', count: 0, bytes: 0, entries: [] },
		});
	}
	const result = await pruneBackups(root, { keep: 2, now: Date.parse('2026-01-04T00:00:00.000Z'), maxAgeMs: 30 * 86_400_000 });
	assert.deepEqual(result.removed, ['backup-20260101']);
	assert.equal(result.kept.length, 2);
});

test('pruneBackups leaves a directory without a readable manifest alone', async t => {
	const root = await tempDir(t, 'log4stellar-prune-');
	await mkdir(join(root, 'backup-broken'), { recursive: true });
	await writeFile(join(root, 'backup-broken', 'manifest.json'), '{not json');
	const result = await pruneBackups(root, { keep: 1, maxAgeMs: 1, now: Date.parse('2030-01-01T00:00:00.000Z') });
	assert.deepEqual(result.removed, []);
	assert.equal(result.skipped.some(entry => entry.name === 'backup-broken'), true);
});

test('pruneBackups on a missing root is a no-op, not an error', async t => {
	const result = await pruneBackups(join(await tempDir(t), 'absent'));
	assert.deepEqual(result, { kept: [], removed: [], skipped: [] });
});

test('the sealer round-trips a file and refuses a wrong key or a tampered envelope', async t => {
	const root = await tempDir(t, 'log4stellar-cipher-');
	const plaintext = join(root, 'plain.bin');
	const doubled = Buffer.alloc(1024, 7);
	await writeFile(plaintext, doubled);
	const sealer = await openSealer(keyMaterial);
	const envelope = join(root, 'plain.enc');
	await sealer.encryptFile(plaintext, envelope);
	assert.equal(await isEncryptedFile(envelope), true);
	assert.notDeepEqual(await readFile(envelope), doubled, 'the envelope must not contain the plaintext');

	const reopened = await reopenSealer(keyMaterial, sealer.encryption);
	const out = join(root, 'out.bin');
	await reopened.decryptFile(envelope, out);
	assert.deepEqual(await readFile(out), doubled);

	await assert.rejects(
		reopenSealer(Buffer.from('wrong-key-material-abcdefgh', 'utf8'), sealer.encryption),
		// The key derives, so the failure surfaces at decrypt time rather than here;
		// assert the decrypt is what refuses, below.
	).catch(() => {});
	const wrong = await openSealer(Buffer.from('wrong-key-material-abcdefgh', 'utf8'), { salt: sealer.encryption.salt });
	await assert.rejects(wrong.decryptFile(envelope, join(root, 'nope.bin')), /unable to authenticate|bad decrypt|not a Log4Stellar/i);

	const bytes = await readFile(envelope);
	bytes[bytes.length - 20] ^= 0x01;
	await writeFile(envelope, bytes);
	await assert.rejects(reopened.decryptFile(envelope, join(root, 'tampered.bin')), /authenticate|bad decrypt/i);
});

test('the sealer uses one fresh salt per backup and one IV per file', async t => {
	const root = await tempDir(t, 'log4stellar-cipher-');
	const plaintext = join(root, 'p');
	await writeFile(plaintext, 'same bytes every time');
	const first = await openSealer(keyMaterial);
	const second = await openSealer(keyMaterial);
	assert.notEqual(first.encryption.salt, second.encryption.salt, 'each backup must get a fresh salt');
	await first.encryptFile(plaintext, join(root, 'a.enc'));
	await first.encryptFile(plaintext, join(root, 'b.enc'));
	// Identical plaintext must not produce identical ciphertext, or an observer could
	// tell which files in a workspace are duplicates.
	assert.notDeepEqual(await readFile(join(root, 'a.enc')), await readFile(join(root, 'b.enc')));
	assert.equal(first.encryption.cipher, backupCipher);
});

test('the sealer refuses to overwrite an existing destination', async t => {
	const root = await tempDir(t, 'log4stellar-cipher-');
	const plaintext = join(root, 'p');
	await writeFile(plaintext, 'x');
	const sealer = await openSealer(keyMaterial);
	const envelope = join(root, 'p.enc');
	await sealer.encryptFile(plaintext, envelope);
	await assert.rejects(sealer.encryptFile(plaintext, envelope), /EEXIST/);
});

test('key material must be provided and must be long enough', async () => {
	await assert.rejects(resolveKeyMaterial(undefined), /requires key material/);
	await assert.rejects(resolveKeyMaterial('short'), /at least 16 bytes/);
	const long = await resolveKeyMaterial('sixteen-bytes-ok');
	assert.equal(long.length, 16);
});

test('a key file is written 0600 and never overwritten', async t => {
	const root = await tempDir(t, 'log4stellar-key-');
	const keyFile = join(root, 'backup.key');
	const material = await writeKeyFile(keyFile);
	assert.ok(material.length >= 16);
	const info = await stat(keyFile);
	assert.equal(info.mode & 0o777, 0o600);
	await assert.rejects(writeKeyFile(keyFile), /EEXIST/);
	assert.equal((await readFile(keyFile, 'utf8')).trim(), material);
});

test('an empty plaintext member survives the round trip', async t => {
	const root = await tempDir(t, 'log4stellar-cipher-');
	const plaintext = join(root, 'empty');
	await writeFile(plaintext, '');
	const sealer = await openSealer(keyMaterial);
	await sealer.encryptFile(plaintext, join(root, 'empty.enc'));
	const out = join(root, 'empty.out');
	await (await reopenSealer(keyMaterial, sealer.encryption)).decryptFile(join(root, 'empty.enc'), out);
	assert.equal((await stat(out)).size, 0);
});
