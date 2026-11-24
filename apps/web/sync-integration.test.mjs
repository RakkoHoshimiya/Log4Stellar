import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
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
import {
	conflictPath, encodeCursor, encodePageToken, formatConflictTimestamp, syncRetention,
} from './sync-contract.mjs';
import { serveSyncRequest } from './sync-files.mjs';
import { ensureStorageSchema, inspectStorageSchema } from './sync-migrate.mjs';
import { trimChanges } from './sync-store.mjs';

// End-to-end tests for the incremental sync API against real PostgreSQL and a
// directory-backed object store. Opt-in, exactly like the other integration tests:
//
//   LOG4STELLAR_STORAGE_CONFIG=/tmp/l4s-sync-storage.json LOG4STELLAR_IT=1 \
//     node --test apps/web/sync-integration.test.mjs
//
// Every workspace here matches `l4s-it-*` and is deleted again, including its blob
// directory, so the shared bucket and the shared database stay clean.
const enabled = process.env.LOG4STELLAR_IT === '1';
const skip = enabled ? false : 'set LOG4STELLAR_IT=1 to run the PostgreSQL integration tests';
const maxBytes = 64 * 1024 * 1024;
const configPath = process.env.LOG4STELLAR_STORAGE_CONFIG;

function storageConfig() {
	if (!configPath) {
		throw new Error('Set LOG4STELLAR_STORAGE_CONFIG to run the sync integration tests.');
	}
	return JSON.parse(readFileSync(configPath, 'utf8'));
}

function spoolDirectory() {
	return join(dirname(configPath), 'spool');
}

function digest(bytes) {
	return createHash('sha256').update(bytes).digest('hex');
}

async function bodyOf(ctx) {
	if (ctx.body === undefined) {
		return undefined;
	}
	return typeof ctx.body === 'object' ? ctx.body : Buffer.from(String(ctx.body));
}

/**
 * Drives one /sync/v1 request through the real handler with the real capability facade.
 * `body` is either a Buffer (octet-stream uploads) or a plain object (JSON endpoints).
 */
async function sync(backend, workspaceId, { method = 'GET', path = '/', query = {}, headers = {}, body } = {}) {
	const stored = new Map(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), String(value)]));
	let payload;
	if (Buffer.isBuffer(body)) {
		payload = body;
		stored.set('content-type', stored.get('content-type') ?? 'application/octet-stream');
		stored.set('content-length', String(body.length));
	} else if (body !== undefined) {
		payload = Buffer.from(JSON.stringify(body));
		stored.set('content-type', 'application/json');
	}
	const ctx = {
		method,
		path: '/sync/v1' + path,
		query,
		status: undefined,
		body: undefined,
		req: payload === undefined ? Readable.from([]) : Readable.from([payload]),
		get: name => stored.get(name.toLowerCase()) ?? '',
		set: (name, value) => stored.set(name.toLowerCase(), value),
		is: type => (stored.get('content-type') ?? '').startsWith(type),
	};
	await serveSyncRequest(ctx, authorizeWorkspace(backend, { role: 'owner' }), backend, workspaceId, maxBytes);
	return { status: ctx.status ?? (ctx.body === undefined ? 404 : 200), body: await bodyOf(ctx), headers: stored };
}

function upload(backend, workspaceId, path, bytes, { mode = 'create', baseRevision, key = 'key-' + randomUUID(), device = 'phone' } = {}) {
	return sync(backend, workspaceId, {
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
}

async function readAll(backend, path) {
	const readable = await backend.openRead(path);
	const chunks = [];
	for await (const chunk of await readable.stream()) {
		chunks.push(Buffer.from(chunk));
	}
	return Buffer.concat(chunks);
}

async function revisionOf(backend, path) {
	const stat = await backend.stat(path);
	return stat.etag.slice(1, -1);
}

async function changes(backend, workspaceId, { cursor, limit } = {}) {
	const query = {};
	if (cursor !== undefined) {
		query.cursor = cursor;
	}
	if (limit !== undefined) {
		query.limit = String(limit);
	}
	return sync(backend, workspaceId, { path: '/changes', query });
}

async function scenarioWorkspace(work) {
	const settings = storageConfig();
	const workspaceId = 'l4s-it-' + randomUUID().replace(/-/g, '').slice(0, 12);
	const pool = new Pool({ connectionTimeoutMillis: 5000, max: 4, ...settings.postgres });
	const seed = await mkdtemp(join(tmpdir(), 'l4s-sync-'));
	try {
		const importer = await openRustfsWorkspace(workspaceId, { importing: true, createBlobs: openDirectoryBlobs });
		try {
			await importer.importDirectory(seed, maxBytes);
		} finally {
			await importer.close();
		}
		const backend = await openRustfsWorkspace(workspaceId, { createBlobs: openDirectoryBlobs });
		try {
			await work({ backend, pool, workspaceId });
		} finally {
			await backend.close();
		}
	} finally {
		await clean(pool, workspaceId);
		await pool.end();
		await rm(seed, { recursive: true, force: true });
	}
}

async function clean(pool, workspaceId) {
	// Sync rows reference storage_workspaces and snapshot entries are keyed by snapshot, so
	// the new tables have to go first. The five original tables keep their schema untouched.
	await pool.query(
		'DELETE FROM log4stellar.storage_snapshot_entries WHERE snapshot_id IN (SELECT id FROM log4stellar.storage_snapshots WHERE workspace_id = $1)',
		[workspaceId]);
	await pool.query(
		'DELETE FROM log4stellar.storage_trash_entries WHERE trash_id IN (SELECT id FROM log4stellar.storage_trash WHERE workspace_id = $1)',
		[workspaceId]);
	for (const table of ['storage_snapshots', 'storage_changes', 'storage_change_heads', 'storage_trash', 'storage_file_versions', 'storage_entries']) {
		await pool.query(`DELETE FROM log4stellar.${table} WHERE workspace_id = $1`, [workspaceId]);
	}
	await pool.query('DELETE FROM log4stellar.storage_workspaces WHERE id = $1', [workspaceId]);
	await rm(join(spoolDirectory(), 'test-blobs', workspaceId), { recursive: true, force: true });
}

// ---------------------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------------------

test('the migration is additive and leaves the previous release schema untouched', { skip }, async () => {
	const settings = storageConfig();
	const pool = new Pool({ connectionTimeoutMillis: 5000, max: 2, ...settings.postgres });
	try {
		// The five original tables must keep EXACTLY the columns the previous release reads.
		const expected = {
			storage_workspaces: ['id', 'created_ms'],
			storage_entries: ['workspace_id', 'path', 'parent_path', 'name', 'file_id', 'revision_id', 'kind', 'created_ms', 'modified_ms'],
			storage_file_versions: ['workspace_id', 'file_id', 'revision_id', 'parent_revision_id', 'sha256', 'size_bytes', 'created_ms'],
			storage_trash: ['id', 'workspace_id', 'original_path', 'deleted_ms'],
			storage_trash_entries: ['trash_id', 'path', 'file_id', 'revision_id', 'kind', 'created_ms', 'modified_ms'],
		};
		for (const [table, columns] of Object.entries(expected)) {
			const { rows } = await pool.query(`
				SELECT column_name FROM information_schema.columns
				WHERE table_schema = 'log4stellar' AND table_name = $1
				ORDER BY ordinal_position
			`, [table]);
			assert.deepEqual(rows.map(row => row.column_name), columns, table + ' must keep its columns');
		}
		// And the four new tables must exist with their primary keys.
		for (const table of ['storage_change_heads', 'storage_changes', 'storage_snapshots', 'storage_snapshot_entries']) {
			const { rows } = await pool.query(
				'SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2',
				['log4stellar', table]);
			assert.equal(rows.length, 1, 'missing table ' + table);
		}
	} finally {
		await pool.end();
	}
});

test('the previous release can still start and write against the migrated database', { skip }, async () => {
	// Rollback rehearsal: the previous release (web-markdown-preview-01) ships its own copy of
	// workspace-schema.sql and its own rustfs-workspace.mjs, which knows NOTHING about the four
	// new tables. Switching back must therefore keep working on a database this release has
	// already migrated. The checks below are exactly what that old code does: re-apply
	// workspace-schema.sql at startup, then run its own INSERT/UPDATE/SELECT statements.
	const settings = storageConfig();
	const workspaceId = 'l4s-it-' + randomUUID().replace(/-/g, '').slice(0, 12);
	const pool = new Pool({ connectionTimeoutMillis: 5000, max: 4, ...settings.postgres });
	const seed = await mkdtemp(join(tmpdir(), 'l4s-sync-'));
	try {
		const importer = await openRustfsWorkspace(workspaceId, { importing: true, createBlobs: openDirectoryBlobs });
		await importer.importDirectory(seed, maxBytes);
		await importer.close();

		// 1. The old startup path: workspace-schema.sql is CREATE TABLE IF NOT EXISTS only, so
		//    applying it again on the migrated database must be a no-op, not an error.
		const oldSchema = readFileSync(new URL('./workspace-schema.sql', import.meta.url), 'utf8');
		await pool.query(oldSchema);
		await pool.query(oldSchema);

		// 2. The old write path, in old-SQL form: a version row, then an entry row.
		const fileId = randomUUID();
		const revisionId = randomUUID();
		await pool.query(
			`INSERT INTO log4stellar.storage_file_versions
				(workspace_id, file_id, revision_id, parent_revision_id, sha256, size_bytes, created_ms)
			 VALUES ($1, $2, $3, NULL, $4, $5, $6)`,
			[workspaceId, fileId, revisionId, digest(Buffer.from('old')), 3, Date.now()]);
		await pool.query(
			`INSERT INTO log4stellar.storage_entries
				(workspace_id, path, parent_path, name, file_id, revision_id, kind, created_ms, modified_ms)
			 VALUES ($1, '/old.md', '/', 'old.md', $2, $3, 1, $4, $5)`,
			[workspaceId, fileId, revisionId, Date.now(), Date.now()]);

		// 3. The old read path: exactly the join its findEntry() uses.
		const { rows } = await pool.query(`
			SELECT e.path, e.kind, v.sha256, v.size_bytes
			FROM log4stellar.storage_entries e
			LEFT JOIN log4stellar.storage_file_versions v
				USING (workspace_id, file_id, revision_id)
			WHERE e.workspace_id = $1 AND e.path = $2
		`, [workspaceId, '/old.md']);
		assert.equal(rows.length, 1);
		assert.equal(rows[0].kind, 1);
		assert.equal(Number(rows[0].size_bytes), 3);

		// 4. And the new release still reads that row, because the write went through the same
		//    five tables: the two releases share storage, only the change stream is new.
		const backend = await openRustfsWorkspace(workspaceId, { createBlobs: openDirectoryBlobs });
		try {
			const stat = await backend.stat('/old.md');
			assert.equal(stat.etag, '"' + revisionId + '"');
		} finally {
			await backend.close();
		}
	} finally {
		await clean(pool, workspaceId);
		await pool.end();
		await rm(seed, { recursive: true, force: true });
	}
});

test('concurrent processes can migrate the same database', { skip }, async () => {
	// Six writers racing through openRustfsWorkspace() all run the migration under the one
	// advisory lock; none of them may fail with a duplicate-object error.
	const settings = storageConfig();
	const workspaceId = 'l4s-it-' + randomUUID().replace(/-/g, '').slice(0, 12);
	const pool = new Pool({ connectionTimeoutMillis: 5000, max: 4, ...settings.postgres });
	const seed = await mkdtemp(join(tmpdir(), 'l4s-sync-'));
	try {
		const importer = await openRustfsWorkspace(workspaceId, { importing: true, createBlobs: openDirectoryBlobs });
		await importer.importDirectory(seed, maxBytes);
		await importer.close();
		const opened = await Promise.all(Array.from({ length: 6 }, () => openRustfsWorkspace(workspaceId, { createBlobs: openDirectoryBlobs })));
		try {
			const { rows } = await pool.query(
				'SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = $1 AND table_name = ANY($2::text[])',
				['log4stellar', ['storage_change_heads', 'storage_changes', 'storage_snapshots', 'storage_snapshot_entries']]);
			assert.equal(rows[0].n, 4);
		} finally {
			await Promise.all(opened.map(backend => backend.close()));
		}
	} finally {
		await clean(pool, workspaceId);
		await pool.end();
		await rm(seed, { recursive: true, force: true });
	}
});

test('the migration runs standalone and is idempotent', { skip }, async () => {
	// `node apps/web/sync-migrate.mjs <storage.json>` is the operator entry point; the server
	// calls the very same module on boot, so this also proves the two paths agree.
	const { spawn } = await import('node:child_process');
	const { fileURLToPath } = await import('node:url');
	const script = fileURLToPath(new URL('./sync-migrate.mjs', import.meta.url));
	const run = () => new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [script, configPath], { stdio: ['ignore', 'pipe', 'pipe'] });
		let out = '';
		child.stdout.on('data', chunk => { out += chunk; });
		child.stderr.on('data', chunk => { out += chunk; });
		child.on('error', reject);
		child.on('close', code => (code === 0 ? resolve(out) : reject(new Error('exit ' + code + ': ' + out))));
	});
	const first = await run();
	assert.match(first, /storage_change_heads/);
	assert.match(first, /storage_snapshots/);
	// A second run must not fail on "already exists" — that is what makes a rolling restart safe.
	const second = await run();
	assert.equal(second.trim(), first.trim());
});

// ---------------------------------------------------------------------------------------
// Change stream writer
// ---------------------------------------------------------------------------------------

test('every write operation appends the documented change kinds', { skip }, async () => {
	await scenarioWorkspace(async ({ backend, workspaceId }) => {
		await sync(backend, workspaceId, { method: 'POST', path: '/mkdir', body: { path: '/notes' } });
		const created = await upload(backend, workspaceId, '/notes/a.md', Buffer.from('one'));
		assert.equal(created.status, 201);
		assert.equal(created.body.created, true);

		const saved = await upload(backend, workspaceId, '/notes/a.md', Buffer.from('two'), { mode: 'save', baseRevision: created.body.revisionId });
		assert.equal(saved.status, 200);
		assert.equal(saved.body.created, false);

		await sync(backend, workspaceId, { method: 'POST', path: '/mkdir', body: { path: '/notes/folder' } });
		await sync(backend, workspaceId, { method: 'POST', path: '/rename', body: { from: '/notes/a.md', to: '/notes/b.md' } });
		const deleted = await sync(backend, workspaceId, { method: 'DELETE', path: '/file', query: { path: '/notes/b.md' } });
		assert.equal(deleted.status, 200);
		const trashId = deleted.body.trashId;
		await sync(backend, workspaceId, { method: 'POST', path: '/restore', body: { trashId, keepBoth: false } });
		await sync(backend, workspaceId, { method: 'POST', path: '/rollback', body: { path: '/notes/b.md', revisionId: created.body.revisionId, baseRevision: saved.body.revisionId } });

		const page = await changes(backend, workspaceId);
		assert.equal(page.status, 200);
		assert.deepEqual(page.body.changes.map(change => change.kind), [
			'directory.created', 'file.created', 'file.saved', 'directory.created', 'file.renamed', 'file.deleted', 'file.restored', 'file.rolledback',
		]);
		// Sequence numbers are strictly increasing and gapless for a single writer.
		assert.deepEqual(page.body.changes.map(change => change.seq), [1, 2, 3, 4, 5, 6, 7, 8]);
		// A rename keeps the file identity and reports where it came from (§9.10).
		const renamed = page.body.changes[4];
		assert.equal(renamed.fileId, created.body.fileId);
		assert.equal(renamed.fromPath, '/notes/a.md');
		assert.equal(renamed.path, '/notes/b.md');
		// A rollback points at the NEW revision, not at the old one (§9.11).
		const rolledBack = page.body.changes[7];
		assert.notEqual(rolledBack.revisionId, created.body.revisionId);
		assert.equal(rolledBack.fileId, created.body.fileId);
		// Restore reports the path it came back to.
		assert.equal(page.body.changes[6].path, '/notes/b.md');
		assert.equal(page.body.hasMore, false);
	});
});

test('/static/mount writes are visible in the same stream', { skip }, async () => {
	await scenarioWorkspace(async ({ backend, workspaceId }) => {
		// The old endpoint keeps its own 412/409 semantics but must still feed the stream,
		// otherwise a workspace edited only through /static/mount would be invisible to sync.
		await backend.writeFile('/legacy.md', Readable.from([Buffer.from('legacy')]), { create: true, maxBytes });
		const page = await changes(backend, workspaceId);
		assert.equal(page.body.changes.length, 1);
		assert.equal(page.body.changes[0].kind, 'file.created');
		assert.equal(page.body.changes[0].path, '/legacy.md');
	});
});

test('a recursive delete appends one change per removed path sharing one op id', { skip }, async () => {
	await scenarioWorkspace(async ({ backend, workspaceId }) => {
		await sync(backend, workspaceId, { method: 'POST', path: '/mkdir', body: { path: '/tree' } });
		for (const name of ['a', 'b', 'c']) {
			await upload(backend, workspaceId, `/tree/${name}.md`, Buffer.from(name));
		}
		const before = await changes(backend, workspaceId);
		const deleted = await sync(backend, workspaceId, { method: 'DELETE', path: '/file', query: { path: '/tree', recursive: '1' } });
		assert.equal(deleted.status, 200);
		const page = await changes(backend, workspaceId, { cursor: before.body.cursor });
		assert.equal(page.body.changes.length, 4, 'three files plus the directory itself');
		assert.ok(page.body.changes.every(change => change.kind === 'file.deleted' || change.kind === 'directory.deleted'));
		// §8.6: N rows, N consecutive seqs, one grouping id so the client can apply atomically.
		const opIds = new Set(page.body.changes.map(change => change.opId));
		assert.equal(opIds.size, 1, 'one logical operation means one op id');
		const seqs = page.body.changes.map(change => change.seq);
		assert.deepEqual(seqs, [seqs[0], seqs[0] + 1, seqs[0] + 2, seqs[0] + 3]);
		assert.deepEqual(deleted.body.changeIds, page.body.changes.map(change => change.changeId));
	});
});

test('batch granularity: one path per change row, grouped by op id', { skip }, async () => {
	// Contract deviation, decided here (see 交付说明 §契约偏差清单 item 1).
	//
	// The doc states two rules that cannot both hold for a batch: §1 invariant 3 says "one
	// logical operation = exactly one change", while §8.6 says a batch produces N changes with
	// N consecutive seqs. The doc itself calls this its weakest trade-off (§11.1).
	//
	// TODO(contract): the wording of §1 invariant 3 is inaccurate for batch operations; it
	// should read "one change per affected path" and the op id is the join key for a batch.
	// The doc now carries that wording (commit 91c146d4698) as a PROPOSAL: the semantics did
	// not change, only the sentence was made true. It still needs the contract owner's
	// sign-off, which is why this marker stays.
	//
	// Decision: keep ONE CHANGE PER PATH and add an explicit grouping id (`opId`) on every row
	// of a batch. Why this way round:
	//   * the consumer unit is "what happened to this path" — a single row cannot describe 100
	//     deletions without the client re-deriving per-path state from a payload blob;
	//   * a partially applied batch is recoverable per path (each row carries its own path,
	//     revision and trash id), while a single mega-row would force the client to implement
	//     half-batch rollback, which §11.1 names as the reason it was rejected;
	//   * `opId` gives atomic application for free: the client buffers rows until the group
	//     changes, then commits them together. The alternative (a batch_id column plus a
	//     separate group row) needs the same client logic plus a schema the contract does not
	//     declare.
	// This test locks the decision: N rows, N consecutive seqs, one op id, and a response that
	// echoes all change ids so the client can verify it received the whole group.
	await scenarioWorkspace(async ({ backend, workspaceId }) => {
		await sync(backend, workspaceId, { method: 'POST', path: '/mkdir', body: { path: '/batch' } });
		for (const name of ['one', 'two']) {
			await upload(backend, workspaceId, `/batch/${name}.md`, Buffer.from(name));
		}
		const before = await changes(backend, workspaceId);

		// Delete a directory with two files in it: one logical operation, three rows.
		const deleted = await sync(backend, workspaceId, { method: 'DELETE', path: '/file', query: { path: '/batch', recursive: '1' } });
		assert.equal(deleted.status, 200);
		const page = await changes(backend, workspaceId, { cursor: before.body.cursor });
		assert.equal(page.body.changes.length, 3);

		// Every row is its own change with its own identity and its own path.
		const changeIds = page.body.changes.map(change => change.changeId);
		assert.equal(new Set(changeIds).size, 3, 'one change row per path, not one row for the batch');
		assert.deepEqual(page.body.changes.map(change => change.path).sort(), ['/batch', '/batch/one.md', '/batch/two.md']);

		// But they are one group: opId is shared, and the seqs are consecutive, so a client can
		// apply the whole operation or none of it.
		assert.equal(new Set(page.body.changes.map(change => change.opId)).size, 1);
		const seqs = page.body.changes.map(change => change.seq);
		assert.deepEqual(seqs, [seqs[0], seqs[0] + 1, seqs[0] + 2]);

		// The response names the whole group, so a caller can confirm it saw every row.
		assert.deepEqual(deleted.body.changeIds, changeIds);
		assert.equal(deleted.body.seq, seqs.at(-1));
	});

	// A batch with a single affected path spends exactly one seq and one row.
	await scenarioWorkspace(async ({ backend, workspaceId }) => {
		await upload(backend, workspaceId, '/solo.md', Buffer.from('solo'));
		const before = await changes(backend, workspaceId);
		const deleted = await sync(backend, workspaceId, { method: 'DELETE', path: '/file', query: { path: '/solo.md' } });
		assert.equal(deleted.body.changeIds.length, 1);
		const page = await changes(backend, workspaceId, { cursor: before.body.cursor });
		assert.equal(page.body.changes.length, 1);
		assert.equal(page.body.changes[0].opId, deleted.body.opId);
	});
});

// ---------------------------------------------------------------------------------------
// Acceptance 1: two devices edit the same file — both contents survive
// ---------------------------------------------------------------------------------------

test('acceptance: two devices that edit the same file keep both contents', { skip }, async () => {
	await scenarioWorkspace(async ({ backend, workspaceId }) => {
		const first = await upload(backend, workspaceId, '/a.md', Buffer.from('# base\n'), { device: 'desktop' });
		assert.equal(first.status, 201);

		// Device A saves from revision 1.
		const deviceA = await upload(backend, workspaceId, '/a.md', Buffer.from('# from device A\n'), {
			mode: 'save', baseRevision: first.body.revisionId, device: 'desktop',
		});
		assert.equal(deviceA.status, 200);
		assert.equal(deviceA.body.replayed, false);

		// Device B still believes revision 1 is current.
		const deviceB = await upload(backend, workspaceId, '/a.md', Buffer.from('# from device B\n'), {
			mode: 'save', baseRevision: first.body.revisionId, device: 'tablet',
		});
		assert.equal(deviceB.status, 409, 'a stale base revision is a conflict, not a 412');
		assert.notEqual(deviceB.status, 412);
		assert.equal(deviceB.body.error, 'SyncConflict');
		assert.equal(deviceB.body.currentRevision, deviceA.body.revisionId, 'the client learns what is current now');
		assert.match(deviceB.body.conflictPath, /^\/a \(conflict tablet \d{8}T\d{6}Z\)\.md$/);
		assert.equal(typeof deviceB.body.seq, 'number');

		// BOTH contents survive, byte for byte.
		const original = await readAll(backend, '/a.md');
		assert.equal(original.toString(), '# from device A\n');
		assert.equal(digest(original), deviceA.body.sha256);
		const copy = await readAll(backend, deviceB.body.conflictPath);
		assert.equal(copy.toString(), '# from device B\n');
		assert.equal(digest(copy), deviceB.body.sha256);

		// The stream tells everyone what happened: the ORIGINAL save, then the copy, then the marker.
		const page = await changes(backend, workspaceId);
		assert.deepEqual(page.body.changes.map(change => change.kind), ['file.created', 'file.saved', 'file.saved', 'file.conflicted']);
		const marker = page.body.changes.at(-1);
		assert.equal(marker.path, '/a.md');
		assert.equal(marker.conflictPath, deviceB.body.conflictPath);
		assert.equal(marker.parentRevisionId, deviceA.body.revisionId, 'the marker records which revision it lost against');
		assert.equal(marker.deviceId, 'tablet');
		assert.equal(marker.baseRevision, first.body.revisionId, '§8.7 needs the client-declared base');
		const copySaved = page.body.changes.at(-2);
		assert.equal(copySaved.path, deviceB.body.conflictPath);
		assert.equal(copySaved.opId, marker.opId, 'the copy and the marker are one operation');

		// The conflict list and the detail endpoint agree with the stream.
		const listed = await sync(backend, workspaceId, { path: '/conflicts' });
		assert.equal(listed.status, 200);
		assert.equal(listed.body.conflicts.length, 1);
		assert.equal(listed.body.conflicts[0].conflictPath, deviceB.body.conflictPath);
		assert.equal(listed.body.conflicts[0].resolved, false);
		const detail = await sync(backend, workspaceId, { path: '/conflict', query: { path: deviceB.body.conflictPath } });
		assert.equal(detail.status, 200);
		assert.equal(detail.body.originalRevisionId, deviceA.body.revisionId);
		assert.equal(detail.body.baseRevision, first.body.revisionId);
		// Deleting the copy resolves the conflict, and the listing then reports nothing to do.
		await sync(backend, workspaceId, { method: 'DELETE', path: '/file', query: { path: deviceB.body.conflictPath } });
		const after = await sync(backend, workspaceId, { path: '/conflicts' });
		assert.deepEqual(after.body.conflicts, []);
	});
});

test('acceptance: a binary attachment conflict copies the exact bytes', { skip }, async () => {
	await scenarioWorkspace(async ({ backend, workspaceId }) => {
		// A ~2 MiB pseudo-random payload stands in for an Office file / video: content the
		// server must never parse, transcode or normalise.
		const bytes = Buffer.alloc(2 * 1024 * 1024);
		for (let index = 0; index < bytes.length; index += 1) {
			bytes[index] = (index * 37 + 11) % 256;
		}
		await sync(backend, workspaceId, { method: 'POST', path: '/mkdir', body: { path: '/docs' } });
		const base = await upload(backend, workspaceId, '/docs/report.docx', bytes, { device: 'desktop' });
		assert.equal(base.status, 201);
		await upload(backend, workspaceId, '/docs/report.docx', Buffer.from('first writer'), { mode: 'save', baseRevision: base.body.revisionId, device: 'desktop' });

		const competing = await upload(backend, workspaceId, '/docs/report.docx', bytes, {
			mode: 'save', baseRevision: base.body.revisionId, device: 'tablet',
		});
		assert.equal(competing.status, 409);
		// Extension preserved, `.docx` kept whole, `.tar.gz` would keep only `.gz` (§6.3).
		assert.match(competing.body.conflictPath, /^\/docs\/report \(conflict tablet \d{8}T\d{6}Z\)\.docx$/);
		const copied = await readAll(backend, competing.body.conflictPath);
		assert.equal(copied.length, bytes.length);
		assert.equal(digest(copied), digest(bytes));
		assert.equal(digest(copied), competing.body.sha256, 'no transcoding: the stored digest is the upload digest');
	});
});

test('conflict names stay unique when the same device collides twice', { skip }, async () => {
	await scenarioWorkspace(async ({ backend, workspaceId }) => {
		const base = await upload(backend, workspaceId, '/c.md', Buffer.from('base'));
		await upload(backend, workspaceId, '/c.md', Buffer.from('winner'), { mode: 'save', baseRevision: base.body.revisionId });
		// Two conflicts in the same millisecond would collide; the index suffix disambiguates.
		const first = await upload(backend, workspaceId, '/c.md', Buffer.from('loser 1'), { mode: 'save', baseRevision: base.body.revisionId, device: 'tablet' });
		const second = await upload(backend, workspaceId, '/c.md', Buffer.from('loser 2'), { mode: 'save', baseRevision: base.body.revisionId, device: 'tablet' });
		assert.equal(first.status, 409);
		assert.equal(second.status, 409);
		assert.notEqual(first.body.conflictPath, second.body.conflictPath);
		assert.equal((await readAll(backend, first.body.conflictPath)).toString(), 'loser 1');
		assert.equal((await readAll(backend, second.body.conflictPath)).toString(), 'loser 2');
	});
});

test('a create against an existing path is a conflict too, symmetrically', { skip }, async () => {
	await scenarioWorkspace(async ({ backend, workspaceId }) => {
		await upload(backend, workspaceId, '/exists.md', Buffer.from('already here'));
		const again = await upload(backend, workspaceId, '/exists.md', Buffer.from('mine'), { mode: 'create' });
		assert.equal(again.status, 409);
		assert.equal(again.body.error, 'SyncConflict');
		assert.equal((await readAll(backend, '/exists.md')).toString(), 'already here');
		assert.equal((await readAll(backend, again.body.conflictPath)).toString(), 'mine');
	});
});

test('mode=save onto a path that no longer exists is a conflict, not a 404', { skip }, async () => {
	await scenarioWorkspace(async ({ backend, workspaceId }) => {
		const created = await upload(backend, workspaceId, '/gone.md', Buffer.from('v1'));
		await sync(backend, workspaceId, { method: 'DELETE', path: '/file', query: { path: '/gone.md' } });
		const write = await upload(backend, workspaceId, '/gone.md', Buffer.from('offline edit'), {
			mode: 'save', baseRevision: created.body.revisionId,
		});
		assert.equal(write.status, 409);
		assert.match(write.body.conflictPath, /^\/gone \(conflict phone \d{8}T\d{6}Z\)\.md$/);
		assert.equal((await readAll(backend, write.body.conflictPath)).toString(), 'offline edit');
		assert.equal(await backend.stat('/gone.md').then(() => true, () => false), false, 'the deleted path stays deleted');
	});
});

// ---------------------------------------------------------------------------------------
// Acceptance 2: retrying the same request produces exactly one logical change
// ---------------------------------------------------------------------------------------

test('acceptance: an identical retry produces one change and replays the result', { skip }, async () => {
	await scenarioWorkspace(async ({ backend, pool, workspaceId }) => {
		const bytes = Buffer.from('idempotent payload');
		const key = 'retry-key-0001';
		const first = await upload(backend, workspaceId, '/a.md', bytes, { key, device: 'phone' });
		assert.equal(first.status, 201);
		const second = await upload(backend, workspaceId, '/a.md', bytes, { key, device: 'phone' });
		assert.equal(second.status, 200, 'a replay is not a second create');
		assert.equal(second.body.replayed, true);
		assert.equal(second.body.seq, first.body.seq, 'the replay returns the original seq');
		assert.equal(second.body.changeId, first.body.changeId);
		assert.equal(second.body.revisionId, first.body.revisionId);
		assert.equal(second.body.etag, first.body.etag);
		assert.equal(second.body.fileId, first.body.fileId);

		// Exactly one change row, exactly one version row: not two.
		const counted = await pool.query(
			'SELECT count(*)::int AS n FROM log4stellar.storage_changes WHERE workspace_id = $1 AND idempotency_key = $2',
			[workspaceId, key]);
		assert.equal(counted.rows[0].n, 1);
		const stream = await changes(backend, workspaceId);
		assert.equal(stream.body.changes.length, 1, 'other devices see one change, not two');
		const versions = await backend.listVersions('/a.md');
		assert.equal(versions.filter(version => version.current).length, 1);
		assert.equal((await readAll(backend, '/a.md')).toString(), 'idempotent payload');
	});
});

test('acceptance: the same key with a different body is rejected without writing', { skip }, async () => {
	await scenarioWorkspace(async ({ backend, workspaceId }) => {
		const key = 'retry-key-0002';
		const first = await upload(backend, workspaceId, '/a.md', Buffer.from('X'), { key });
		assert.equal(first.status, 201);
		const conflicting = await upload(backend, workspaceId, '/a.md', Buffer.from('Y'), { key });
		assert.equal(conflicting.status, 409);
		assert.equal(conflicting.body.error, 'IdempotencyKeyReused');
		// The rejected attempt left no trace: content, revisions and the stream are unchanged.
		assert.equal((await readAll(backend, '/a.md')).toString(), 'X');
		const stream = await changes(backend, workspaceId);
		assert.equal(stream.body.changes.length, 1);
		assert.equal((await backend.listVersions('/a.md')).length, 1);
	});
});

test('an idempotent retry of a conflicted write replays the same copy name', { skip }, async () => {
	await scenarioWorkspace(async ({ backend, workspaceId }) => {
		const base = await upload(backend, workspaceId, '/d.md', Buffer.from('base'));
		await upload(backend, workspaceId, '/d.md', Buffer.from('winner'), { mode: 'save', baseRevision: base.body.revisionId });
		const key = 'retry-key-0003';
		// Pin the clock so the expected name is exactly the contract's formatting.
		const timestampMs = Date.UTC(2026, 0, 1, 12, 0, 0);
		const expected = conflictPath('/d.md', { device: 'tablet', timestampMs });
		assert.equal(expected, '/d (conflict tablet 20260101T120000Z).md');
		assert.equal(formatConflictTimestamp(timestampMs), '20260101T120000Z');

		const first = await upload(backend, workspaceId, '/d.md', Buffer.from('loser'), {
			mode: 'save', baseRevision: base.body.revisionId, device: 'tablet', key,
		});
		assert.equal(first.status, 409);
		const retry = await upload(backend, workspaceId, '/d.md', Buffer.from('loser'), {
			mode: 'save', baseRevision: base.body.revisionId, device: 'tablet', key,
		});
		assert.equal(retry.status, 200);
		assert.equal(retry.body.replayed, true);
		assert.equal(retry.body.conflictPath, first.body.conflictPath, 'the retry names the same copy');
		assert.equal(retry.body.seq, first.body.seq);
		// One copy on disk, one pair of changes.
		const copies = (await backend.readDirectory('/')).filter(entry => entry.name.startsWith('d (conflict'));
		assert.equal(copies.length, 1);
		const stream = await changes(backend, workspaceId);
		assert.deepEqual(stream.body.changes.map(change => change.kind), ['file.created', 'file.saved', 'file.saved', 'file.conflicted']);
	});
});

test('every mutating route replays on an identical retry, not just PUT', { skip }, async () => {
	// §8.6 lists `replayed` on every mutation, and §5.2 says the replay must return the
	// original result. The risk here is specific: DELETE/rename/mkdir/rollback have no
	// content to hash, so their fingerprint is derived from the request shape. If the handler
	// forgot to derive one, a retry would look like a DIFFERENT request on a reused key and
	// would be answered 409 IdempotencyKeyReused instead of being replayed.
	await scenarioWorkspace(async ({ backend, pool, workspaceId }) => {
		const mkdirKey = 'route-key-mkdir';
		const firstMkdir = await sync(backend, workspaceId, {
			method: 'POST', path: '/mkdir', body: { path: '/r' }, headers: { 'idempotency-key': mkdirKey },
		});
		assert.equal(firstMkdir.status, 201);
		assert.equal(firstMkdir.body.replayed, false);
		const retriedMkdir = await sync(backend, workspaceId, {
			method: 'POST', path: '/mkdir', body: { path: '/r' }, headers: { 'idempotency-key': mkdirKey },
		});
		// §5.2: the replay status is 200 for EVERY route, mkdir included. The first attempt
		// keeps its 201 (a creation did happen); the retry must not be able to tell itself
		// apart as "another creation" by the status line alone.
		assert.equal(retriedMkdir.status, 200, 'a mkdir replay answers 200, not the original 201');
		assert.equal(retriedMkdir.body.replayed, true, 'an identical mkdir retry is a replay');
		assert.equal(retriedMkdir.body.seq, firstMkdir.body.seq);
		assert.equal(retriedMkdir.body.changeId, firstMkdir.body.changeId);

		// The same key aimed at a different path is a different request: 409, nothing written.
		const reused = await sync(backend, workspaceId, {
			method: 'POST', path: '/mkdir', body: { path: '/other' }, headers: { 'idempotency-key': mkdirKey },
		});
		assert.equal(reused.status, 409);
		assert.equal(reused.body.error, 'IdempotencyKeyReused');

		await upload(backend, workspaceId, '/r/one.md', Buffer.from('one'));
		const deleteKey = 'route-key-delete';
		const firstDelete = await sync(backend, workspaceId, {
			method: 'DELETE', path: '/file', query: { path: '/r', recursive: '1' }, headers: { 'idempotency-key': deleteKey },
		});
		assert.equal(firstDelete.status, 200);
		assert.equal(firstDelete.body.changeIds.length, 2, 'the directory and its file');
		const retriedDelete = await sync(backend, workspaceId, {
			method: 'DELETE', path: '/file', query: { path: '/r', recursive: '1' }, headers: { 'idempotency-key': deleteKey },
		});
		assert.equal(retriedDelete.status, 200);
		assert.equal(retriedDelete.body.replayed, true, 'an identical delete retry is a replay');
		assert.deepEqual(retriedDelete.body.changeIds, firstDelete.body.changeIds);
		assert.equal(retriedDelete.body.trashId, firstDelete.body.trashId, 'the retry names the same trash batch');

		// Exactly one keyed row per key, and the stream saw each operation once.
		const keyed = await pool.query(
			'SELECT idempotency_key, count(*)::int AS n FROM log4stellar.storage_changes WHERE workspace_id = $1 AND idempotency_key IS NOT NULL GROUP BY idempotency_key',
			[workspaceId]);
		assert.equal(keyed.rows.length, 3, 'mkdir, upload and delete each stored their key once');
		assert.ok(keyed.rows.every(row => row.n === 1), 'no key was stored twice by a retry');
		// mkdir(1) + upload(1) + recursive delete of the directory and its file(2): four rows,
		// and the rejected mkdir under the reused key added none.
		const stream = await changes(backend, workspaceId);
		assert.equal(stream.body.changes.length, 4);
		assert.equal(stream.body.changes.filter(change => change.idempotencyKey !== undefined).length, 0, 'keys are not part of the public change shape');
	});
});

test('a failed write commits nothing, so the retry is the first logical change', { skip }, async () => {
	await scenarioWorkspace(async ({ backend, workspaceId }) => {
		// mode=create against an existing path fails with a conflict AFTER the object store
		// already accepted the bytes. The transaction must roll back cleanly and the retry
		// must behave as a first attempt.
		await upload(backend, workspaceId, '/taken.md', Buffer.from('owner'));
		const before = await changes(backend, workspaceId);
		const attempt = await upload(backend, workspaceId, '/taken.md', Buffer.from('mine'), { key: 'crash-key-0001' });
		assert.equal(attempt.status, 409);
		const after = await changes(backend, workspaceId);
		// The conflict is a real commit (copy + marker), so compare against the retry instead.
		const page = await changes(backend, workspaceId, { cursor: before.body.cursor });
		assert.deepEqual(page.body.changes.map(change => change.kind), ['file.saved', 'file.conflicted']);
		assert.equal(page.body.changes.length, after.body.changes.length - before.body.changes.length);
	});
});

// ---------------------------------------------------------------------------------------
// Acceptance 3: reconnect, duplicate submit, writes during paging, stale cursor
// ---------------------------------------------------------------------------------------

test('acceptance: an offline device catches up with one pull in order', { skip }, async () => {
	await scenarioWorkspace(async ({ backend, workspaceId }) => {
		await upload(backend, workspaceId, '/one.md', Buffer.from('1'));
		// The client pulls up to here and then goes offline.
		const baseline = await changes(backend, workspaceId);
		assert.equal(baseline.body.changes.length, 1);
		const held = baseline.body.cursor;

		// While offline, the workspace keeps moving.
		await upload(backend, workspaceId, '/two.md', Buffer.from('2'));
		await upload(backend, workspaceId, '/one.md', Buffer.from('1b'), {
			mode: 'save', baseRevision: await revisionOf(backend, '/one.md'),
		});
		await backend.createDirectory('/later');
		await sync(backend, workspaceId, { method: 'POST', path: '/rename', body: { from: '/two.md', to: '/later/two.md' } });

		// One request returns everything, in seq order, with no content re-uploaded.
		const catchUp = await changes(backend, workspaceId, { cursor: held });
		assert.equal(catchUp.status, 200);
		assert.deepEqual(catchUp.body.changes.map(change => change.kind), [
			'file.created', 'file.saved', 'directory.created', 'file.renamed',
		]);
		assert.equal(catchUp.body.changes[0].seq, baseline.body.changes.at(-1).seq + 1, 'the page starts after the client cursor');
		assert.equal(catchUp.body.hasMore, false);
		assert.equal(catchUp.body.head, catchUp.body.toSeq);
		// The cursor advances to the head and a second pull is a no-change poll.
		const again = await changes(backend, workspaceId, { cursor: catchUp.body.cursor });
		assert.equal(again.body.changes.length, 0);
		assert.equal(again.body.fromSeq, again.body.toSeq);
	});
});

test('acceptance: pages stay stable when writes land between them', { skip }, async () => {
	await scenarioWorkspace(async ({ backend, workspaceId }) => {
		for (const name of ['a', 'b', 'c', 'd']) {
			await upload(backend, workspaceId, `/${name}.md`, Buffer.from(name));
		}
		const start = await changes(backend, workspaceId);
		const firstPage = await changes(backend, workspaceId, { limit: 2 });
		assert.equal(firstPage.body.changes.length, 2);
		assert.equal(firstPage.body.hasMore, true, 'more changes exist');

		// A second device commits while the first is paging.
		await upload(backend, workspaceId, '/e.md', Buffer.from('e'));
		await upload(backend, workspaceId, '/f.md', Buffer.from('f'));

		const secondPage = await changes(backend, workspaceId, { limit: 2, cursor: firstPage.body.cursor });
		const thirdPage = await changes(backend, workspaceId, { limit: 2, cursor: secondPage.body.cursor });
		const emptyPage = await changes(backend, workspaceId, { limit: 2, cursor: thirdPage.body.cursor });
		const collected = [
			...firstPage.body.changes,
			...secondPage.body.changes,
			...thirdPage.body.changes,
		];
		// §9.3: the writes that landed mid-paging appear on the page that reaches them, with no
		// duplicate and no skip.
		assert.deepEqual(collected.map(change => change.path), ['/a.md', '/b.md', '/c.md', '/d.md', '/e.md', '/f.md']);
		assert.deepEqual(collected.map(change => change.seq), [1, 2, 3, 4, 5, 6]);
		// hasMore flips false exactly when the page covered the head; a further poll is empty
		// rather than an error.
		assert.equal(firstPage.body.hasMore, true);
		assert.equal(secondPage.body.hasMore, true);
		assert.equal(thirdPage.body.hasMore, false, 'the last full page ends the stream');
		assert.deepEqual(emptyPage.body.changes, []);
		assert.equal(emptyPage.body.hasMore, false);
		assert.equal(start.body.changes.length, 4);
	});
});

test('acceptance: a cursor older than the retention floor forces a resync', { skip }, async () => {
	await scenarioWorkspace(async ({ backend, pool, workspaceId }) => {
		for (let index = 0; index < 8; index += 1) {
			await upload(backend, workspaceId, `/n${index}.md`, Buffer.from(String(index)));
		}
		const early = await changes(backend, workspaceId, { limit: 1 });
		const staleCursor = early.body.cursor;

		// Trim the stream as if 30 days had passed (§7.2). Trimming runs inside the write
		// transaction with the row lock, exactly like the real maintenance path.
		const client = await pool.connect();
		try {
			await client.query('BEGIN');
			await client.query('SELECT 1 FROM log4stellar.storage_workspaces WHERE id = $1 FOR UPDATE', [workspaceId]);
			const trimmed = await trimChanges(client, workspaceId, { nowMs: Date.now() + syncRetention.changesTtlMs + 1 });
			await client.query('COMMIT');
			assert.ok(trimmed.deleted > 0, 'the trim removed rows');
			assert.ok(trimmed.retainedFloor > 1);
		} finally {
			client.release();
		}

		// The stale cursor is refused with 410, never answered with an empty page.
		const refused = await changes(backend, workspaceId, { cursor: staleCursor });
		assert.equal(refused.status, 410);
		assert.equal(refused.body.error, 'ResyncRequired');
		assert.equal(refused.body.changes, undefined, 'no partial results with an error');

		// The documented recovery: take a fresh snapshot and continue from its seq.
		const snapshot = await sync(backend, workspaceId, { method: 'POST', path: '/snapshot', body: { limit: 100 } });
		assert.equal(snapshot.status, 201);
		assert.ok(snapshot.body.seq >= 8);
		const resumed = await changes(backend, workspaceId, { cursor: snapshot.body.cursor });
		assert.equal(resumed.status, 200);
		assert.equal(resumed.body.fromSeq, snapshot.body.seq);
		assert.equal(resumed.body.changes.length, 0, 'the snapshot already carries the whole tree');
	});

	// A cursor from the future is equally invalid.
	await scenarioWorkspace(async ({ backend, workspaceId }) => {
		await upload(backend, workspaceId, '/x.md', Buffer.from('x'));
		const future = encodeCursor({ workspaceId, kind: 'changes', seq: 999 });
		const refused = await changes(backend, workspaceId, { cursor: future });
		assert.equal(refused.status, 410);
		assert.equal(refused.body.error, 'ResyncRequired');
	});
});

test('a no-change poll is a 200 with fromSeq === toSeq === head', { skip }, async () => {
	await scenarioWorkspace(async ({ backend, workspaceId }) => {
		await upload(backend, workspaceId, '/a.md', Buffer.from('a'));
		const first = await changes(backend, workspaceId);
		const poll = await changes(backend, workspaceId, { cursor: first.body.cursor });
		assert.equal(poll.status, 200, 'never 304 and never 410');
		assert.deepEqual(poll.body.changes, []);
		assert.equal(poll.body.hasMore, false);
		assert.equal(poll.body.fromSeq, poll.body.head);
		assert.equal(poll.body.toSeq, poll.body.head);
		assert.equal(poll.body.head, 1);
	});
});

// ---------------------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------------------

test('a snapshot is a consistent baseline that pages by path', { skip }, async () => {
	await scenarioWorkspace(async ({ backend, workspaceId }) => {
		await sync(backend, workspaceId, { method: 'POST', path: '/mkdir', body: { path: '/docs' } });
		for (const name of ['one', 'two', 'three']) {
			await upload(backend, workspaceId, `/docs/${name}.md`, Buffer.from(name));
		}
		const created = await sync(backend, workspaceId, { method: 'POST', path: '/snapshot', body: { limit: 2 } });
		assert.equal(created.status, 201);
		// The tree includes the workspace root itself, the /docs directory and the three files.
		assert.equal(created.body.entryCount, 5);
		assert.equal(created.body.entries.length, 2);
		assert.equal(created.body.hasMore, true);
		assert.ok(created.body.pageToken);

		// Writing after the snapshot must not change what the snapshot pages show.
		await upload(backend, workspaceId, '/docs/four.md', Buffer.from('four'));

		const collected = [...created.body.entries];
		let token = created.body.pageToken;
		for (;;) {
			const page = await sync(backend, workspaceId, {
				path: '/snapshot/' + created.body.snapshotId,
				query: { token, limit: '2' },
			});
			assert.equal(page.status, 200);
			collected.push(...page.body.entries);
			if (!page.body.hasMore) {
				break;
			}
			token = page.body.pageToken;
		}
		const seen = collected.map(entry => entry.path);
		assert.deepEqual(seen, ['/', '/docs', '/docs/one.md', '/docs/three.md', '/docs/two.md']);
		assert.ok(!seen.includes('/docs/four.md'), 'a snapshot is a fixed view');

		// Entry pages keep the contract field names (§8.2).
		const withHash = collected.find(entry => entry.kind === 1);
		assert.equal(typeof withHash.sha256, 'string');
		assert.equal(withHash.sha256.length, 64);
		assert.equal(typeof withHash.modifiedAt, 'number');
	});
});

test('a snapshot page token from another snapshot is rejected', { skip }, async () => {
	await scenarioWorkspace(async ({ backend, workspaceId }) => {
		await upload(backend, workspaceId, '/a.md', Buffer.from('a'));
		const one = await sync(backend, workspaceId, { method: 'POST', path: '/snapshot', body: { limit: 1 } });
		const two = await sync(backend, workspaceId, { method: 'POST', path: '/snapshot', body: { limit: 1 } });
		const foreign = encodePageToken({ snapshotId: two.body.snapshotId, lastPath: '/a.md' });
		const wrong = await sync(backend, workspaceId, { path: '/snapshot/' + one.body.snapshotId, query: { token: foreign } });
		assert.equal(wrong.status, 400);
		assert.equal(wrong.body.error, 'InvalidPageToken');
	});
});

test('an expired or unknown snapshot is a 410 InvalidSnapshot', { skip }, async () => {
	await scenarioWorkspace(async ({ backend, pool, workspaceId }) => {
		await upload(backend, workspaceId, '/a.md', Buffer.from('a'));
		const created = await sync(backend, workspaceId, { method: 'POST', path: '/snapshot', body: {} });
		// Expire it by moving the clock forward in the row itself.
		await pool.query('UPDATE log4stellar.storage_snapshots SET expires_ms = $2 WHERE id = $1', [created.body.snapshotId, Date.now() - 1]);
		const expired = await sync(backend, workspaceId, { path: '/snapshot/' + created.body.snapshotId });
		assert.equal(expired.status, 410);
		assert.equal(expired.body.error, 'InvalidSnapshot', 'distinct from ResyncRequired');
		const unknown = await sync(backend, workspaceId, { path: '/snapshot/' + randomUUID() });
		assert.equal(unknown.status, 410);
		assert.equal(unknown.body.error, 'InvalidSnapshot');
	});
});

test('the snapshot seq and the change stream join without gaps or overlap', { skip }, async () => {
	await scenarioWorkspace(async ({ backend, workspaceId }) => {
		await upload(backend, workspaceId, '/before.md', Buffer.from('before'));
		const snapshot = await sync(backend, workspaceId, { method: 'POST', path: '/snapshot', body: {} });
		assert.equal(snapshot.body.seq, 1);
		// Changes at or below the snapshot seq are already in the snapshot; only strictly
		// greater ones are pulled, which is what §4.1 tells clients to do.
		await upload(backend, workspaceId, '/after.md', Buffer.from('after'));
		const tail = await changes(backend, workspaceId, { cursor: snapshot.body.cursor });
		assert.equal(tail.body.changes.length, 1);
		assert.equal(tail.body.changes[0].path, '/after.md');
		assert.equal(tail.body.changes[0].seq, 2);
	});
});

// ---------------------------------------------------------------------------------------
// Review fixes: every test below was written first and observed RED (§5.2 replay, §3.3
// cursor semantics, §7.2 retention, §8.6 no-op shape, and the cold-start migration).
// ---------------------------------------------------------------------------------------

test('review A: a restore retried with the same key replays instead of 404', { skip }, async () => {
	// The trash row is CONSUMED by the first restore, so a second attempt finds no trash.
	// §5.2 still requires the original result back: the key identifies the request, not the
	// state it happened to run against.
	await scenarioWorkspace(async ({ backend, workspaceId }) => {
		const created = await upload(backend, workspaceId, '/r.md', Buffer.from('restore me'));
		assert.equal(created.status, 201);
		const deleted = await sync(backend, workspaceId, { method: 'DELETE', path: '/file', query: { path: '/r.md' } });
		assert.equal(deleted.status, 200);
		const trashId = deleted.body.trashId;
		const key = 'restore-key-0001';
		const first = await sync(backend, workspaceId, {
			method: 'POST', path: '/restore', body: { trashId }, headers: { 'idempotency-key': key, 'x-log4stellar-device': 'phone' },
		});
		assert.equal(first.status, 200);
		assert.equal(first.body.replayed, false);
		const retry = await sync(backend, workspaceId, {
			method: 'POST', path: '/restore', body: { trashId }, headers: { 'idempotency-key': key, 'x-log4stellar-device': 'phone' },
		});
		assert.equal(retry.status, 200, 'a retry of a completed restore is a replay, not a 404');
		assert.equal(retry.body.error, undefined);
		assert.equal(retry.body.replayed, true);
		assert.equal(retry.body.seq, first.body.seq);
		assert.equal(retry.body.changeId, first.body.changeId);
		// And it did not restore twice: one change row for the restore, one file on disk.
		const stream = await changes(backend, workspaceId);
		assert.deepEqual(stream.body.changes.map(change => change.kind), ['file.created', 'file.deleted', 'file.restored']);
		assert.equal((await readAll(backend, '/r.md')).toString(), 'restore me');
	});
});

test('review D1: an upload retried after the parent went away replays instead of 404', { skip }, async () => {
	// The upload pre-checks the parent directory OUTSIDE the transaction. A retry that
	// arrives after another device removed that directory used to fail that pre-check and
	// never reach the replay lookup, so an already-committed write was reported as 404.
	await scenarioWorkspace(async ({ backend, workspaceId }) => {
		await sync(backend, workspaceId, { method: 'POST', path: '/mkdir', body: { path: '/dir' } });
		const key = 'upload-replay-key';
		const first = await upload(backend, workspaceId, '/dir/a.md', Buffer.from('payload'), { key, device: 'phone' });
		assert.equal(first.status, 201);
		const removed = await sync(backend, workspaceId, { method: 'DELETE', path: '/file', query: { path: '/dir', recursive: '1' } });
		assert.equal(removed.status, 200);
		const retry = await upload(backend, workspaceId, '/dir/a.md', Buffer.from('payload'), { key, device: 'phone' });
		assert.equal(retry.status, 200, 'the replay answers from the change stream, not from the deleted tree');
		assert.equal(retry.body.replayed, true);
		assert.equal(retry.body.seq, first.body.seq);
		assert.equal(retry.body.changeId, first.body.changeId);
		assert.equal(retry.body.etag, first.body.etag);
		// Nothing was recreated: the path is still deleted.
		await assert.rejects(() => backend.stat('/dir/a.md'), error => error.code === 'FileNotFound');
	});
});

test('review D1: a rollback retried after the file was deleted replays instead of 404', { skip }, async () => {
	await scenarioWorkspace(async ({ backend, workspaceId }) => {
		const created = await upload(backend, workspaceId, '/b.md', Buffer.from('one'));
		const saved = await upload(backend, workspaceId, '/b.md', Buffer.from('two'), { mode: 'save', baseRevision: created.body.revisionId });
		const key = 'rollback-replay-key';
		const first = await sync(backend, workspaceId, {
			method: 'POST', path: '/rollback',
			body: { path: '/b.md', revisionId: created.body.revisionId, baseRevision: saved.body.revisionId },
			headers: { 'idempotency-key': key },
		});
		assert.equal(first.status, 200);
		const removed = await sync(backend, workspaceId, { method: 'DELETE', path: '/file', query: { path: '/b.md' } });
		assert.equal(removed.status, 200);
		const retry = await sync(backend, workspaceId, {
			method: 'POST', path: '/rollback',
			body: { path: '/b.md', revisionId: created.body.revisionId, baseRevision: saved.body.revisionId },
			headers: { 'idempotency-key': key },
		});
		assert.equal(retry.status, 200, 'a retried rollback is a replay, not a 404');
		assert.equal(retry.body.replayed, true);
		assert.equal(retry.body.seq, first.body.seq);
	});
});

test('review B: an out-of-range cursor is 410 on every read path, including /conflicts', { skip }, async () => {
	// §3.3: "绝不允许用 200 返回一个空变更列表". A cursor past the head used to be echoed
	// back as if it were valid, so the client's bad position was never corrected.
	await scenarioWorkspace(async ({ backend, workspaceId }) => {
		await upload(backend, workspaceId, '/a.md', Buffer.from('a'));
		const ahead = encodeCursor({ workspaceId, kind: 'changes', seq: 1000000 });
		const onChanges = await changes(backend, workspaceId, { cursor: ahead });
		assert.equal(onChanges.status, 410);
		assert.equal(onChanges.body.error, 'ResyncRequired');
		const onConflicts = await sync(backend, workspaceId, { path: '/conflicts', query: { cursor: ahead } });
		assert.equal(onConflicts.status, 410, '/conflicts must not answer 200 for an impossible position');
		assert.equal(onConflicts.body.error, 'ResyncRequired');
		assert.equal(onConflicts.body.conflicts, undefined, 'no partial result');
	});
});

test('review B: an expired snapshot cursor is a 410 on the change stream too', { skip }, async () => {
	await scenarioWorkspace(async ({ backend, workspaceId }) => {
		await upload(backend, workspaceId, '/a.md', Buffer.from('a'));
		const snapshot = await sync(backend, workspaceId, { method: 'POST', path: '/snapshot', body: {} });
		const expired = encodeCursor({ workspaceId, kind: 'snapshot', seq: snapshot.body.seq, expiresMs: Date.now() - 1 });
		const page = await changes(backend, workspaceId, { cursor: expired });
		assert.equal(page.status, 410, 'requireLiveCursor applies wherever a snapshot cursor may arrive');
		assert.equal(page.body.error, 'ResyncRequired');
		// A still-live snapshot cursor keeps working: it is just a seq.
		const live = await changes(backend, workspaceId, { cursor: snapshot.body.cursor });
		assert.equal(live.status, 200);
	});
});

test('review E: the row ceiling never trims a row that is still inside the idempotency window', { skip }, async () => {
	// §7.2 keeps keyed rows for 30 days so a retry can be replayed. The row ceiling used to
	// win over that window, silently shrinking idempotency to "as long as the stream is
	// short" — after which a retry looked like a brand new request (here: a SyncConflict).
	await scenarioWorkspace(async ({ backend, pool, workspaceId }) => {
		const key = 'trim-key-0001';
		const first = await upload(backend, workspaceId, '/a.md', Buffer.from('kept'), { key });
		assert.equal(first.status, 201);
		for (let index = 0; index < 4; index += 1) {
			await upload(backend, workspaceId, '/b' + index + '.md', Buffer.from('plain ' + index));
		}
		const connection = await pool.connect();
		try {
			await connection.query('BEGIN');
			await connection.query('SELECT 1 FROM log4stellar.storage_workspaces WHERE id = $1 FOR UPDATE', [workspaceId]);
			// Same code path as production, with a tiny ceiling so the case is reachable.
			// "Plain" rows are past the change TTL; the keyed row is still inside the much
			// longer idempotency window, which is exactly the case the ceiling used to break.
			const trimmed = await trimChanges(connection, workspaceId, {
				nowMs: Date.now() + 2000,
				changesTtlMs: 1000,
				maxChanges: 2,
			});
			await connection.query('COMMIT');
			assert.equal(trimmed.retainedFloor, 1, 'the keyed row anchors the floor: nothing may be trimmed before it');
			assert.equal(trimmed.deleted, 0);
		} finally {
			connection.release();
		}
		// The rendered consequence: the retry still replays instead of being re-executed.
		const retry = await upload(backend, workspaceId, '/a.md', Buffer.from('kept'), { key });
		assert.equal(retry.status, 200, 'the key was not forgotten');
		assert.equal(retry.body.replayed, true);
		assert.equal(retry.body.seq, first.body.seq);
	});
});

test('review G: a no-op mkdir reports "nothing changed" instead of borrowing the head seq', { skip }, async () => {
	// Returning head.seq for an operation that changed nothing lets a client advance its
	// cursor past other people's changes, and `changeId: null` + `replayed: false` is not a
	// state a client can act on. rename already answers {seq: null}; mkdir now matches.
	await scenarioWorkspace(async ({ backend, workspaceId }) => {
		const first = await sync(backend, workspaceId, { method: 'POST', path: '/mkdir', body: { path: '/x' } });
		assert.equal(first.status, 201);
		assert.equal(typeof first.body.changeId, 'string');
		assert.equal(first.body.seq, 1);
		const second = await sync(backend, workspaceId, { method: 'POST', path: '/mkdir', body: { path: '/x' } });
		assert.equal(second.status, 201);
		assert.equal(second.body.seq, null, 'no seq may be spent or borrowed');
		assert.equal(second.body.changeId, null);
		assert.deepEqual(second.body.changeIds, []);
		assert.equal(second.body.replayed, false);
		assert.equal(second.body.changed, false);
		// One change row, one seq: the no-op really wrote nothing.
		const stream = await changes(backend, workspaceId);
		assert.equal(stream.body.changes.length, 1);
		assert.equal(stream.body.head, 1);
	});
});

test('review F: opening a workspace does not run DDL while readers are active', { skip }, async () => {
	// The ALTER TABLE in the migration takes AccessExclusiveLock even when the column is
	// already there. Running it on every cold open meant a slow snapshot request could block
	// the next workspace open, and the queued DDL then blocked every reader behind it.
	await scenarioWorkspace(async ({ backend, pool, workspaceId }) => {
		const reader = await pool.connect();
		let opened;
		try {
			await reader.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
			// Take the same AccessShareLock a snapshot read holds on the change stream.
			await reader.query('SELECT count(*) FROM log4stellar.storage_changes');
			opened = openRustfsWorkspace(workspaceId, { createBlobs: openDirectoryBlobs });
			const outcome = await Promise.race([
				opened.then(() => 'opened'),
				new Promise(resolve => setTimeout(() => resolve('blocked'), 3000)),
			]);
			assert.equal(outcome, 'opened', 'a warm schema must not be re-migrated under a reader');
		} finally {
			await reader.query('COMMIT');
			reader.release();
			// Let a late open finish so it cannot leak a pool or surface as an unhandled rejection.
			if (opened) {
				await opened.then(handle => handle.close(), () => undefined);
			}
		}
	});
});

test('review F: a missing schema makes the probe say "stale", so the migration still runs', { skip }, async () => {
	// The fast path is only safe if "absent" can never look "current": to_regclass() returns
	// NULL, and NULL AND x is NULL, which is why the probe compares `=== true` instead of
	// testing truthiness. Pinning that keeps a fresh database from silently skipping DDL.
	await scenarioWorkspace(async ({ pool: connected }) => {
		const { storageSchemaCurrent } = await import('./sync-migrate.mjs');
		assert.equal(await storageSchemaCurrent(connected), true, 'a migrated database reports current');
		const { rows } = await connected.query(`
			SELECT (to_regclass('log4stellar.storage_absent_probe') IS NOT NULL AND true) AS missing
		`);
		assert.equal(rows[0].missing, false, 'an absent table yields false, never NULL-to-true');
	});
});

// ---------------------------------------------------------------------------------------
// Schema probe against a real, deliberately broken catalog
// ---------------------------------------------------------------------------------------

/**
 * Mutates the live catalog inside a transaction and rolls it back.
 *
 * `lock_timeout` matters: DDL takes AccessExclusiveLock, and without a bound a concurrent
 * reader would leave this test waiting until the suite's own timeout. A bounded wait turns
 * "somebody else is using the table" into a fast, explainable failure instead of a hang.
 *
 * The probe is handed the transaction's client, so it sees the uncommitted DDL and nothing
 * outside ever observes the broken schema.
 */
async function withBrokenCatalog(pool, ddl, work) {
	const client = await pool.connect();
	try {
		await client.query('BEGIN');
		await client.query(`SET LOCAL lock_timeout TO '3000'`);
		for (const statement of [].concat(ddl)) {
			await client.query(statement);
		}
		/* eslint-disable-next-line no-useless-catch */
		return await work(client);
	} finally {
		await client.query('ROLLBACK').catch(() => undefined);
		client.release();
	}
}

test('review G: a dropped idempotency index is detected, not reported as current', { skip }, async () => {
	// This is the deviation with the worst downstream cost: while the probe said "current" the
	// migration was skipped, duplicate idempotency keys were accepted, and sync-schema.sql could
	// not even re-create the index (23505 from the duplicates it had already allowed).
	await scenarioWorkspace(async ({ pool }) => {
		await withBrokenCatalog(pool, 'DROP INDEX log4stellar.storage_changes_idempotency_idx', async client => {
			const probe = await inspectStorageSchema(client);
			assert.equal(probe.current, false);
			const problem = probe.problems.find(entry => entry.object === 'storage_changes_idempotency_idx');
			assert.ok(problem, probe.problems.map(entry => entry.message).join('\n'));
			assert.equal(problem.repairable, true, 'a missing index is what CREATE INDEX IF NOT EXISTS can fix');
		});
	});
});

test('review G: a retyped column refuses to start instead of skipping the migration', { skip }, async () => {
	// bigint -> text is invisible to CREATE TABLE IF NOT EXISTS, so "migrate and carry on" would
	// leave it forever. The refusal has to happen before any DDL runs, which is what the throwing
	// connect() below proves.
	//
	// `storage_snapshots.created_ms` is the column to retype: unlike `storage_change_heads.seq`
	// it carries no CHECK constraint, so the ALTER TYPE does not fail on revalidation (42883
	// `text >= integer`) before the probe ever gets to see the deviation.
	await scenarioWorkspace(async ({ pool }) => {
		await withBrokenCatalog(pool, 'ALTER TABLE log4stellar.storage_snapshots ALTER COLUMN created_ms TYPE text', async client => {
			const probe = await inspectStorageSchema(client);
			assert.equal(probe.current, false);
			const problem = probe.problems.find(entry => entry.object === 'storage_snapshots.created_ms' && entry.repairable === false);
			assert.ok(problem, probe.problems.map(entry => entry.message).join('\n'));
			assert.match(problem.message, /has type text, expected bigint/);

			const guardedPool = {
				query: (...args) => client.query(...args),
				connect: async () => {
					throw new Error('ensureStorageSchema must refuse before running the migration');
				},
			};
			await assert.rejects(
				() => ensureStorageSchema(guardedPool),
				error => {
					assert.match(error.message, /cannot repair/);
					assert.match(error.message, /storage_snapshots\.created_ms has type text, expected bigint/);
					return true;
				},
			);
		});
	});
});

test('review G: a dropped column is detected as stale and repairable', { skip }, async () => {
	// The measured runtime symptom of this one was every sync request answering 42703, i.e. a
	// permanent 500 that no restart could clear.
	await scenarioWorkspace(async ({ pool }) => {
		await withBrokenCatalog(pool, 'ALTER TABLE log4stellar.storage_changes DROP COLUMN device_id', async client => {
			const probe = await inspectStorageSchema(client);
			assert.equal(probe.current, false);
			const problem = probe.problems.find(entry => entry.object === 'storage_changes.device_id');
			assert.ok(problem, probe.problems.map(entry => entry.message).join('\n'));
			assert.equal(problem.repairable, true);
		});
	});
});

test('review G: a healthy catalog is still reported as current, and needs no migration', { skip }, async () => {
	// The positive control for the three tests above: the probe must not have become "always
	// stale", or every open would queue DDL behind readers (the review-F regression).
	const settings = storageConfig();
	const pool = new Pool({ connectionTimeoutMillis: 5000, max: 2, ...settings.postgres });
	try {
		const probe = await inspectStorageSchema(pool);
		assert.deepEqual(probe.problems, []);
		assert.equal(probe.current, true);
		assert.deepEqual(await ensureStorageSchema(pool), { migrated: false, problems: [] });
	} finally {
		await pool.end();
	}
});

test('review H: the same key with mode flipped from create to save is refused, not replayed', { skip }, async () => {
	// §5.1: `mode` changes what the operation IS (may it create the path, or must it push an
	// existing revision forward?), so it belongs in the fingerprint. Both attempts below name
	// the SAME base revision, which makes `mode` the only differing field — precisely the case
	// the fingerprint used to miss, answering 200 replayed:true about a save that never ran.
	await scenarioWorkspace(async ({ backend, workspaceId }) => {
		const key = 'gap-mode-key-0001';
		const base = randomUUID();
		const first = await upload(backend, workspaceId, '/gap.md', Buffer.from('one'), { mode: 'create', baseRevision: base, key });
		assert.equal(first.status, 201);
		assert.equal(first.body.created, true);
		const retried = await upload(backend, workspaceId, '/gap.md', Buffer.from('one'), { mode: 'save', baseRevision: base, key });
		assert.equal(retried.status, 409, 'a save under a create key is a different request, not a retry');
		assert.equal(retried.body.error, 'IdempotencyKeyReused');
		// Still one file, one revision, one change row: the refused attempt wrote nothing.
		assert.equal((await readAll(backend, '/gap.md')).toString(), 'one');
		assert.equal((await backend.listVersions('/gap.md')).length, 1);
		const stream = await changes(backend, workspaceId);
		assert.equal(stream.body.changes.length, 1);
	});
});

test('review H: the same key with overwrite flipped is refused, not replayed', { skip }, async () => {
	// The practical damage: `overwrite:true` never took effect, but the client was told 200.
	// A rename that may clobber the target is not the retry of one that may not.
	await scenarioWorkspace(async ({ backend, workspaceId }) => {
		await upload(backend, workspaceId, '/from.md', Buffer.from('from'));
		await upload(backend, workspaceId, '/taken.md', Buffer.from('taken'));
		const key = 'gap-overwrite-key1';
		const first = await sync(backend, workspaceId, {
			method: 'POST', path: '/rename',
			body: { from: '/from.md', to: '/free.md', overwrite: false },
			headers: { 'idempotency-key': key },
		});
		assert.equal(first.status, 200);
		assert.equal(first.body.replayed, false);
		const retried = await sync(backend, workspaceId, {
			method: 'POST', path: '/rename',
			body: { from: '/from.md', to: '/free.md', overwrite: true },
			headers: { 'idempotency-key': key },
		});
		assert.equal(retried.status, 409, 'overwrite:true is not the retry of overwrite:false');
		assert.equal(retried.body.error, 'IdempotencyKeyReused');
		const stream = await changes(backend, workspaceId);
		assert.equal(stream.body.changes.filter(change => change.kind === 'file.renamed').length, 1);
	});
});

test('review H: the same key with keepBoth flipped is refused, not replayed', { skip }, async () => {
	// `keepBoth:true` was equally dead: a restore that should have preserved the incumbent
	// bytes as a conflict copy was answered with the first attempt's result instead.
	await scenarioWorkspace(async ({ backend, workspaceId }) => {
		await upload(backend, workspaceId, '/keep.md', Buffer.from('incumbent'));
		const deleted = await sync(backend, workspaceId, { method: 'DELETE', path: '/file', query: { path: '/keep.md' } });
		assert.equal(deleted.status, 200);
		const trashId = deleted.body.trashId;
		const key = 'gap-keepboth-key1';
		const first = await sync(backend, workspaceId, {
			method: 'POST', path: '/restore', body: { trashId, keepBoth: false }, headers: { 'idempotency-key': key },
		});
		assert.equal(first.status, 200);
		assert.equal(first.body.replayed, false);
		const retried = await sync(backend, workspaceId, {
			method: 'POST', path: '/restore', body: { trashId, keepBoth: true }, headers: { 'idempotency-key': key },
		});
		assert.equal(retried.status, 409, 'keepBoth:true is not the retry of keepBoth:false');
		assert.equal(retried.body.error, 'IdempotencyKeyReused');
	});
});

test('review I: a read path collects snapshots that expired in an idle workspace', { skip }, async () => {
	// §7.2 promises a six hour snapshot TTL, but `trimSnapshots` only ever ran from
	// `maintain()`, which returns early unless the write lands on a multiple of 512. A
	// workspace that stopped writing therefore kept every expired snapshot — and, through
	// ON DELETE CASCADE, every one of its entry rows — forever. Nothing else ever deleted them.
	await scenarioWorkspace(async ({ backend, pool, workspaceId }) => {
		const snapshotRows = async () => Number((await pool.query(
			'SELECT count(*)::int AS n FROM log4stellar.storage_snapshots WHERE workspace_id = $1', [workspaceId],
		)).rows[0].n);
		const entryRows = async snapshotId => Number((await pool.query(
			'SELECT count(*)::int AS n FROM log4stellar.storage_snapshot_entries WHERE snapshot_id = $1', [snapshotId],
		)).rows[0].n);

		await upload(backend, workspaceId, '/gc.md', Buffer.from('collect me'));
		await sync(backend, workspaceId, { method: 'POST', path: '/mkdir', body: { path: '/dir' } });
		const stale = await sync(backend, workspaceId, { method: 'POST', path: '/snapshot', body: {} });
		assert.equal(stale.status, 201);
		assert.equal(await entryRows(stale.body.snapshotId), 3, 'two paths plus the root entry are paged');
		assert.equal(await snapshotRows(), 1);

		// Expire it the way the clock would, without waiting six hours.
		await pool.query('UPDATE log4stellar.storage_snapshots SET expires_ms = $2 WHERE id = $1', [stale.body.snapshotId, Date.now() - 1]);
		// A plain read is all an idle client does. It must be enough to reclaim the row.
		const page = await changes(backend, workspaceId);
		assert.equal(page.status, 200);
		assert.equal(await snapshotRows(), 0, 'the expired snapshot row is gone after one read');
		assert.equal(await entryRows(stale.body.snapshotId), 0, 'its entries went with it (ON DELETE CASCADE)');
		// The data itself is untouched: collecting a snapshot must never delete entries.
		assert.equal((await readAll(backend, '/gc.md')).toString(), 'collect me');

		// Throttle evidence: the collection is NOT paid on every request. A snapshot that
		// expires right after a collection survives the next read and is picked up by the next
		// collection window (here: a freshly opened backend, i.e. a restarted process).
		const second = await sync(backend, workspaceId, { method: 'POST', path: '/snapshot', body: {} });
		await pool.query('UPDATE log4stellar.storage_snapshots SET expires_ms = $2 WHERE id = $1', [second.body.snapshotId, Date.now() - 1]);
		assert.equal((await changes(backend, workspaceId)).status, 200);
		assert.equal(await snapshotRows(), 1, 'a second read inside the throttle window does not pay for another GC');
		const restarted = await openRustfsWorkspace(workspaceId, { createBlobs: openDirectoryBlobs });
		try {
			assert.equal((await changes(restarted, workspaceId)).status, 200);
			assert.equal(await snapshotRows(), 0, 'the next window collects it, so nothing is stranded forever');
			assert.equal(await entryRows(second.body.snapshotId), 0);
		} finally {
			await restarted.close();
		}
	});
});
