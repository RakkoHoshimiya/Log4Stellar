import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { openResumableUploads } from './resumable-uploads.mjs';
import { uploadsPage } from './uploads-page.mjs';

test('the upload page encodes paths in markup and uses the requested locale', () => {
	const page = uploadsPage({
		locale: 'zh-tw', theme: 'dark', workspaceId: 'notes', account: 'owner',
		directory: '/"><script>bad</script>', maxBytes: 100,
	});
	assert.match(page, /上傳附件/);
	assert.match(page, /&lt;script&gt;bad/);
	assert.doesNotMatch(page, /<script>bad/);
	assert.match(page, /l4sWorkspace=notes/);
});

test('persisted parts are checked and a lost commit response replays the same version',
	{ skip: process.env.LOG4STELLAR_UPLOAD_IT !== '1' && 'set LOG4STELLAR_UPLOAD_IT=1 for the isolated PostgreSQL fixture' },
	async () => {
		const { postgres } = JSON.parse(await readFile(process.env.LOG4STELLAR_STORAGE_CONFIG, 'utf8'));
		assert.equal(postgres.host, '127.0.0.1');
		assert.equal(postgres.database, 'managed_acceptance');
		const root = await mkdtemp(join(tmpdir(), 'l4s-upload-test-'));
		const config = { configPath: join(root, 'config.json'), postgres, maxUploadBytes: 20 * 1024 * 1024 };
		let manager = openResumableUploads(config);
		const id = randomUUID();
		const versions = new Map();
		const workspaceId = 'upload-fixture';
		const accountId = 'owner';
		let calls = 0;
		const backend = {
			async syncPutFile({ source, idempotencyKey, path }) {
				const pieces = [];
				for await (const bytes of source) pieces.push(bytes);
				assert.equal(Buffer.concat(pieces).toString(), 'abcde');
				calls++;
				if (!versions.has(idempotencyKey)) {
					versions.set(idempotencyKey, { body: { path, revisionId: randomUUID() } });
				}
				return versions.get(idempotencyKey);
			},
		};
		async function request(method, { suffix = '', offset, data, raw, account = accountId } = {}) {
			const ctx = {
				method, path: '/api/v1/uploads/' + id + suffix, query: { offset },
				is: type => type === (raw ? 'application/octet-stream' : 'application/json'),
				req: Readable.from(raw ? [raw] : data ? [Buffer.from(JSON.stringify(data))] : []),
			};
			await manager.handle(ctx, { workspaceId, accountId: account, backend });
			return ctx.body;
		}
		try {
			await request('PUT', { data: { path: '/file.bin', size: 5 } });
			await assert.rejects(request('GET', { account: 'another-owner' }), { code: 'UploadNotFound' });
			await assert.rejects(request('PATCH', { raw: Buffer.from('abc'), offset: '2' }), { code: 'UploadOffsetMismatch' });
			await request('PATCH', { raw: Buffer.from('abcde'), offset: '0' });
			await manager.close();
			manager = openResumableUploads(config);
			assert.equal((await request('GET')).offset, 5);

			const owner = createHash('sha256').update(workspaceId + '\0' + accountId).digest('hex');
			const staged = join(root, 'resumable-uploads', owner, id);
			const part = join(staged, 'part-0');
			const manifest = join(staged, 'upload.json');
			await writeFile(part, 'abcdX');
			await assert.rejects(request('POST', { suffix: '/complete' }), { code: 'UploadPartCorrupt' });
			assert.equal(versions.size, 0);
			await writeFile(part, 'abcde');
			const beforeCommit = JSON.parse(await readFile(manifest, 'utf8'));
			const first = await request('POST', { suffix: '/complete' });
			// Simulate interruption after file-version commit, before the upload receipt was saved.
			await writeFile(manifest, JSON.stringify({ ...beforeCommit, committing: true }));
			await writeFile(part, 'abcde');
			const [retry, duplicate] = await Promise.all([1, 2].map(() => request('POST', { suffix: '/complete' })));
			assert.deepEqual(first.result, retry.result);
			assert.deepEqual(retry.result, duplicate.result);
			assert.equal(calls, 2, 'the lost receipt replays exactly once');
			assert.equal(versions.size, 1);
		} finally {
			await manager.close();
			await rm(root, { recursive: true, force: true });
		}
	});
