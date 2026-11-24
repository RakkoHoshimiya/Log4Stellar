// The backup contract: what a backup must contain, how its integrity is proven, and
// how an operator learns whether the last one is still fresh.
//
// The earlier tooling wrote a `format: 1` manifest listing artifacts with a size and a
// digest. That proved a backup had *run*, but not that it could be *restored*:
//
//   * nothing said which members were mandatory, so a half-written directory could be
//     restored as a silently partial workspace;
//   * nothing said where a byte came from, so "the object export is missing" and "the
//     account database is missing" looked the same to an operator;
//   * nothing recorded whether the last run succeeded or how long ago that was.
//
// This module owns exactly those three answers: the manifest shape, the verification
// walk, and the outcome/freshness bookkeeping. Producing the members is
// `backup-data.mjs`, consuming them is `restore-backup.mjs`, scheduling them is
// `backup-schedule.mjs`.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { backupCipher, backupKdf, openSealer, reopenSealer } from './backup-cipher.mjs';

/** The manifest revision this module reads and writes. Format 1 is refused, not guessed. */
export const manifestFormat = 2;

/** A backup the operator asked to be complete: every member plus every object's bytes. */
export const scopeFull = 'full';

/**
 * A metadata backup: everything a full backup has except the object bytes. A
 * legitimate scope (it is small and can run hourly) but it can never restore file
 * contents, so verification reports it as unusable for a full restore unless the
 * caller explicitly accepts that.
 */
export const scopeLimited = 'limited';

/** Raised when a backup directory cannot be trusted. Never downgraded to a warning. */
export class BackupVerificationError extends Error {
	/**
	 * @param {string} message
	 * @param {{ code?: string, details?: object }} [options]
	 */
	constructor(message, { code = 'BackupVerificationFailed', details = {} } = {}) {
		super(message);
		this.name = 'BackupVerificationError';
		this.code = code;
		this.details = details;
	}
}

/** Raised when a restore target is refused because writing there would touch production. */
export class RestoreTargetError extends Error {
	/**
	 * @param {string} message
	 * @param {{ code?: string, target: string }} options
	 */
	constructor(message, { code = 'RestoreTargetRefused', target }) {
		super(message);
		this.name = 'RestoreTargetError';
		this.code = code;
		this.target = target;
	}
}

/**
 * The member contract, in write order.
 *
 * `auth.sqlite` and `secret` are the account system: without them every workspace is
 * ownerless and every existing session cookie is invalid. `git-secret` seals the
 * stored Git credentials, so losing it keeps the data but loses every remote. The
 * PostgreSQL dump is the metadata half of the storage layer. The deployment members
 * are what a restore onto a bare host needs in order to start the service at all.
 *
 * `required` is a promise about *restore ability*, not about importance: an optional
 * member that is absent is noted, a required one that is absent fails verification.
 */
export const memberContract = [
	{
		name: 'auth.sqlite',
		file: 'auth.sqlite.enc',
		kind: 'sqlite-accounts',
		required: true,
		source: { type: 'file', path: '<authDir>/auth.sqlite', description: 'better-auth SQLite account database' },
		description: 'accounts, sessions, workspace_member and workspace_meta; snapshotted with VACUUM INTO so the WAL is included',
	},
	{
		name: 'secret',
		file: 'secret.enc',
		kind: 'auth-secret',
		required: true,
		source: { type: 'file', path: '<authDir>/secret', description: 'better-auth signing secret' },
		description: 'signs session cookies and seals account security secrets; losing it invalidates every session',
	},
	{
		name: 'git-secret',
		file: 'git-secret.enc',
		kind: 'git-secret',
		required: true,
		source: { type: 'file', path: '<configDir>/git-secret', description: 'Git credential sealing key' },
		description: 'seals every configured Git remote credential',
	},
	{
		name: 'log4stellar.sql',
		file: 'log4stellar.sql.enc',
		kind: 'postgres-dump',
		required: true,
		source: {
			type: 'postgres',
			schema: 'log4stellar',
			tables: [
				'storage_workspaces', 'storage_entries', 'storage_file_versions', 'storage_trash',
				'storage_trash_entries', 'storage_snapshots', 'storage_snapshot_entries',
				'storage_change_heads', 'storage_changes', 'git_repositories', 'git_credentials',
				'git_checkpoints',
			],
			description: 'pg_dump --schema log4stellar --format plain',
		},
		description: 'the storage metadata: entries, versions, trash, incremental-sync and Git tables',
	},
	{
		name: 'objects.index',
		file: 'objects.index.enc',
		kind: 'object-inventory',
		required: true,
		source: {
			type: 'postgres',
			schema: 'log4stellar',
			table: 'storage_file_versions',
			columns: ['workspace_id', 'sha256', 'size_bytes'],
			description: 'distinct (workspace_id, sha256, size_bytes) of every object the snapshot references',
		},
		description: 'the object inventory as a restore reads it; the manifest also carries it inline so a truncated index is detected',
	},
];

/** A full backup additionally requires the object bytes. A limited one does not. */
const objectMemberKinds = new Set(['object-inventory']);

/**
 * Plans what a backup is going to contain, without reading anything.
 *
 * Deliberately pure and cheap: `backup-data.mjs` calls it *before* opening a database
 * or a bucket, so an impossible request (a full backup with the object export turned
 * off, an unknown scope) fails before any byte is written, and tests can assert the
 * contract without a server.
 *
 * @param {object} [options]
 * @param {'full' | 'limited'} [options.scope]
 * @param {boolean} [options.exportObjects]  defaults to true for a full backup
 * @param {string} [options.authDir]
 * @param {string} [options.configDir]
 * @param {string[]} [options.deploymentFiles]  extra deployment files to include verbatim
 * @param {{ s3?: object, postgres?: object }} [options.settings]
 */
export function planBackupScope(options = {}) {
	const scope = options.scope ?? scopeFull;
	if (scope !== scopeFull && scope !== scopeLimited) {
		throw new Error('A backup scope must be "' + scopeFull + '" or "' + scopeLimited + '".');
	}
	const exportObjects = options.exportObjects ?? scope === scopeFull;
	if (scope === scopeFull && !exportObjects) {
		// A full backup without the object bytes is not a full backup. Failing here is
		// what stops a scheduled job from quietly degrading into metadata-only runs.
		throw new Error('A full backup must export the referenced objects; use the "' + scopeLimited + '" scope for metadata only.');
	}
	if (scope === scopeLimited && exportObjects) {
		throw new Error('The "' + scopeLimited + '" scope does not export objects; use the "' + scopeFull + '" scope.');
	}

	const members = memberContract.map(member => ({
		...member,
		source: materializeSource(member.source, options),
	}));

	const deployment = [];
	for (const name of options.deploymentFiles ?? []) {
		if (typeof name !== 'string' || name.length === 0 || name.includes('..') || name.startsWith('/')) {
			throw new Error('A deployment file must be a plain file name inside the config directory: ' + JSON.stringify(name));
		}
		deployment.push({
			name: 'deployment/' + name,
			file: 'deployment/' + name + '.enc',
			kind: 'deployment-config',
			required: false,
			source: { type: 'file', path: join(options.configDir ?? '.', name), description: 'deployment configuration' },
			description: 'deployment file copied verbatim: ' + name,
		});
	}

	return {
		scope,
		exportObjects,
		members: [...members, ...deployment],
		requiredMembers: memberContract.filter(member => member.required).map(member => member.name),
		objects: {
			required: scope === scopeFull,
			source: {
				type: 'postgres',
				schema: 'log4stellar',
				table: 'storage_file_versions',
				columns: ['workspace_id', 'sha256', 'size_bytes'],
				description: 'every distinct immutable object the snapshot references',
			},
			// Recorded so an operator can see *why* an object is in the backup: an object
			// can be referenced by a live entry, by the trash, or only by version history.
			referencedBy: [
				{ table: 'log4stellar.storage_entries', column: 'revision_id', via: 'storage_file_versions' },
				{ table: 'log4stellar.storage_trash_entries', column: 'revision_id', via: 'storage_file_versions' },
				{ table: 'log4stellar.storage_file_versions', column: 'revision_id', via: 'storage_file_versions' },
			],
			remote: {
				endpoint: options.settings?.s3?.endpoint ?? null,
				bucket: options.settings?.s3?.bucket ?? null,
				keyLayout: 'workspaces/<workspaceId>/sha256/<sha256>',
			},
		},
		warnings: scope === scopeLimited
			? ['Limited scope: the object bytes are not exported, so this backup cannot restore file contents.']
			: [],
	};
}

function materializeSource(source, options) {
	if (source.path?.startsWith('<authDir>/')) {
		return { ...source, path: join(options.authDir ?? '.', source.path.slice('<authDir>/'.length)) };
	}
	if (source.path?.startsWith('<configDir>/')) {
		return { ...source, path: join(options.configDir ?? '.', source.path.slice('<configDir>/'.length)) };
	}
	return { ...source };
}

/** The member names that must exist for a scope, recomputed from the contract. */
export function requiredMembersFor(scope) {
	if (scope !== scopeFull && scope !== scopeLimited) {
		throw new Error('Unknown backup scope: ' + JSON.stringify(scope));
	}
	return memberContract.filter(member => member.required).map(member => member.name);
}

/** The object directory member kinds, for callers that need to tell objects from metadata. */
export function isObjectMember(kind) {
	return objectMemberKinds.has(kind);
}

async function digestFile(path) {
	const hash = createHash('sha256');
	await pipeline(createReadStream(path), hash);
	return hash.digest('hex');
}

/** The sha256 of a buffer, for callers that already hold the bytes. */
export function digestBytes(bytes) {
	return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Seals one plaintext file into the backup directory and records it in the manifest.
 *
 * Write order is what makes the manifest trustworthy: the ciphertext is written and
 * digested first, and only then is its entry appended. A run killed mid-member leaves
 * no entry, so the next verification reports a member the manifest promised but never
 * produced rather than accepting a truncated file.
 *
 * Two digests are recorded because they answer different questions. `sha256` is the
 * digest of the bytes on disk, so verification can prove "this is the file this run
 * wrote" without the key. `contentSha256` is the digest of the plaintext, so a restore
 * can prove "these are the bytes the member is supposed to yield" after decrypting.
 *
 * @param {string} backupDir
 * @param {object} manifest
 * @param {{ name: string, file: string, kind: string, required: boolean, source: object, description?: string }} member
 * @param {{ sealer: object, plaintextPath: string }} input
 */
export async function sealMember(backupDir, manifest, member, input) {
	const destination = join(backupDir, member.file);
	await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
	const contentSha256 = await digestFile(input.plaintextPath);
	const contentSize = (await stat(input.plaintextPath)).size;
	const { size } = await input.sealer.encryptFile(input.plaintextPath, destination);
	const entry = {
		name: member.name,
		file: member.file,
		kind: member.kind,
		required: member.required,
		description: member.description ?? '',
		source: member.source,
		size,
		sha256: await digestFile(destination),
		contentSize,
		contentSha256,
	};
	manifest.members.push(entry);
	return entry;
}

/** Seals an in-memory buffer as a member (used for the object inventory). */
export async function sealMemberFromBytes(backupDir, manifest, member, input) {
	const destination = join(backupDir, member.file);
	await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
	const bytes = Buffer.from(input.bytes);
	const envelope = input.sealer.encryptBytes(bytes);
	await writeFile(destination, envelope, { flag: 'wx', mode: 0o600 });
	const entry = {
		name: member.name,
		file: member.file,
		kind: member.kind,
		required: member.required,
		description: member.description ?? '',
		source: member.source,
		size: envelope.length,
		sha256: digestBytes(envelope),
		contentSize: bytes.length,
		contentSha256: digestBytes(bytes),
	};
	manifest.members.push(entry);
	return entry;
}

/**
 * Writes the manifest atomically, so an interrupted run never leaves a manifest that
 * describes members that were not finished.
 * @param {string} backupDir
 * @param {object} manifest
 */
export async function writeManifest(backupDir, manifest) {
	const target = join(backupDir, 'manifest.json');
	await writeFile(target + '.tmp', JSON.stringify(manifest, null, '\t') + '\n', { flag: 'w', mode: 0o600 });
	await rename(target + '.tmp', target);
}

/**
 * Reads and shape-checks a manifest. Does not trust anything in it yet.
 * @param {string} backupDir
 */
export async function readManifest(backupDir) {
	const target = join(backupDir, 'manifest.json');
	let text;
	try {
		text = await readFile(target, 'utf8');
	} catch (error) {
		if (error.code === 'ENOENT') {
			throw new BackupVerificationError('The backup has no manifest.json: ' + backupDir, {
				code: 'ManifestMissing',
				details: { backupDir },
			});
		}
		throw error;
	}
	let manifest;
	try {
		manifest = JSON.parse(text);
	} catch {
		throw new BackupVerificationError('The backup manifest is not valid JSON: ' + backupDir, {
			code: 'ManifestCorrupt',
			details: { backupDir },
		});
	}
	if (manifest?.format !== manifestFormat) {
		throw new BackupVerificationError(
			'Unsupported backup manifest format ' + JSON.stringify(manifest?.format)
			+ ' (this build reads format ' + manifestFormat + '); restore a pre-v2 backup with the release that wrote it.',
			{ code: 'ManifestUnsupported', details: { format: manifest?.format } },
		);
	}
	if (!manifest.encryption || manifest.encryption.cipher !== backupCipher || manifest.encryption.kdf !== backupKdf) {
		throw new BackupVerificationError(
			'The backup manifest does not describe a supported encryption scheme.',
			{ code: 'EncryptionUnsupported', details: { encryption: manifest.encryption } },
		);
	}
	return manifest;
}

/** Opens the sealer a manifest was written with. */
export async function sealerFor(manifest, keyMaterial) {
	return reopenSealer(keyMaterial, manifest.encryption);
}

/**
 * Verifies a backup directory before anything is restored from it.
 *
 * Every failure mode an operator can hit is distinguished, because the recovery
 * differs: a missing index is re-run the backup, a digest mismatch is re-copy from a
 * replica, an unsupported format is use-the-old-release, and an undecryptable member
 * is a lost key. Verification collects *all* problems before throwing, so one run
 * tells the operator everything that is wrong instead of one item per retry.
 *
 * Refuses to proceed when a required member is missing even if every other member is
 * perfect: a restore from a backup without the account database would produce an
 * ownerless workspace, which is worse than a failed restore.
 *
 * @param {string} backupDir
 * @param {object} [options]
 * @param {unknown} [options.keyMaterial]  decrypts each member and re-checks contentSha256
 * @param {boolean} [options.allowMetadataOnly]  accept a limited-scope backup
 * @param {'full' | 'limited'} [options.expectScope]
 * @param {boolean} [options.skipObjectBytes]  metadata-only inspection of a full backup
 * @param {string} [options.scratchDir]  where decrypted members are staged (default: a new temp dir)
 * @param {boolean} [options.keepPlaintext]  leave the decrypted members for the caller to consume
 * @param {boolean} [options.verifyPlaintext]  decrypt even when the caller did not ask for the plaintext
 */
export async function verifyBackupManifest(backupDir, options = {}) {
	const directory = resolve(backupDir);
	const manifest = await readManifest(directory);
	const problems = [];

	const expectScope = options.expectScope;
	if (expectScope && expectScope !== manifest.scope) {
		problems.push({
			code: 'ScopeMismatch',
			message: 'The backup scope is ' + JSON.stringify(manifest.scope) + ', not ' + JSON.stringify(expectScope),
		});
	}
	if (manifest.scope !== scopeFull && manifest.scope !== scopeLimited) {
		problems.push({ code: 'ScopeInvalid', message: 'The manifest declares an unknown scope: ' + JSON.stringify(manifest.scope) });
	} else if (manifest.scope === scopeLimited && !options.allowMetadataOnly) {
		problems.push({
			code: 'MetadataOnly',
			message: 'This is a limited (metadata-only) backup: its object bytes were never exported, so restoring it would '
				+ 'produce a workspace whose files are all missing.',
		});
	}
	if (!Array.isArray(manifest.members)) {
		throw new BackupVerificationError('The backup manifest has no member list.', {
			code: 'ManifestEmpty',
			details: { backupDir: directory },
		});
	}

	// The required set is recomputed from the contract, never read out of the manifest:
	// a manifest edited to delete a member must not also be able to delete the
	// requirement for it.
	const required = requiredMembersFor(manifest.scope);
	const present = new Set(manifest.members.map(member => member?.name));
	for (const name of required) {
		if (!present.has(name)) {
			problems.push({ code: 'MemberMissing', message: 'The backup does not contain the required member "' + name + '".' });
		}
	}

	const seenNames = new Set();
	const seenFiles = new Set();
	const verified = [];
	for (const member of manifest.members) {
		if (typeof member?.name !== 'string' || typeof member?.file !== 'string') {
			problems.push({ code: 'MemberInvalid', message: 'The manifest contains a member without a name or a file: ' + JSON.stringify(member) });
			continue;
		}
		if (isUnsafeRelativePath(member.file) || isUnsafeRelativePath(member.name)) {
			problems.push({ code: 'MemberInvalid', message: 'The member "' + member.name + '" has an unsafe path: ' + JSON.stringify(member.file) });
			continue;
		}
		if (seenNames.has(member.name)) {
			problems.push({ code: 'MemberDuplicate', message: 'The manifest lists the member "' + member.name + '" more than once.' });
			continue;
		}
		if (seenFiles.has(member.file)) {
			problems.push({ code: 'MemberDuplicate', message: 'The manifest lists the file "' + member.file + '" more than once.' });
			continue;
		}
		seenNames.add(member.name);
		seenFiles.add(member.file);
		if (!member.source || typeof member.source !== 'object' || typeof member.source.type !== 'string') {
			problems.push({ code: 'SourceMissing', message: 'The member "' + member.name + '" does not record where it came from.' });
			continue;
		}
		if (typeof member.contentSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(member.contentSha256)) {
			problems.push({ code: 'MemberInvalid', message: 'The member "' + member.name + '" has no valid plaintext digest.' });
			continue;
		}
		const file = join(directory, member.file);
		let info;
		try {
			info = await stat(file);
		} catch (error) {
			if (error.code === 'ENOENT') {
				// An optional member that was never written is normal; a required one was
				// already reported above, so only flag the file when the entry claims it.
				problems.push({
					code: member.required ? 'MemberMissing' : 'MemberMissingOptional',
					message: 'The manifest lists the member "' + member.name + '" but ' + member.file + ' is not on disk.',
				});
				continue;
			}
			throw error;
		}
		if (!info.isFile()) {
			problems.push({ code: 'MemberInvalid', message: 'The member "' + member.name + '" is not a regular file.' });
			continue;
		}
		if (info.size !== member.size) {
			problems.push({
				code: 'SizeMismatch',
				message: 'The member "' + member.name + '" is ' + info.size + ' bytes, the manifest says ' + member.size + '.',
			});
			continue;
		}
		const digest = await digestFile(file);
		if (digest !== member.sha256) {
			problems.push({
				code: 'DigestMismatch',
				message: 'The member "' + member.name + '" has digest ' + digest + ', the manifest says ' + member.sha256 + '.',
			});
			continue;
		}
		verified.push(member);
	}

	// The object list is inline in the manifest *and* sealed as objects.index, because
	// two representations of the same fact let verification prove they agree: a
	// manifest edited to drop objects is caught by the index digest, and an index
	// truncated on disk is caught by the manifest's inline copy.
	const objects = await verifyObjectEntries(directory, manifest, options, problems);

	let sealer = null;
	let decrypted = null;
	let scratchDir = null;
	const wantsPlaintext = options.keyMaterial !== undefined || options.verifyPlaintext === true;
	if (wantsPlaintext && problems.length === 0) {
		sealer = await sealerFor(manifest, options.keyMaterial);
		decrypted = new Map();
		// Decrypted members are staged *outside* the backup directory: plaintext must
		// never land next to the ciphertext it was sealed to protect, not even in a
		// subdirectory, because that subdirectory is what gets copied to the offsite
		// medium first.
		scratchDir = options.scratchDir ?? await mkdtempDirectory(join(tmpdir(), 'log4stellar-verify-'));
		await mkdir(scratchDir, { recursive: true, mode: 0o700 });
		for (const member of verified) {
			const out = join(scratchDir, member.file);
			await mkdir(dirname(out), { recursive: true, mode: 0o700 });
			try {
				await sealer.decryptFile(join(directory, member.file), out);
				const digest = await digestFile(out);
				if (digest !== member.contentSha256) {
					problems.push({
						code: 'ContentDigestMismatch',
						message: 'The decrypted member "' + member.name + '" has digest ' + digest
							+ ', the manifest says ' + member.contentSha256 + '.',
					});
					continue;
				}
				decrypted.set(member.name, out);
			} catch (error) {
				problems.push({
					code: 'DecryptionFailed',
					message: 'The member "' + member.name + '" cannot be decrypted: ' + error.message,
				});
			}
		}
		if (problems.length === 0 && decrypted.has('objects.index')) {
			await crossCheckObjectIndex(decrypted.get('objects.index'), manifest, problems);
		}
		// Keep the plaintext only for a caller that will consume it immediately and has
		// taken responsibility for removing it; otherwise sweep it now. A decrypted
		// account database left behind is the exact leak this tool exists to avoid.
		if (problems.length > 0 || !options.keepPlaintext) {
			await removeDirectory(scratchDir);
			scratchDir = null;
			decrypted = null;
		}
	}

	if (problems.length > 0) {
		throw new BackupVerificationError(
			'The backup at ' + directory + ' failed verification:\n'
			+ problems.map(problem => '  - ' + problem.code + ': ' + problem.message).join('\n'),
			{ code: problems[0].code, details: { backupDir: directory, problems } },
		);
	}

	return {
		backupDir: directory,
		manifest,
		members: manifest.members,
		objects,
		scope: manifest.scope,
		sealer,
		plaintext: decrypted,
	};
}

function isUnsafeRelativePath(value) {
	if (typeof value !== 'string' || value.length === 0) {
		return true;
	}
	if (value.startsWith('/') || value.includes('\\')) {
		return true;
	}
	const segments = value.split('/');
	return segments.some(segment => segment === '' || segment === '.' || segment === '..');
}

async function verifyObjectEntries(directory, manifest, options, problems) {
	const exportInfo = manifest.objects;
	if (!exportInfo) {
		if (manifest.scope === scopeFull) {
			problems.push({ code: 'ObjectsMissing', message: 'A full backup must record the object export.' });
		}
		return { count: 0, bytes: 0, entries: [] };
	}
	if (!Array.isArray(exportInfo.entries)) {
		problems.push({ code: 'ObjectsInvalid', message: 'The manifest object export has no entry list.' });
		return { count: 0, bytes: 0, entries: [] };
	}
	if (exportInfo.entries.length !== exportInfo.count) {
		problems.push({
			code: 'ObjectCountMismatch',
			message: 'The manifest declares ' + exportInfo.count + ' exported objects but lists ' + exportInfo.entries.length + '.',
		});
	}
	if (typeof exportInfo.bytes !== 'number' || !Number.isSafeInteger(exportInfo.bytes)) {
		problems.push({ code: 'ObjectsInvalid', message: 'The manifest object export has no valid byte total.' });
	}
	const directoryName = exportInfo.directory ?? 'objects';
	if (isUnsafeRelativePath(directoryName)) {
		problems.push({ code: 'ObjectsInvalid', message: 'The manifest object directory is not a safe relative path: ' + JSON.stringify(directoryName) });
		return { count: 0, bytes: 0, entries: [] };
	}
	let bytes = 0;
	const seen = new Set();
	const entries = [];
	for (const entry of exportInfo.entries) {
		const key = String(entry?.workspaceId) + '/' + String(entry?.sha256);
		if (typeof entry?.workspaceId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(entry.workspaceId)
			|| typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(entry.sha256)
			|| !Number.isSafeInteger(entry.size) || entry.size < 0) {
			problems.push({ code: 'ObjectReferenceInvalid', message: 'The object export contains an invalid reference: ' + JSON.stringify(entry) });
			continue;
		}
		if (!entry.source || typeof entry.source.table !== 'string') {
			problems.push({ code: 'ObjectSourceMissing', message: 'The object ' + key + ' does not record the table it came from.' });
		}
		if (seen.has(key)) {
			problems.push({ code: 'ObjectDuplicate', message: 'The object export lists ' + key + ' more than once.' });
			continue;
		}
		seen.add(key);
		if (options.skipObjectBytes) {
			entries.push(entry);
			bytes += entry.size;
			continue;
		}
		const file = join(directory, directoryName, entry.workspaceId, entry.sha256 + '.enc');
		try {
			const info = await stat(file);
			if (info.size !== entry.storedSize) {
				problems.push({
					code: 'ObjectSizeMismatch',
					message: 'The stored object ' + key + ' is ' + info.size + ' bytes, the export says ' + entry.storedSize + '.',
				});
				continue;
			}
			const digest = await digestFile(file);
			if (digest !== entry.storedSha256) {
				problems.push({
					code: 'ObjectDigestMismatch',
					message: 'The stored object ' + key + ' has digest ' + digest + ', the export says ' + entry.storedSha256 + '.',
				});
				continue;
			}
			entries.push(entry);
			bytes += entry.size;
		} catch (error) {
			if (error.code === 'ENOENT') {
				problems.push({ code: 'ObjectMissing', message: 'The object ' + key + ' is missing from the export.' });
				continue;
			}
			throw error;
		}
	}
	if (bytes !== exportInfo.bytes && problems.length === 0) {
		problems.push({
			code: 'ObjectBytesMismatch',
			message: 'The exported objects total ' + bytes + ' bytes, the manifest says ' + exportInfo.bytes + '.',
		});
	}
	return { count: exportInfo.count, bytes, entries, directory: directoryName };
}

async function crossCheckObjectIndex(plaintextPath, manifest, problems) {
	let index;
	try {
		index = JSON.parse(await readFile(plaintextPath, 'utf8'));
	} catch {
		problems.push({ code: 'ObjectIndexCorrupt', message: 'objects.index is not valid JSON.' });
		return;
	}
	const listed = Array.isArray(index?.entries) ? index.entries : null;
	if (!listed) {
		problems.push({ code: 'ObjectIndexCorrupt', message: 'objects.index has no entry list.' });
		return;
	}
	const inline = new Map((manifest.objects?.entries ?? []).map(entry => [entry.workspaceId + '/' + entry.sha256, entry]));
	if (listed.length !== inline.size) {
		problems.push({
			code: 'ObjectIndexMismatch',
			message: 'objects.index lists ' + listed.length + ' objects, the manifest lists ' + inline.size + '.',
		});
		return;
	}
	for (const entry of listed) {
		const key = entry.workspaceId + '/' + entry.sha256;
		const expected = inline.get(key);
		if (!expected) {
			problems.push({ code: 'ObjectIndexMismatch', message: 'objects.index lists ' + key + ', which the manifest does not.' });
			continue;
		}
		if (expected.size !== entry.size || expected.storedSha256 !== entry.storedSha256 || expected.storedSize !== entry.storedSize) {
			problems.push({ code: 'ObjectIndexMismatch', message: 'objects.index and the manifest disagree about ' + key + '.' });
		}
	}
}

async function mkdtempDirectory(prefix) {
	const { mkdtemp } = await import('node:fs/promises');
	return await mkdtemp(prefix);
}

async function removeDirectory(path) {
	await rm(path, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Outcome bookkeeping and freshness
// ---------------------------------------------------------------------------

/** `state.json` in the state directory: the last success, the last failure, counters. */
export const stateFileName = 'state.json';
/** Append-only run history, one JSON object per line. */
export const outcomesFileName = 'outcomes.jsonl';
/** The latest unresolved failure, read by the alerting hook. */
export const alertFileName = 'alert.json';

/**
 * Records how a backup run ended and updates the freshness state.
 *
 * Two artifacts on purpose. `outcomes.jsonl` is the append-only history an operator
 * greps after an incident, and it is written *before* the state, so a crash between
 * the two loses the summary but never the fact. `state.json` is rewritten atomically
 * and is the only thing the freshness check reads, so a torn write can never make a
 * failed run look like the last success.
 *
 * A failure never clears the previous success. "The last backup worked 3 h ago and
 * the run five minutes ago failed" is exactly the fact an operator needs; overwriting
 * `lastSuccess` would erase it.
 *
 * @param {string} stateDirectory
 * @param {object} outcome
 * @param {'success' | 'failure'} outcome.status
 * @param {string} [outcome.backupDir]
 * @param {'full' | 'limited'} [outcome.scope]
 * @param {number} [outcome.startedAt]  epoch ms
 * @param {number} [outcome.finishedAt] epoch ms
 * @param {number} [outcome.objects]
 * @param {number} [outcome.bytes]
 * @param {number} [outcome.members]
 * @param {{ message: string, code?: string }} [outcome.error]
 * @param {'manual' | 'schedule' | string} [outcome.trigger]
 * @param {string} [outcome.host]
 */
export async function recordBackupOutcome(stateDirectory, outcome) {
	if (outcome?.status !== 'success' && outcome?.status !== 'failure') {
		throw new Error('A backup outcome must be "success" or "failure".');
	}
	await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
	const finishedAt = outcome.finishedAt ?? Date.now();
	const startedAt = outcome.startedAt ?? finishedAt;
	/** @type {Record<string, unknown>} */
	const record = {
		schema: 1,
		status: outcome.status,
		trigger: outcome.trigger ?? 'manual',
		scope: outcome.scope ?? null,
		backupDir: outcome.backupDir ?? null,
		startedAt: new Date(startedAt).toISOString(),
		finishedAt: new Date(finishedAt).toISOString(),
		durationMs: Math.max(0, finishedAt - startedAt),
		members: outcome.members ?? 0,
		objects: outcome.objects ?? 0,
		bytes: outcome.bytes ?? 0,
		host: outcome.host ?? null,
		error: outcome.error ? { message: String(outcome.error.message), code: outcome.error.code ?? null } : null,
	};
	const handle = await open(join(stateDirectory, outcomesFileName), 'a', 0o600);
	try {
		await handle.appendFile(JSON.stringify(record) + '\n');
	} finally {
		await handle.close();
	}

	const previous = await readState(stateDirectory);
	/** @type {Record<string, unknown>} */
	const state = {
		schema: 1,
		runs: Number(previous?.runs ?? 0) + 1,
		failures: Number(previous?.failures ?? 0) + (outcome.status === 'failure' ? 1 : 0),
		consecutiveFailures: outcome.status === 'failure' ? Number(previous?.consecutiveFailures ?? 0) + 1 : 0,
		lastSuccess: previous?.lastSuccess ?? null,
		lastFailure: previous?.lastFailure ?? null,
		lastRun: record,
	};
	if (outcome.status === 'success') {
		state.lastSuccess = record;
	} else {
		state.lastFailure = record;
	}
	await writeJsonAtomic(join(stateDirectory, stateFileName), state);

	let alert = null;
	if (outcome.status === 'failure') {
		alert = {
			raisedAt: new Date(finishedAt).toISOString(),
			consecutiveFailures: state.consecutiveFailures,
			message: record.error?.message ?? 'The backup failed.',
			code: record.error?.code ?? null,
			backupDir: record.backupDir,
			scope: record.scope,
		};
		await writeJsonAtomic(join(stateDirectory, alertFileName), alert);
	}
	return { record, state, alert };
}

async function readState(stateDirectory) {
	try {
		return JSON.parse(await readFile(join(stateDirectory, stateFileName), 'utf8'));
	} catch (error) {
		if (error.code === 'ENOENT') {
			return null;
		}
		if (error instanceof SyntaxError) {
			throw new Error('The backup state file is corrupt and cannot be trusted: ' + join(stateDirectory, stateFileName));
		}
		throw error;
	}
}

async function writeJsonAtomic(path, value) {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	await writeFile(path + '.tmp', JSON.stringify(value, null, '\t') + '\n', { mode: 0o600 });
	await rename(path + '.tmp', path);
}

/** The default freshness ceiling: nightly, so one missed night is already late. */
export const defaultMaxAgeMs = 36 * 60 * 60 * 1000;

/**
 * Answers "how long since the last successful backup, and is that too long?".
 *
 * Three states, because they need three different reactions:
 *   * `ok`    -- a successful run inside the window;
 *   * `stale` -- the last success is older than the window, so the scheduler stopped;
 *   * `never` -- no successful run has ever been recorded, so it never ran.
 *
 * A run that is failing right now shows up in `consecutiveFailures` and never changes
 * the age of the last success.
 *
 * @param {string} stateDirectory
 * @param {{ now?: number, maxAgeMs?: number, clock?: () => number }} [options]
 */
export async function checkBackupFreshness(stateDirectory, options = {}) {
	const now = options.now ?? (options.clock ? options.clock() : Date.now());
	const maxAgeMs = options.maxAgeMs ?? defaultMaxAgeMs;
	if (typeof maxAgeMs !== 'number' || !Number.isFinite(maxAgeMs) || maxAgeMs <= 0) {
		throw new Error('The backup freshness window must be a positive number of milliseconds.');
	}
	const state = await readState(stateDirectory);
	const lastSuccess = state?.lastSuccess ?? null;
	if (!lastSuccess) {
		return {
			state: 'never',
			fresh: false,
			overdue: true,
			lastSuccessAt: null,
			lastSuccessBackupDir: null,
			ageMs: null,
			ageText: null,
			maxAgeMs,
			maxAgeText: formatDuration(maxAgeMs),
			consecutiveFailures: Number(state?.consecutiveFailures ?? 0),
			lastFailure: state?.lastFailure ?? null,
			reason: 'No successful backup has ever been recorded in ' + resolve(stateDirectory) + '.',
		};
	}
	const successAt = Date.parse(lastSuccess.finishedAt);
	if (!Number.isFinite(successAt)) {
		throw new Error('The recorded last success has an unreadable timestamp: ' + JSON.stringify(lastSuccess.finishedAt));
	}
	const ageMs = Math.max(0, now - successAt);
	const overdue = ageMs > maxAgeMs;
	return {
		state: overdue ? 'stale' : 'ok',
		fresh: !overdue,
		overdue,
		lastSuccessAt: lastSuccess.finishedAt,
		lastSuccessBackupDir: lastSuccess.backupDir ?? null,
		ageMs,
		ageText: formatDuration(ageMs),
		maxAgeMs,
		maxAgeText: formatDuration(maxAgeMs),
		consecutiveFailures: Number(state?.consecutiveFailures ?? 0),
		lastFailure: state?.lastFailure ?? null,
		reason: overdue
			? 'The last successful backup finished ' + formatDuration(ageMs) + ' ago, past the ' + formatDuration(maxAgeMs) + ' window.'
			: 'The last successful backup finished ' + formatDuration(ageMs) + ' ago.',
	};
}

/** Formats a duration the way an operator reads it in a shell: `45s`, `2h13m`, `4d2h`. */
export function formatDuration(ms) {
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) {
		return seconds + 's';
	}
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) {
		return seconds % 60 ? minutes + 'm' + (seconds % 60) + 's' : minutes + 'm';
	}
	const hours = Math.floor(minutes / 60);
	if (hours < 48) {
		return minutes % 60 ? hours + 'h' + (minutes % 60) + 'm' : hours + 'h';
	}
	const days = Math.floor(hours / 24);
	return hours % 24 ? days + 'd' + (hours % 24) + 'h' : days + 'd';
}

/**
 * Deletes backups past the retention window.
 *
 * Only directories this tool named are candidates (a `backup-*` directory carrying a
 * readable manifest), and the newest remaining one is never removed: a retention of
 * one, or a window that has expired everything, must not leave the host with no
 * restore point at all.
 *
 * @param {string} root  the directory holding `backup-*` subdirectories
 * @param {{ keep?: number, maxAgeMs?: number, now?: number, dryRun?: boolean }} [options]
 */
export async function pruneBackups(root, options = {}) {
	const keep = options.keep ?? 7;
	const maxAgeMs = options.maxAgeMs ?? 30 * 24 * 60 * 60 * 1000;
	const now = options.now ?? Date.now();
	let entries;
	try {
		entries = await readdir(root, { withFileTypes: true });
	} catch (error) {
		if (error.code === 'ENOENT') {
			return { kept: [], removed: [], skipped: [] };
		}
		throw error;
	}
	const candidates = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || !entry.name.startsWith('backup-')) {
			continue;
		}
		const directory = join(root, entry.name);
		let createdAt = null;
		try {
			const manifest = await readManifest(directory);
			createdAt = Date.parse(manifest.completedAt ?? manifest.createdAt);
		} catch {
			// A directory without a usable manifest is not provably ours; leave it alone.
		}
		candidates.push({ directory, name: entry.name, createdAt: Number.isFinite(createdAt) ? createdAt : null });
	}
	candidates.sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0));
	const kept = [];
	const removed = [];
	const skipped = [];
	for (let index = 0; index < candidates.length; index++) {
		const candidate = candidates[index];
		if (candidate.createdAt === null) {
			skipped.push({ name: candidate.name, reason: 'no readable manifest' });
			continue;
		}
		const tooOld = now - candidate.createdAt > maxAgeMs;
		const beyondKeep = index >= keep;
		if (!tooOld && !beyondKeep) {
			kept.push(candidate.name);
			continue;
		}
		if (kept.length === 0) {
			kept.push(candidate.name);
			skipped.push({ name: candidate.name, reason: 'newest remaining backup' });
			continue;
		}
		if (!options.dryRun) {
			await rm(candidate.directory, { recursive: true, force: true });
		}
		removed.push(candidate.name);
	}
	return { kept, removed, skipped };
}

/** Removes a partially written backup directory (a failed run leaves no debris). */
export async function discardBackup(directory) {
	await rm(directory, { recursive: true, force: true });
}
