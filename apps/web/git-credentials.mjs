// Credential sealing for the Git integration (docs/git-integration.md §5.1).
//
// AES-256-GCM, one key, stored in a file next to the storage configuration:
//
//   $LOG4STELLAR_STORAGE_CONFIG  ->  /etc/log4stellar/workspace-storage.json
//   key file                     ->  /etc/log4stellar/git-secret   (0600, 64 hex chars)
//
// The key lives beside the database credentials rather than in an environment variable
// because the server is started by a supervisor that inherits a shared environment: an env
// var is readable by every process of the same user, a 0600 file is not. It is created by an
// operator (`node apps/web/git-credentials.mjs secret --create`) and never silently on first
// use — a server that invents a key on its own will invent a different one after a restore,
// and the difference only shows up as every credential failing to decrypt.
//
// THIS FILE IS THE ENCRYPTION ROOT: every stored repository credential is sealed with it,
// and any future TOTP seed is meant to reuse it. It must not be rotated (there is no dual key
// support in this version) and it must not be lost — losing it permanently loses every stored
// credential, because the sealed blobs in the database are useless without it.

import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, open, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { gitError, gitSecretLimit } from './git-contract.mjs';

export const secretFileName = 'git-secret';
export const sealedPrefix = 'v1:';
const algorithm = 'aes-256-gcm';
const ivBytes = 12;
const tagBytes = 16;
const keyBytes = 32;

/** Where the key file lives: the directory that also holds the storage configuration. */
export function secretPathFor(configPath) {
	if (typeof configPath !== 'string' || configPath === '') {
		throw gitError('GitNotConfigured');
	}
	return join(dirname(resolve(configPath)), secretFileName);
}

function decodeKey(hex) {
	if (typeof hex !== 'string') {
		throw gitError('GitNotConfigured');
	}
	const trimmed = hex.trim();
	if (!/^[0-9a-fA-F]{64}$/.test(trimmed)) {
		throw gitError('GitNotConfigured');
	}
	return Buffer.from(trimmed, 'hex');
}

/**
 * Reads the key. Returns undefined when the file does not exist (the caller decides whether
 * that is fatal), throws when it exists but is not a usable key — a half generated or
 * truncated file must never be treated as "not configured yet", because generating a new key
 * over it would orphan every credential that was sealed with the old one.
 */
export async function readGitSecret(configPath) {
	const target = secretPathFor(configPath);
	let raw;
	try {
		raw = await readFile(target, 'utf8');
	} catch (error) {
		if (error?.code === 'ENOENT') {
			return undefined;
		}
		throw gitError('GitNotConfigured');
	}
	return { path: target, key: decodeKey(raw) };
}

/** Throwing form used by every code path that needs to seal or unseal. */
export async function requireGitSecret(configPath) {
	const secret = await readGitSecret(configPath);
	if (!secret) {
		throw gitError('GitNotConfigured');
	}
	return secret;
}

/**
 * Creates the key file. Refuses to overwrite an existing one unless `overwrite` is set, and
 * writes with `wx` so two concurrent creations cannot interleave.
 */
export async function createGitSecret(configPath, { overwrite = false } = {}) {
	const target = secretPathFor(configPath);
	await mkdir(dirname(target), { recursive: true, mode: 0o700 });
	const key = randomBytes(keyBytes).toString('hex');
	if (overwrite) {
		await writeFile(target, key + '\n', { mode: 0o600 });
	} else {
		let handle;
		try {
			handle = await open(target, 'wx', 0o600);
		} catch (error) {
			if (error?.code === 'EEXIST') {
				throw gitError('RepositoryImmutable');
			}
			throw error;
		} finally {
			await handle?.close();
		}
		await writeFile(target, key + '\n', { mode: 0o600 });
	}
	await enforceMode(target);
	return { path: target };
}

async function enforceMode(target) {
	try {
		const info = await stat(target);
		if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) {
			const { chmod } = await import('node:fs/promises');
			await chmod(target, 0o600);
		}
	} catch {
		// A mode we cannot tighten is not an error here: the file was just created 0600.
	}
}

/**
 * Seals one credential. The workspace id and credential id are bound as additional
 * authenticated data, so a sealed blob copied from another row (or another workspace) fails to
 * open instead of silently authenticating as somebody else.
 */
export function sealCredential(secret, { workspaceId, credentialId, plaintext }) {
	if (typeof plaintext !== 'string' || plaintext.length === 0 || plaintext.length > gitSecretLimit) {
		throw gitError('InvalidCredential');
	}
	const iv = randomBytes(ivBytes);
	const cipher = createCipheriv(algorithm, secret.key, iv);
	cipher.setAAD(Buffer.from(aadFor(workspaceId, credentialId), 'utf8'));
	const sealed = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
	return sealedPrefix + Buffer.concat([iv, sealed, cipher.getAuthTag()]).toString('base64');
}

/** Opens a sealed credential. A wrong key or a moved blob is `InvalidCredential`. */
export function openCredential(secret, { workspaceId, credentialId, sealed }) {
	if (typeof sealed !== 'string' || !sealed.startsWith(sealedPrefix)) {
		throw gitError('InvalidCredential');
	}
	let blob;
	try {
		blob = Buffer.from(sealed.slice(sealedPrefix.length), 'base64');
	} catch {
		throw gitError('InvalidCredential');
	}
	if (blob.length < ivBytes + tagBytes + 1) {
		throw gitError('InvalidCredential');
	}
	const iv = blob.subarray(0, ivBytes);
	const tag = blob.subarray(blob.length - tagBytes);
	const body = blob.subarray(ivBytes, blob.length - tagBytes);
	try {
		const decipher = createDecipheriv(algorithm, secret.key, iv);
		decipher.setAAD(Buffer.from(aadFor(workspaceId, credentialId), 'utf8'));
		decipher.setAuthTag(tag);
		return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
	} catch {
		throw gitError('InvalidCredential');
	}
}

function aadFor(workspaceId, credentialId) {
	return 'l4s-git-credential\n' + workspaceId + '\n' + credentialId;
}

/** Constant time comparison helper for tests and for future key checks. */
export function sameSecret(left, right) {
	const a = Buffer.from(String(left));
	const b = Buffer.from(String(right));
	return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Operator CLI.
 *
 *   node apps/web/git-credentials.mjs secret --create [storage.json]   create the key
 *   node apps/web/git-credentials.mjs secret --status [storage.json]   report presence only
 *
 * The key itself is never printed: only the path and whether it exists.
 */
async function main(argv) {
	const [command, ...rest] = argv;
	const flags = new Set(rest.filter(entry => entry.startsWith('--')));
	const positional = rest.filter(entry => !entry.startsWith('--'));
	const configPath = positional[0] ?? process.env.LOG4STELLAR_STORAGE_CONFIG;
	if (command !== 'secret' || !configPath) {
		console.error('Usage: node apps/web/git-credentials.mjs secret (--create|--status) [storage.json]');
		process.exitCode = 2;
		return;
	}
	if (flags.has('--create')) {
		const { path } = await createGitSecret(configPath, { overwrite: flags.has('--overwrite') });
		console.log('created: ' + path);
		return;
	}
	const secret = await readGitSecret(configPath);
	console.log(`secret: ${secret ? 'present' : 'missing'} at ${secretPathFor(configPath)}`);
	if (!secret) {
		process.exitCode = 1;
	}
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
	await main(process.argv.slice(2));
}
