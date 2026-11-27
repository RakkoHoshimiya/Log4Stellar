import { spawn } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rename, rm } from 'node:fs/promises';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
	newInstance, objectUid, prepareDatabase, prepareObjects, privateDirectory,
	probeDatabase, probeObjects, randomSecret, readJson, seedAdmin, storageSettings, webUid, writePrivate,
} from './bootstrap.mjs';

const release = '/opt/log4stellar/release';
const config = '/data/config';
const web = '/data/web';
const runtime = '/run/log4stellar';
const children = new Map();
const persisted = join(config, 'instance.json');
const initialized = join(config, 'storage-ready.json');
const postgresUid = 18021;
let shuttingDown = false;
let failure;
let resolveStop;
const stopped = new Promise(resolve => { resolveStop = resolve; });

async function exists(path) {
	try {
		await access(path);
		return true;
	} catch (error) {
		if (error.code === 'ENOENT') return false;
		throw error;
	}
}

function stop(reason) {
	if (shuttingDown) return;
	shuttingDown = true;
	failure = reason;
	resolveStop();
}

for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => stop());

function abortIfStopping() {
	if (shuttingDown) throw new Error('Shutdown requested');
}

function execute(command, args, { input, env = {}, inherit = false } = {}) {
	abortIfStopping();
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			env: { PATH: process.env.PATH, LANG: 'C.UTF-8', ...env },
			stdio: [input === undefined ? 'ignore' : 'pipe', inherit ? 'inherit' : 'ignore', inherit ? 'inherit' : 'ignore'],
		});
		child.stdin?.on('error', () => {});
		child.stdin?.end(input);
		child.once('error', reject);
		child.once('exit', code => code === 0 ? resolve() : reject(new Error(command + ' failed with exit code ' + code)));
	});
}

function service(name, account, args, env = {}) {
	abortIfStopping();
	const child = spawn('gosu', [account, ...args], {
		env: { PATH: process.env.PATH, LANG: 'C.UTF-8', ...env },
		stdio: ['ignore', 'inherit', 'inherit'],
	});
	const entry = { child, exited: new Promise(resolve => {
		child.once('exit', (code, signal) => { stop(new Error(name + ' exited (' + (signal ?? code) + ')')); resolve(); });
		child.once('error', () => { stop(new Error(name + ' could not start')); resolve(); });
	}) };
	children.set(name, entry);
}

async function shutdown() {
	for (const [name, signal] of [['Web', 'SIGTERM'], ['PostgreSQL', 'SIGINT'], ['RustFS', 'SIGTERM']]) {
		const entry = children.get(name);
		if (!entry) continue;
		entry.child.kill(signal);
		await Promise.race([entry.exited, sleep(12_000, undefined, { ref: false })]);
		if (entry.child.exitCode === null && entry.child.signalCode === null) {
			entry.child.kill('SIGKILL');
			await entry.exited;
		}
	}
}

async function waitFor(description, attempt) {
	const until = Date.now() + 45000;
	do {
		abortIfStopping();
		try {
			await attempt();
			return;
		} catch {
			await sleep(500);
		}
	} while (Date.now() < until);
	throw new Error(description + ' did not become ready');
}

async function initCluster(data, state) {
	if (await exists(join(data, 'PG_VERSION'))) return;
	if (await exists(data)) throw new Error('Refusing to initialize an incomplete PostgreSQL cluster');
	const stage = await mkdtemp('/data/postgres/initialize-');
	const password = join(runtime, 'pg-password');
	await execute('chown', ['postgres:postgres', stage]);
	await writePrivate(password, state.postgres + '\n');
	await execute('chown', ['postgres:postgres', password]);
	try {
		await execute('gosu', ['postgres', 'initdb', '-D', stage, '--username=postgres', '--auth-local=peer',
			'--auth-host=scram-sha-256', '--encoding=UTF8', '--pwfile=' + password], { inherit: true });
		await rename(stage, data);
	} finally {
		await rm(password, { force: true });
		await rm(stage, { recursive: true, force: true });
	}
}

function validStorage(settings) {
	const postgres = settings?.postgres;
	const s3 = settings?.s3;
	if (!postgres?.host || !postgres.database || !postgres.user || !postgres.password ||
		!s3?.endpoint || !s3.bucket || !s3.accessKeyId || !s3.secretAccessKey) {
		throw new Error('Storage config requires PostgreSQL and S3 connection credentials');
	}
}

async function copyTls(origin) {
	const directory = join(config, 'tls');
	await mkdir(directory, { mode: 0o700, recursive: true });
	const cert = join(directory, 'server.crt');
	const key = join(directory, 'server.key');
	const supplied = process.env.LOG4STELLAR_TLS_CERT;
	const suppliedKey = process.env.LOG4STELLAR_TLS_KEY;
	if (Boolean(supplied) !== Boolean(suppliedKey)) throw new Error('Provide both TLS certificate and TLS key');
	if (!supplied && (!await exists(cert) || !await exists(key))) {
		const host = origin.hostname.replace(/^\[|\]$/g, '');
		if (!isIP(host) && !/^[a-zA-Z0-9.-]+$/.test(host)) throw new Error('Invalid hostname for generated TLS certificate');
		await execute('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '365', '-subj', '/CN=Log4Stellar',
			'-addext', 'subjectAltName=' + (isIP(host) ? 'IP:' : 'DNS:') + host, '-keyout', key, '-out', cert]);
		console.log('Generated a self-signed certificate in /data/config/tls');
	}
	await privateDirectory(join(runtime, 'web'), webUid);
	const certificate = join(runtime, 'web/server.crt');
	const privateKey = join(runtime, 'web/server.key');
	await writePrivate(certificate, await readFile(supplied ?? cert), webUid);
	await writePrivate(privateKey, await readFile(suppliedKey ?? key), webUid);
	return { certificate, privateKey };
}

async function boot() {
	const mode = process.env.LOG4STELLAR_DEPLOYMENT_MODE;
	if (mode !== 'external' && mode !== 'standalone') throw new Error('Set deployment mode to external or standalone');
	const origin = new URL(process.env.LOG4STELLAR_WEB_ORIGIN);
	if (origin.protocol !== 'https:' || origin.origin !== process.env.LOG4STELLAR_WEB_ORIGIN) {
		throw new Error('Set a canonical HTTPS origin');
	}
	await privateDirectory(config, 0);
	const modeFile = join(config, 'deployment-mode.json');
	const oldMode = await readJson(modeFile);
	if (oldMode && oldMode.mode !== mode) throw new Error('Use a separate data directory when changing deployment mode');
	if (!oldMode) await writePrivate(modeFile, JSON.stringify({ mode }) + '\n');
	await mkdir(runtime, { recursive: true, mode: 0o755 });
	await chmod(runtime, 0o755);
	await chmod('/data', 0o711);
	await privateDirectory(web, webUid);
	const auth = join(web, 'auth');
	await privateDirectory(auth, webUid);
	const adminFile = process.env.LOG4STELLAR_ADMIN_PASSWORD_FILE;
	const username = process.env.LOG4STELLAR_ADMIN_USERNAME ?? 'admin';
	if (!/^[a-z0-9._]{3,30}$/.test(username)) throw new Error('Invalid platform administrator username');
	const platformReady = (await readJson(join(config, 'platform-bootstrap.json')))?.complete;
	const password = adminFile && !platformReady ? (await readFile(adminFile, 'utf8')).replace(/\r?\n$/, '') : undefined;
	if (password !== undefined && (password.length < 8 || password.length > 128)) throw new Error('Administrator password must have 8–128 characters');
	if (mode === 'standalone' && !platformReady && !password) throw new Error('Provide the first platform administrator password file');

	let settings;
	if (mode === 'external') {
		const path = process.env.LOG4STELLAR_EXTERNAL_STORAGE_CONFIG ?? '/run/secrets/log4stellar-storage.json';
		settings = await readJson(path);
		validStorage(settings);
	} else {
		const data = '/data/postgres/cluster';
		const objects = '/data/rustfs';
		const ready = await exists(initialized);
		const postgresExists = await exists(data);
		const objectsExist = await exists(objects) && (await readdir(objects)).length > 0;
		if (ready && (!postgresExists || !objectsExist)) throw new Error('A previously initialized storage directory is missing');
		const state = await newInstance(persisted, process.env.PG_MAJOR, postgresExists || objectsExist || ready);
		settings = storageSettings(state);
		await privateDirectory('/data/postgres', postgresUid);
		await privateDirectory(objects, objectUid);
		await privateDirectory(join(runtime, 'pg'), postgresUid);
		await initCluster(data, state);
		const diskVersion = (await readFile(join(data, 'PG_VERSION'), 'utf8')).trim();
		if (diskVersion !== state.pgVersion) throw new Error('PostgreSQL data major version does not match the image');
		service('PostgreSQL', 'postgres', ['postgres', '-D', data, '-c', 'listen_addresses=127.0.0.1',
			'-c', 'unix_socket_directories=' + join(runtime, 'pg')]);
		await waitFor('PostgreSQL', async () => {
			await execute('pg_isready', ['-h', '127.0.0.1', '-q', '-t', '2']);
		});
		const access = join(runtime, 'rustfs-access');
		const secret = join(runtime, 'rustfs-secret');
		await writePrivate(access, 'stellarsystem', objectUid);
		await writePrivate(secret, state.rustfsAdmin, objectUid);
		service('RustFS', 'rustfs', ['rustfs', 'server', '--address', '127.0.0.1:9000', objects], {
			RUSTFS_CONSOLE_ENABLE: 'false', RUSTFS_ACCESS_KEY_FILE: access, RUSTFS_SECRET_KEY_FILE: secret, RUSTFS_OBS_LOGGER_LEVEL: 'warn',
		});
		await waitFor('RustFS', async () => {
			const response = await fetch('http://127.0.0.1:9000/health', { signal: AbortSignal.timeout(2500) });
			if (!response.ok) throw new Error('Object service unhealthy');
		});
		if (!ready) {
			await prepareDatabase(state, settings);
			await prepareObjects(state, settings, execute);
		}
	}
	validStorage(settings);
	abortIfStopping();
	console.log('Checking application PostgreSQL role and RustFS bucket');
	await probeDatabase(settings.postgres);
	await probeObjects(settings.s3);
	if (mode === 'standalone' && !await exists(initialized)) await writePrivate(initialized, '{"format":1}\n');

	const storage = join(web, 'storage.json');
	await writePrivate(storage, JSON.stringify(settings) + '\n', webUid);
	for (const [key, directory] of [['secret', auth], ['git-secret', web], ['backup.key', web]]) {
		const keyPath = join(directory, key);
		if (!await exists(keyPath)) await writePrivate(keyPath, randomSecret() + '\n', webUid);
	}
	await privateDirectory('/data/backups', webUid);
	await privateDirectory('/data/cache', webUid);
	const tls = await copyTls(origin);
	const port = process.env.LOG4STELLAR_INTERNAL_PORT ?? '8443';
	const env = {
		...Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('LOG4STELLAR_') &&
			!['LOG4STELLAR_ADMIN_PASSWORD_FILE', 'LOG4STELLAR_EXTERNAL_STORAGE_CONFIG'].includes(key))),
		LOG4STELLAR_AUTH_DIR: auth,
		LOG4STELLAR_STORAGE_BACKEND: 'rustfs',
		LOG4STELLAR_MANAGED_TENANTS: '1',
		LOG4STELLAR_STORAGE_CONFIG: storage,
		LOG4STELLAR_TLS_CERT: tls.certificate,
		LOG4STELLAR_TLS_KEY: tls.privateKey,
		LOG4STELLAR_DEMO_HOST: '0.0.0.0',
		LOG4STELLAR_MONITOR_CLIENTS: '127.0.0.1',
		LOG4STELLAR_OFFICE_CACHE_DIR: '/data/cache/office',
		LOG4STELLAR_BACKUP_KEY_FILE: join(web, 'backup.key'),
		LOG4STELLAR_BACKUP_DIR: '/data/backups',
		LOG4STELLAR_BLOB_GC_APPLY: '0',
		HOME: web,
		TMPDIR: '/data/cache',
	};
	if (process.env.LOG4STELLAR_CONTAINER_CONVERSION === '1') {
		await execute('gosu', ['stellar', 'python3', '-I', '/opt/log4stellar/container/sandbox.py',
			'/data/cache', '/usr/bin/true'], { inherit: true });
		env.LOG4STELLAR_OFFICE_PREVIEW = '1';
		env.LOG4STELLAR_OFFICE_SOFFICE = '/opt/log4stellar/container/office-preview.sh';
		env.LOG4STELLAR_SEARCH_FORMAT_RUNNER = '/opt/log4stellar/container/converter.sh';
	} else {
		env.LOG4STELLAR_OFFICE_PREVIEW = '0';
		delete env.LOG4STELLAR_SEARCH_FORMAT_RUNNER;
	}

	await seedAdmin(env, password, username, execute);
	service('Web', 'stellar', ['node', release + '/server/serve-demo.mjs', 'log4stellar', port, '--release'], env);
	console.log('Log4Stellar started; use the HTTPS origin to log in.');
}

try {
	await boot();
	await stopped;
} catch (error) {
	stop(error);
}
await shutdown();
if (failure) {
	console.error('Deployment failed: ' + (failure.code ?? failure.message));
	process.exitCode = 1;
}
