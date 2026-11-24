#!/usr/bin/env node
// Restore a backup produced by `backup-data.mjs` into an operator-chosen target.
//
// The order of operations is the whole point of this file:
//
//   verify -> decrypt to a staging directory -> restore -> read back
//
// Verification happens before a single byte is written to a live target, and it is
// performed *with the key*, so a wrong key, a damaged envelope or a member that does
// not decrypt is discovered while the only thing at risk is a temp directory. A
// partial restore is never possible from a backup that fails verification, because
// the manifest has already been proven to describe exactly the members on disk.
//
// Restoring to production is refused by construction, not by politeness: the target
// object store, account directory and database are compared against the `origin`
// recorded in the manifest, and a match fails with `RestoreTargetRefused`. That check
// exists because the most dangerous moment in a restore is an operator under pressure
// pointing `--objects-config` at the live storage configuration.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import { openRustfsBlobs } from './rustfs-blobs.mjs';
import { BackupVerificationError, RestoreTargetError, verifyBackupManifest } from './backup-manifest.mjs';
import { formatDuration } from './backup-manifest.mjs';

/** @param {string} file */
async function sha256File(file) {
	const hash = createHash('sha256');
	for await (const chunk of createReadStream(file)) {
		hash.update(chunk);
	}
	return hash.digest('hex');
}

/**
 * Decides whether a restore target would overwrite the backup's own origin.
 *
 * Compares endpoint and bucket for storage, host/port/database for PostgreSQL, and the
 * resolved path for the account directory. A restore that lands on the origin is not a
 * restore drill, it is an incident, so this throws rather than warning.
 * @param {object} manifest
 * @param {object} target
 */
export function assertRestoreTargetIsSeparate(manifest, target) {
	const origin = manifest.origin ?? {};
	const problems = [];
	if (target.s3 && origin.s3) {
		const sameEndpoint = normalizeEndpoint(target.s3.endpoint) === normalizeEndpoint(origin.s3.endpoint);
		if (sameEndpoint && target.s3.bucket === origin.s3.bucket) {
			problems.push('storage: ' + target.s3.endpoint + '/' + target.s3.bucket + ' is the backed-up bucket');
		}
	}
	if (target.postgres && origin.postgres) {
		const same = String(target.postgres.host) === String(origin.postgres.host)
			&& String(target.postgres.port) === String(origin.postgres.port)
			&& String(target.postgres.database) === String(origin.postgres.database);
		if (same) {
			problems.push('postgres: ' + target.postgres.host + ':' + target.postgres.port + '/' + target.postgres.database
				+ ' is the backed-up database');
		}
	}
	if (target.authDir && manifest.origin?.authDir && path.resolve(target.authDir) === path.resolve(manifest.origin.authDir)) {
		problems.push('accounts: ' + target.authDir + ' is the backed-up account directory');
	}
	if (problems.length > 0) {
		throw new RestoreTargetError(
			'Refusing to restore onto the source of this backup:\n  - ' + problems.join('\n  - ')
			+ '\nChoose a separate target; restoring over the original destroys the evidence a drill is meant to produce.',
			{ target: problems.join('; ') },
		);
	}
}

function normalizeEndpoint(endpoint) {
	try {
		return new URL(String(endpoint)).href;
	} catch {
		return String(endpoint);
	}
}

/**
 * Restores the decrypted members into a plain directory.
 *
 * This is the drill path: everything lands under one directory that the caller owns and
 * can delete, the SQLite file is opened to prove it is a database, the dump is scanned
 * for every expected table, and nothing outside that directory is touched. A real
 * disaster restore uses the same verified bytes but writes them to the live services
 * (see {@link restoreToServices}).
 * @param {object} verified  the result of verifyBackupManifest with keepPlaintext
 * @param {string} targetDir
 */
export async function restoreToDirectory(verified, targetDir) {
	const directory = path.resolve(targetDir);
	const plaintext = verified.plaintext;
	if (!plaintext) {
		throw new Error('restoreToDirectory needs the decrypted members: call verifyBackupManifest with keepPlaintext.');
	}
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const restored = {};
	const sqliteSource = await requirePlaintext(plaintext, 'auth.sqlite', 'account database');
	const gitSecretSource = await requirePlaintext(plaintext, 'git-secret', 'Git sealing key');
	const secretSource = await requirePlaintext(plaintext, 'secret', 'account signing secret');
	const dumpSource = await requirePlaintext(plaintext, 'log4stellar.sql', 'PostgreSQL dump');
	const authTarget = path.join(directory, 'auth.sqlite');
	await copyFile(sqliteSource, authTarget);
	restored.auth = { path: authTarget, sha256: await sha256File(authTarget) };

	for (const [name, source] of [['secret', secretSource], ['git-secret', gitSecretSource]]) {
		const target = path.join(directory, name);
		await copyFile(source, target);
		await chmodSecret(target);
		restored[name] = { path: target, sha256: await sha256File(target) };
	}

	const dumpTarget = path.join(directory, 'log4stellar.sql');
	await copyFile(dumpSource, dumpTarget);
	const sqlSummary = await inspectSqlDump(dumpTarget);
	restored.sql = { path: dumpTarget, sha256: await sha256File(dumpTarget), ...sqlSummary };

	// The object bytes are restored by `restoreObjectBytes`, not here: they are the one
	// part of a restore that cannot land in a plain directory and still be useful.
	return restored;
}

/**
 * Returns the staged plaintext of a member, or fails because a restore with a missing
 * member would be a partial restore wearing a success message.
 *
 * The file is stat'ed rather than trusted from the map: a staged file can disappear
 * between verification and restore (a full /tmp, an aggressive cleaner), and restore is
 * the one place where "almost all of the data" is not better than stopping.
 * @param {Map<string, string>} plaintext
 * @param {string} name
 * @param {string} label
 */
async function requirePlaintext(plaintext, name, label) {
	const staged = plaintext.get(name);
	if (!staged) {
		throw new BackupVerificationError('The backup has no decrypted ' + label + ' to restore.', { code: 'MemberMissing' });
	}
	try {
		await stat(staged);
	} catch {
		throw new BackupVerificationError('The decrypted ' + label + ' vanished before it could be restored: ' + staged, {
			code: 'MemberMissing',
		});
	}
	return staged;
}

async function chmodSecret(target) {
	const { chmod } = await import('node:fs/promises');
	await chmod(target, 0o600);
}

/**
 * Reads a plain-SQL dump enough to prove it is the dump of this workspace.
 *
 * A dump that is truncated mid-COPY, or one from another database, would otherwise
 * only fail at the end of a long psql run; scanning for the schema, every expected
 * table and the closing `PostgreSQL database dump complete` marker catches it while the
 * restore is still cheap to redo. Reported, not thrown: a caller restoring a subset
 * may legitimately expect fewer tables.
 * @param {string} dumpPath
 */
export async function inspectSqlDump(dumpPath) {
	const text = await readFile(dumpPath, 'utf8');
	const tables = [];
	for (const match of text.matchAll(/CREATE TABLE log4stellar\.("?)([A-Za-z0-9_]+)\1/g)) {
		tables.push(match[2]);
	}
	const hasSchema = /CREATE SCHEMA (?:IF NOT EXISTS )?log4stellar;/.test(text);
	// pg_dump 18 closes the file with the completion comment, then a blank line and a
	// `\unrestrict <token>` psql meta-command, so the marker is not the last line. Strip the
	// trailer's blank lines, meta-commands and comment rules before looking for it;
	// otherwise every dump taken by a recent pg_dump would be reported as truncated and a
	// real restore would be refused.
	const tail = text.trimEnd().split('\n');
	while (tail.length > 1) {
		const last = (tail.at(-1) ?? '').trim();
		if (last === '' || /^\\[A-Za-z]/.test(last) || (last.startsWith('--') && !last.includes('database dump complete'))) {
			tail.pop();
			continue;
		}
		break;
	}
	const complete = (tail.at(-1) ?? '').trim().replace(/^--\s*/, '') === 'PostgreSQL database dump complete';
	const copyStatements = (text.match(/^COPY log4stellar\./gm) ?? []).length;
	return {
		tables: [...new Set(tables)].sort(),
		hasSchema,
		complete,
		copyStatements,
		bytes: Buffer.byteLength(text),
	};
}

/**
 * Restores the sealed object bytes into a separate S3-compatible target.
 *
 * Each object is decrypted to a staging file, its digest is re-checked against the
 * manifest (so a corrupt envelope cannot be laundered into the target), then uploaded
 * and read back. The read-back is what makes the drill meaningful: an upload that
 * silently stored a different key layout would otherwise look like a success.
 * @param {object} verified
 * @param {object} options
 * @param {object} options.s3  target storage settings (must be a separate endpoint or bucket)
 * @param {(message: string) => void} [options.log]
 * @param {'rustfs' | 'directory'} [options.backend]  test hook: write to a directory instead
 * @param {string} [options.spool]
 */
export async function restoreObjectBytes(verified, options) {
	assertRestoreTargetIsSeparate(verified.manifest, { s3: options.s3 });
	const entries = verified.objects.entries;
	if (entries.length === 0) {
		return { restored: 0, bytes: 0, verified: 0 };
	}
	const sealer = verified.sealer ?? await (async () => {
		throw new BackupVerificationError('Object restore needs the backup key to decrypt the export.', { code: 'KeyRequired' });
	})();
	const spool = options.spool ?? await mkdtemp(path.join(tmpdir(), 'log4stellar-object-restore-'));
	const owned = options.spool === undefined;
	const openBlobs = options.backend === 'directory'
		? (await import('./test-support/directory-blobs.mjs')).openDirectoryBlobs
		: openRustfsBlobs;
	const byWorkspace = new Map();
	let restored = 0;
	let bytes = 0;
	try {
		for (const entry of entries) {
			let blobs = byWorkspace.get(entry.workspaceId);
			if (!blobs) {
				blobs = await openBlobs(options.s3, entry.workspaceId, spool);
				byWorkspace.set(entry.workspaceId, blobs);
			}
			const envelope = path.join(verified.backupDir, verified.objects.directory, entry.workspaceId, entry.sha256 + '.enc');
			const plaintext = path.join(spool, 'restore-' + entry.sha256);
			await sealer.decryptFile(envelope, plaintext);
			try {
				const digest = await sha256File(plaintext);
				if (digest !== entry.sha256) {
					throw new BackupVerificationError(
						'The decrypted object ' + entry.workspaceId + '/' + entry.sha256 + ' has digest ' + digest + '.',
						{ code: 'ObjectContentDigestMismatch' },
					);
				}
				const size = (await stat(plaintext)).size;
				if (size !== entry.size) {
					throw new BackupVerificationError(
						'The decrypted object ' + entry.sha256 + ' is ' + size + ' bytes, the manifest says ' + entry.size + '.',
						{ code: 'ObjectContentSizeMismatch' },
					);
				}
				const result = await blobs.put(createReadStream(plaintext), size);
				if (result.digest !== entry.sha256 || result.size !== size) {
					throw new BackupVerificationError('The restore target stored different bytes for ' + entry.sha256 + '.', {
						code: 'RestoreWriteMismatch',
					});
				}
				// Read back: proves the bytes are retrievable under the key layout the
				// workspace expects, not merely that a PUT was accepted.
				const hash = createHash('sha256');
				let readSize = 0;
				for await (const chunk of await blobs.read(entry.sha256, size)) {
					hash.update(chunk);
					readSize += chunk.length;
				}
				if (readSize !== size || hash.digest('hex') !== entry.sha256) {
					throw new BackupVerificationError('The restored object ' + entry.sha256 + ' does not read back identically.', {
						code: 'RestoreReadMismatch',
					});
				}
				restored++;
				bytes += size;
			} finally {
				await rm(plaintext, { force: true });
			}
		}
		return { restored, bytes, verified: entries.length };
	} finally {
		for (const blobs of byWorkspace.values()) {
			blobs.close();
		}
		if (owned) {
			await rm(spool, { recursive: true, force: true });
		}
	}
}

/**
 * Applies a restored database and account directory to live (non-production) services.
 *
 * Kept deliberately small: `psql` is the only thing that can apply a plain-SQL dump
 * faithfully, and the account directory is a file copy. The caller is responsible for
 * pointing both at a *separate* target; {@link assertRestoreTargetIsSeparate} is called
 * first so a mistake fails here rather than after the drop.
 * @param {object} verified
 * @param {object} options
 * @param {object} options.postgres  target connection settings
 * @param {string} options.dumpPath  the verified plain-SQL dump
 * @param {boolean} [options.dropSchema]  drop the schema first (a clean restore)
 * @param {string} [options.psqlImage]  container image used when psql is unavailable
 * @param {(message: string) => void} [options.log]
 */
export async function restoreToServices(verified, options) {
	assertRestoreTargetIsSeparate(verified.manifest, { postgres: options.postgres });
	const log = options.log ?? (() => {});
	const env = { ...process.env, PGPASSWORD: String(options.postgres.password ?? '') };
	if (typeof options.postgres.ssl === 'boolean') {
		env.PGSSLMODE = options.postgres.ssl ? 'verify-full' : 'disable';
	}
	if (options.dropSchema) {
		log('Dropping schema log4stellar in ' + options.postgres.database + ' ...');
		await runPsql(options, ['--command', 'DROP SCHEMA IF EXISTS log4stellar CASCADE;'], env);
	}
	log('Applying ' + options.dumpPath + ' to ' + options.postgres.database + ' ...');
	await runPsql(options, ['--file', '/dev/stdin', '--single-transaction', '--set', 'ON_ERROR_STOP=1'], env, options.dumpPath);
	log('PostgreSQL restore finished.');
}

async function runPsql(options, args, env, stdinFile) {
	const target = [
		'--host', String(options.postgres.host),
		'--port', String(options.postgres.port),
		'--username', String(options.postgres.user),
		'--dbname', String(options.postgres.database),
	];
	try {
		await execute('psql', [...target, ...args], env, stdinFile);
		return;
	} catch (error) {
		if (error.code !== 'ENOENT') throw error;
	}
	// This host has no PostgreSQL client, and the container binary cannot run on the
	// host; run psql inside the image and reach the database over the host network.
	const image = options.psqlImage ?? process.env.LOG4STELLAR_PSQL_IMAGE ?? 'postgres:18';
	const containerArgs = [];
	for (const argument of [...target, ...args]) {
		containerArgs.push(argument);
	}
	await execute('docker', [
		'run', '--rm', '--interactive', '--network', 'host', '-e', 'PGPASSWORD', image, 'psql', ...containerArgs,
	], env, stdinFile);
}

async function execute(command, args, env, stdinFile) {
	const child = spawn(command, args, { env, stdio: [stdinFile ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
	const stderr = [];
	child.stderr.on('data', chunk => stderr.push(chunk));
	const exited = new Promise((resolve, reject) => {
		child.once('error', reject);
		child.once('close', status => status === 0
			? resolve(undefined)
			: reject(Object.assign(new Error(
				command + ' exited with ' + status + ': ' + Buffer.concat(stderr).toString('utf8').trim(),
			), { code: 'CommandFailed' })));
	});
	if (stdinFile) {
		const stream = createReadStream(stdinFile);
		await Promise.all([pipeline(stream, child.stdin), exited]);
	} else {
		await exited;
	}
}

/**
 * Restores one backup end to end into a target directory and, optionally, a separate
 * object store. Returns the evidence a drill report needs.
 *
 * This is the entry point the drill script uses, so that the drill exercises the same
 * code path an operator would use during an incident instead of a parallel
 * implementation that only exists in the test.
 * @param {object} options
 * @param {string} options.backupDir
 * @param {unknown} options.keyMaterial
 * @param {string} options.targetDir
 * @param {object} [options.s3]  separate target for the object bytes
 * @param {'rustfs' | 'directory'} [options.objectBackend]
 * @param {(message: string) => void} [options.log]
 * @param {boolean} [options.skipObjects]
 */
export async function restoreBackup(options) {
	const startedAt = Date.now();
	const log = options.log ?? (() => {});
	log('Verifying ' + options.backupDir + ' ...');
	const verified = await verifyBackupManifest(options.backupDir, {
		keyMaterial: options.keyMaterial,
		keepPlaintext: true,
	});
	log('Verification passed: ' + verified.members.length + ' members, ' + verified.objects.count + ' objects.');

	let objectResult = { restored: 0, bytes: 0, verified: verified.objects.count };
	try {
		const restored = await restoreToDirectory(verified, options.targetDir);
		log('Restored account database, secrets and metadata dump into ' + path.resolve(options.targetDir) + '.');
		if (options.s3 && !options.skipObjects) {
			log('Restoring ' + verified.objects.count + ' objects into ' + options.s3.endpoint + '/' + options.s3.bucket + ' ...');
			objectResult = await restoreObjectBytes(verified, {
				s3: options.s3,
				backend: options.objectBackend,
			});
			log('Restored and read back ' + objectResult.restored + ' objects.');
		}
		return {
			backupDir: path.resolve(options.backupDir),
			targetDir: path.resolve(options.targetDir),
			scope: verified.scope,
			members: verified.members.length,
			objects: objectResult,
			restored,
			durationMs: Date.now() - startedAt,
			duration: formatDuration(Date.now() - startedAt),
			snapshot: verified.manifest.snapshot ?? null,
			backupCompletedAt: verified.manifest.completedAt ?? null,
		};
	} finally {
		// The decrypted members live in a temp directory the verifier created; deleting
		// it here is what keeps a drill from leaving a plaintext copy of the account
		// database on the host after the report is written.
		if (verified.plaintext) {
			const scratch = new Set(verified.plaintext.values());
			for (const file of scratch) {
				const directory = path.dirname(file);
				if (directory.startsWith(tmpdir())) {
					await rm(directory, { recursive: true, force: true });
				}
			}
		}
	}
}

/**
 * Parses the command line.
 * @param {string[]} argv
 */
export function parseArguments(argv) {
	const parsed = {
		backupDir: null,
		targetDir: null,
		keyFile: process.env.LOG4STELLAR_BACKUP_KEY_FILE ?? null,
		objectsConfig: null,
		trigger: 'manual',
		json: false,
		keepPlaintext: false,
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
			case 'key-file': parsed.keyFile = takeValue(); break;
			case 'objects-config': parsed.objectsConfig = takeValue(); break;
			case 'trigger': parsed.trigger = takeValue(); break;
			case 'json': parsed.json = true; break;
			case 'help': parsed.help = true; break;
			default: throw new Error('Unknown flag: --' + name);
		}
	}
	if (positional.length === 2) {
		[parsed.backupDir, parsed.targetDir] = positional;
	} else if (positional.length === 1) {
		parsed.backupDir = positional[0];
	} else if (positional.length > 2) {
		throw new Error('Usage: node apps/web/restore-backup.mjs <backup dir> <target dir> [--objects-config=<file>] [--key-file=<path>]');
	}
	return parsed;
}

const usage = [
	'Usage: node apps/web/restore-backup.mjs <backup dir> <target dir> [flags]',
	'',
	'Restores a backup into <target dir>. The account database, both secrets and the',
	'PostgreSQL dump land there verbatim; the object bytes are restored only when',
	'--objects-config names a storage configuration that is not the backed-up bucket.',
	'',
	'  --key-file=<path>        backup key file (0600)',
	'  --objects-config=<file>  storage configuration for a separate restore target',
	'  --json                   machine-readable summary',
].join('\n');

async function main() {
	const options = parseArguments(process.argv.slice(2));
	if (options.help) {
		process.stdout.write(usage + '\n');
		return;
	}
	if (!options.backupDir || !options.targetDir) {
		process.stderr.write(usage + '\n');
		throw new Error('Both a backup directory and a target directory are required.');
	}
	if (!options.keyFile) {
		throw new Error('A backup key file is required: pass --key-file=<path> or set LOG4STELLAR_BACKUP_KEY_FILE.');
	}
	process.umask(0o077);
	const s3 = options.objectsConfig ? (JSON.parse(await readFile(options.objectsConfig, 'utf8'))).s3 : undefined;
	const result = await restoreBackup({
		backupDir: options.backupDir,
		keyMaterial: { keyFile: options.keyFile },
		targetDir: options.targetDir,
		s3,
		log: message => process.stderr.write(message + '\n'),
	});
	if (options.json) {
		process.stdout.write(JSON.stringify(result, null, 2) + '\n');
	} else {
		process.stdout.write(
			'Restored ' + result.backupDir + '\n'
			+ '  into:     ' + result.targetDir + '\n'
			+ '  scope:    ' + result.scope + '\n'
			+ '  members:  ' + result.members + '\n'
			+ '  objects:  ' + result.objects.restored + ' (' + result.objects.bytes + ' bytes)\n'
			+ '  snapshot: ' + (result.snapshot ?? 'n/a') + '\n'
			+ '  duration: ' + result.duration + '\n',
		);
	}
}

export { usage };

if (import.meta.url === 'file://' + process.argv[1]) {
	await main().catch(error => {
		process.stderr.write('Restore failed: ' + (error?.message ?? error) + '\n');
		if (error?.details?.problems) {
			for (const problem of error.details.problems) {
				process.stderr.write('  - ' + problem.code + ': ' + problem.message + '\n');
			}
		}
		process.exitCode = 1;
	});
}
