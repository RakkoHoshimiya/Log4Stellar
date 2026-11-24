import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { WorkspaceError } from '../workspace-contract.mjs';

// A directory-backed object store that also offers the *inventory* surface the blob GC
// needs (list, head, deleteExact, copyTo), which test-support/directory-blobs.mjs
// deliberately does not have. It reads and writes the exact same layout
// (`<spool>/test-blobs/<workspaceId>/<digest>`), so a workspace imported through
// openDirectoryBlobs can be garbage collected through this adapter and vice versa.
//
// Object identity is derived from the filesystem timestamps and the size. Rewriting the
// bytes therefore changes the identity, which is what a test for "the candidate must not
// delete a rebuilt object" needs: it can call `rewrite()` between the plan and the sweep
// and watch the collector cancel instead of delete.

const digestPattern = /^[0-9a-f]{64}$/;

async function hashFile(file) {
	const hash = createHash('sha256');
	for await (const chunk of createReadStream(file)) hash.update(chunk);
	return hash.digest('hex');
}

async function identityOf(file) {
	const found = await stat(file);
	return `stat:${Math.round(found.mtimeMs)}:${Math.round(found.ctimeMs)}:${found.size}`;
}

async function exists(file) {
	try {
		await stat(file);
		return true;
	} catch (error) {
		if (error.code === 'ENOENT') return false;
		throw error;
	}
}

/**
 * @param {object} _settings unused, for signature compatibility with openRustfsBlobs.
 * @param {string} workspaceId
 * @param {string} spoolDirectory
 */
export async function openDirectoryInventory(_settings, workspaceId, spoolDirectory) {
	const root = join(spoolDirectory, 'test-blobs', workspaceId);
	await mkdir(root, { recursive: true, mode: 0o700 });
	const fileOf = (digest) => join(root, digest);
	const calls = { list: 0, head: 0, delete: 0, copy: 0 };

	async function head(digest) {
		calls.head += 1;
		if (!digestPattern.test(digest) || !await exists(fileOf(digest))) return null;
		const found = await stat(fileOf(digest));
		return {
			key: `workspaces/${workspaceId}/sha256/${digest}`,
			digest,
			sizeBytes: found.size,
			lastModifiedMs: Math.round(found.mtimeMs),
			version: await identityOf(fileOf(digest)),
		};
	}

	return {
		calls,
		workspaceId,
		root,

		async list(cursor, limit = 1000) {
			calls.list += 1;
			const names = (await readdir(root)).filter((name) => digestPattern.test(name)).sort();
			const start = cursor ? Number(cursor) : 0;
			if (!Number.isSafeInteger(start) || start < 0) throw new WorkspaceError(400, 'invalid_cursor');
			const page = names.slice(start, start + Math.max(1, limit));
			const objects = [];
			for (const digest of page) {
				const found = await head(digest);
				if (found) objects.push(found);
			}
			const next = start + page.length;
			return { objects, unmanaged: 0, cursor: next < names.length ? String(next) : null };
		},

		head,

		/** Deletes only when the identity still matches; never a blind delete. */
		async deleteExact(digest, version) {
			calls.delete += 1;
			const current = await head(digest);
			if (!current) return { deleted: false, missing: true };
			if (version && current.version !== version) {
				return { deleted: false, identityChanged: true, current: current.version };
			}
			await rm(fileOf(digest), { force: true });
			return { deleted: true };
		},

		/** Writes a digest-verified copy; the bytes are re-hashed from the copy. */
		async copyTo(path, digest, sizeBytes) {
			calls.copy += 1;
			const source = fileOf(digest);
			if (!await exists(source)) throw new WorkspaceError(502, 'StorageObjectMissing');
			await mkdir(join(path, '..'), { recursive: true, mode: 0o700 });
			const temporary = `${path}.partial`;
			await copyFile(source, temporary);
			const actual = await hashFile(temporary);
			if (actual !== digest) throw new Error('The recovery copy does not match the object digest.');
			const copy = await stat(temporary);
			if (sizeBytes !== undefined && sizeBytes !== null && copy.size !== Number(sizeBytes)) {
				throw new Error('The recovery copy does not match the recorded object size.');
			}
			await rm(path, { force: true });
			await rename(temporary, path);
			return { path, sizeBytes: copy.size, digest: actual };
		},

		close() {},

		// Test-only helpers.
		async put(digest, bytes) {
			if (!digestPattern.test(digest)) throw new Error('invalid digest');
			if (await exists(fileOf(digest))) return head(digest);
			const temporary = `${fileOf(digest)}.partial`;
			const { writeFile } = await import('node:fs/promises');
			await writeFile(temporary, bytes, { mode: 0o600 });
			await rename(temporary, fileOf(digest));
			return head(digest);
		},
		async rewrite(digest, bytes) {
			const temporary = `${fileOf(digest)}.partial`;
			const { writeFile } = await import('node:fs/promises');
			await writeFile(temporary, bytes, { mode: 0o600 });
			await rm(fileOf(digest), { force: true });
			await rename(temporary, fileOf(digest));
			return head(digest);
		},
		async bytes(digest) {
			return (await import('node:fs/promises')).readFile(fileOf(digest));
		},
		async digests() {
			return (await readdir(root)).filter((name) => digestPattern.test(name)).sort();
		},
	};
}
