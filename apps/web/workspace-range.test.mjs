import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { authorizeWorkspace } from './workspace-access.mjs';
import { WorkspaceError, ifMatchHolds } from './workspace-contract.mjs';
import { mountPath, serveWorkspaceFile } from './workspace-files.mjs';

const maxBytes = 64 * 1024 * 1024;

// Koa's `ctx.type` setter resolves an extension to a mime type; the server relies on that for
// the types it allows to render inline.
const mimeTypes = new Map([
	['.md', 'text/markdown; charset=utf-8'],
	['.txt', 'text/plain; charset=utf-8'],
	['.png', 'image/png'],
	['.mp4', 'video/mp4'],
]);

function context({ method = 'GET', path = '/', query = {}, headers = {}, body } = {}) {
	const stored = new Map(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
	const ctx = {
		method,
		path: mountPath + path,
		query,
		length: undefined,
		status: undefined,
		body: undefined,
		req: body === undefined ? Readable.from([]) : Readable.from([body]),
		get: name => stored.get(name.toLowerCase()) ?? '',
		set: (name, value) => stored.set(name.toLowerCase(), value),
		is: type => (stored.get('content-type') ?? '').startsWith(type),
	};
	Object.defineProperty(ctx, 'type', {
		get: () => stored.get('content-type'),
		set: value => stored.set('content-type', mimeTypes.get(value) ?? value),
	});
	Object.defineProperty(ctx, 'headers', { value: stored });
	return ctx;
}

async function collect(ctx) {
	if (ctx.body === undefined) {
		return Buffer.alloc(0);
	}
	if (Buffer.isBuffer(ctx.body)) {
		return ctx.body;
	}
	if (typeof ctx.body === 'object' && !ctx.body[Symbol.asyncIterator]) {
		return Buffer.from(JSON.stringify(ctx.body));
	}
	const chunks = [];
	for await (const chunk of ctx.body) {
		chunks.push(Buffer.from(chunk));
	}
	return Buffer.concat(chunks);
}

function stubWorkspace(bytes, { etag = '"revision-a"' } = {}) {
	const file = {
		type: 1,
		ctime: 0,
		mtime: 0,
		size: bytes.length,
		etag,
		stream: range => Readable.from([range ? bytes.subarray(range.start, range.end + 1) : bytes]),
		close: () => {},
	};
	return { openRead: async () => file, openRevision: async () => file };
}

async function request(workspace, options) {
	const ctx = context(options);
	// Authorization is a required step before the handler runs, so wrap the stub the way the
	// gateway does; these cases exercise range and precondition handling, not roles.
	await serveWorkspaceFile(ctx, authorizeWorkspace(workspace, { role: 'owner' }), maxBytes);
	// Koa infers 200 for a set body and 404 when nothing was produced, and the routes rely on
	// that, so the stub has to model it or a handler that only sets `body` looks status-less.
	const status = ctx.status ?? (ctx.body === undefined ? 404 : 200);
	return { status, headers: ctx.headers, length: ctx.length, body: await collect(ctx) };
}

test('an If-Range validator that no longer matches serves the whole representation', async () => {
	const workspace = stubWorkspace(Buffer.from('ABCDEFGHIJKLMNOPQRST'));
	const response = await request(workspace, { headers: { Range: 'bytes=10-19', 'If-Range': '"revision-stale"' } });
	assert.equal(response.status, 200);
	assert.equal(response.headers.get('content-range'), undefined);
	assert.equal(response.body.toString(), 'ABCDEFGHIJKLMNOPQRST');
});

test('a matching If-Range validator still serves the requested range', async () => {
	const workspace = stubWorkspace(Buffer.from('ABCDEFGHIJKLMNOPQRST'));
	const response = await request(workspace, { headers: { Range: 'bytes=10-19', 'If-Range': '"revision-a"' } });
	assert.equal(response.status, 206);
	assert.equal(response.headers.get('content-range'), 'bytes 10-19/20');
	assert.equal(response.body.toString(), 'KLMNOPQRST');
});

test('an unsatisfiable range is reported instead of silently truncated', async () => {
	const workspace = stubWorkspace(Buffer.from('0123456789'));
	const response = await request(workspace, { headers: { Range: 'bytes=10-' } });
	assert.equal(response.status, 416);
	assert.equal(response.headers.get('content-range'), 'bytes */10');
	assert.equal(response.body.length, 0);
});

test('a multi-range request is served whole rather than rejected as unsatisfiable', async () => {
	const bytes = Buffer.from('0123456789');
	const workspace = stubWorkspace(bytes);
	const response = await request(workspace, { headers: { Range: 'bytes=0-1,5-6' } });
	assert.equal(response.status, 200);
	assert.equal(response.headers.get('content-range'), undefined);
	assert.deepEqual(response.body, bytes);
});

test('an empty attachment rejects ranges but still serves a full body', async () => {
	const workspace = stubWorkspace(Buffer.alloc(0));
	const ranged = await request(workspace, { headers: { Range: 'bytes=0-0' } });
	assert.equal(ranged.status, 416);
	assert.equal(ranged.headers.get('content-range'), 'bytes */0');
	const full = await request(workspace, {});
	assert.equal(full.status, 200);
	assert.equal(full.length, 0);
	assert.equal(full.body.length, 0);
});

// Every byte range of a zero length representation is unsatisfiable, and a broken range must
// never turn into a 206 whose Content-Range fits no actual representation.
for (const header of ['bytes=0-0', 'bytes=0-', 'bytes=-1', 'bytes=-0']) {
	test('an empty attachment rejects the range ' + header, async () => {
		const workspace = stubWorkspace(Buffer.alloc(0));
		const response = await request(workspace, { headers: { Range: header } });
		assert.equal(response.status, 416);
		assert.equal(response.headers.get('content-range'), 'bytes */0');
		assert.equal(response.length, 0);
		assert.equal(response.body.length, 0);
	});
}

// The two clamps below are what keeps a valid request from producing a nonsense Content-Range.
// Only comparing status codes lets either one be deleted without any test noticing, so each case
// asserts the header and the real body together.
test('a last-pos beyond the end is clamped to the representation length', async () => {
	const bytes = Buffer.from('ABCDEFGHIJKLMNOPQRST');
	const workspace = stubWorkspace(bytes);
	const response = await request(workspace, { headers: { Range: 'bytes=0-1000000' } });
	assert.equal(response.status, 206);
	assert.equal(response.headers.get('content-range'), 'bytes 0-19/20');
	assert.equal(response.length, 20);
	assert.equal(response.body.length, 20);
	assert.deepEqual(response.body, bytes);
});

test('an open ended range starting past the end is unsatisfiable', async () => {
	const workspace = stubWorkspace(Buffer.from('ABCDEFGHIJKLMNOPQRST'));
	const response = await request(workspace, { headers: { Range: 'bytes=20-' } });
	assert.equal(response.status, 416);
	assert.equal(response.headers.get('content-range'), 'bytes */20');
	assert.equal(response.body.length, 0);
});

test('a last-pos before the first-pos is unsatisfiable rather than an empty range', async () => {
	const workspace = stubWorkspace(Buffer.from('ABCDEFGHIJKLMNOPQRST'));
	const response = await request(workspace, { headers: { Range: 'bytes=10-5' } });
	assert.equal(response.status, 416);
	assert.equal(response.headers.get('content-range'), 'bytes */20');
	assert.equal(response.length, 0);
	assert.equal(response.body.length, 0);
});

// A fully out of bounds int-range has a first-pos at or past the end while its last-pos is
// still beyond that first-pos, so only the satisfiability check on the first-pos rejects it.
test('a closed range entirely past the end is unsatisfiable', async () => {
	const workspace = stubWorkspace(Buffer.from('ABCDEFGHIJKLMNOPQRST'));
	const response = await request(workspace, { headers: { Range: 'bytes=25-30' } });
	assert.equal(response.status, 416);
	assert.equal(response.headers.get('content-range'), 'bytes */20');
	assert.equal(response.length, 0);
	assert.equal(response.body.length, 0);
});

test('a suffix longer than the representation starts at its first byte', async () => {
	const bytes = Buffer.from('ABCDEFGHIJKLMNOPQRST');
	const workspace = stubWorkspace(bytes);
	const response = await request(workspace, { headers: { Range: 'bytes=-25' } });
	assert.equal(response.status, 206);
	assert.equal(response.headers.get('content-range'), 'bytes 0-19/20');
	assert.equal(response.length, 20);
	assert.deepEqual(response.body, bytes);
});

test('a suffix range shorter than the representation starts at the requested offset', async () => {
	const bytes = Buffer.from('ABCDEFGHIJKLMNOPQRST');
	const workspace = stubWorkspace(bytes);
	const response = await request(workspace, { headers: { Range: 'bytes=-5' } });
	assert.equal(response.status, 206);
	assert.equal(response.headers.get('content-range'), 'bytes 15-19/20');
	assert.equal(response.length, 5);
	assert.equal(response.body.toString(), 'PQRST');
});

test('a zero length suffix is rejected instead of widening to the whole representation', async () => {
	const workspace = stubWorkspace(Buffer.from('ABCDEFGHIJKLMNOPQRST'));
	const response = await request(workspace, { headers: { Range: 'bytes=-0' } });
	assert.equal(response.status, 416);
	assert.equal(response.headers.get('content-range'), 'bytes */20');
	assert.equal(response.body.length, 0);
});

test('a HEAD request reports range metadata without a body', async () => {
	const workspace = stubWorkspace(Buffer.from('0123456789'));
	const response = await request(workspace, { method: 'HEAD', headers: { Range: 'bytes=2-5' } });
	assert.equal(response.status, 206);
	assert.equal(response.headers.get('content-range'), 'bytes 2-5/10');
	assert.equal(response.length, 4);
	assert.equal(response.body.length, 0);
});

test('binary attachments download as octet streams behind a sandbox CSP', async () => {
	for (const path of ['/plan.docx', '/sheet.xlsx', '/deck.pptx', '/bundle.zip']) {
		const workspace = stubWorkspace(Buffer.from('binary'));
		const response = await request(workspace, { path });
		assert.equal(response.headers.get('content-type'), 'application/octet-stream', path);
		assert.equal(response.headers.get('content-security-policy'), "sandbox; default-src 'none'", path);
		assert.equal(response.headers.get('x-content-type-options'), 'nosniff', path);
		assert.equal(response.headers.get('accept-ranges'), 'bytes', path);
	}
});

test('inline previewable types keep their own content type', async () => {
	const cases = [['/notes.md', 'text/markdown; charset=utf-8'], ['/photo.png', 'image/png'], ['/clip.mp4', 'video/mp4']];
	for (const [path, type] of cases) {
		const workspace = stubWorkspace(Buffer.from('inline'));
		const response = await request(workspace, { path });
		assert.equal(response.headers.get('content-type'), type, path);
		assert.equal(response.headers.get('content-security-policy'), "sandbox; default-src 'none'", path);
	}
});

test('a stale If-Match on a download is rejected before any bytes are sent', async () => {
	const workspace = stubWorkspace(Buffer.from('0123456789'));
	const response = await request(workspace, { headers: { 'If-Match': '"revision-stale"' } });
	assert.equal(response.status, 412);
	assert.equal(response.body.toString(), JSON.stringify({ error: 'FileChanged' }));
});

// RFC 9110 section 13.1.1 lets a client send `*` or a list of entity tags instead of one exact
// tag. Rejecting those made a legitimate resend look like a concurrent edit, so the comparison
// accepts both forms while still rejecting a genuinely stale tag.
test('an If-Match wildcard accepts the current revision on download', async () => {
	const workspace = stubWorkspace(Buffer.from('0123456789'));
	const response = await request(workspace, { headers: { 'If-Match': '*' } });
	assert.equal(response.status, 200);
	assert.equal(response.body.toString(), '0123456789');
});

test('an If-Match list accepts a download when it names the current revision', async () => {
	const workspace = stubWorkspace(Buffer.from('0123456789'));
	const response = await request(workspace, { headers: { 'If-Match': '"revision-stale", "revision-a"' } });
	assert.equal(response.status, 200);
	assert.equal(response.body.toString(), '0123456789');
});

test('an If-Match list without the current revision is still stale', async () => {
	const workspace = stubWorkspace(Buffer.from('0123456789'));
	const response = await request(workspace, { headers: { 'If-Match': '"revision-stale", "revision-older"' } });
	assert.equal(response.status, 412);
	assert.equal(response.body.toString(), JSON.stringify({ error: 'FileChanged' }));
});

test('a restore forwards the raw precondition so a wildcard can be honoured', async () => {
	const calls = [];
	const bytes = Buffer.from('0123456789');
	const workspace = {
		...stubWorkspace(bytes),
		restoreRevision: async (path, id, expectedEtag) => {
			calls.push({ path, id, expectedEtag });
			// The storage layer decides whether the precondition holds; the route must not
			// pre-filter it, or `If-Match: *` and tag lists would never reach the comparison.
			if (!ifMatchHolds(expectedEtag, '"revision-a"')) {
				throw new WorkspaceError(412, 'FileChanged');
			}
			return { type: 1, ctime: 0, mtime: 0, size: bytes.length, etag: '"revision-b"' };
		},
	};
	const unconditional = await request(workspace, { method: 'POST', query: { restoreVersion: 'revision-old' } });
	assert.equal(unconditional.status, 412);
	const wildcard = await request(workspace, {
		method: 'POST', query: { restoreVersion: 'revision-old' }, headers: { 'If-Match': '*' },
	});
	assert.equal(wildcard.status, 200);
	assert.equal(wildcard.headers.get('etag'), '"revision-b"');
	assert.deepEqual(calls, [
		{ path: '/', id: 'revision-old', expectedEtag: '' },
		{ path: '/', id: 'revision-old', expectedEtag: '*' },
	]);
});

// The three forms below decide whether a save or a restore is allowed to proceed, so each one
// needs its own assertion; a plain string comparison silently rejects the RFC 9110 forms.
test('the If-Match comparison accepts a wildcard and a list but rejects absent or stale tags', () => {
	assert.equal(ifMatchHolds('*', '"revision-a"'), true);
	assert.equal(ifMatchHolds('"revision-a"', '"revision-a"'), true);
	assert.equal(ifMatchHolds('"revision-x", "revision-a"', '"revision-a"'), true);
	assert.equal(ifMatchHolds(' "revision-a" ', '"revision-a"'), true);
	assert.equal(ifMatchHolds('"revision-x", "revision-y"', '"revision-a"'), false);
	// An absent precondition never holds: callers that require one treat this as "reject".
	assert.equal(ifMatchHolds('', '"revision-a"'), false);
	assert.equal(ifMatchHolds(undefined, '"revision-a"'), false);
});
