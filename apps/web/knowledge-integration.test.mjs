import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { Pool } from 'pg';
import { openRustfsWorkspace } from './rustfs-workspace.mjs';
import { authorizeWorkspace } from './workspace-access.mjs';
import { openDirectoryBlobs } from './test-support/directory-blobs.mjs';
import { migrateKnowledge, knowledgeSchemaCurrent } from './knowledge-migrate.mjs';
import { closeKnowledgeStore, openKnowledgeStore } from './knowledge-store.mjs';
import {
	describeNoteIndex,
	planLinkRewrite,
	rebuildKnowledgeIndex,
	updateKnowledgeIndex,
} from './knowledge-indexer.mjs';
import { knowledgeMountPath, serveKnowledgeRequest } from './knowledge-files.mjs';

// End-to-end tests for the knowledge index against real PostgreSQL and a directory-backed
// object store. Opt-in, exactly like the other integration tests:
//
//   LOG4STELLAR_STORAGE_CONFIG=/tmp/l4s-sync-storage.json LOG4STELLAR_IT=1 \
//     node --test --test-concurrency=1 apps/web/knowledge-integration.test.mjs
//
// Every workspace here matches `l4s-it-know-*` and is deleted again, including its blob
// directory and its index rows, so the shared bucket and database stay clean.
const enabled = process.env.LOG4STELLAR_IT === '1';
const skip = enabled ? false : 'set LOG4STELLAR_IT=1 to run the PostgreSQL integration tests';
const maxBytes = 64 * 1024 * 1024;
const configPath = process.env.LOG4STELLAR_STORAGE_CONFIG;

function storageConfig() {
	if (!configPath) {
		throw new Error('Set LOG4STELLAR_STORAGE_CONFIG to run the knowledge integration tests.');
	}
	return JSON.parse(readFileSync(configPath, 'utf8'));
}

function spoolDirectory() {
	return join(dirname(configPath), 'spool');
}

async function readAll(backend, path) {
	const readable = await backend.openRead(path);
	const chunks = [];
	for await (const chunk of await readable.stream()) {
		chunks.push(Buffer.from(chunk));
	}
	return Buffer.concat(chunks);
}

/** Writes one note (creating its directory) and returns its stable file ID and revision. */
async function writeNote(backend, path, body) {
	const parent = path.slice(0, path.lastIndexOf('/')) || '/';
	if (parent !== '/') {
		await backend.createDirectory(parent);
	}
	// A note that already exists must be written against its current revision, otherwise the
	// backend answers 412 FileChanged — the same rule the editor UI follows.
	let etag;
	try {
		etag = (await backend.stat(path)).etag;
	} catch {
		etag = undefined;
	}
	const result = await backend.writeFile(path, Readable.from([Buffer.from(body, 'utf8')]), {
		create: true,
		overwrite: true,
		etag,
		maxBytes,
	});
	return { fileId: result.fileId, revisionId: result.revisionId };
}

/** Creates an empty workspace the same way every other integration test does. */
async function seedWorkspace(workspaceId) {
	const seed = await mkdtemp(join(tmpdir(), 'l4s-know-'));
	try {
		const importer = await openRustfsWorkspace(workspaceId, { importing: true, createBlobs: openDirectoryBlobs });
		try {
			await importer.importDirectory(seed, maxBytes);
		} finally {
			await importer.close();
		}
	} finally {
		await rm(seed, { recursive: true, force: true });
	}
	return openRustfsWorkspace(workspaceId, { createBlobs: openDirectoryBlobs });
}

/**
 * One workspace, one index store, one backend. The workspace is created the same way every other
 * integration test creates one (`importDirectory` on an empty temp root), and the store comes
 * from `openKnowledgeStore()`, which is the production path: it migrates on first use.
 */
async function scenario(work) {
	const settings = storageConfig();
	const workspaceId = 'l4s-it-know-' + randomUUID().replace(/-/g, '').slice(0, 10);
	const pool = new Pool({ connectionTimeoutMillis: 5000, max: 4, ...settings.postgres });
	const seed = await mkdtemp(join(tmpdir(), 'l4s-know-'));
	const importer = await openRustfsWorkspace(workspaceId, { importing: true, createBlobs: openDirectoryBlobs });
	try {
		await importer.importDirectory(seed, maxBytes);
	} finally {
		await importer.close();
	}
	const backend = await openRustfsWorkspace(workspaceId, { createBlobs: openDirectoryBlobs });
	const store = await openKnowledgeStore();
	try {
		await work({ backend, pool, workspaceId, store, scope: { workspaceId, store, backend } });
	} finally {
		await backend.close();
		await clean(pool, workspaceId);
		await pool.end();
		await rm(seed, { recursive: true, force: true });
	}
}

async function clean(pool, workspaceId) {
	// The index rows are a soft reference (no foreign key), so they have to be deleted
	// explicitly — leaving them behind would hand the next run a workspace with stale links.
	for (const table of ['knowledge_links', 'knowledge_tags', 'knowledge_index_state']) {
		const exists = await pool.query('SELECT to_regclass($1) AS present', ['log4stellar.' + table]);
		if (exists.rows[0]?.present) {
			await pool.query(`DELETE FROM log4stellar.${table} WHERE workspace_id = $1`, [workspaceId]);
		}
	}
	// Same order as sync-integration.test.mjs: snapshot and trash entries are keyed by their
	// parent row, then the remaining tables, then the workspace the others reference.
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

/** Drives one /api/knowledge request through the real handler and the real capability facade. */
async function call(backend, store, workspaceId, { method = 'GET', path, query = {}, role = 'owner', body } = {}) {
	const url = path ?? knowledgeMountPath + '/backlinks';
	const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
	const ctx = {
		method,
		path: url,
		query,
		status: undefined,
		body: undefined,
		req: Readable.from(payload ? [payload] : []),
		get: () => '',
		set: () => {},
		is: type => (body !== undefined && type.startsWith('application/json')),
	};
	await serveKnowledgeRequest(ctx, authorizeWorkspace(backend, { role }), backend, workspaceId, store);
	const result = typeof ctx.body === 'object' && ctx.body !== null && !Buffer.isBuffer(ctx.body)
		? ctx.body
		: ctx.body;
	return { status: ctx.status ?? (ctx.body === undefined ? 404 : 200), body: result };
}

// ---------------------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------------------

test('the knowledge migration only adds tables and leaves the storage schema untouched', { skip }, async () => {
	const settings = storageConfig();
	const pool = new Pool({ connectionTimeoutMillis: 5000, max: 2, ...settings.postgres });
	try {
		// The five tables the previous release writes must keep EXACTLY their columns: the index
		// is derived data, so a knowledge release may never alter what a note actually is.
		const expected = {
			storage_entries: ['workspace_id', 'path', 'parent_path', 'name', 'file_id', 'revision_id', 'kind', 'created_ms', 'modified_ms'],
			storage_file_versions: ['workspace_id', 'file_id', 'revision_id', 'parent_revision_id', 'sha256', 'size_bytes', 'created_ms'],
		};
		for (const [table, columns] of Object.entries(expected)) {
			const { rows } = await pool.query(`
				SELECT column_name FROM information_schema.columns
				WHERE table_schema = 'log4stellar' AND table_name = $1
				ORDER BY ordinal_position
			`, [table]);
			assert.deepEqual(rows.map(row => row.column_name), columns, table + ' must keep its columns');
		}
		// Applying the migration twice must be a no-op, and the probe must agree it is current.
		await migrateKnowledge(pool);
		await migrateKnowledge(pool);
		assert.equal(await knowledgeSchemaCurrent(pool), true);
		for (const table of ['knowledge_links', 'knowledge_tags', 'knowledge_index_state']) {
			const { rows } = await pool.query(
				'SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2',
				['log4stellar', table]);
			assert.equal(rows.length, 1, 'missing table ' + table);
		}
		// `column` is a reserved word in PostgreSQL; the column must exist with that exact name.
		const { rows: columnRows } = await pool.query(`
			SELECT 1 FROM information_schema.columns
			WHERE table_schema = 'log4stellar' AND table_name = 'knowledge_links' AND column_name = 'column'
		`);
		assert.equal(columnRows.length, 1, 'knowledge_links.column must exist (quoted identifier)');
	} finally {
		await pool.end();
	}
});

// ---------------------------------------------------------------------------------------
// K01: a name shared by two notes is ambiguous, and nothing is guessed
// ---------------------------------------------------------------------------------------

test('K01: a bare wiki link to a duplicated name is ambiguous and lists this workspace candidates', { skip }, async () => {
	await scenario(async ({ backend, store, workspaceId, scope }) => {
		await writeNote(backend, '/notes/index.md', 'See [[重名]] for details.\n');
		await writeNote(backend, '/x/重名.md', '# X\n');
		await writeNote(backend, '/y/重名.md', '# Y\n');

		const report = await rebuildKnowledgeIndex(scope);
		assert.equal(report.failed.length, 0, JSON.stringify(report.failed));

		const source = await store.readFileByPath(workspaceId, '/notes/index.md');
		const links = await store.listSourceLinks(workspaceId, source.file_id, { limit: 50 });
		assert.equal(links.length, 1);
		assert.equal(links[0].status, 'ambiguous');
		assert.equal(links[0].candidateCount, 2);
		assert.equal(links[0].targetFileId, null, 'an ambiguous link must not store a target');

		// The candidates are the two notes that share the name, nothing else.
		const described = await describeNoteIndex(scope, {
			path: '/notes/index.md',
			fileId: source.file_id,
			revisionId: source.revision_id,
			body: 'See [[重名]] for details.\n',
		});
		const candidates = await store.listCandidateFiles(workspaceId, ['重名', '重名.md']);
		assert.deepEqual(candidates.map(row => row.path), ['/x/重名.md', '/y/重名.md']);

		// And the rename preview offers no rewrite: an ambiguous link has no target identity.
		const plan = await planLinkRewrite(scope, source.file_id, '/notes/moved.md');
		assert.equal(plan.editCount, 0, 'nothing may be rewritten from a name guess');
		assert.equal(plan.affectedFiles.length, 0);

		assert.equal(described.links.length, 1);
	});
});

// ---------------------------------------------------------------------------------------
// K02: only body references are indexed
// ---------------------------------------------------------------------------------------

test('K02: a link inside a code block is not indexed while the same text in prose is', { skip }, async () => {
	await scenario(async ({ backend, store, workspaceId, scope }) => {
		const body = [
			'Prose links to [[target]] here.',
			'',
			'```js',
			'// [[target]] inside a fence',
			'```',
			'',
			'    [[target]] indented code',
			'',
			'Tail [[target]] again.',
		].join('\n');
		await writeNote(backend, '/notes/source.md', body);
		await writeNote(backend, '/notes/target.md', '# Target\n');

		const report = await rebuildKnowledgeIndex(scope);
		assert.equal(report.failed.length, 0, JSON.stringify(report.failed));

		const target = await store.readFileByPath(workspaceId, '/notes/target.md');
		const backlinks = await store.listBacklinks(workspaceId, target.file_id, { limit: 50 });
		// Line 1 is the prose link; the fenced copy (line 4) and the indented copy (line 7) are
		// code and must not be indexed; line 9 is the second prose line.
		assert.deepEqual(backlinks.map(link => [link.line, link.column]), [[1, 16], [9, 6]]);

		const source = await store.readFileByPath(workspaceId, '/notes/source.md');
		const outgoing = await store.listSourceLinks(workspaceId, source.file_id, { limit: 50 });
		assert.equal(outgoing.length, 2, 'the fenced and the indented copy must not be indexed');
		assert.deepEqual(outgoing.map(link => link.status), ['resolved', 'resolved']);

		// Re-indexing never rewrites the note: the bytes on disk are unchanged after a rebuild.
		assert.equal((await readAll(backend, '/notes/source.md')).toString('utf8'), body);
	});
});

// ---------------------------------------------------------------------------------------
// K04: trash and restore, with the stable identity intact
// ---------------------------------------------------------------------------------------

test('K04: a trashed target loses its backlinks and gets them back on restore', { skip }, async () => {
	await scenario(async ({ backend, store, workspaceId, scope }) => {
		await writeNote(backend, '/notes/source.md', 'Points at [[target]].\n');
		const target = await writeNote(backend, '/notes/target.md', '# Target\n');
		await rebuildKnowledgeIndex(scope);

		const before = await call(backend, store, workspaceId, {
			path: knowledgeMountPath + '/backlinks',
			query: { fileId: target.fileId },
		});
		assert.equal(before.status, 200);
		assert.equal(before.body.links.length, 1);
		assert.equal(before.body.links[0].sourcePath, '/notes/source.md');

		// Trash the target. No re-index happens: the stored link row is untouched, only the
		// target entry disappears from storage_entries, which the query notices.
		await backend.delete('/notes/target.md', false);
		const trashed = await call(backend, store, workspaceId, {
			path: knowledgeMountPath + '/backlinks',
			query: { fileId: target.fileId },
		});
		assert.equal(trashed.status, 200);
		assert.deepEqual(trashed.body.links, [], 'a trashed target has no visible backlinks');

		// The broken view reports it as missing, so the UI can list it instead of losing it.
		const broken = await call(backend, store, workspaceId, { path: knowledgeMountPath + '/broken' });
		assert.equal(broken.status, 200);
		assert.deepEqual(broken.body.links.map(link => [link.sourcePath, link.status]), [['/notes/source.md', 'missing']]);

		// Restore it: the same file ID comes back and so does the backlink.
		const trash = await backend.listTrash();
		assert.equal(trash.length, 1);
		await backend.restoreTrash(trash[0].id, false);

		const restored = await call(backend, store, workspaceId, {
			path: knowledgeMountPath + '/backlinks',
			query: { fileId: target.fileId },
		});
		assert.equal(restored.status, 200);
		assert.equal(restored.body.links.length, 1, 'the restored note keeps its stable identity');
		assert.equal(restored.body.links[0].sourceFileId, (await store.readFileByPath(workspaceId, '/notes/source.md')).file_id);

		const afterRestore = await store.readFileByPath(workspaceId, '/notes/target.md');
		assert.equal(afterRestore.file_id, target.fileId, 'restore must preserve the file ID, not mint a new one');
	});
});

// ---------------------------------------------------------------------------------------
// Rename: identity survives the path change
// ---------------------------------------------------------------------------------------

test('a renamed target keeps its backlinks because they are stored against the file ID', { skip }, async () => {
	await scenario(async ({ backend, store, workspaceId, scope }) => {
		await writeNote(backend, '/notes/source.md', 'Points at [[target]].\n');
		const target = await writeNote(backend, '/notes/target.md', '# Target\n');
		await rebuildKnowledgeIndex(scope);

		// The destination directory has to exist: rename moves an entry, it does not create one.
		await backend.createDirectory('/archive');
		await backend.rename('/notes/target.md', '/archive/target.md', false);

		const { status, body } = await call(backend, store, workspaceId, {
			path: knowledgeMountPath + '/backlinks',
			query: { fileId: target.fileId },
		});
		assert.equal(status, 200);
		assert.equal(body.links.length, 1, 'a rename must not drop the backlink');
		assert.equal(body.links[0].sourcePath, '/notes/source.md');

		// The rename preview now reports the stale spelling, so the UI can offer the rewrite.
		const plan = await planLinkRewrite(scope, target.fileId, '/archive/target.md');
		assert.equal(plan.editCount, 1);
		assert.equal(plan.affectedFiles[0].path, '/notes/source.md');
		assert.equal(plan.applicable, true);
	});
});

// ---------------------------------------------------------------------------------------
// K03: a preview taken before another tab saved the source must not overwrite it
// ---------------------------------------------------------------------------------------

test('K03: submitting a rename preview after the source note changed answers 409 and writes nothing', { skip }, async () => {
	await scenario(async ({ backend, store, workspaceId, scope }) => {
		await writeNote(backend, '/notes/source.md', 'Points at [[target]].\n');
		const target = await writeNote(backend, '/notes/target.md', '# Target\n');
		await rebuildKnowledgeIndex(scope);

		// Tab A: the rename preview. The plan names the source revision it was computed against.
		const preview = await call(backend, store, workspaceId, {
			method: 'POST',
			path: knowledgeMountPath + '/rename-plan',
			body: { fileId: target.fileId, newPath: '/archive/target.md' },
		});
		assert.equal(preview.status, 200);
		assert.equal(preview.body.editCount, 1);
		assert.equal(preview.body.applicable, true);
		const expectedRevisions = preview.body.affectedFiles.map(file => ({
			fileId: file.fileId,
			revisionId: file.revisionId,
		}));
		const planId = preview.body.planId;

		// Tab B: somebody edits the source note in the meantime, and the index catches up.
		await writeNote(backend, '/notes/source.md', 'Points at [[target]] and more text.\n');
		await rebuildKnowledgeIndex(scope);
		const edited = await readAll(backend, '/notes/source.md');

		// Tab A: submits the stale preview. Nothing may be overwritten.
		const applied = await call(backend, store, workspaceId, {
			method: 'POST',
			path: knowledgeMountPath + '/rename-apply',
			body: { fileId: target.fileId, newPath: '/archive/target.md', planId, expectedRevisions },
		});
		assert.equal(applied.status, 409);
		assert.ok(['RewriteConflict', 'StalePlan'].includes(applied.body.error), applied.body.error);

		// The source note still holds the text Tab B saved, and the target still lives where it was.
		assert.deepEqual(await readAll(backend, '/notes/source.md'), edited, 'the stale preview must not touch the source');
		assert.equal((await backend.stat('/notes/target.md')).etag, '"' + target.revisionId + '"');
		assert.equal((await store.readFileByPath(workspaceId, '/notes/target.md')).path, '/notes/target.md');
	});
});

// ---------------------------------------------------------------------------------------
// Workspace isolation
// ---------------------------------------------------------------------------------------

test('two workspaces with the same note names never see each other links or tags', { skip }, async () => {
	const settings = storageConfig();
	const suffix = randomUUID().replace(/-/g, '').slice(0, 10);
	const workspaceA = 'l4s-it-know-a-' + suffix;
	const workspaceB = 'l4s-it-know-b-' + suffix;
	const pool = new Pool({ connectionTimeoutMillis: 5000, max: 4, ...settings.postgres });
	const store = await openKnowledgeStore();
	const backendA = await seedWorkspace(workspaceA);
	const backendB = await seedWorkspace(workspaceB);
	try {
		await writeNote(backendA, '/notes/重名.md', 'A links to [[重名]] and carries #alpha.\n');
		await writeNote(backendB, '/notes/重名.md', 'B links to [[重名]] and carries #beta.\n');

		await rebuildKnowledgeIndex({ workspaceId: workspaceA, store, backend: backendA });
		await rebuildKnowledgeIndex({ workspaceId: workspaceB, store, backend: backendB });

		const tagsA = await store.listTags(workspaceA, { limit: 50 });
		const tagsB = await store.listTags(workspaceB, { limit: 50 });
		assert.deepEqual(tagsA.map(tag => tag.tagKey), ['alpha']);
		assert.deepEqual(tagsB.map(tag => tag.tagKey), ['beta']);

		// Both notes link to themselves by name; neither index may resolve into the other tenant.
		const fileA = await store.readFileByPath(workspaceA, '/notes/重名.md');
		const linksA = await store.listSourceLinks(workspaceA, fileA.file_id, { limit: 50 });
		assert.equal(linksA.length, 1);
		assert.equal(linksA[0].status, 'resolved');
		assert.equal(linksA[0].targetFileId, fileA.file_id, 'the name resolves inside its own workspace only');

		const occurrencesA = await store.listTagOccurrences(workspaceA, 'alpha', { limit: 50 });
		assert.equal(occurrencesA.length, 1);
		assert.equal(occurrencesA[0].path, '/notes/重名.md');
	} finally {
		await backendA.close();
		await backendB.close();
		await clean(pool, workspaceA);
		await clean(pool, workspaceB);
		await pool.end();
	}
});

// ---------------------------------------------------------------------------------------
// Index rebuild: idempotent, converging from an empty index, and order-independent
// ---------------------------------------------------------------------------------------

test('a full rebuild converges from an empty index and a second pass changes nothing', { skip }, async () => {
	await scenario(async ({ backend, store, workspaceId, scope }) => {
		await writeNote(backend, '/a.md', 'Link to [[b]] and #tag.\n');
		await writeNote(backend, '/b.md', 'Link back to [A](a.md).\n');

		const first = await rebuildKnowledgeIndex(scope);
		assert.equal(first.indexed, 2);
		assert.equal(first.links, 2);
		assert.equal(first.tags, 1);

		const second = await rebuildKnowledgeIndex(scope);
		assert.equal(second.indexed, 0, 'a converged index must not be rewritten');
		assert.equal(second.skipped, 2);

		// Forcing a rebuild produces the same rows, so a rebuild is safe to run at any time.
		const forced = await rebuildKnowledgeIndex(scope, { force: true });
		assert.equal(forced.indexed, 2);

		const b = await store.readFileByPath(workspaceId, '/b.md');
		const backlinks = await store.listBacklinks(workspaceId, b.file_id, { limit: 50 });
		assert.equal(backlinks.length, 1);
		assert.equal(backlinks[0].sourcePath, '/a.md');

		// A note edited after the index pass is re-parsed on the next one.
		await writeNote(backend, '/a.md', 'Now links to nothing, only #other.\n');
		const incremental = await updateKnowledgeIndex(scope, (await store.readFileByPath(workspaceId, '/a.md')).file_id);
		assert.equal(incremental.indexed, true);
		assert.equal(incremental.linkCount, 0);
		assert.deepEqual((await store.listTags(workspaceId, { limit: 50 })).map(tag => tag.tagKey), ['other']);
		const afterEdit = await store.listBacklinks(workspaceId, b.file_id, { limit: 50 });
		assert.deepEqual(afterEdit, [], 'the removed link must leave the index');
		assert.equal(incremental.revisionId !== undefined, true);
	});
});

// ---------------------------------------------------------------------------------------
// HTTP surface: auth, shapes and error codes
// ---------------------------------------------------------------------------------------

test('the backlinks endpoint answers with source path, revision and position', { skip }, async () => {
	await scenario(async ({ backend, store, workspaceId, scope }) => {
		await writeNote(backend, '/notes/source.md', 'See [B](../notes/target.md#intro).\n');
		const target = await writeNote(backend, '/notes/target.md', '# Target\n');
		await rebuildKnowledgeIndex(scope);

		const { status, body } = await call(backend, store, workspaceId, {
			path: knowledgeMountPath + '/backlinks',
			query: { fileId: target.fileId },
		});
		assert.equal(status, 200);
		assert.equal(body.fileId, target.fileId);
		assert.equal(body.nextCursor, null);
		const [link] = body.links;
		assert.equal(link.sourcePath, '/notes/source.md');
		assert.equal(link.sourceFileId, (await store.readFileByPath(workspaceId, '/notes/source.md')).file_id);
		assert.ok(link.sourceRevisionId);
		assert.equal(link.status, 'resolved');
		assert.equal(link.line, 1);
		assert.equal(link.column, 5);
		assert.equal(link.anchor, 'intro');
	});
});

test('a viewer may read the index but may not write it', { skip }, async () => {
	await scenario(async ({ backend, store, workspaceId }) => {
		const read = await call(backend, store, workspaceId, {
			path: knowledgeMountPath + '/broken',
			role: 'viewer',
		});
		assert.equal(read.status, 200);

		const write = await call(backend, store, workspaceId, {
			method: 'POST',
			path: knowledgeMountPath + '/reindex',
			role: 'viewer',
			body: {},
		});
		assert.equal(write.status, 403);
		assert.equal(write.body.error, 'NoPermissions');

		// The preview only reads, so a viewer is allowed to ask for it.
		const plan = await call(backend, store, workspaceId, {
			method: 'POST',
			path: knowledgeMountPath + '/rename-plan',
			role: 'viewer',
			body: { fileId: randomUUID(), newPath: '/x.md' },
		});
		assert.equal(plan.status, 200);
	});
});

test('an unknown route, a bad body and a bad cursor are refused with stable codes', { skip }, async () => {
	await scenario(async ({ backend, store, workspaceId }) => {
		const missing = await call(backend, store, workspaceId, { path: knowledgeMountPath + '/nope' });
		assert.equal(missing.status, 404);
		assert.equal(missing.body.error, 'NotFound');

		// A GET on a POST-only route is not "authorized by default": it has no route at all.
		const wrongMethod = await call(backend, store, workspaceId, {
			method: 'POST',
			path: knowledgeMountPath + '/backlinks',
			body: {},
		});
		assert.equal(wrongMethod.status, 404);

		const badFileId = await call(backend, store, workspaceId, {
			path: knowledgeMountPath + '/backlinks',
			query: { fileId: 'not-a-uuid' },
		});
		assert.equal(badFileId.status, 400);
		assert.equal(badFileId.body.error, 'InvalidFileId');

		const badCursor = await call(backend, store, workspaceId, {
			path: knowledgeMountPath + '/backlinks',
			query: { fileId: randomUUID(), cursor: 'garbage' },
		});
		assert.equal(badCursor.status, 400);
		assert.equal(badCursor.body.error, 'InvalidCursor');

		const badPage = await call(backend, store, workspaceId, {
			path: knowledgeMountPath + '/broken',
			query: { limit: '0' },
		});
		assert.equal(badPage.status, 400);
		assert.equal(badPage.body.error, 'InvalidPageSize');
	});
});

test('the index routes answer 501 when no store is configured instead of pretending', { skip }, async () => {
	await scenario(async ({ backend, workspaceId }) => {
		// A mount-only deployment has a backend but no index store; the honest answer is
		// "unavailable", not an empty backlink list that would look like "no links".
		const { status, body } = await call(backend, undefined, workspaceId, {
			path: knowledgeMountPath + '/backlinks',
			query: { fileId: randomUUID() },
		});
		assert.equal(status, 501);
		assert.equal(body.error, 'KnowledgeUnavailable');
	});
});

test('the tag endpoints list the cloud and the occurrences of one tag', { skip }, async () => {
	await scenario(async ({ backend, store, workspaceId, scope }) => {
		await writeNote(backend, '/notes/a.md', 'Ideas about #API and #项目/子项.\n');
		await writeNote(backend, '/notes/b.md', 'More #api here.\n');
		await rebuildKnowledgeIndex(scope);

		const cloud = await call(backend, store, workspaceId, { path: knowledgeMountPath + '/tags' });
		assert.equal(cloud.status, 200);
		assert.deepEqual(cloud.body.tags.map(tag => [tag.tagKey, tag.uses]), [['api', 2], ['项目/子项', 1]]);

		const api = await call(backend, store, workspaceId, {
			path: knowledgeMountPath + '/tags/api',
			query: { children: 'false' },
		});
		assert.equal(api.status, 200);
		assert.deepEqual(api.body.occurrences.map(item => item.path), ['/notes/a.md', '/notes/b.md']);

		const subtree = await call(backend, store, workspaceId, {
			path: knowledgeMountPath + '/tags/' + encodeURIComponent('项目'),
			query: { children: 'true' },
		});
		assert.equal(subtree.status, 200);
		assert.deepEqual(subtree.body.occurrences.map(item => item.tagKey), ['项目/子项']);
	});
});

// Keep the module-level store from holding a pool open after the last test.
test.after(() => closeKnowledgeStore());
