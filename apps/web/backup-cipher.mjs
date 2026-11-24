// At-rest encryption for backup members and exported object bytes.
//
// A backup is the one artifact that deliberately contains every credential the
// deployment owns: the better-auth secret, the Git sealing key and the storage
// configuration with its plaintext RustFS and PostgreSQL passwords. Restricted file
// permissions are not a transport story -- a backup gets copied to another host, to a
// USB disk or to an object store -- so the bytes are sealed as well.
//
// Two levels, on purpose. One passphrase-derived key per *backup* (a fresh scrypt salt
// per run, recorded in the manifest), and one random IV per *file*. Deriving per file
// would mean an expensive scrypt for each of the ~1000 objects; deriving per backup
// and giving every file its own 96-bit IV is the standard construction and is safe
// for the file counts a workspace has.
//
//   envelope := magic(7) "l4sbk1\n" | iv(12) | ciphertext(n) | tag(16)
//
// AES-256-GCM authenticates every member, so a truncated or edited file fails to
// decrypt instead of restoring silently corrupted data. The manifest additionally
// records the plaintext digest, so restored bytes are checked twice: GCM at
// decryption, sha256 against the manifest afterwards.
import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { appendFile, open, readFile, stat, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

const derive = promisify(scrypt);

/** The cipher suite advertised in the manifest. A restore refuses anything else. */
export const backupCipher = 'aes-256-gcm';

/** The key-derivation function advertised in the manifest. */
export const backupKdf = 'scrypt';

const magic = Buffer.from('l4sbk1\n', 'latin1');
const saltBytes = 16;
const ivBytes = 12;
const tagBytes = 16;
const keyBytes = 32;
const headerBytes = magic.length + ivBytes;
const minimumKeyMaterial = 16;
// N = 2^14 costs ~16 MiB and a few tens of milliseconds, once per backup run: slow
// enough to matter to an offline attacker, fast enough for a scheduled job.
const scryptOptions = { N: 1 << 14, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

/**
 * Accepts raw key material, a passphrase, or `{ keyFile }` and returns the bytes.
 *
 * A key file is a separate 0600 file so the passphrase never has to appear in the
 * environment of a long-running scheduler, in shell history, or in the manifest.
 * @param {Buffer | Uint8Array | string | { keyFile?: string, passphrase?: string | Buffer } | undefined} material
 */
export async function resolveKeyMaterial(material) {
	if (material === undefined || material === null) {
		throw new Error('Backup encryption requires key material: pass { keyFile } or a passphrase.');
	}
	let bytes;
	if (typeof material === 'string') {
		bytes = Buffer.from(material, 'utf8');
	} else if (Buffer.isBuffer(material) || material instanceof Uint8Array) {
		bytes = Buffer.from(material);
	} else if (material.keyFile) {
		bytes = Buffer.from((await readFile(material.keyFile, 'utf8')).trim(), 'utf8');
	} else if (material.passphrase !== undefined) {
		bytes = Buffer.from(material.passphrase);
	} else {
		throw new Error('Backup encryption key material must name a key file or a passphrase.');
	}
	if (bytes.length < minimumKeyMaterial) {
		throw new Error('Backup encryption key material must be at least ' + minimumKeyMaterial + ' bytes long.');
	}
	return bytes;
}

/** Generates a key file (0600, never overwritten) and returns its contents. */
export async function writeKeyFile(path) {
	const material = randomBytes(keyBytes).toString('base64url');
	await writeFile(path, material + '\n', { flag: 'wx', mode: 0o600 });
	return material;
}

/** True when the file starts with the backup envelope magic. */
export async function isEncryptedFile(path) {
	const handle = await open(path, 'r');
	try {
		const head = Buffer.alloc(magic.length);
		const { bytesRead } = await handle.read(head, 0, head.length, 0);
		return bytesRead === magic.length && head.equals(magic);
	} finally {
		await handle.close();
	}
}

function sealKey(passphrase, salt) {
	return derive(passphrase, salt, keyBytes, scryptOptions);
}

function envelopeOf(iv) {
	return Buffer.concat([magic, iv]);
}

/**
 * Opens a sealer bound to one backup run's salt.
 *
 * `salt` and `keyMaterial` may be omitted for a new backup, in which case a fresh
 * salt is generated; a restore passes the salt it read out of the manifest so the
 * same key is reproduced. The returned functions are the only way the rest of the
 * tooling touches ciphertext, which keeps the envelope format in one place.
 *
 * @param {unknown} keyMaterial
 * @param {{ salt?: string, passphrase?: boolean }} [options]  salt as base64
 */
export async function openSealer(keyMaterial, options = {}) {
	const passphrase = await resolveKeyMaterial(keyMaterial);
	const salt = options.salt ? Buffer.from(options.salt, 'base64') : randomBytes(saltBytes);
	if (salt.length !== saltBytes) {
		throw new Error('A backup encryption salt must be ' + saltBytes + ' bytes.');
	}
	const key = await sealKey(passphrase, salt);
	const encryption = {
		cipher: backupCipher,
		kdf: backupKdf,
		salt: salt.toString('base64'),
		ivBytes,
	};

	return {
		encryption,

		/** Encrypts a buffer, for the small members written whole. */
		encryptBytes(bytes) {
			const iv = randomBytes(ivBytes);
			const cipher = createCipheriv(backupCipher, key, iv);
			const body = Buffer.concat([cipher.update(Buffer.from(bytes)), cipher.final()]);
			return Buffer.concat([envelopeOf(iv), body, cipher.getAuthTag()]);
		},

		/** Reverses {@link encryptBytes}; a wrong key or an edited envelope throws. */
		decryptBytes(envelope) {
			const buffer = Buffer.from(envelope);
			if (buffer.length < headerBytes + tagBytes || !buffer.subarray(0, magic.length).equals(magic)) {
				throw new Error('Not a Log4Stellar backup envelope.');
			}
			const iv = buffer.subarray(magic.length, headerBytes);
			const decipher = createDecipheriv(backupCipher, key, iv);
			decipher.setAuthTag(buffer.subarray(buffer.length - tagBytes));
			return Buffer.concat([
				decipher.update(buffer.subarray(headerBytes, buffer.length - tagBytes)),
				decipher.final(),
			]);
		},

		/**
		 * Encrypts one file into `destination` (created `wx`, 0600), single pass.
		 * @param {string} source
		 * @param {string} destination
		 */
		async encryptFile(source, destination) {
			const iv = randomBytes(ivBytes);
			const cipher = createCipheriv(backupCipher, key, iv);
			await writeFile(destination, envelopeOf(iv), { flag: 'wx', mode: 0o600 });
			await pipeline(createReadStream(source), cipher, createWriteStream(destination, { flags: 'a', mode: 0o600 }));
			await appendFile(destination, cipher.getAuthTag());
			return { size: (await stat(destination)).size };
		},

		/**
		 * Decrypts one file into `destination` (created `wx`, 0600).
		 *
		 * The GCM tag lives at the end of the file, so it is read first and set before
		 * the ciphertext streams through; that keeps decryption single-pass.
		 * @param {string} source
		 * @param {string} destination
		 */
		async decryptFile(source, destination) {
			const handle = await open(source, 'r');
			let size;
			let header;
			let tag;
			try {
				size = (await handle.stat()).size;
				if (size < headerBytes + tagBytes) {
					throw new Error('Truncated backup member: ' + source);
				}
				header = Buffer.alloc(headerBytes);
				const { bytesRead } = await handle.read(header, 0, header.length, 0);
				if (bytesRead !== headerBytes || !header.subarray(0, magic.length).equals(magic)) {
					throw new Error('Not a Log4Stellar backup envelope: ' + source);
				}
				tag = Buffer.alloc(tagBytes);
				await handle.read(tag, 0, tagBytes, size - tagBytes);
			} finally {
				await handle.close();
			}
			const decipher = createDecipheriv(backupCipher, key, header.subarray(magic.length, headerBytes));
			decipher.setAuthTag(tag);
			const start = headerBytes;
			const end = size - tagBytes;
			if (end === start) {
				// An empty plaintext still has a valid envelope; create the empty file so
				// the caller's digest comparison sees an empty member, not a missing one.
				const empty = await this.encryptBytes(Buffer.alloc(0));
				if (empty.length === 0) {
					throw new Error('Unreachable: an empty envelope is never empty.');
				}
				await writeFile(destination, Buffer.alloc(0), { flag: 'wx', mode: 0o600 });
				return { size: 0 };
			}
			await pipeline(
				createReadStream(source, { start, end: end - 1 }),
				decipher,
				createWriteStream(destination, { flags: 'wx', mode: 0o600 }),
			);
			return { size: (await stat(destination)).size };
		},
	};
}

/**
 * Reopens the sealer of an existing backup from the `encryption` block its manifest
 * records. Refuses a suite this build does not implement rather than guessing.
 * @param {unknown} keyMaterial
 * @param {{ cipher?: string, kdf?: string, salt?: string } | undefined} encryption
 */
export async function reopenSealer(keyMaterial, encryption) {
	if (!encryption || typeof encryption !== 'object') {
		throw new Error('This backup does not record how its members are encrypted.');
	}
	if (encryption.cipher !== backupCipher) {
		throw new Error('Unsupported backup cipher ' + JSON.stringify(encryption.cipher) + ' (expected ' + backupCipher + ').');
	}
	if (encryption.kdf !== backupKdf) {
		throw new Error('Unsupported backup key derivation ' + JSON.stringify(encryption.kdf) + ' (expected ' + backupKdf + ').');
	}
	if (typeof encryption.salt !== 'string' || encryption.salt.length === 0) {
		throw new Error('This backup does not record its encryption salt.');
	}
	return openSealer(keyMaterial, { salt: encryption.salt });
}
