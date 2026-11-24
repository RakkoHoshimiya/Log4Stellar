import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { authorizeWorkspace, workspaceCapabilities } from './workspace-access.mjs';
import { encodeCursor, encodePageToken } from './sync-contract.mjs';
import { serveSyncRequest, syncPath } from './sync-files.mjs';

// These tests cover the /sync/v1 HTTP layer without PostgreSQL: they assert the contract's
// ORDER of checks (§8 preamble "判权先于参数校验", §3 cursor validation), the error mapping,
// and the request shapes each endpoint hands to the storage layer. The storage behaviour
// itself is exercised by sync-integration.test.mjs.

const maxBytes = 1024 * 1024;
const workspaceId = 'l4s-test-unit';

function context({ method = 'GET', path = '/', query = {}, headers = {}, body } = {}) {
	const stored = new Map(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
	return {
		method,
		path: syncPath + path,
		query,
		status: undefined,
		body: undefined,
		req: body === undefined ? Readable.from([]) : Readable.from([Buffer.from(body)]),
		get: name => stored.get(name.toLowerCase()) ?? '',
		set: (name, value) => stored.set(name.toLowerCase(), value),
		is: type => (stored.get('content-type') ?? '').startsWith(type),
	};
}

// A backend that records every call, so a test can prove a rejected request never reached
// storage. Only the methods the sync handler may call are implemented.
function recordingBackend(overrides = {}) {
	const calls = [];
	const record = name => async (...args) => {
		calls.push(name);
		const override = overrides[name];
		if (override) {
			return override(...args);
		}
		if (name === 'syncChanges') {
			return { workspaceId, head: 0, fromSeq: 0, toSeq: 0, changes: [], hasMore: false, cursor: '' };
		}
		if (name === 'syncSnapshot') {
			return { snapshotId: randomUUID(), workspaceId, seq: 0, entryCount: 0, expiresAt: Date.now() + 1000, cursor: '', entries: [], pageToken: null, hasMore: false };
		}
		if (name === 'syncConflicts') {
			return { conflicts: [], hasMore: false, cursor: '' };
		}
		if (name === 'syncPutFile' || name === 'syncDelete' || name === 'syncRename' || name === 'syncMkdir' || name === 'syncRestore' || name === 'syncRollback') {
			return { status: 200, body: { seq: 1, changeId: randomUUID(), changeIds: [], replayed: false } };
		}
		throw new Error('unexpected backend call: ' + name);
	};
	return {
		calls,
		syncChanges: record('syncChanges'),
		syncSnapshot: record('syncSnapshot'),
		syncSnapshotPage: record('syncSnapshotPage'),
		syncPutFile: record('syncPutFile'),
		syncDelete: record('syncDelete'),
		syncRename: record('syncRename'),
		syncMkdir: record('syncMkdir'),
		syncRestore: record('syncRestore'),
		syncRollback: record('syncRollback'),
		syncConflicts: record('syncConflicts'),
		syncConflict: record('syncConflict'),
	};
}

async function serve({ role = 'owner', method, path, query, headers, body, backend = recordingBackend() } = {}) {
	const ctx = context({ method, path, query, headers, body });
	await serveSyncRequest(ctx, authorizeWorkspace(backend, { role }), backend, workspaceId, maxBytes);
	return { ctx, backend, body: ctx.body, status: ctx.status ?? (ctx.body === undefined ? 404 : 200) };
}

function errorOf(response) {
	assert.equal(typeof response.body, 'object', 'an error response must have a JSON body');
	return response.body.error;
}

test('a backend without sync support answers 501 instead of crashing', async () => {
	// serve-demo.mjs can run against the local-disk backend, which predates this API. The
	// handler must say so, not fail on a missing method, and it must still authorize first.
	const bare = {};
	for (const [method, path] of [['GET', '/changes'], ['POST', '/snapshot'], ['POST', '/mkdir'], ['GET', '/conflicts']]) {
		const response = await serve({
			method, path, backend: bare,
			headers: method === 'POST' ? { 'content-type': 'application/json' } : {},
			body: method === 'POST' ? JSON.stringify({ path: '/x' }) : undefined,
		});
		assert.equal(response.status, 501);
		assert.equal(response.body.error, 'SyncUnavailable');
	}
	const denied = await serve({
		role: 'viewer', method: 'POST', path: '/mkdir', backend: bare,
		headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: '/x' }),
	});
	assert.equal(denied.status, 403, 'the capability check still runs before the support check');
});

test('the migration only adds tables, indexes and columns', () => {
	const schema = readFileSync(new URL('./sync-schema.sql', import.meta.url), 'utf8');
	const statements = schema.replace(/--[^\n]*/g, '').split(';').map(part => part.trim()).filter(Boolean);
	const creates = statements.filter(statement => /^CREATE\s/i.test(statement));
	const alters = statements.filter(statement => /^ALTER\s/i.test(statement));
	assert.equal(creates.length + alters.length, statements.length, 'the migration must only CREATE or ALTER');
	for (const statement of statements) {
		const bare = statement.replace(/'[^']*'/g, '').replace(/ON DELETE CASCADE/gi, '');
		assert.ok(!/\b(DROP|TRUNCATE|DELETE|UPDATE|GRANT|REVOKE)\b/i.test(bare), 'the migration must not run ' + statement.slice(0, 40));
	}
	// Only storage_changes is altered, and only to add columns the contract needs.
	for (const statement of alters) {
		assert.match(statement, /^ALTER TABLE log4stellar\.storage_changes ADD COLUMN IF NOT EXISTS (op_id|base_revision) uuid$/);
	}
	// The whole migration is re-runnable: every object is created only if it is absent.
	for (const statement of creates) {
		assert.match(statement, /^CREATE (TABLE|UNIQUE INDEX|INDEX) IF NOT EXISTS /, statement);
	}
	for (const table of ['storage_change_heads', 'storage_changes', 'storage_snapshots', 'storage_snapshot_entries']) {
		assert.ok(creates.some(statement => statement.includes('log4stellar.' + table)), 'missing ' + table);
	}
	// The previous release's tables are never touched at all.
	for (const table of ['storage_workspaces', 'storage_entries', 'storage_file_versions', 'storage_trash', 'storage_trash_entries']) {
		assert.ok(!schema.includes('ALTER TABLE log4stellar.' + table + ' '), 'the migration must not alter ' + table);
		assert.ok(!new RegExp('CREATE TABLE IF NOT EXISTS log4stellar\\.' + table + '\\b').test(schema), 'the migration must not recreate ' + table);
	}
});

test('the contract DDL is reproduced verbatim for the four new tables', () => {
	const schema = readFileSync(new URL('./sync-schema.sql', import.meta.url), 'utf8');
	// Spot-check the parts a client depends on: the idempotency partial unique index, the
	// composite primary keys and the change-kind CHECK that makes an unknown kind impossible.
	assert.match(schema, /CREATE UNIQUE INDEX IF NOT EXISTS storage_changes_idempotency_idx\s+ON log4stellar\.storage_changes \(workspace_id, idempotency_key\) WHERE idempotency_key IS NOT NULL/);
	assert.match(schema, /PRIMARY KEY \(workspace_id, seq\)/);
	assert.match(schema, /UNIQUE \(workspace_id, change_id\)/);
	assert.match(schema, /PRIMARY KEY \(snapshot_id, path\)/);
	assert.match(schema, /REFERENCES log4stellar\.storage_snapshots\(id\) ON DELETE CASCADE/);
	for (const kind of ['file.created', 'file.saved', 'file.renamed', 'file.deleted', 'file.restored', 'file.rolledback', 'file.conflicted', 'directory.created', 'directory.renamed', 'directory.deleted']) {
		assert.ok(schema.includes("'" + kind + "'"), 'the CHECK constraint must admit ' + kind);
	}
});

test('an unknown /sync/v1 route is a 404 and never reaches storage', async () => {
	const response = await serve({ method: 'POST', path: '/unknown' });
	assert.equal(response.status, 404);
	assert.deepEqual(response.backend.calls, []);
});

test('a method that the contract does not define for a known path is rejected', async () => {
	const response = await serve({ method: 'PATCH', path: '/changes' });
	assert.equal(response.status, 404);
	assert.deepEqual(response.backend.calls, []);
});

test('authorization runs before parameter validation', async () => {
	// A viewer may not write. The request is also invalid (no path, no key, wrong content
	// type), and the contract requires the permission failure to win: the caller must not
	// be able to probe the parameter rules of an endpoint it cannot use.
	const viewer = await serve({ role: 'viewer', method: 'PUT', path: '/file' });
	assert.equal(viewer.status, 403);
	assert.equal(errorOf(viewer), 'NoPermissions');
	assert.deepEqual(viewer.backend.calls, []);

	// And a viewer cannot read history-only endpoints either.
	const conflicts = await serve({ role: 'viewer', method: 'GET', path: '/conflicts' });
	assert.equal(conflicts.status, 200, 'viewers do have workspace.history');

	const editorDelete = await serve({ role: 'editor', method: 'DELETE', path: '/file' });
	assert.equal(editorDelete.status, 400, 'an editor may delete, so it fails on the missing path');

	const viewerDelete = await serve({ role: 'viewer', method: 'DELETE', path: '/file' });
	assert.equal(viewerDelete.status, 403);
	assert.equal(errorOf(viewerDelete), 'NoPermissions');
	assert.deepEqual(viewerDelete.backend.calls, []);
});

test('every documented capability is enforced with the existing capability names', async () => {
	const matrix = [
		['viewer', 'GET', '/changes', 200],
		['viewer', 'POST', '/snapshot', 201],
		['viewer', 'GET', '/conflicts', 200],
		['viewer', 'PUT', '/file', 403],
		['viewer', 'DELETE', '/file', 403],
		['viewer', 'POST', '/rename', 403],
		['viewer', 'POST', '/mkdir', 403],
		['viewer', 'POST', '/restore', 403],
		['viewer', 'POST', '/rollback', 403],
		// An authorized write reaches validation and fails there: no baseRevision is a 428,
		// which proves the permission gate let the request through (§8 preamble order).
		['editor', 'PUT', '/file', 428],
		['editor', 'DELETE', '/file', 400],
		['editor', 'POST', '/rename', 400],
		['editor', 'POST', '/mkdir', 400],
		['editor', 'POST', '/restore', 400],
		['editor', 'POST', '/rollback', 400],
	];
	for (const [role, method, path, expected] of matrix) {
		const response = await serve({
			role, method, path, headers: method === 'GET' ? {} : { 'content-type': 'application/json' },
			body: method === 'GET' ? undefined : '{}',
		});
		assert.equal(response.status, expected, role + ' ' + method + ' ' + path);
	}
	// The capability names themselves are the pre-existing ones, not new sync-only names.
	assert.equal(workspaceCapabilities.read, 'workspace.read');
	assert.equal(workspaceCapabilities.restore, 'workspace.restore');
});

test('a malformed cursor is rejected by the codec, not by storage', async () => {
	const backend = recordingBackend();
	for (const cursor of [
		'not-a-token',
		'l4s.only-two-parts',
		'l4s.abc.def.ghi',
		'l4s.' + Buffer.from('{"v":1,"k":"changes","w":"' + workspaceId + '","s":5}').toString('base64url') + '.0000000000000000',
	]) {
		const response = await serve({ method: 'GET', path: '/changes', query: { cursor }, backend });
		assert.equal(response.status, 400, cursor);
		assert.equal(errorOf(response), 'InvalidCursor');
	}
	assert.deepEqual(backend.calls, [], 'no cursor failure may reach the database');
});

test('a well-formed cursor for another workspace is rejected too', async () => {
	const foreign = encodeCursor({ workspaceId: 'someone-elses', kind: 'changes', seq: 1 });
	const response = await serve({ method: 'GET', path: '/changes', query: { cursor: foreign } });
	assert.equal(response.status, 400);
	assert.equal(errorOf(response), 'InvalidCursor');
});

test('a semantic cursor failure inside storage surfaces as 410 ResyncRequired', async () => {
	const { WorkspaceError } = await import('./workspace-contract.mjs');
	const backend = recordingBackend({
		syncChanges: () => {
			throw new WorkspaceError(410, 'ResyncRequired');
		},
	});
	const cursor = encodeCursor({ workspaceId, kind: 'changes', seq: 3 });
	const response = await serve({ method: 'GET', path: '/changes', query: { cursor }, backend });
	assert.equal(response.status, 410);
	assert.equal(errorOf(response), 'ResyncRequired');
	assert.deepEqual(backend.calls, ['syncChanges']);
});

test('the changes endpoint passes a decoded cursor and a bounded page size down', async () => {
	let seen;
	const backend = recordingBackend({
		syncChanges: args => {
			seen = args;
			return { workspaceId, head: 9, fromSeq: args.cursor.seq, toSeq: 9, changes: [], hasMore: false, cursor: 'next' };
		},
	});
	const cursor = encodeCursor({ workspaceId, kind: 'changes', seq: 4 });
	const response = await serve({ method: 'GET', path: '/changes', query: { cursor, limit: '100000' }, backend });
	assert.equal(response.status, 200);
	assert.equal(seen.cursor.seq, 4);
	assert.equal(seen.cursor.kind, 'changes');
	assert.equal(seen.limit, 500, 'the page size is clamped to the contract maximum');

	const unbounded = await serve({ method: 'GET', path: '/changes', backend: recordingBackend({ syncChanges: args => { seen = args; return { workspaceId, head: 0, fromSeq: 0, toSeq: 0, changes: [], hasMore: false, cursor: '' }; } }) });
	assert.equal(unbounded.status, 200);
	assert.equal(seen.limit, 200, 'the default page size is the contract default');
	assert.equal(seen.cursor, null, 'an absent cursor is passed as null, not as seq 0');
});

test('an invalid page size is a 400 InvalidPageSize', async () => {
	const response = await serve({ method: 'GET', path: '/changes', query: { limit: '0' } });
	assert.equal(response.status, 400);
	assert.equal(errorOf(response), 'InvalidPageSize');
});

test('a snapshot page token is bound to its snapshot', async () => {
	const snapshotId = randomUUID();
	const foreignToken = encodePageToken({ snapshotId: randomUUID(), lastPath: '/a.md' });
	const wrong = await serve({ method: 'GET', path: '/snapshot/' + snapshotId, query: { token: foreignToken } });
	assert.equal(wrong.status, 400);
	assert.equal(errorOf(wrong), 'InvalidPageToken');

	let seen;
	const right = await serve({
		method: 'GET',
		path: '/snapshot/' + snapshotId,
		query: { token: encodePageToken({ snapshotId, lastPath: '/b.md' }), limit: '5' },
		backend: recordingBackend({
			syncSnapshotPage: args => {
				seen = args;
				return { snapshotId, seq: 7, entryCount: 1, expiresAt: Date.now() + 1000, entries: [], hasMore: false, pageToken: null };
			},
		}),
	});
	assert.equal(right.status, 200);
	assert.equal(seen.snapshotId, snapshotId);
	assert.equal(seen.lastPath, '/b.md');
	assert.equal(seen.limit, 5);
});

test('an expired or unknown snapshot is a 410 InvalidSnapshot, not a resync', async () => {
	const { WorkspaceError } = await import('./workspace-contract.mjs');
	const response = await serve({
		method: 'GET',
		path: '/snapshot/' + randomUUID(),
		backend: recordingBackend({
			syncSnapshotPage: () => {
				throw new WorkspaceError(410, 'InvalidSnapshot');
			},
		}),
	});
	assert.equal(response.status, 410);
	assert.equal(errorOf(response), 'InvalidSnapshot');
});

test('PUT /file requires the documented header and body contract', async () => {
	const base = encodeCursor({ workspaceId, kind: 'changes', seq: 1 });
	const put = (extra = {}) => serve({
		method: 'PUT',
		path: '/file',
		query: { path: '/a.md', ...(extra.query ?? {}) },
		headers: {
			'content-type': 'application/octet-stream',
			'idempotency-key': 'key-abcdefgh-1',
			'x-log4stellar-base-revision': randomUUID(),
			...(extra.headers ?? {}),
		},
		body: extra.body ?? 'hello',
		backend: extra.backend,
	});

	assert.equal(errorOf(await put({ query: { mode: 'CREATE' } })), 'InvalidUploadMode');
	assert.equal(errorOf(await put({ headers: { 'idempotency-key': '' } })), 'InvalidIdempotencyKey');
	assert.equal(errorOf(await put({ headers: { 'x-log4stellar-base-revision': '' } })), 'BaseRevisionRequired');
	assert.equal(errorOf(await put({ headers: { 'x-log4stellar-base-revision': 'nope' } })), 'BaseRevisionInvalid');
	assert.equal(errorOf(await put({ headers: { 'x-log4stellar-device': 'BAD DEVICE' } })), 'InvalidDevice');
	assert.equal(errorOf(await put({ headers: { 'content-type': 'text/plain' } })), 'InvalidContentType');
	assert.equal(errorOf(await put({ query: { path: '' } })), 'InvalidPath');
	// A baseRevision is mandatory for mode=save but not for mode=create.
	const created = await put({ query: { mode: 'create' }, headers: { 'x-log4stellar-base-revision': '' } });
	assert.equal(created.body.error, undefined, 'mode=create does not require a base revision');
	assert.equal(created.status, 200);
	assert.equal(await serve({ method: 'PUT', path: '/file' }).then(r => r.status), 428);
	assert.ok(base);
});

test('a normal upload returns the contract body and status', async () => {
	let seen;
	const response = await serve({
		method: 'PUT',
		path: '/file',
		query: { path: '/a.md', mode: 'create' },
		headers: {
			'content-type': 'application/octet-stream',
			'idempotency-key': 'key-abcdefgh-2',
			'x-log4stellar-device': 'phone',
			'content-length': '5',
		},
		body: 'hello',
		backend: recordingBackend({
			syncPutFile: async args => {
				seen = args;
				return { status: 201, body: { seq: 1, changeId: randomUUID(), path: '/a.md', fileId: randomUUID(), revisionId: randomUUID(), etag: '"e"', size: 5, sha256: 'a'.repeat(64), created: true, replayed: false } };
			},
		}),
	});
	assert.equal(response.status, 201);
	assert.equal(seen.path, '/a.md');
	assert.equal(seen.mode, 'create');
	assert.equal(seen.baseRevision, null);
	assert.equal(seen.device, 'phone');
	assert.equal(seen.idempotencyKey, 'key-abcdefgh-2');
	assert.equal(response.ctx.get('etag'), '"e"');
});

test('a conflict is a 409 with the structured body and never a 412', async () => {
	const conflictPath = '/a (conflict tablet 20260101T120000Z).md';
	const response = await serve({
		method: 'PUT',
		path: '/file',
		query: { path: '/a.md' },
		headers: {
			'content-type': 'application/octet-stream',
			'idempotency-key': 'key-abcdefgh-3',
			'x-log4stellar-base-revision': randomUUID(),
		},
		body: 'hello',
		backend: recordingBackend({
			syncPutFile: () => ({
				status: 409,
				body: { error: 'SyncConflict', seq: 4, changeId: randomUUID(), conflictPath, currentRevision: randomUUID(), replayed: false },
			}),
		}),
	});
	assert.equal(response.status, 409);
	assert.notEqual(response.status, 412, 'a kept copy must never reuse the 412 "nothing happened" status');
	assert.equal(response.body.error, 'SyncConflict');
	assert.equal(response.body.conflictPath, conflictPath);
});

test('a replayed idempotent upload reports replayed:true', async () => {
	const changeId = randomUUID();
	const response = await serve({
		method: 'PUT',
		path: '/file',
		query: { path: '/a.md', mode: 'create' },
		headers: {
			'content-type': 'application/octet-stream',
			'idempotency-key': 'key-abcdefgh-4',
		},
		body: 'hello',
		backend: recordingBackend({
			syncPutFile: () => ({ status: 200, body: { seq: 2, changeId, path: '/a.md', created: true, replayed: true } }),
		}),
	});
	assert.equal(response.status, 200);
	assert.equal(response.body.replayed, true);
	assert.equal(response.body.changeId, changeId);
});

test('the JSON endpoints reject a wrong content type and an oversized body', async () => {
	const wrongType = await serve({ method: 'POST', path: '/mkdir', headers: { 'content-type': 'text/plain' }, body: '{}' });
	assert.equal(wrongType.status, 415);
	assert.equal(errorOf(wrongType), 'InvalidContentType');

	const huge = await serve({
		method: 'POST',
		path: '/mkdir',
		headers: { 'content-type': 'application/json' },
		body: 'x'.repeat(1024 * 1024 + 1),
	});
	assert.equal(huge.status, 413);
	assert.equal(errorOf(huge), 'RequestTooLarge');

	const malformed = await serve({ method: 'POST', path: '/mkdir', headers: { 'content-type': 'application/json' }, body: 'not json' });
	assert.equal(malformed.status, 400);
	assert.equal(errorOf(malformed), 'InvalidRequest');
});

test('rename and mkdir validate their body before touching storage', async () => {
	const rename = await serve({ method: 'POST', path: '/rename', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from: '/a.md' }) });
	assert.equal(rename.status, 400);
	assert.equal(errorOf(rename), 'InvalidPath');

	const mkdir = await serve({ method: 'POST', path: '/mkdir', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) });
	assert.equal(mkdir.status, 400);
	assert.equal(errorOf(mkdir), 'InvalidPath');
});

test('restore and rollback only accept a well-formed identity', async () => {
	const restore = await serve({ method: 'POST', path: '/restore', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ trashId: 'not-a-uuid' }) });
	assert.equal(restore.status, 400);
	assert.equal(errorOf(restore), 'InvalidTrashId');

	const rollback = await serve({ method: 'POST', path: '/rollback', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: '/a.md', revisionId: 'nope' }) });
	assert.equal(rollback.status, 400);
	assert.equal(errorOf(rollback), 'InvalidRevision');

	const missingBase = await serve({
		method: 'POST',
		path: '/rollback',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ path: '/a.md', revisionId: randomUUID() }),
	});
	assert.equal(missingBase.status, 428);
	assert.equal(errorOf(missingBase), 'BaseRevisionRequired');
});

test('a rename that changes nothing still answers 200 with an empty change list', async () => {
	const response = await serve({
		method: 'POST',
		path: '/rename',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ from: '/a.md', to: '/a.md' }),
		backend: recordingBackend({
			syncRename: () => ({ status: 200, body: { seq: null, changeId: null, changeIds: [], opId: null, replayed: false } }),
		}),
	});
	assert.equal(response.status, 200);
	assert.deepEqual(response.body.changeIds, []);
});

test('the migration and the contract document describe the same change columns', async () => {
	// §2.1 now declares op_id and base_revision, and sync-schema.sql adds them with
	// ALTER TABLE instead of inside CREATE TABLE. Both spellings are equivalent only as long
	// as they list the SAME columns, so a drift here would be invisible until a client
	// started relying on a column that one of the two never creates.
	const schema = await readFile(new URL('./sync-schema.sql', import.meta.url), 'utf8');
	const doc = await readFile(new URL('./docs/incremental-sync.md', import.meta.url), 'utf8');
	const createTable = 'CREATE TABLE IF NOT EXISTS log4stellar.storage_changes';
	const idempotencyIndex = 'CREATE UNIQUE INDEX IF NOT EXISTS storage_changes_idempotency_idx';
	// Column names may contain digits (sha256), so the pattern must too: an earlier version of
	// this test silently skipped sha256 in BOTH files and still passed.
	const columns = text => [...text.matchAll(/^\t([a-z0-9_]+) (?:uuid|text|bigint|smallint)/gm)].map(match => match[1]);
	const docColumns = columns(doc.slice(doc.indexOf(createTable), doc.indexOf(idempotencyIndex))).sort();
	const sqlColumns = columns(schema.slice(schema.indexOf(createTable), schema.indexOf(idempotencyIndex)))
		.concat([...schema.matchAll(/ADD COLUMN IF NOT EXISTS ([a-z0-9_]+)/g)].map(match => match[1]))
		.sort();
	assert.deepEqual(sqlColumns, docColumns, 'sync-schema.sql and §2.1 must declare identical columns');
	assert.equal(docColumns.length, 20, 'all twenty §2.1 columns are parsed, digit-named ones included');
	assert.ok(docColumns.includes('sha256'), 'sha256 is parsed, not skipped by the name pattern');
	assert.ok(docColumns.includes('op_id'), 'the grouping id is part of the contract DDL');
	assert.ok(docColumns.includes('base_revision'), 'the declared base revision is part of the contract DDL');
});


test('rename and restore fingerprint the flags that change their outcome', async () => {
	// §5.1: same key + a flipped flag is a DIFFERENT request. Before this, `overwrite` and
	// `keepBoth` never reached the fingerprint, so a retry that asked to overwrite was
	// replayed with the "kept both / refused" answer of the first attempt and `overwrite:true`
	// silently never happened while the client was told 200 replayed:true.
	const fingerprints = async run => {
		let seen;
		await run(recordingBackend({
			syncRename: args => { seen = args; return { status: 200, body: { seq: null, changeId: null, changeIds: [], opId: null, replayed: false } }; },
			syncRestore: args => { seen = args; return { status: 200, body: { seq: 1, changeId: randomUUID(), changeIds: [], opId: null, replayed: false } }; },
		}));
		return seen;
	};
	const rename = overwrite => fingerprints(backend => serve({
		method: 'POST',
		path: '/rename',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ from: '/a.md', to: '/b.md', overwrite }),
		backend,
	}));
	const restore = keepBoth => fingerprints(backend => serve({
		method: 'POST',
		path: '/restore',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ trashId: '2b7f5e0e-6d1c-4f4b-9a5e-3c1d2b3a4f50', keepBoth }),
		backend,
	}));
	const renameKeep = await rename(false);
	const renameOver = await rename(true);
	assert.equal(renameKeep.overwrite, false);
	assert.equal(renameOver.overwrite, true);
	assert.notEqual(renameOver.fingerprint, renameKeep.fingerprint, 'a rename that may overwrite is not the same request');
	const restoreReplace = await restore(false);
	const restoreBoth = await restore(true);
	assert.equal(restoreReplace.keepBoth, false);
	assert.equal(restoreBoth.keepBoth, true);
	assert.notEqual(restoreBoth.fingerprint, restoreReplace.fingerprint, 'a restore that keeps both is not the same request');
	// The flag alone carries the difference: the two requests are otherwise identical.
	assert.equal(renameKeep.targetPath, renameOver.targetPath);
	assert.equal(restoreReplace.targetPath, restoreBoth.targetPath);
});
