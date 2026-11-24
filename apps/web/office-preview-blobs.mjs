// Derived PDF storage for Office previews (05-Office文件预览.md §3, §5).
//
// This is the *only* module allowed to write or delete a derived PDF. Originals are
// never touched here: the workspace object store stays read-only from the preview
// path, which is what makes "生成预览不写原件对象" a structural property rather than a
// convention.
//
// The store is a private directory, not the workspace bucket. Previews are
// deployment-local, disposable and must never be mixed with the originals that the
// backup and retention rules protect; keeping them in their own root also means a
// misconfigured eviction can only ever delete preview objects.

import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { WorkspaceError } from './workspace-contract.mjs';

const previewKeyPattern = /^office-previews\/([0-9a-f]{2})\/([0-9a-f]{64})\/([0-9a-f-]{36})\.pdf$/;

/** Default root: a private directory under the system temp dir, never the workspace. */
export function previewCacheRoot(environment = process.env) {
	return resolve(environment.LOG4STELLAR_OFFICE_CACHE_DIR || join(tmpdir(), 'log4stellar-office-previews'));
}

function safePath(root, key) {
	if (typeof key !== 'string' || !previewKeyPattern.test(key)) {
		throw new WorkspaceError(400, 'InvalidRequest');
	}
	const path = resolve(root, key);
	// Defence in depth: the pattern already forbids `..`, but a resolved-path check
	// keeps the invariant obvious if the pattern is ever widened.
	if (path !== join(root, key) || !path.startsWith(root + sep)) {
		throw new WorkspaceError(400, 'InvalidRequest');
	}
	return path;
}

export async function openPreviewBlobs({ directory = previewCacheRoot(), maxBytes = 100 * 1024 * 1024 } = {}) {
	const root = resolve(directory);
	await mkdir(root, { recursive: true, mode: 0o700 });

	return {
		root,

		/**
		 * Streams a verified PDF into its attempt-specific key. The bytes are written
		 * to a sibling temporary file first and renamed into place, so a reader can
		 * never observe a half written object and a crash leaves only a `*.part` file
		 * that the next `sweep` removes.
		 */
		async put(key, source, limit = maxBytes) {
			const path = safePath(root, key);
			await mkdir(dirname(path), { recursive: true, mode: 0o700 });
			const staging = path + '.' + randomUUID() + '.part';
			const hash = createHash('sha256');
			let size = 0;
			try {
				await pipeline(Readable.from(source), new Transform({
					transform(chunk, _, callback) {
						size += chunk.length;
						if (size > limit) {
							callback(new WorkspaceError(413, 'FileTooLarge'));
							return;
						}
						hash.update(chunk);
						callback(null, chunk);
					},
				}), createWriteStream(staging, { flags: 'wx', mode: 0o600 }));
				await rename(staging, path);
				return { key, size, sha256: hash.digest('hex') };
			} catch (error) {
				await rm(staging, { force: true });
				throw error;
			}
		},

		/** Metadata of a published PDF, or `undefined` when the object is gone. */
		async stat(key) {
			try {
				const found = await stat(safePath(root, key));
				return { size: found.size };
			} catch (error) {
				if (error.code === 'ENOENT') {
					return undefined;
				}
				throw error;
			}
		},

		/**
		 * Opens a published PDF for reading, optionally one byte range. The declared
		 * size is checked against the file so a truncated object is reported as a
		 * missing object (which re-queues the preview) instead of being streamed.
		 */
		async open(key, expectedSize, range) {
			const path = safePath(root, key);
			let found;
			try {
				found = await stat(path);
			} catch (error) {
				if (error.code === 'ENOENT') {
					throw new WorkspaceError(502, 'StorageObjectMissing');
				}
				throw error;
			}
			if (!Number.isFinite(found.size) || found.size === 0 || (expectedSize !== undefined && found.size !== expectedSize)) {
				throw new WorkspaceError(502, 'StorageIntegrityMismatch');
			}
			if (!range) {
				return { size: found.size, stream: createReadStream(path) };
			}
			if (range.start >= found.size || range.end < range.start) {
				throw new WorkspaceError(416, 'InvalidRange');
			}
			const end = Math.min(range.end, found.size - 1);
			return { size: found.size, stream: createReadStream(path, { start: range.start, end }) };
		},

		/** Reads the leading bytes so the caller can check the PDF magic. */
		async head(key, length = 8) {
			const path = safePath(root, key);
			let handle;
			try {
				handle = await open(path, 'r');
			} catch (error) {
				if (error.code === 'ENOENT') {
					throw new WorkspaceError(502, 'StorageObjectMissing');
				}
				throw error;
			}
			try {
				const buffer = Buffer.alloc(length);
				const { bytesRead } = await handle.read(buffer, 0, length, 0);
				return buffer.subarray(0, bytesRead);
			} finally {
				await handle.close();
			}
		},

		/** Deletes one derived PDF. The only delete path for preview objects. */
		async remove(key) {
			await rm(safePath(root, key), { force: true });
		},

		/** Bytes currently held under the root, for the cache budget check. */
		async usage() {
			const { readdir } = await import('node:fs/promises');
			let total = 0;
			const walk = async directory => {
				let entries;
				try {
					entries = await readdir(directory, { withFileTypes: true });
				} catch (error) {
					if (error.code === 'ENOENT') {
						return;
					}
					throw error;
				}
				for (const entry of entries) {
					const path = join(directory, entry.name);
					if (entry.isDirectory()) {
						await walk(path);
					} else if (entry.isFile() && !entry.name.endsWith('.part')) {
						total += (await stat(path)).size;
					}
				}
			};
			await walk(root);
			return total;
		},

		/**
		 * §5 `evictPreviewCache`: frees space for `wantedBytes` by deleting the least
		 * recently used ready previews of this workspace. Victims come from the store
		 * callback, so this module never invents an eviction order and never tries to
		 * delete an object it was not handed. A recently touched row is never taken
		 * while an older one is available.
		 */
		async evict({ wantedBytes, budgetBytes, listCandidates, markEvicted, keep }) {
			if (!(wantedBytes > 0)) {
				return { evicted: 0, freedBytes: 0 };
			}
			const candidates = await listCandidates();
			let remaining = await this.usage();
			let evicted = 0;
			let freedBytes = 0;
			for (const candidate of candidates) {
				if (remaining + wantedBytes <= budgetBytes) {
					break;
				}
				if (keep && keep(candidate)) {
					continue;
				}
				await this.remove(candidate.objectKey).catch(() => {});
				await markEvicted(candidate);
				remaining -= Number(candidate.sizeBytes);
				freedBytes += Number(candidate.sizeBytes);
				evicted += 1;
			}
			return { evicted, freedBytes };
		},

		/**
		 * Removes temporary files left behind by a crashed upload. Called on startup so
		 * a restart never leaks disk space into the cache budget.
		 */
		async sweep() {
			const { readdir } = await import('node:fs/promises');
			let removed = 0;
			const walk = async directory => {
				let entries;
				try {
					entries = await readdir(directory, { withFileTypes: true });
				} catch (error) {
					if (error.code === 'ENOENT') {
						return;
					}
					throw error;
				}
				for (const entry of entries) {
					const path = join(directory, entry.name);
					if (entry.isDirectory()) {
						await walk(path);
					} else if (entry.isFile() && entry.name.endsWith('.part')) {
						await rm(path, { force: true });
						removed += 1;
					}
				}
			};
			await walk(root);
			return removed;
		},
	};
}
