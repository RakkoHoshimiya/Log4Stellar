/**
 * Offline editing tests (docs/web-offline.md §7, acceptance O01–O04).
 *
 * The store is exercised against a real transaction implementation (test-support/
 * offline-fake-idb.mjs) rather than a stubbed store, because every acceptance criterion
 * here is about what survives a boundary: a tab killed between two writes, a response
 * lost after the server committed, a queue resumed under a different account. A mock
 * that records calls would report success for all four while losing the user's text.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createFakeIndexedDB } from './test-support/offline-fake-idb.mjs';
import {
	OfflineError,
	assertPersistable,
	compoundKey,
	digestText,
	draftStates,
	extendKey,
	keySeparator,
	normalizeOfflineScope,
	normalizeOfflineWindow,
	offlineEnabled,
	offlineErrorCodes,
	offlineSchemaVersion,
	offlineWindowLimits,
	opBlockReasons,
	opStates,
	requireOfflineEnabled,
	retryDelay,
	retryLimits,
	sameScope,
	scopeKeyOf,
} from './offline-contract.js';
import {
	exportFileName,
	openOfflineDatabase,
	openOfflineStore,
} from './offline-store.js';
import {
	cacheServerDocument,
	canUseOffline,
	discardDraft,
	documentStatus,
	newIdempotencyKey,
	newOperationId,
	readCachedDocument,
	writeOfflineDraft,
} from './offline-provider.js';
import {
	classifyCommit,
	createLeaseManager,
	drainOutbox,
	handleConflict,
	leaseLimits,
	offlineRetryCeiling,
	verifyReplayScope,
} from './offline-coordinator.js';
import {
	actionLabel,
	exportPendingDrafts,
	offlineBanner,
	offlineStatuses,
	offlineWindowNotice,
	outboxRows,
	renderOfflineBanner,
	resolvePendingConflict,
} from './offline-ui.js';

const origin = 'https://192.0.2.233:18990';

function scopeOf(accountId = 'user-a', workspaceId = 'log4stellar-main', extra = {}) {
	return { origin, accountId, workspaceId, ...extra };
}

function clock(start = 1_770_000_000_000) {
	let value = start;
	const now = () => value;
	now.advance = ms => {
		value += ms;
		return value;
	};
	now.set = next => {
		value = next;
		return value;
	};
	return now;
}

/** A store bound to a fresh fake database, plus the factory so a test can break it. */
async function fixture({ accountId = 'user-a', policy = {}, now = Date.now } = {}) {
	const indexedDB = createFakeIndexedDB();
	const store = await openOfflineStore({ scope: scopeOf(accountId), indexedDB, policy, now });
	return { indexedDB, store, now };
}

function operationFor(path, index = 0) {
	return {
		path,
		text: '# ' + path + ' ' + String(index),
		baseRevision: null,
		opId: 'op-' + path.replace(/\W/g, '-') + '-' + String(index),
		idempotencyKey: 'key-' + path.replace(/\W/g, '-') + '-' + String(index),
		mode: 'create',
	};
}

function assertOfflineError(error, code) {
	assert.ok(error instanceof OfflineError, 'expected an OfflineError, got ' + String(error));
	assert.equal(error.code, code);
	return error;
}

/** `assert.rejects` cannot hand the error back, and several tests compare two of them. */
async function capture(promise) {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	assert.fail('expected the call to reject');
}

// ---------------------------------------------------------------- contract (O04 by construction)

test('a scope key separates two accounts even when everything else is identical', () => {
	const left = scopeKeyOf(scopeOf('user-a'));
	const right = scopeKeyOf(scopeOf('user-b'));
	assert.notEqual(left, right);
	assert.ok(left.includes(keySeparator));
	// O04: the partition is in the key, so a query that forgets to filter still cannot
	// return the other account's row.
	assert.equal(left.split(keySeparator)[1], 'user-a');
});

test('a scope normalizes its origin and rejects a scope without an account', () => {
	const normalized = normalizeOfflineScope({ origin: 'HTTPS://192.0.2.233:18990/', accountId: ' user-a ', workspaceId: 'log4stellar-main' });
	assert.equal(normalized.origin, origin);
	assert.equal(normalized.accountId, 'user-a');
	assert.equal(normalized.tenantId, 'default');
	assert.ok(Object.isFrozen(normalized));
	// `normalizeOfflineScope` throws synchronously — it is called from the workbench
	// during a keystroke, so it must not need an await to reject a bad scope.
	assert.throws(() => normalizeOfflineScope({ origin, workspaceId: 'w' }), error => error.code === offlineErrorCodes.invalidScope);
});

test('a shared browser refuses offline storage by default', () => {
	const shared = scopeOf('user-a', 'log4stellar-main', { sharedDevice: true });
	assert.equal(offlineEnabled(shared), false);
	assert.equal(offlineEnabled(scopeOf()), true);
	assert.throws(() => requireOfflineEnabled(shared), error => error.code === offlineErrorCodes.offlineDisabled);
});

test('the offline window is clamped to the documented maximum', () => {
	assert.equal(normalizeOfflineWindow(undefined), offlineWindowLimits.defaultMs);
	assert.equal(normalizeOfflineWindow(30 * 24 * 3600 * 1000), offlineWindowLimits.maxMs);
	assert.equal(normalizeOfflineWindow(365 * 24 * 3600 * 1000), offlineWindowLimits.maxMs);
	assert.throws(() => normalizeOfflineWindow(-1), /positive integer/);
	assert.throws(() => normalizeOfflineWindow(1.5), /positive integer/);
});

test('a compound key cannot be forged by a part that contains the separator', () => {
	assert.equal(compoundKey('a', 'b'), 'a' + keySeparator + 'b');
	assert.throws(() => compoundKey('a', 'b' + keySeparator + 'c'), /may not contain the separator/);
	assert.throws(() => compoundKey('a', undefined), /must be a string/);
});

test('extendKey prefixes an existing key, which compoundKey refuses to do', () => {
	const base = scopeKeyOf(scopeOf());
	assert.equal(extendKey(base, '/notes/a.md'), base + keySeparator + '/notes/a.md');
	assert.throws(() => compoundKey(base, '/notes/a.md'), /may not contain the separator/);
	assert.throws(() => extendKey(base, ''), /may not be empty/);
});

test('two scopes that differ only by tenant are not the same scope', () => {
	assert.equal(sameScope(scopeOf(), scopeOf()), true);
	assert.equal(sameScope(scopeOf(), scopeOf('user-a', 'log4stellar-main', { tenantId: 't-alpha' })), false);
	assert.equal(sameScope(scopeOf(), null), false);
});

test('a record carrying a credential is refused before it can be written', () => {
	assert.throws(() => assertPersistable({ draftId: 'x', authorization: 'Bearer abcdefghijkl' }), /is a credential field/);
	assert.throws(() => assertPersistable({ nested: { accessToken: 'x' } }), /is a credential field/);
	assert.throws(() => assertPersistable({ text: 'Authorization: Bearer abcdefghijklmnop' }), /would persist a credential/);
	assert.throws(() => assertPersistable({ url: 'https://bucket/x?X-Amz-Signature=abc' }), /would persist a credential/);
	// Property names that merely READ like credentials are allowed through: a draft
	// titled "secret.md" must still be savable offline.
	assert.doesNotThrow(() => assertPersistable({ path: '/notes/secret.md', text: 'no credentials here' }));
});

test('the retry delay grows and then stops growing', () => {
	assert.equal(retryDelay(0), retryLimits.baseMs);
	assert.equal(retryDelay(1), retryLimits.baseMs * 2);
	assert.equal(retryDelay(99), retryLimits.maxMs);
});

test('a digest is lowercase sha-256 hex of the exact bytes', async () => {
	const digest = await digestText('# hello');
	assert.match(digest, /^[0-9a-f]{64}$/);
	assert.equal(digest, await digestText('# hello'));
	assert.notEqual(digest, await digestText('# hello\n'));
});

// ---------------------------------------------------------------- store

test('the schema upgrade is additive and creates every declared store and index', async () => {
	const indexedDB = createFakeIndexedDB();
	const database = await openOfflineDatabase({ indexedDB });
	assert.equal(database.version, offlineSchemaVersion);
	for (const name of ['scopes', 'baseDocuments', 'drafts', 'outbox', 'receipts', 'leases']) {
		assert.equal(database.objectStoreNames.contains(name), true, 'missing store ' + name);
	}
	const drafts = database.transaction(['drafts']).objectStore('drafts');
	assert.equal(drafts.indexNames.contains('byScope'), true);
	assert.equal(drafts.indexNames.contains('byScopePath'), true);
});

test('a database written by a newer build is refused by name', async () => {
	const indexedDB = createFakeIndexedDB();
	await openOfflineDatabase({ indexedDB, version: 5 });
	const error = await capture(openOfflineDatabase({ indexedDB }));
	assertOfflineError(error, offlineErrorCodes.schemaTooNew);
});

test('saving a draft and enqueueing its operation commits together', async () => {
	const { store } = await fixture();
	const saved = await store.persistDraftAndEnqueue(operationFor('/notes/a.md'));
	assert.equal(saved.draft.state, draftStates.queued);
	assert.equal(saved.operation.state, opStates.pending);
	assert.equal(saved.draft.draftId, saved.operation.draftId);
	assert.equal(saved.operation.idempotencyKey, 'key--notes-a-md-0');
	assert.equal((await store.listOutbox()).length, 1);
	const read = await store.readDraft('/notes/a.md');
	assert.equal(read.text, saved.draft.text);
	assert.equal(read.digest, await digestText(saved.draft.text));
});

test('a rejected transaction leaves neither a draft nor an outbox row (O01)', async () => {
	const { store, indexedDB } = await fixture();
	const database = indexedDB.databases.get('log4stellar-offline');
	database.failNextTransaction('QuotaExceededError');
	await assert.rejects(store.persistDraftAndEnqueue(operationFor('/notes/a.md')));
	// The write happened in one transaction; a failure must not leave half of it behind,
	// otherwise the user's text is gone while the queue still holds an operation to it.
	assert.equal((await store.listDrafts()).length, 0);
	assert.equal((await store.listOutbox()).length, 0);
});

test('reloading the tab recovers the draft and its operation ID (O01)', async () => {
	const { indexedDB } = await fixture();
	const before = await openOfflineStore({ scope: scopeOf(), indexedDB });
	const saved = await before.persistDraftAndEnqueue(operationFor('/notes/a.md'));

	// A second store instance over the SAME database is what a reloaded tab sees.
	const after = await openOfflineStore({ scope: scopeOf(), indexedDB });
	const draft = await after.readDraft('/notes/a.md');
	const operation = await after.readOperation(saved.operation.opId);
	assert.equal(draft.text, saved.draft.text);
	assert.equal(operation.opId, saved.operation.opId);
	assert.equal(operation.idempotencyKey, saved.operation.idempotencyKey);
	assert.equal(operation.state, opStates.pending);
});

test('another account in the same browser cannot read the first account data (O04)', async () => {
	const { indexedDB } = await fixture({ accountId: 'user-a' });
	const first = await openOfflineStore({ scope: scopeOf('user-a'), indexedDB });
	await first.persistDraftAndEnqueue(operationFor('/notes/private-a.md'));

	const second = await openOfflineStore({ scope: scopeOf('user-b'), indexedDB });
	assert.equal(await second.readDraft('/notes/private-a.md'), undefined);
	assert.deepEqual(await second.listDrafts(), []);
	assert.deepEqual(await second.listOutbox(), []);
	assert.equal((await first.listDrafts()).length, 1);
});

test('the scope record anchors its expiry to the first offline write', async () => {
	const now = clock();
	const { store } = await fixture({ now });
	// No record exists until the first offline write: opening a store is not consent to
	// keep workspace bytes, so nothing is registered by merely signing in.
	assert.equal(await store.readScopeRecord(), undefined);
	await store.persistDraftAndEnqueue(operationFor('/notes/a.md'));
	const first = await store.readScopeRecord();
	now.advance(60_000);
	await store.persistDraftAndEnqueue(operationFor('/notes/b.md', 1));
	const second = await store.readScopeRecord();
	assert.equal(second.firstUsedMs, first.firstUsedMs);
	// Editing again must not extend the window: otherwise a queue could be kept alive
	// indefinitely by touching it once a day, which is exactly what the window forbids.
	assert.equal(second.expiresMs, first.expiresMs);
	assert.equal(second.expiresMs, first.firstUsedMs + offlineWindowLimits.defaultMs);
});

test('a receipt removes the outbox row and marks the draft synced', async () => {
	const { store } = await fixture();
	const saved = await store.persistDraftAndEnqueue(operationFor('/notes/a.md'));
	await store.applyReceipt({
		opId: saved.operation.opId,
		result: { seq: 7, changeId: 'c-1', revisionId: 'rev-2', fileId: 'file-1', etag: 'e-1', sha256: saved.draft.digest, text: saved.draft.text },
	});
	assert.equal((await store.listOutbox()).length, 0);
	assert.equal((await store.readDraft('/notes/a.md')).state, draftStates.synced);
	const receipt = await store.readReceipt(saved.operation.opId);
	assert.equal(receipt.seq, 7);
	assert.equal(receipt.revisionId, 'rev-2');
	assert.equal((await store.readBaseDocument('/notes/a.md')).revisionId, 'rev-2');
});

test('blocking an operation explains why and keeps the draft exportable', async () => {
	const { store } = await fixture();
	const saved = await store.persistDraftAndEnqueue(operationFor('/notes/a.md'));
	await store.blockOperation({ opId: saved.operation.opId, reason: opBlockReasons.conflict });
	const operation = await store.readOperation(saved.operation.opId);
	assert.equal(operation.state, opStates.blocked);
	assert.equal(operation.blockedReason, opBlockReasons.conflict);
	assert.equal((await store.readDraft('/notes/a.md')).state, draftStates.conflict);
	assert.equal((await store.countOutbox()).blocked, 1);
	const exported = await store.exportDraft('/notes/a.md');
	assert.equal(exported.text, saved.draft.text);
	assert.match(exported.fileName, /^a \(offline \d{8}T\d{6}Z\)\.md$/);
});

test('a permission block leaves the draft queued but locks the scope', async () => {
	const { store } = await fixture();
	const saved = await store.persistDraftAndEnqueue(operationFor('/notes/a.md'));
	await store.blockOperation({ opId: saved.operation.opId, reason: opBlockReasons.noPermission });
	// The draft stays "queued": the user did nothing wrong, the authorization changed.
	assert.equal((await store.readDraft('/notes/a.md')).state, draftStates.queued);
	await store.lockScope(opBlockReasons.noPermission);
	assert.equal((await store.readScopeRecord()).locked, true);
	assert.equal((await store.readScopeRecord()).lockReason, opBlockReasons.noPermission);
	await store.unlockScope();
	assert.equal((await store.readScopeRecord()).locked, false);
});

test('an attempt limit turns a transient failure into a visible one', async () => {
	const { store } = await fixture();
	const saved = await store.persistDraftAndEnqueue(operationFor('/notes/a.md'));
	let last;
	for (let index = 0; index < retryLimits.maxAttempts; index += 1) {
		last = await store.noteAttempt({ opId: saved.operation.opId });
	}
	assert.equal(last.attempts, retryLimits.maxAttempts);
	assert.equal(last.giveUp, true);
	assert.equal((await store.readOperation(saved.operation.opId)).state, opStates.failed);
	assert.equal((await store.countOutbox()).failed, 1);
});

test('export works with no network and no scope record in reach', async () => {
	const { store } = await fixture();
	await store.persistDraftAndEnqueue(operationFor('/notes/a.md'));
	await store.persistDraftAndEnqueue(operationFor('/notes/b.md', 1));
	const all = await store.exportAllDrafts();
	assert.equal(all.length, 2);
	assert.deepEqual(all.map(entry => entry.path).sort(), ['/notes/a.md', '/notes/b.md']);
	assert.ok(all.every(entry => typeof entry.text === 'string' && entry.digest));
});

test('an export file name is safe on every desktop file system', () => {
	assert.equal(exportFileName('/notes/plan.md', Date.UTC(2026, 0, 1, 12, 0, 0)), 'plan (offline 20260101T120000Z).md');
	assert.equal(exportFileName('/notes/README', Date.UTC(2026, 0, 1, 12, 0, 0)), 'README (offline 20260101T120000Z)');
	assert.equal(exportFileName('/notes/.hidden', Date.UTC(2026, 0, 1, 12, 0, 0)).includes('/'), false);
});

test('an unknown draft cannot be exported into a silent empty file', async () => {
	const { store } = await fixture();
	const error = await capture(store.exportDraft('/notes/missing.md'));
	assertOfflineError(error, offlineErrorCodes.unknownDraft);
});

// ---------------------------------------------------------------- coordinator

test('replay refuses a queue whose account changed (O04)', async () => {
	const { store } = await fixture();
	await store.persistDraftAndEnqueue(operationFor('/notes/a.md'));
	const verify = (accountId) => verifyReplayScope({
		scope: scopeOf('user-a'),
		authenticate: async () => ({ ok: true, origin, accountId, tenantId: 'default', workspaceId: 'log4stellar-main' }),
	});
	const ok = await verify('user-a');
	assert.equal(ok.remainingMs, null);

	const error = await capture(verify('user-b'));
	assertOfflineError(error, offlineErrorCodes.accountChanged);
	assert.match(error.message, /different account or workspace/);
});

test('replay refuses a session that ended or belongs to another workspace', async () => {
	const ended = await capture(verifyReplayScope({ scope: scopeOf(), authenticate: async () => ({ ok: false }) }));
	assertOfflineError(ended, offlineErrorCodes.accountChanged);

	const other = await capture(verifyReplayScope({
		scope: scopeOf(),
		authenticate: async () => ({ ok: true, origin, accountId: 'user-a', workspaceId: 'other-workspace' }),
	}));
	assertOfflineError(other, offlineErrorCodes.accountChanged);

	const missing = await capture(verifyReplayScope({ scope: scopeOf(), authenticate: async () => null }));
	assertOfflineError(missing, offlineErrorCodes.accountChanged);
});

test('replay refuses a queue older than the offline window', async () => {
	const now = clock();
	const error = await capture(verifyReplayScope({
		scope: scopeOf(),
		now,
		authenticate: async () => ({ ok: true, origin, accountId: 'user-a', tenantId: 'default', workspaceId: 'log4stellar-main', expiresMs: now() - 1 }),
	}));
	assertOfflineError(error, offlineErrorCodes.offlineExpired);
});

test('a server answer maps to exactly one replay outcome', () => {
	assert.equal(classifyCommit({ status: 201, body: { seq: 1 } }).outcome, 'committed');
	assert.equal(classifyCommit({ status: 200, body: { replayed: true } }).replayed, true);
	assert.equal(classifyCommit({ status: 409, body: { error: 'SyncConflict' } }).outcome, 'conflict');
	// A reused key is not a conflict the user can resolve: the same key answered a
	// different body, so retrying cannot help and minting a new key would duplicate.
	assert.equal(classifyCommit({ status: 409, body: { error: 'IdempotencyKeyReused' } }).reason, opBlockReasons.accountChanged);
	assert.equal(classifyCommit({ status: 403, body: {} }).reason, opBlockReasons.noPermission);
	assert.equal(classifyCommit({ status: 410, body: {} }).reason, opBlockReasons.resyncRequired);
	assert.equal(classifyCommit({ status: 428, body: {} }).outcome, 'blocked');
	assert.equal(classifyCommit({ status: 413, body: {} }).outcome, 'blocked');
	assert.equal(classifyCommit({ status: 429, body: {} }).outcome, 'retry');
	assert.equal(classifyCommit({ status: 503, body: {} }).outcome, 'retry');
});

/**
 * A commit callback that answers from a script and records what it was asked. When the
 * script runs out the LAST answer repeats, because a queue of three uploads usually wants
 * the same answer three times and writing it out three times hides which call differed.
 */
function scriptedCommit(answers) {
	const calls = [];
	let last;
	const commit = async operation => {
		calls.push(operation);
		if (answers.length > 0) {
			last = answers.shift();
		}
		return typeof last === 'function' ? last(operation) : last;
	};
	commit.calls = calls;
	return commit;
}

function session(answer = {}) {
	return async () => ({ ok: true, origin, accountId: 'user-a', tenantId: 'default', workspaceId: 'log4stellar-main', ...answer });
}

test('a replayed answer commits exactly once and is not counted as new work (O02)', async () => {
	const { store } = await fixture();
	const saved = await store.persistDraftAndEnqueue(operationFor('/notes/a.md'));
	const commit = scriptedCommit([{ status: 200, body: { replayed: true, seq: 9, revisionId: 'rev-9', fileId: 'f-1', changeId: 'c-9' }, text: saved.draft.text }]);
	const summary = await drainOutbox({ store, scope: scopeOf(), authenticate: session(), commit });
	assert.equal(summary.replayed, 1);
	assert.equal(summary.committed, 0);
	// The operation was sent with the SAME idempotency key that was persisted, which is
	// what makes a lost response produce one version rather than two.
	assert.equal(commit.calls[0].idempotencyKey, saved.operation.idempotencyKey);
	assert.equal((await store.listOutbox()).length, 0);
	assert.equal((await store.readDraft('/notes/a.md')).state, draftStates.synced);
	assert.equal((await store.readReceipt(saved.operation.opId)).replayed, true);
});

test('a lost response is retried with the same key and lands once (O02)', async () => {
	const { store } = await fixture();
	const saved = await store.persistDraftAndEnqueue(operationFor('/notes/a.md'));
	const keys = [];
	const commit = async operation => {
		keys.push(operation.idempotencyKey);
		if (keys.length === 1) {
			throw new OfflineError(offlineErrorCodes.accountChanged, 'network down');
		}
		return { status: 201, body: { seq: 3, revisionId: 'rev-3', fileId: 'f-1', changeId: 'c-3' }, text: saved.draft.text };
	};
	// The first pass throws out of `commit`, so the caller sees the transport failure.
	await assert.rejects(drainOutbox({ store, scope: scopeOf(), authenticate: session(), commit }));
	assert.equal((await store.listOutbox()).length, 1);

	const summary = await drainOutbox({ store, scope: scopeOf(), authenticate: session(), commit });
	assert.equal(summary.committed, 1);
	assert.deepEqual(keys, [saved.operation.idempotencyKey, saved.operation.idempotencyKey]);
	assert.equal((await store.listOutbox()).length, 0);
});

test('a retryable status is rescheduled rather than lost', async () => {
	const now = clock();
	const { store } = await fixture({ now });
	const saved = await store.persistDraftAndEnqueue(operationFor('/notes/a.md'));
	const summary = await drainOutbox({
		store, scope: scopeOf(), authenticate: session(), now,
		commit: scriptedCommit([{ status: 503, body: {} }]),
	});
	assert.equal(summary.retried, 1);
	const operation = await store.readOperation(saved.operation.opId);
	assert.equal(operation.state, opStates.pending);
	assert.equal(operation.attempts, 1);
	assert.ok(operation.nextRetryAt > now(), 'a retry must be pushed into the future');

	// A second pass before the backoff elapses skips it instead of hammering the server.
	const again = await drainOutbox({ store, scope: scopeOf(), authenticate: session(), now, commit: scriptedCommit([{ status: 503, body: {} }]) });
	assert.equal(again.skipped, 1);
	assert.equal(again.retried, 0);
});

test('a conflict keeps both sides and pauses only that path (O03)', async () => {
	const { store } = await fixture();
	const first = await store.persistDraftAndEnqueue(operationFor('/notes/a.md'));
	const second = await store.persistDraftAndEnqueue(operationFor('/notes/b.md', 1));
	const third = await store.persistDraftAndEnqueue(operationFor('/notes/a.md', 2));
	const commit = scriptedCommit([
		{ status: 409, body: { error: 'SyncConflict', conflictPath: '/notes/a (conflict phone 20260101T120000Z).md', currentRevision: 'rev-cloud', seq: 12 } },
		{ status: 201, body: { seq: 13, revisionId: 'rev-b', fileId: 'f-b', changeId: 'c-b' }, text: 'b' },
		{ status: 201, body: { seq: 14, revisionId: 'rev-a2', fileId: 'f-a', changeId: 'c-a2' }, text: 'a2' },
	]);
	const summary = await drainOutbox({ store, scope: scopeOf(), authenticate: session(), commit });
	assert.equal(summary.conflicts, 1);
	assert.equal(summary.committed, 1);

	// The conflicted draft is preserved and still exportable. There is exactly one draft
	// per path — the editor buffer — so it holds the NEWEST local text (the second edit),
	// while the conflict is reported on the operation that lost the race.
	assert.equal((await store.readDraft('/notes/a.md')).state, draftStates.conflict);
	const exported = await store.exportDraft('/notes/a.md');
	assert.equal(exported.text, third.draft.text);
	assert.notEqual(exported.text, first.draft.text);

	// The same-path dependent is blocked with a Dependency reason, the other path landed.
	const dependent = await store.readOperation(third.operation.opId);
	assert.equal(dependent.state, opStates.blocked);
	assert.equal(dependent.blockedReason, opBlockReasons.dependency);
	assert.equal((await store.readOperation(second.operation.opId)), undefined);
	assert.equal((await store.readDraft('/notes/b.md')).state, draftStates.synced);
});

test('a conflict response exposes the server version to the user', async () => {
	const { store } = await fixture();
	const saved = await store.persistDraftAndEnqueue(operationFor('/notes/a.md'));
	const operation = await store.readOperation(saved.operation.opId);
	const outcome = await handleConflict({
		store,
		operation,
		response: { conflictPath: '/notes/a (conflict phone 20260101T120000Z).md', currentRevision: 'rev-cloud', seq: 12 },
	});
	assert.equal(outcome.draftPreserved, true);
	assert.equal(outcome.conflictPath, '/notes/a (conflict phone 20260101T120000Z).md');
	assert.equal(outcome.currentRevision, 'rev-cloud');
	assert.equal(outcome.serverSeq, 12);
	assert.equal(outcome.blockedDependents, 0);
});

test('a permission answer locks the scope and stops the queue', async () => {
	const { store } = await fixture();
	await store.persistDraftAndEnqueue(operationFor('/notes/a.md'));
	await store.persistDraftAndEnqueue(operationFor('/notes/b.md', 1));
	const commit = scriptedCommit([{ status: 403, body: { error: 'NoPermissions' } }]);
	const summary = await drainOutbox({ store, scope: scopeOf(), authenticate: session(), commit });
	assert.equal(summary.blocked, 1);
	assert.equal(summary.stopReason, opBlockReasons.noPermission);
	assert.equal(commit.calls.length, 1, 'the rest of the queue must not be attempted');
	assert.equal((await store.readScopeRecord()).locked, true);

	const refused = await capture(drainOutbox({ store, scope: scopeOf(), authenticate: session(), commit }));
	assertOfflineError(refused, offlineErrorCodes.scopeLocked);
});

test('a resync answer stops replay without discarding the queue', async () => {
	const { store } = await fixture();
	const saved = await store.persistDraftAndEnqueue(operationFor('/notes/a.md'));
	const summary = await drainOutbox({
		store, scope: scopeOf(), authenticate: session(),
		commit: scriptedCommit([{ status: 410, body: { error: 'ResyncRequired' } }]),
	});
	assert.equal(summary.stopReason, opBlockReasons.resyncRequired);
	const operation = await store.readOperation(saved.operation.opId);
	assert.equal(operation.state, opStates.blocked);
	assert.equal((await store.readDraft('/notes/a.md')).state, draftStates.queued);
});

test('the queue drains in creation order', async () => {
	const now = clock();
	const { store } = await fixture({ now });
	const first = await store.persistDraftAndEnqueue(operationFor('/notes/a.md', 0));
	now.advance(1000);
	const second = await store.persistDraftAndEnqueue(operationFor('/notes/b.md', 1));
	now.advance(1000);
	const third = await store.persistDraftAndEnqueue(operationFor('/notes/c.md', 2));
	assert.ok((await store.listOutbox()).length === 3);
	const commit = scriptedCommit([{ status: 201, body: { seq: 1, revisionId: 'r1', fileId: 'f', changeId: 'c' }, text: 'x' }]);
	await drainOutbox({ store, scope: scopeOf(), authenticate: session(), now, commit });
	assert.deepEqual(commit.calls.map(call => call.opId), [first.operation.opId, second.operation.opId, third.operation.opId]);
});

test('a pass is capped so one tab cannot hold the lease forever', async () => {
	const { store } = await fixture();
	for (let index = 0; index < 4; index += 1) {
		await store.persistDraftAndEnqueue(operationFor('/notes/' + String(index) + '.md', index));
	}
	const commit = scriptedCommit([{ status: 201, body: { seq: 1, revisionId: 'r', fileId: 'f', changeId: 'c' }, text: 'x' }]);
	const summary = await drainOutbox({ store, scope: scopeOf(), authenticate: session(), commit, maxOperations: 2 });
	assert.equal(summary.stopReason, 'cap');
	assert.equal(commit.calls.length, 2);
	assert.equal((await store.listOutbox()).length, 2);
});

test('a second tab cannot drain the queue while the lease is held', async () => {
	const { store } = await fixture();
	await store.persistDraftAndEnqueue(operationFor('/notes/a.md'));
	const holder = createLeaseManager({ store, writerId: 'tab-1' });
	const other = createLeaseManager({ store, writerId: 'tab-2' });
	assert.equal((await holder.acquire()).acquired, true);
	assert.equal((await other.acquire()).acquired, false);

	const commit = scriptedCommit([{ status: 201, body: { seq: 1, revisionId: 'r', fileId: 'f', changeId: 'c' }, text: 'x' }]);
	const summary = await drainOutbox({ store, scope: scopeOf(), authenticate: session(), commit, acquireLease: () => other.acquire(), releaseLease: () => other.release() });
	assert.equal(summary.stopReason, 'lease');
	assert.equal(commit.calls.length, 0);

	await holder.release();
	assert.equal((await other.acquire()).acquired, true);
});

test('a crashed tab lease is taken over once it expires', async () => {
	const now = clock();
	const { store } = await fixture({ now });
	const dead = createLeaseManager({ store, writerId: 'tab-dead', now, durationMs: leaseLimits.durationMs });
	const live = createLeaseManager({ store, writerId: 'tab-live', now, durationMs: leaseLimits.durationMs });
	assert.equal((await dead.acquire()).acquired, true);
	assert.equal((await live.acquire()).acquired, false);
	now.advance(leaseLimits.durationMs + 1);
	// Otherwise one crashed tab would wedge the queue until the browser cache is cleared.
	assert.equal((await live.acquire()).acquired, true);
});

test('replay refuses a queue written under a different account before sending (O04)', async () => {
	const { store } = await fixture({ accountId: 'user-a' });
	await store.persistDraftAndEnqueue(operationFor('/notes/a.md'));
	const commit = scriptedCommit([{ status: 201, body: {}, text: 'x' }]);
	const owner = await capture(drainOutbox({ store, scope: scopeOf('user-a'), authenticate: session({ accountId: 'user-b' }), commit }));
	assertOfflineError(owner, offlineErrorCodes.accountChanged);
	assert.equal(commit.calls.length, 0, 'nothing may be submitted under the wrong identity');
});

// ---------------------------------------------------------------- UI view models

test('the banner prefers the state that needs the user’s judgement', () => {
	const conflicted = offlineBanner({
		operations: [{ state: opStates.blocked, blockedReason: opBlockReasons.conflict, attempts: 1 }],
		drafts: [{ state: draftStates.conflict }],
	});
	assert.equal(conflicted.status, offlineStatuses.conflict);
	assert.deepEqual(conflicted.actions, ['resolve', 'export']);

	const locked = offlineBanner({ operations: [{ state: opStates.pending }], scopeRecord: { locked: true, lockReason: opBlockReasons.noPermission } });
	assert.equal(locked.status, offlineStatuses.blocked);
	assert.deepEqual(locked.actions, ['signIn', 'export']);

	const pending = offlineBanner({ operations: [{ state: opStates.pending }, { state: opStates.pending }] });
	assert.equal(pending.status, offlineStatuses.pending);
	assert.equal(pending.count, 2);
	assert.match(pending.message, /2/);

	const local = offlineBanner({ drafts: [{ state: draftStates.queued }] });
	assert.equal(local.status, offlineStatuses.local);
	assert.equal(offlineBanner({}).status, offlineStatuses.synced);
});

test('an expired window shows as blocked even with no queue', () => {
	const now = clock();
	const view = offlineBanner({ now, scopeRecord: { expiresMs: now() - 1, locked: false } });
	assert.equal(view.expired, true);
	assert.equal(view.status, offlineStatuses.blocked);
	assert.equal(view.remainingMs, 0);
	assert.match(offlineWindowNotice(offlineWindowLimits.defaultMs), /7 天/);
});

test('an outbox row explains the block in Chinese and stays actionable', () => {
	const rows = outboxRows({
		operations: [
			{ opId: 'b', path: '/notes/b.md', state: opStates.blocked, blockedReason: opBlockReasons.noPermission, attempts: offlineRetryCeiling - 1, createdMs: 2, nextRetryAt: 5 },
			{ opId: 'a', path: '/notes/a.md', state: opStates.pending, attempts: 0, createdMs: 1, nextRetryAt: 1 },
		],
	});
	assert.deepEqual(rows.map(row => row.opId), ['a', 'b']);
	assert.equal(rows[1].reasonText, '权限已失效，提交暂停');
	assert.equal(rows[1].nearGiveUp, true);
	assert.equal(rows[1].canRetry, false);
	assert.equal(rows[1].canExport, true);
	assert.equal(rows[0].reasonText, null);
	assert.equal(rows[0].attemptLimit, offlineRetryCeiling);
});

test('resolving a conflict never silently discards the local text', () => {
	const operation = { path: '/notes/a.md', blockedReason: opBlockReasons.conflict, baseRevision: 'rev-old' };
	assert.deepEqual(resolvePendingConflict({ operation, resolution: 'keep-mine' }), { ok: true, action: 'resubmit', baseRevision: 'rev-old', path: '/notes/a.md' });
	// "Keep theirs" destroys the user's text, so it is only legal after an export.
	assert.deepEqual(resolvePendingConflict({ operation, resolution: 'keep-theirs' }), { ok: false, reason: 'export-first' });
	assert.deepEqual(resolvePendingConflict({ operation, resolution: 'keep-theirs', exported: true }), { ok: true, action: 'discard', path: '/notes/a.md' });
	assert.deepEqual(resolvePendingConflict({ operation, resolution: 'merge' }), { ok: false, reason: 'unknown-resolution' });
	assert.deepEqual(resolvePendingConflict({ operation: { path: '/x', blockedReason: opBlockReasons.noPermission }, resolution: 'keep-mine' }), { ok: false, reason: 'not-a-conflict' });
});

test('the bulk export carries every draft it was given', () => {
	const exported = exportPendingDrafts({ drafts: [{ path: '/notes/a.md', text: 'a', digest: 'd', baseRevision: null, updatedMs: 1, state: draftStates.queued }, { path: '/notes/b.md', text: 'b', digest: 'e', baseRevision: null, updatedMs: 2, state: draftStates.conflict }] });
	assert.equal(exported.count, 2);
	assert.equal(exported.documents.length, 2);
	assert.match(exported.fileName, /^log4stellar-offline-drafts-\d{8}T\d{6}Z\.json$/);
});

test('every status action has a Chinese label', () => {
	assert.equal(actionLabel('resolve'), '处理冲突');
	assert.equal(actionLabel('export'), '导出草稿');
	assert.equal(actionLabel('signIn'), '重新登录');
	assert.equal(actionLabel('retryNow'), '立即重试');
	assert.equal(actionLabel('unknown'), 'unknown');
});

test('rendering is skipped when there is no DOM, and works when there is one', () => {
	assert.equal(renderOfflineBanner(null, { status: 'local', message: 'm', actions: [] }), false);

	// A four-line fake DOM node is enough to prove the data attributes the workbench
	// binds to and the action buttons it dispatches.
	const document = {
		createElement(tag) {
			return { tag, children: [], dataset: {}, attributes: {}, className: '', textContent: '',
				appendChild(child) { this.children.push(child); return child; },
				setAttribute(name, value) { this.attributes[name] = value; },
				replaceChildren(...nodes) { this.children = nodes; } };
		},
	};
	const root = { children: [], ownerDocument: document, replaceChildren(...nodes) { this.children = nodes; } };
	const view = offlineBanner({ operations: [{ state: opStates.pending }] });
	assert.equal(renderOfflineBanner(root, view), true);
	const banner = root.children[0];
	assert.equal(banner.dataset.offlineStatus, offlineStatuses.pending);
	assert.equal(banner.attributes.role, 'status');
	const actions = banner.children.find(child => child.className === 'log4stellar-offline-actions');
	assert.deepEqual(actions.children.map(child => child.dataset.offlineAction), view.actions);
	assert.equal(actions.children[0].textContent, '立即重试');
});

// ---------------------------------------------------------------- provider adapter

test('an edit is stored as text and read back as bytes', async () => {
	const { store } = await fixture();
	const saved = await writeOfflineDraft({ store, path: '/notes/a.md', bytes: new TextEncoder().encode('# hello'), baseRevision: null, mode: 'create' });
	assert.equal(saved.state, draftStates.queued);
	assert.equal(saved.digest, await digestText('# hello'));
	const read = await readCachedDocument({ store, path: '/notes/a.md' });
	assert.equal(read.source, 'draft');
	assert.equal(new TextDecoder().decode(read.bytes), '# hello');
	assert.equal(read.state, draftStates.queued);
});

test('a cached server document is the fallback when no draft exists', async () => {
	const { store } = await fixture();
	assert.equal(await readCachedDocument({ store, path: '/notes/a.md' }), undefined);
	await cacheServerDocument({ store, path: '/notes/a.md', bytes: '# from server', revisionId: 'rev-1', digest: await digestText('# from server'), modifiedMs: 5 });
	const read = await readCachedDocument({ store, path: '/notes/a.md' });
	// The base document is what an offline keystroke extends; without it the editor would
	// open an empty buffer and the first save would look like a deliberate truncation.
	assert.equal(read.source, 'cache');
	assert.equal(read.baseRevision, 'rev-1');
	assert.equal(new TextDecoder().decode(read.bytes), '# from server');
});

test('a draft wins over the cached base document', async () => {
	const { store } = await fixture();
	await cacheServerDocument({ store, path: '/notes/a.md', bytes: 'server', revisionId: 'rev-1', digest: await digestText('server'), modifiedMs: 5 });
	await writeOfflineDraft({ store, path: '/notes/a.md', bytes: 'local edit', baseRevision: 'rev-1' });
	const read = await readCachedDocument({ store, path: '/notes/a.md' });
	assert.equal(read.source, 'draft');
	assert.equal(new TextDecoder().decode(read.bytes), 'local edit');
});

test('a retried save keeps the identifiers it was given', async () => {
	const { store } = await fixture();
	const first = await writeOfflineDraft({ store, path: '/notes/a.md', bytes: 'one', opId: 'op-fixed', idempotencyKey: 'key-fixed' });
	assert.equal(first.opId, 'op-fixed');
	assert.equal((await store.readOperation('op-fixed')).idempotencyKey, 'key-fixed');
	// A retry must not mint a new key: a second key is a second version on the server.
	const again = await writeOfflineDraft({ store, path: '/notes/a.md', bytes: 'one', opId: 'op-fixed', idempotencyKey: 'key-fixed' });
	assert.equal(again.opId, 'op-fixed');
	assert.equal((await store.listOutbox()).length, 1);
});

test('a generated operation id and key satisfy the sync contract', async () => {
	const operationId = newOperationId();
	const key = newIdempotencyKey();
	assert.match(operationId, /^op-/);
	assert.ok(key.length >= 8 && key.length <= 200);
	assert.match(key, /^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
	assert.notEqual(newOperationId(), newOperationId());
});

test('a status describes one document without rendering it', async () => {
	const { store } = await fixture();
	assert.deepEqual(await documentStatus({ store, path: '/notes/a.md' }), { path: '/notes/a.md', status: 'absent', operation: null });
	const saved = await writeOfflineDraft({ store, path: '/notes/a.md', bytes: 'x' });
	const status = await documentStatus({ store, path: '/notes/a.md' });
	assert.equal(status.status, draftStates.queued);
	assert.equal(status.operation.opId, saved.opId);
	assert.equal(status.operation.state, opStates.pending);
});

test('a draft is only discarded once nothing is queued for it', async () => {
	const { store } = await fixture();
	const saved = await writeOfflineDraft({ store, path: '/notes/a.md', bytes: 'x' });
	// Discarding a queued draft is the one irreversible loss in the feature.
	await assert.rejects(discardDraft({ store, path: '/notes/a.md' }), /still queued/);
	await store.blockOperation({ opId: saved.opId, reason: opBlockReasons.conflict });
	const discarded = await discardDraft({ store, path: '/notes/a.md' });
	assert.equal(discarded.discarded, true);
	assert.equal(discarded.exportedText, 'x');
	assert.equal((await discardDraft({ store, path: '/notes/a.md' })).discarded, false);
});

test('a shared browser or an account-less scope cannot use offline storage', () => {
	assert.equal(canUseOffline({ scope: { sharedDevice: false, accountId: 'user-a' } }), true);
	assert.equal(canUseOffline({ scope: { sharedDevice: true, accountId: 'user-a' } }), false);
	assert.equal(canUseOffline({ scope: { sharedDevice: false, accountId: '' } }), false);
	assert.equal(canUseOffline({ scope: null }), false);
});

// ---------------------------------------------------------------- module serving

/** The smallest Koa-shaped context the module server needs: path, method, headers, body. */
function context({ method = 'GET', path, headers = {} } = {}) {
	const stored = new Map(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
	return {
		method,
		path,
		type: undefined,
		body: undefined,
		status: undefined,
		set(name, value) {
			stored.set(name.toLowerCase(), value);
		},
		get(name) {
			return stored.get(name.toLowerCase());
		},
	};
}

test('the offline module route serves every module the client imports', async () => {
	const modules = await import('./offline-files.mjs');
	assert.deepEqual([...modules.offlineModules].sort(), ['offline-client.js', 'offline-contract.js', 'offline-coordinator.js', 'offline-provider.js', 'offline-store.js', 'offline-ui.js']);
	assert.equal(modules.offlineModulePath('offline-store.js'), '/api/offline-editing/offline-store.js');
	assert.equal(modules.isOfflineRequest('/api/offline-editing'), true);
	assert.equal(modules.isOfflineRequest('/api/offline-editing/offline-ui.js'), true);
	// A path that merely starts with the name must not be treated as the mount, or the
	// auth gate would be skipped for `/api/offline-editing-something`.
	assert.equal(modules.isOfflineRequest('/api/offline-editingX'), false);
	assert.equal(modules.isOfflineRequest('/api/session'), false);

	for (const name of modules.offlineModules) {
		const ctx = await context({ method: 'GET', path: modules.offlineModulePath(name) });
		await modules.serveOfflineRequest(ctx);
		assert.equal(ctx.status, undefined, 'expected a 200 for ' + name);
		assert.equal(ctx.type, 'js');
		assert.equal(ctx.get('Cache-Control'), 'no-store');
		assert.ok(typeof ctx.body === 'string' && ctx.body.length > 0);
	}
});

test('an unknown or non-GET module request is refused with an API error body', async () => {
	const modules = await import('./offline-files.mjs');
	const missing = await context({ method: 'GET', path: '/api/offline-editing/offline-nope.js' });
	await modules.serveOfflineRequest(missing);
	assert.equal(missing.status, 404);
	assert.deepEqual(missing.body, { error: 'NotFound' });

	const post = await context({ method: 'POST', path: '/api/offline-editing/offline-store.js' });
	await modules.serveOfflineRequest(post);
	assert.equal(post.status, 405);
	assert.deepEqual(post.body, { error: 'MethodNotAllowed' });
});
