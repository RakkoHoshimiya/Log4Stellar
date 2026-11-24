import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { Pool } from 'pg';
import { openRustfsWorkspace } from './rustfs-workspace.mjs';
import { authorizeWorkspace } from './workspace-access.mjs';
import { openDirectoryBlobs } from './test-support/directory-blobs.mjs';
import { mountPath, serveWorkspaceFile } from './workspace-files.mjs';

// These tests drive the real PostgreSQL schema against throwaway `l4s-test-*` workspaces and a
// directory-backed blob store. They are opt-in because CI machines rarely provide the database.
const enabled = process.env.LOG4STELLAR_IT === '1';
// The skip reason is spelled out rather than inherited from `test.skip`: the CI entry
// asserts that every skip carries a reason, so a silent skip of this whole suite would
// otherwise look like a passing run.
const skipReason = enabled ? false : 'set LOG4STELLAR_IT=1 to run the PostgreSQL integration tests';
const scenario = (name, run) => test(name, { skip: skipReason }, run);
const maxBytes = 64 * 1024 * 1024;
const configPath = process.env.LOG4STELLAR_STORAGE_CONFIG;

function storageConfig() {
	if (!configPath) {
		throw new Error('Set LOG4STELLAR_STORAGE_CONFIG to run the attachment version integration tests.');
	}
	return JSON.parse(readFileSync(configPath, 'utf8'));
}

const mimeTypes = new Map([
	['.md', 'text/markdown; charset=utf-8'],
	['.txt', 'text/plain; charset=utf-8'],
	['.png', 'image/png'],
	['.jpg', 'image/jpeg'],
	['.mp4', 'video/mp4'],
	['.mov', 'video/quicktime'],
]);

function context({ method = 'GET', path = '/', query = {}, headers = {}, body } = {}) {
	const stored = new Map(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
	const ctx = {
		method,
		path: mountPath + path,
		query,
		length: undefined,
		status: undefined,
		body: undefined,
		req: body === undefined ? Readable.from([]) : body instanceof Readable ? body : Readable.from([body]),
		get: name => stored.get(name.toLowerCase()) ?? '',
		set: (name, value) => stored.set(name.toLowerCase(), value),
		is: type => (stored.get('content-type') ?? '').startsWith(type),
	};
	Object.defineProperty(ctx, 'type', {
		get: () => stored.get('content-type'),
		set: value => stored.set('content-type', mimeTypes.get(value) ?? value),
	});
	Object.defineProperty(ctx, 'headers', { value: stored });
	return ctx;
}

async function collect(ctx) {
	if (ctx.body === undefined) {
		return Buffer.alloc(0);
	}
	if (Buffer.isBuffer(ctx.body)) {
		return ctx.body;
	}
	if (typeof ctx.body === 'object' && !ctx.body[Symbol.asyncIterator]) {
		return Buffer.from(JSON.stringify(ctx.body));
	}
	const chunks = [];
	for await (const chunk of ctx.body) {
		chunks.push(Buffer.from(chunk));
	}
	return Buffer.concat(chunks);
}

async function request(workspace, options) {
	const ctx = context(options);
	// The handler requires the capability facade the gateway installs; these scenarios
	// exercise attachment versioning, so an owner role keeps authorization out of the way.
	await serveWorkspaceFile(ctx, authorizeWorkspace(workspace, { role: 'owner' }), maxBytes);
	// Koa infers the status from the body, so a response that only assigns `ctx.body` is a 200.
	const status = ctx.status ?? (ctx.body === undefined ? 404 : 200);
	return { status, headers: ctx.headers, length: ctx.length, body: await collect(ctx) };
}

function upload(workspace, path, bytes, { etag, create = true, overwrite = false } = {}) {
	const headers = { 'Content-Type': 'application/octet-stream' };
	if (etag) {
		headers['If-Match'] = etag;
	}
	return request(workspace, {
		method: 'PUT',
		path,
		query: { create: create ? '1' : '0', overwrite: overwrite ? '1' : '0' },
		headers,
		body: bytes,
	});
}

function digest(bytes) {
	return createHash('sha256').update(bytes).digest('hex');
}

async function digestOf(readable) {
	const hash = createHash('sha256');
	for await (const chunk of readable) {
		hash.update(chunk);
	}
	return hash.digest('hex');
}

async function readAll(readable) {
	const chunks = [];
	for await (const chunk of readable) {
		chunks.push(Buffer.from(chunk));
	}
	return Buffer.concat(chunks);
}

// `openRead(...).stream()` hands back the blob store's promise of a stream.
async function readAllOf(workspace, path) {
	return readAll(await (await workspace.openRead(path)).stream());
}

async function digestOfFile(workspace, path) {
	return digestOf(await (await workspace.openRead(path)).stream());
}

async function etagOf(workspace, path) {
	const response = await request(workspace, { method: 'HEAD', path });
	assert.equal(response.status, 200, `HEAD ${path}`);
	return response.headers.get('etag');
}

function mkdir(workspace, path) {
	return request(workspace, { method: 'POST', path, query: { mkdir: '1' } });
}

// Overwrites are conditional: the storage layer rejects a write that carries no `If-Match`
// even with `overwrite=1`, which is what makes concurrent saves safe.
async function overwrite(workspace, path, bytes) {
	const etag = await etagOf(workspace, path);
	return upload(workspace, path, bytes, { overwrite: true, etag });
}

function restore(workspace, path, revision, etag) {
	return request(workspace, {
		method: 'POST', path, query: { restoreVersion: revision }, headers: { 'If-Match': etag },
	});
}

async function scenarioWorkspace(work) {
	const settings = storageConfig();
	const workspaceId = 'l4s-test-' + randomUUID().replace(/-/g, '').slice(0, 12);
	const pool = new Pool({ connectionTimeoutMillis: 5000, max: 2, ...settings.postgres });
	const seed = await mkdtemp(join(tmpdir(), 'l4s-attach-'));
	try {
		// Importing an empty directory is the supported way to create a workspace, so every
		// scenario starts from the same state the production importer would produce.
		const importer = await openRustfsWorkspace(workspaceId, { importing: true, createBlobs: openDirectoryBlobs });
		try {
			await importer.importDirectory(seed, maxBytes);
		} finally {
			await importer.close();
		}
		const workspace = await openRustfsWorkspace(workspaceId, { createBlobs: openDirectoryBlobs });
		try {
			await work({ workspace, pool, workspaceId });
		} finally {
			await workspace.close();
		}
	} finally {
		await clean(pool, workspaceId);
		await pool.end();
		await rm(seed, { recursive: true, force: true });
	}
}

async function clean(pool, workspaceId) {
	await pool.query(
		'DELETE FROM log4stellar.storage_trash_entries WHERE trash_id IN (SELECT id FROM log4stellar.storage_trash WHERE workspace_id = $1)',
		[workspaceId]);
	// Incremental-sync rows reference storage_workspaces too, and snapshot entries are keyed
	// by snapshot only. Deleting them first keeps this fixture's cleanup self-contained.
	await pool.query(
		'DELETE FROM log4stellar.storage_snapshot_entries WHERE snapshot_id IN (SELECT id FROM log4stellar.storage_snapshots WHERE workspace_id = $1)',
		[workspaceId]);
	for (const table of ['storage_snapshots', 'storage_changes', 'storage_change_heads', 'storage_trash', 'storage_file_versions', 'storage_entries']) {
		await pool.query(`DELETE FROM log4stellar.${table} WHERE workspace_id = $1`, [workspaceId]);
	}
	await pool.query('DELETE FROM log4stellar.storage_workspaces WHERE id = $1', [workspaceId]);
	await rm(join(dirname(configPath), 'spool', 'test-blobs', workspaceId), { recursive: true, force: true });
}

async function versionRows(pool, workspaceId, path) {
	const { rows } = await pool.query(
		`SELECT e.file_id, v.revision_id, v.parent_revision_id, v.size_bytes, v.sha256
		   FROM log4stellar.storage_entries e
		   JOIN log4stellar.storage_file_versions v
		     ON v.workspace_id = e.workspace_id AND v.file_id = e.file_id AND v.revision_id = e.revision_id
		  WHERE e.workspace_id = $1 AND e.path = $2`, [workspaceId, path]);
	return rows;
}

async function chainRows(pool, workspaceId, fileId) {
	const { rows } = await pool.query(
		`SELECT revision_id, parent_revision_id, size_bytes, sha256
		   FROM log4stellar.storage_file_versions
		  WHERE workspace_id = $1 AND file_id = $2
		  ORDER BY created_ms`, [workspaceId, fileId]);
	return rows;
}

async function versionCount(pool, workspaceId) {
	const { rows } = await pool.query(
		'SELECT count(*)::int AS count FROM log4stellar.storage_file_versions WHERE workspace_id = $1', [workspaceId]);
	return rows[0].count;
}

scenario('restoring a binary attachment reproduces the old revision byte for byte', async () => {
	await scenarioWorkspace(async ({ workspace, pool, workspaceId }) => {
		const first = randomBytes(4096);
		const second = randomBytes(9000);
		assert.equal((await upload(workspace, '/report.docx', first)).status, 201);
		const current = await overwrite(workspace, '/report.docx', second);
		assert.equal(current.status, 200);

		const versions = await request(workspace, { path: '/report.docx', query: { versions: '1' } });
		assert.equal(versions.status, 200);
		const listed = JSON.parse(versions.body.toString());
		assert.equal(listed.length, 2);
		assert.equal(listed[0].current, true);
		assert.equal(listed[1].initial, true);
		assert.deepEqual(listed.map(version => version.size), [second.length, first.length]);
		const stale = listed[1].id;
		const staleSha = digest(first);

		const download = await request(workspace, {
			path: '/report.docx', query: { revision: stale }, headers: { Range: 'bytes=100-199' },
		});
		assert.equal(download.status, 206);
		assert.deepEqual(download.body, first.subarray(100, 200));

		const restore = await request(workspace, {
			method: 'POST', path: '/report.docx',
			query: { restoreVersion: stale }, headers: { 'If-Match': current.headers.get('etag') },
		});
		assert.equal(restore.status, 200);
		assert.notEqual(restore.headers.get('etag'), current.headers.get('etag'));

		// Restoring must create a new version rather than move the entry pointer.
		assert.equal(await digestOfFile(workspace, '/report.docx'), staleSha);

		const [entry] = await versionRows(pool, workspaceId, '/report.docx');
		const chain = await chainRows(pool, workspaceId, entry.file_id);
		assert.equal(chain.length, 3);
		assert.equal(chain[2].sha256, staleSha);
		assert.equal(Number(chain[2].size_bytes), first.length);
		assert.equal(chain[1].parent_revision_id, chain[0].revision_id);
		assert.equal(chain[2].parent_revision_id, chain[1].revision_id);
		assert.equal(chain[0].parent_revision_id, null);

		const after = JSON.parse((await request(workspace, { path: '/report.docx', query: { versions: '1' } })).body.toString());
		assert.equal(after.length, 3);
		assert.deepEqual(after.map(version => version.current), [true, false, false]);
		assert.equal(after[0].id, chain[2].revision_id);
	});
});

scenario('an empty attachment keeps a zero byte revision that can be listed, fetched and restored', async () => {
	await scenarioWorkspace(async ({ workspace, pool, workspaceId }) => {
		assert.equal((await upload(workspace, '/blank.pptx', Buffer.alloc(0))).status, 201);
		const content = Buffer.from('later content');
		assert.equal((await overwrite(workspace, '/blank.pptx', content)).status, 200);

		const listed = JSON.parse((await request(workspace, { path: '/blank.pptx', query: { versions: '1' } })).body.toString());
		assert.deepEqual(listed.map(version => version.size), [content.length, 0]);

		const empty = listed[1].id;
		const download = await request(workspace, { path: '/blank.pptx', query: { revision: empty } });
		assert.equal(download.status, 200);
		assert.equal(download.length, 0);
		assert.equal(download.body.length, 0);

		const rejected = await request(workspace, {
			path: '/blank.pptx', query: { revision: empty }, headers: { Range: 'bytes=0-0' },
		});
		assert.equal(rejected.status, 416);
		assert.equal(rejected.headers.get('content-range'), 'bytes */0');

		const current = await request(workspace, { path: '/blank.pptx' });
		const restore = await request(workspace, {
			method: 'POST', path: '/blank.pptx',
			query: { restoreVersion: empty }, headers: { 'If-Match': current.headers.get('etag') },
		});
		assert.equal(restore.status, 200);
		assert.equal((await workspace.openRead('/blank.pptx')).size, 0);

		const [entry] = await versionRows(pool, workspaceId, '/blank.pptx');
		const chain = await chainRows(pool, workspaceId, entry.file_id);
		assert.equal(chain.length, 3);
		assert.equal(Number(chain[2].size_bytes), 0);
		assert.equal(chain[2].sha256, digest(Buffer.alloc(0)));
	});
});

scenario('a historical video revision serves byte exact range requests', async () => {
	await scenarioWorkspace(async ({ workspace, pool, workspaceId }) => {
		const video = randomBytes(16 * 1024 * 1024);
		const replacement = randomBytes(1024);
		assert.equal((await upload(workspace, '/clip.mov', video)).status, 201);
		assert.equal((await overwrite(workspace, '/clip.mov', replacement)).status, 200);

		const listed = JSON.parse((await request(workspace, { path: '/clip.mov', query: { versions: '1' } })).body.toString());
		const original = listed.find(version => version.initial)?.id;
		assert.ok(original, 'the original revision must still be listed');

		const ranged = await request(workspace, {
			path: '/clip.mov', query: { revision: original }, headers: { Range: 'bytes=1000000-1999999' },
		});
		assert.equal(ranged.status, 206);
		assert.equal(ranged.headers.get('content-range'), 'bytes 1000000-1999999/16777216');
		assert.equal(ranged.headers.get('accept-ranges'), 'bytes');
		assert.equal(ranged.body.length, 1000000);
		assert.equal(digest(ranged.body), digest(video.subarray(1000000, 2000000)));

		const tail = await request(workspace, {
			path: '/clip.mov', query: { revision: original }, headers: { Range: 'bytes=-2048' },
		});
		assert.equal(tail.status, 206);
		assert.equal(tail.headers.get('content-range'), 'bytes 16775168-16777215/16777216');
		assert.deepEqual(tail.body, video.subarray(video.length - 2048));

		const whole = await request(workspace, { path: '/clip.mov', query: { revision: original } });
		assert.equal(whole.status, 200);
		assert.equal(digest(whole.body), digest(video));

		const [entry] = await versionRows(pool, workspaceId, '/clip.mov');
		assert.equal(Number((await chainRows(pool, workspaceId, entry.file_id))[0].size_bytes), video.length);
	});
});

scenario('an interrupted upload leaves no version behind and a retry records exactly one', async () => {
	await scenarioWorkspace(async ({ workspace, pool, workspaceId }) => {
		assert.equal((await mkdir(workspace, '/media')).status, 204);
		assert.equal((await upload(workspace, '/media/poster.jpg', randomBytes(64))).status, 201);
		const before = await versionCount(pool, workspaceId);

		const payload = randomBytes(4 * 1024 * 1024);
		const interrupted = Readable.from((async function* () {
			yield payload.subarray(0, 512 * 1024);
			yield payload.subarray(512 * 1024, 1024 * 1024);
			throw new Error('network interrupted');
		})());
		await assert.rejects(
			request(workspace, {
				method: 'PUT', path: '/media/clip.mov',
				query: { create: '1', overwrite: '0' },
				headers: { 'Content-Type': 'application/octet-stream' },
				body: interrupted,
			}),
			/network interrupted/);

		const listing = JSON.parse((await request(workspace, { path: '/media', query: { readdir: '1' } })).body.toString());
		assert.deepEqual(listing.map(item => item.name), ['poster.jpg']);
		assert.equal(await versionCount(pool, workspaceId), before, 'no version may be recorded for a failed upload');
		assert.equal((await request(workspace, { path: '/media/clip.mov', query: { versions: '1' } })).status, 404);

		const retry = await upload(workspace, '/media/clip.mov', payload);
		assert.equal(retry.status, 201);
		const listed = JSON.parse((await request(workspace, { path: '/media/clip.mov', query: { versions: '1' } })).body.toString());
		assert.equal(listed.length, 1);
		assert.equal(listed[0].size, payload.length);
		assert.equal(listed[0].current, true);
		assert.equal(listed[0].initial, true);
		assert.equal(digest(await readAllOf(workspace, '/media/clip.mov')), digest(payload));
	});
});

scenario('same named attachments keep independent version chains', async () => {
	await scenarioWorkspace(async ({ workspace, pool, workspaceId }) => {
		assert.equal((await mkdir(workspace, '/team-a')).status, 204);
		assert.equal((await mkdir(workspace, '/team-b')).status, 204);
		const left = randomBytes(128);
		const right = randomBytes(256);
		const leftFinal = randomBytes(512);
		assert.equal((await upload(workspace, '/team-a/report.pdf', left)).status, 201);
		assert.equal((await upload(workspace, '/team-b/report.pdf', right)).status, 201);
		assert.equal((await overwrite(workspace, '/team-a/report.pdf', leftFinal)).status, 200);

		const a = JSON.parse((await request(workspace, { path: '/team-a/report.pdf', query: { versions: '1' } })).body.toString());
		const b = JSON.parse((await request(workspace, { path: '/team-b/report.pdf', query: { versions: '1' } })).body.toString());
		assert.equal(a.length, 2);
		assert.equal(b.length, 1);
		assert.equal(new Set([...a, ...b].map(version => version.id)).size, 3, 'revision ids must be distinct');

		const [entryA] = await versionRows(pool, workspaceId, '/team-a/report.pdf');
		const [entryB] = await versionRows(pool, workspaceId, '/team-b/report.pdf');
		assert.notEqual(entryA.file_id, entryB.file_id, 'a same named file in another directory is another file');

		// Overwriting in place must extend the chain of the same file rather than fork it.
		const chainA = await chainRows(pool, workspaceId, entryA.file_id);
		assert.equal(chainA.length, 2);
		assert.equal(chainA[1].parent_revision_id, chainA[0].revision_id);
		assert.equal(chainA[0].sha256, digest(left));
		assert.equal(chainA[1].sha256, digest(leftFinal));
		assert.equal((await chainRows(pool, workspaceId, entryB.file_id)).length, 1);

		// The historical revision of one attachment stays reachable after the other is written.
		const historical = await request(workspace, { path: '/team-b/report.pdf', query: { revision: b[0].id } });
		assert.equal(historical.status, 200);
		assert.equal(digest(historical.body), digest(right));

		const crossFile = await request(workspace, { path: '/team-b/report.pdf', query: { revision: a[1].id } });
		assert.equal(crossFile.status, 404);
		assert.equal(crossFile.body.toString(), JSON.stringify({ error: 'FileNotFound' }));
	});
});

scenario('attachment downloads are sandboxed octet streams while previewable files stay inline', async () => {
	await scenarioWorkspace(async ({ workspace }) => {
		for (const path of ['/plan.docx', '/sheet.xlsx', '/deck.pptx', '/bundle.zip']) {
			assert.equal((await upload(workspace, path, randomBytes(32))).status, 201);
			const response = await request(workspace, { path });
			assert.equal(response.headers.get('content-type'), 'application/octet-stream', path);
			assert.equal(response.headers.get('content-security-policy'), "sandbox; default-src 'none'", path);
			assert.equal(response.headers.get('x-content-type-options'), 'nosniff', path);
		}
		assert.equal((await upload(workspace, '/notes.md', Buffer.from('# notes'))).status, 201);
		const markdown = await request(workspace, { path: '/notes.md' });
		assert.equal(markdown.headers.get('content-type'), 'text/markdown; charset=utf-8');
		assert.equal(markdown.headers.get('content-security-policy'), "sandbox; default-src 'none'");
	});
});

scenario('a concurrent save and restore leaves a linear chain and rejects the loser', async () => {
	await scenarioWorkspace(async ({ workspace, pool, workspaceId }) => {
		const base = randomBytes(1024);
		const created = await upload(workspace, '/deck.pptx', base);
		assert.equal(created.status, 201);
		const baseEtag = created.headers.get('etag');
		assert.ok(baseEtag, 'a created attachment must carry an ETag');
		const winner = randomBytes(2048);
		const saved = await overwrite(workspace, '/deck.pptx', winner);
		assert.equal(saved.status, 200);
		const versions = JSON.parse((await request(workspace, { path: '/deck.pptx', query: { versions: '1' } })).body.toString());
		const originalId = versions.find(version => version.initial).id;
		const contested = saved.headers.get('etag');

		// Both requests read the same ETag, so exactly one of them may advance the chain.
		const [save, restored] = await Promise.all([
			upload(workspace, '/deck.pptx', randomBytes(64), { overwrite: true, etag: contested }),
			restore(workspace, '/deck.pptx', originalId, contested),
		]);
		assert.deepEqual([save.status, restored.status].sort(), [200, 412], 'one writer wins and the other is rejected');
		const rejected = save.status === 412 ? save : restored;
		assert.equal(rejected.body.toString(), JSON.stringify({ error: 'FileChanged' }));

		const [entry] = await versionRows(pool, workspaceId, '/deck.pptx');
		const chain = await chainRows(pool, workspaceId, entry.file_id);
		assert.equal(chain.length, 3, 'only the winner may append a revision');
		for (let index = 1; index < chain.length; index += 1) {
			assert.equal(chain[index].parent_revision_id, chain[index - 1].revision_id);
		}
		const current = JSON.parse((await request(workspace, { path: '/deck.pptx', query: { versions: '1' } })).body.toString());
		assert.deepEqual(current.map(version => version.current), [true, false, false]);
		assert.equal(current[0].id, chain[2].revision_id);
	});
});

scenario('restoring a revision of a deleted attachment is not silently resurrected', async () => {
	await scenarioWorkspace(async ({ workspace }) => {
		const created = await upload(workspace, '/gone.zip', randomBytes(16));
		assert.equal(created.status, 201);
		const etag = created.headers.get('etag');
		const versions = JSON.parse((await request(workspace, { path: '/gone.zip', query: { versions: '1' } })).body.toString());
		const removed = versions[0].id;

		assert.equal((await request(workspace, { method: 'DELETE', path: '/gone.zip' })).status, 204);
		assert.equal((await request(workspace, { path: '/gone.zip', query: { versions: '1' } })).status, 404);

		// Restoring by revision id must not resurrect a path that only lives in the recycle bin.
		const resurrected = await restore(workspace, '/gone.zip', removed, etag);
		assert.equal(resurrected.status, 404);
		assert.equal(resurrected.body.toString(), JSON.stringify({ error: 'FileNotFound' }));
	});
});

// The keep-both restore path has to invent a free name, and a wrong name is a real defect: it
// either mangles the extension or produces a path a user cannot predict. These attachments are
// deleted while a same-named file still exists, so each restore has to disambiguate.
scenario('a keep both restore names attachments without mangling them', async () => {
	await scenarioWorkspace(async ({ workspace }) => {
		const names = ['a.tar.gz', 'name .txt', 'noext', '.hidden', 'x (restored).txt'];
		const expected = new Map([
			['a.tar.gz', '/a (restored).tar.gz'],
			['name .txt', '/name (restored).txt'],
			['noext', '/noext (restored)'],
			['.hidden', '/.hidden (restored)'],
			['x (restored).txt', '/x (restored 2).txt'],
		]);
		const bytes = randomBytes(32);

		for (const name of names) {
			const path = '/' + name;
			assert.equal((await upload(workspace, path, bytes)).status, 201, path);
			const trash = await request(workspace, { method: 'DELETE', path });
			assert.equal(trash.status, 204, path);
			// A fresh file at the original path forces the restore to pick another name.
			assert.equal((await upload(workspace, path, randomBytes(8))).status, 201, path);
		}

		const listed = JSON.parse((await request(workspace, { path: '/', query: { trash: '1' } })).body.toString());
		assert.equal(listed.length, names.length);
		for (const item of listed) {
			const restored = await request(workspace, {
				method: 'POST', path: '/', query: { restoreTrash: item.id, keepBoth: '1' },
			});
			assert.equal(restored.status, 200, item.path);
			const expectedPath = expected.get(item.path.slice(1));
			assert.ok(expectedPath, 'unexpected trashed path ' + item.path);
			assert.equal(restored.body.toString().includes(expectedPath), true, item.path + ' -> ' + restored.body);
		}

		const root = JSON.parse((await request(workspace, { path: '/', query: { readdir: '1' } })).body.toString());
		const present = new Set(root.map(entry => entry.name));
		for (const expectedName of expected.values()) {
			assert.equal(present.has(expectedName.slice(1)), true, 'missing ' + expectedName);
		}
	});
});
