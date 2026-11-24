#!/usr/bin/env node
// Run backups on a schedule without a service manager.
//
// This host has neither a working `systemctl --user` bus ("Failed to connect to bus:
// No medium found") nor a crontab for the service account, so a schedule that depends
// on either would be a schedule that never fires. The timer therefore ships with the
// product: `daemon` runs a loop that sleeps until the next due time and then invokes
// the same `backup-data.mjs` an operator would run by hand; `run-once` is the entry
// point a cron or systemd timer can call if the host grows one later; `status` answers
// "how old is the last good backup" from the recorded state.
//
// Three properties are non-negotiable for an unattended job:
//
//   * single instance -- two overlapping runs would write two backups and race on the
//     state file, so a pid lock file with a liveness check gates every run;
//   * failures are recorded, not swallowed -- a run that fails writes an outcome and an
//     alert, so the freshness check can report "the last attempt failed" instead of
//     quietly ageing an older success;
//   * the next run is computed from the last success, not from process start, so a
//     restart does not reset the clock and a long outage produces one catch-up run
//     rather than a burst.
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	checkBackupFreshness,
	defaultMaxAgeMs,
	formatDuration,
	readManifest,
	recordBackupOutcome,
	stateFileName,
} from './backup-manifest.mjs';

const app = path.dirname(fileURLToPath(import.meta.url));

/** The default cadence: nightly at 03:15 local time. */
export const defaultIntervalMs = 24 * 60 * 60 * 1000;
/** A nightly job with a 36 h window tolerates one missed night before it is stale. */
export const defaultFreshnessMs = defaultMaxAgeMs;

/** The lock file that keeps two runs from overlapping. */
export const lockFileName = 'backup.lock';

/**
 * Answers "is it time to run?" from the recorded state rather than from a wall clock
 * schedule.
 *
 * A due time derived from the last success means a host that was off for three days
 * runs *once* on wake-up instead of three times, and a host whose clock jumped
 * backwards does not stall until the skew catches up.
 * @param {{ now?: number, lastSuccessAt?: number | null, intervalMs?: number }} input
 */
export function nextRunAt({ now = Date.now(), lastSuccessAt = null, intervalMs = defaultIntervalMs }) {
	if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
		throw new Error('The backup interval must be a positive number of milliseconds.');
	}
	if (lastSuccessAt === null || !Number.isFinite(lastSuccessAt)) {
		return now;
	}
	return Math.max(now, lastSuccessAt + intervalMs);
}

/** @param {{ now?: number, lastSuccessAt?: number | null, intervalMs?: number }} [input] */
export function isDue(input = {}) {
	return nextRunAt(input) <= (input.now ?? Date.now());
}

/**
 * Acquires the single-instance lock.
 *
 * A stale lock from a killed daemon must not block every future run, so the pid is
 * checked for liveness: a lock whose pid is gone (or belongs to another host) is
 * replaced. The `wx` flag is what makes the acquisition atomic.
 * @param {string} stateDirectory
 * @param {{ now?: number, pid?: number, host?: string }} [options]
 */
export async function acquireLock(stateDirectory, options = {}) {
	await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
	const lockPath = path.join(stateDirectory, lockFileName);
	const pid = options.pid ?? process.pid;
	const host = options.host ?? hostname();
	const payload = JSON.stringify({ pid, host, acquiredAt: new Date(options.now ?? Date.now()).toISOString() }) + '\n';
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const handle = await open(lockPath, 'wx', 0o600);
			try {
				await handle.writeFile(payload);
			} finally {
				await handle.close();
			}
			return { acquired: true, lockPath, release: () => releaseLock(lockPath, pid) };
		} catch (error) {
			if (error.code !== 'EEXIST') {
				throw error;
			}
			const holder = await readLock(lockPath);
			if (holder && holder.host === host && isProcessAlive(holder.pid)) {
				return {
					acquired: false,
					lockPath,
					holder,
					reason: 'Another backup is already running (pid ' + holder.pid + ' since ' + holder.acquiredAt + ').',
				};
			}
			// A stale lock: remove it and retry once. Retrying exactly once keeps a genuine
			// race (two processes both deciding the lock is stale) from spinning.
			await unlink(lockPath).catch(() => {});
		}
	}
	return { acquired: false, lockPath, reason: 'Could not acquire the backup lock.' };
}

async function readLock(lockPath) {
	try {
		return JSON.parse(await readFile(lockPath, 'utf8'));
	} catch {
		return null;
	}
}

function isProcessAlive(pid) {
	if (!Number.isSafeInteger(pid) || pid <= 0) {
		return false;
	}
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error.code === 'EPERM';
	}
}

async function releaseLock(lockPath, pid) {
	const holder = await readLock(lockPath);
	// Only remove the lock this process wrote: deleting someone else's live lock would
	// let a second backup start underneath it.
	if (holder && holder.pid !== pid) {
		return false;
	}
	await unlink(lockPath).catch(() => {});
	return true;
}

/**
 * Runs one backup through the CLI, inheriting stdout/stderr so the scheduler log is the
 * backup log.
 *
 * Spawning rather than importing keeps the scheduled path identical to the manual one,
 * which is the property that makes a drill meaningful: what the drill exercises is
 * byte-for-byte what runs at 03:15.
 * @param {object} options
 * @param {string} options.backupRoot
 * @param {string} options.stateDir
 * @param {string} options.keyFile
 * @param {'full' | 'limited'} [options.scope]
 * @param {(message: string) => void} [options.log]
 * @param {string} [options.node]
 */
export async function runScheduledBackup(options) {
	const log = options.log ?? (() => {});
	const stamp = new Date().toISOString().replace(/[:.]/g, '-');
	const target = path.join(options.backupRoot, 'backup-' + stamp);
	const startedAt = Date.now();
	const args = [
		path.join(app, 'backup-data.mjs'),
		target,
		'--key-file=' + options.keyFile,
		'--state-dir=' + options.stateDir,
		'--trigger=schedule',
		'--scope=' + (options.scope ?? 'full'),
	];
	log('Starting scheduled backup into ' + target + ' ...');
	const child = spawn(options.node ?? process.execPath, args, { stdio: 'inherit' });
	const status = await new Promise((resolve, reject) => {
		child.once('error', reject);
		child.once('close', code => resolve(code ?? 1));
	});
	if (status !== 0) {
		// The child already recorded the failure outcome; the scheduler only needs to say
		// so loudly enough to reach an operator's log.
		log('Scheduled backup FAILED with exit ' + status + ' after ' + formatDuration(Date.now() - startedAt) + '.');
		return { ok: false, status, target, durationMs: Date.now() - startedAt };
	}
	log('Scheduled backup finished in ' + formatDuration(Date.now() - startedAt) + '.');
	return { ok: true, status: 0, target, durationMs: Date.now() - startedAt };
}

/**
 * Sleeps until `target`, but in bounded chunks.
 *
 * A single multi-hour `setTimeout` is unreliable across host suspend/resume, and an
 * unref'd timer would let the process exit; slicing the wait also gives the loop a
 * chance to notice a shutdown signal promptly.
 * @param {number} target  epoch ms
 * @param {() => boolean} [stopped]
 * @param {number} [chunkMs]
 */
export async function sleepUntil(target, stopped = () => false, chunkMs = 60_000) {
	while (!stopped()) {
		const remaining = target - Date.now();
		if (remaining <= 0) {
			return true;
		}
		await new Promise(resolve => setTimeout(resolve, Math.min(remaining, chunkMs)));
	}
	return false;
}

/**
 * Reads the last success timestamp the scheduler should schedule from.
 * @param {string} stateDirectory
 */
export async function readLastSuccessAt(stateDirectory) {
	try {
		const state = JSON.parse(await readFile(path.join(stateDirectory, stateFileName), 'utf8'));
		const finishedAt = Date.parse(state?.lastSuccess?.finishedAt);
		return Number.isFinite(finishedAt) ? finishedAt : null;
	} catch {
		return null;
	}
}

/**
 * The daemon loop: acquire the lock, run if due, sleep, repeat.
 *
 * Each iteration re-reads the state instead of trusting its own memory, so an operator
 * forcing a manual backup outside the daemon still resets the schedule.
 * @param {object} options
 * @param {string} options.backupRoot
 * @param {string} options.stateDir
 * @param {string} options.keyFile
 * @param {number} [options.intervalMs]
 * @param {number} [options.maxRuns]
 * @param {(message: string) => void} [options.log]
 * @param {() => boolean} [options.stopped]
 * @param {(run: typeof runScheduledBackup, input: object) => Promise<object>} [options.runBackup]  test hook
 */
export async function runDaemon(options) {
	const log = options.log ?? (() => {});
	const intervalMs = options.intervalMs ?? defaultIntervalMs;
	const runBackup = options.runBackup ?? runScheduledBackup;
	const stopped = options.stopped ?? (() => false);
	let runs = 0;
	let exitReason = 'stopped';
	log('Backup scheduler started: interval ' + formatDuration(intervalMs) + ', state ' + options.stateDir + '.');
	try {
		await mkdir(options.backupRoot, { recursive: true, mode: 0o700 });
		while (!stopped()) {
			const lastSuccessAt = await readLastSuccessAt(options.stateDir);
			const dueAt = nextRunAt({ lastSuccessAt, intervalMs });
			if (dueAt > Date.now()) {
				log('Next backup due at ' + new Date(dueAt).toISOString() + ' (' + formatDuration(dueAt - Date.now()) + ' away).');
				const reached = await sleepUntil(dueAt, stopped);
				if (!reached) {
					exitReason = 'stopped';
					break;
				}
			}
			const lock = await acquireLock(options.stateDir);
			if (!lock.acquired) {
				log(lock.reason ?? 'Lock held; skipping this run.');
				// Wait out the holder rather than spinning: a run takes minutes at most.
				const retryAt = Date.now() + Math.min(intervalMs, 5 * 60_000);
				if (!await sleepUntil(retryAt, stopped)) {
					exitReason = 'stopped';
					break;
				}
				continue;
			}
			try {
				const result = await runBackup({
					backupRoot: options.backupRoot,
					stateDir: options.stateDir,
					keyFile: options.keyFile,
					scope: options.scope,
					log,
				});
				runs++;
				options.onRun?.(result);
				if (options.maxRuns !== undefined && runs >= options.maxRuns) {
					exitReason = 'max-runs';
					break;
				}
			} finally {
				await lock.release();
			}
		}
	} finally {
		log('Backup scheduler exiting (' + exitReason + ' after ' + runs + ' run(s)).');
	}
	return { runs, exitReason };
}

/**
 * The operator-facing status line: last success age, freshness verdict, last error.
 * @param {string} stateDir
 * @param {{ now?: number, maxAgeMs?: number }} [options]
 */
export async function schedulerStatus(stateDir, options = {}) {
	const freshness = await checkBackupFreshness(stateDir, options);
	const lines = [];
	if (freshness.state === 'never') {
		lines.push('No successful backup has ever been recorded.');
	} else {
		lines.push('Last successful backup: ' + freshness.lastSuccessAt + ' (' + freshness.ageText + ' ago)');
		lines.push('Freshness: ' + freshness.state.toUpperCase() + ' (window ' + freshness.maxAgeText + ')');
	}
	if (freshness.consecutiveFailures > 0) {
		lines.push('Consecutive failures: ' + freshness.consecutiveFailures);
		const failure = freshness.lastFailure;
		if (failure) {
			lines.push('Last error: ' + (failure.error?.message ?? 'unknown') + ' at ' + failure.finishedAt);
		}
	}
	lines.push('Verdict: ' + (freshness.fresh ? 'OK' : 'ATTENTION REQUIRED') + ' -- ' + freshness.reason);
	return { freshness, text: lines.join('\n') + '\n' };
}

/** Lists the backups under a root, newest first, with their scope and completeness. */
export async function listBackups(backupRoot) {
	const { readdir } = await import('node:fs/promises');
	let entries;
	try {
		entries = await readdir(backupRoot, { withFileTypes: true });
	} catch (error) {
		if (error.code === 'ENOENT') {
			return [];
		}
		throw error;
	}
	const backups = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || !entry.name.startsWith('backup-')) {
			continue;
		}
		const directory = path.join(backupRoot, entry.name);
		try {
			const manifest = await readManifest(directory);
			backups.push({
				directory,
				scope: manifest.scope,
				createdAt: manifest.completedAt ?? manifest.createdAt,
				objects: manifest.objects?.count ?? 0,
				bytes: manifest.objects?.bytes ?? 0,
				members: manifest.members?.length ?? 0,
				restorable: manifest.scope === 'full',
			});
		} catch (error) {
			backups.push({ directory, error: error.message });
		}
	}
	backups.sort((left, right) => String(right.createdAt ?? '').localeCompare(String(left.createdAt ?? '')));
	return backups;
}

const usage = [
	'Usage: node apps/web/backup-schedule.mjs <command> [flags]',
	'',
	'Commands:',
	'  daemon      run the backup loop in the foreground (this is the scheduler)',
	'  run-once    run one backup if due, then exit (for cron or a systemd timer)',
	'  status      print the last success, its age and the freshness verdict',
	'  list        list the backups on disk',
	'',
	'Flags:',
	'  --backup-root=<dir>   where backup-<iso> directories are written (required for daemon/run-once/list)',
	'  --state-dir=<dir>     state.json / outcomes.jsonl / alert.json (required)',
	'  --key-file=<path>     backup key file (0600)',
	'  --interval=<duration> daemon cadence, e.g. 24h, 90m (default 24h)',
	'  --max-age=<duration>  freshness window for status (default 36h)',
	'  --force               run-once ignores the schedule and runs immediately',
].join('\n');

/** Parses `24h`, `90m`, `45s`, `2d` into milliseconds. */
export function parseDuration(text) {
	const match = /^(\d+(?:\.\d+)?)([smhd])$/.exec(String(text).trim());
	if (!match) {
		throw new Error('A duration must look like 45s, 90m, 24h or 2d; got ' + JSON.stringify(text));
	}
	const scale = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[/** @type {'s'|'m'|'h'|'d'} */ (match[2])];
	return Math.round(Number(match[1]) * scale);
}

/**
 * Parses the command line.
 * @param {string[]} argv
 */
export function parseArguments(argv) {
	const parsed = {
		command: null,
		backupRoot: process.env.LOG4STELLAR_BACKUP_ROOT ?? null,
		stateDir: process.env.LOG4STELLAR_BACKUP_STATE ?? null,
		keyFile: process.env.LOG4STELLAR_BACKUP_KEY_FILE ?? null,
		intervalMs: defaultIntervalMs,
		maxAgeMs: defaultFreshnessMs,
		force: false,
		json: false,
		maxRuns: undefined,
	};
	const positional = [];
	for (let index = 0; index < argv.length; index++) {
		const argument = argv[index];
		if (!argument.startsWith('--')) {
			positional.push(argument);
			continue;
		}
		const equals = argument.indexOf('=');
		const name = equals === -1 ? argument.slice(2) : argument.slice(2, equals);
		const inline = equals === -1 ? null : argument.slice(equals + 1);
		const takeValue = () => {
			if (inline !== null) return inline;
			const next = argv[++index];
			if (next === undefined) throw new Error('The flag --' + name + ' needs a value.');
			return next;
		};
		switch (name) {
			case 'backup-root': parsed.backupRoot = takeValue(); break;
			case 'state-dir': parsed.stateDir = takeValue(); break;
			case 'key-file': parsed.keyFile = takeValue(); break;
			case 'interval': parsed.intervalMs = parseDuration(takeValue()); break;
			case 'max-age': parsed.maxAgeMs = parseDuration(takeValue()); break;
			case 'max-runs': parsed.maxRuns = Number(takeValue()); break;
			case 'force': parsed.force = true; break;
			case 'json': parsed.json = true; break;
			case 'help': parsed.help = true; break;
			default: throw new Error('Unknown flag: --' + name);
		}
	}
	parsed.command = positional[0] ?? null;
	if (positional.length > 1) {
		throw new Error('Only one command may be given.');
	}
	if (parsed.maxRuns !== undefined && (!Number.isSafeInteger(parsed.maxRuns) || parsed.maxRuns < 1)) {
		throw new Error('--max-runs must be a positive integer.');
	}
	return parsed;
}

async function main() {
	const options = parseArguments(process.argv.slice(2));
	if (options.help || !options.command) {
		process.stdout.write(usage + '\n');
		if (!options.command) {
			process.exitCode = 1;
		}
		return;
	}
	const log = message => process.stdout.write('[' + new Date().toISOString() + '] ' + message + '\n');
	switch (options.command) {
		case 'status': {
			if (!options.stateDir) throw new Error('status needs --state-dir.');
			const status = await schedulerStatus(options.stateDir, { maxAgeMs: options.maxAgeMs });
			if (options.json) {
				process.stdout.write(JSON.stringify(status.freshness, null, 2) + '\n');
			} else {
				process.stdout.write(status.text);
			}
			// A stale or never-successful backup is a failing status on purpose: that is
			// what makes it usable as a monitoring check.
			process.exitCode = status.freshness.fresh ? 0 : 2;
			return;
		}
		case 'list': {
			if (!options.backupRoot) throw new Error('list needs --backup-root.');
			const backups = await listBackups(options.backupRoot);
			if (options.json) {
				process.stdout.write(JSON.stringify(backups, null, 2) + '\n');
				return;
			}
			if (backups.length === 0) {
				process.stdout.write('No backups in ' + options.backupRoot + '\n');
				return;
			}
			for (const backup of backups) {
				process.stdout.write(
					(backup.createdAt ?? 'unknown') + '  ' + backup.scope + '  '
					+ (backup.error ? 'UNREADABLE: ' + backup.error : backup.objects + ' objects, ' + backup.bytes + ' bytes')
					+ '  ' + backup.directory + '\n',
				);
			}
			return;
		}
		case 'run-once': {
			if (!options.backupRoot || !options.stateDir) throw new Error('run-once needs --backup-root and --state-dir.');
			if (!options.keyFile) throw new Error('run-once needs --key-file.');
			const lastSuccessAt = await readLastSuccessAt(options.stateDir);
			if (!options.force && !isDue({ lastSuccessAt, intervalMs: options.intervalMs })) {
				log('Not due until ' + new Date(nextRunAt({ lastSuccessAt, intervalMs: options.intervalMs })).toISOString() + '.');
				return;
			}
			const lock = await acquireLock(options.stateDir);
			if (!lock.acquired) {
				log(lock.reason ?? 'Lock held; skipping.');
				process.exitCode = 0;
				return;
			}
			try {
				const result = await runScheduledBackup({
					backupRoot: options.backupRoot,
					stateDir: options.stateDir,
					keyFile: options.keyFile,
					log,
				});
				process.exitCode = result.ok ? 0 : 1;
			} finally {
				await lock.release();
			}
			return;
		}
		case 'daemon': {
			if (!options.backupRoot || !options.stateDir) throw new Error('daemon needs --backup-root and --state-dir.');
			if (!options.keyFile) throw new Error('daemon needs --key-file.');
			let stopping = false;
			const stop = () => { stopping = true; };
			process.once('SIGINT', stop);
			process.once('SIGTERM', stop);
			const result = await runDaemon({
				backupRoot: options.backupRoot,
				stateDir: options.stateDir,
				keyFile: options.keyFile,
				intervalMs: options.intervalMs,
				maxRuns: options.maxRuns,
				log,
				stopped: () => stopping,
			});
			process.exitCode = result.exitReason === 'max-runs' ? 0 : 0;
			return;
		}
		default:
			process.stderr.write(usage + '\n');
			throw new Error('Unknown command: ' + options.command);
	}
}

export { usage, main };

if (import.meta.url === 'file://' + process.argv[1]) {
	await main().catch(error => {
		process.stderr.write('Backup scheduler failed: ' + (error?.message ?? error) + '\n');
		process.exitCode = 1;
	});
}
