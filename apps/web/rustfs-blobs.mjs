import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { WorkspaceError } from './workspace-contract.mjs';

export async function openRustfsBlobs(settings, workspaceId, spoolDirectory) {
	const { endpoint, region = 'us-east-1', bucket, accessKeyId, secretAccessKey } = settings;
	if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
		throw new Error('The RustFS connection requires an endpoint, bucket and access credentials.');
	}
	await mkdir(spoolDirectory, { recursive: true, mode: 0o700 });
	const client = new S3Client({
		endpoint, region, forcePathStyle: true,
		credentials: { accessKeyId, secretAccessKey },
		requestChecksumCalculation: 'WHEN_REQUIRED',
		responseChecksumValidation: 'WHEN_REQUIRED',
	});
	const object = digest => ({ Bucket: bucket, Key: `workspaces/${workspaceId}/sha256/${digest}` });

	async function checkExisting(digest, size) {
		try {
			const head = await client.send(new HeadObjectCommand(object(digest)));
			if (head.ContentLength !== size || head.Metadata?.sha256 !== digest) {
				throw new WorkspaceError(502, 'StorageIntegrityMismatch');
			}
			return true;
		} catch (error) {
			if (error.$metadata?.httpStatusCode === 404) {
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
					const data = createReadStream(path);
					try {
						await client.send(new PutObjectCommand({
							...object(digest), Body: data, ContentLength: size,
							ContentType: 'application/octet-stream',
							ChecksumSHA256: Buffer.from(digest, 'hex').toString('base64'),
							Metadata: { sha256: digest },
							IfNoneMatch: '*',
						}));
					} catch (error) {
						if (error.$metadata?.httpStatusCode !== 412 || !await checkExisting(digest, size)) {
							throw error;
						}
					} finally {
						data.destroy();
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
			const response = await client.send(new GetObjectCommand({
				...object(digest), Range: range ? `bytes=${range.start}-${range.end}` : undefined,
			}));
			const expected = range ? range.end - range.start + 1 : size;
			if (!response.Body || response.ContentLength !== expected || response.Metadata?.sha256 !== digest) {
				response.Body?.destroy();
				throw new WorkspaceError(502, 'StorageIntegrityMismatch');
			}
			return response.Body;
		},

		close() {
			client.destroy();
		},
	};
}
