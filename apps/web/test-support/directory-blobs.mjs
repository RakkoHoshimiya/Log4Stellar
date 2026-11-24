import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { WorkspaceError } from '../workspace-contract.mjs';

// A directory-backed stand-in for the RustFS object store. It implements the same
// contract as openRustfsBlobs (content-addressed, digest-verified, range reads) so
// storage-layer integration tests can exercise real PostgreSQL metadata without
// writing to the shared bucket. Blob bytes survive a reopen, which makes restart
// and rollback scenarios testable.
export async function openDirectoryBlobs(_settings, workspaceId, spoolDirectory) {
	await mkdir(spoolDirectory, { recursive: true, mode: 0o700 });
	const root = join(spoolDirectory, 'test-blobs', workspaceId);
	await mkdir(root, { recursive: true, mode: 0o700 });
	const object = digest => join(root, digest);

	async function checkExisting(digest, size) {
		try {
			const found = await stat(object(digest));
			if (found.size !== size) {
				throw new WorkspaceError(502, 'StorageIntegrityMismatch');
			}
			return true;
		} catch (error) {
			if (error.code === 'ENOENT') {
				return false;
			}
			throw error;
		}
	}

	return {
		async put(source, maxBytes) {
			const path = join(spoolDirectory, randomUUID());
			const hash = createHash('sha256');
			let size = 0;
			try {
				const input = Readable.from(source.iterator({ destroyOnReturn: false }));
				await pipeline(input, new Transform({
					transform(chunk, _, callback) {
						size += chunk.length;
						if (size > maxBytes) {
							callback(new WorkspaceError(413, 'FileTooLarge'));
							return;
						}
						hash.update(chunk);
						callback(null, chunk);
					},
				}), createWriteStream(path, { flags: 'wx', mode: 0o600 }));
				const digest = hash.digest('hex');
				if (!await checkExisting(digest, size)) {
					try {
						await pipeline(createReadStream(path), createWriteStream(object(digest), { flags: 'wx', mode: 0o600 }));
					} catch (error) {
						if (error.code !== 'EEXIST') {
							throw error;
						}
						await checkExisting(digest, size);
					}
				}
				return { digest, size };
			} finally {
				await rm(path, { force: true });
			}
		},

		async verify(digest, size) {
			if (!digest || !await checkExisting(digest, size)) {
				throw new WorkspaceError(502, 'StorageObjectMissing');
			}
		},

		async read(digest, size, range) {
			if (!await checkExisting(digest, size)) {
				throw new WorkspaceError(502, 'StorageObjectMissing');
			}
			return createReadStream(object(digest), range ? { start: range.start, end: range.end } : {});
		},

		close() {},
	};
}
