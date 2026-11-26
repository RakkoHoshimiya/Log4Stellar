import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import { betterAuth } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

import { createBlobGc, objectKey, openRustfsInventory } from './blob-gc.mjs';
import { createBlobGcStore, lockBlobGcWorkspaceForWrite, migrateBlobGcSchema, readBlobGcWorkspaceCatalog } from './blob-gc-store.mjs';
import { blobGcRetention, workspaceScope } from './blob-retention.mjs';
import { openManagedWorkspaces } from './managed-workspaces.mjs';
import { openDirectoryInventory } from './test-support/directory-inventory.mjs';

// G01–G04 from 06-存储对象清理.md, against real PostgreSQL and a directory-backed object
// store. Opt-in like the other integration tests:
//
//   LOG4STELLAR_STORAGE_CONFIG=/tmp/l4s-gc-storage.json LOG4STELLAR_IT=1 \
//     node --test --test-concurrency=1 apps/web/blob-gc-integration.test.mjs
//
// --test-concurrency=1 matters: the shared database has a 10-connection user, and each
// scenario holds its own pool. Every workspace here matches `l4s-gc-*` and is removed
// again, blobs included, so the shared bucket and database stay clean. No test in this
// file ever talks to a bucket other than the spool directory under the config path.
const enabled = process.env.LOG4STELLAR_IT === '1';
const skip = enabled ? false : 'set LOG4STELLAR_IT=1 to run the PostgreSQL integration tests';
const configPath = process.env.LOG4STELLAR_STORAGE_CONFIG;
const graceMs = blobGcRetention.graceMs;
const dayMs = 24 * 60 * 60 * 1000;
// The directory inventory reports the file's real mtime, which is a few milliseconds after
// the clock the scenario started with, so every advance has to clear the grace period by a
// margin rather than by one millisecond.
const minuteMs = 60 * 1000;

function storageConfig() {
	if (!configPath) {
		throw new Error('Set LOG4STELLAR_STORAGE_CONFIG to run the blob GC integration tests.');
	}
	return JSON.parse(readFileSync(configPath, 'utf8'));
}

function spoolDirectory() {
	return join(dirname(configPath), 'spool');
}

function sha256(bytes) {
	return createHash('sha256').update(bytes).digest('hex');
}

function clock(startMs = Date.now()) {
	let current = startMs;
	return {
		now: () => current,
		advance(ms) { current += ms; return current; },
		get current() { return current; },
	};
}

// Opt in only with a disposable loopback database and a dedicated RustFS bucket.
const realRustfs = process.env.LOG4STELLAR_GC_RUSTFS_IT === '1';

function assertDisposableRustfs({ s3, postgres }) {
	assert.equal(postgres.host, '127.0.0.1');
	assert.equal(postgres.database, 'managed_acceptance');
	assert.equal(new URL(s3.endpoint).hostname, '127.0.0.1');
	assert.equal(s3.bucket, 'l4s-gc-test-acceptance');
}

function openRustfsFixture({ s3 }, workspaceId, tenantId) {
	const inventory = openRustfsInventory(s3, workspaceId, { tenantId });
	const { endpoint, bucket, region, accessKeyId, secretAccessKey } = s3;
	const client = new S3Client({
		endpoint, region, forcePathStyle: true, credentials: { accessKeyId, secretAccessKey },
		requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
	});
	const uploaded = new Set();
	const object = digest => ({ Bucket: bucket, Key: objectKey(workspaceId, digest, { tenantId }) });
	return {
		...inventory,
		async put(digest, bytes) {
			uploaded.add(digest);
			await client.send(new PutObjectCommand({ ...object(digest), Body: bytes, Metadata: { sha256: digest } }));
		},
		async bytes(digest) {
			const { Body } = await client.send(new GetObjectCommand(object(digest)));
			return Buffer.from(await Body.transformToByteArray());
		},
		async digests() {
			const { objects, cursor } = await inventory.list(null);
			assert.equal(cursor, null);
			return objects.map(({ digest }) => digest);
		},
		async close() {
			try {
				await Promise.all([...uploaded].map(digest => client.send(new DeleteObjectCommand(object(digest)))));
			} finally {
				inventory.close();
				client.destroy();
			}
		},
	};
}

/** Everything a scenario needs: a pool, a workspace id, an inventory and its settings. */
async function scenario(work, openInventory = (settings, id) => openDirectoryInventory(settings, id, spoolDirectory())) {
	const settings = storageConfig();
	const workspaceId = 'l4s-gc-' + randomUUID().replace(/-/g, '').slice(0, 12);
	const pool = new Pool({ connectionTimeoutMillis: 5000, max: 4, ...settings.postgres });
	const recoveryDirectory = await mkdtemp(join(tmpdir(), 'l4s-gc-recovery-'));
	try {
		await migrateBlobGcSchema(pool);
		await pool.query('INSERT INTO log4stellar.storage_workspaces (id, created_ms) VALUES ($1, $2)',
			[workspaceId, Date.now()]);
		const inventory = await openInventory(settings, workspaceId);
		const store = createBlobGcStore(pool, { migrate: false });
		try {
			await work({ store, inventory, pool, workspaceId, settings, recoveryDirectory });
		} finally {
			await inventory.close();
		}
	} finally {
		await clean(pool, workspaceId);
		await pool.end();
		await rm(recoveryDirectory, { recursive: true, force: true });
	}
}

async function clean(pool, workspaceId) {
	// GC rows first: gc_candidates references gc_runs, and everything here is workspace-keyed.
	await pool.query('DELETE FROM log4stellar.gc_candidates WHERE workspace_id = $1', [workspaceId]);
	await pool.query('DELETE FROM log4stellar.blob_write_intents WHERE workspace_id = $1', [workspaceId]);
	await pool.query('DELETE FROM log4stellar.blob_holds WHERE workspace_id = $1', [workspaceId]);
	await pool.query('DELETE FROM log4stellar.gc_runs WHERE scope = $1', ['workspace:' + workspaceId]);
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

/** Writes a file row plus its version row, exactly as rustfs-workspace.mjs would. */
async function insertFile(pool, workspaceId, { path, digest, sizeBytes, createdMs }) {
	const fileId = randomUUID();
	const revisionId = randomUUID();
	const name = path.split('/').pop();
	const parentPath = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : null;
	await pool.query(
		`INSERT INTO log4stellar.storage_entries
			(workspace_id, path, parent_path, name, file_id, revision_id, kind, created_ms, modified_ms)
		 VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $7)`,
		[workspaceId, path, parentPath, name, fileId, revisionId, createdMs]);
	await pool.query(
		`INSERT INTO log4stellar.storage_file_versions
			(workspace_id, file_id, revision_id, parent_revision_id, sha256, size_bytes, created_ms)
		 VALUES ($1, $2, $3, NULL, $4, $5, $6)`,
		[workspaceId, fileId, revisionId, digest, sizeBytes, createdMs]);
	return { fileId, revisionId };
}

function settingsFor({ apply = false, recoveryDirectory = null, time }) {
	return Object.freeze({
		graceMs,
		intentTtlMs: blobGcRetention.intentTtlMs,
		maxInventoryPage: blobGcRetention.maxInventoryPage,
		maxSweepBatch: blobGcRetention.maxSweepBatch,
		apply,
		recoveryDirectory,
		workspaces: [],
		now: time?.current,
	});
}

/**
 * A workspace holding one object of each kind the reference query has to recognise, plus
 * one true orphan. `objects` maps a role to the digest that was uploaded for it.
 */
async function seedMixedWorkspace({ store, inventory, pool, workspaceId, time }) {
	const bytes = {
		active: Buffer.from('active file v1'),
		history: Buffer.from('history file v1'),
		inTrash: Buffer.from('trashed file'),
		inSnapshot: Buffer.from('file inside a live snapshot'),
		inChanges: Buffer.from('file inside the replay window'),
		orphan: Buffer.from('orphan that nothing references'),
	};
	const objects = {};
	for (const [role, content] of Object.entries(bytes)) {
		objects[role] = sha256(content);
		await inventory.put(objects[role], content);
	}

	// 1. A live file: storage_entries + storage_file_versions both point at it.
	await insertFile(pool, workspaceId, {
		path: 'notes/active.md', digest: objects.active, sizeBytes: bytes.active.length, createdMs: time.current,
	});

	// 2. A historical version: no entry points at this revision, but the version row is
	//    still there, which is what protects "历史版本".
	const history = await insertFile(pool, workspaceId, {
		path: 'notes/history.md', digest: objects.history, sizeBytes: bytes.history.length, createdMs: time.current,
	});
	await pool.query('DELETE FROM log4stellar.storage_entries WHERE workspace_id = $1 AND path = $2',
		[workspaceId, 'notes/history.md']);

	// 3. A file in the trash: storage_trash + storage_trash_entries + its version.
	const trashed = await insertFile(pool, workspaceId, {
		path: 'notes/trashed.md', digest: objects.inTrash, sizeBytes: bytes.inTrash.length, createdMs: time.current,
	});
	await pool.query('DELETE FROM log4stellar.storage_entries WHERE workspace_id = $1 AND path = $2',
		[workspaceId, 'notes/trashed.md']);
	const trashId = randomUUID();
	await pool.query(
		'INSERT INTO log4stellar.storage_trash (id, workspace_id, original_path, deleted_ms) VALUES ($1, $2, $3, $4)',
		[trashId, workspaceId, 'notes/trashed.md', time.current]);
	await pool.query(
		`INSERT INTO log4stellar.storage_trash_entries
			(trash_id, path, file_id, revision_id, kind, created_ms, modified_ms)
		 VALUES ($1, $2, $3, $4, 1, $5, $5)`,
		[trashId, 'notes/trashed.md', trashed.fileId, trashed.revisionId, time.current]);

	// 4. A file reachable only through a live snapshot (sync replay).
	const snapshotId = randomUUID();
	await pool.query(
		`INSERT INTO log4stellar.storage_snapshots (id, workspace_id, seq, entry_count, created_ms, expires_ms)
		 VALUES ($1, $2, 1, 1, $3, $4)`,
		[snapshotId, workspaceId, time.current, time.current + 10 * dayMs]);
	await pool.query(
		`INSERT INTO log4stellar.storage_snapshot_entries
			(snapshot_id, path, kind, file_id, revision_id, sha256, size_bytes, modified_ms)
		 VALUES ($1, $2, 1, $3, $4, $5, $6, $7)`,
		[snapshotId, 'notes/snap.md', randomUUID(), randomUUID(), objects.inSnapshot, bytes.inSnapshot.length, time.current]);

	// 5. A file reachable only through the change log inside the replay window.
	await pool.query(
		`INSERT INTO log4stellar.storage_changes
			(workspace_id, seq, change_id, kind, entry_kind, path, file_id, revision_id, sha256, size_bytes, created_ms)
		 VALUES ($1, 1, $2, 'file.saved', 1, $3, $4, $5, $6, $7, $8)`,
		[workspaceId, randomUUID(), 'notes/changed.md', randomUUID(), randomUUID(),
			objects.inChanges, bytes.inChanges.length, time.current]);

	return { objects, bytes, history, trashed, snapshotId };
}

function collectorFor({ store, inventory, time, apply = false, recoveryDirectory = null, logger }) {
	return createBlobGc({
		store,
		inventory,
		settings: settingsFor({ apply, recoveryDirectory, time }),
		now: time.now,
		logger,
	});
}

// ---------------------------------------------------------------------------------------
// G01 — a read-only inventory run lists only true orphans and writes no storage
// ---------------------------------------------------------------------------------------

test('G01: plan lists only the true orphan and deletes nothing', { skip }, async () => {
	await scenario(async ({ store, inventory, pool, workspaceId, recoveryDirectory }) => {
		const time = clock();
		const { objects, bytes } = await seedMixedWorkspace({ store, inventory, pool, workspaceId, time });
		const collector = collectorFor({ store, inventory, time });

		const summary = await collector.plan(workspaceScope(workspaceId));
		assert.equal(summary.scanned, 6);
		assert.equal(summary.candidates, 1, 'exactly one object is genuinely unreferenced');
		assert.equal(summary.candidateBytes, bytes.orphan.length);
		assert.equal(summary.deleted, 0);

		// The machine-checkable form of "存储零写操作".
		assert.equal(inventory.calls.delete, 0);
		assert.equal(inventory.calls.copy, 0);

		const { rows } = await pool.query(
			'SELECT digest, state FROM log4stellar.gc_candidates WHERE workspace_id = $1 ORDER BY digest',
			[workspaceId]);
		assert.deepEqual(rows.map(row => row.digest), [objects.orphan]);
		assert.equal(rows[0].state, 'observed');

		// A candidate is metadata only: every object, including the orphan, is still there.
		assert.equal((await inventory.digests()).length, 6);
		// And the run itself is recorded as a dry run.
		const { rows: runs } = await pool.query(
			'SELECT mode, dry_run, state FROM log4stellar.gc_runs WHERE scope = $1',
			[workspaceScope(workspaceId)]);
		assert.equal(runs.length, 1);
		assert.equal(runs[0].mode, 'plan');
		assert.equal(runs[0].dry_run, true);
		assert.equal(runs[0].state, 'completed');
		assert.ok(recoveryDirectory);

		// Independent confirmation by re-reading the protecting rows: each protected digest
		// really does appear in the table that is supposed to protect it.
		const reference = await store.isReferenced(workspaceId, objects.history, { nowMs: time.current });
		assert.deepEqual(reference.blockers, ['versions']);
		const trashed = await store.isReferenced(workspaceId, objects.inTrash, { nowMs: time.current });
		assert.ok(trashed.blockers.includes('trash'));
		const snapshot = await store.isReferenced(workspaceId, objects.inSnapshot, { nowMs: time.current });
		assert.deepEqual(snapshot.blockers, ['snapshots']);
		const changed = await store.isReferenced(workspaceId, objects.inChanges, { nowMs: time.current });
		assert.deepEqual(changed.blockers, ['changes']);
		const orphan = await store.isReferenced(workspaceId, objects.orphan, { nowMs: time.current });
		assert.equal(orphan.referenced, false);
	});
});

test('G01b: with the switch off, apply is a dry run that deletes nothing', { skip }, async () => {
	await scenario(async ({ store, inventory, pool, workspaceId }) => {
		const time = clock();
		const { objects } = await seedMixedWorkspace({ store, inventory, pool, workspaceId, time });
		// The switch is off (settings.apply === false), which is the shipped default.
		const collector = collectorFor({ store, inventory, time, apply: false });

		await collector.plan(workspaceScope(workspaceId));
		time.advance(graceMs + minuteMs);
		await collector.review(workspaceScope(workspaceId));
		const summary = await collector.apply(workspaceScope(workspaceId));
		assert.equal(summary.dryRun, true);
		assert.equal(summary.wouldDelete, 1);
		assert.equal(summary.deleted, 0);
		assert.equal(inventory.calls.delete, 0, 'a dry run must not request one delete');
		assert.equal(inventory.calls.copy, 0, 'a dry run must not even make a recovery copy');
		assert.ok((await inventory.digests()).includes(objects.orphan));

		const { rows } = await pool.query(
			'SELECT state FROM log4stellar.gc_candidates WHERE workspace_id = $1', [workspaceId]);
		assert.deepEqual(rows.map(row => row.state), ['eligible'], 'the candidate stays queued for review');
		const { rows: runs } = await pool.query(
			'SELECT dry_run FROM log4stellar.gc_runs WHERE scope = $1 AND mode = $2',
			[workspaceScope(workspaceId), 'apply']);
		assert.deepEqual(runs.map(row => row.dry_run), [true]);
	});
});

// ---------------------------------------------------------------------------------------
// G02 — the shared fence decides the order when the same digest is written again
// ---------------------------------------------------------------------------------------

test('G02: a candidate re-referenced by a write intent is cancelled, never deleted', { skip }, async () => {
	await scenario(async ({ store, inventory, pool, workspaceId, recoveryDirectory }) => {
		const time = clock();
		const { objects } = await seedMixedWorkspace({ store, inventory, pool, workspaceId, time });
		const collector = collectorFor({ store, inventory, time, apply: true, recoveryDirectory });

		await collector.plan(workspaceScope(workspaceId));
		time.advance(graceMs + minuteMs);
		await collector.review(workspaceScope(workspaceId));

		// The writer half of the race: an upload for the same digest registers an intent
		// before it touches the object, exactly as the task book requires.
		await store.registerIntent({
			workspaceId,
			digest: objects.orphan,
			writerId: 'writer-g02',
			createdMs: time.current,
			expiresMs: time.current + 15 * 60 * 1000,
		});

		const summary = await collector.apply(workspaceScope(workspaceId));
		assert.equal(summary.cancelled, 1);
		assert.equal(summary.deleted, 0);
		assert.equal(inventory.calls.delete, 0, 'a live write intent must protect the object');
		assert.ok((await inventory.digests()).includes(objects.orphan));

		const { rows } = await pool.query(
			'SELECT state, reason FROM log4stellar.gc_candidates WHERE workspace_id = $1', [workspaceId]);
		assert.equal(rows[0].state, 'cancelled');
		assert.match(rows[0].reason, /referenced:.*intents/);

		// Once the writer commits its metadata and releases the intent, the object is still
		// protected — now by the version row it just wrote. Fence order is what makes this
		// deterministic: the intent is visible to the collector's re-check.
		await store.releaseIntent({ workspaceId, digest: objects.orphan, writerId: 'writer-g02' });
		await insertFile(pool, workspaceId, {
			path: 'notes/rewritten.md', digest: objects.orphan,
			sizeBytes: objects.orphan.length, createdMs: time.current,
		});
		const after = await store.isReferenced(workspaceId, objects.orphan, { nowMs: time.current });
		assert.equal(after.referenced, true);
		assert.ok(after.blockers.includes('versions'));
		assert.ok(after.blockers.includes('entries'));
	});
});

test('G02b: a hold from a verified backup protects a digest the metadata no longer mentions', { skip }, async () => {
	await scenario(async ({ store, inventory, pool, workspaceId, recoveryDirectory }) => {
		const time = clock();
		const { objects } = await seedMixedWorkspace({ store, inventory, pool, workspaceId, time });
		const collector = collectorFor({ store, inventory, time, apply: true, recoveryDirectory });
		await collector.plan(workspaceScope(workspaceId));
		// A backup that proved readability of every object takes a hold on each digest.
		await store.createHold({
			scope: 'backup:l4s-backup-g02b',
			workspaceId,
			digest: objects.orphan,
			reason: 'verified backup manifest',
			createdMs: time.current,
			expiresMs: null,
		});
		time.advance(graceMs + minuteMs);
		await collector.review(workspaceScope(workspaceId));
		const summary = await collector.apply(workspaceScope(workspaceId));
		assert.equal(summary.deleted, 0);
		assert.equal(inventory.calls.delete, 0);
		const { rows } = await pool.query(
			'SELECT state FROM log4stellar.gc_candidates WHERE workspace_id = $1', [workspaceId]);
		assert.equal(rows[0].state, 'cancelled');
	});
});

// ---------------------------------------------------------------------------------------
// G03 — a crashed delete is resumed by object identity and never removes a rebuilt object
// ---------------------------------------------------------------------------------------

test('G03: resume after a crash finishes the delete only when the identity still matches', { skip }, async () => {
	await scenario(async ({ store, inventory, pool, workspaceId, recoveryDirectory }) => {
		const time = clock();
		const { objects } = await seedMixedWorkspace({ store, inventory, pool, workspaceId, time });
		const collector = collectorFor({ store, inventory, time, apply: true, recoveryDirectory });

		await collector.plan(workspaceScope(workspaceId));
		time.advance(graceMs + minuteMs);
		await collector.review(workspaceScope(workspaceId));

		// The worker dies between the fence commit and the provider call: `deleting` is
		// durable, the object is untouched.
		const run = await store.beginRun({
			scope: workspaceScope(workspaceId), mode: 'apply', dryRun: false, startedMs: time.current,
		});
		const [candidate] = await store.listCandidates(workspaceId, { states: ['eligible'] });
		assert.ok(candidate.objectVersion, 'the fence records the identity it observed');
		await store.transitionCandidate({
			workspaceId, digest: objects.orphan, from: ['eligible'], to: 'deleting',
			objectVersion: candidate.objectVersion,
			recoveryPath: join(recoveryDirectory, workspaceId, objects.orphan),
			updatedMs: time.current,
		});
		const inFlight = await store.listCandidates(workspaceId, { states: ['deleting'] });
		assert.equal(inFlight.length, 1);

		// Meanwhile the object is rebuilt: same key, different bytes. A naive resume would
		// delete live data here.
		await inventory.rewrite(objects.orphan, Buffer.from('a completely different object'));
		const resumed = await collector.resume(run.runId);
		assert.equal(resumed.deleted, 0);
		assert.equal(resumed.cancelled, 1);
		assert.equal(inventory.calls.delete, 0);
		assert.ok((await inventory.digests()).includes(objects.orphan), 'the rebuilt object must survive');
		const { rows } = await pool.query(
			'SELECT state, reason FROM log4stellar.gc_candidates WHERE workspace_id = $1', [workspaceId]);
		assert.equal(rows[0].state, 'cancelled');
		assert.equal(rows[0].reason, 'object-identity-changed');
	});
});

test('G03b: resume completes an interrupted delete and stays idempotent when it is repeated', { skip }, async () => {
	await scenario(async ({ store, inventory, pool, workspaceId, recoveryDirectory }) => {
		const time = clock();
		const { objects } = await seedMixedWorkspace({ store, inventory, pool, workspaceId, time });
		const collector = collectorFor({ store, inventory, time, apply: true, recoveryDirectory });

		await collector.plan(workspaceScope(workspaceId));
		time.advance(graceMs + minuteMs);
		await collector.review(workspaceScope(workspaceId));
		const run = await store.beginRun({
			scope: workspaceScope(workspaceId), mode: 'apply', dryRun: false, startedMs: time.current,
		});
		const [candidate] = await store.listCandidates(workspaceId, { states: ['eligible'] });
		await store.transitionCandidate({
			workspaceId, digest: objects.orphan, from: ['eligible'], to: 'deleting',
			objectVersion: candidate.objectVersion,
			recoveryPath: join(recoveryDirectory, workspaceId, objects.orphan),
			updatedMs: time.current,
		});
		// The provider call did happen before the crash, but the result was never recorded.
		await inventory.deleteExact(objects.orphan, null);

		const first = await collector.resume(run.runId);
		assert.equal(first.alreadyMissing >= 1 || first.deleted >= 1, true);
		const { rows } = await pool.query(
			'SELECT state FROM log4stellar.gc_candidates WHERE workspace_id = $1', [workspaceId]);
		assert.equal(rows[0].state, 'deleted', 'an object that is already gone is a success, not a failure');

		// Replaying the same resume must not fail the candidate because the object vanished.
		const second = await collector.resume(run.runId);
		assert.equal(second.failed, 0);
		assert.equal(inventory.calls.delete <= 2, true);
		const after = await pool.query(
			'SELECT state FROM log4stellar.gc_candidates WHERE workspace_id = $1', [workspaceId]);
		assert.equal(after.rows[0].state, 'deleted');
	});
});

// ---------------------------------------------------------------------------------------
// G04 — a deleted sample can be restored byte-for-byte and every protected object is intact
// ---------------------------------------------------------------------------------------

async function verifyRemovalAndRecovery(openInventory) {
	await scenario(async ({ store, inventory, pool, workspaceId, recoveryDirectory }) => {
		const time = clock();
		const { objects, bytes } = await seedMixedWorkspace({ store, inventory, pool, workspaceId, time });
		// Hash every protected object before the run: the acceptance criterion is "全部保护
		// 对象可读且字节不变".
		const protectedRoles = ['active', 'history', 'inTrash', 'inSnapshot', 'inChanges'];
		const before = new Map();
		for (const role of protectedRoles) before.set(objects[role], await inventory.bytes(objects[role]));

		const collector = collectorFor({ store, inventory, time, apply: true, recoveryDirectory });
		await collector.plan(workspaceScope(workspaceId));
		time.advance(graceMs + minuteMs);
		await collector.review(workspaceScope(workspaceId));
		const summary = await collector.apply(workspaceScope(workspaceId));
		assert.equal(summary.deleted, 1);
		assert.equal(summary.deletedBytes, bytes.orphan.length);
		assert.equal(await inventory.head(objects.orphan), null);
		if (inventory.calls) {
			assert.equal(inventory.calls.delete, 1);
			assert.equal(inventory.calls.copy, 1);
		}
		assert.ok(!(await inventory.digests()).includes(objects.orphan));

		// Every protected object is still readable and byte-identical.
		for (const role of protectedRoles) {
			const digest = objects[role];
			assert.ok((await inventory.digests()).includes(digest), role + ' must still be present');
			assert.deepEqual(await inventory.bytes(digest), before.get(digest), role + ' must be byte-identical');
			assert.equal(sha256(await inventory.bytes(digest)), digest, role + ' must still hash to its digest');
		}

		// The recovery copy holds exactly the deleted bytes, so the sample restores.
		const { rows } = await pool.query(
			'SELECT recovery_path, size_bytes FROM log4stellar.gc_candidates WHERE workspace_id = $1 AND digest = $2',
			[workspaceId, objects.orphan]);
		assert.equal(rows.length, 1);
		const copy = await readFile(rows[0].recovery_path);
		assert.equal(sha256(copy), objects.orphan, 'the recovery copy must hash to the deleted digest');
		assert.deepEqual(copy, bytes.orphan);
		assert.equal(Number(rows[0].size_bytes), bytes.orphan.length);

		// And restoring it into the store yields the original object again.
		await inventory.put(objects.orphan, copy);
		assert.equal(sha256(await inventory.bytes(objects.orphan)), objects.orphan);

		// The run row records what was actually removed.
		const { rows: runs } = await pool.query(
			'SELECT deleted_count, deleted_bytes, dry_run, state FROM log4stellar.gc_runs WHERE scope = $1 AND mode = $2',
			[workspaceScope(workspaceId), 'apply']);
		assert.equal(runs.length, 1);
		assert.equal(Number(runs[0].deleted_count), 1);
		assert.equal(Number(runs[0].deleted_bytes), bytes.orphan.length);
		assert.equal(runs[0].dry_run, false);
		assert.equal(runs[0].state, 'completed');
	}, openInventory);
}

test('G04: the deleted object round-trips from the recovery copy, and protected bytes are unchanged', { skip },
	() => verifyRemovalAndRecovery());

test('G04: real RustFS delete and restore preserve all referenced bytes',
	{ skip: skip || (!realRustfs && 'set LOG4STELLAR_GC_RUSTFS_IT=1 with the dedicated RustFS fixture') },
	async () => {
		assertDisposableRustfs(storageConfig());
		await verifyRemovalAndRecovery(openRustfsFixture);
	});

test('managed RustFS cleanup protects other namespaces and a concurrent writer before deleting and restoring',
	{ skip: skip || (!realRustfs && 'set LOG4STELLAR_GC_RUSTFS_IT=1 with the dedicated RustFS fixture') },
	async () => {
		assertDisposableRustfs(storageConfig());
		await scenario(async ({ pool, workspaceId, settings, recoveryDirectory }) => {
			const auth = betterAuth({
				baseURL: 'https://127.0.0.1', database: pool,
				secret: 'disposable-integration-fixture-no-production-data',
			});
			await (await getMigrations(auth.options)).runMigrations();
			await openManagedWorkspaces(pool);
			const tenant = () => 'tenant-' + randomUUID().replaceAll('-', '');
			const [tenantId, otherTenantId] = [tenant(), tenant()];
			await pool.query("INSERT INTO log4stellar.managed_tenants (id, name) VALUES ($1, 'Alpha'), ($2, 'Beta')",
				[tenantId, otherTenantId]);
			await pool.query("INSERT INTO log4stellar.managed_workspaces (id, tenant_id, name) VALUES ($1, $2, 'Notes')",
				[workspaceId, tenantId]);
			const catalog = await readBlobGcWorkspaceCatalog(pool, { managed: true });
			assert.equal(catalog.get(workspaceId), tenantId);
			assert.ok(![...catalog.values()].includes(undefined));
			const store = createBlobGcStore(pool, { migrate: false, workspaceCatalog: catalog });
			await assert.rejects(store.workspacesForScope('workspace:unknown-fixture'), { code: 'blob_gc_workspace_not_found' });

			const own = openRustfsFixture(settings, workspaceId, tenantId);
			const foreign = openRustfsFixture(settings, workspaceId, otherTenantId);
			const legacy = openRustfsFixture(settings, workspaceId);
			const time = clock();
			const scope = workspaceScope(workspaceId);
			const collector = collectorFor({ store, inventory: own, time, apply: true, recoveryDirectory });
			try {
				const { objects, bytes } = await seedMixedWorkspace({ store, inventory: own, pool, workspaceId, time });
				await foreign.put(objects.orphan, bytes.orphan);
				await legacy.put(objects.orphan, bytes.orphan);
				const { stdout } = await promisify(execFile)(process.execPath, [
					fileURLToPath(new URL('./blob-gc.mjs', import.meta.url)), 'plan', scope,
				], {
					env: { ...process.env, LOG4STELLAR_MANAGED_TENANTS: '1', LOG4STELLAR_BLOB_GC_APPLY: '0' },
				});
				const planned = JSON.parse(stdout);
				assert.equal(planned.scanned, 6, 'the operator command must scan only the catalog namespace');
				assert.equal(planned.candidates, 1);
				const old = await legacy.head(objects.orphan);
				const oldStart = time.current - graceMs - minuteMs;
				await store.observeCandidate({
					workspaceId, digest: objects.orphan, objectVersion: old.version, sizeBytes: old.sizeBytes,
					reason: 'legacy fixture', firstSeenMs: oldStart, eligibleAfterMs: oldStart + graceMs,
				});
				await collector.review(scope);
				assert.equal((await collector.apply(scope)).deleted, 0, 'legacy observation cannot authorize managed deletion');
				assert.ok(await own.head(objects.orphan));

				const arriving = Buffer.from('uploaded before the new database reference is committed');
				const arrivingDigest = sha256(arriving);
				await own.put(arrivingDigest, arriving);
				assert.equal((await collector.plan(scope)).candidates, 2);
				assert.equal((await store.findCandidate(workspaceId, objects.orphan)).firstSeenMs, time.current);
				assert.equal((await collector.review(scope)).promoted, 0);
				time.advance(graceMs + minuteMs);
				await collector.review(scope);

				const writer = await pool.connect();
				let apply;
				try {
					await writer.query('BEGIN');
					await lockBlobGcWorkspaceForWrite(writer, workspaceId);
					apply = collector.apply(scope);
					void apply.catch(() => {});
					const { rows: [{ pid }] } = await writer.query('SELECT pg_backend_pid() AS pid');
					let blocked = false;
					for (let attempt = 0; attempt < 80 && !blocked; attempt++) {
						const { rows } = await writer.query(`
							SELECT EXISTS (SELECT 1 FROM pg_stat_activity
							WHERE wait_event = 'advisory' AND $1 = ANY(pg_blocking_pids(pid))) AS blocked
						`, [pid]);
						blocked = rows[0].blocked;
						if (!blocked) await delay(25);
					}
					assert.equal(blocked, true, 'the collector must wait for the in-progress writer transaction');
					await insertFile(writer, workspaceId, {
						path: 'arriving.md', digest: arrivingDigest, sizeBytes: arriving.length, createdMs: time.current,
					});
					await writer.query('COMMIT');
				} finally {
					await writer.query('ROLLBACK').catch(() => {});
					writer.release();
				}
				const result = await apply;
				assert.equal(result.deleted, 1);
				assert.equal(result.cancelled, 1);
				assert.equal(await own.head(objects.orphan), null);
				assert.deepEqual(await own.bytes(arrivingDigest), arriving);
				assert.deepEqual(await foreign.bytes(objects.orphan), bytes.orphan);
				assert.deepEqual(await legacy.bytes(objects.orphan), bytes.orphan);
				for (const role of ['active', 'history', 'inTrash', 'inSnapshot', 'inChanges']) {
					assert.deepEqual(await own.bytes(objects[role]), bytes[role]);
				}
				const removed = await store.findCandidate(workspaceId, objects.orphan);
				assert.equal(removed.state, 'deleted');
				const recovered = await readFile(removed.recoveryPath);
				assert.deepEqual(recovered, bytes.orphan);
				await own.put(objects.orphan, recovered);
				assert.deepEqual(await own.bytes(objects.orphan), bytes.orphan);
			} finally {
				await Promise.all([own.close(), foreign.close(), legacy.close()]);
				await pool.query('DELETE FROM log4stellar.managed_workspaces WHERE id = $1', [workspaceId]);
				await pool.query('DELETE FROM log4stellar.managed_tenants WHERE id = ANY($1::text[])', [[tenantId, otherTenantId]]);
			}
		});
	});

// ---------------------------------------------------------------------------------------
// The migration and the log discipline, against the real database
// ---------------------------------------------------------------------------------------

test('the GC migration is additive and repeatable and leaves the storage tables untouched', { skip }, async () => {
	const settings = storageConfig();
	const pool = new Pool({ connectionTimeoutMillis: 5000, max: 2, ...settings.postgres });
	try {
		await migrateBlobGcSchema(pool);
		await migrateBlobGcSchema(pool); // idempotent, like the other storage migrations
		const expected = {
			gc_runs: ['run_id', 'scope', 'mode', 'dry_run', 'state', 'inventory_cursor', 'candidate_count',
				'candidate_bytes', 'deleted_count', 'deleted_bytes', 'started_ms', 'updated_ms'],
			gc_candidates: ['workspace_id', 'digest', 'object_version', 'size_bytes', 'run_id', 'state', 'reason',
				'first_seen_ms', 'eligible_after_ms', 'updated_ms', 'recovery_path', 'last_error'],
			blob_write_intents: ['workspace_id', 'digest', 'writer_id', 'created_ms', 'expires_ms'],
			blob_holds: ['hold_id', 'scope', 'workspace_id', 'digest', 'reason', 'created_ms', 'expires_ms'],
		};
		for (const [table, columns] of Object.entries(expected)) {
			const { rows } = await pool.query(`
				SELECT column_name FROM information_schema.columns
				WHERE table_schema = 'log4stellar' AND table_name = $1
				ORDER BY ordinal_position
			`, [table]);
			assert.deepEqual(rows.map(row => row.column_name), columns, table + ' must have exactly these columns');
		}
		// The five original storage tables still have exactly the columns the previous
		// release reads: the GC must not have altered them.
		const storage = {
			storage_entries: ['workspace_id', 'path', 'parent_path', 'name', 'file_id', 'revision_id', 'kind', 'created_ms', 'modified_ms'],
			storage_file_versions: ['workspace_id', 'file_id', 'revision_id', 'parent_revision_id', 'sha256', 'size_bytes', 'created_ms'],
			storage_trash: ['id', 'workspace_id', 'original_path', 'deleted_ms'],
			storage_trash_entries: ['trash_id', 'path', 'file_id', 'revision_id', 'kind', 'created_ms', 'modified_ms'],
		};
		for (const [table, columns] of Object.entries(storage)) {
			const { rows } = await pool.query(`
				SELECT column_name FROM information_schema.columns
				WHERE table_schema = 'log4stellar' AND table_name = $1
				ORDER BY ordinal_position
			`, [table]);
			assert.deepEqual(rows.map(row => row.column_name), columns, table + ' must keep its columns');
		}
	} finally {
		await pool.end();
	}
});

test('the collector never writes a digest or an object key into the log', { skip }, async () => {
	await scenario(async ({ store, inventory, pool, workspaceId, recoveryDirectory }) => {
		const events = [];
		const time = clock();
		const { objects } = await seedMixedWorkspace({ store, inventory, pool, workspaceId, time });
		const collector = collectorFor({
			store, inventory, time, apply: true, recoveryDirectory,
			logger: (event) => events.push(event),
		});
		await collector.plan(workspaceScope(workspaceId));
		time.advance(graceMs + minuteMs);
		await collector.review(workspaceScope(workspaceId));
		await collector.apply(workspaceScope(workspaceId));
		assert.ok(events.length > 0);
		const rendered = JSON.stringify(events);
		assert.ok(!rendered.includes(objects.orphan));
		assert.ok(!rendered.includes('workspaces/'));
		// A workspace id is not a secret and may appear; a digest or key never may.
		assert.ok(rendered.includes('plan.completed'));
		assert.ok(!/secret|accessKey|password/i.test(rendered));
	});
});

// A tiny guard so that a future refactor does not silently drop the read-only helper: it
// must keep using a read-only transaction for anything that only reads.
test('the store exposes a read-only transaction helper', { skip }, async () => {
	await scenario(async ({ store }) => {
		const result = await store.readTransaction(async (connection) => {
			const { rows } = await connection.query('SELECT 1 AS one');
			return rows[0].one;
		});
		assert.equal(Number(result), 1);
		await assert.rejects(
			() => store.readTransaction(async (connection) => {
				await connection.query('CREATE TEMP TABLE should_not_exist (id int)');
			}),
			/read-only/,
		);
	});
});
