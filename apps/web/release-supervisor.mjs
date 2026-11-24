#!/usr/bin/env node
// Keeps a packaged Web release running on a host that has no service manager.
//
// The production host cannot use `systemctl --user`: the user bus is absent
// (`Failed to connect to bus: No medium found`), so a systemd unit template is
// documentation only and cannot be the mechanism that starts the service. This
// supervisor is the portable replacement. It owns one child process, records its
// identity in a JSON pid file, restarts the child after an unexpected exit and
// turns a signal into a bounded graceful shutdown. The deploy tooling talks to it
// through `start`, `stop` and `status`, so every switch and rollback can be
// observed (pid, release path, port) without depending on a bus.
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { open, readFile, rename, rm, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const usage = 'Usage: node release-supervisor.mjs <start|stop|status|restart> --pid-file <path> [options]';

function parseArguments(argv) {
	const [command, ...rest] = argv;
	if (!command || !['start', 'stop', 'status', 'restart'].includes(command)) {
		throw new Error(usage);
	}
	const options = {};
	for (let index = 0; index < rest.length; index += 2) {
		const flag = rest[index];
		const value = rest[index + 1];
		if (!flag?.startsWith('--') || value === undefined) {
			throw new Error(usage);
		}
		options[flag.slice(2)] = value;
	}
	return { command, options };
}

function numberOption(options, name, fallback) {
	const value = options[name];
	if (value === undefined) {
		return fallback;
	}
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 0) {
		throw new Error('--' + name + ' must be a non-negative integer');
	}
	return parsed;
}

async function readPidFile(file) {
	let text;
	try {
		text = await readFile(file, 'utf8');
	} catch (error) {
		if (error.code === 'ENOENT') {
			return undefined;
		}
		throw error;
	}
	try {
		return JSON.parse(text);
	} catch {
		return { malformed: true, raw: text.slice(0, 200) };
	}
}

function alive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) {
		return false;
	}
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error.code === 'EPERM';
	}
}

async function writePidFile(file, record) {
	await mkdir(dirname(file), { recursive: true, mode: 0o700 });
	const temporary = file + '.' + process.pid + '.tmp';
	await rm(temporary, { force: true });
	const handle = await open(temporary, 'wx', 0o600);
	try {
		await handle.writeFile(JSON.stringify(record, null, '\t') + '\n');
	} finally {
		await handle.close();
	}
	await rename(temporary, file);
}

function logLine(log, message) {
	const line = '[' + new Date().toISOString() + '] supervisor: ' + message + '\n';
	log.write(line);
}

async function start(options) {
	const pidFile = resolve(options['pid-file'] ?? '');
	const release = resolve(options.release ?? '');
	const port = Number(options.port);
	const node = options.node ?? process.execPath;
	const workspace = options.workspace ?? 'log4stellar-main';
	const logFile = resolve(options['log-file'] ?? join(dirname(pidFile), 'web.log'));
	const gracefulTimeoutMs = numberOption(options, 'graceful-timeout', 15_000);
	const restartLimit = numberOption(options, 'restart-limit', 5);
	const restartWindowMs = numberOption(options, 'restart-window', 60_000);
	if (!options['pid-file'] || !options.release || !Number.isInteger(port) || port < 1 || port > 65_535) {
		throw new Error(usage);
	}

	const existing = await readPidFile(pidFile);
	if (existing && (alive(existing.supervisorPid) || alive(existing.childPid))) {
		throw new Error('A supervised release is already running: pid ' + (existing.supervisorPid ?? existing.childPid) + ' (' + pidFile + ')');
	}
	await mkdir(dirname(logFile), { recursive: true, mode: 0o700 });
	const log = createWriteStream(logFile, { flags: 'a', mode: 0o600 });
	const record = {
		format: 1,
		status: 'starting',
		release,
		port,
		node,
		workspace,
		logFile,
		supervisorPid: process.pid,
		childPid: undefined,
		startedAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		restarts: 0,
	};

	let child;
	let stopping = false;
	let restarts = [];
	let finish;
	const finished = new Promise(resolveFinished => { finish = resolveFinished; });

	const launch = () => {
		child = spawn(node, [join(release, 'server', 'serve-demo.mjs'), workspace, String(port), '--release'], {
			cwd: dirname(pidFile),
			env: { ...process.env },
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		for (const stream of [child.stdout, child.stderr]) {
			stream.on('data', chunk => log.write(chunk));
		}
		child.once('error', error => {
			logLine(log, 'could not start the release: ' + error.message);
			finish(1);
		});
		child.once('exit', (code, signal) => {
			record.childPid = undefined;
			if (stopping) {
				logLine(log, 'release stopped (' + (signal ?? 'exit ' + code) + ')');
				finish(0);
				return;
			}
			const now = Date.now();
			restarts = restarts.filter(at => now - at < restartWindowMs);
			restarts.push(now);
			logLine(log, 'release exited unexpectedly (' + (signal ?? 'code ' + code) + '), restart ' + restarts.length + '/' + restartLimit);
			if (restarts.length > restartLimit) {
				record.status = 'crashed';
				record.updatedAt = new Date().toISOString();
				writePidFile(pidFile, record).catch(() => {});
				logLine(log, 'giving up after ' + restarts.length + ' restarts inside ' + restartWindowMs + 'ms');
				finish(1);
				return;
			}
			record.restarts += 1;
			record.childPid = undefined;
			record.updatedAt = new Date().toISOString();
			writePidFile(pidFile, record).catch(() => {});
			void delay(Math.min(1000 * restarts.length, 5_000)).then(() => {
				if (!stopping) {
					launch();
				}
			});
		});
		record.childPid = child.pid;
		record.status = 'running';
		record.updatedAt = new Date().toISOString();
		void writePidFile(pidFile, record);
	};

	const shutdown = async signal => {
		if (stopping) {
			return;
		}
		stopping = true;
		record.status = 'stopping';
		record.updatedAt = new Date().toISOString();
		await writePidFile(pidFile, record).catch(() => {});
		logLine(log, 'received ' + signal + ', stopping the release (graceful timeout ' + gracefulTimeoutMs + 'ms)');
		if (child?.exitCode === null && child.signalCode === null) {
			child.kill('SIGTERM');
			const deadline = Date.now() + gracefulTimeoutMs;
			while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
				await delay(100);
			}
			if (child.exitCode === null && child.signalCode === null) {
				logLine(log, 'release ignored SIGTERM, sending SIGKILL');
				child.kill('SIGKILL');
			}
		}
		await rm(pidFile, { force: true });
		logLine(log, 'supervisor exiting');
		log.end();
		finish(0);
	};

	process.once('SIGTERM', () => void shutdown('SIGTERM'));
	process.once('SIGINT', () => void shutdown('SIGINT'));
	process.once('SIGHUP', () => void shutdown('SIGHUP'));

	logLine(log, 'starting ' + release + ' on port ' + port + ' with ' + node);
	launch();
	process.exitCode = await finished;
}

async function stop(options) {
	const pidFile = resolve(options['pid-file'] ?? '');
	if (!options['pid-file']) {
		throw new Error(usage);
	}
	const timeoutMs = numberOption(options, 'timeout', 20_000);
	const record = await readPidFile(pidFile);
	if (!record || record.malformed) {
		if (record?.malformed) {
			await rm(pidFile, { force: true });
			console.log(JSON.stringify({ stopped: false, reason: 'removed a malformed pid file', pidFile }));
			return;
		}
		console.log(JSON.stringify({ stopped: false, reason: 'no pid file', pidFile }));
		return;
	}
	const terminated = [];
	if (alive(record.supervisorPid)) {
		terminated.push(record.supervisorPid);
		process.kill(record.supervisorPid, 'SIGTERM');
	}
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const stillAlive = (record.childPid && alive(record.childPid)) || (record.supervisorPid && alive(record.supervisorPid));
		if (!stillAlive) {
			break;
		}
		await delay(100);
	}
	// The supervisor stops the child; if it died first the child may be orphaned.
	for (const pid of [record.childPid, record.supervisorPid]) {
		if (alive(pid)) {
			process.kill(pid, 'SIGKILL');
			terminated.push(pid);
		}
	}
	await rm(pidFile, { force: true });
	console.log(JSON.stringify({ stopped: terminated.length > 0, terminated, pidFile }));
}

async function status(options) {
	const pidFile = resolve(options['pid-file'] ?? '');
	if (!options['pid-file']) {
		throw new Error(usage);
	}
	const record = await readPidFile(pidFile);
	if (!record || record.malformed) {
		console.log(JSON.stringify({ running: false, pidFile, reason: record?.malformed ? 'malformed pid file' : 'no pid file' }));
		return;
	}
	const running = alive(record.supervisorPid) || alive(record.childPid);
	console.log(JSON.stringify({ running, ...record }));
}

async function restart(options) {
	await stop(options);
	await start(options);
}

const { command, options } = parseArguments(process.argv.slice(2));
if (command === 'start') {
	await start(options);
} else if (command === 'stop') {
	await stop(options);
} else if (command === 'status') {
	await status(options);
} else {
	await restart(options);
}
