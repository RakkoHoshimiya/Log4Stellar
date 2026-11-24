import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { authorizeWorkspace } from './workspace-access.mjs';
import { WorkspaceError } from './workspace-contract.mjs';
import { byteRange, previewRoute, serveOfficePreviewRequest, streamAuthorizedPreview } from './office-preview-files.mjs';
import { officePreviewPath, officePreviewStates as states } from './office-preview-contract.mjs';

// The HTTP contract of §4 without PostgreSQL and without LibreOffice: the order of the
// checks (capability before body), the three routes, the status/error mapping, and the
// streaming rules (Range, HEAD, and the "never leak a path" invariant).

const workspaceId = 'l4s-test-unit';
const previewId = '11111111-1111-4111-8111-111111111111';
const fileId = '22222222-2222-4222-8222-222222222222';
const revisionId = '33333333-3333-4333-8333-333333333333';
const objectKey = 'office-previews/ab/' + 'a'.repeat(64) + '/' + previewId + '.pdf';

function context({ method = 'GET', path = '', headers = {}, body } = {}) {
	const stored = new Map(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
	if (body !== undefined && !stored.has('content-type')) {
		stored.set('content-type', 'application/json');
	}
	return {
		method,
		path: path === '' ? officePreviewPath : officePreviewPath + path,
		status: undefined,
		body: undefined,
		type: undefined,
		length: undefined,
		req: Readable.from(body === undefined ? [] : [Buffer.from(body)]),
		get: name => stored.get(name.toLowerCase()) ?? '',
		set: (name, value) => { stored.set(name.toLowerCase(), value); },
		is: type => (stored.get('content-type') ?? '').startsWith(type),
	};
}

function recordingWorkspace(role = 'owner') {
	const calls = [];
	const backend = {};
	// The preview route only ever needs the facade's require(); recording it lets a test
	// prove that an unauthorized request never reached the store.
	const facade = {
		role,
		require(capability) {
			calls.push(capability);
			const allowed = {
				viewer: ['workspace.read', 'workspace.history'],
				editor: ['workspace.read', 'workspace.history'],
				owner: ['workspace.read', 'workspace.history'],
			}[role];
			if (!allowed?.includes(capability)) {
				throw new WorkspaceError(403, 'NoPermissions');
			}
		},
	};
	return { facade, calls, backend };
}

/** An in-memory stand-in for the preview store, recording every access. */
function fakeStore({ rows = new Map(), calls = [] } = {}) {
	return {
		calls,
		rows,
		async getPreviewByObject(scopeWorkspaceId, id) {
			calls.push({ name: 'getPreviewByObject', workspaceId: scopeWorkspaceId, previewId: id });
			return rows.get(id);
		},
		async getPreview(scopeWorkspaceId, id) {
			calls.push({ name: 'getPreview', workspaceId: scopeWorkspaceId, previewId: id });
			return rows.get(id);
		},
		async markEvicted(id) {
			calls.push({ name: 'markEvicted', previewId: id });
		},
	};
}

function previewRow(overrides = {}) {
	return {
		previewId,
		workspaceId,
		fileId,
		revisionId,
		state: states.ready,
		sizeBytes: 25,
		objectKey,
		retryable: false,
		errorCode: undefined,
		createdMs: 1,
		updatedMs: 2,
		lastAccessMs: 2,
		...overrides,
	};
}

// 25 bytes: `%PDF-1.7` + newline + 16 hex characters. The row's sizeBytes must
// match it, because the route length and the Content-Range total come from the row.
function fakeBlobs({ body = Buffer.from('%PDF-1.7\n0123456789abcdef') } = {}) {
	const calls = [];
	return {
		calls,
		async open(key, expectedSize, range) {
			calls.push({ name: 'open', key, expectedSize, range });
			const wanted = range ?? { start: 0, end: body.length - 1 };
			return { size: body.length, stream: Readable.from([body.subarray(wanted.start, wanted.end + 1)]) };
		},
	};
}

function scope(overrides = {}) {
	const store = overrides.store ?? fakeStore({ rows: new Map([[previewId, previewRow()]]) });
	return {
		store,
		blobs: overrides.blobs ?? fakeBlobs(),
		workspaceId,
		limits: {},
		profileFingerprint: 'f'.repeat(32),
		...overrides.extra,
	};
}

function response(ctx) {
	const status = ctx.status ?? (ctx.body === undefined ? 404 : 200);
	return { status, body: ctx.body, type: ctx.type, length: ctx.length, headers: ctx };
}

async function bodyOf(ctx) {
	if (ctx.body === undefined || Buffer.isBuffer(ctx.body) || typeof ctx.body === 'string') {
		return ctx.body;
	}
	const chunks = [];
	for await (const chunk of ctx.body) {
		chunks.push(chunk);
	}
	return Buffer.concat(chunks);
}

// ------------------------------------------------------------------- path parsing

test('the three documented routes are the only ones recognised', () => {
	assert.deepEqual(previewRoute(officePreviewPath), { kind: 'collection' });
	assert.deepEqual(previewRoute(officePreviewPath + '/'), { kind: 'collection' });
	assert.deepEqual(previewRoute(officePreviewPath + '/' + previewId), { kind: 'status', previewId });
	assert.deepEqual(previewRoute(officePreviewPath + '/' + previewId + '/pdf'), { kind: 'pdf', previewId });
	assert.equal(previewRoute(officePreviewPath + '/' + previewId + '/other'), undefined);
	assert.equal(previewRoute(officePreviewPath + '/' + previewId + '/pdf/extra'), undefined);
	assert.equal(previewRoute(officePreviewPath + 'x'), undefined);
	assert.equal(previewRoute('/static/mount/' + previewId), undefined);
});

test('byteRange follows the HTTP rules used by the file route', () => {
	// `bytes=0-` is a satisfiable open ended range: the whole representation as a 206.
	assert.deepEqual(byteRange('bytes=0-', 10), { start: 0, end: 9 });
	assert.equal(byteRange('bytes=-5', 10).start, 5);
	assert.deepEqual(byteRange('bytes=-5', 10), { start: 5, end: 9 });
	assert.deepEqual(byteRange('bytes=2-4', 10), { start: 2, end: 4 });
	assert.deepEqual(byteRange('bytes=2-999', 10), { start: 2, end: 9 });
	assert.equal(byteRange('bytes=10-', 10), null);
	assert.equal(byteRange('bytes=4-2', 10), null);
	assert.equal(byteRange('bytes=-0', 10), null);
	assert.equal(byteRange('bytes=0-', 0), null);
	assert.equal(byteRange('items=0-1', 10), undefined);
	assert.equal(byteRange('bytes=-', 10), undefined);
	// A Range is only one range here: multi range is treated as "the whole thing" rather
	// than answered with a broken multipart response.
	assert.equal(byteRange('bytes=0-1,4-5', 10), undefined);
});

// ------------------------------------------------------------------- authorization

test('an unauthorized role is refused before the body is read or a row is touched', async () => {
	const { facade, calls } = recordingWorkspace('viewer');
	const store = fakeStore();
	const ctx = context({
		method: 'POST',
		headers: { 'content-type': 'text/plain', 'x-log4stellar-workspace': workspaceId },
		body: 'this is not json and must never be parsed',
	});
	// A viewer asking for a *past revision* needs history, which a viewer does have; the
	// interesting refusal is `read` on a role that lacks it, simulated here by a viewer
	// facade limited to history only.
	const limited = {
		role: 'none',
		require(capability) {
			calls.push(capability);
			if (capability !== 'workspace.history') {
				throw new WorkspaceError(403, 'NoPermissions');
			}
		},
	};
	await serveOfficePreviewRequest(ctx, limited, scope({ store }));
	assert.equal(ctx.status, 403);
	assert.equal(ctx.body.error, 'NoPermissions');
	assert.ok(ctx.body.requestId);
	// The body was never read, so the store was never consulted either.
	assert.deepEqual(store.calls, []);
	assert.ok(facade);
});

test('a POST without JSON is 415 InvalidContentType', async () => {
	const { facade } = recordingWorkspace();
	const ctx = context({ method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'fileId=1' });
	await serveOfficePreviewRequest(ctx, facade, scope());
	assert.equal(ctx.status, 415);
	assert.equal(ctx.body.error, 'InvalidContentType');
});

test('a POST with a malformed body is 400 InvalidRequest', async () => {
	const { facade } = recordingWorkspace();
	for (const body of ['', '{', '[]', 'null', '"text"']) {
		const ctx = context({ method: 'POST', body });
		await serveOfficePreviewRequest(ctx, facade, scope());
		assert.equal(ctx.status, 400, 'body ' + JSON.stringify(body));
		assert.equal(ctx.body.error, 'InvalidRequest');
	}
});

test('a POST body above the route limit is 413 RequestTooLarge', async () => {
	const { facade } = recordingWorkspace();
	const ctx = context({ method: 'POST', body: JSON.stringify({ fileId, padding: 'x'.repeat(70 * 1024) }) });
	await serveOfficePreviewRequest(ctx, facade, scope());
	assert.equal(ctx.status, 413);
	assert.equal(ctx.body.error, 'RequestTooLarge');
});

test('a GET on the collection is a method error, not a missing route', async () => {
	const { facade } = recordingWorkspace();
	const ctx = context({ method: 'GET' });
	await serveOfficePreviewRequest(ctx, facade, scope());
	assert.equal(ctx.status, 405);
});

test('a DELETE on a status route is a method error', async () => {
	const { facade } = recordingWorkspace();
	const ctx = context({ method: 'DELETE', path: '/' + previewId });
	await serveOfficePreviewRequest(ctx, facade, scope());
	assert.equal(ctx.status, 405);
});

// ------------------------------------------------------------------- the PDF route

test('a ready preview is served as a private, sandboxed PDF', async () => {
	const { facade } = recordingWorkspace('viewer');
	const blobs = fakeBlobs();
	const ctx = context({ method: 'GET', path: '/' + previewId + '/pdf' });
	await serveOfficePreviewRequest(ctx, facade, scope({ blobs }));
	assert.equal(ctx.status, 200);
	assert.equal(ctx.type, 'application/pdf');
	assert.equal(ctx.length, 25);
	assert.equal(ctx.get('cache-control'), 'private, no-store');
	assert.equal(ctx.get('x-content-type-options'), 'nosniff');
	assert.match(ctx.get('content-security-policy'), /sandbox/);
	assert.equal(ctx.get('accept-ranges'), 'bytes');
	assert.ok(ctx.get('x-request-id'));
	// The object key came from the row, not from the request.
	assert.equal(blobs.calls[0].key, objectKey);
	assert.equal(blobs.calls[0].range, undefined);
});

test('a byte range is answered 206 with Content-Range and only those bytes', async () => {
	const { facade } = recordingWorkspace();
	const blobs = fakeBlobs();
	const ctx = context({ method: 'GET', path: '/' + previewId + '/pdf', headers: { range: 'bytes=0-4' } });
	await serveOfficePreviewRequest(ctx, facade, scope({ blobs }));
	assert.equal(ctx.status, 206);
	assert.equal(ctx.get('content-range'), 'bytes 0-4/25');
	assert.equal(ctx.length, 5);
	assert.equal((await bodyOf(ctx)).toString('latin1'), '%PDF-');
	assert.deepEqual(blobs.calls[0].range, { start: 0, end: 4 });
});

test('an unsatisfiable range is 416 with the size, and no object is opened', async () => {
	const { facade } = recordingWorkspace();
	const blobs = fakeBlobs();
	const ctx = context({ method: 'GET', path: '/' + previewId + '/pdf', headers: { range: 'bytes=99-' } });
	await serveOfficePreviewRequest(ctx, facade, scope({ blobs }));
	assert.equal(ctx.status, 416);
	assert.equal(ctx.get('content-range'), 'bytes */25');
	assert.equal(ctx.body.error, 'InvalidRange');
	assert.deepEqual(blobs.calls, []);
});

test('HEAD reports the same metadata without opening the object', async () => {
	const { facade } = recordingWorkspace();
	const blobs = fakeBlobs();
	const head = context({ method: 'HEAD', path: '/' + previewId + '/pdf' });
	await serveOfficePreviewRequest(head, facade, scope({ blobs }));
	assert.equal(head.status, 200);
	assert.equal(head.length, 25);
	assert.equal(head.type, 'application/pdf');
	assert.deepEqual(blobs.calls, []);

	const ranged = context({ method: 'HEAD', path: '/' + previewId + '/pdf', headers: { range: 'bytes=2-5' } });
	await serveOfficePreviewRequest(ranged, facade, scope({ blobs }));
	assert.equal(ranged.status, 206);
	assert.equal(ranged.length, 4);
	assert.equal(ranged.get('content-range'), 'bytes 2-5/25');
	assert.deepEqual(blobs.calls, []);
});

test('a preview that is not ready is 409 PreviewNotReady', async () => {
	const { facade } = recordingWorkspace();
	for (const state of [states.queued, states.running, states.failed, states.evicted]) {
		const store = fakeStore({ rows: new Map([[previewId, previewRow({ state, objectKey: null, sizeBytes: 0 })]]) });
		const blobs = fakeBlobs();
		const ctx = context({ method: 'GET', path: '/' + previewId + '/pdf' });
		await serveOfficePreviewRequest(ctx, facade, scope({ store, blobs }));
		assert.equal(ctx.status, 409, state);
		assert.equal(ctx.body.error, 'PreviewNotReady');
		assert.deepEqual(blobs.calls, []);
	}
});

test('an unknown or foreign preview id is 404 and an impossible id never reaches the store', async () => {
	const { facade } = recordingWorkspace();
	const store = fakeStore();
	const ctx = context({ method: 'GET', path: '/44444444-4444-4444-8444-444444444444/pdf' });
	await serveOfficePreviewRequest(ctx, facade, scope({ store }));
	assert.equal(ctx.status, 404);
	assert.equal(ctx.body.error, 'FileNotFound');
	// A well formed but unknown id is looked up and found absent; that is the only way to
	// distinguish it from a foreign one, and the answer is the same 404 either way.
	assert.deepEqual(store.calls.map(call => call.previewId), ['44444444-4444-4444-8444-444444444444']);

	// A syntactically impossible id is a 404 without a lookup, so "wrong workspace" and
	// "garbage id" are indistinguishable to a caller probing the route.
	const garbageStore = fakeStore();
	const garbage = context({ method: 'GET', path: '/..%2f..%2fetc%2fpasswd' });
	await serveOfficePreviewRequest(garbage, facade, scope({ store: garbageStore }));
	assert.equal(garbage.status, 404);
	assert.deepEqual(garbageStore.calls, []);
});

test('a missing object behind a ready row is 409 and the row is tombstoned', async () => {
	const { facade } = recordingWorkspace();
	const store = fakeStore({ rows: new Map([[previewId, previewRow()]]) });
	const blobs = {
		async open() {
			throw new WorkspaceError(502, 'StorageObjectMissing');
		},
	};
	const ctx = context({ method: 'GET', path: '/' + previewId + '/pdf' });
	await serveOfficePreviewRequest(ctx, facade, scope({ store, blobs }));
	assert.equal(ctx.status, 409);
	assert.equal(ctx.body.error, 'PreviewNotReady');
	assert.ok(store.calls.some(call => call.name === 'markEvicted' && call.previewId === previewId));
});

test('the status route returns the public shape and a request id', async () => {
	const { facade } = recordingWorkspace('viewer');
	const store = fakeStore({ rows: new Map([[previewId, previewRow()]]) });
	const ctx = context({ method: 'GET', path: '/' + previewId });
	await serveOfficePreviewRequest(ctx, facade, scope({ store }));
	assert.equal(ctx.status, 200);
	assert.equal(ctx.body.id, previewId);
	assert.equal(ctx.body.state, 'ready');
	assert.equal(ctx.body.revisionId, revisionId);
	assert.ok(ctx.body.requestId);
	// No object key, no path, no size of the source: the response is about the preview.
	assert.equal(ctx.body.objectKey, undefined);
	assert.equal(ctx.body.objectPath, undefined);
});

test('no error body ever contains a path, a key or a command line', async () => {
	const { facade } = recordingWorkspace();
	const cases = [
		context({ method: 'POST', body: JSON.stringify({ fileId: 'not-a-uuid' }) }),
		context({ method: 'GET', path: '/' + previewId + '/pdf', headers: { range: 'bytes=99-' } }),
		context({ method: 'GET', path: '/44444444-4444-4444-8444-444444444444/pdf' }),
	];
	for (const ctx of cases) {
		await serveOfficePreviewRequest(ctx, facade, scope());
		const text = JSON.stringify(ctx.body);
		assert.doesNotMatch(text, /office-previews\//);
		assert.doesNotMatch(text, /\/tmp\//);
		assert.doesNotMatch(text, /soffice/);
		assert.match(text, /"requestId":"[0-9a-f-]{36}"/);
	}
});

test('a queue full condition is 429 with a Retry-After hint', async () => {
	const { facade } = recordingWorkspace();
	const store = {
		async getOrEnqueuePreview() {
			throw new WorkspaceError(429, 'PreviewQueueFull');
		},
		async currentVersionSource() {
			return { workspaceId, fileId, revisionId, sha256: 'a'.repeat(64), sizeBytes: 10, path: '/r.docx' };
		},
	};
	const ctx = context({ method: 'POST', body: JSON.stringify({ fileId }) });
	await serveOfficePreviewRequest(ctx, facade, scope({ store }));
	assert.equal(ctx.status, 429);
	assert.equal(ctx.body.error, 'PreviewQueueFull');
	assert.equal(ctx.get('retry-after'), '5');
});

test('streamAuthorizedPreview refuses a preview that is not ready', async () => {
	const store = fakeStore({ rows: new Map([[previewId, previewRow({ state: states.evicted, objectKey: null })]]) });
	await assert.rejects(
		streamAuthorizedPreview({ store, blobs: fakeBlobs(), workspaceId, previewId }),
		error => error.status === 409 && error.code === 'PreviewNotReady',
	);
});

test('the facade from authorizeWorkspace accepts the preview route for every role that can read', () => {
	// A real authorizeWorkspace facade must not choke on require('workspace.read'): this
	// pins the integration between the two modules without a fake.
	const backend = {};
	const facade = authorizeWorkspace(backend, { role: 'viewer' });
	assert.doesNotThrow(() => facade.require('workspace.read'));
	assert.doesNotThrow(() => facade.require('workspace.history'));
	assert.throws(() => facade.require('workspace.write'), error => error.status === 403);
});
