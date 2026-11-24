#!/usr/bin/env node
// Produce one restorable backup: the account database, the account and Git secrets,
// the PostgreSQL metadata dump, every immutable object the snapshot references, and
// the deployment configuration needed to start the service on a bare host.
//
// Everything is written through `backup-manifest.mjs`, which owns the contract (which
// members are mandatory), the envelope format (AES-256-GCM under one scrypt-derived
// key per run) and the outcome bookkeeping. This file's job is only to *obtain* the
// bytes and to keep the whole run atomic:
//
//   stage in a sibling temp directory -> verify the finished manifest with the key
//   -> rename into place -> record the outcome
//
// The verify-before-publish step is what makes "a backup directory exists" mean "a
// backup was proven restorable when it was written". A run that fails at any point
// removes its staging directory and records a failure, so a stale success timestamp
// can never be produced by a crashed run.
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { copyFile, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { freemem, hostname, homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { isValidWorkspaceId } from './workspace-contract.mjs';
import { openRustfsBlobs } from './rustfs-blobs.mjs';
import { openSealer, writeKeyFile } from './backup-cipher.mjs';
import {
	discardBackup,
	planBackupScope,
	pruneBackups,
	readManifest,
	recordBackupOutcome,
	sealMember,
	sealMemberFromBytes,
	scopeFull,
	scopeLimited,
	verifyBackupManifest,
	writeManifest,
} from './backup-manifest.mjs';
import { formatDuration } from './backup-manifest.mjs';

const run = promisify(execFile);
const home = homedir();
const defaultAuthDir = path.join(home, '.cache', 'log4stellar-demo', 'auth');
const defaultConfigDir = path.join(home, '.config', 'log4stellar');
const defaultStorageConfig = path.join(defaultConfigDir, 'workspace-storage.json');

/** The deployment files a restore onto a bare host needs; copied when present. */
const defaultDeploymentFiles = ['workspace-storage.json', 'web-clients', 'start-web.sh'];

/** @param {string} file */
async function sha256File(file) {
	const hash = createHash('sha256');
	for await (const chunk of createReadStream(file)) {
		hash.update(chunk);
	}
	return hash.digest('hex');
}

/** @param {string} target */
async function sizeOf(target) {
	return (await stat(target)).size;
}

/**
 * Copies the SQLite database through SQLite's own backup surface.
 *
 * A plain file copy is not safe here: the account database runs in WAL mode, so recent
 * commits live in `auth.sqlite-wal` and copying the main file alone silently loses
 * them (the live database's WAL held 2.6 MB against a 68 KB main file when this was
 * written). `VACUUM INTO` produces one consistent file with no sidecar to also copy.
 * @param {string} source
 * @param {string} destination
 */
async function backupSqlite(source, destination) {
	const database = new DatabaseSync(source, { readOnly: true });
	try {
		await database.exec(`VACUUM INTO '${destination.replace(/'/g, "''")}'`);
	} finally {
		database.close();
	}
}

/**
 * Checks the account snapshot really carries what a restore needs.
 *
 * A snapshot with no `workspace_member` table would restore accounts that cannot reach
 * any workspace, which is a backup in name only; refusing here is cheaper than
 * discovering it during an incident.
 * @param {string} snapshotPath
 */
function inspectAuthSnapshot(snapshotPath) {
	const database = new DatabaseSync(snapshotPath, { readOnly: true });
	try {
		const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map(row => row.name);
		if (!tables.includes('workspace_member')) {
			throw new Error('The account snapshot has no workspace_member table; refusing to call this a backup.');
		}
		// `role` arrived with the workspace access work; an older database still has the
		// original three columns. Read whichever exists instead of assuming the newest
		// schema, because a backup has to work against the live deployment.
		const columns = database.prepare('PRAGMA table_info(workspace_member)').all().map(row => row.name);
		const select = columns.includes('role')
			? 'SELECT tenant_id, workspace_id, user_id, role FROM workspace_member ORDER BY tenant_id, workspace_id, user_id'
			: 'SELECT tenant_id, workspace_id, user_id FROM workspace_member ORDER BY tenant_id, workspace_id, user_id';
		const rows = database.prepare(select).all();
		return {
			tables,
			memberColumns: columns,
			memberships: rows.length,
			workspaces: [...new Set(rows.map(row => row.workspace_id))].sort(),
			note: columns.includes('role') ? null : 'workspace_member has no role column: this database predates the workspace access migration.',
		};
	} finally {
		database.close();
	}
}

/**
 * Dumps the whole `log4stellar` schema as plain SQL at one exported snapshot.
 *
 * `pg_dump` is the only tool that understands the type graph, identity columns and
 * defacl entries, so a hand-rolled COPY sequence would be a second, worse
 * implementation of it. The snapshot id is exported first so the dump and the object
 * inventory describe the same instant.
 * @param {object} postgres
 * @param {string} destination
 * @param {string} snapshot
 */
async function backupPostgres(postgres, destination, snapshot) {
	if (postgres.ssl && typeof postgres.ssl === 'object' && Object.keys(postgres.ssl).length > 0) {
		throw new Error('Use a pg_dump service configuration for custom PostgreSQL TLS settings.');
	}
	const env = { ...process.env, PGPASSWORD: String(postgres.password ?? '') };
	if (typeof postgres.ssl === 'boolean') {
		env.PGSSLMODE = postgres.ssl ? 'verify-full' : 'disable';
	}
	const args = [
		'--host', String(postgres.host),
		'--port', String(postgres.port),
		'--username', String(postgres.user),
		'--dbname', String(postgres.database),
		'--schema', 'log4stellar',
		'--no-owner', '--no-privileges',
		'--format', 'plain',
		'--snapshot', snapshot,
		'--file', destination,
	];
	if (postgres.ssl === false) args.push('--no-password');
	await runDump(args, destination, env);
}

/**
 * Runs `pg_dump`, falling back to the copy inside the container image.
 *
 * This host has no PostgreSQL client package, and the binary cannot be copied out of
 * a container: the Debian build inside `postgres:18` links against that image's glibc
 * and aborts with a stack smashing error on the host. So when the binary is missing,
 * run the dump inside a throwaway container on the host network and stream the SQL
 * back out; `--network host` is also what reaches a database on 192.0.2.9, which a
 * bridged container would not.
 * @param {string[]} args
 * @param {string} destination
 * @param {NodeJS.ProcessEnv} env
 */
async function runDump(args, destination, env) {
	try {
		await run('pg_dump', args, { env, maxBuffer: 256 * 1024 * 1024 });
		return;
	} catch (error) {
		if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error;
	}
	const image = process.env.LOG4STELLAR_PG_DUMP_IMAGE ?? 'postgres:18';
	const withoutFile = [];
	for (let index = 0; index < args.length; index++) {
		if (args[index] === '--file') { index++; continue; }
		withoutFile.push(args[index]);
	}
	const dump = spawn('docker', [
		'run', '--rm', '--network', 'host',
		'-e', 'PGPASSWORD',
		image, 'pg_dump', ...withoutFile,
	], { env, stdio: ['ignore', 'pipe', 'inherit'] });
	const exited = new Promise((resolve, reject) => {
		dump.once('error', reject);
		dump.once('close', (status, signal) => status === 0 ? resolve() : reject(new Error('Container pg_dump failed: ' + (signal ?? status))));
	});
	try {
		await Promise.all([pipeline(dump.stdout, createWriteStream(destination, { flags: 'wx', mode: 0o600 })), exited]);
	} finally {
		if (dump.exitCode === null && dump.signalCode === null) {
			dump.kill();
		}
	}
}

/**
 * Reads the storage metadata and the object inventory at one repeatable-read snapshot.
 *
 * The inventory is taken from `storage_file_versions` rather than from
 * `storage_entries`, because a version that no entry points at any more (an object
 * that was overwritten or emptied into the trash) is still part of "the workspace as
 * it was", and a restore that dropped it would silently lose history.
 * @param {object} postgres
 * @param {string} stage  staging directory for the dump
 */
async function backupStorageMetadata(postgres, stage) {
	const { Pool } = createRequire(import.meta.url)('pg');
	const pool = new Pool({ ...postgres, max: 2 });
	const connection = await pool.connect().catch(async error => {
		await pool.end();
		throw error;
	});
	try {
		await connection.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
		const inventory = (await connection.query(`
			SELECT workspace_id AS "workspaceId", sha256, size_bytes AS "size"
			FROM log4stellar.storage_file_versions
			GROUP BY workspace_id, sha256, size_bytes
			ORDER BY workspace_id, sha256
		`)).rows.map(row => ({ workspaceId: row.workspaceId, sha256: row.sha256, size: Number(row.size) }));
		const counts = (await connection.query(`
			SELECT
				(SELECT count(*) FROM log4stellar.storage_entries)::int AS entries,
				(SELECT count(*) FROM log4stellar.storage_file_versions)::int AS versions,
				(SELECT count(*) FROM log4stellar.storage_trash)::int AS trash,
				(SELECT count(*) FROM log4stellar.storage_workspaces)::int AS workspaces
		`)).rows[0];
		const { rows: [{ snapshot }] } = await connection.query('SELECT pg_export_snapshot() AS snapshot');
		const dumpPath = path.join(stage, 'log4stellar.sql');
		await backupPostgres(postgres, dumpPath, snapshot);
		return { inventory, counts, dumpPath, snapshot };
	} finally {
		try {
			await connection.query('ROLLBACK');
		} finally {
			connection.release();
			await pool.end();
		}
	}
}

/**
 * Exports every referenced object and seals it into the backup.
 *
 * Each object is read at its recorded size, its plaintext digest is re-checked against
 * the inventory (a mismatch is the one case where corrupt bytes would otherwise be
 * preserved faithfully and restored happily), and only then is it encrypted. The
 * manifest records both the digest of the object and the digest of the envelope, so a
 * later verification can tell "the wrong bytes were exported" from "the envelope was
 * damaged on disk".
 * @param {object} s3
 * @param {{ workspaceId: string, sha256: string, size: number }} object
 * @param {{ sealer: object, backupDir: string, stage: string, blobsByWorkspace: Map<string, any> }} context
 */
async function sealObject(s3, object, context) {
	if (!isValidWorkspaceId(object.workspaceId) || !/^[a-f0-9]{64}$/.test(object.sha256)
		|| !Number.isSafeInteger(object.size) || object.size < 0) {
		throw new Error('The storage snapshot contains an invalid object reference: '
			+ object.workspaceId + '/' + object.sha256);
	}
	let blobs = context.blobsByWorkspace.get(object.workspaceId);
	if (!blobs) {
		blobs = await openRustfsBlobs(s3, object.workspaceId, path.join(context.stage, '.blob-spool'));
		context.blobsByWorkspace.set(object.workspaceId, blobs);
	}
	const plaintext = path.join(context.stage, 'object.bin');
	await pipeline(await blobs.read(object.sha256, object.size), createWriteStream(plaintext, { flags: 'wx', mode: 0o600 }));
	try {
		const size = await sizeOf(plaintext);
		if (size !== object.size) {
			throw new Error('Object ' + object.sha256 + ' is ' + size + ' bytes, the inventory says ' + object.size + '.');
		}
		const digest = await sha256File(plaintext);
		if (digest !== object.sha256) {
			throw new Error('Object contents do not match the storage snapshot: expected ' + object.sha256 + ', read ' + digest + '.');
		}
		const directory = path.join(context.backupDir, 'objects', object.workspaceId);
		await mkdir(directory, { recursive: true, mode: 0o700 });
		const destination = path.join(directory, object.sha256 + '.enc');
		const { size: storedSize } = await context.sealer.encryptFile(plaintext, destination);
		return {
			workspaceId: object.workspaceId,
			sha256: object.sha256,
			size: object.size,
			storedSize,
			storedSha256: await sha256File(destination),
			source: {
				type: 's3',
				table: 'log4stellar.storage_file_versions',
				columns: ['workspace_id', 'sha256', 'size_bytes'],
				bucket: s3.bucket ?? null,
				key: 'workspaces/' + object.workspaceId + '/sha256/' + object.sha256,
			},
		};
	} finally {
		await rm(plaintext, { force: true });
	}
}

/**
 * Builds a backup inside `stage` and returns the finished manifest.
 *
 * Members are sealed in the order the contract lists them, and the manifest is written
 * last, so a member that failed to seal is simply absent from a manifest that was never
 * written.
 * @param {object} options
 */
async function createBackup(stage, options) {
	const startedAt = Date.now();
	const plan = planBackupScope({
		scope: options.scope,
		exportObjects: options.scope === scopeFull,
		authDir: options.authDir,
		configDir: options.configDir,
		deploymentFiles: options.deploymentFiles,
		settings: options.settings,
	});
	const sealer = await openSealer(options.keyMaterial);
	const settings = options.settings;
	const deploymentFiles = options.deploymentFiles.filter(name => options.existingDeploymentFiles.has(name));
	const notes = [...plan.warnings];
	for (const name of options.deploymentFiles) {
		if (!options.existingDeploymentFiles.has(name)) {
			notes.push('Deployment file ' + name + ' is not present on this host and was not included.');
		}
	}

	/** @type {Record<string, any>} */
	const manifest = {
		format: 2,
		schema: 1,
		tool: { name: 'log4stellar-backup', version: 2, node: process.version },
		backupId: path.basename(stage),
		scope: plan.scope,
		host: hostname(),
		createdAt: new Date(startedAt).toISOString(),
		completedAt: null,
		encryption: sealer.encryption,
		// Deliberately free of secrets: the endpoint, bucket and database name identify
		// *where* the bytes came from. Credentials live only inside the sealed
		// deployment member, which is exactly what the encryption is for.
		origin: {
			s3: { endpoint: settings.s3.endpoint ?? null, region: settings.s3.region ?? null, bucket: settings.s3.bucket ?? null },
			postgres: {
				host: settings.postgres.host ?? null,
				port: settings.postgres.port ?? null,
				database: settings.postgres.database ?? null,
				schema: 'log4stellar',
			},
		},
		counts: {},
		members: [],
		objects: { directory: 'objects', count: 0, bytes: 0, entries: [] },
		notes,
	};

	const membersByName = new Map(plan.members.map(member => [member.name, member]));

	// 1. The account database, restored from a consistent SQLite snapshot.
	const authSnapshot = path.join(stage, 'auth.sqlite');
	await backupSqlite(path.join(options.authDir, 'auth.sqlite'), authSnapshot);
	const authInspection = inspectAuthSnapshot(authSnapshot);
	if (authInspection.note) {
		manifest.notes.push(authInspection.note);
	}
	manifest.counts.memberships = authInspection.memberships;
	manifest.counts.workspaces = authInspection.workspaces.length;
	manifest.auth = {
		tables: authInspection.tables,
		memberColumns: authInspection.memberColumns,
		workspaceIds: authInspection.workspaces,
	};
	await sealMember(stage, manifest, membersByName.get('auth.sqlite'), { sealer, plaintextPath: authSnapshot });
	await rm(authSnapshot, { force: true });

	// 2. The signing secret: losing it invalidates every session and every sealed
	//    account security secret.
	await sealMember(stage, manifest, membersByName.get('secret'), {
		sealer,
		plaintextPath: path.join(options.authDir, 'secret'),
	});

	// 3. The Git credential sealing key.
	await sealMember(stage, manifest, membersByName.get('git-secret'), {
		sealer,
		plaintextPath: path.join(options.configDir, 'git-secret'),
	});

	// 4. The PostgreSQL metadata dump and the object inventory, at one snapshot.
	const metadata = await backupStorageMetadata(settings.postgres, stage);
	await sealMember(stage, manifest, membersByName.get('log4stellar.sql'), { sealer, plaintextPath: metadata.dumpPath });
	await rm(metadata.dumpPath, { force: true });
	manifest.counts.entries = metadata.counts.entries;
	manifest.counts.versions = metadata.counts.versions;
	manifest.counts.trash = metadata.counts.trash;
	manifest.counts.storageWorkspaces = metadata.counts.workspaces;
	manifest.snapshot = metadata.snapshot;

	const inventory = metadata.inventory;
	/** @type {Map<string, any>} */
	const blobsByWorkspace = new Map();
	try {
		if (plan.exportObjects) {
			const context = { sealer, backupDir: stage, stage, blobsByWorkspace };
			const entries = [];
			for (const object of inventory) {
				entries.push(await sealObject(settings.s3, object, context));
			}
			manifest.objects = {
				directory: 'objects',
				count: entries.length,
				bytes: entries.reduce((total, entry) => total + entry.size, 0),
				references: plan.objects.referencedBy,
				entries,
			};
		}
	} finally {
		for (const blobs of blobsByWorkspace.values()) {
			blobs.close();
		}
		await rm(path.join(stage, '.blob-spool'), { recursive: true, force: true });
	}

	// 5. The inventory as its own sealed member, so a manifest edited to drop objects
	//    is caught by the index digest and a truncated index is caught by the manifest.
	const indexBytes = Buffer.from(JSON.stringify({
		schema: 1,
		scope: plan.scope,
		count: manifest.objects.count,
		bytes: manifest.objects.bytes,
		entries: manifest.objects.entries.map(entry => ({
			workspaceId: entry.workspaceId,
			sha256: entry.sha256,
			size: entry.size,
			storedSha256: entry.storedSha256,
			storedSize: entry.storedSize,
		})),
	}) + '\n');
	await sealMemberFromBytes(stage, manifest, membersByName.get('objects.index'), { sealer, bytes: indexBytes });

	// 6. The deployment configuration, so a restore onto a bare host can start.
	for (const name of deploymentFiles) {
		const member = membersByName.get('deployment/' + name);
		if (!member) {
			continue;
		}
		await sealMember(stage, manifest, member, {
			sealer,
			plaintextPath: path.join(options.configDir, name),
		});
	}

	manifest.counts.members = manifest.members.length;
	manifest.completedAt = new Date().toISOString();
	manifest.durationMs = Date.now() - startedAt;
	return manifest;
}

/** @param {string} file */
async function readJsonIfPresent(file) {
	try {
		return JSON.parse(await readFile(file, 'utf8'));
	} catch (error) {
		if (error.code === 'ENOENT') {
			return null;
		}
		throw error;
	}
}

async function requireNewDestination(destination) {
	try {
		await lstat(destination);
	} catch (error) {
		if (error.code === 'ENOENT') {
			return;
		}
		throw error;
	}
	throw new Error('Backup destination already exists: ' + destination);
}

/**
 * Parses the command line.
 *
 * Flags are accepted as `--name=value` and `--name value` because this runs from both
 * a human shell and a scheduler, and getting quoting wrong in a cron entry is a
 * classic way to end up with a backup that silently wrote to the wrong place.
 * @param {string[]} argv
 */
function parseArguments(argv) {
	const parsed = {
		target: null,
		scope: scopeFull,
		keyFile: process.env.LOG4STELLAR_BACKUP_KEY_FILE ?? null,
		stateDir: process.env.LOG4STELLAR_BACKUP_STATE ?? null,
		trigger: 'manual',
		deploymentFiles: null,
		keep: Number(process.env.LOG4STELLAR_BACKUP_KEEP ?? 7),
		maxAgeHours: Number(process.env.LOG4STELLAR_BACKUP_MAX_AGE_HOURS ?? 720),
		prune: true,
		selfVerify: true,
		json: false,
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
		const inlineValue = equals === -1 ? null : argument.slice(equals + 1);
		const takeValue = () => {
			if (inlineValue !== null) {
				return inlineValue;
			}
			const next = argv[++index];
			if (next === undefined) {
				throw new Error('The flag --' + name + ' needs a value.');
			}
			return next;
		};
		switch (name) {
			case 'scope': parsed.scope = takeValue(); break;
			case 'key-file': parsed.keyFile = takeValue(); break;
			case 'state-dir': parsed.stateDir = takeValue(); break;
			case 'trigger': parsed.trigger = takeValue(); break;
			case 'deployment': parsed.deploymentFiles = takeValue().split(',').map(value => value.trim()).filter(Boolean); break;
			case 'keep': parsed.keep = Number(takeValue()); break;
			case 'max-age-hours': parsed.maxAgeHours = Number(takeValue()); break;
			case 'no-prune': parsed.prune = false; break;
			case 'no-self-verify': parsed.selfVerify = false; break;
			case 'json': parsed.json = true; break;
			case 'help':
				parsed.help = true;
				break;
			default:
				throw new Error('Unknown flag: --' + name);
		}
	}
	if (positional.length > 1) {
		throw new Error('Usage: node apps/web/backup-data.mjs <output dir> [--scope=full|limited] [--key-file=<path>] [--state-dir=<dir>]');
	}
	parsed.target = positional[0] ?? null;
	if (parsed.scope !== scopeFull && parsed.scope !== scopeLimited) {
		throw new Error('--scope must be "' + scopeFull + '" or "' + scopeLimited + '".');
	}
	if (!Number.isSafeInteger(parsed.keep) || parsed.keep < 1) {
		throw new Error('--keep must be a positive integer.');
	}
	if (!Number.isFinite(parsed.maxAgeHours) || parsed.maxAgeHours <= 0) {
		throw new Error('--max-age-hours must be a positive number.');
	}
	return parsed;
}

const usage = [
	'Usage: node apps/web/backup-data.mjs <output dir> [flags]',
	'',
	'  --scope=full|limited     full (default) also exports every referenced object',
	'  --key-file=<path>        backup key file (0600); required unless LOG4STELLAR_BACKUP_KEY_FILE is set',
	'  --state-dir=<dir>        where state.json / outcomes.jsonl / alert.json live',
	'  --trigger=manual|schedule  recorded in the outcome history',
	'  --deployment=a,b,c       deployment files to include (default: workspace-storage.json,web-clients,start-web.sh)',
	'  --keep=<n>               backups to retain in the destination parent (default 7)',
	'  --max-age-hours=<n>      retention window (default 720)',
	'  --no-prune               keep every existing backup',
	'  --no-self-verify         skip the verify pass on the finished manifest (not recommended)',
].join('\n');

async function main() {
	const options = parseArguments(process.argv.slice(2));
	if (options.help) {
		process.stdout.write(usage + '\n');
		return;
	}
	if (!options.target) {
		process.stderr.write(usage + '\n');
		throw new Error('A backup destination is required.');
	}
	// 0077 for the whole process: a backup directory that is world-readable defeats the
	// encryption only by being careless about the manifest, which is not encrypted.
	process.umask(0o077);

	const outDir = path.resolve(options.target);
	const parent = path.dirname(outDir);
	const startedAt = Date.now();
	const authDir = process.env.LOG4STELLAR_AUTH_DIR ?? defaultAuthDir;
	const configDir = path.dirname(process.env.LOG4STELLAR_STORAGE_CONFIG ?? defaultStorageConfig);
	const storageConfigPath = process.env.LOG4STELLAR_STORAGE_CONFIG ?? defaultStorageConfig;
	const settings = JSON.parse(await readFile(storageConfigPath, 'utf8'));

	if (!options.keyFile) {
		throw new Error('A backup key file is required: pass --key-file=<path> or set LOG4STELLAR_BACKUP_KEY_FILE.');
	}
	const keyMaterial = { keyFile: options.keyFile };

	const deploymentFiles = options.deploymentFiles ?? defaultDeploymentFiles;
	const existingDeploymentFiles = new Set();
	for (const name of deploymentFiles) {
		try {
			await stat(path.join(configDir, name));
			existingDeploymentFiles.add(name);
		} catch (error) {
			if (error.code !== 'ENOENT') throw error;
		}
	}

	await requireNewDestination(outDir);
	await mkdir(parent, { recursive: true, mode: 0o700 });
	const stage = await mkdtemp(path.join(parent, '.log4stellar-backup-'));
	let manifest = null;
	try {
		manifest = await createBackup(stage, {
			scope: options.scope,
			keyMaterial,
			authDir,
			configDir,
			deploymentFiles,
			existingDeploymentFiles,
			settings,
		});
		await writeManifest(stage, manifest);

		// Prove the backup before publishing it. A directory that exists but cannot be
		// restored is worse than no directory, because it makes the freshness check lie.
		if (options.selfVerify) {
			await verifyBackupManifest(stage, {
				keyMaterial,
				expectScope: options.scope,
				allowMetadataOnly: options.scope === scopeLimited,
			});
		}
		await requireNewDestination(outDir);
		const backupId = path.basename(outDir);
		manifest.backupId = backupId;
		await writeManifest(stage, manifest);
		await rename(stage, outDir);

		const published = await readManifest(outDir);
		const finishedAt = Date.now();
		let prune = null;
		if (options.prune) {
			prune = await pruneBackups(parent, {
				keep: options.keep,
				maxAgeMs: options.maxAgeHours * 60 * 60 * 1000,
			});
		}
		if (options.stateDir) {
			await recordBackupOutcome(options.stateDir, {
				status: 'success',
				trigger: options.trigger,
				scope: published.scope,
				backupDir: outDir,
				startedAt,
				finishedAt,
				members: published.counts?.members ?? published.members.length,
				objects: published.objects?.count ?? 0,
				bytes: published.objects?.bytes ?? 0,
				host: published.host,
			});
		}
		const summary = {
			outDir,
			scope: published.scope,
			members: published.members.map(member => member.name),
			memberships: published.counts?.memberships,
			entries: published.counts?.entries,
			objects: published.objects?.count ?? 0,
			bytes: published.objects?.bytes ?? 0,
			duration: formatDuration(finishedAt - startedAt),
			pruned: prune?.removed ?? [],
		};
		if (options.json) {
			process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
		} else {
			process.stdout.write(
				'Backup ' + published.scope + ' published to ' + outDir + '\n'
				+ '  members:   ' + summary.members.join(', ') + '\n'
				+ '  accounts:  ' + summary.memberships + ' memberships\n'
				+ '  metadata:  ' + summary.entries + ' entries\n'
				+ '  objects:   ' + summary.objects + ' (' + summary.bytes + ' bytes)\n'
				+ '  duration:  ' + summary.duration + '\n',
			);
		}
	} catch (error) {
		// A failed run leaves no debris and, crucially, records the failure: the
		// freshness check must be able to say "the last attempt failed N minutes ago"
		// instead of quietly reporting the age of an older success.
		await discardBackup(stage);
		if (options.stateDir) {
			try {
				await recordBackupOutcome(options.stateDir, {
					status: 'failure',
					trigger: options.trigger,
					scope: options.scope,
					backupDir: outDir,
					startedAt,
					finishedAt: Date.now(),
					error: { message: error.message, code: error.code ?? null },
				});
			} catch (recordError) {
				process.stderr.write('Could not record the backup failure: ' + recordError.message + '\n');
			}
		}
		throw error;
	}
}

export { createBackup, inspectAuthSnapshot, parseArguments, usage, writeKeyFile };

if (import.meta.url === 'file://' + process.argv[1]) {
	await main().catch(error => {
		process.stderr.write('Backup failed: ' + (error?.message ?? error) + '\n');
		if (error?.details?.problems) {
			for (const problem of error.details.problems) {
				process.stderr.write('  - ' + problem.code + ': ' + problem.message + '\n');
			}
		}
		process.exitCode = 1;
	});
}
