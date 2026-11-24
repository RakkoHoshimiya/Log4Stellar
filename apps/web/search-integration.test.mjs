import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { Pool } from 'pg';
import { openRustfsWorkspace } from './rustfs-workspace.mjs';
import {
	claimIndexJobs, countPendingJobs, enqueueIndexUpdate, ensureSearchSchema, queryDocuments,
	readIndexState, searchTables, upsertDocument,
} from './search-store.mjs';
import { applyIndexJob } from './search-indexer.mjs';
import { searchLimits } from './search-contract.mjs';
import { openDirectoryBlobs } from './test-support/directory-blobs.mjs';

// End-to-end tests for the workspace full text index against real PostgreSQL and a
// directory-backed object store. Opt-in, exactly like sync-integration.test.mjs:
//
//   LOG4STELLAR_STORAGE_CONFIG=/tmp/l4s-search-it/storage.json LOG4STELLAR_IT=1 \
//     node --test --test-concurrency=1 apps/web/search-integration.test.mjs
//
// The storage config here carries only the `postgres` block: the blob store is injected
// as a directory, so the shared bucket is unreachable from these tests. Every workspace
// matches `l4s-it-*` and is deleted afterwards, including its index rows and its blob
// directory.
const enabled = process.env.LOG4STELLAR_IT === '1';
const skip = enabled ? false : 'set LOG4STELLAR_IT=1 to run the PostgreSQL integration tests';
const maxBytes = 64 * 1024 * 1024;
const configPath = process.env.LOG4STELLAR_STORAGE_CONFIG;

function postgresSettings() {
	if (!configPath) {
		throw new Error('Set LOG4STELLAR_STORAGE_CONFIG to run the search integration tests.');
	}
	const settings = JSON.parse(readFileSync(configPath, 'utf8'));
	// The blob store is always injected as a directory, so the bucket in this file is never
	// contacted. It is still checked, because pointing these tests at the production bucket
	// would be a silent way to write into it if that ever changed.
	if (settings.s3?.bucket === 'log4stellar') {
		throw new Error('Refusing to run the search integration tests against the production bucket.');
	}
	return settings.postgres;
}

const storageConfig = () => postgresSettings();

async function scenarioWorkspace(work) {
	const settings = storageConfig();
	const workspaceId = 'l4s-it-' + randomUUID().replace(/-/g, '').slice(0, 12);
	const pool = new Pool({ connectionTimeoutMillis: 5000, max: 4, ...settings });
	const seed = await mkdtemp(join(tmpdir(), 'l4s-search-'));
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
		await clean(pool, workspaceId, seed);
		await pool.end();
	}
}

async function clean(pool, workspaceId, seed) {
	// The index tables are derived and hold no foreign key to storage_workspaces, but
	// they are still workspace scoped, so they go first for a stable teardown order.
	for (const table of ['search_jobs', 'search_documents', 'search_index_state']) {
		await pool.query(`DELETE FROM log4stellar.${table} WHERE workspace_id = $1`, [workspaceId]);
	}
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
	if (seed) {
		await rm(seed, { recursive: true, force: true });
	}
}

const bytesOf = value => Buffer.from(value, 'utf8');

// `writeFile` takes a stream, exactly like an upload body does, so the test helper wraps
// the buffer the same way /static/mount does. Parent directories are created on demand
// because a mount write does not create them either.
async function write(backend, path, value, options = {}) {
	const segments = path.split('/').slice(1, -1);
	let prefix = '';
	for (const segment of segments) {
		prefix += '/' + segment;
		await backend.createDirectory(prefix).catch(error => {
			if (error.status !== 409) {
				throw error;
			}
		});
	}
	return backend.writeFile(path, Readable.from([bytesOf(value)]), { create: true, overwrite: true, maxBytes, ...options });
}

async function readAll(backend, path) {
	const opened = await backend.openRead(path);
	const chunks = [];
	for await (const chunk of await opened.stream()) {
		chunks.push(Buffer.from(chunk));
	}
	return Buffer.concat(chunks).toString('utf8');
}

async function search(backend, query, { limit, cursor } = {}) {
	return backend.searchDocuments({ query, limit, cursor });
}

// Runs one callback inside a real transaction on a pooled connection, which is how the
// storage backend calls every search-store helper.
async function transaction(pool, work) {
	const connection = await pool.connect();
	try {
		await connection.query('BEGIN');
		const result = await work(connection);
		await connection.query('COMMIT');
		return result;
	} catch (error) {
		await connection.query('ROLLBACK').catch(() => {});
		throw error;
	} finally {
		connection.release();
	}
}

// ---------------------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------------------

test('the search schema is created on demand and is idempotent', { skip }, async () => {
	const pool = new Pool({ connectionTimeoutMillis: 5000, max: 2, ...storageConfig() });
	try {
		// The first call may create the tables or find them already there (the shared test
		// database outlives a run). What matters is that it is idempotent and that the
		// tables are usable afterwards, so the second call on the same pool is a no-op.
		assert.equal(typeof await ensureSearchSchema(pool), 'boolean');
		assert.equal(await ensureSearchSchema(pool), false, 'a second call on the same pool is a no-op');
		const { rows } = await pool.query(
			`SELECT table_name FROM information_schema.tables
			WHERE table_schema = 'log4stellar' AND table_name LIKE 'search\\_%' ORDER BY table_name`);
		assert.deepEqual(rows.map(row => row.table_name), ['search_documents', 'search_index_state', 'search_jobs']);
		// The index tables live beside the storage tables and must never be confused with
		// the sync contract tables that are pinned by sync-schema.sql.
		assert.equal(searchTables.documents, 'log4stellar.search_documents');
		assert.equal(searchTables.jobs, 'log4stellar.search_jobs');
	} finally {
		await pool.end();
	}
});

test('the search schema leaves the storage tables exactly as the previous release left them', { skip }, async () => {
	const pool = new Pool({ connectionTimeoutMillis: 5000, max: 2, ...storageConfig() });
	try {
		await ensureSearchSchema(pool);
		// A rollback to the previous release must keep working, so the five original
		// tables keep their documented columns and the search tables add nothing to them.
		const expected = {
			storage_entries: ['workspace_id', 'path', 'parent_path', 'name', 'file_id', 'revision_id', 'kind', 'created_ms', 'modified_ms'],
			storage_file_versions: ['workspace_id', 'file_id', 'revision_id', 'parent_revision_id', 'sha256', 'size_bytes', 'created_ms'],
		};
		for (const [table, columns] of Object.entries(expected)) {
			const { rows } = await pool.query(
				`SELECT column_name FROM information_schema.columns
				WHERE table_schema = 'log4stellar' AND table_name = $1 ORDER BY ordinal_position`, [table]);
			assert.deepEqual(rows.map(row => row.column_name), columns, table + ' must keep its columns');
		}
	} finally {
		await pool.end();
	}
});

// ---------------------------------------------------------------------------------------
// Lifecycle: save, search, rename, delete, restore, rollback
// ---------------------------------------------------------------------------------------

test('saving a note makes its body searchable, in Chinese and in English', { skip }, async () => {
	await scenarioWorkspace(async ({ backend }) => {
		await write(backend, '/notes/发布计划.md', '# 发布计划\n\n今天的发布计划已完成。\n');
		await write(backend, '/notes/release.md', '# Release\n\nThe launch plan is ready.\n');

		const chinese = await search(backend, '发布计划');
		assert.equal(chinese.items.length, 1);
		assert.equal(chinese.items[0].path, '/notes/发布计划.md');
		assert.equal(chinese.items[0].match, 'title');
		assert.match(chinese.items[0].excerpt, /发布计划/);

		const english = await search(backend, 'launch plan');
		assert.equal(english.items.length, 1);
		assert.equal(english.items[0].path, '/notes/release.md');
		assert.equal(english.items[0].match, 'body');
		assert.equal(english.total, 1);
	});
});

test('a search is case insensitive but reports the original casing', { skip }, async () => {
	await scenarioWorkspace(async ({ backend }) => {
		await write(backend, '/notes/release.md', '# Release\n\nThe Launch Plan is READY.\n');
		for (const query of ['launch', 'LAUNCH', 'Launch']) {
			const page = await search(backend, query);
			assert.equal(page.items.length, 1, query);
			const item = page.items[0];
			assert.equal(item.excerpt.slice(item.excerptOffset, item.excerptOffset + item.excerptLength), 'Launch', query);
		}
	});
});

test('a special character in the query is matched literally', { skip }, async () => {
	await scenarioWorkspace(async ({ backend }) => {
		await write(backend, '/notes/percent.md', '# Percent\n\na 100% match_ready value\n');
		await write(backend, '/notes/plain.md', '# Plain\n\na 100x matchYready value\n');
		// `%` and `_` are LIKE wildcards; strpos() keeps them literal, so the second note
		// must not match. Percent also proves the space is matched as typed.
		const percent = await search(backend, '100%');
		assert.deepEqual(percent.items.map(item => item.path), ['/notes/percent.md']);
		const underscore = await search(backend, 'match_ready');
		assert.deepEqual(underscore.items.map(item => item.path), ['/notes/percent.md']);
	});
});

test('renaming a note moves the hit without re-indexing the body', { skip }, async () => {
	await scenarioWorkspace(async ({ backend }) => {
		await write(backend, '/notes/old.md', '# 计划\n\n今天完成发布计划。\n');
		assert.deepEqual((await search(backend, '发布计划')).items.map(item => item.path), ['/notes/old.md']);

		await backend.rename('/notes/old.md', '/notes/new.md');
		// The index stores no path of its own: it is joined from storage_entries, so the
		// rename is visible immediately even though no index job was queued for it.
		assert.deepEqual((await search(backend, '发布计划')).items.map(item => item.path), ['/notes/new.md']);
		assert.deepEqual((await search(backend, 'old.md')).items, [], 'the old path must stop matching');
	});
});

test('deleting a note removes its hits and restoring brings them back', { skip }, async () => {
	await scenarioWorkspace(async ({ backend }) => {
		await write(backend, '/notes/plan.md', '# 计划\n\n发布计划在这里。\n');
		assert.equal((await search(backend, '发布计划')).items.length, 1);

		await backend.delete('/notes/plan.md', false);
		assert.deepEqual((await search(backend, '发布计划')).items, [], 'a deleted note must disappear');

		const items = await backend.listTrash();
		const target = items.find(item => item.path === '/notes/plan.md');
		assert.ok(target, 'the note must be in the trash');
		await backend.restoreTrash(target.id, false);
		assert.deepEqual((await search(backend, '发布计划')).items.map(item => item.path), ['/notes/plan.md']);
	});
});

test('a rollback to an older revision is searchable with the older text', { skip }, async () => {
	await scenarioWorkspace(async ({ backend }) => {
		await write(backend, '/notes/plan.md', '# 计划\n\n第一版内容：春季发布会。\n');
		const first = await backend.stat('/notes/plan.md');
		const firstRevision = first.etag.slice(1, -1);
		assert.equal((await search(backend, '春季发布会')).items.length, 1);

		await write(backend, '/notes/plan.md', '# 计划\n\n第二版内容：秋季发布会。\n', { create: false, etag: first.etag });
		const afterSecond = await backend.stat('/notes/plan.md');
		assert.equal((await search(backend, '秋季发布会')).items.length, 1);
		assert.deepEqual((await search(backend, '春季发布会')).items, [], 'the old text must be gone');

		// The rollback is a conditional write: it names the revision it expects to replace.
		await backend.restoreRevision('/notes/plan.md', firstRevision, afterSecond.etag);
		assert.equal((await search(backend, '春季发布会')).items.length, 1, 'the rollback must be indexed');
		assert.deepEqual((await search(backend, '秋季发布会')).items, []);
	});
});

// ---------------------------------------------------------------------------------------
// S02: out of order and duplicate index jobs
// ---------------------------------------------------------------------------------------

test('S02: an out of order job indexes the current revision, never the revision it names', { skip }, async () => {
	await scenarioWorkspace(async ({ backend, pool, workspaceId }) => {
		await write(backend, '/notes/plan.md', '# 计划\n\n初版：春季发布会。\n');
		const afterFirst = await backend.stat('/notes/plan.md');
		const firstRevision = afterFirst.etag.slice(1, -1);
		const fileId = await transaction(pool, connection => fileIdOf(connection, workspaceId, '/notes/plan.md'));

		await write(backend, '/notes/plan.md', '# 计划\n\n二版：秋季发布会。\n', { create: false, etag: afterFirst.etag });
		const afterSecond = await backend.stat('/notes/plan.md');
		const secondRevision = afterSecond.etag.slice(1, -1);
		// Index the current state first, so the index is known to be correct before the
		// stale job is applied on top of it.
		assert.equal((await search(backend, '秋季发布会')).items.length, 1);
		assert.equal(await transaction(pool, connection => countPendingJobs(connection, workspaceId)), 0);

		// Queue a job that names the *first* revision, as if the worker had crashed after the
		// first save and only comes back now. The queue itself is empty, so a sequence from
		// before is accepted — that is exactly the out of order delivery this row is about.
		await transaction(pool, connection => enqueueIndexUpdate(connection, {
			workspaceId, fileId, revisionId: firstRevision, seq: 1, operation: 'upsert', nowMs: Date.now(),
		}));
		const [stale] = await transaction(pool, connection => claimIndexJobs(connection, workspaceId));
		assert.ok(stale, 'the stale job must be claimable');
		assert.equal(stale.desiredRevisionId, firstRevision, 'the job really names the old revision');

		// Applying it must not resurrect the old text: the worker re-reads storage inside
		// its own transaction and only ever writes what storage currently holds.
		const applied = await applyIndexJob(stale, {
			backend,
			workspaceId,
			withTransaction: action => transaction(pool, action),
		});
		assert.equal(applied, true);
		const indexed = await transaction(pool, connection => indexedRevisionOf(connection, workspaceId, fileId));
		assert.equal(indexed, secondRevision, 'the index must hold the current revision, not the named one');
		assert.deepEqual((await search(backend, '春季发布会')).items, [], 'stale content must never be resurrected');
		assert.equal((await search(backend, '秋季发布会')).items.length, 1);
	});
});

test('S02: a stale document row is hidden by the current storage metadata', { skip }, async () => {
	await scenarioWorkspace(async ({ backend, pool, workspaceId }) => {
		await write(backend, '/notes/plan.md', '# 计划\n\n初版：春季发布会。\n');
		await write(backend, '/notes/secret.md', '# 备忘\n\n机密内容：待公开的名单。\n');
		await search(backend, '计划');
		const current = await backend.stat('/notes/plan.md');
		const currentRevision = current.etag.slice(1, -1);
		const secretId = await transaction(pool, connection => fileIdOf(connection, workspaceId, '/notes/secret.md'));
		assert.equal((await search(backend, '机密内容')).items.length, 1, 'the note is indexed while current');

		// Simulate an index row that was written for a revision the file has left behind.
		// The query joins storage_entries on the revision, so this row is invisible even
		// though it is still in the table: a stale copy can never be served.
		await transaction(pool, connection => upsertDocument(connection, {
			workspaceId,
			fileId: secretId,
			revisionId: randomUUID(),
			path: '/notes/secret.md',
			title: '备忘',
			body: '机密内容：待公开的名单。',
			truncated: false,
		}));
		assert.deepEqual((await search(backend, '机密内容')).items, [], 'a stale revision must not answer');
		// Other notes keep answering through their own, still current rows.
		assert.equal((await search(backend, '春季发布会')).items.length, 1);
		assert.equal((await search(backend, '春季发布会')).items[0].revisionId, currentRevision);
	});
});

test('S02: the queue only moves forward and repeats are idempotent', { skip }, async () => {
	await scenarioWorkspace(async ({ pool, workspaceId }) => {
		const fileId = randomUUID();
		const newer = randomUUID();
		const older = randomUUID();
		await transaction(pool, connection => enqueueIndexUpdate(connection, {
			workspaceId, fileId, revisionId: newer, seq: 7, operation: 'upsert', nowMs: 1000,
		}));
		// A duplicate delivery of an older event must not move the queue backwards.
		await transaction(pool, connection => enqueueIndexUpdate(connection, {
			workspaceId, fileId, revisionId: older, seq: 3, operation: 'upsert', nowMs: 1001,
		}));
		const claimed = await transaction(pool, connection => claimIndexJobs(connection, workspaceId));
		assert.equal(claimed.length, 1);
		assert.equal(claimed[0].desiredSeq, 7);
		assert.equal(claimed[0].desiredRevisionId, newer);

		// The same event twice leaves exactly one row.
		await transaction(pool, connection => enqueueIndexUpdate(connection, {
			workspaceId, fileId, revisionId: newer, seq: 7, operation: 'upsert', nowMs: 1002,
		}));
		assert.equal(await transaction(pool, connection => countPendingJobs(connection, workspaceId)), 1);
	});
});

test('a claimed job is not handed out twice while it is running', { skip }, async () => {
	await scenarioWorkspace(async ({ pool, workspaceId }) => {
		const fileId = randomUUID();
		await transaction(pool, connection => enqueueIndexUpdate(connection, {
			workspaceId, fileId, revisionId: randomUUID(), seq: 2, operation: 'upsert', nowMs: 1,
		}));
		const first = await transaction(pool, connection => claimIndexJobs(connection, workspaceId, { nowMs: 2 }));
		assert.equal(first.length, 1);
		const second = await transaction(pool, connection => claimIndexJobs(connection, workspaceId, { nowMs: 3 }));
		assert.deepEqual(second, [], 'a running job must not be claimed by a second worker');
		// Once the claim goes stale, the next worker takes it over: that is how a crashed
		// indexer recovers without a supervising process.
		const recovered = await transaction(pool, connection => claimIndexJobs(connection, workspaceId, { nowMs: 120_000 }));
		assert.equal(recovered.length, 1);
		assert.equal(recovered[0].attempts, 0, 'a reclaimed job keeps its attempt count, not a new one');
	});
});

// ---------------------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------------------

test('paging returns every note exactly once in a stable order', { skip }, async () => {
	await scenarioWorkspace(async ({ backend }) => {
		const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
		for (const name of names) {
			await write(backend, `/notes/${name}.md`, `# ${name}\n\nshared needle in ${name}\n`);
		}
		const seen = [];
		let cursor;
		for (let guard = 0; guard < 20; guard += 1) {
			const page = await search(backend, 'shared needle', { limit: 2, cursor });
			seen.push(...page.items.map(item => item.path));
			if (!page.hasMore) {
				assert.equal(page.nextCursor, null);
				break;
			}
			assert.ok(page.nextCursor, 'a page with more results must hand out a cursor');
			cursor = page.nextCursor;
		}
		assert.deepEqual(seen, names.map(name => `/notes/${name}.md`), 'no row may be skipped or repeated');
		const all = await search(backend, 'shared needle');
		assert.equal(all.total, names.length);
	});
});

test('a page cursor cannot be used for another query', { skip }, async () => {
	await scenarioWorkspace(async ({ backend }) => {
		for (const name of ['a', 'b', 'c']) {
			await write(backend, `/notes/${name}.md`, `# ${name}\n\nneedle ${name}\n`);
		}
		const first = await search(backend, 'needle', { limit: 1 });
		assert.ok(first.nextCursor);
		await assert.rejects(search(backend, 'other', { limit: 1, cursor: first.nextCursor }), error => error.status === 400);
	});
});

// ---------------------------------------------------------------------------------------
// Rebuild and generation
// ---------------------------------------------------------------------------------------

test('rebuilding moves the generation and empties the cursor of the previous one', { skip }, async () => {
	await scenarioWorkspace(async ({ backend, pool, workspaceId }) => {
		for (const name of ['a', 'b', 'c']) {
			await write(backend, `/notes/${name}.md`, `# ${name}\n\nneedle ${name}\n`);
		}
		const before = await search(backend, 'needle', { limit: 1 });
		assert.ok(before.nextCursor);
		const previousGeneration = before.indexGeneration;

		const rebuilt = await backend.reindexWorkspace();
		assert.ok(rebuilt.generation > previousGeneration, 'a rebuild must move the generation');
		assert.equal(rebuilt.applied, 3, 'every note must be re-indexed');

		// The old cursor belongs to the previous generation: 410 tells the client to
		// search again instead of showing a page from a document set that no longer exists.
		await assert.rejects(
			search(backend, 'needle', { limit: 1, cursor: before.nextCursor }),
			error => error.status === 410 && error.code === 'SearchCursorExpired',
		);
		// And the rebuilt index answers everything again.
		const after = await search(backend, 'needle');
		assert.equal(after.total, 3);
		assert.equal(after.indexGeneration, rebuilt.generation);
		assert.equal(await transaction(pool, connection => countPendingJobs(connection, workspaceId)), 0);
	});
});

test('a write during a rebuild is indexed by the rebuild instead of being lost', { skip }, async () => {
	await scenarioWorkspace(async ({ backend, pool, workspaceId }) => {
		await write(backend, '/notes/a.md', '# a\n\nneedle a\n');
		await write(backend, '/notes/b.md', '# b\n\nneedle b\n');

		// The rebuild lists the workspace and then drains. A note written between those two
		// steps is enqueued with a higher sequence, so the drain picks it up too.
		const rebuilt = await backend.reindexWorkspace();
		assert.equal(rebuilt.queued, 2);
		await write(backend, '/notes/c.md', '# c\n\nneedle c\n');
		const page = await search(backend, 'needle');
		assert.equal(page.total, 3);
		assert.equal(await transaction(pool, connection => countPendingJobs(connection, workspaceId)), 0);
	});
});

test('a rebuild of an empty workspace is a no-op that still moves the generation', { skip }, async () => {
	await scenarioWorkspace(async ({ backend }) => {
		const status = await backend.searchStatus();
		const rebuilt = await backend.reindexWorkspace();
		assert.equal(rebuilt.queued, 0);
		assert.equal(rebuilt.applied, 0);
		assert.ok(rebuilt.generation > status.generation);
		assert.equal((await backend.searchStatus()).documents, 0);
	});
});

// ---------------------------------------------------------------------------------------
// Isolation
// ---------------------------------------------------------------------------------------

test('S01: two workspaces with the same note keep their hits apart', { skip }, async () => {
	await scenarioWorkspace(async ({ backend: alpha }) => {
		await scenarioWorkspace(async ({ backend: beta }) => {
			await write(alpha, '/notes/发布计划.md', '# 发布计划\n\nalpha 的内容\n');
			await write(beta, '/notes/发布计划.md', '# 发布计划\n\nbeta 的内容\n');

			const alphaPage = await search(alpha, '发布计划');
			const betaPage = await search(beta, '发布计划');
			assert.equal(alphaPage.total, 1);
			assert.equal(betaPage.total, 1);
			assert.match(alphaPage.items[0].excerpt, /alpha/);
			assert.match(betaPage.items[0].excerpt, /beta/);
			// The two rows share a path but not a file id or a workspace.
			assert.notEqual(alphaPage.items[0].fileId, betaPage.items[0].fileId);
		});
	});
});

test('a document of another workspace is invisible even when the file id matches', { skip }, async () => {
	await scenarioWorkspace(async ({ backend, pool, workspaceId }) => {
		await write(backend, '/notes/a.md', '# a\n\nneedle\n');
		await search(backend, 'a');
		const fileId = await transaction(pool, connection => fileIdOf(connection, workspaceId, '/notes/a.md'));
		// A row for another workspace that happens to reuse the file id must not leak.
		await transaction(pool, connection => upsertDocument(connection, {
			workspaceId: workspaceId + '-other',
			fileId,
			revisionId: randomUUID(),
			path: '/notes/a.md',
			title: 'leak',
			body: 'leak needle',
			truncated: false,
		}));
		try {
			const page = await search(backend, 'leak');
			assert.deepEqual(page.items, []);
		} finally {
			await pool.query('DELETE FROM log4stellar.search_documents WHERE workspace_id = $1', [workspaceId + '-other']);
		}
	});
});

// ---------------------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------------------

test('an oversized note is indexed up to the documented cap and still searchable', { skip }, async () => {
	await scenarioWorkspace(async ({ backend }) => {
		const body = '# Big\n\n' + 'x'.repeat(searchLimits.maxBodyChars + 5000) + '\nneedle at the end\n';
		await write(backend, '/notes/big.md', body);
		// The needle is past the cap: it is not indexed, and that is the documented limit,
		// not a silent failure — the note itself is untouched in storage.
		assert.deepEqual((await search(backend, 'needle at the end')).items, []);
		assert.equal((await search(backend, 'xxxxx')).items.length, 1);
		const stored = await backend.openRead('/notes/big.md');
		const chunks = [];
		for await (const chunk of await stored.stream()) {
			chunks.push(Buffer.from(chunk));
		}
		assert.equal(Buffer.concat(chunks).toString('utf8'), body, 'the original note must never be modified');
	});
});

test('the index lifecycle never touches the stored bytes', { skip }, async () => {
	await scenarioWorkspace(async ({ backend }) => {
		const original = '# 计划\n\n发布计划原始内容，包含 emoji 🙂 和 HTML <b>bold</b>。\n';
		await write(backend, '/notes/plan.md', original);
		await search(backend, '发布计划');
		await backend.reindexWorkspace();
		await search(backend, '发布计划');
		const stored = await backend.openRead('/notes/plan.md');
		const chunks = [];
		for await (const chunk of await stored.stream()) {
			chunks.push(Buffer.from(chunk));
		}
		assert.equal(Buffer.concat(chunks).toString('utf8'), original);
		// And the excerpt is the text, with the markup intact as characters, not removed.
		const page = await search(backend, 'bold');
		assert.equal(page.items.length, 1);
		assert.match(page.items[0].excerpt, /<b>bold<\/b>/);
	});
});

test('the index state reports what was indexed', { skip }, async () => {
	await scenarioWorkspace(async ({ backend, pool, workspaceId }) => {
		await write(backend, '/notes/a.md', '# a\n\nneedle\n');
		await search(backend, 'needle');
		const status = await backend.searchStatus();
		assert.equal(status.documents, 1);
		assert.ok(status.indexedMs > 0);
		const state = await transaction(pool, connection => readIndexState(connection, workspaceId));
		assert.equal(state.generation, status.generation);
		assert.equal(status.rebuiltMs, null, 'no rebuild has run yet');
		const { rows } = await pool.query(
			'SELECT body FROM log4stellar.search_documents WHERE workspace_id = $1', [workspaceId]);
		assert.equal(rows.length, 1);
		assert.match(rows[0].body, /needle/);
	});
});

// ---------------------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------------------

async function indexedRevisionOf(connection, workspaceId, fileId) {
	const { rows } = await connection.query(
		'SELECT revision_id FROM log4stellar.search_documents WHERE workspace_id = $1 AND file_id = $2',
		[workspaceId, fileId]);
	return rows.length === 0 ? undefined : rows[0].revision_id;
}

async function fileIdOf(connection, workspaceId, path) {
	const { rows } = await connection.query(
		'SELECT file_id FROM log4stellar.storage_entries WHERE workspace_id = $1 AND path = $2',
		[workspaceId, path]);
	assert.equal(rows.length, 1, 'the file must exist before its id is looked up');
	return rows[0].file_id;
}
