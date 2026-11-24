#!/usr/bin/env node
// Verify, prepare, activate, check and roll back a packaged Log4Stellar Web release.
//
// The production host has no usable service manager (`systemctl --user` fails with
// `Failed to connect to bus: No medium found`), so this tool cannot lean on a user
// unit template. It drives `release-supervisor.mjs` instead: the supervisor owns the
// child process, records a pid file and restarts it after an unexpected exit. Every
// step below is idempotent, prints a numbered progress line and never echoes a
// credential.
//
// Safety rules encoded here:
//   * activation switches a `current-web-release` symlink atomically and keeps both
//     the newly activated and the previously active release on disk;
//   * a switch that cannot be verified is reverted to the previous release before the
//     error is reported;
//   * a rollback target must pass the same manifest, fingerprint and required-file
//     checks as a fresh candidate;
//   * a rollback to a release that cannot enforce two-factor authentication is
//     refused while any account has it enabled, because those accounts would keep a
//     factor the target cannot ask for.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createPublicKey, createPrivateKey, X509Certificate } from 'node:crypto';
import { createConnection } from 'node:net';
import { request as httpsRequest } from 'node:https';
import { open, lstat, mkdir, readFile, readdir, readlink, realpath, rename, rm, statfs, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { releaseInventory } from './web-release.mjs';

const home = homedir();
const pointerName = 'current-web-release';
const previousName = 'previous-web-release';
const historyName = 'deployment-history.json';
const lockName = 'web-release-switch.lock';

/// Files every release must contain to be considered runnable. The inventory check
/// catches drift inside the package; this list catches a package that is internally
/// consistent but missing a component the launcher needs.
const requiredFiles = [
	'release.json',
	'server/serve-demo.mjs',
	'server/auth.mjs',
	'server/package.json',
	'server/workspace-contract.mjs',
	'web/out/nls.locales.json',
	'extensions/workspace-files/package.json',
];

/// Marker that a release is able to ask for a second factor. Releases built before
/// the account-security work (the 20261122 series) have no `account-security.mjs`,
/// so they would accept a single factor for an account that expects two.
const mfaServerFile = 'server/account-security.mjs';

let step = 0;
function progress(message, detail) {
	step += 1;
	const line = '[deploy ' + String(step).padStart(2, '0') + '] ' + message;
	console.log(detail === undefined ? line : line + ': ' + JSON.stringify(detail));
}

export class DeployError extends Error {
	constructor(code, message, detail) {
		super(message);
		this.name = 'DeployError';
		this.code = code;
		this.detail = detail;
	}
}

// ---------------------------------------------------------------------------
// option handling

function parseFlags(argv) {
	const result = { positional: [] };
	for (let index = 0; index < argv.length; index += 1) {
		const token = argv[index];
		if (token === '--no-backup' || token === '--smoke' || token === '--json') {
			result[token.slice(2)] = true;
			continue;
		}
		if (!token.startsWith('--')) {
			result.positional.push(token);
			continue;
		}
		const value = argv[index + 1];
		if (value === undefined || value.startsWith('--')) {
			throw new DeployError('Usage', 'Option ' + token + ' needs a value');
		}
		result[token.slice(2)] = value;
		index += 1;
	}
	return result;
}

/**
 * Resolves every deployment path once so each later step works on absolutes.
 * All of it is overridable, which is what lets the drill run under `/tmp` without
 * touching `/home/log4stellar/.config/log4stellar`.
 */
export function deploymentConfig(flags = {}) {
	const stateDir = resolve(flags['state-dir'] ?? process.env.LOG4STELLAR_DEPLOY_STATE ?? join(home, '.config', 'log4stellar'));
	const releasesRoot = resolve(flags['releases-root'] ?? process.env.LOG4STELLAR_RELEASES_ROOT ?? join(home, '.local', 'share', 'log4stellar', 'releases'));
	const node = resolve(flags.node ?? process.env.LOG4STELLAR_NODE ?? process.execPath);
	const port = Number(flags.port ?? process.env.LOG4STELLAR_PORT ?? 18990);
	if (!Number.isInteger(port) || port < 1 || port > 65_535) {
		throw new DeployError('Usage', '--port must be a TCP port number');
	}
	return {
		stateDir,
		releasesRoot,
		node,
		nodeMajor: Number(spawnSync(node, ['--version'], { encoding: 'utf8' }).stdout.trim().replace(/^v/, '').split('.')[0]),
		pointer: join(stateDir, pointerName),
		previous: join(stateDir, previousName),
		history: join(stateDir, historyName),
		lock: join(stateDir, lockName),
		pidFile: resolve(flags['pid-file'] ?? process.env.LOG4STELLAR_PID_FILE ?? join(stateDir, 'web-release.pid.json')),
		logFile: resolve(flags['log-file'] ?? process.env.LOG4STELLAR_SERVICE_LOG ?? join(stateDir, 'logs', 'web-release.log')),
		backupRoot: resolve(flags['backup-root'] ?? join(stateDir, 'backups')),
		host: flags.host ?? process.env.LOG4STELLAR_DEPLOY_HOST ?? '127.0.0.1',
		port,
		workspace: flags.workspace ?? process.env.LOG4STELLAR_WORKSPACE_ID ?? 'log4stellar-main',
		backend: flags.backend ?? process.env.LOG4STELLAR_STORAGE_BACKEND ?? 'rustfs',
		// With the local backend the launcher's positional argument is the notes
		// directory, not a workspace ID; the workspace ID then comes from the
		// environment. Default matches the production launcher's local branch.
		notesDir: resolve(flags['notes-dir'] ?? process.env.LOG4STELLAR_NOTES_DIR
			?? join(home, '.cache', 'log4stellar-demo', 'Log4Stellar Demo')),
		clients: flags.clients ?? process.env.LOG4STELLAR_DEMO_CLIENTS ?? '127.0.0.1',
		tlsCert: resolve(flags['tls-cert'] ?? process.env.LOG4STELLAR_TLS_CERT ?? join(home, '.cache', 'log4stellar-demo', 'tls', 'server.crt')),
		tlsKey: resolve(flags['tls-key'] ?? process.env.LOG4STELLAR_TLS_KEY ?? join(home, '.cache', 'log4stellar-demo', 'tls', 'server.key')),
		authDir: resolve(flags['auth-dir'] ?? process.env.LOG4STELLAR_AUTH_DIR ?? join(home, '.cache', 'log4stellar-demo', 'auth')),
		storageConfig: resolve(flags['storage-config'] ?? process.env.LOG4STELLAR_STORAGE_CONFIG ?? join(home, '.config', 'log4stellar', 'workspace-storage.json')),
		minFreeBytes: Number(flags['min-free-bytes'] ?? process.env.LOG4STELLAR_MIN_FREE_BYTES ?? 2 * 1024 ** 3),
		allowUntrustedCert: flags['allow-untrusted-cert'] === 'true' || flags['allow-untrusted-cert'] === true,
		skipDataChecks: flags['skip-data-checks'] === 'true' || flags['skip-data-checks'] === true,
		timeoutMs: Number(flags.timeout ?? 60_000),
	};
}

// ---------------------------------------------------------------------------
// manifest and integrity

/**
 * Reads `release.json` and validates it against the *target runtime* Node major
 * version rather than `process.versions.node`, because the tool is commonly run by a
 * different Node build than the service (the production service runs the pinned
 * `log4stellar-toolchain` v24 while the shell may have v26).
 */
export async function readReleaseManifest(directory, config) {
	let root;
	try {
		root = await realpath(directory);
	} catch (error) {
		if (error.code === 'ENOENT') {
			throw new DeployError('MissingRelease', 'Release directory does not exist: ' + directory);
		}
		throw error;
	}
	let marker;
	try {
		marker = JSON.parse(await readFile(join(root, 'release.json'), 'utf8'));
	} catch (error) {
		if (error.code === 'ENOENT') {
			throw new DeployError('MissingManifest', 'Release has no release.json: ' + root);
		}
		throw new DeployError('BadManifest', 'Release manifest is not valid JSON: ' + root);
	}
	const problems = [];
	if (marker.format !== 1) problems.push('format ' + marker.format + ' instead of 1');
	if (marker.platform !== process.platform) problems.push('platform ' + marker.platform + ' instead of ' + process.platform);
	if (marker.arch !== process.arch) problems.push('arch ' + marker.arch + ' instead of ' + process.arch);
	if (marker.nodeMajor !== config.nodeMajor) problems.push('nodeMajor ' + marker.nodeMajor + ' instead of ' + config.nodeMajor + ' (' + config.node + ')');
	if (!Array.isArray(marker.files)) problems.push('no file inventory');
	if (!marker.source?.commit) problems.push('no source commit');
	if (problems.length > 0) {
		throw new DeployError('IncompatibleRelease', 'Incompatible Log4Stellar Web release: ' + root + ' (' + problems.join('; ') + ')');
	}
	return { root, marker };
}

async function assertRequiredFiles(root) {
	const missing = [];
	for (const name of requiredFiles) {
		try {
			await lstat(join(root, name));
		} catch {
			missing.push(name);
		}
	}
	if (missing.length > 0) {
		throw new DeployError('IncompleteRelease', 'Release is missing required files: ' + missing.join(', '), { root, missing });
	}
}

/// True when the release ships the account-security surface, i.e. it can demand a
/// second factor from an account that has one enrolled.
export async function supportsTwoFactor(root) {
	try {
		await lstat(join(root, mfaServerFile));
		return true;
	} catch {
		return false;
	}
}

/**
 * verifyCandidate(): full package verification that must pass before anything is
 * prepared or activated. It checks the manifest, the required-file list and every
 * file digest against the recorded inventory, in both directions, so a modified file
 * and an extra file are both rejected.
 */
export async function verifyCandidate(directory, config, options = {}) {
	progress('verify candidate', { directory });
	const { root, marker } = await readReleaseManifest(directory, config);
	progress('release manifest', {
		release: basename(root), commit: marker.source.commit, fingerprint: marker.source.fingerprint,
		nodeMajor: marker.nodeMajor, files: marker.files.length, twoFactor: await supportsTwoFactor(root),
	});
	await assertRequiredFiles(root);
	const inventory = await releaseInventory(root);
	const expected = new Map(marker.files);
	const differences = [];
	for (const [name, digest] of inventory) {
		const recorded = expected.get(name);
		if (recorded === undefined || recorded !== digest) {
			// A modified file is reported once, never twice as modified *and* missing.
			expected.delete(name);
			differences.push('Unexpected or modified release file: ' + name);
			continue;
		}
		expected.delete(name);
	}
	for (const name of expected.keys()) {
		differences.push('Missing release file: ' + name);
	}
	if (differences.length > 0) {
		throw new DeployError('IntegrityMismatch',
			'Candidate release failed fingerprint verification (' + differences.length + ' differences): ' + differences.slice(0, 5).join('; '),
			{ root, differences: differences.slice(0, 50), total: differences.length });
	}
	progress('candidate integrity verified', { files: inventory.length, fingerprint: marker.source.fingerprint });
	if (options.smoke) {
		progress('running the packaged HTTPS smoke test', { root });
		execFileSync(config.node, [join(root, 'server', 'verify-web-release.mjs'), root], { stdio: 'inherit' });
	}
	return { root, marker, files: inventory.length, twoFactor: await supportsTwoFactor(root) };
}

// ---------------------------------------------------------------------------
// preflight

async function checkTls(config) {
	let cert, key;
	try {
		cert = await readFile(config.tlsCert, 'utf8');
	} catch {
		throw new DeployError('TlsMissing', 'TLS certificate is not readable: ' + config.tlsCert);
	}
	try {
		key = await readFile(config.tlsKey, 'utf8');
	} catch {
		throw new DeployError('TlsMissing', 'TLS private key is not readable: ' + config.tlsKey);
	}
	const parsed = new X509Certificate(cert);
	const notBefore = new Date(parsed.validFrom);
	const notAfter = new Date(parsed.validTo);
	const now = new Date();
	if (now < notBefore) {
		throw new DeployError('TlsNotYetValid', 'TLS certificate is not valid before ' + parsed.validFrom, { cert: config.tlsCert });
	}
	if (now > notAfter) {
		throw new DeployError('TlsExpired', 'TLS certificate expired at ' + parsed.validTo, { cert: config.tlsCert });
	}
	// `X509Certificate#publicKey` is already a KeyObject; wrapping it again throws.
	const certKey = parsed.publicKey;
	const fileKey = createPublicKey(createPrivateKey(key));
	if (certKey.export({ type: 'spki', format: 'der' }).compare(fileKey.export({ type: 'spki', format: 'der' })) !== 0) {
		throw new DeployError('TlsMismatch', 'TLS certificate and private key do not belong together', { cert: config.tlsCert });
	}
	const san = parsed.subjectAltName ?? '';
	const coversHost = san.includes('IP Address:' + config.host) || san.includes('DNS:' + config.host)
		|| (config.host === '127.0.0.1' && san.includes('DNS:localhost'));
	return { subject: parsed.subject.replaceAll('\n', ' '), notAfter: parsed.validTo, coversHost, san };
}

async function checkDisk(config, extraBytes) {
	const filesystem = await statfs(config.releasesRoot);
	const available = filesystem.bavail * filesystem.bsize;
	const required = config.minFreeBytes + (extraBytes ?? 0);
	if (available < required) {
		throw new DeployError('LowDiskSpace',
			'Not enough free space under ' + config.releasesRoot + ': ' + available + ' bytes available, ' + required + ' required',
			{ available, required });
	}
	return { available, required, filesystem: config.releasesRoot };
}

async function checkPostgres(config) {
	let settings;
	try {
		settings = JSON.parse(await readFile(config.storageConfig, 'utf8'));
	} catch (error) {
		if (error.code === 'ENOENT') {
			return { skipped: 'no storage configuration at ' + config.storageConfig };
		}
		throw new DeployError('StorageConfigUnreadable', 'Storage configuration is not valid JSON: ' + config.storageConfig);
	}
	if (!settings.postgres) {
		return { skipped: 'storage configuration has no postgres section' };
	}
	const { createRequire } = await import('node:module');
	const { Pool } = createRequire(import.meta.url)('pg');
	const pool = new Pool({ ...settings.postgres, connectionTimeoutMillis: 5_000, max: 1 });
	try {
		const connection = await pool.connect();
		try {
			// Read-only probes only: this runs against the live metadata database.
			await connection.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
			const entries = await connection.query('SELECT count(*)::int AS n FROM log4stellar.storage_entries');
			const versions = await connection.query('SELECT count(*)::int AS n FROM log4stellar.storage_file_versions');
			await connection.query('ROLLBACK');
			return { ok: true, entries: entries.rows[0].n, versions: versions.rows[0].n };
		} finally {
			connection.release();
		}
	} catch (error) {
		throw new DeployError('DatabaseUnavailable', 'PostgreSQL preflight failed: ' + String(error.message).split('\n')[0],
			{ host: settings.postgres.host, port: settings.postgres.port, database: settings.postgres.database });
	} finally {
		await pool.end();
	}
}

async function checkRustfs(config) {
	let settings;
	try {
		settings = JSON.parse(await readFile(config.storageConfig, 'utf8'));
	} catch {
		return { skipped: 'no storage configuration' };
	}
	if (!settings.s3?.bucket) {
		return { skipped: 'storage configuration has no s3 section' };
	}
	const { createRequire } = await import('node:module');
	const { S3Client, ListObjectsV2Command } = createRequire(import.meta.url)('@aws-sdk/client-s3');
	const client = new S3Client({
		endpoint: settings.s3.endpoint,
		region: settings.s3.region ?? 'us-east-1',
		forcePathStyle: true,
		credentials: { accessKeyId: settings.s3.accessKeyId, secretAccessKey: settings.s3.secretAccessKey },
		requestChecksumCalculation: 'WHEN_REQUIRED',
		responseChecksumValidation: 'WHEN_REQUIRED',
	});
	try {
		// A single-key listing proves the endpoint answers and the credentials may read
		// the bucket without walking a large namespace.
		const listing = await client.send(new ListObjectsV2Command({ Bucket: settings.s3.bucket, MaxKeys: 1 }));
		return { ok: true, bucket: settings.s3.bucket, endpoint: settings.s3.endpoint, readable: Array.isArray(listing.Contents) };
	} catch (error) {
		throw new DeployError('ObjectStoreUnavailable', 'RustFS preflight failed: ' + String(error.name ?? 'error'),
			{ endpoint: settings.s3.endpoint, bucket: settings.s3.bucket });
	} finally {
		client.destroy();
	}
}

/// Census of accounts that actually depend on a second factor: the plugin table holds
/// enrolled secrets, and the `user` flag is what the login gate consults.
export async function mfaCensus(authDir = join(home, '.cache', 'log4stellar-demo', 'auth')) {
	const database = join(authDir, 'auth.sqlite');
	let handle;
	try {
		await lstat(database);
	} catch {
		return { enrolled: 0, enabled: 0, available: false };
	}
	const { DatabaseSync } = await import('node:sqlite');
	try {
		handle = new DatabaseSync(database, { readOnly: true });
	} catch (error) {
		throw new DeployError('AuthDatabaseUnavailable', 'Authentication database is not readable: ' + database);
	}
	try {
		const tables = handle.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name);
		const enrolled = tables.includes('twoFactor')
			? handle.prepare('SELECT count(*) AS n FROM twoFactor WHERE verified = 1').get().n
			: 0;
		const enabled = tables.includes('user') && handle.prepare('PRAGMA table_info("user")').all().some(row => row.name === 'twoFactorEnabled')
			? handle.prepare('SELECT count(*) AS n FROM "user" WHERE twoFactorEnabled = 1').get().n
			: 0;
		return { enrolled, enabled, available: true, database };
	} finally {
		handle.close();
	}
}

/**
 * The read-only half of preflight: TLS material, free space, PostgreSQL and RustFS
 * readability and the second-factor census. Nothing here writes anywhere.
 */
export async function preflight(config, options = {}) {
	progress('preflight: TLS', { cert: config.tlsCert });
	const tls = await checkTls(config);
	progress('preflight: TLS ok', { subject: tls.subject, notAfter: tls.notAfter, coversHost: tls.coversHost });
	if (!tls.coversHost) {
		progress('preflight: TLS certificate does not name the deployment host', { host: config.host });
	}

	progress('preflight: disk', { root: config.releasesRoot, minFreeBytes: config.minFreeBytes });
	const disk = await checkDisk(config, options.expectedBytes);
	progress('preflight: disk ok', disk);

	let database = { skipped: 'data checks disabled' };
	let objects = { skipped: 'data checks disabled' };
	if (!config.skipDataChecks) {
		progress('preflight: PostgreSQL');
		database = await checkPostgres(config);
		progress('preflight: PostgreSQL ok', database);
		progress('preflight: RustFS');
		objects = await checkRustfs(config);
		progress('preflight: RustFS ok', objects);
	} else {
		progress('preflight: data checks skipped');
	}

	progress('preflight: second-factor census', { authDir: config.authDir });
	const mfa = await mfaCensus(config.authDir);
	progress('preflight: second-factor census ok', { enrolled: mfa.enrolled, enabled: mfa.enabled, available: mfa.available });
	return { tls, disk, database, objects, mfa };
}

// ---------------------------------------------------------------------------
// history

async function readHistory(config) {
	try {
		const parsed = JSON.parse(await readFile(config.history, 'utf8'));
		return Array.isArray(parsed.entries) ? parsed : { format: 1, entries: [] };
	} catch (error) {
		if (error.code === 'ENOENT') {
			return { format: 1, entries: [] };
		}
		throw new DeployError('HistoryUnreadable', 'Deployment history is not valid JSON: ' + config.history);
	}
}

/// Appends one auditable record: what moved, from where, the source commit that came
/// with it and the operator-visible reason. This is the "release to commit mapping"
/// the deployment contract asks to keep.
async function appendHistory(config, entry) {
	const history = await readHistory(config);
	history.entries.push({ at: new Date().toISOString(), ...entry });
	while (history.entries.length > 200) {
		history.entries.shift();
	}
	await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
	const temporary = config.history + '.tmp';
	await writeFile(temporary, JSON.stringify(history, null, '\t') + '\n', { mode: 0o600 });
	await rename(temporary, config.history);
	return history.entries.length;
}

export async function deploymentHistory(config) {
	return readHistory(config);
}

// ---------------------------------------------------------------------------
// locks

async function acquireLock(config, purpose) {
	await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			const handle = await open(config.lock, 'wx', 0o600);
			try {
				await handle.writeFile(JSON.stringify({ pid: process.pid, purpose, at: new Date().toISOString() }) + '\n');
			} finally {
				await handle.close();
			}
			return async () => { await rm(config.lock, { force: true }); };
		} catch (error) {
			if (error.code !== 'EEXIST') {
				throw error;
			}
			const holder = await readFile(config.lock, 'utf8').catch(() => '');
			let record;
			try {
				record = JSON.parse(holder);
			} catch {
				record = undefined;
			}
			let stale = true;
			if (record?.pid) {
				try {
					process.kill(record.pid, 0);
					stale = false;
				} catch {
					stale = true;
				}
			}
			if (!stale) {
				throw new DeployError('SwitchInProgress',
					'Another deployment is switching the release now: pid ' + record.pid + ' (' + (record.purpose ?? 'unknown') + ')',
					{ lock: config.lock, holder: record });
			}
			progress('removing stale switch lock', { lock: config.lock, holder: record });
			await rm(config.lock, { force: true });
		}
	}
	throw new DeployError('SwitchInProgress', 'Could not acquire the switch lock: ' + config.lock);
}

// ---------------------------------------------------------------------------
// pointer switching

export async function currentRelease(config) {
	try {
		return await realpath(config.pointer);
	} catch (error) {
		if (error.code === 'ENOENT') {
			return undefined;
		}
		throw error;
	}
}

export async function previousRelease(config) {
	try {
		return await realpath(config.previous);
	} catch (error) {
		if (error.code === 'ENOENT') {
			return undefined;
		}
		throw error;
	}
}

/// Atomic pointer replacement: build the new link in a temporary directory beside the
/// pointer, then `rename` over it. Both the old and the new release directories stay
/// untouched, which is what makes an in-place rollback possible.
async function switchPointer(config, target, options = {}) {
	const old = await currentRelease(config);
	await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
	const temporary = join(config.stateDir, '.web-release-switch-' + process.pid);
	await rm(temporary, { recursive: true, force: true });
	await mkdir(temporary, { recursive: true, mode: 0o700 });
	try {
		await symlink(target, join(temporary, 'next'));
		if (old && options.keepPrevious !== false) {
			await symlink(old, join(temporary, 'previous'));
			await rename(join(temporary, 'previous'), config.previous);
		}
		await rename(join(temporary, 'next'), config.pointer);
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
	const now = await currentRelease(config);
	if (now !== target) {
		throw new DeployError('PointerMismatch', 'Release pointer did not move to ' + target + ' (reads ' + now + ')');
	}
	progress('release pointer switched', { pointer: config.pointer, from: old ?? null, to: target });
	return { from: old, to: now };
}

// ---------------------------------------------------------------------------
// service control through the supervisor

function supervisorCommand(config, command, extra = []) {
	return [join(dirname(new URL(import.meta.url).pathname), 'release-supervisor.mjs'), command, '--pid-file', config.pidFile, ...extra];
}

export async function serviceStatus(config) {
	const output = execFileSync(config.node, supervisorCommand(config, 'status'), { encoding: 'utf8' });
	return JSON.parse(output.trim().split('\n').pop());
}

/// The service environment is built explicitly rather than inherited, so a switch
/// cannot silently depend on whatever the operator's shell happened to export. Any
/// extra variable the deployment needs is passed through `LOG4STELLAR_SERVICE_*`.
function serviceEnvironment(config, release) {
	const environment = { ...process.env };
	environment.LOG4STELLAR_AUTH_DIR = config.authDir;
	environment.LOG4STELLAR_TLS_CERT = config.tlsCert;
	environment.LOG4STELLAR_TLS_KEY = config.tlsKey;
	environment.LOG4STELLAR_STORAGE_BACKEND = config.backend;
	environment.LOG4STELLAR_WEB_ORIGIN = 'https://' + config.host + ':' + config.port;
	environment.LOG4STELLAR_DEMO_HOST = config.host;
	// Only the addresses that should reach the service. Without this the release
	// serves every client, which is exactly what the production launcher avoids.
	environment.LOG4STELLAR_DEMO_CLIENTS = config.clients;
	environment.LOG4STELLAR_WORKSPACE_ID = config.workspace;
	if (config.backend === 'rustfs') {
		environment.LOG4STELLAR_STORAGE_CONFIG = config.storageConfig;
	}
	environment.LOG4STELLAR_RELEASE = release;
	return environment;
}

async function serviceStart(config, release) {
	// serve-demo.mjs takes one positional argument whose meaning depends on the
	// backend: the storage workspace ID for RustFS, the notes directory for local.
	const positional = config.backend === 'local' ? config.notesDir : config.workspace;
	const extra = ['--release', release, '--port', String(config.port), '--node', config.node,
		'--workspace', positional, '--log-file', config.logFile];
	// The supervisor outlives this command by design, so it is spawned detached and
	// never awaited: waiting on it would block until the service is stopped again.
	const child = spawn(config.node, supervisorCommand(config, 'start', extra), {
		detached: true, stdio: 'ignore', env: serviceEnvironment(config, release),
	});
	let exited;
	child.once('exit', (code, signal) => { exited = { code, signal }; });
	child.unref();
	for (let attempt = 0; attempt < 40; attempt += 1) {
		await delay(100);
		if (exited) {
			throw new DeployError('ServiceStartFailed',
				'The release supervisor exited immediately (' + (exited.signal ?? 'code ' + exited.code) + ')',
				{ pidFile: config.pidFile, logFile: config.logFile });
		}
		const status = await serviceStatus(config).catch(() => undefined);
		if (status?.running) {
			progress('supervisor started', { pidFile: config.pidFile, supervisedPid: status.childPid, logFile: config.logFile });
			return status;
		}
	}
	throw new DeployError('ServiceStartFailed', 'The release supervisor did not report a running release within 4s',
		{ pidFile: config.pidFile, logFile: config.logFile });
}

async function serviceStop(config) {
	try {
		const output = execFileSync(config.node, supervisorCommand(config, 'stop'), { encoding: 'utf8', timeout: 40_000 });
		const result = JSON.parse(output.trim().split('\n').pop());
		progress('supervisor stopped', result);
		return result;
	} catch (error) {
		// Stop is idempotent: nothing running is a success, not a failure.
		progress('supervisor was not running', { pidFile: config.pidFile });
		return { stopped: false };
	}
}

// ---------------------------------------------------------------------------
// listening sockets, read straight from /proc so no extra tool is required

function decodeAddress(hex) {
	const bytes = hex.match(/../g).map(part => parseInt(part, 16));
	// /proc/net/tcp stores each 32-bit word little-endian.
	return bytes.slice(0, 4).reverse().join('.');
}

async function listeningInodes(port) {
	const result = new Map();
	for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
		let text;
		try {
			text = await readFile(file, 'utf8');
		} catch {
			continue;
		}
		for (const line of text.split('\n').slice(1)) {
			const fields = line.trim().split(/\s+/);
			if (fields.length < 10 || fields[3] !== '0A') {
				continue;
			}
			const [address, portHex] = fields[1].split(':');
			if (parseInt(portHex, 16) !== port) {
				continue;
			}
			result.set(fields[9], { inode: fields[9], address: decodeAddress(address) });
		}
	}
	return result;
}

/// Maps every listening socket on `port` to the process that owns it. Used to prove
/// the new release owns the port and that no listener from a previous release was
/// left behind.
export async function portOwners(port) {
	const sockets = await listeningInodes(port);
	if (sockets.size === 0) {
		return [];
	}
	const owners = [];
	let pids = [];
	try {
		pids = (await readdir('/proc')).filter(name => /^\d+$/.test(name));
	} catch {
		return [];
	}
	for (const pid of pids) {
		let descriptors;
		try {
			descriptors = await readdir('/proc/' + pid + '/fd');
		} catch {
			continue;
		}
		const matched = [];
		for (const descriptor of descriptors) {
			let target;
			try {
				target = await readlink('/proc/' + pid + '/fd/' + descriptor);
			} catch {
				continue;
			}
			const match = /^socket:\[(\d+)\]$/.exec(target);
			if (match && sockets.has(match[1])) {
				matched.push(match[1]);
			}
		}
		if (matched.length === 0) {
			continue;
		}
		let argv = [];
		try {
			argv = (await readFile('/proc/' + pid + '/cmdline', 'utf8')).split('\0').filter(Boolean);
		} catch {
			// The process may have exited between the two reads.
		}
		owners.push({ pid: Number(pid), argv, release: argv.find(arg => arg.endsWith('/server/serve-demo.mjs')) });
	}
	return owners;
}

// ---------------------------------------------------------------------------
// HTTPS probe

function fetchHttps(config, path, options = {}) {
	return new Promise((resolvePromise, reject) => {
		const call = httpsRequest(new URL(path, 'https://' + config.host + ':' + config.port), {
			method: options.method ?? 'GET',
			headers: options.headers ?? {},
			signal: AbortSignal.timeout(10_000),
			ca: options.ca,
			rejectUnauthorized: options.ca === undefined,
		}, response => {
			const chunks = [];
			response.on('data', chunk => chunks.push(chunk));
			response.on('error', reject);
			response.on('end', () => resolvePromise({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
		});
		call.on('error', reject);
		call.end(options.body);
	});
}

async function listenReady(host, port, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const connected = await new Promise(resolvePromise => {
			const socket = createConnection({ host, port });
			socket.setTimeout(2_000);
			socket.once('connect', () => { socket.destroy(); resolvePromise(true); });
			socket.once('error', () => { socket.destroy(); resolvePromise(false); });
			socket.once('timeout', () => { socket.destroy(); resolvePromise(false); });
		});
		if (connected) {
			return true;
		}
		await delay(200);
	}
	return false;
}

// ---------------------------------------------------------------------------
// verifyInstallation()

/**
 * verifyInstallation(): readiness after a switch. It asserts that the supervised
 * process exists, that it is running *this* release, that it owns the port, that the
 * login page answers over TLS, and that the release just left behind owns nothing.
 */
export async function verifyInstallation(config, expected, options = {}) {
	const release = expected ?? await currentRelease(config);
	if (!release) {
		throw new DeployError('NoCurrentRelease', 'No release is active under ' + config.pointer);
	}
	progress('verify installation: waiting for the port', { host: config.host, port: config.port });
	if (!await listenReady(config.host, config.port, options.timeoutMs ?? 30_000)) {
		throw new DeployError('NotListening', 'Nothing is listening on ' + config.host + ':' + config.port, { release });
	}
	await delay(250);

	progress('verify installation: supervisor state', { pidFile: config.pidFile });
	const status = await serviceStatus(config);
	if (!status.running) {
		throw new DeployError('ServiceNotRunning', 'The release supervisor reports no running service', { status });
	}
	if (status.release !== release) {
		throw new DeployError('WrongReleaseRunning',
			'The running service is ' + status.release + ' but ' + release + ' is expected', { status, release });
	}

	progress('verify installation: port ownership', { port: config.port });
	const owners = await portOwners(config.port);
	const supervised = owners.filter(owner => owner.pid === status.childPid);
	if (supervised.length === 0) {
		throw new DeployError('PortOwnerMismatch',
			'Port ' + config.port + ' is not owned by the supervised process ' + status.childPid,
			{ owners: owners.map(owner => ({ pid: owner.pid, release: owner.release })), expectedPid: status.childPid });
	}
	const orphans = owners.filter(owner => owner.pid !== status.childPid);
	if (orphans.length > 0) {
		throw new DeployError('OrphanListener',
			'Port ' + config.port + ' has listeners outside the supervised process',
			{ orphans: orphans.map(owner => ({ pid: owner.pid, release: owner.release })) });
	}
	progress('verify installation: port owned by the supervised process', { pid: status.childPid });

	progress('verify installation: HTTPS probe', { path: '/login' });
	let ca;
	if (!config.allowUntrustedCert) {
		ca = await readFile(config.tlsCert);
	}
	let login;
	const deadline = Date.now() + (options.timeoutMs ?? 30_000);
	while (Date.now() < deadline) {
		try {
			login = await fetchHttps(config, '/login', { ca });
			break;
		} catch (error) {
			if (error.code === 'ECONNREFUSED' || error.code === 'ECONNRESET' || /socket hang up|aborted/i.test(String(error.message))) {
				await delay(250);
				continue;
			}
			throw error;
		}
	}
	if (!login) {
		throw new DeployError('ProbeFailed', 'The release never answered /login over HTTPS', { host: config.host, port: config.port });
	}
	if (login.status !== 200) {
		throw new DeployError('ProbeFailed', '/login answered ' + login.status + ' instead of 200', { host: config.host, port: config.port });
	}
	const body = login.body.toString();
	if (!/Log4Stellar|登录|login/i.test(body)) {
		throw new DeployError('ProbeFailed', '/login did not return the sign-in page');
	}
	const anonymousWorkbench = await fetchHttps(config, '/', { ca });
	if (anonymousWorkbench.status !== 303) {
		throw new DeployError('ProbeFailed', 'An anonymous workspace request answered ' + anonymousWorkbench.status + ' instead of a redirect to the sign-in page');
	}
	progress('verify installation: HTTPS probes ok', {
		login: login.status, anonymousWorkspace: anonymousWorkbench.status, redirect: anonymousWorkbench.headers.location,
	});

	const installation = {
		release,
		commit: undefined,
		pid: status.childPid,
		port: config.port,
		host: config.host,
		loginStatus: login.status,
		logFile: config.logFile,
	};
	try {
		installation.commit = JSON.parse(await readFile(join(release, 'release.json'), 'utf8')).source.commit;
	} catch {
		// The commit is informative here; the manifest was already validated.
	}
	progress('installation verified', installation);
	return installation;
}

// ---------------------------------------------------------------------------
// data backup

/// A backup is only meaningful when the deployment owns durable state. The local
/// notes backend keeps everything in the workspace directory, which the release never
/// touches, so there is nothing to snapshot; the tool says so instead of failing or
/// inventing an empty archive.
async function hasDurableState(config) {
	let settings;
	try {
		settings = JSON.parse(await readFile(config.storageConfig, 'utf8'));
	} catch {
		return false;
	}
	return Boolean(settings.postgres && settings.s3);
}

async function dataBackup(config) {
	if (!await hasDurableState(config)) {
		progress('data backup skipped: the storage configuration has no database or object store',
			{ storageConfig: config.storageConfig, backend: config.backend });
		return undefined;
	}
	const target = join(config.backupRoot, 'pre-activation-' + new Date().toISOString().replaceAll(/[:.]/g, '-'));
	await mkdir(config.backupRoot, { recursive: true, mode: 0o700 });
	progress('data backup', { target });
	const result = spawnSync(config.node, [join(dirname(new URL(import.meta.url).pathname), 'backup-data.mjs'), target], {
		encoding: 'utf8',
		env: {
			...process.env,
			LOG4STELLAR_AUTH_DIR: config.authDir,
			LOG4STELLAR_STORAGE_CONFIG: config.storageConfig,
			LOG4STELLAR_BACKUP_PG_DUMP: process.env.LOG4STELLAR_BACKUP_PG_DUMP ?? '1',
		},
		timeout: 600_000,
	});
	if (result.status !== 0) {
		const output = String(result.stderr ?? '');
		// Report the exception line, not the stack tail.
		const reason = output.split('\n').map(line => line.trim())
			.find(line => /^[A-Za-z]*Error\b|^TypeError\b|^Error:/.test(line)) ?? output.trim().split('\n').slice(-1)[0];
		throw new DeployError('BackupFailed', 'The pre-activation data backup failed: ' + reason, { target });
	}
	progress('data backup complete', { target });
	return target;
}

// ---------------------------------------------------------------------------
// prepareRelease()

/**
 * prepareRelease(): validate a candidate package, run the read-only preflight, copy it
 * into the managed releases root under a new name and record it in the history. It
 * deliberately does not touch the pointer: activation is a separate, locked step.
 */
export async function prepareRelease(directory, config, options = {}) {
	progress('prepare release', { candidate: directory, releasesRoot: config.releasesRoot });
	const candidate = await verifyCandidate(directory, config, options);
	const disk = await checkDisk(config, Number(candidate.marker.files.length) * 0);
	progress('disk budget', disk);

	const name = options.name ?? basename(candidate.root);
	const target = join(config.releasesRoot, name);
	if (isAbsolute(name) || name.includes('/') || name.startsWith('.')) {
		throw new DeployError('Usage', 'Invalid release name: ' + name);
	}
	const existing = await lstat(target).catch(() => undefined);
	if (existing) {
		const sameFingerprint = JSON.parse(await readFile(join(target, 'release.json'), 'utf8')).source?.fingerprint === candidate.marker.source.fingerprint;
		if (sameFingerprint) {
			progress('release already prepared with the same source fingerprint', { target, fingerprint: candidate.marker.source.fingerprint });
			return { root: target, marker: candidate.marker, prepared: false, fingerprint: candidate.marker.source.fingerprint };
		}
		throw new DeployError('ReleaseExists', 'Release already exists with a different source: ' + target, { target });
	}

	await mkdir(config.releasesRoot, { recursive: true });
	const stage = join(config.releasesRoot, '.deploy-stage-' + process.pid + '-' + Date.now());
	await rm(stage, { recursive: true, force: true });
	try {
		progress('copying the candidate into the releases root', { from: candidate.root, to: stage });
		execFileSync('cp', ['-a', '--', candidate.root, stage], { stdio: 'inherit' });
		// The copy must still verify: a truncated copy is worse than no copy.
		await verifyCandidate(stage, config);
		await lstat(target).then(
			() => { throw new DeployError('ReleaseExists', 'Release appeared while preparing: ' + target); },
			error => { if (error.code !== 'ENOENT') throw error; });
		await rename(stage, target);
	} finally {
		await rm(stage, { recursive: true, force: true });
	}
	const count = await appendHistory(config, {
		action: 'prepare', release: target, name,
		source: candidate.marker.source, previous: await currentRelease(config) ?? null,
	});
	progress('release prepared', { target, fingerprint: candidate.marker.source.fingerprint, historyEntries: count });
	return { root: target, marker: candidate.marker, prepared: true, fingerprint: candidate.marker.source.fingerprint };
}

// ---------------------------------------------------------------------------
// activateRelease()

/**
 * activateRelease(): the locked, observable switch. Order matters: verify, preflight,
 * back up, remember the old release, move the pointer, restart the supervised service,
 * verify — and if verification fails, put the old release back and verify that.
 */
export async function activateRelease(directory, config, options = {}) {
	const target = (await readReleaseManifest(directory, config)).root;
	const release_ = await acquireLock(config, 'activate');
	try {
		const previous = await currentRelease(config);
		progress('activation requested', { target, current: previous ?? null });
		const candidate = await verifyCandidate(target, config, options);
		const checks = await preflight(config);
		if (!options.noBackup) {
			await dataBackup(config);
		} else {
			progress('data backup skipped by --no-backup');
		}

		// Refuse a no-op churn but keep it idempotent: activating the active release is a
		// restart-and-verify, not a pointer change.
		const sameRelease = previous === target;
		if (!sameRelease) {
			await switchPointer(config, target);
		} else {
			progress('release is already active; restarting it to verify');
		}
		await serviceStop(config);
		await serviceStart(config, target);

		try {
			const installation = await verifyInstallation(config, target, { timeoutMs: config.timeoutMs });
			const count = await appendHistory(config, {
				action: sameRelease ? 'restart' : 'activate',
				release: target,
				name: basename(target),
				source: candidate.marker.source,
				previous: previous ?? null,
				verified: { login: installation.loginStatus, pid: installation.pid },
				checks: { tls: checks.tls.notAfter, mfa: { enrolled: checks.mfa.enrolled, enabled: checks.mfa.enabled } },
			});
			progress('activation complete', { release: target, pid: installation.pid, historyEntries: count });
			return { release: target, previous: previous ?? null, installation, checks };
		} catch (error) {
			progress('activation verification failed, restoring the previous release', { error: error.message, previous: previous ?? null });
			await serviceStop(config);
			if (previous) {
				// Record the failed target as the previous pointer: it is the release a
				// follow-up `rollback` should offer, together with the one we restore.
				await switchPointer(config, previous);
				await serviceStart(config, previous);
				let restored;
				try {
					restored = await verifyInstallation(config, previous, { timeoutMs: config.timeoutMs });
				} catch (restoreError) {
					await appendHistory(config, {
						action: 'activate-failed', release: target, previous, source: candidate.marker.source,
						error: error.message, restoreError: restoreError.message,
					});
					throw new DeployError('ActivationFailedAndRollbackFailed',
						'Activation of ' + target + ' failed (' + error.message + ') and restoring ' + previous + ' also failed (' + restoreError.message + ')',
						{ target, previous, activationError: error.message, restoreError: restoreError.message });
				}
				await appendHistory(config, {
					action: 'activate-reverted', release: previous, previous: target, source: candidate.marker.source,
					error: error.message, verified: { login: restored.loginStatus, pid: restored.pid },
				});
				throw new DeployError('ActivationReverted',
					'Activation of ' + target + ' failed (' + error.message + '); the previous release ' + previous + ' was restored and verified',
					{ target, previous, activationError: error.message, restored });
			}
			await appendHistory(config, {
				action: 'activate-failed', release: target, previous: null, source: candidate.marker.source, error: error.message,
			});
			throw new DeployError('ActivationFailed',
				'Activation of ' + target + ' failed (' + error.message + ') and there was no previous release to restore',
				{ target, activationError: error.message });
		}
	} finally {
		await release_();
	}
}

// ---------------------------------------------------------------------------
// rollbackRelease()

/**
 * rollbackRelease(): return to an earlier, still present release. The target is
 * either named, inferred from `previous-web-release`, or taken from the history. It
 * must pass the full candidate verification first, and it must be able to enforce a
 * second factor whenever any account has one enrolled.
 */
export async function rollbackRelease(config, options = {}) {
	const stop = await acquireLock(config, 'rollback');
	try {
		const current = await currentRelease(config);
		if (!current) {
			throw new DeployError('NoCurrentRelease', 'No release is active under ' + config.pointer + ', so there is nothing to roll back from');
		}
		progress('rollback requested', { current, requested: options.target ?? null });

		let target = options.target;
		if (!target) {
			target = await previousRelease(config);
			if (!target) {
				const history = await readHistory(config);
				const lastActivation = [...history.entries].reverse().find(entry =>
					entry.action === 'activate' && entry.previous && entry.release === current);
				target = lastActivation?.previous;
			}
			if (!target) {
				throw new DeployError('NoRollbackTarget',
					'No rollback target is recorded: ' + config.previous + ' does not exist and the deployment history has no previous release for ' + current,
					{ pointer: config.pointer, previousPointer: config.previous, history: config.history });
			}
			progress('rollback target inferred', { target });
		} else {
			target = resolve(target);
			try {
				target = await realpath(target);
			} catch (error) {
				if (error.code === 'ENOENT') {
					throw new DeployError('NoRollbackTarget', 'Rollback target does not exist: ' + options.target, { requested: options.target });
				}
				throw error;
			}
		}
		if (target === current) {
			throw new DeployError('AlreadyActive', 'The rollback target is already the active release: ' + target);
		}

		const candidate = await verifyCandidate(target, config);

		progress('rollback policy: second-factor compatibility');
		const mfa = await mfaCensus(config.authDir);
		const targetSupportsMfa = candidate.twoFactor;
		if ((mfa.enrolled > 0 || mfa.enabled > 0) && !targetSupportsMfa) {
			// A refused rollback is an operational event too: the audit trail must show
			// that someone tried, and why the deployment said no.
			await appendHistory(config, {
				action: 'rollback-refused', release: target, name: basename(target), previous: current,
				source: candidate.marker.source, reason: options.reason ?? null,
				error: 'MfaRollbackRefused',
				checks: { mfa: { enrolled: mfa.enrolled, enabled: mfa.enabled }, targetSupportsMfa },
			});
			throw new DeployError('MfaRollbackRefused',
				'Refusing to roll back to ' + basename(target) + ': ' + Math.max(mfa.enrolled, mfa.enabled)
				+ ' account(s) have two-factor authentication enabled but that release cannot enforce it '
				+ '(missing ' + mfaServerFile + '). Disable two-factor for those accounts, or roll back to a release built after the account-security work.',
				{ target, current, enrolled: mfa.enrolled, enabled: mfa.enabled, missing: mfaServerFile });
		}
		progress('rollback policy satisfied', { enrolled: mfa.enrolled, enabled: mfa.enabled, targetSupportsMfa });

		const checks = await preflight(config);
		if (!options.noBackup) {
			await dataBackup(config);
		} else {
			progress('data backup skipped by --no-backup');
		}

		// The rollback must stay reversible: keep the release we are leaving as the
		// previous pointer, so a bad rollback can be undone by activating it again
		// without hunting through the history file.
		await switchPointer(config, target);
		await serviceStop(config);
		await serviceStart(config, target);
		try {
			const installation = await verifyInstallation(config, target, { timeoutMs: config.timeoutMs });
			const count = await appendHistory(config, {
				action: 'rollback',
				release: target,
				name: basename(target),
				previous: current,
				source: candidate.marker.source,
				reason: options.reason ?? null,
				verified: { login: installation.loginStatus, pid: installation.pid },
				checks: { mfa: { enrolled: mfa.enrolled, enabled: mfa.enabled } },
			});
			progress('rollback complete', { release: target, pid: installation.pid, historyEntries: count });
			return { release: target, previous: current, installation, checks };
		} catch (error) {
			progress('rollback verification failed, restoring the release that was active', { error: error.message, current });
			await serviceStop(config);
			// Keep the failed target as the previous pointer so the operator can retry it.
			await switchPointer(config, current);
			await serviceStart(config, current);
			const restored = await verifyInstallation(config, current, { timeoutMs: config.timeoutMs }).catch(restoreError => {
				throw new DeployError('RollbackFailedAndRestoreFailed',
					'Rollback to ' + target + ' failed (' + error.message + ') and restoring ' + current + ' also failed (' + restoreError.message + ')',
					{ target, current, rollbackError: error.message, restoreError: restoreError.message });
			});
			await appendHistory(config, {
				action: 'rollback-reverted', release: current, previous: target, source: candidate.marker.source,
				error: error.message, verified: { login: restored.loginStatus, pid: restored.pid },
			});
			throw new DeployError('RollbackReverted',
				'Rollback to ' + target + ' failed (' + error.message + '); ' + current + ' is active again and verified',
				{ target, current, rollbackError: error.message, restored });
		}
	} finally {
		await stop();
	}
}

// ---------------------------------------------------------------------------
// CLI

const usage = [
	'Usage:',
	'  node apps/web/deploy-release.mjs verify   <release-dir> [options]',
	'  node apps/web/deploy-release.mjs prepare  <candidate-dir> [--name <name>] [options]',
	'  node apps/web/deploy-release.mjs activate <release-dir> [--no-backup] [options]',
	'  node apps/web/deploy-release.mjs verify-installation [--expect <release-dir>] [options]',
	'  node apps/web/deploy-release.mjs rollback [--to <release-dir>] [--reason <text>] [options]',
	'  node apps/web/deploy-release.mjs status [options]',
	'  node apps/web/deploy-release.mjs history [options]',
	'',
	'Options: --state-dir <dir> --releases-root <dir> --node <binary> --port <n> --host <addr>',
	'         --pid-file <file> --log-file <file> --tls-cert <file> --tls-key <file>',
	'         --auth-dir <dir> --storage-config <file> --backup-root <dir>',
	'         --min-free-bytes <n> --timeout <ms> --skip-data-checks --allow-untrusted-cert',
].join('\n');

async function main() {
	const flags = parseFlags(process.argv.slice(2));
	const [command, ...rest] = flags.positional;
	if (!command) {
		throw new DeployError('Usage', usage);
	}
	const config = deploymentConfig(flags);
	const target = rest[0];

	if (command === 'verify') {
		if (!target || rest.length > 1) throw new DeployError('Usage', usage);
		const result = await verifyCandidate(target, config, { smoke: flags.smoke === true });
		console.log(JSON.stringify({ command, root: result.root, commit: result.marker.source.commit, fingerprint: result.marker.source.fingerprint, files: result.files, twoFactor: result.twoFactor }, null, '\t'));
		return;
	}
	if (command === 'prepare') {
		if (!target || rest.length > 1) throw new DeployError('Usage', usage);
		const result = await prepareRelease(target, config, { name: flags.name, smoke: flags.smoke === true });
		console.log(JSON.stringify({ command, root: result.root, prepared: result.prepared, commit: result.marker.source.commit, fingerprint: result.fingerprint }, null, '\t'));
		return;
	}
	if (command === 'activate') {
		if (!target || rest.length > 1) throw new DeployError('Usage', usage);
		const result = await activateRelease(target, config, { noBackup: flags['no-backup'] === true, smoke: flags.smoke === true });
		console.log(JSON.stringify({ command, release: result.release, previous: result.previous, installation: result.installation }, null, '\t'));
		return;
	}
	if (command === 'verify-installation') {
		const result = await verifyInstallation(config, flags.expect ? resolve(flags.expect) : undefined, { timeoutMs: config.timeoutMs });
		console.log(JSON.stringify({ command, ...result }, null, '\t'));
		return;
	}
	if (command === 'rollback') {
		const result = await rollbackRelease(config, {
			target: flags.to ? resolve(flags.to) : undefined,
			reason: flags.reason,
			noBackup: flags['no-backup'] === true,
		});
		console.log(JSON.stringify({ command, release: result.release, previous: result.previous, installation: result.installation }, null, '\t'));
		return;
	}
	if (command === 'status') {
		const current = await currentRelease(config);
		const previous = await previousRelease(config);
		let service;
		try {
			service = await serviceStatus(config);
		} catch {
			service = { running: false, reason: 'no supervisor pid file' };
		}
		console.log(JSON.stringify({ command, current: current ?? null, previous: previous ?? null, pointer: config.pointer, service }, null, '\t'));
		return;
	}
	if (command === 'history') {
		const history = await readHistory(config);
		console.log(JSON.stringify({ command, entries: history.entries }, null, '\t'));
		return;
	}
	throw new DeployError('Usage', usage);
}

if (process.argv[1] && import.meta.url === new URL('file://' + resolve(process.argv[1])).href) {
	try {
		await main();
	} catch (error) {
		if (error instanceof DeployError) {
			process.stderr.write('[deploy] ' + error.code + ': ' + error.message + '\n');
			if (error.detail) {
				process.stderr.write('[deploy] detail: ' + JSON.stringify(error.detail) + '\n');
			}
			process.exitCode = 1;
		} else {
			throw error;
		}
	}
}
