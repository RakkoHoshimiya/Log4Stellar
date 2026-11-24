import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Readable } from 'node:stream';
import { openPreviewBlobs, previewCacheRoot } from './office-preview-blobs.mjs';
import {
	attemptObjectKey,
	makePreviewKey,
	officePreviewErrorCodes as codes,
	officePreviewLimits,
	officePreviewStates as states,
} from './office-preview-contract.mjs';
import {
	openPreviewPdf,
	publicPreview,
	requestOfficePreview,
	resolvePreviewSource,
	runPreviewCycle,
} from './office-preview-service.mjs';
import { WorkspaceError } from './workspace-contract.mjs';

// The state machine of §5, driven with a fake clock, a fake converter and an in-memory
// store that mirrors the real one's contract. This is where PV02 (dedupe), PV05 (failure
// classification), PV06 (lease recovery) and PV07/PV08 (rebuild and single conversion) are
// pinned without PostgreSQL: the real SQL is exercised by the integration test.

const workspaceId = 'l4s-test-unit';
const fileId = '11111111-1111-4111-8111-111111111111';
const revisionId = '22222222-2222-4222-8222-222222222222';
const otherRevisionId = '33333333-3333-4333-8333-333333333333';
const profileFingerprint = 'f'.repeat(32);
const revisions = new Set([revisionId, otherRevisionId]);
const pdfBytes = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');

/**
 * In-memory implementation of the store contract. Every method mirrors the observable
 * behaviour of `office-preview-store.mjs`: dedupe by the five column key, a queue cap, a
 * deployment wide single slot, lease expiry recovery, attempt fencing and an LRU.
 */
function memoryStore({ maxQueued = 20, slots = 1 } = {}) {
	const rows = new Map();
	const byKey = new Map();
	let slot; // { ownerId, leaseUntilMs }
	let depthSeen = 0;
	let claimLog = [];

	const clone = row => ({ ...row });

	function keyOf(source) {
		return [source.workspaceId, source.fileId, source.revisionId, source.sha256, profileFingerprint].join('|');
	}

	function queueDepth() {
		return [...rows.values()].filter(row => row.state === states.queued).length;
	}

	const store = {
		rows,
		get claimLog() { return claimLog; },
		get claimCount() { return claimLog.length; },
		get slot() { return slot; },
		get depthSeen() { return depthSeen; },

		async currentVersionSource(scopeWorkspaceId, id) {
			if (scopeWorkspaceId !== workspaceId || id !== fileId) {
				return undefined;
			}
			return {
				workspaceId, fileId, revisionId, sha256: 'a'.repeat(64), sizeBytes: 100, path: '/docs/report.docx',
			};
		},

		async findVersionSource(scopeWorkspaceId, id, revision) {
			if (scopeWorkspaceId !== workspaceId || id !== fileId) {
				return undefined;
			}
			if (!revisions.has(revision)) {
				return undefined;
			}
			// A distinct digest per revision, so each one is a distinct dedupe key.
			const digest = (revision === revisionId ? 'a' : revision === otherRevisionId ? 'b' : revision.slice(0, 1)).repeat(64);
			return {
				workspaceId, fileId, revisionId: revision, sha256: digest, sizeBytes: 100, path: '/docs/report.docx',
			};
		},

		async versionExists(scopeWorkspaceId, id, revision) {
			return scopeWorkspaceId === workspaceId && id === fileId && revisions.has(revision);
		},

		async getOrEnqueuePreview({ source, nowMs }) {
			const key = keyOf(source);
			const existing = byKey.get(key);
			if (existing) {
				if (existing.state === states.ready || existing.state === states.queued || existing.state === states.running) {
					existing.lastAccessMs = nowMs;
					return clone(existing);
				}
				if (existing.state === states.failed && !existing.retryable) {
					return clone(existing);
				}
				if (queueDepth() >= maxQueued) {
					throw new WorkspaceError(429, codes.queueFull);
				}
				Object.assign(existing, {
					state: states.queued, attemptId: undefined, leaseUntilMs: null, errorCode: undefined,
					retryable: false, reservedBytes: 0, sizeBytes: 0, objectKey: undefined,
					updatedMs: nowMs, lastAccessMs: nowMs,
				});
				return clone(existing);
			}
			if (queueDepth() >= maxQueued) {
				throw new WorkspaceError(429, codes.queueFull);
			}
			const row = {
				previewId: crypto.randomUUID(),
				workspaceId: source.workspaceId,
				fileId: source.fileId,
				revisionId: source.revisionId,
				sourceSha256: source.sha256,
				profileFingerprint,
				previewKey: makePreviewKey(source, profileFingerprint),
				state: states.queued,
				attemptId: undefined,
				attemptCount: 0,
				leaseUntilMs: null,
				sizeBytes: 0,
				reservedBytes: 0,
				objectKey: undefined,
				retryable: false,
				errorCode: undefined,
				createdMs: nowMs,
				updatedMs: nowMs,
				lastAccessMs: nowMs,
			};
			rows.set(row.previewId, row);
			byKey.set(key, row);
			return clone(row);
		},

		async getPreview(scopeWorkspaceId, id, nowMs) {
			const row = rows.get(id);
			if (!row || row.workspaceId !== scopeWorkspaceId) {
				return undefined;
			}
			row.lastAccessMs = nowMs ?? row.lastAccessMs;
			return clone(row);
		},

		async getPreviewByObject(scopeWorkspaceId, id) {
			const row = rows.get(id);
			if (!row || row.workspaceId !== scopeWorkspaceId) {
				return undefined;
			}
			return clone(row);
		},

		async queueDepth() {
			return queueDepth();
		},

		async releaseExpiredLeases(nowMs, maxAttempts = 3) {
			let recovered = 0;
			for (const row of rows.values()) {
				if (row.state !== states.running || row.leaseUntilMs === null || row.leaseUntilMs >= nowMs) {
					continue;
				}
				recovered += 1;
				const exhausted = row.attemptCount >= maxAttempts;
				row.state = exhausted ? states.failed : states.queued;
				row.errorCode = exhausted ? codes.timeout : undefined;
				row.retryable = !exhausted;
				row.attemptId = undefined;
				row.leaseUntilMs = null;
				row.reservedBytes = 0;
				row.updatedMs = nowMs;
			}
			if (slot && slot.leaseUntilMs < nowMs) {
				slot = undefined;
			}
			depthSeen = queueDepth();
			return recovered;
		},

		async claimPreviewJob({ workerId, leaseMs, nowMs }) {
			await store.releaseExpiredLeases(nowMs);
			if (slot && slot.leaseUntilMs >= nowMs) {
				return undefined;
			}
			slot = { ownerId: workerId, leaseUntilMs: nowMs + leaseMs };
			const queued = [...rows.values()]
				.filter(row => row.state === states.queued)
				.sort((left, right) => left.createdMs - right.createdMs || left.previewId.localeCompare(right.previewId));
			const row = queued[0];
			if (!row) {
				slot = undefined;
				return undefined;
			}
			row.state = states.running;
			row.attemptId = crypto.randomUUID();
			row.attemptCount += 1;
			row.leaseUntilMs = nowMs + leaseMs;
			row.updatedMs = nowMs;
			claimLog.push({ previewId: row.previewId, workerId, attemptId: row.attemptId });
			// The deployment wide slot is what guarantees this: after a claim there is
			// exactly one running row, never two.
			const running = [...rows.values()].filter(candidate => candidate.state === states.running);
			assert.equal(running.length, 1, 'only one conversion may be running at a time');
			return { ...clone(row), workerId };
		},

		async renewLease({ previewId, attemptId, workerId, leaseMs, nowMs }) {
			const row = rows.get(previewId);
			if (!row || row.attemptId !== attemptId || row.state !== states.running) {
				return false;
			}
			row.leaseUntilMs = nowMs + leaseMs;
			if (slot && slot.ownerId === workerId) {
				slot.leaseUntilMs = nowMs + leaseMs;
			}
			return true;
		},

		async releaseSlot(workerId) {
			if (slot && slot.ownerId === workerId) {
				slot = undefined;
			}
		},

		async reserveCache({ previewId, attemptId, bytes, budgetBytes, nowMs }) {
			const row = rows.get(previewId);
			let held = 0;
			for (const candidate of rows.values()) {
				if (candidate.workspaceId === row.workspaceId && (candidate.state === 'ready' || candidate.state === 'running')) {
					held += candidate.sizeBytes + candidate.reservedBytes;
				}
			}
			if (held + bytes > budgetBytes) {
				return { ok: false, held, budgetBytes };
			}
			row.reservedBytes = bytes;
			row.updatedMs = nowMs;
			return { ok: true, held };
		},

		async evictionCandidates(limit = 64) {
			return [...rows.values()]
				.filter(row => row.workspaceId === workspaceId && row.state === 'ready' && row.objectKey)
				.sort((left, right) => left.lastAccessMs - right.lastAccessMs)
				.slice(0, limit)
				.map(row => ({ previewId: row.previewId, objectKey: row.objectKey, sizeBytes: row.sizeBytes, lastAccessMs: row.lastAccessMs }));
		},

		async markEvicted(previewId) {
			const row = rows.get(previewId);
			if (row && row.state === states.ready) {
				Object.assign(row, { state: states.evicted, sizeBytes: 0, reservedBytes: 0, objectKey: undefined });
			}
		},

		async finalizePreview({ previewId, attemptId, objectKey, sizeBytes, nowMs }) {
			const row = rows.get(previewId);
			if (!row || row.attemptId !== attemptId || row.state !== states.running || row.leaseUntilMs < nowMs) {
				return undefined;
			}
			Object.assign(row, {
				state: states.ready, sizeBytes, reservedBytes: 0, objectKey, errorCode: undefined,
				retryable: false, attemptId: undefined, leaseUntilMs: null, updatedMs: nowMs, lastAccessMs: nowMs,
			});
			slot = undefined;
			return clone(row);
		},

		async failPreviewAttempt({ previewId, attemptId, errorCode, retryable, maxAttempts, nowMs }) {
			const row = rows.get(previewId);
			if (!row || row.attemptId !== attemptId || row.state !== states.running) {
				return undefined;
			}
			const retry = retryable && row.attemptCount < maxAttempts;
			Object.assign(row, {
				state: retry ? states.queued : states.failed,
				errorCode: retry ? undefined : errorCode,
				retryable: retry,
				attemptId: undefined, leaseUntilMs: null, reservedBytes: 0, updatedMs: nowMs,
			});
			slot = undefined;
			return { state: row.state, errorCode: row.errorCode };
		},
	};
	return store;
}

/** In-memory blob store with an LRU account, mirroring office-preview-blobs.mjs. */
function memoryBlobs({ budgetBytes = Infinity } = {}) {
	const objects = new Map();
	return {
		objects,
		async put(key, source, limit) {
			const chunks = [];
			for await (const chunk of source) {
				chunks.push(chunk);
			}
			const body = Buffer.concat(chunks);
			if (body.length > limit) {
				throw new WorkspaceError(413, codes.fileTooLarge);
			}
			objects.set(key, body);
			return { key, size: body.length, sha256: 'c'.repeat(64) };
		},
		async open(key, expectedSize, range) {
			const body = objects.get(key);
			if (!body) {
				throw new WorkspaceError(502, 'StorageObjectMissing');
			}
			const wanted = range ?? { start: 0, end: body.length - 1 };
			return { size: body.length, stream: Readable.from([body.subarray(wanted.start, wanted.end + 1)]) };
		},
		async remove(key) {
			objects.delete(key);
		},
		async evict({ wantedBytes, budgetBytes: budget, listCandidates, markEvicted, keep }) {
			let freed = 0;
			for (const candidate of await listCandidates()) {
				if (freed >= wantedBytes) {
					break;
				}
				if (keep && keep(candidate)) {
					continue;
				}
				objects.delete(candidate.objectKey);
				freed += candidate.sizeBytes;
				await markEvicted(candidate);
			}
			return freed;
		},
	};
}

/** A converter that produces a valid PDF without touching LibreOffice. */
function fakeConverter({ bytes = pdfBytes, fail } = {}) {
	const calls = [];
	const run = async () => {
		calls.push(calls.length + 1);
		if (fail) {
			throw Object.assign(new WorkspaceError(fail.status ?? 415, fail.code), { retryable: fail.retryable ?? false });
		}
		return { objectKey: 'unused', size: bytes.length, sha256: 'd'.repeat(64), durationMs: 1 };
	};
	return { calls, run };
}

function cycleOptions({ store, blobs, converter, nowMs = 1000, limits = officePreviewLimits({}) }) {
	return {
		store,
		blobs,
		limits,
		workerId: 'worker-1',
		converterPath: '/bin/true',
		cacheDirectory: '/tmp',
		nowMs,
		// The service hands this to runPreviewJob, which writes a real copy and runs a
		// child process; the fake converter path is injected by replacing runPreviewJob's
		// converter with a stub through this hook below.
		openOriginal: async () => Buffer.from('document'),
		__converter: converter,
	};
}

// The service imports runPreviewJob directly, so the fake converter is installed by
// giving the job an extension of `.docx` and pointing `converterPath` at a real script
// that writes a PDF. That would be slow and shell dependent in a unit test, so instead
// the tests drive the *decision* layer (`requestOfficePreview`, `openPreviewPdf`, the
// lease/fencing rules) and the pub/sub store transitions, and the conversion itself is
// covered by office-preview-worker.test.mjs with real child processes.

// ------------------------------------------------------------------- resolve + request

test('resolvePreviewSource refuses malformed ids before touching the store', async () => {
	const store = memoryStore();
	for (const [file, revision] of [['not-a-uuid', undefined], [fileId, 'nope'], [undefined, undefined], [12, undefined]]) {
		await assert.rejects(
			resolvePreviewSource({ store, workspaceId, fileId: file, revisionId: revision }),
			error => error.status === 400 && error.code === codes.invalidRequest,
		);
	}
});

test('resolvePreviewSource defaults to the current revision and reads the digest from metadata', async () => {
	const store = memoryStore();
	const source = await resolvePreviewSource({ store, workspaceId, fileId });
	assert.equal(source.revisionId, revisionId);
	assert.equal(source.sha256, 'a'.repeat(64));
	assert.equal(source.extension, '.docx');

	const past = await resolvePreviewSource({ store, workspaceId, fileId, revisionId: otherRevisionId });
	assert.equal(past.revisionId, otherRevisionId);
});

test('an unknown file or revision is 404 and an unsupported format is 415', async () => {
	const store = memoryStore();
	await assert.rejects(
		resolvePreviewSource({ store, workspaceId, fileId: '99999999-9999-4999-8999-999999999999' }),
		error => error.status === 404 && error.code === codes.notFound,
	);
	await assert.rejects(
		resolvePreviewSource({ store, workspaceId: 'l4s-test-other', fileId }),
		error => error.status === 404,
	);
	// A `.doc`/`.pdf` source is a download-only format, so the answer is 415 with no row.
	const legacy = {
		...store,
		async currentVersionSource() {
			return { workspaceId, fileId, revisionId, sha256: 'a'.repeat(64), sizeBytes: 10, path: '/old.doc' };
		},
	};
	await assert.rejects(
		resolvePreviewSource({ store: legacy, workspaceId, fileId }),
		error => error.status === 415 && error.code === codes.unsupportedFormat,
	);
});

test('PV05: an oversized original is 413 before any row is created', async () => {
	const store = memoryStore();
	let enqueued = false;
	const spying = { ...store, async getOrEnqueuePreview(args) { enqueued = true; return store.getOrEnqueuePreview(args); } };
	await assert.rejects(
		requestOfficePreview({
			store: spying,
			limits: { ...officePreviewLimits({}), maxInputBytes: 50 },
			profileFingerprint,
			workspaceId,
			fileId,
		}),
		error => error.status === 413 && error.code === codes.fileTooLarge,
	);
	assert.equal(enqueued, false);
});

test('PV02: the same version is the same preview, and a first request is 202', async () => {
	const store = memoryStore();
	const limits = officePreviewLimits({});
	const first = await requestOfficePreview({ store, limits, profileFingerprint, workspaceId, fileId, nowMs: 1 });
	assert.equal(first.status, 202);
	assert.equal(first.preview.state, states.queued);

	const second = await requestOfficePreview({ store, limits, profileFingerprint, workspaceId, fileId, nowMs: 2 });
	assert.equal(second.status, 202);
	assert.equal(second.preview.previewId, first.preview.previewId, 'the same version must not create a second job');
	assert.equal(store.rows.size, 1);

	// Once ready, the same request is a hit: 200 and no new row.
	const row = store.rows.get(first.preview.previewId);
	Object.assign(row, { state: states.ready, objectKey: attemptObjectKey(row.previewKey, '44444444-4444-4444-8444-444444444444'), sizeBytes: 100 });
	const hit = await requestOfficePreview({ store, limits, profileFingerprint, workspaceId, fileId, nowMs: 3 });
	assert.equal(hit.status, 200);
	assert.equal(hit.preview.previewId, first.preview.previewId);
	assert.equal(store.rows.size, 1);
});

test('PV03: two revisions of one file are two independent previews', async () => {
	const store = memoryStore();
	const limits = officePreviewLimits({});
	const current = await requestOfficePreview({ store, limits, profileFingerprint, workspaceId, fileId, nowMs: 1 });
	const past = await requestOfficePreview({ store, limits, profileFingerprint, workspaceId, fileId, revisionId: otherRevisionId, nowMs: 1 });
	assert.notEqual(past.preview.previewId, current.preview.previewId);
	assert.equal(past.preview.revisionId, otherRevisionId);
	assert.equal(store.rows.size, 2);
});

test('a permanent failure is reported with its classified code, never re-queued', async () => {
	const store = memoryStore();
	const limits = officePreviewLimits({});
	const { preview } = await requestOfficePreview({ store, limits, profileFingerprint, workspaceId, fileId, nowMs: 1 });
	Object.assign(store.rows.get(preview.previewId), {
		state: states.failed, errorCode: codes.passwordProtected, retryable: false,
	});
	await assert.rejects(
		requestOfficePreview({ store, limits, profileFingerprint, workspaceId, fileId, nowMs: 2 }),
		error => error.status === 415 && error.code === codes.passwordProtected && error.preview?.previewId === preview.previewId,
	);
	// A permanent content failure must not create a second job either.
	assert.equal(store.rows.size, 1);
});

test('a resource limit failure maps to 413', async () => {
	const store = memoryStore();
	const limits = officePreviewLimits({});
	const { preview } = await requestOfficePreview({ store, limits, profileFingerprint, workspaceId, fileId, nowMs: 1 });
	Object.assign(store.rows.get(preview.previewId), {
		state: states.failed, errorCode: codes.resourceLimit, retryable: false,
	});
	await assert.rejects(
		requestOfficePreview({ store, limits, profileFingerprint, workspaceId, fileId, nowMs: 2 }),
		error => error.status === 413 && error.code === codes.resourceLimit,
	);
});

test('the queue cap is a 429 and an existing row is still served', async () => {
	const store = memoryStore({ maxQueued: 1 });
	const limits = officePreviewLimits({});
	await requestOfficePreview({ store, limits, profileFingerprint, workspaceId, fileId, nowMs: 1 });
	await assert.rejects(
		requestOfficePreview({ store, limits, profileFingerprint, workspaceId, fileId, revisionId: otherRevisionId, nowMs: 1 }),
		error => error.status === 429 && error.code === codes.queueFull,
	);
	// Asking again for the row that already exists is not blocked by the cap.
	const repeat = await requestOfficePreview({ store, limits, profileFingerprint, workspaceId, fileId, nowMs: 2 });
	assert.equal(repeat.status, 202);
});

// ------------------------------------------------------------------- public shape

test('the public shape carries no key, path or command line', () => {
	const row = {
		previewId: '11111111-1111-4111-8111-111111111111',
		state: states.ready,
		revisionId,
		fileId,
		createdMs: 1000,
		updatedMs: 2000,
		sizeBytes: 4096,
		objectKey: 'office-previews/ab/…/attempt.pdf',
		errorCode: undefined,
		previewKey: 'k'.repeat(64),
		sourceSha256: 'a'.repeat(64),
	};
	const body = publicPreview(row);
	assert.deepEqual(body, {
		id: row.previewId,
		state: 'ready',
		revisionId,
		fileId,
		createdAt: new Date(1000).toISOString(),
		updatedAt: new Date(2000).toISOString(),
		size: 4096,
	});
	const text = JSON.stringify(body);
	assert.doesNotMatch(text, /office-previews\//);
	assert.doesNotMatch(text, /tmp/);
	assert.equal(body.objectKey, undefined);

	const failed = publicPreview({ ...row, state: states.failed, errorCode: codes.corruptSource, retryable: false, sizeBytes: 0 });
	assert.equal(failed.error, codes.corruptSource);
	assert.equal(failed.retryable, false);
	assert.equal(failed.size, undefined);
});

// ------------------------------------------------------------------- lease / fencing

test('PV06: a crashed worker lease is recovered and the job becomes claimable again', async () => {
	const store = memoryStore();
	const limits = officePreviewLimits({});
	const { preview } = await requestOfficePreview({ store, limits, profileFingerprint, workspaceId, fileId, nowMs: 0 });
	const claimed = await store.claimPreviewJob({ workerId: 'worker-a', leaseMs: 1000, nowMs: 10 });
	assert.equal(claimed.previewId, preview.previewId);
	assert.equal(claimed.state, states.running);
	assert.equal(store.slot.ownerId, 'worker-a');

	// The worker "dies": no renew, no finalize.
	const recovered = await store.releaseExpiredLeases(2000, limits.maxAttempts);
	assert.equal(recovered, 1);
	assert.equal(store.rows.get(preview.previewId).state, states.queued);
	assert.equal(store.rows.get(preview.previewId).retryable, true);

	// A new worker can claim it again.
	const second = await store.claimPreviewJob({ workerId: 'worker-b', leaseMs: 1000, maxAttempts: limits.maxAttempts, nowMs: 2001 });
	assert.equal(second.previewId, preview.previewId);
	assert.equal(second.attemptCount, 2);
});

test('PV06: only the attempt that still owns the lease may publish', async () => {
	const store = memoryStore();
	const { preview } = await requestOfficePreview({
		store, limits: officePreviewLimits({}), profileFingerprint, workspaceId, fileId, nowMs: 0,
	});
	const first = await store.claimPreviewJob({ workerId: 'worker-a', leaseMs: 1000, nowMs: 10 });
	// The lease expires and a second worker takes over before the first publishes.
	await store.releaseExpiredLeases(2000);
	const second = await store.claimPreviewJob({ workerId: 'worker-b', leaseMs: 1000, nowMs: 2001 });
	assert.notEqual(first.attemptId, second.attemptId);

	// The stale attempt is fenced out, and the fresh one publishes.
	const stale = await store.finalizePreview({
		previewId: preview.previewId, attemptId: first.attemptId, objectKey: 'office-previews/ab/x/old.pdf', sizeBytes: 10, nowMs: 2002,
	});
	assert.equal(stale, undefined);
	const fresh = await store.finalizePreview({
		previewId: preview.previewId, attemptId: second.attemptId, objectKey: 'office-previews/ab/x/new.pdf', sizeBytes: 20, nowMs: 2002,
	});
	assert.equal(fresh.state, states.ready);
	assert.equal(fresh.sizeBytes, 20);
	assert.equal(fresh.objectKey, 'office-previews/ab/x/new.pdf');
});

test('an attempt that lost its lease cannot mark the row failed either', async () => {
	const store = memoryStore();
	const { preview } = await requestOfficePreview({
		store, limits: officePreviewLimits({}), profileFingerprint, workspaceId, fileId, nowMs: 0,
	});
	const first = await store.claimPreviewJob({ workerId: 'worker-a', leaseMs: 1000, nowMs: 10 });
	await store.releaseExpiredLeases(2000);
	await store.claimPreviewJob({ workerId: 'worker-b', leaseMs: 1000, nowMs: 2001 });
	const stale = await store.failPreviewAttempt({
		previewId: preview.previewId, attemptId: first.attemptId, errorCode: codes.unavailable, retryable: true, maxAttempts: 3, nowMs: 2002,
	});
	assert.equal(stale, undefined);
	assert.equal(store.rows.get(preview.previewId).state, states.running);
});

test('PV08: only one claim succeeds while the slot is held', async () => {
	const store = memoryStore();
	const limits = officePreviewLimits({});
	// Five independent previews (five revisions, therefore five dedupe keys) wait for one
	// worker. This is PV08: however many requests arrive, only one conversion starts.
	const extraRevisions = [
		'44444444-4444-4444-8444-444444444444',
		'55555555-5555-4555-8555-555555555555',
		'66666666-6666-4666-8666-666666666666',
	].map(revision => revision);
	for (const revision of extraRevisions) {
		revisions.add(revision);
	}
	await requestOfficePreview({ store, limits, profileFingerprint, workspaceId, fileId, nowMs: 0 });
	for (const [index, revision] of extraRevisions.entries()) {
		await requestOfficePreview({
			store, limits, profileFingerprint, workspaceId, fileId, revisionId: revision, nowMs: index + 1,
		});
	}
	assert.equal(await store.queueDepth(), 4);
	const first = await store.claimPreviewJob({ workerId: 'worker-a', leaseMs: 1000, nowMs: 10 });
	assert.ok(first);
	const second = await store.claimPreviewJob({ workerId: 'worker-b', leaseMs: 1000, nowMs: 10 });
	assert.equal(second, undefined, 'a second worker must not get the slot');
	// And the row itself is not claimable twice.
	const third = await store.claimPreviewJob({ workerId: 'worker-a', leaseMs: 1000, nowMs: 11 });
	assert.equal(third, undefined);
});

// ------------------------------------------------------------------- cache budget

test('PV07: an evicted tombstone is rebuilt by the next request', async () => {
	const store = memoryStore();
	const limits = officePreviewLimits({});
	const { preview } = await requestOfficePreview({ store, limits, profileFingerprint, workspaceId, fileId, nowMs: 0 });
	const claimed = await store.claimPreviewJob({ workerId: 'worker-a', leaseMs: 1000, nowMs: 1 });
	await store.finalizePreview({
		previewId: claimed.previewId, attemptId: claimed.attemptId, objectKey: 'office-previews/ab/x/a.pdf', sizeBytes: 10, nowMs: 2,
	});
	await store.markEvicted(preview.previewId);
	assert.equal(store.rows.get(preview.previewId).state, states.evicted);

	// The same request re-queues the tombstone instead of inserting a second row.
	const rebuilt = await requestOfficePreview({ store, limits, profileFingerprint, workspaceId, fileId, nowMs: 3 });
	assert.equal(rebuilt.status, 202);
	assert.equal(rebuilt.preview.previewId, preview.previewId);
	assert.equal(rebuilt.preview.state, states.queued);
	assert.equal(store.rows.size, 1);
});

test('a ready preview whose object vanished is reported as not ready and tombstoned', async () => {
	const store = memoryStore();
	const blobs = memoryBlobs();
	const limits = officePreviewLimits({});
	const { preview } = await requestOfficePreview({ store, limits, profileFingerprint, workspaceId, fileId, nowMs: 0 });
	const claimed = await store.claimPreviewJob({ workerId: 'worker-a', leaseMs: 1000, nowMs: 1 });
	await store.finalizePreview({
		previewId: claimed.previewId, attemptId: claimed.attemptId, objectKey: 'office-previews/ab/x/a.pdf', sizeBytes: 10, nowMs: 2,
	});
	// No object was ever written, so the blob store throws StorageObjectMissing.
	await assert.rejects(
		openPreviewPdf({ store, blobs, workspaceId, previewId: preview.previewId }),
		error => error.status === 409 && error.code === codes.notReady,
	);
	assert.equal(store.rows.get(preview.previewId).state, states.evicted);
});

test('the cache budget refuses a publication that would exceed it', async () => {
	const store = memoryStore();
	const { preview } = await requestOfficePreview({
		store, limits: officePreviewLimits({}), profileFingerprint, workspaceId, fileId, nowMs: 0,
	});
	const claimed = await store.claimPreviewJob({ workerId: 'worker-a', leaseMs: 1000, nowMs: 1 });
	const refused = await store.reserveCache({
		previewId: claimed.previewId, attemptId: claimed.attemptId, bytes: 4096, budgetBytes: 1024, nowMs: 2,
	});
	assert.equal(refused.ok, false);
	const allowed = await store.reserveCache({
		previewId: claimed.previewId, attemptId: claimed.attemptId, bytes: 512, budgetBytes: 1024, nowMs: 2,
	});
	assert.equal(allowed.ok, true);
	assert.equal(store.rows.get(preview.previewId).reservedBytes, 512);
});

// ------------------------------------------------------------------- blob store

test('the derived PDF store is a private directory outside the workspace', async () => {
	assert.match(previewCacheRoot({}), /log4stellar-office-previews$/);
	assert.equal(previewCacheRoot({ LOG4STELLAR_OFFICE_CACHE_DIR: '/tmp/x' }), '/tmp/x');
	// It must never default into the workspace, the config directory or the release.
	assert.doesNotMatch(previewCacheRoot({}), /\/home\/agent/);

	const root = await mkdtemp(join(tmpdir(), 'l4s-blobs-'));
	const blobs = await openPreviewBlobs({ directory: root, maxBytes: 1024 });
	const key = 'office-previews/ab/' + 'a'.repeat(64) + '/11111111-1111-4111-8111-111111111111.pdf';
	const put = await blobs.put(key, Readable.from([pdfBytes]), 1024);
	assert.equal(put.size, pdfBytes.length);
	assert.match(put.sha256, /^[0-9a-f]{64}$/);
	// The bytes landed inside the configured root, under the key.
	assert.equal((await readFile(join(root, key))).equals(pdfBytes), true);

	const head = await blobs.head(key, 5);
	assert.equal(head.toString('latin1'), '%PDF-');
	const opened = await blobs.open(key, pdfBytes.length);
	const chunks = [];
	for await (const chunk of opened.stream) {
		chunks.push(chunk);
	}
	assert.equal(Buffer.concat(chunks).equals(pdfBytes), true);

	const ranged = await blobs.open(key, pdfBytes.length, { start: 0, end: 4 });
	const rangedChunks = [];
	for await (const chunk of ranged.stream) {
		rangedChunks.push(chunk);
	}
	assert.equal(Buffer.concat(rangedChunks).toString('latin1'), '%PDF-');

	// A size mismatch and a missing object are integrity errors, not silent short reads.
	await assert.rejects(blobs.open(key, pdfBytes.length + 1), error => error.code === 'StorageIntegrityMismatch');
	await assert.rejects(blobs.open('office-previews/ab/' + 'b'.repeat(64) + '/11111111-1111-4111-8111-111111111111.pdf', 10), error => error.code === 'StorageObjectMissing');
	// A key outside the preview prefix is refused before it can escape the root.
	await assert.rejects(blobs.put('../escape.pdf', Readable.from([pdfBytes])), error => error.status === 400);
	await assert.rejects(blobs.open('office-previews/zz/' + 'a'.repeat(64) + '/11111111-1111-4111-8111-111111111111.pdf', 10), error => error.status === 400);
});

test('the derived PDF store rejects an object above the output budget', async () => {
	const root = await mkdtemp(join(tmpdir(), 'l4s-blobs-'));
	const blobs = await openPreviewBlobs({ directory: root, maxBytes: 16 });
	const key = 'office-previews/ab/' + 'a'.repeat(64) + '/11111111-1111-4111-8111-111111111111.pdf';
	await assert.rejects(
		blobs.put(key, Readable.from([Buffer.alloc(64, 0x41)]), 16),
		error => error.status === 413,
	);
	// A rejected upload leaves no partial object behind.
	assert.equal(await blobs.usage(), 0);
});

test('the derived PDF store removes only the keys it is given', async () => {
	const root = await mkdtemp(join(tmpdir(), 'l4s-blobs-'));
	const blobs = await openPreviewBlobs({ directory: root, maxBytes: 1024 });
	const kept = 'office-previews/ab/' + 'a'.repeat(64) + '/11111111-1111-4111-8111-111111111111.pdf';
	const dropped = 'office-previews/ab/' + 'b'.repeat(64) + '/22222222-2222-4222-8222-222222222222.pdf';
	await blobs.put(kept, Readable.from([pdfBytes]), 1024);
	await blobs.put(dropped, Readable.from([pdfBytes]), 1024);
	assert.equal(await blobs.usage(), pdfBytes.length * 2);
	await blobs.remove(dropped);
	assert.equal(await blobs.usage(), pdfBytes.length);
	// Removing a key that is already gone is not an error: a retried cleanup must be safe.
	await blobs.remove(dropped);
});
