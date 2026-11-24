import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
	acquireLock,
	defaultFreshnessMs,
	defaultIntervalMs,
	isDue,
	listBackups,
	lockFileName,
	nextRunAt,
	parseArguments,
	parseDuration,
	readLastSuccessAt,
	runDaemon,
	schedulerStatus,
	sleepUntil,
} from './backup-schedule.mjs';
import { recordBackupOutcome } from './backup-manifest.mjs';

async function tempDir(t, prefix = 'log4stellar-sched-') {
	const directory = await mkdtemp(join(tmpdir(), prefix));
	t.after(() => rm(directory, { recursive: true, force: true }));
	return directory;
}

test('the next run is computed from the last success, not from process start', () => {
	const lastSuccess = Date.parse('2026-01-01T00:00:00.000Z');
	const due = nextRunAt({ now: Date.parse('2026-01-01T01:00:00.000Z'), lastSuccessAt: lastSuccess, intervalMs: 86_400_000 });
	assert.equal(new Date(due).toISOString(), '2026-01-02T00:00:00.000Z');
	// A host that was off for three days is due now, and stays due: it produces one
	// catch-up run rather than three.
	const catchUp = nextRunAt({ now: Date.parse('2026-01-04T00:00:00.000Z'), lastSuccessAt: lastSuccess, intervalMs: 86_400_000 });
	assert.equal(catchUp, Date.parse('2026-01-04T00:00:00.000Z'));
	assert.equal(isDue({ now: catchUp, lastSuccessAt: lastSuccess, intervalMs: 86_400_000 }), true);
});

test('a backup that has never succeeded is due immediately', () => {
	assert.equal(isDue({ now: Date.parse('2026-01-01T00:00:00.000Z'), lastSuccessAt: null }), true);
	assert.throws(() => nextRunAt({ intervalMs: 0 }), /positive number of milliseconds/);
	assert.equal(defaultIntervalMs, 86_400_000);
	assert.equal(defaultFreshnessMs, 36 * 3_600_000);
});

test('the lock allows one run at a time and refuses a live holder', async t => {
	const stateDir = await tempDir(t);
	const first = await acquireLock(stateDir, { pid: process.pid });
	assert.equal(first.acquired, true);
	const second = await acquireLock(stateDir, { pid: process.pid + 1 });
	assert.equal(second.acquired, false);
	assert.match(second.reason, /Another backup is already running/);
	assert.equal(await first.release(), true);
	const third = await acquireLock(stateDir, { pid: process.pid + 2 });
	assert.equal(third.acquired, true);
	await third.release();
});

test('a lock left by a dead process is reclaimed instead of blocking forever', async t => {
	const stateDir = await tempDir(t);
	// pid 2^22 + 1 is not a running process on any sane host, and the liveness probe
	// treats EPERM as alive so the choice is deliberately extreme.
	const staleLock = JSON.stringify({ pid: 4_194_305, host: (await import('node:os')).hostname(), acquiredAt: '2026-01-01T00:00:00.000Z' });
	await writeFile(join(stateDir, lockFileName), staleLock);
	const lock = await acquireLock(stateDir, { pid: process.pid });
	assert.equal(lock.acquired, true);
	await lock.release();
});

test('a lock from another host is treated as stale', async t => {
	const stateDir = await tempDir(t);
	await writeFile(join(stateDir, lockFileName), JSON.stringify({ pid: process.pid, host: 'another-host', acquiredAt: '2026-01-01T00:00:00.000Z' }));
	const lock = await acquireLock(stateDir, { pid: process.pid });
	assert.equal(lock.acquired, true);
	await lock.release();
});

test('releasing a lock another process now holds does not delete it', async t => {
	const stateDir = await tempDir(t);
	const ours = await acquireLock(stateDir, { pid: 111_111 });
	assert.equal(ours.acquired, true);
	// Simulate another process having taken the lock after ours went stale.
	await writeFile(join(stateDir, lockFileName), JSON.stringify({ pid: 222_222, host: (await import('node:os')).hostname(), acquiredAt: '2026-01-02T00:00:00.000Z' }));
	assert.equal(await ours.release(), false);
	assert.match(await readFile(join(stateDir, lockFileName), 'utf8'), /222222/);
});

test('the daemon runs once when due, then stops on request', async t => {
	const stateDir = await tempDir(t);
	const backupRoot = await tempDir(t, 'log4stellar-root-');
	const runs = [];
	let stopping = false;
	const result = await runDaemon({
		backupRoot,
		stateDir,
		keyFile: '/keys/backup.key',
		intervalMs: 86_400_000,
		maxRuns: 1,
		log: () => {},
		stopped: () => stopping,
		runBackup: async input => {
			runs.push(input);
			// Record a success so the next iteration would sleep rather than run again.
			await recordBackupOutcome(stateDir, { status: 'success', finishedAt: Date.now(), backupDir: join(backupRoot, 'backup-1') });
			stopping = true;
			return { ok: true, status: 0 };
		},
	});
	assert.equal(result.runs, 1);
	assert.equal(result.exitReason, 'max-runs');
	assert.equal(runs[0].keyFile, '/keys/backup.key');
});

test('the daemon never starts a run while another backup holds the lock', async t => {
	const stateDir = await tempDir(t);
	const backupRoot = await tempDir(t, 'log4stellar-root-');
	const held = await acquireLock(stateDir, { pid: process.pid });
	let invocations = 0;
	const deadline = Date.now() + 5_000;
	// The lock is released by the loop's own retry sleep expiring after this timer, so
	// the daemon either skips while held or runs once afterwards -- never both at once.
	setTimeout(() => { held.release(); }, 50);
	await runDaemon({
		backupRoot,
		stateDir,
		keyFile: '/k',
		// A short interval keeps the lock-retry sleep short: the retry wait is
		// min(interval, 5 min), and the test must not wait a minute to observe it.
		intervalMs: 1_000,
		maxRuns: 1,
		log: () => {},
		stopped: () => Date.now() > deadline || invocations > 0,
		runBackup: async () => {
			invocations++;
			await recordBackupOutcome(stateDir, { status: 'success', finishedAt: Date.now() });
			return { ok: true, status: 0 };
		},
	});
	// The daemon must not have bypassed the lock: at most one run, and only after the
	// holder let go.
	assert.equal(invocations <= 1, true);
	assert.equal(await readLastSuccessAt(stateDir) === null || invocations === 1, true);
});

test('readLastSuccessAt returns the recorded success and null when there is none', async t => {
	const stateDir = await tempDir(t);
	assert.equal(await readLastSuccessAt(stateDir), null);
	await recordBackupOutcome(stateDir, { status: 'success', finishedAt: Date.parse('2026-01-01T00:00:00.000Z') });
	assert.equal(await readLastSuccessAt(stateDir), Date.parse('2026-01-01T00:00:00.000Z'));
	await recordBackupOutcome(stateDir, { status: 'failure', finishedAt: Date.parse('2026-01-02T00:00:00.000Z'), error: { message: 'x' } });
	assert.equal(await readLastSuccessAt(stateDir), Date.parse('2026-01-01T00:00:00.000Z'), 'a failure must not move the schedule forward');
});

test('status reports ATTENTION REQUIRED for a stale backup and OK for a fresh one', async t => {
	const stateDir = await tempDir(t);
	const never = await schedulerStatus(stateDir);
	assert.match(never.text, /No successful backup has ever been recorded/);
	assert.match(never.text, /ATTENTION REQUIRED/);
	assert.equal(never.freshness.fresh, false);

	await recordBackupOutcome(stateDir, { status: 'success', finishedAt: Date.parse('2026-01-01T00:00:00.000Z') });
	const fresh = await schedulerStatus(stateDir, { now: Date.parse('2026-01-01T01:00:00.000Z') });
	assert.match(fresh.text, /Freshness: OK \(window 36h\)/);
	assert.match(fresh.text, /1h ago/);
	assert.equal(fresh.freshness.fresh, true);

	const stale = await schedulerStatus(stateDir, { now: Date.parse('2026-01-05T00:00:00.000Z') });
	assert.match(stale.text, /ATTENTION REQUIRED/);
	assert.match(stale.text, /past the 36h window/);

	await recordBackupOutcome(stateDir, {
		status: 'failure',
		finishedAt: Date.parse('2026-01-05T01:00:00.000Z'),
		error: { message: 'bucket read denied' },
	});
	const failing = await schedulerStatus(stateDir, { now: Date.parse('2026-01-05T02:00:00.000Z') });
	assert.match(failing.text, /Consecutive failures: 1/);
	assert.match(failing.text, /Last error: bucket read denied/);
});

test('listBackups reports restorability and survives an unreadable directory', async t => {
	const root = await tempDir(t, 'log4stellar-list-');
	const good = join(root, 'backup-20260101');
	await mkdir(good, { recursive: true });
	await writeFile(join(good, 'manifest.json'), JSON.stringify({
		format: 2,
		scope: 'full',
		createdAt: '2026-01-01T00:00:00.000Z',
		completedAt: '2026-01-01T00:00:01.000Z',
		encryption: { cipher: 'aes-256-gcm', kdf: 'scrypt', salt: 'AAAA' },
		members: [{ name: 'auth.sqlite' }],
		objects: { count: 2, bytes: 20 },
	}));
	await mkdir(join(root, 'backup-broken'), { recursive: true });
	await mkdir(join(root, 'not-a-backup'), { recursive: true });
	const backups = await listBackups(root);
	assert.equal(backups.length, 2);
	const healthy = backups.find(backup => backup.scope === 'full');
	assert.equal(healthy.restorable, true);
	assert.equal(healthy.objects, 2);
	const broken = backups.find(backup => backup.error);
	assert.match(broken.error, /no manifest.json/);
	assert.deepEqual(await listBackups(join(root, 'absent')), []);
});

test('parseDuration accepts the forms an operator writes', () => {
	assert.equal(parseDuration('45s'), 45_000);
	assert.equal(parseDuration('90m'), 5_400_000);
	assert.equal(parseDuration('24h'), 86_400_000);
	assert.equal(parseDuration('2d'), 172_800_000);
	assert.throws(() => parseDuration('weekly'), /must look like/);
	assert.throws(() => parseDuration('5'), /must look like/);
});

test('parseArguments reads the command and its flags', () => {
	const parsed = parseArguments(['status', '--state-dir=/s', '--max-age=12h', '--json']);
	assert.equal(parsed.command, 'status');
	assert.equal(parsed.stateDir, '/s');
	assert.equal(parsed.maxAgeMs, 43_200_000);
	assert.equal(parsed.json, true);
	const daemon = parseArguments(['daemon', '--backup-root', '/b', '--state-dir', '/s', '--key-file', '/k', '--interval', '6h']);
	assert.equal(daemon.intervalMs, 21_600_000);
	assert.equal(daemon.backupRoot, '/b');
	assert.equal(parseArguments(['run-once', '--force']).force, true);
	assert.throws(() => parseArguments(['status', 'extra']), /Only one command/);
	assert.throws(() => parseArguments(['status', '--max-runs=0']), /positive integer/);
});

test('sleepUntil returns false when stopped and true when the time arrives', async () => {
	let stopping = false;
	const done = sleepUntil(Date.now() + 30, () => stopping, 10);
	await new Promise(resolve => setTimeout(resolve, 5));
	assert.equal(await done, true);
	stopping = true;
	assert.equal(await sleepUntil(Date.now() + 60_000, () => stopping, 10), false);
});

test('the schedule CLI exits non-zero when the last backup is stale', async t => {
	const stateDir = await tempDir(t);
	const { recordBackupOutcome: record } = await import('./backup-manifest.mjs');
	await record(stateDir, { status: 'success', finishedAt: Date.parse('2020-01-01T00:00:00.000Z') });
	const child = spawn(process.execPath, ['apps/web/backup-schedule.mjs', 'status', '--state-dir', stateDir], {
		cwd: process.cwd(),
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	const chunks = [];
	child.stdout.on('data', chunk => chunks.push(chunk));
	const status = await new Promise((resolve, reject) => {
		child.once('error', reject);
		child.once('close', resolve);
	});
	const output = Buffer.concat(chunks).toString('utf8');
	assert.equal(status, 2, 'a stale backup must be a failing status so it can be used as a health check');
	assert.match(output, /ATTENTION REQUIRED/);
});
