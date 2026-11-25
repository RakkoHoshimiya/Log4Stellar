import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

// The browser side of the search panel, driven without a browser: the extension source is
// executed in a sandbox with a fake `vscode` object and a fake `fetch`, exactly like
// git-ui.test.mjs. That is enough to pin the two things the acceptance rows care about:
//
//   S03  a slow search that finishes after a newer one is dropped, not rendered.
//   The preview is text plus a Range, so a note containing HTML cannot inject markup.
//
// The HTTP shapes are covered by search-files.test.mjs; the real index by
// search-integration.test.mjs.

const code = await readFile(new URL('./workspace-extension/extension.js', import.meta.url), 'utf8');
// A Uri look-alike: `with({ path })` is what the editor gives the provider and what the
// extension uses to build a hit's uri, so it has to exist here too.
const uriOf = (authority, path = '/') => ({
	scheme: 'vscode-test-web',
	authority,
	path,
	with(change) { return { ...this, ...change }; },
	toString() { return `vscode-test-web://${authority}${path}`; },
});
const rootUri = uriOf('mount-Owner123.notes');
const folder = { uri: rootUri, path: '/' };
const plain = value => JSON.parse(JSON.stringify(value));

function sandbox({ fetch: fetchImpl, origin = 'https://workspace.invalid', language = 'en' } = {}) {
	const module = { exports: {} };
	const registered = {};
	const vscode = {
		env: { language },
		EventEmitter: class { constructor() { this.listeners = []; } fire() {} dispose() {} },
		Position: class { constructor(line, character) { this.line = line; this.character = character; } },
		Range: class { constructor(start, end) { this.start = start; this.end = end; } },
		Uri: {
			from: value => value,
			parse: value => new URL(value),
			joinPath: (uri, ...parts) => ({ ...uri, path: [uri.path ?? '/', ...parts].join('/') }),
		},
		FileType: { File: 1, Directory: 2 },
		FileChangeType: { Changed: 1, Created: 2, Deleted: 3 },
		FileSystemError: { FileNotFound: message => new Error(message), NoPermissions: message => new Error(message) },
		workspace: {
			workspaceFolders: [{ uri: { scheme: 'vscode-test-web', authority: 'mount-Owner123.notes', path: '/' } }],
			registerFileSystemProvider: (scheme, provider) => { registered.fileSystem = provider; return { dispose() {} }; },
			registerFileSearchProvider: (scheme, provider) => { registered.fileSearch = provider; return { dispose() {} }; },
			registerTextSearchProvider: (scheme, provider) => { registered.textSearch = provider; return { dispose() {} }; },
			onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
		},
		commands: { registerCommand: () => ({ dispose() {} }), executeCommand: async () => undefined },
		extensions: { getExtension: () => undefined },
		window: {
			registerCustomEditorProvider: (type, provider) => { registered.officeEditor = { type, provider }; return { dispose() {} }; },
			showQuickPick: async () => undefined,
			showWarningMessage: async () => undefined,
			showInformationMessage: async () => undefined,
			showErrorMessage: async () => undefined,
			showInputBox: async () => undefined,
		},
	};
	vm.runInNewContext(code, {
		require: () => vscode, module, URL, URLSearchParams, Headers, AbortController,
		fetch: fetchImpl ?? (async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })),
	});
	return { vscode, registered, exports: module.exports, provider: () => module.exports.WorkspaceFileSystem };
}

function tick() {
	// The extension only awaits real promises, so one macrotask is enough to let a
	// resolved fetch settle before the assertions run.
	return new Promise(resolve => setTimeout(resolve, 0));
}

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
	return { promise, resolve, reject };
}

function token() {
	const listeners = [];
	return {
		isCancellationRequested: false,
		cancel() {
			this.isCancellationRequested = true;
			for (const listener of listeners.splice(0)) {
				listener();
			}
		},
		onCancellationRequested(listener) {
			listeners.push(listener);
			return { dispose: () => { const at = listeners.indexOf(listener); if (at >= 0) listeners.splice(at, 1); } };
		},
	};
}

function page(items, extra = {}) {
	return {
		items,
		total: items.length,
		hasMore: false,
		nextCursor: null,
		indexGeneration: 1,
		indexedAt: 1_700_000_000_000,
		...extra,
	};
}

async function textSearch(overrides = {}) {
	const box = sandbox(overrides);
	const instance = new (box.provider())(overrides.origin ?? 'https://workspace.invalid');
	return { box, instance };
}

// ------------------------------------------------------------------ request shape

test('a search asks the workspace mount for one page and fowards the pattern', async () => {
	const seen = [];
	const { instance } = await textSearch({
		fetch: async (url, init) => {
			seen.push({ url: String(url), init });
			return new Response(JSON.stringify(page([])), { status: 200, headers: { 'content-type': 'application/json' } });
		},
	});
	await instance.provideTextSearchResults({ pattern: '发布计划' }, { folder: folder.uri, maxResults: 20 }, { report() {} }, token());
	assert.equal(seen.length, 1);
	const url = new URL(seen[0].url);
	assert.equal(url.pathname, '/search/v1/query');
	assert.equal(url.searchParams.get('q'), '发布计划');
	assert.equal(url.searchParams.get('limit'), '20');
	// No cache: a stale page under a fresh cursor would be a correctness bug, not a
	// performance one.
	assert.equal(seen[0].init.cache, 'no-store');
	assert.equal(seen[0].init.redirect, 'error');
	// Both identity headers are present, so the gateway can resolve the workspace.
	assert.equal(seen[0].init.headers.get('X-Log4Stellar-Workspace'), 'notes');
	assert.equal(seen[0].init.headers.get('X-Log4Stellar-Workspace-Account'), 'owner123');
});

test('the page size is clamped to the documented bounds', async () => {
	for (const [requested, expected] of [[undefined, '50'], [5, '5'], [1000, '200'], [0, '50'], [-3, '1']]) {
		let seen;
		const { instance } = await textSearch({
			fetch: async url => {
				seen = String(url);
				return new Response(JSON.stringify(page([])), { status: 200, headers: { 'content-type': 'application/json' } });
			},
		});
		await instance.provideTextSearchResults({ pattern: 'x' }, { folder: folder.uri, maxResults: requested }, { report() {} }, token());
		assert.equal(new URL(seen).searchParams.get('limit'), expected, String(requested));
	}
});

// ------------------------------------------------------------------ results and previews

test('each hit is reported with a plain-text preview and a highlight range', async () => {
	const reported = [];
	const { instance } = await textSearch({
		fetch: async () => new Response(JSON.stringify(page([{
			fileId: 'f'.repeat(36), path: '/notes/发布计划.md', revisionId: 'r'.repeat(36),
			line: 1, column: 1, match: 'title', excerpt: '发布计划 alpha', excerptOffset: 0, excerptLength: 4,
		}])), { status: 200, headers: { 'content-type': 'application/json' } }),
	});
	const complete = await instance.provideTextSearchResults({ pattern: '发布计划' }, { folder: folder.uri }, { report: value => reported.push(value) }, token());
	assert.equal(reported.length, 1);
	assert.equal(reported[0].uri.path, '/notes/发布计划.md');
	// The preview carries the text as a string and the highlight as a Range, never as
	// markup, so an HTML note is displayed and never executed.
	assert.equal(reported[0].preview.text, '发布计划 alpha');
	assert.deepEqual(plain(reported[0].preview.matches), [{ start: { line: 0, character: 0 }, end: { line: 0, character: 4 } }]);
	assert.deepEqual(plain(reported[0].ranges), [{ start: { line: 0, character: 0 }, end: { line: 0, character: 4 } }]);
	assert.deepEqual(plain(complete), { limitHit: false });
});

test('a note containing HTML is reported as text and no markup is constructed', async () => {
	const reported = [];
	const excerpt = '<script>alert(1)</script> plan';
	const { instance } = await textSearch({
		fetch: async () => new Response(JSON.stringify(page([{
			fileId: 'f'.repeat(36), path: '/notes/x.md', revisionId: 'r'.repeat(36),
			line: 1, column: 1, match: 'body', excerpt, excerptOffset: 24, excerptLength: 4,
		}])), { status: 200, headers: { 'content-type': 'application/json' } }),
	});
	await instance.provideTextSearchResults({ pattern: 'plan' }, { folder: folder.uri }, { report: value => reported.push(value) }, token());
	// The string is passed through verbatim: escaping it here would break the offsets,
	// and the editor renders a preview as text.
	assert.equal(reported[0].preview.text, excerpt);
	assert.ok(reported[0].preview.text.includes('<script>'));
	assert.equal(reported[0].preview.text.constructor, String);
});

test('a page with more results reports the limit to the editor', async () => {
	const { instance } = await textSearch({
		fetch: async () => new Response(JSON.stringify(page([], { hasMore: true })), { status: 200, headers: { 'content-type': 'application/json' } }),
	});
	const complete = await instance.provideTextSearchResults({ pattern: 'x' }, { folder: folder.uri }, { report() {} }, token());
	assert.equal(complete.limitHit, true);
});

// ------------------------------------------------------------------ S03

test('S03: a slow search that finishes after a newer one is dropped', async () => {
	const slow = deferred();
	const fast = deferred();
	let call = 0;
	const { instance } = await textSearch({
		fetch: async () => {
			// The first request is the slow one; the second resolves immediately.
			return call++ === 0 ? slow.promise : fast.promise;
		},
	});
	const firstReports = [];
	const secondReports = [];
	const first = instance.provideTextSearchResults({ pattern: 'slow' }, { folder: folder.uri }, { report: value => firstReports.push(value) }, token());
	const second = instance.provideTextSearchResults({ pattern: 'fast' }, { folder: folder.uri }, { report: value => secondReports.push(value) }, token());

	const item = text => ({
		fileId: 'f'.repeat(36), path: '/' + text + '.md', revisionId: 'r'.repeat(36),
		line: 1, column: 1, match: 'body', excerpt: text, excerptOffset: 0, excerptLength: text.length,
	});
	// The newer query answers first and is rendered.
	fast.resolve(new Response(JSON.stringify(page([item('fast')])), { status: 200, headers: { 'content-type': 'application/json' } }));
	await second;
	await tick();
	// The older query answers afterwards. Its ticket was superseded, so it must not
	// report anything even though it succeeded.
	slow.resolve(new Response(JSON.stringify(page([item('slow')])), { status: 200, headers: { 'content-type': 'application/json' } }));
	const late = await first;

	assert.deepEqual(secondReports.map(report => report.preview.text), ['fast']);
	assert.deepEqual(firstReports, [], 'the superseded search must not render');
	assert.deepEqual(plain(late), { limitHit: false });
});

test('S03: a search that fails after being superseded does not surface its error', async () => {
	const slow = deferred();
	const fast = deferred();
	let call = 0;
	const { instance } = await textSearch({
		fetch: async () => (call++ === 0 ? slow.promise : fast.promise),
	});
	const first = instance.provideTextSearchResults({ pattern: 'slow' }, { folder: folder.uri }, { report() {} }, token());
	const second = instance.provideTextSearchResults({ pattern: 'fast' }, { folder: folder.uri }, { report() {} }, token());
	fast.resolve(new Response(JSON.stringify(page([])), { status: 200, headers: { 'content-type': 'application/json' } }));
	await second;
	// The stale request now fails; the user must never see an error for a query they
	// already replaced.
	slow.reject(new Error('network down'));
	const late = await first;
	assert.deepEqual(plain(late), { limitHit: false });
});

test('a cancelled search is dropped and its request aborted', async () => {
	const pending = deferred();
	let signal;
	const { instance } = await textSearch({
		fetch: async (_url, init) => {
			signal = init.signal;
			return pending.promise;
		},
	});
	const cancellation = token();
	const running = instance.provideTextSearchResults({ pattern: 'x' }, { folder: folder.uri }, { report() {} }, cancellation);
	await tick();
	assert.equal(signal.aborted, false);
	cancellation.cancel();
	assert.equal(signal.aborted, true, 'the in-flight request must be aborted, not just ignored');
	pending.resolve(new Response(JSON.stringify(page([])), { status: 200, headers: { 'content-type': 'application/json' } }));
	assert.deepEqual(plain(await running), { limitHit: false });
});

test('a search cancelled before it starts never reaches the network', async () => {
	let calls = 0;
	const { instance } = await textSearch({
		fetch: async () => { calls += 1; return new Response('{}', { status: 200 }); },
	});
	const cancellation = token();
	cancellation.cancel();
	const complete = await instance.provideTextSearchResults({ pattern: 'x' }, { folder: folder.uri }, { report() {} }, cancellation);
	assert.deepEqual(plain(complete), { limitHit: false });
	assert.equal(calls, 0);
});

// ------------------------------------------------------------------ failures

test('search distinguishes an expired session from insufficient permissions', async () => {
	for (const status of [401, 403]) {
		const { instance } = await textSearch({
			fetch: async () => new Response(JSON.stringify({ error: 'NoPermissions' }), { status, headers: { 'content-type': 'application/json' } }),
		});
		await assert.rejects(
			instance.provideTextSearchResults({ pattern: 'x' }, { folder: folder.uri }, { report() {} }, token()),
			{ code: status === 401 ? 'SessionExpired' : 'NoPermissions', message: status === 401 ? /Sign in again/ : /workspace role/ },
		);
	}
});

test('search cursor expiration retains its code and uses the active locale', async () => {
	const { instance } = await textSearch({
		language: 'zh-HK',
		fetch: async () => new Response(JSON.stringify({ error: 'SearchCursorExpired' }), { status: 410, headers: { 'content-type': 'application/json' } }),
	});
	await assert.rejects(
		instance.provideTextSearchResults({ pattern: 'x' }, { folder: folder.uri }, { report() {} }, token()),
		{ code: 'SearchCursorExpired', message: '搜尋結果已到期，請重新搜尋。' },
	);
});

// ------------------------------------------------------------------ registration

test('the search provider is registered for the workspace scheme', async () => {
	const box = sandbox();
	const activated = [];
	await box.exports.activate({
		extensionUri: { toString: () => 'https://workspace.invalid/' },
		subscriptions: { push: value => activated.push(value) },
	});
	assert.ok(box.registered.textSearch, 'a text search provider must be registered');
	assert.equal(typeof box.registered.textSearch.provideTextSearchResults, 'function');
	// The file search provider from the previous feature must keep working.
	assert.ok(box.registered.fileSearch);
	assert.equal(box.registered.officeEditor.type, 'log4stellar.officePreview');
});
