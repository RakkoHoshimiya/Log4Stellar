import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { WorkspaceError } from './workspace-contract.mjs';
import {
	capabilityForSyncRequest,
	changeKinds,
	conflictPath,
	decodeCursor,
	decodePageToken,
	encodeCursor,
	encodePageToken,
	fallbackDeviceId,
	formatConflictTimestamp,
	idempotencyFingerprint,
	idempotencyKeyLimits,
	isChangeKind,
	isValidDeviceId,
	isValidIdempotencyKey,
	nextConflictPath,
	normalizeDeviceId,
	normalizePageSize,
	requireBaseRevision,
	requireChangeKind,
	requireHeadCursor,
	requireIdempotencyKey,
	requireLiveCursor,
	requireRetainedCursor,
	requireUploadMode,
	syncCapabilities,
	syncErrorCodes,
	syncErrorStatus,
	syncPageLimits,
	syncRetention,
	syncRoutes,
	syncUploadModes,
} from './sync-contract.mjs';

const workspaceId = 'log4stellar-main';

test('a cursor round-trips the kind, the workspace and the sequence', () => {
	const cursor = encodeCursor({ workspaceId, seq: 42 });
	const decoded = decodeCursor(cursor, { workspaceId });
	assert.equal(decoded.kind, 'changes');
	assert.equal(decoded.workspaceId, workspaceId);
	assert.equal(decoded.seq, 42);
	assert.equal(decoded.expiresMs, undefined);
});

test('a cursor is opaque, ASCII and stable for the same input', () => {
	const first = encodeCursor({ workspaceId, seq: 7 });
	const second = encodeCursor({ workspaceId, seq: 7 });
	assert.equal(first, second);
	assert.match(first, /^l4s\.[A-Za-z0-9_-]+\.[0-9a-f]{16}$/);
	assert.equal(first.includes('log4stellar-main'), false);
});

test('sequence zero is a valid cursor and a negative or fractional one is not', () => {
	assert.equal(decodeCursor(encodeCursor({ workspaceId, seq: 0 })).seq, 0);
	for (const seq of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
		assert.throws(() => encodeCursor({ workspaceId, seq }), /non-negative integer/, String(seq));
	}
});

test('a tampered cursor is rejected instead of being read as a fresh start', () => {
	const cursor = encodeCursor({ workspaceId, seq: 42 });
	const [, body, checksum] = cursor.split('.');
	const forgedBody = Buffer.from(JSON.stringify({ v: 1, k: 'changes', w: workspaceId, s: 43 }), 'utf8').toString('base64url');
	for (const value of [
		cursor + 'x',
		cursor.slice(0, -1),
		'l4s.' + forgedBody + '.' + checksum,
		'l4s.' + body + '.' + checksum.replace(/^./, c => (c === '0' ? '1' : '0')),
		'xl4s.' + body + '.' + checksum,
		'l4s.' + body,
		'l4s..' + checksum,
		'',
		'   ',
		'l4s.' + body + '.' + checksum + '.' + checksum,
	]) {
		assert.throws(() => decodeCursor(value), { code: syncErrorCodes.invalidCursor }, String(value));
	}
	for (const value of [null, undefined, 0, 42, {}, []]) {
		assert.throws(() => decodeCursor(value), { code: syncErrorCodes.invalidCursor }, String(value));
	}
});

test('a cursor over the length limit is rejected before it is parsed', () => {
	const body = Buffer.from(JSON.stringify({ v: 1, k: 'changes', w: 'a'.repeat(600), s: 1 }), 'utf8').toString('base64url');
	assert.throws(() => decodeCursor('l4s.' + body + '.0123456789abcdef'), { code: syncErrorCodes.invalidCursor });
});

test('a cursor for another workspace is rejected', () => {
	const cursor = encodeCursor({ workspaceId: 'team-notes', seq: 3 });
	assert.throws(() => decodeCursor(cursor, { workspaceId }), { code: syncErrorCodes.invalidCursor });
	assert.equal(decodeCursor(cursor).workspaceId, 'team-notes');
});

test('a cursor with an unknown kind or version is rejected', () => {
	for (const payload of [
		{ v: 2, k: 'changes', w: workspaceId, s: 1 },
		{ v: 1, k: 'other', w: workspaceId, s: 1 },
		{ v: 1, k: 'changes', w: '', s: 1 },
		{ v: 1, k: 'changes', w: workspaceId, s: -1 },
		{ v: 1, k: 'changes', w: workspaceId, s: '1' },
		{ v: 1, k: 'changes', w: workspaceId, s: 1, e: 1 },
		{ v: 1, k: 'page', w: workspaceId, s: 1 },
	]) {
		const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
		assert.throws(() => decodeCursor('l4s.' + body + '.' + checksumOf(body)), { code: syncErrorCodes.invalidCursor }, JSON.stringify(payload));
	}
});

function checksumOf(body) {
	return createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 16);
}

test('a snapshot cursor carries an expiry and a change cursor may not', () => {
	const cursor = encodeCursor({ workspaceId, kind: 'snapshot', seq: 9, expiresMs: 1767225600000 });
	const decoded = decodeCursor(cursor);
	assert.equal(decoded.kind, 'snapshot');
	assert.equal(decoded.seq, 9);
	assert.equal(decoded.expiresMs, 1767225600000);
	assert.throws(() => encodeCursor({ workspaceId, kind: 'snapshot', seq: 9 }), /absolute expiry/);
	assert.throws(() => encodeCursor({ workspaceId, kind: 'other', seq: 9 }), /Unknown cursor kind/);
});

test('a cursor whose changes were pruned demands a resync', () => {
	const cursor = decodeCursor(encodeCursor({ workspaceId, seq: 10 }));
	assert.deepEqual(requireRetainedCursor(cursor, 11).seq, 10);
	assert.deepEqual(requireRetainedCursor(cursor, 10).seq, 10);
	assert.throws(() => requireRetainedCursor(cursor, 50), {
		code: syncErrorCodes.resyncRequired,
		status: syncErrorStatus.ResyncRequired,
	});
	assert.throws(() => requireRetainedCursor(cursor, 0), /positive integer/);
});

test('the resync error maps to 410 so a client cannot confuse it with a server bug', () => {
	assert.equal(syncErrorStatus.ResyncRequired, 410);
	assert.equal(syncErrorStatus.SyncConflict, 409);
	assert.equal(syncErrorStatus.IdempotencyKeyReused, 409);
	for (const [code, name] of Object.entries(syncErrorCodes)) {
		assert.equal(typeof syncErrorStatus[name], 'number', code);
	}
	const resync = new WorkspaceError(syncErrorStatus.ResyncRequired, syncErrorCodes.resyncRequired);
	assert.equal(resync.status, 410);
	assert.equal(resync.code, 'ResyncRequired');
});

test('an idempotency key accepts a narrow alphabet within the length bounds', () => {
	for (const value of ['01234567', 'a'.repeat(200), 'phone-2f8a:1._x', 'A1b2C3d4']) {
		assert.equal(isValidIdempotencyKey(value), true, value);
	}
	for (const value of [
		'a'.repeat(7),
		'a'.repeat(201),
		'',
		0,
		null,
		undefined,
		' leading-space',
		'trailing-space ',
		'.leading-dot',
		'has space',
		'has/newline\n',
		'has#hash',
		'has+plus',
		'has=equals',
		'中文键值键值',
	]) {
		assert.equal(isValidIdempotencyKey(value), false, String(value));
	}
	assert.equal(idempotencyKeyLimits.minLength, 8);
	assert.equal(idempotencyKeyLimits.maxLength, 200);
	assert.throws(() => requireIdempotencyKey('short'), { code: syncErrorCodes.invalidIdempotencyKey });
	assert.equal(requireIdempotencyKey('01234567'), '01234567');
});

test('the same key with a different payload has a different fingerprint', () => {
	const base = { method: 'PUT', path: '/notes/plan.md', baseRevision: 'r1', digest: 'd1', size: 3, targetPath: null, device: 'phone' };
	const fingerprint = idempotencyFingerprint(base);
	assert.equal(idempotencyFingerprint({ ...base }), fingerprint);
	assert.equal(fingerprint.length, 64);
	for (const patch of [
		{ path: '/notes/other.md' },
		{ baseRevision: 'r2' },
		{ digest: 'd2' },
		{ size: 4 },
		{ targetPath: '/notes/plan-2.md' },
		{ device: 'tablet' },
		{ method: 'POST' },
		// The three outcome flags (§5.1). Each one changes what the operation DOES, so the
		// request identity must change with it: same key + flipped flag used to be replayed
		// with the first result while the flag the client sent was never honoured.
		{ mode: 'save' },
		{ overwrite: true },
		{ keepBoth: true },
	]) {
		assert.notEqual(idempotencyFingerprint({ ...base, ...patch }), fingerprint, JSON.stringify(patch));
	}
	// false and true must not collide; that is the whole point of adding the slot.
	assert.notEqual(idempotencyFingerprint({ ...base, overwrite: false }), idempotencyFingerprint({ ...base, overwrite: true }));
	// Field order must not matter: the client may serialize its retry differently.
	assert.equal(idempotencyFingerprint({ size: 3, digest: 'd1', path: '/notes/plan.md', method: 'PUT', baseRevision: 'r1', targetPath: null, device: 'phone' }), fingerprint);
	assert.throws(() => idempotencyFingerprint(null), /needs the request fields/);
});

test('a page size is clamped to the documented bounds', () => {
	assert.equal(normalizePageSize(undefined), syncPageLimits.defaultSize);
	assert.equal(normalizePageSize(''), syncPageLimits.defaultSize);
	assert.equal(normalizePageSize('50'), 50);
	assert.equal(normalizePageSize(1), 1);
	assert.equal(normalizePageSize(syncPageLimits.maxSize), syncPageLimits.maxSize);
	assert.equal(normalizePageSize(syncPageLimits.maxSize + 1), syncPageLimits.maxSize);
	assert.equal(normalizePageSize('100000'), syncPageLimits.maxSize);
	assert.equal(normalizePageSize(100000, { maximum: syncPageLimits.maxSnapshotSize }), syncPageLimits.maxSnapshotSize);
	assert.equal(normalizePageSize(undefined, { maximum: syncPageLimits.maxSnapshotSize }), syncPageLimits.defaultSize);
	for (const value of [0, -1, 1.5, 'abc', Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
		assert.throws(() => normalizePageSize(value), { code: syncErrorCodes.invalidPageSize }, String(value));
	}
	assert.ok(syncPageLimits.maxSnapshotSize > syncPageLimits.maxSize);
});

test('a base revision is required, must be a UUID and is normalized', () => {
	const revision = '0F0E0D0C-0B0A-4908-8706-050403020100';
	assert.equal(requireBaseRevision(revision), revision.toLowerCase());
	for (const value of [undefined, null, '']) {
		assert.throws(() => requireBaseRevision(value), {
			code: syncErrorCodes.baseRevisionRequired,
			status: syncErrorStatus.BaseRevisionRequired,
		});
	}
	for (const value of ['not-a-uuid', '0f0e0d0c-0b0a-4908-8706', 42, {}]) {
		assert.throws(() => requireBaseRevision(value), {
			code: syncErrorCodes.baseRevisionInvalid,
			status: syncErrorStatus.BaseRevisionInvalid,
		}, String(value));
	}
});

test('a device ID is a lowercase slug and falls back to a fixed name', () => {
	for (const value of ['phone', 'a', 'pixel-8', 'x'.repeat(32)]) {
		assert.equal(isValidDeviceId(value), true, value);
	}
	for (const value of ['', 'Phone', 'pixel_8', 'x'.repeat(33), '-lead', 'trail-', 'has space', null, 3]) {
		assert.equal(isValidDeviceId(value), false, String(value));
	}
	assert.equal(normalizeDeviceId(undefined), fallbackDeviceId);
	assert.equal(normalizeDeviceId('phone'), 'phone');
	assert.throws(() => normalizeDeviceId('Pixel 8'), { code: syncErrorCodes.invalidDevice });
});

test('a conflict name keeps the extension and the directory', () => {
	assert.equal(
		conflictPath('/notes/plan.md', { device: 'phone', timestampMs: Date.UTC(2026, 0, 1, 12, 0, 0) }),
		'/notes/plan (conflict phone 20260101T120000Z).md',
	);
	assert.equal(
		conflictPath('/media/holiday.tar.gz', { device: 'tablet', timestampMs: Date.UTC(2026, 0, 1, 12, 0, 0) }),
		'/media/holiday.tar (conflict tablet 20260101T120000Z).gz',
	);
	assert.equal(
		conflictPath('/a/budget.xlsx', { device: 'phone', timestampMs: Date.UTC(2026, 0, 1, 12, 0, 0), index: 2 }),
		'/a/budget (conflict phone 20260101T120000Z 2).xlsx',
	);
	assert.equal(
		conflictPath('/docs/report', { device: 'phone', timestampMs: Date.UTC(2026, 0, 1, 12, 0, 0) }),
		'/docs/report (conflict phone 20260101T120000Z)',
	);
	// A file whose name already looks like a conflict copy still gets a fresh suffix.
	assert.equal(
		conflictPath('/notes/plan (conflict phone 20260101T120000Z).md', { device: 'tablet', timestampMs: Date.UTC(2026, 0, 2, 12, 0, 0) }),
		'/notes/plan (conflict phone 20260101T120000Z) (conflict tablet 20260102T120000Z).md',
	);
});

test('a conflict name is deterministic for the same device and timestamp', () => {
	const timestampMs = Date.UTC(2026, 0, 1, 12, 0, 0);
	assert.equal(
		conflictPath('/notes/plan.md', { device: 'phone', timestampMs }),
		conflictPath('/notes/plan.md', { device: 'phone', timestampMs }),
	);
	// Two devices conflict into two different names, so neither overwrites the other.
	const phone = conflictPath('/notes/plan.md', { device: 'phone', timestampMs });
	const tablet = conflictPath('/notes/plan.md', { device: 'tablet', timestampMs });
	assert.notEqual(phone, tablet);
	assert.equal(phone.includes('phone'), true);
	assert.equal(tablet.includes('tablet'), true);
});

test('a conflict name rejects an impossible timestamp, index or path', () => {
	for (const timestampMs of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
		assert.throws(() => conflictPath('/notes/plan.md', { device: 'phone', timestampMs }), /conflict timestamp/);
	}
	for (const index of [0, -1, 1.5, 101]) {
		assert.throws(() => conflictPath('/notes/plan.md', { device: 'phone', timestampMs: 0, index }), /conflict index/);
	}
	for (const path of ['notes/plan.md', '', 'relative.md']) {
		assert.throws(() => conflictPath(path, { device: 'phone', timestampMs: 0 }), /absolute workspace path/, String(path));
	}
	assert.throws(() => conflictPath('/notes/plan.md', { device: 'Phone', timestampMs: 0 }), { code: syncErrorCodes.invalidDevice });
});

test('the conflict timestamp is a fixed UTC format without fractional seconds', () => {
	assert.equal(formatConflictTimestamp(0), '19700101T000000Z');
	assert.equal(formatConflictTimestamp(Date.UTC(2026, 11, 31, 23, 59, 59, 999)), '20261231T235959Z');
});

test('a taken conflict name moves to the next index and never collides', () => {
	const timestampMs = Date.UTC(2026, 0, 1, 12, 0, 0);
	const taken = new Set();
	const pick = () => nextConflictPath('/notes/plan.md', { device: 'phone', timestampMs, isTaken: path => taken.has(path) });
	const first = pick();
	taken.add(first);
	const second = pick();
	taken.add(second);
	const third = pick();
	assert.equal(new Set([first, second, third]).size, 3);
	assert.equal(first, '/notes/plan (conflict phone 20260101T120000Z).md');
	assert.equal(second, '/notes/plan (conflict phone 20260101T120000Z 2).md');
	assert.equal(third, '/notes/plan (conflict phone 20260101T120000Z 3).md');
});

test('exhausting the conflict indexes is an explicit error, not a silent overwrite', () => {
	assert.throws(
		() => nextConflictPath('/notes/plan.md', { device: 'phone', timestampMs: 0, isTaken: () => true }),
		{ code: syncErrorCodes.conflictNameExhausted, status: syncErrorStatus.ConflictNameExhausted },
	);
	assert.throws(() => nextConflictPath('/notes/plan.md', { device: 'phone', timestampMs: 0 }), /isTaken/);
});

test('a page token round-trips the snapshot and the last path', () => {
	const snapshotId = '0f0e0d0c-0b0a-4908-8706-050403020100';
	const token = encodePageToken({ snapshotId, lastPath: '/notes/plan.md' });
	const decoded = decodePageToken(token, { snapshotId });
	assert.equal(decoded.snapshotId, snapshotId);
	assert.equal(decoded.lastPath, '/notes/plan.md');
	assert.equal(decodePageToken(encodePageToken({ snapshotId, lastPath: '' }), { snapshotId }).lastPath, '');
});

test('a page token is bound to its snapshot and rejects tampering', () => {
	const snapshotId = '0f0e0d0c-0b0a-4908-8706-050403020100';
	const otherId = '1f0e0d0c-0b0a-4908-8706-050403020100';
	const token = encodePageToken({ snapshotId, lastPath: '/a.md' });
	const forged = Buffer.from(JSON.stringify({ v: 1, k: 'page', i: snapshotId, p: '/forged.md' }), 'utf8').toString('base64url');
	assert.throws(() => decodePageToken(token.replace(/\.[^.]+$/, '.' + checksumOf(forged))), { code: syncErrorCodes.invalidPageToken });
	assert.throws(() => decodePageToken('l4s.' + forged + '.' + checksumOf(forged), { snapshotId: otherId }), { code: syncErrorCodes.invalidPageToken });
	// A correctly checksummed token still cannot be used against another snapshot.
	assert.throws(() => decodePageToken(token, { snapshotId: otherId }), { code: syncErrorCodes.invalidPageToken });
	assert.throws(() => encodePageToken({ snapshotId: 'not-a-uuid' }), /snapshot UUID/);
});

test('a change cursor cannot be replayed as a page token and vice versa', () => {
	const cursor = encodeCursor({ workspaceId, seq: 10 });
	assert.throws(() => decodePageToken(cursor), { code: syncErrorCodes.invalidPageToken });
	const page = encodePageToken({ snapshotId: '0f0e0d0c-0b0a-4908-8706-050403020100', lastPath: '/a.md' });
	assert.throws(() => decodeCursor(page), { code: syncErrorCodes.invalidCursor });
});

test('every change kind is a known kind', () => {
	for (const kind of changeKinds) {
		assert.equal(isChangeKind(kind), true, kind);
		assert.equal(requireChangeKind(kind), kind);
	}
	assert.equal(changeKinds.includes('file.saved'), true);
	assert.equal(changeKinds.includes('file.renamed'), true);
	assert.equal(changeKinds.includes('file.deleted'), true);
	assert.equal(changeKinds.includes('file.restored'), true);
	assert.equal(changeKinds.includes('file.rolledback'), true);
	assert.equal(changeKinds.includes('file.conflicted'), true);
	for (const value of ['file.saved', 'renamed', '', null, 3]) {
		if (value === 'file.saved') {
			continue;
		}
		assert.equal(isChangeKind(value), false, String(value));
		assert.throws(() => requireChangeKind(value), { code: syncErrorCodes.invalidChangeKind }, String(value));
	}
});


test('a sync route maps to the capability the access contract already defines', () => {
	const cases = [
		['POST', '/sync/v1/snapshot', 'workspace.read'],
		['GET', '/sync/v1/snapshot/6f1c7d6e-3f3f-4a3b-9a2f-1c2b3a4d5e6f', 'workspace.read'],
		['GET', '/sync/v1/changes', 'workspace.read'],
		['GET', '/sync/v1/conflicts', 'workspace.history'],
		['GET', '/sync/v1/conflict', 'workspace.history'],
		['PUT', '/sync/v1/file', 'workspace.write'],
		['POST', '/sync/v1/rename', 'workspace.write'],
		['POST', '/sync/v1/restore', 'workspace.restore'],
		['POST', '/sync/v1/mkdir', 'workspace.write'],
		['POST', '/sync/v1/rollback', 'workspace.restore'],
		['DELETE', '/sync/v1/file', 'workspace.delete'],
	];
	for (const [method, pathname, capability] of cases) {
		assert.equal(capabilityForSyncRequest(method, pathname), capability, method + ' ' + pathname);
	}
	assert.equal(syncRoutes.changes, '/sync/v1/changes');
	assert.equal(syncRoutes.conflicts, '/sync/v1/conflicts');
	assert.equal(syncCapabilities.delete, 'workspace.delete');
	assert.equal(syncCapabilities.restore, 'workspace.restore');
	assert.equal(syncCapabilities.file, 'workspace.write');
});

test('an unknown sync route has no capability instead of defaulting to read', () => {
	for (const [method, pathname] of [
		['GET', '/sync/v1/unknown'],
		['GET', '/static/mount/notes'],
		['PATCH', '/sync/v1/changes'],
		['POST', '/sync/v1/file'],
		['GET', '/sync/v1/changes/extra'],
		['GET', '/sync/v1/snapshot/not-a-uuid'],
		['get', '/sync/v1/changes'],
	]) {
		assert.equal(capabilityForSyncRequest(method, pathname), undefined, method + ' ' + pathname);
	}
	assert.equal(capabilityForSyncRequest(undefined, '/sync/v1/changes'), undefined);
	assert.equal(capabilityForSyncRequest('GET', undefined), undefined);
});


test('an upload declares whether it creates or saves', () => {
	assert.deepEqual([...syncUploadModes], ['create', 'save']);
	assert.equal(requireUploadMode('create'), 'create');
	assert.equal(requireUploadMode('save'), 'save');
	assert.equal(requireUploadMode(undefined), 'save');
	assert.equal(requireUploadMode(''), 'save');
	for (const value of ['update', 'CREATE', 'append', 1, null, {}]) {
		if (value === null) {
			assert.equal(requireUploadMode(value), 'save');
			continue;
		}
		assert.throws(() => requireUploadMode(value), { code: syncErrorCodes.invalidUploadMode }, String(value));
	}
});

test('a cursor beyond the workspace head is rejected instead of reading as empty', () => {
	const cursor = decodeCursor(encodeCursor({ workspaceId: 'log4stellar-main', seq: 40 }), { workspaceId: 'log4stellar-main' });
	assert.equal(requireHeadCursor(cursor, 40).seq, 40);
	assert.equal(requireHeadCursor(cursor, 41).seq, 40);
	assert.equal(requireHeadCursor(decodeCursor(encodeCursor({ workspaceId: 'w', seq: 0 })), 0).seq, 0);
	assert.throws(() => requireHeadCursor(cursor, 39), { code: syncErrorCodes.resyncRequired, status: 410 });
	assert.throws(() => requireHeadCursor(cursor, -1), /non-negative integer/);
	assert.throws(() => requireHeadCursor(cursor, 1.5), /non-negative integer/);
});

test('the retention policy is a documented constant, not an implementation detail', () => {
	assert.equal(syncRetention.snapshotTtlMs, 6 * 60 * 60 * 1000);
	assert.equal(syncRetention.changesTtlMs, 30 * 24 * 60 * 60 * 1000);
	assert.equal(syncRetention.idempotencyTtlMs, syncRetention.changesTtlMs);
	assert.equal(syncRetention.maxChangesPerWorkspace, 200000);
	assert.equal(syncRetention.maxSnapshotEntries, 100000);
	assert.equal(Object.isFrozen(syncRetention), true);
});


test('a snapshot cursor stops being usable once its snapshot window closes', () => {
	const now = 1_800_000_000_000;
	const snapshot = decodeCursor(encodeCursor({ workspaceId: 'w', kind: 'snapshot', seq: 12, expiresMs: now + 1000 }), { workspaceId: 'w' });
	assert.equal(requireLiveCursor(snapshot, now).seq, 12);
	assert.equal(requireLiveCursor(snapshot, now + 1000).seq, 12);
	assert.throws(() => requireLiveCursor(snapshot, now + 1001), { code: syncErrorCodes.resyncRequired, status: 410 });
	const plain = decodeCursor(encodeCursor({ workspaceId: 'w', seq: 12 }));
	assert.equal(requireLiveCursor(plain, now + 10 * 1000).seq, 12);
	assert.throws(() => requireLiveCursor(plain, -1), /non-negative integer/);
});
