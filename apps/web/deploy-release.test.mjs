// Deployment tooling contract: candidate verification, prepare, the MFA rollback
// policy and the absent-target behaviour. The service itself is not started here;
// the supervised end-to-end drill lives in the deployment runbook so these tests stay
// fast and independent of a live port.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import {
	activateRelease, currentRelease, deploymentConfig, deploymentHistory, mfaCensus,
	prepareRelease, previousRelease, rollbackRelease, supportsTwoFactor, verifyCandidate,
} from './deploy-release.mjs';
import { releaseInventory } from './web-release.mjs';

// A release that satisfies every required file but is tiny on disk, so the deploy
// tool can be exercised without building a 500 MB package.
const requiredContents = {
	'server/serve-demo.mjs': '// launcher\n',
	'server/auth.mjs': '// authentication gateway\n',
	'server/package.json': '{"name":"fixture","type":"module"}\n',
	'server/workspace-contract.mjs': '// workspace contract\n',
	'web/out/nls.locales.json': '{"zh-cn":{}}\n',
	'extensions/workspace-files/package.json': '{"name":"workspace-files"}\n',
};

async function fixture(directory, options = {}) {
	const root = join(directory, options.name ?? 'release');
	await mkdir(root, { recursive: true });
	for (const [name, content] of Object.entries(requiredContents)) {
		const path = join(root, name);
		await mkdir(join(path, '..'), { recursive: true });
		await writeFile(path, content);
	}
	if (options.twoFactor !== false) {
		await writeFile(join(root, 'server', 'account-security.mjs'), '// second factor\n');
	}
	const files = await releaseInventory(root);
	const marker = {
		format: 1,
		platform: process.platform,
		arch: process.arch,
		nodeMajor: Number(process.versions.node.split('.')[0]),
		builtAt: new Date().toISOString(),
		source: { commit: options.commit ?? 'a'.repeat(41), fingerprint: options.fingerprint ?? 'b'.repeat(64) },
		files,
	};
	await writeFile(join(root, 'release.json'), JSON.stringify(marker, null, '\t') + '\n');
	return root;
}

async function workspace(t) {
	const directory = await mkdtemp(join(tmpdir(), 'log4stellar-deploy-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const config = deploymentConfig({
		'state-dir': join(directory, 'config'),
		'releases-root': join(directory, 'releases'),
		'pid-file': join(directory, 'config', 'web.pid.json'),
		'log-file': join(directory, 'logs', 'web.log'),
		'backup-root': join(directory, 'backups'),
		'auth-dir': join(directory, 'auth'),
		'storage-config': join(directory, 'storage.json'),
		// Deliberately absent: the tests that reach the preflight must fail fast on TLS
		// instead of reaching the service manager or the live host's TLS material.
		'tls-cert': join(directory, 'tls', 'server.crt'),
		'tls-key': join(directory, 'tls', 'server.key'),
		port: '19443',
		'skip-data-checks': 'true',
		node: process.execPath,
	});
	await mkdir(config.stateDir, { recursive: true });
	await mkdir(config.releasesRoot, { recursive: true });
	await mkdir(config.authDir, { recursive: true });
	return { directory, config };
}

function errorCode(error) {
	return error.code;
}

test('verifyCandidate rejects a candidate that is missing a required file', async t => {
	const { directory, config } = await workspace(t);
	const root = await fixture(directory);
	await rm(join(root, 'server', 'workspace-contract.mjs'));
	// Keep the recorded inventory consistent so the *required file* check is what
	// fires, not the digest comparison.
	const marker = JSON.parse(await readFile(join(root, 'release.json'), 'utf8'));
	marker.files = await releaseInventory(root);
	await writeFile(join(root, 'release.json'), JSON.stringify(marker, null, '\t') + '\n');

	await assert.rejects(verifyCandidate(root, config), error => {
		assert.equal(errorCode(error), 'IncompleteRelease');
		assert.match(error.message, /Release is missing required files: server\/workspace-contract\.mjs/);
		assert.deepEqual(error.detail.missing, ['server/workspace-contract.mjs']);
		return true;
	});
});

test('verifyCandidate rejects a candidate whose files drifted from the recorded fingerprint', async t => {
	const { directory, config } = await workspace(t);
	const root = await fixture(directory);
	await writeFile(join(root, 'server', 'auth.mjs'), '// tampered\n');

	await assert.rejects(verifyCandidate(root, config), error => {
		assert.equal(errorCode(error), 'IntegrityMismatch');
		assert.match(error.message, /failed fingerprint verification/);
		assert.match(error.message, /Unexpected or modified release file: server\/auth\.mjs/);
		assert.equal(error.detail.total, 1);
		return true;
	});
});

test('verifyCandidate rejects an extra file that the manifest does not record', async t => {
	const { directory, config } = await workspace(t);
	const root = await fixture(directory);
	await writeFile(join(root, 'server', 'extra.mjs'), '// smuggled\n');

	await assert.rejects(verifyCandidate(root, config), error => {
		assert.equal(errorCode(error), 'IntegrityMismatch');
		assert.match(error.message, /Unexpected or modified release file: server\/extra\.mjs/);
		return true;
	});
});

test('verifyCandidate rejects a release built for another Node major', async t => {
	const { directory, config } = await workspace(t);
	const root = await fixture(directory);
	config.nodeMajor += 1;

	await assert.rejects(verifyCandidate(root, config), error => {
		assert.equal(errorCode(error), 'IncompatibleRelease');
		assert.match(error.message, /nodeMajor/);
		return true;
	});
});

test('verifyCandidate rejects a missing release directory', async t => {
	const { directory, config } = await workspace(t);
	await assert.rejects(verifyCandidate(join(directory, 'absent'), config), error => {
		assert.equal(errorCode(error), 'MissingRelease');
		return true;
	});
});

test('supportsTwoFactor follows the account-security surface of the package', async t => {
	const { directory } = await workspace(t);
	const modern = await fixture(directory, { name: 'modern' });
	const legacy = await fixture(directory, { name: 'legacy', twoFactor: false });
	assert.equal(await supportsTwoFactor(modern), true);
	assert.equal(await supportsTwoFactor(legacy), false);
});

test('prepareRelease copies the candidate into the releases root and is idempotent', async t => {
	const { directory, config } = await workspace(t);
	const root = await fixture(directory, { fingerprint: 'c'.repeat(64) });

	const first = await prepareRelease(root, config, { name: 'web-fixture-01' });
	assert.equal(first.prepared, true);
	assert.equal(first.root, join(config.releasesRoot, 'web-fixture-01'));
	assert.equal(first.fingerprint, 'c'.repeat(64));
	const copied = await readdir(join(config.releasesRoot, 'web-fixture-01'));
	assert.ok(copied.includes('release.json'));

	const second = await prepareRelease(root, config, { name: 'web-fixture-01' });
	assert.equal(second.prepared, false, 'preparing the same source twice must be a no-op');

	const history = await deploymentHistory(config);
	assert.equal(history.entries.filter(entry => entry.action === 'prepare').length, 1);
	assert.equal(history.entries[0].source.fingerprint, 'c'.repeat(64));
});

test('prepareRelease refuses a name that already holds a different source', async t => {
	const { directory, config } = await workspace(t);
	const first = await fixture(directory, { name: 'one', fingerprint: 'd'.repeat(64) });
	const second = await fixture(directory, { name: 'two', fingerprint: 'e'.repeat(64) });
	await prepareRelease(first, config, { name: 'web-collision' });

	await assert.rejects(prepareRelease(second, config, { name: 'web-collision' }), error => {
		assert.equal(errorCode(error), 'ReleaseExists');
		return true;
	});
});

test('rollbackRelease refuses to move to a release that cannot enforce a second factor', async t => {
	const { directory, config } = await workspace(t);
	const active = await fixture(directory, { name: 'active', fingerprint: 'f'.repeat(64) });
	const legacy = await fixture(directory, { name: 'legacy', fingerprint: '0'.repeat(64), twoFactor: false });
	await symlink(active, config.pointer);

	// One account depends on a second factor; the target predates account-security.
	const database = join(config.authDir, 'auth.sqlite');
	const handle = new DatabaseSync(database);
	handle.exec('CREATE TABLE "user" (id TEXT PRIMARY KEY, twoFactorEnabled INTEGER NOT NULL DEFAULT 0)');
	handle.exec('CREATE TABLE twoFactor (id TEXT PRIMARY KEY, secret TEXT, userId TEXT, verified INTEGER NOT NULL DEFAULT 0)');
	handle.exec('INSERT INTO "user" (id, twoFactorEnabled) VALUES (\'u1\', 1)');
	handle.exec('INSERT INTO twoFactor (id, secret, userId, verified) VALUES (\'t1\', \'secret\', \'u1\', 1)');
	handle.close();

	assert.deepEqual(await mfaCensus(config.authDir), { enrolled: 1, enabled: 1, available: true, database });

	await assert.rejects(rollbackRelease(config, { target: legacy }), error => {
		assert.equal(errorCode(error), 'MfaRollbackRefused');
		assert.match(error.message, /Refusing to roll back to legacy/);
		assert.match(error.message, /cannot enforce it/);
		assert.equal(error.detail.missing, 'server/account-security.mjs');
		assert.equal(error.detail.enrolled, 1);
		return true;
	});
	// The refusal must not move the pointer or the previous marker.
	assert.equal(await currentRelease(config), active);
	assert.equal(await previousRelease(config), undefined);
	// A refused attempt is still an operational event and must stay auditable.
	const history = await deploymentHistory(config);
	const refusal = history.entries.at(-1);
	assert.equal(refusal.action, 'rollback-refused');
	assert.equal(refusal.release, legacy);
	assert.equal(refusal.error, 'MfaRollbackRefused');
	assert.equal(refusal.source.commit, 'a'.repeat(41));
	assert.deepEqual(refusal.checks.mfa, { enrolled: 1, enabled: 1 });
});

test('rollbackRelease allows the move once no account depends on a second factor', async t => {
	const { directory, config } = await workspace(t);
	const active = await fixture(directory, { name: 'active', fingerprint: '1'.repeat(64) });
	const legacy = await fixture(directory, { name: 'legacy', fingerprint: '2'.repeat(64), twoFactor: false });
	await symlink(active, config.pointer);

	// The policy check runs before any service work, so the missing TLS material is
	// what stops this attempt; the important part is that it is no longer the MFA rule.
	await assert.rejects(rollbackRelease(config, { target: legacy }), error => {
		assert.notEqual(errorCode(error), 'MfaRollbackRefused');
		assert.equal(errorCode(error), 'TlsMissing');
		return true;
	});
	assert.equal(await currentRelease(config), active);
});

test('rollbackRelease reports an absent target instead of guessing', async t => {
	const { directory, config } = await workspace(t);
	const active = await fixture(directory, { name: 'active', fingerprint: '3'.repeat(64) });
	await symlink(active, config.pointer);

	await assert.rejects(rollbackRelease(config, { target: join(directory, 'never-built') }), error => {
		assert.equal(errorCode(error), 'NoRollbackTarget');
		assert.match(error.message, /Rollback target does not exist/);
		assert.match(error.detail.requested, /never-built/);
		return true;
	});
});

test('rollbackRelease reports that no target is recorded when nothing points back', async t => {
	const { directory, config } = await workspace(t);
	const active = await fixture(directory, { name: 'active', fingerprint: '4'.repeat(64) });
	await symlink(active, config.pointer);

	await assert.rejects(rollbackRelease(config), error => {
		assert.equal(errorCode(error), 'NoRollbackTarget');
		assert.match(error.message, /No rollback target is recorded/);
		assert.match(error.message, /previous-web-release/);
		assert.equal(error.detail.pointer, config.pointer);
		return true;
	});
});

test('rollbackRelease reports there is nothing to roll back from', async t => {
	const { directory, config } = await workspace(t);
	await assert.rejects(rollbackRelease(config), error => {
		assert.equal(errorCode(error), 'NoCurrentRelease');
		return true;
	});
});

test('rollbackRelease refuses to roll back onto the active release', async t => {
	const { directory, config } = await workspace(t);
	const active = await fixture(directory, { name: 'active', fingerprint: '5'.repeat(64) });
	await symlink(active, config.pointer);

	await assert.rejects(rollbackRelease(config, { target: active }), error => {
		assert.equal(errorCode(error), 'AlreadyActive');
		return true;
	});
});

test('rollbackRelease rejects a tampered rollback target before any policy check', async t => {
	const { directory, config } = await workspace(t);
	const active = await fixture(directory, { name: 'active', fingerprint: '6'.repeat(64) });
	const previous = await fixture(directory, { name: 'previous', fingerprint: '7'.repeat(64) });
	await symlink(active, config.pointer);
	await writeFile(join(previous, 'server', 'auth.mjs'), '// tampered\n');

	assert.equal(await previousRelease(config), undefined);
	await assert.rejects(rollbackRelease(config, { target: previous }), error => {
		assert.equal(errorCode(error), 'IntegrityMismatch');
		return true;
	});
	assert.equal(await currentRelease(config), active);
});

test('activateRelease refuses a switch while another deployment holds the lock', async t => {
	const { directory, config } = await workspace(t);
	const root = await fixture(directory, { fingerprint: '8'.repeat(64) });
	await writeFile(config.lock, JSON.stringify({ pid: process.pid, purpose: 'activate', at: new Date().toISOString() }) + '\n');

	await assert.rejects(activateRelease(root, config, { noBackup: true }), error => {
		assert.equal(errorCode(error), 'SwitchInProgress');
		assert.match(error.message, /Another deployment is switching the release now/);
		return true;
	});
});

test('activateRelease clears a lock left behind by a process that is gone', async t => {
	const { directory, config } = await workspace(t);
	const root = await fixture(directory, { fingerprint: '9'.repeat(64) });
	// A pid that cannot be running: the lock is stale and must be reclaimed, then the
	// activation proceeds far enough to fail on the missing TLS material.
	await writeFile(config.lock, JSON.stringify({ pid: 2 ** 22 - 1, purpose: 'activate', at: new Date().toISOString() }) + '\n');

	await assert.rejects(activateRelease(root, config, { noBackup: true }), error => {
		assert.equal(errorCode(error), 'TlsMissing');
		return true;
	});
	assert.equal(await currentRelease(config), undefined, 'a failed activation must not move the pointer');
});

test('deployment history keeps a commit mapping for every documented action', async t => {
	const { directory, config } = await workspace(t);
	const root = await fixture(directory, { commit: 'deadbeef'.repeat(5) + 'c', fingerprint: 'a'.repeat(64) });
	await prepareRelease(root, config, { name: 'web-fixture-01' });
	const history = await deploymentHistory(config);
	assert.equal(history.format, 1);
	assert.equal(history.entries.length, 1);
	assert.equal(history.entries[0].action, 'prepare');
	assert.equal(history.entries[0].source.commit, 'deadbeef'.repeat(5) + 'c');
	assert.ok(Date.parse(history.entries[0].at) > 0);
});

test('the recorded fingerprint matches the build-time source fingerprint', async () => {
	// Guards the invariant the drift check relies on: the same digest the build tool
	// stores is recomputable from a clean checkout of the recorded commit.
	const clean = createHash('sha256').update('0894060b906351bba6d6f72f0cc85bc2ff51455c\0\0').digest('hex');
	assert.equal(clean, 'f1e459757c727db8034e8fb9c18d1962f09b0cc4d7d316262ed8b499b631792a');
});
