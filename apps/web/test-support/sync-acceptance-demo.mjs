// Prints a readable trace of the five acceptance scenarios of the incremental sync API
// against the real PostgreSQL storage. It is evidence, not a test: the assertions live in
// apps/web/sync-integration.test.mjs. Run it with the same opt-in switch:
//
//   LOG4STELLAR_STORAGE_CONFIG=/tmp/l4s-sync-storage.json LOG4STELLAR_IT=1 \
//     node apps/web/test-support/sync-acceptance-demo.mjs
//
// Every workspace is `l4s-it-*` and is deleted again, including its blob directory.
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { Pool } from 'pg';
import { openRustfsWorkspace } from '../rustfs-workspace.mjs';
import { authorizeWorkspace } from '../workspace-access.mjs';
import { openDirectoryBlobs } from './directory-blobs.mjs';
import { syncRetention } from '../sync-contract.mjs';
import { serveSyncRequest } from '../sync-files.mjs';
import { trimChanges } from '../sync-store.mjs';

if (process.env.LOG4STELLAR_IT !== '1') {
	console.error('Set LOG4STELLAR_IT=1 (and LOG4STELLAR_STORAGE_CONFIG) to run this demo.');
	process.exit(2);
}
const configPath = process.env.LOG4STELLAR_STORAGE_CONFIG;
const settings = JSON.parse(readFileSync(configPath, 'utf8'));
const maxBytes = 64 * 1024 * 1024;
const spool = join(dirname(configPath), 'spool');

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const head = text => console.log('\n=== ' + text + ' ===');

async function request(backend, workspaceId, { method = 'GET', path = '/', query = {}, headers = {}, body } = {}) {
	const stored = new Map(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), String(value)]));
	let payload;
	if (Buffer.isBuffer(body)) {
		payload = body;
		stored.set('content-type', 'application/octet-stream');
		stored.set('content-length', String(body.length));
	} else if (body !== undefined) {
		payload = Buffer.from(JSON.stringify(body));
		stored.set('content-type', 'application/json');
	}
	const ctx = {
		method,
		path: '/sync/v1' + path,
		query,
		req: payload === undefined ? Readable.from([]) : Readable.from([payload]),
		get: name => stored.get(name.toLowerCase()) ?? '',
		set: (name, value) => stored.set(name.toLowerCase(), value),
		is: type => (stored.get('content-type') ?? '').startsWith(type),
	};
	await serveSyncRequest(ctx, authorizeWorkspace(backend, { role: 'owner' }), backend, workspaceId, maxBytes);
	return { status: ctx.status, body: ctx.body };
}

const upload = (backend, workspaceId, path, bytes, { mode = 'create', baseRevision, key = 'k-' + randomUUID(), device = 'phone' } = {}) =>
	request(backend, workspaceId, {
		method: 'PUT',
		path: '/file',
		query: { path, mode },
		headers: {
			'idempotency-key': key,
			'x-log4stellar-device': device,
			...(baseRevision ? { 'x-log4stellar-base-revision': baseRevision } : {}),
		},
		body: bytes,
	});

const changes = (backend, workspaceId, query = {}) =>
	request(backend, workspaceId, { path: '/changes', query: Object.fromEntries(Object.entries(query).map(([k, v]) => [k, String(v)])) });

async function readAll(backend, path) {
	const handle = await backend.openRead(path);
	const chunks = [];
	for await (const chunk of await handle.stream()) {
		chunks.push(Buffer.from(chunk));
	}
	return Buffer.concat(chunks);
}

async function scenario(work) {
	const workspaceId = 'l4s-it-' + randomUUID().replace(/-/g, '').slice(0, 12);
	const pool = new Pool({ connectionTimeoutMillis: 5000, max: 4, ...settings.postgres });
	const seed = await mkdtemp(join(tmpdir(), 'l4s-demo-'));
	try {
		const importer = await openRustfsWorkspace(workspaceId, { importing: true, createBlobs: openDirectoryBlobs });
		await importer.importDirectory(seed, maxBytes);
		await importer.close();
		const backend = await openRustfsWorkspace(workspaceId, { createBlobs: openDirectoryBlobs });
		try {
			await work({ backend, pool, workspaceId });
		} finally {
			await backend.close();
		}
	} finally {
		await pool.query('DELETE FROM log4stellar.storage_snapshot_entries WHERE snapshot_id IN (SELECT id FROM log4stellar.storage_snapshots WHERE workspace_id = $1)', [workspaceId]);
		await pool.query('DELETE FROM log4stellar.storage_trash_entries WHERE trash_id IN (SELECT id FROM log4stellar.storage_trash WHERE workspace_id = $1)', [workspaceId]);
		for (const table of ['storage_snapshots', 'storage_changes', 'storage_change_heads', 'storage_trash', 'storage_file_versions', 'storage_entries']) {
			await pool.query(`DELETE FROM log4stellar.${table} WHERE workspace_id = $1`, [workspaceId]);
		}
		await pool.query('DELETE FROM log4stellar.storage_workspaces WHERE id = $1', [workspaceId]);
		await pool.end();
		await rm(seed, { recursive: true, force: true });
		await rm(join(spool, 'test-blobs', workspaceId), { recursive: true, force: true });
	}
}

// 1. Two devices edit the same file: both contents survive.
await scenario(async ({ backend, workspaceId }) => {
	head('1. 两个设备同时改同一文件时保留双方内容');
	const base = await upload(backend, workspaceId, '/a.md', Buffer.from('# base\n'), { device: 'desktop' });
	console.log('device A creates /a.md            ->', base.status, { seq: base.body.seq, revisionId: base.body.revisionId, sha256: base.body.sha256.slice(0, 12) });
	const a = await upload(backend, workspaceId, '/a.md', Buffer.from('# from device A\n'), { mode: 'save', baseRevision: base.body.revisionId, device: 'desktop' });
	console.log('device A saves from that revision ->', a.status, { seq: a.body.seq, revisionId: a.body.revisionId });
	const b = await upload(backend, workspaceId, '/a.md', Buffer.from('# from device B\n'), { mode: 'save', baseRevision: base.body.revisionId, device: 'tablet' });
	console.log('device B saves from the same one  ->', b.status, JSON.stringify({ error: b.body.error, conflictPath: b.body.conflictPath, currentRevision: b.body.currentRevision, seq: b.body.seq }));
	const original = await readAll(backend, '/a.md');
	const copy = await readAll(backend, b.body.conflictPath);
	console.log('/a.md          bytes:', JSON.stringify(original.toString()), 'sha256 ok:', sha(original) === sha(Buffer.from('# from device A\n')));
	console.log('conflict copy  bytes:', JSON.stringify(copy.toString()), 'sha256 ok:', sha(copy) === sha(Buffer.from('# from device B\n')));
	const stream = await changes(backend, workspaceId);
	console.log('change stream:  ', stream.body.changes.map(change => change.kind + ' ' + (change.conflictPath ?? change.path)).join(' | '));
	console.log('conflict listing:', JSON.stringify((await request(backend, workspaceId, { path: '/conflicts' })).body.conflicts.map(c => c.conflictPath)));
});

// 2. The same request retried produces exactly one logical change.
await scenario(async ({ backend, pool, workspaceId }) => {
	head('2. 同一请求重试只产生一次逻辑变更');
	const bytes = Buffer.from('idempotent payload');
	const key = 'retry-key-demo';
	const first = await upload(backend, workspaceId, '/a.md', bytes, { key, device: 'phone' });
	const second = await upload(backend, workspaceId, '/a.md', bytes, { key, device: 'phone' });
	console.log('first  ->', first.status, { seq: first.body.seq, changeId: first.body.changeId, revisionId: first.body.revisionId, replayed: first.body.replayed });
	console.log('retry  ->', second.status, { seq: second.body.seq, changeId: second.body.changeId, revisionId: second.body.revisionId, replayed: second.body.replayed });
	console.log('same seq/changeId/etag:', first.body.seq === second.body.seq && first.body.changeId === second.body.changeId && first.body.etag === second.body.etag);
	const counted = await pool.query('SELECT count(*)::int AS n FROM log4stellar.storage_changes WHERE workspace_id = $1 AND idempotency_key = $2', [workspaceId, key]);
	const versions = await pool.query('SELECT count(*)::int AS n FROM log4stellar.storage_file_versions WHERE workspace_id = $1', [workspaceId]);
	console.log('storage_changes rows with that key:', counted.rows[0].n, '| storage_file_versions rows:', versions.rows[0].n, '| stream length:', (await changes(backend, workspaceId)).body.changes.length);
	const other = await upload(backend, workspaceId, '/a.md', Buffer.from('different payload'), { key, device: 'phone' });
	console.log('same key, different body ->', other.status, other.body, '| content still:', JSON.stringify((await readAll(backend, '/a.md')).toString()));
});

// 3a. Offline device reconnects and catches up in one pull.
await scenario(async ({ backend, workspaceId }) => {
	head('3a. 断网重连：一次拉取补上中断期间的变更');
	await upload(backend, workspaceId, '/offline.md', Buffer.from('v1'));
	const pulled = await changes(backend, workspaceId);
	console.log('device A pulled to cursor seq =', pulled.body.toSeq, '(hasMore:', pulled.body.hasMore + ')');
	for (let index = 2; index <= 5; index += 1) {
		await upload(backend, workspaceId, '/offline.md', Buffer.from('v' + index), { mode: 'save', baseRevision: (await changes(backend, workspaceId)).body.changes.at(-1).revisionId });
	}
	console.log('server produced seqs ' + (pulled.body.toSeq + 1) + '..' + (await changes(backend, workspaceId)).body.head + ' while A was offline');
	const catchUp = await changes(backend, workspaceId, { cursor: pulled.body.cursor });
	console.log('reconnect with the held cursor ->', catchUp.status, 'seqs:', catchUp.body.changes.map(change => change.seq), 'hasMore:', catchUp.body.hasMore, 'head:', catchUp.body.head);
});

// 3b. Writes land while the client is paging.
await scenario(async ({ backend, workspaceId }) => {
	head('3b. 分页期间有写入：不重复、不跳过');
	await upload(backend, workspaceId, '/p.md', Buffer.from('0'));
	await upload(backend, workspaceId, '/p.md', Buffer.from('1'), { mode: 'save', baseRevision: (await changes(backend, workspaceId)).body.changes.at(-1).revisionId });
	await upload(backend, workspaceId, '/p.md', Buffer.from('2'), { mode: 'save', baseRevision: (await changes(backend, workspaceId)).body.changes.at(-1).revisionId });
	let page = await changes(backend, workspaceId, { limit: 2 });
	console.log('page 1 ->', page.body.changes.map(c => c.seq), 'hasMore:', page.body.hasMore);
	const base = (await changes(backend, workspaceId)).body.changes.at(-1).revisionId;
	await upload(backend, workspaceId, '/p.md', Buffer.from('3'), { mode: 'save', baseRevision: base });
	await upload(backend, workspaceId, '/p.md', Buffer.from('4'), { mode: 'save', baseRevision: (await changes(backend, workspaceId)).body.changes.at(-1).revisionId });
	console.log('a writer commits two more changes in between');
	const seen = [...page.body.changes.map(c => c.seq)];
	while (page.body.hasMore) {
		page = await changes(backend, workspaceId, { cursor: page.body.cursor, limit: 2 });
		seen.push(...page.body.changes.map(c => c.seq));
		console.log('next page ->', page.body.changes.map(c => c.seq), 'hasMore:', page.body.hasMore);
	}
	const finalHead = (await changes(backend, workspaceId)).body.head;
	console.log('collected seqs:', seen, '| no gaps/dups:', JSON.stringify(seen) === JSON.stringify(Array.from({ length: finalHead }, (_, i) => i + 1)));
});

// 3c. A cursor older than the retention floor forces a resync.
await scenario(async ({ backend, pool, workspaceId }) => {
	head('3c. 旧游标失效后重新同步');
	for (let index = 0; index < 8; index += 1) {
		await upload(backend, workspaceId, '/r.md', Buffer.from('r' + index), index === 0 ? {} : { mode: 'save', baseRevision: (await changes(backend, workspaceId)).body.changes.at(-1).revisionId });
	}
	const stale = (await changes(backend, workspaceId, { limit: 1 })).body.cursor;
	console.log('client holds a cursor at seq 1');
	const connection = await pool.connect();
	try {
		await connection.query('BEGIN');
		await connection.query('SELECT 1 FROM log4stellar.storage_workspaces WHERE id = $1 FOR UPDATE', [workspaceId]);
		const trimmed = await trimChanges(connection, workspaceId, { nowMs: Date.now() + syncRetention.changesTtlMs + 1 });
		await connection.query('COMMIT');
		console.log('retention trim ->', JSON.stringify(trimmed));
	} finally {
		connection.release();
	}
	const expired = await changes(backend, workspaceId, { cursor: stale });
	console.log('old cursor ->', expired.status, expired.body, '| partial results:', expired.body.changes === undefined ? 'none' : 'PRESENT (bug)');
	const snapshot = await request(backend, workspaceId, { method: 'POST', path: '/snapshot', body: {} });
	const recovered = await changes(backend, workspaceId, { cursor: snapshot.body.cursor });
	console.log('after POST /snapshot: seq =', snapshot.body.seq, 'entries =', snapshot.body.entryCount, '-> tail pull:', recovered.status, recovered.body.changes.length, 'changes, hasMore:', recovered.body.hasMore);
});

head('done');
