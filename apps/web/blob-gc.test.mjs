import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	blobGcErrors,
	createBlobGc,
	describeBlobGcSummary,
	objectKey,
	parseObjectKey,
	redactDigest,
} from './blob-gc.mjs';
import {
	blobGcReferenceSources,
	blobGcTables,
	referenceSql,
} from './blob-gc-store.mjs';
import {
	applyEnabled,
	blobGcRetention,
	resolveBlobGcSettings,
	scopeWorkspaceId,
	workspaceScope,
} from './blob-retention.mjs';
import { createFakeInventory, createMemoryBlobGcStore } from './test-support/memory-blob-gc-store.mjs';

// Unit-level proof of the guarantees in task 06 (存储对象清理). These tests never touch
// PostgreSQL or a bucket: the store and the inventory are in-memory, so the suite runs on
// every machine, and the "dry-run deletes nothing" invariant is checkable as a counter.

const workspaceId = 'l4s-gc-unit';
const graceMs = blobGcRetention.graceMs;
const dayMs = 24 * 60 * 60 * 1000;

function digest(seed) {
	return Buffer.from(String(seed).padEnd(64, '0')).toString('hex').slice(0, 64);
}

const objects = {
	orphan: digest('orphan-a'),
	referenced: digest('referenced-b'),
	versioned: digest('versioned-c'),
	inTrash: digest('trash-d'),
	inSnapshot: digest('snapshot-e'),
	held: digest('held-f'),
};

/** A clock that can be advanced, so grace periods are tested without sleeping. */
function clock(startMs = Date.UTC(2026, 0, 1)) {
	let current = startMs;
	return {
		now: () => current,
		advance(ms) { current += ms; return current; },
		get current() { return current; },
	};
}

function settingsFor(overrides = {}) {
	return Object.freeze({
		graceMs,
		intentTtlMs: blobGcRetention.intentTtlMs,
		maxInventoryPage: blobGcRetention.maxInventoryPage,
		maxSweepBatch: blobGcRetention.maxSweepBatch,
		apply: false,
		recoveryDirectory: null,
		workspaces: [],
		...overrides,
	});
}

/**
 * A workspace whose metadata protects everything except `objects.orphan`. The reference
 * rows stand in for what referenceSql finds in the storage tables.
 */
function scenario({ time, apply = false, recoveryDirectory = null } = {}) {
	const store = createMemoryBlobGcStore({
		referenceRows: [
			[workspaceId, objects.referenced, ['entries', 'versions']],
			[workspaceId, objects.versioned, ['versions']],
			[workspaceId, objects.inTrash, ['trash', 'versions']],
			[workspaceId, objects.inSnapshot, ['snapshots']],
		],
		now: time.now,
	});
	const inventory = createFakeInventory({
		objects: [
			{ workspaceId, digest: objects.orphan, sizeBytes: 32, lastModifiedMs: time.current - 30 * dayMs },
			{ workspaceId, digest: objects.referenced, sizeBytes: 40, lastModifiedMs: time.current - 30 * dayMs },
			{ workspaceId, digest: objects.versioned, sizeBytes: 50, lastModifiedMs: time.current - 30 * dayMs },
			{ workspaceId, digest: objects.inTrash, sizeBytes: 60, lastModifiedMs: time.current - 30 * dayMs },
			{ workspaceId, digest: objects.inSnapshot, sizeBytes: 70, lastModifiedMs: time.current - 30 * dayMs },
		],
		now: time.now,
	});
	const collector = createBlobGc({
		store,
		inventory,
		settings: settingsFor({ apply, recoveryDirectory }),
		now: time.now,
	});
	return { store, inventory, collector, settings: collector.settings };
}

test('the retention policy defaults to a dry-run with a one-week grace period', () => {
	const settings = resolveBlobGcSettings({});
	assert.equal(settings.apply, false, 'physical deletion must be off unless explicitly switched on');
	assert.equal(settings.graceMs, 7 * 24 * 60 * 60 * 1000);
	assert.equal(settings.intentTtlMs, 15 * 60 * 1000);
	assert.equal(settings.recoveryDirectory, null);
	// The switch is exact: nothing but '1' enables deletion, so a typo only ever fails safe.
	for (const value of [undefined, '', '0', 'true', 'yes', 'on', ' 1', '1 ', 'TRUE']) {
		assert.equal(applyEnabled({ LOG4STELLAR_BLOB_GC_APPLY: value }), false, String(value));
	}
	assert.equal(applyEnabled({ LOG4STELLAR_BLOB_GC_APPLY: '1' }), true);
});

test('enabling apply without a recovery directory is refused, never silently ignored', () => {
	assert.throws(
		() => resolveBlobGcSettings({ LOG4STELLAR_BLOB_GC_APPLY: '1' }),
		/LOG4STELLAR_BLOB_GC_RECOVERY_DIR is required/,
	);
	const settings = resolveBlobGcSettings({
		LOG4STELLAR_BLOB_GC_APPLY: '1',
		LOG4STELLAR_BLOB_GC_RECOVERY_DIR: '/var/lib/log4stellar/blob-gc-recovery',
	});
	assert.equal(settings.apply, true);
	assert.equal(settings.recoveryDirectory, '/var/lib/log4stellar/blob-gc-recovery');
});

test('a configured grace period may not be shorter than an hour', () => {
	assert.throws(
		() => resolveBlobGcSettings({ LOG4STELLAR_BLOB_GC_GRACE_MS: '999' }),
		/must be between/,
	);
	assert.throws(
		() => resolveBlobGcSettings({ LOG4STELLAR_BLOB_GC_GRACE_MS: 'seven days' }),
		/whole number/,
	);
	assert.equal(resolveBlobGcSettings({ LOG4STELLAR_BLOB_GC_GRACE_MS: String(dayMs) }).graceMs, dayMs);
});

test('scopes name one workspace or all of them, and never a free-form string', () => {
	assert.equal(workspaceScope('log4stellar-main'), 'workspace:log4stellar-main');
	assert.equal(scopeWorkspaceId('workspace:log4stellar-main'), 'log4stellar-main');
	assert.equal(scopeWorkspaceId('all'), null);
	assert.throws(() => workspaceScope(''), /invalid_workspace/);
});

test('only keys in the collector’s own shape are parsed, and logs never carry the key', () => {
	const key = objectKey(workspaceId, objects.orphan);
	assert.equal(key, `workspaces/${workspaceId}/sha256/${objects.orphan}`);
	assert.deepEqual(parseObjectKey(key), { workspaceId, digest: objects.orphan, algorithm: 'sha256' });
	// Everything else is unmanaged: a stray key must never become a candidate.
	for (const wrong of [
		`workspaces/${workspaceId}/sha256/not-a-digest`,
		`workspaces/${workspaceId}/other/${objects.orphan}`,
		`other/${workspaceId}/sha256/${objects.orphan}`,
		`workspaces/${workspaceId}/sha256/${objects.orphan}/extra`,
		`workspaces//sha256/${objects.orphan}`,
		'', null, undefined, 42,
	]) {
		assert.equal(parseObjectKey(wrong), null, String(wrong));
	}
	const label = redactDigest(objects.orphan);
	assert.ok(!label.includes(objects.orphan), 'a log label must not contain the full digest');
	assert.match(label, /^sha256:[0-9a-f]{12}…$/);
	assert.equal(redactDigest('nonsense'), 'sha256:?');
	assert.throws(() => objectKey(workspaceId, 'nope'), /invalid_digest/);
});

test('the reference test reads every protecting table and column the report claims', () => {
	// A regression guard for the answer to "what is this candidate decision based on?":
	// if a source is dropped from the query, this fails instead of quietly deleting.
	const expectations = {
		versions: ['log4stellar.storage_file_versions', ['workspace_id', 'sha256']],
		entries: ['log4stellar.storage_entries', ['file_id', 'revision_id']],
		trash: ['log4stellar.storage_trash', ['id']],
		trashEntries: ['log4stellar.storage_trash_entries', ['trash_id']],
		snapshots: ['log4stellar.storage_snapshots', ['expires_ms']],
		snapshotEntries: ['log4stellar.storage_snapshot_entries', ['snapshot_id', 'sha256']],
		changes: ['log4stellar.storage_changes', ['sha256', 'created_ms']],
		intents: [blobGcTables.intents, ['workspace_id', 'digest', 'expires_ms']],
		holds: [blobGcTables.holds, ['digest', 'workspace_id', 'expires_ms']],
	};
	for (const [name, [table, columns]] of Object.entries(expectations)) {
		assert.ok(referenceSql.includes(table), `referenceSql must read ${table} (${name})`);
		assert.ok(referenceSql.includes(table), name);
		for (const column of columns) {
			assert.ok(referenceSql.includes(column), `referenceSql must use ${table}.${column}`);
		}
	}
	// The active-snapshot window and the replay window are both expressed as parameters,
	// never as a literal: the caller decides "now".
	assert.ok(referenceSql.includes('s.expires_ms > $3'));
	assert.ok(referenceSql.includes('c.created_ms > $4'));
	assert.ok(referenceSql.includes('i.expires_ms > $3'));
	assert.ok(referenceSql.includes('h.expires_ms IS NULL OR h.expires_ms > $3'));
	const sources = blobGcReferenceSources.map((entry) => entry.source);
	assert.ok(sources.includes('log4stellar.storage_file_versions'));
	assert.ok(sources.includes(blobGcTables.holds));
});

test('G01: a plan lists only unreferenced objects and writes nothing to the object store', async () => {
	const time = clock();
	const { collector, store, inventory } = scenario({ time });
	const summary = await collector.plan(workspaceScope(workspaceId));
	assert.equal(summary.scanned, 5);
	assert.equal(summary.candidates, 1, 'only the orphan is a candidate');
	assert.equal(summary.candidateBytes, 32);
	assert.equal(summary.deleted, 0);
	// The machine-checkable form of "只读盘点": not one delete was requested.
	assert.equal(inventory.calls.delete, 0);
	assert.equal(inventory.calls.copy, 0);
	assert.equal(store.writes, 0);
	const rows = store.inspect().candidates;
	assert.equal(rows.length, 1);
	assert.equal(rows[0].digest, objects.orphan);
	assert.equal(rows[0].state, 'observed');
	// The grace period is measured from the first observation, a full week out.
	assert.equal(rows[0].firstSeenMs, time.current);
	assert.equal(rows[0].eligibleAfterMs, time.current + graceMs);
	// Protected objects are still present in the store.
	for (const protectedDigest of [objects.referenced, objects.versioned, objects.inTrash, objects.inSnapshot]) {
		assert.ok(inventory.get(protectedDigest), 'a protected object must not be touched');
	}
});

test('an object written recently is not made eligible just because it is unreferenced', async () => {
	const time = clock();
	const store = createMemoryBlobGcStore({ now: time.now });
	const inventory = createFakeInventory({
		objects: [{ workspaceId, digest: objects.orphan, sizeBytes: 8, lastModifiedMs: time.current }],
		now: time.now,
	});
	const collector = createBlobGc({ store, inventory, settings: settingsFor(), now: time.now });
	await collector.plan(workspaceScope(workspaceId));
	const [candidate] = store.inspect().candidates;
	// The store says "written now", so the earliest possible eligibility is now + grace.
	assert.ok(candidate.eligibleAfterMs >= time.current + graceMs);
});

test('G01b: a dry-run apply reports what it would delete and deletes nothing', async () => {
	const time = clock();
	const { collector, store, inventory } = scenario({ time });
	await collector.plan(workspaceScope(workspaceId));
	// Still inside the grace period: no promotion yet.
	const early = await collector.apply(workspaceScope(workspaceId));
	assert.equal(early.wouldDelete, 0);
	assert.equal(early.deleted, 0);

	time.advance(graceMs + 1);
	const review = await collector.review(workspaceScope(workspaceId));
	assert.equal(review.promoted, 1);
	const summary = await collector.apply(workspaceScope(workspaceId));
	assert.equal(summary.dryRun, true, 'the default mode is a dry-run');
	assert.equal(summary.wouldDelete, 1);
	assert.equal(summary.deleted, 0);
	assert.equal(inventory.calls.delete, 0, 'a dry-run must not request a single delete');
	assert.equal(inventory.calls.copy, 0, 'a dry-run must not even make a recovery copy');
	assert.equal(store.writes, 0);
	assert.ok(inventory.get(objects.orphan), 'the orphan must survive a dry-run');
	assert.equal(store.inspect().candidates[0].state, 'eligible', 'a dry-run leaves the candidate in place');
});

test('a candidate that is referenced again is cancelled instead of deleted (bidirectional race)', async () => {
	const time = clock();
	const { collector, store, inventory } = scenario({
		time, apply: true, recoveryDirectory: '/tmp/l4s-gc-recovery',
	});
	await collector.plan(workspaceScope(workspaceId));
	time.advance(graceMs + 1);
	await collector.review(workspaceScope(workspaceId));

	// The collector decided the object is dead; a writer now registers a write intent,
	// which is the "candidate re-referenced after the decision" direction of the race.
	await store.registerIntent({
		workspaceId,
		digest: objects.orphan,
		writerId: 'writer-1',
		createdMs: time.current,
		expiresMs: time.current + 60_000,
	});
	const summary = await collector.apply(workspaceScope(workspaceId));
	assert.equal(summary.cancelled, 1);
	assert.equal(summary.deleted, 0);
	assert.equal(inventory.calls.delete, 0, 'a re-referenced object must never be deleted');
	assert.ok(inventory.get(objects.orphan));
	const [candidate] = store.inspect().candidates;
	assert.equal(candidate.state, 'cancelled');
	assert.match(candidate.reason, /referenced:.*intents/);
});

test('a hold cancels the delete even when the metadata tables say nothing', async () => {
	const time = clock();
	const { collector, store, inventory } = scenario({
		time, apply: true, recoveryDirectory: '/tmp/l4s-gc-recovery',
	});
	await collector.plan(workspaceScope(workspaceId));
	// A verified backup takes a hold on every digest it preserves.
	await store.createHold({
		scope: 'backup:l4s-backup-2026-01-01',
		workspaceId,
		digest: objects.orphan,
		reason: 'verified backup manifest',
		createdMs: time.current,
		expiresMs: null,
	});
	time.advance(graceMs + 1);
	await collector.review(workspaceScope(workspaceId));
	const summary = await collector.apply(workspaceScope(workspaceId));
	assert.equal(summary.deleted, 0);
	assert.equal(inventory.calls.delete, 0);
	assert.equal(store.inspect().candidates[0].state, 'cancelled');
});

test('apply deletes exactly the orphan once, after a verified recovery copy', async () => {
	const time = clock();
	const { collector, store, inventory } = scenario({
		time, apply: true, recoveryDirectory: '/tmp/l4s-gc-recovery',
	});
	await collector.plan(workspaceScope(workspaceId));
	time.advance(graceMs + 1);
	await collector.review(workspaceScope(workspaceId));
	const summary = await collector.apply(workspaceScope(workspaceId));
	assert.equal(summary.dryRun, false);
	assert.equal(summary.deleted, 1);
	assert.equal(summary.deletedBytes, 32);
	assert.equal(inventory.calls.copy, 1, 'a delete must be preceded by a recovery copy');
	assert.equal(inventory.calls.delete, 1);
	assert.equal(inventory.get(objects.orphan), null);
	const [candidate] = store.inspect().candidates;
	assert.equal(candidate.state, 'deleted');
	assert.equal(candidate.recoveryPath, `/tmp/l4s-gc-recovery/${workspaceId}/${objects.orphan}`);
	// Protected content is byte-identical and untouched.
	for (const protectedDigest of [objects.referenced, objects.versioned, objects.inTrash, objects.inSnapshot]) {
		assert.ok(inventory.get(protectedDigest));
	}
});

test('a failed recovery copy fails the candidate instead of deleting it', async () => {
	const time = clock();
	const { collector, store, inventory } = scenario({
		time, apply: true, recoveryDirectory: '/tmp/l4s-gc-recovery',
	});
	inventory.copyTo = async () => { throw new Error('spool is full'); };
	await collector.plan(workspaceScope(workspaceId));
	time.advance(graceMs + 1);
	await collector.review(workspaceScope(workspaceId));
	const summary = await collector.apply(workspaceScope(workspaceId));
	assert.equal(summary.failed, 1);
	assert.equal(summary.deleted, 0);
	assert.equal(inventory.calls.delete, 0, 'no copy, no delete');
	assert.ok(inventory.get(objects.orphan));
	const [candidate] = store.inspect().candidates;
	assert.equal(candidate.state, 'failed');
	assert.equal(candidate.lastError, blobGcErrors.copyFailed);
});

test('a rebuilt object is cancelled by identity, never deleted (G03)', async () => {
	const time = clock();
	const { collector, store, inventory } = scenario({
		time, apply: true, recoveryDirectory: '/tmp/l4s-gc-recovery',
	});
	await collector.plan(workspaceScope(workspaceId));
	time.advance(graceMs + 1);
	await collector.review(workspaceScope(workspaceId));
	// Same key, different object: the orphan was rebuilt (or restored from backup) after
	// the candidate was observed. Deleting it would destroy live data.
	inventory.rewrite(workspaceId, objects.orphan, { sizeBytes: 48 });
	const summary = await collector.apply(workspaceScope(workspaceId));
	assert.equal(summary.cancelled, 1);
	assert.equal(summary.deleted, 0);
	assert.equal(inventory.calls.delete, 0);
	assert.ok(inventory.get(objects.orphan), 'the rebuilt object must survive');
	assert.equal(store.inspect().candidates[0].reason, 'object-identity-changed');
});

test('deleting is idempotent: an object that is already gone is recorded as deleted, not failed', async () => {
	const time = clock();
	const { collector, store, inventory } = scenario({
		time, apply: true, recoveryDirectory: '/tmp/l4s-gc-recovery',
	});
	await collector.plan(workspaceScope(workspaceId));
	time.advance(graceMs + 1);
	await collector.review(workspaceScope(workspaceId));
	const [candidate] = store.inspect().candidates;
	// Simulate a crash after the fence was committed but before the object was removed,
	// then somebody else removed it: a retry must not report a failure it cannot fix.
	await store.transitionCandidate({
		workspaceId, digest: candidate.digest, from: ['eligible'], to: 'deleting',
		recoveryPath: '/tmp/l4s-gc-recovery/copy', updatedMs: time.current,
	});
	await inventory.deleteExact(objects.orphan, null);
	const outcome = await collector.sweepCandidate(workspaceScope(workspaceId), candidate, { nowMs: time.current });
	assert.equal(outcome.action, 'already-missing');
	const row = store.inspect().candidates[0];
	assert.equal(row.state, 'deleted');
	assert.equal(row.reason, 'already-missing');
	// Repeating the sweep is harmless: nothing was in flight, so nothing happens.
	const again = await collector.sweepCandidate(workspaceScope(workspaceId), candidate, { nowMs: time.current });
	assert.equal(again.action, 'cancelled');
});

test('resume finishes an interrupted delete without touching a rebuilt object', async () => {
	const time = clock();
	const { collector, store, inventory } = scenario({
		time, apply: true, recoveryDirectory: '/tmp/l4s-gc-recovery',
	});
	await collector.plan(workspaceScope(workspaceId));
	time.advance(graceMs + 1);
	await collector.review(workspaceScope(workspaceId));
	const run = await store.beginRun({ scope: workspaceScope(workspaceId), mode: 'apply', dryRun: false, startedMs: time.current });
	const [candidate] = store.inspect().candidates;
	// Crash window: the fence is committed, the object is still there.
	await store.transitionCandidate({
		workspaceId, digest: candidate.digest, from: ['eligible'], to: 'deleting',
		objectVersion: candidate.objectVersion, recoveryPath: `/tmp/l4s-gc-recovery/${workspaceId}/${candidate.digest}`,
		updatedMs: time.current,
	});
	const resumed = await collector.resume(run.runId);
	assert.equal(resumed.alreadyMissing, 0);
	assert.equal(resumed.deleted, 1);
	assert.equal(inventory.calls.delete, 1);
	assert.equal(inventory.get(objects.orphan), null);
});

test('resume cancels when the object changed identity while the worker was down', async () => {
	const time = clock();
	const { collector, store, inventory } = scenario({
		time, apply: true, recoveryDirectory: '/tmp/l4s-gc-recovery',
	});
	await collector.plan(workspaceScope(workspaceId));
	time.advance(graceMs + 1);
	await collector.review(workspaceScope(workspaceId));
	const run = await store.beginRun({ scope: workspaceScope(workspaceId), mode: 'apply', dryRun: false, startedMs: time.current });
	const [candidate] = store.inspect().candidates;
	await store.transitionCandidate({
		workspaceId, digest: candidate.digest, from: ['eligible'], to: 'deleting',
		objectVersion: candidate.objectVersion, recoveryPath: '/tmp/copy', updatedMs: time.current,
	});
	inventory.rewrite(workspaceId, objects.orphan, { sizeBytes: 99 });
	const resumed = await collector.resume(run.runId);
	assert.equal(resumed.deleted, 0);
	assert.equal(resumed.cancelled, 1);
	assert.equal(inventory.calls.delete, 0);
	assert.ok(inventory.get(objects.orphan));
});

test('a candidate in any state other than eligible/deleting is left alone', async () => {
	const time = clock();
	const { collector, store, inventory } = scenario({ time, apply: true, recoveryDirectory: '/tmp/r' });
	await collector.plan(workspaceScope(workspaceId));
	const [candidate] = store.inspect().candidates;
	const outcome = await collector.sweepCandidate(workspaceScope(workspaceId), candidate, { nowMs: time.current });
	assert.equal(outcome.action, 'cancelled');
	assert.equal(outcome.reason, 'state:observed');
	assert.equal(inventory.calls.delete, 0);
});

test('an expired write intent does not block collection, a live one does', async () => {
	const time = clock();
	const { collector, store } = scenario({ time });
	await store.registerIntent({
		workspaceId, digest: objects.orphan, writerId: 'writer-1',
		createdMs: time.current, expiresMs: time.current + 1000,
	});
	const live = await store.isReferenced(workspaceId, objects.orphan, { nowMs: time.current });
	assert.equal(live.referenced, true);
	assert.deepEqual(live.blockers, ['intents']);
	// A crashed writer's intent expires instead of blocking forever.
	const later = await store.isReferenced(workspaceId, objects.orphan, { nowMs: time.current + 2000 });
	assert.equal(later.referenced, false);
	assert.deepEqual(later.blockers, []);
	// The collector prunes expired rows during review.
	time.advance(2000);
	await collector.review(workspaceScope(workspaceId));
	assert.equal(store.inspect().intents.length, 0);
});

test('no log line or error carries an object key, a digest or a credential', async () => {
	const events = [];
	const time = clock();
	const { store, inventory } = scenario({ time, apply: true, recoveryDirectory: '/tmp/l4s-gc-recovery' });
	const collector = createBlobGc({
		store, inventory, settings: settingsFor({ apply: true, recoveryDirectory: '/tmp/l4s-gc-recovery' }),
		now: time.now, logger: (event) => events.push(event),
	});
	await collector.plan(workspaceScope(workspaceId));
	time.advance(graceMs + 1);
	await collector.review(workspaceScope(workspaceId));
	await collector.apply(workspaceScope(workspaceId));
	assert.ok(events.length > 0);
	const rendered = JSON.stringify(events);
	assert.ok(!rendered.includes(objects.orphan), 'a log must not contain the digest');
	assert.ok(!rendered.includes('workspaces/'), 'a log must not contain the object key');
	assert.ok(!/secret|accessKey|password/i.test(rendered));
	// Deleting while the object store throws must not leak the key through the error either.
	// This needs a fresh scenario: the run above already removed the orphan.
	const second = scenario({ time, apply: true, recoveryDirectory: '/tmp/l4s-gc-recovery' });
	const failing = createBlobGc({
		store: second.store,
		inventory: {
			...second.inventory,
			async deleteExact() { throw new Error('AccessDenied for workspaces/x'); },
		},
		settings: settingsFor({ apply: true, recoveryDirectory: '/tmp/l4s-gc-recovery' }),
		now: time.now, logger: (event) => events.push(event),
	});
	await failing.plan(workspaceScope(workspaceId));
	time.advance(graceMs + 1);
	await failing.review(workspaceScope(workspaceId));
	const [pending] = second.store.inspect().candidates;
	const outcome = await failing.sweepCandidate(
		workspaceScope(workspaceId),
		{ ...pending, state: undefined },
		{ nowMs: time.current },
	);
	assert.equal(outcome.action, 'failed');
	assert.equal(outcome.category, blobGcErrors.deleteFailed);
	assert.ok(!JSON.stringify(outcome).includes('AccessDenied'));
});

test('the operator summary is one line of counters, safe to paste into a ticket', async () => {
	const summary = {
		mode: 'plan', dryRun: true, scanned: 10, candidates: 2, deleted: 0, wouldDelete: 0, cancelled: 1, failed: 0,
	};
	const line = describeBlobGcSummary(summary);
	assert.match(line, /^plan \(dry-run\): scanned=10 candidates=2/);
	assert.ok(!line.includes('\n'));
});
