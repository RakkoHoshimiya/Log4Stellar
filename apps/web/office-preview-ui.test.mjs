import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

// The extension is plain CommonJS with no build step, so it is loaded into a fresh VM
// context exactly like the Git dashboard test does. Everything the extension touches that
// is not ECMAScript comes from the `vscode` stub below, which means a test failure here is
// always a real behaviour change in the web entry point.

const code = await readFile(new URL('./workspace-extension/extension.js', import.meta.url), 'utf8');
const uri = {
	scheme: 'vscode-test-web',
	authority: 'mount-Owner123.notes',
	path: '/docs/report.docx',
	toString: () => 'vscode-test-web://mount-Owner123.notes/docs/report.docx',
};
const plain = value => JSON.parse(JSON.stringify(value));

/** Builds a VM context with a recording `vscode` stub and a scripted preview provider. */
function environment({
	create = { state: 'queued' }, statuses = [], versions = [], pickVersion, pdf = '%PDF-1.7',
	pickAnswer, saveDialog, hasWebview = true, messages = [],
} = {}) {
	const created = [];
	const previews = [];
	const polled = [];
	const rendered = [];
	const warnings = [];
	const infos = [];
	const saved = [];
	const posted = [];
	let statusIndex = 0;

	const vscode = {
		env: { language: 'en' },
		ViewColumn: { Active: -1 },
		FileType: { File: 1, Directory: 2 },
		Uri: {
			from: value => value,
			file: value => ({ ...value, scheme: 'file' }),
			joinPath: (base, file) => ({ ...base, path: base.path + '/' + file }),
		},
		FileSystemError: {
			FileNotFound: value => Object.assign(new Error('FileNotFound'), { name: 'FileNotFound', uri: value }),
			NoPermissions: value => Object.assign(new Error('NoPermissions'), { name: 'NoPermissions', uri: value }),
			Unavailable: value => Object.assign(new Error('Unavailable'), { name: 'Unavailable', uri: value }),
		},
		EventEmitter: class {
			constructor() {
				this.listeners = [];
				this.event = listener => {
					this.listeners.push(listener);
					return { dispose: () => {} };
				};
			}
			fire(value) {
				for (const listener of this.listeners) {
					listener(value);
				}
			}
			dispose() {}
		},
		Disposable: class {
			constructor(action) {
				this.dispose = action ?? (() => {});
			}
		},
		CancellationTokenSource: class {
			constructor() {
				this.token = { isCancellationRequested: false };
				this.cancelled = false;
			}
			cancel() {
				this.cancelled = true;
				this.token.isCancellationRequested = true;
			}
			dispose() {}
		},
		window: {
			async showInformationMessage(message, ...items) {
				infos.push(message);
				return pickAnswer ? items[0] : undefined;
			},
			async showWarningMessage(message) {
				warnings.push(message);
				return undefined;
			},
			async showErrorMessage(message) {
				warnings.push(message);
				return undefined;
			},
			async showQuickPick(items) {
				if (typeof pickVersion === 'function') {
					const answer = pickVersion(items);
					return answer === undefined ? undefined : answer;
				}
				return undefined;
			},
			async showSaveDialog() {
				if (typeof saveDialog === 'function') {
					return saveDialog();
				}
				return saveDialog ?? undefined;
			},
			...(hasWebview
				? {
					createWebviewPanel(viewType, title, column, options) {
						const panel = {
							viewType, title, column, options, disposed: [],
							webview: {
								html: '',
														onDidReceiveMessage(listener) {
														        panel.receive = listener;
														        return { dispose: () => { panel.receive = undefined; } };
														},
														postMessage(message) { posted.push(message); },
								asWebviewUri: value => ({ toString: () => 'https://preview.invalid/' + (value.path ?? '') }),
							},
							onDidDispose(listener) { panel.disposed.push(listener); },
							dispose() { for (const listener of panel.disposed) { listener(); } },
						};
						rendered.push(panel);
						return panel;
					},
				}
				: {}),
		},
		workspace: {
			fs: {
				async writeFile(target, contents) {
					saved.push({ target, contents });
				},
			},
			registerFileSystemProvider(scheme, provider, options) {
				return { dispose: () => {}, scheme, provider, options };
			},
		},
	};

	const module = { exports: {} };
	vm.runInNewContext(code, {
		require: () => vscode, module, URL, URLSearchParams, Headers, Blob: globalThis.Blob,
		createObjectURL: undefined, fetch, AbortController,
	});
	const exports = module.exports;

	const provider = {
		async request(target, query) {
			if (query?.versions === '1') {
				return { json: async () => versions };
			}
			throw new Error('unexpected request ' + JSON.stringify(query));
		},
		async requestOfficePreview(target, options) {
			previews.push(plain({ path: target.path, ...options }));
			return create;
		},
		async previewStatus(target, previewId) {
			polled.push(previewId);
			const next = statuses.length ? statuses[Math.min(statusIndex, statuses.length - 1)] : { state: 'ready' };
			statusIndex += 1;
			return next;
		},
		async previewPdf(target, previewId) {
			return new TextEncoder().encode(pdf);
		},
	};

	return {
		exports, provider, warnings, infos, previews, polled, rendered, saved, posted, created, messages,
		open: options => exports.openOfficePreview(provider, uri, { extensionUri: { path: '/workspace-files' }, ...options }),
	};
}

test('PV01: a ready preview is rendered without polling', async () => {
	const window = environment({ create: { id: 'p-1', state: 'ready', revisionId: 'r-1' } });
	const panel = await window.open();
	assert.equal(panel.title, 'report.docx · r-1'.replace('r-1', 'r-1'));
	assert.equal(window.polled.length, 0, 'a ready preview must not poll');
	assert.deepEqual(window.previews, [{ path: '/docs/report.docx' }]);
	assert.equal(window.rendered.length, 1);
	assert.match(panel.webview.html, /<progress /);
	assert.match(panel.webview.html, /office-viewer\.mjs/);
	assert.doesNotMatch(panel.webview.html, /<embed/);
	assert.equal(panel.options.enableScripts, true);
	assert.equal(window.posted.length, 0);
	await panel.receive({ type: 'ready' });
	assert.equal(window.posted[0].type, 'document');
	assert.match(new TextDecoder().decode(window.posted[0].bytes), /^%PDF-/);
	panel.dispose();
	assert.equal(panel.receive, undefined);
	assert.match(window.rendered[0].webview.html, /default-src 'none'/);
	assert.match(panel.webview.html, /worker-src blob:; connect-src https:\/\/preview\.invalid\/[^;]*pdf\.worker\.min\.mjs;/);
});

test('the Office viewer fetches the bundled worker and reports a stalled first page', async () => {
	const viewerSource = await readFile(new URL('./workspace-extension/office-viewer.mjs', import.meta.url), 'utf8');
	const source = viewerSource.replace(/^import .*from '\.\/pdf\.min\.mjs';/m, '')
		.replace('import.meta.url', "'https://preview.invalid/office-viewer.mjs'");
	const status = { setAttribute() {}, dataset: { error: 'Could not render the preview.' } };
	const message = { textContent: 'Preparing' };
	const progress = { hidden: false };
	const options = {};
	const released = new Set();
	const ready = Promise.withResolvers();
	let onMessage;
	let onDeadline;
	let signal;
	let destroyed = false;
	class WorkerURL extends URL {
		static createObjectURL(blob) {
			assert.equal(blob.type, 'text/javascript');
			return 'blob:worker-from-webview';
		}
		static revokeObjectURL(url) { released.add(url); }
	}
	vm.runInNewContext(source, {
		URL: WorkerURL, Blob, AbortController, GlobalWorkerOptions: options,
		acquireVsCodeApi: () => ({ postMessage: event => assert.equal(event.type, 'ready') }),
		document: {
			getElementById: id => ({ status, message })[id],
			querySelector: () => progress,
		},
		addEventListener: (_type, listener) => { onMessage = listener; },
		async fetch(url, request) {
			assert.equal(url.href, 'https://preview.invalid/pdf.worker.min.mjs');
			assert.equal(request.credentials, 'omit');
			signal = request.signal;
			return new Response('worker module');
		},
		getDocument() {
			ready.resolve();
			return { promise: new Promise(() => {}), async destroy() { destroyed = true; } };
		},
		setTimeout: callback => { onDeadline = callback; return 1; },
		clearTimeout: () => {},
	});
	onMessage({ data: { type: 'document', bytes: new Uint8Array([1]) } });
	await ready.promise;
	assert.equal(options.workerSrc, 'blob:worker-from-webview');
	assert.equal(progress.hidden, false);
	onDeadline();
	assert.equal(signal.aborted, true);
	assert.equal(destroyed, true);
	assert.equal(released.has(options.workerSrc), true);
	assert.equal(progress.hidden, true);
	assert.equal(message.textContent, status.dataset.error);
});

test('a queued preview is polled until ready and then rendered', async () => {
	const window = environment({
		create: { id: 'p-2', state: 'queued', revisionId: 'r-2' },
		statuses: [{ state: 'running' }, { state: 'queued' }, { state: 'ready', id: 'p-2', revisionId: 'r-2' }],
	});
	const panel = await window.open({ wait: async () => {} });
	assert.equal(panel.title, 'report.docx · r-2');
	assert.deepEqual(window.polled, ['p-2', 'p-2', 'p-2']);
	assert.equal(window.rendered.length, 1);
});

test('a permanently failed preview stops polling and warns the user', async () => {
	const window = environment({
		create: { id: 'p-3', state: 'queued' },
		statuses: [{ state: 'failed', error: 'PreviewPasswordProtected' }],
	});
	const result = await window.open({ wait: async () => {} });
	assert.equal(result, undefined);
	assert.equal(window.polled.length, 1, 'a terminal state must stop the loop immediately');
	assert.equal(window.rendered.length, 0);
	assert.match(window.warnings[0], /Password protected/);
});

test('a corrupt document is reported as damaged, not retried', async () => {
	const window = environment({
		create: { id: 'p-4', state: 'queued' },
		statuses: [{ state: 'failed', error: 'PreviewSourceCorrupt' }],
	});
	await window.open({ wait: async () => {} });
	assert.equal(window.polled.length, 1);
	assert.match(window.warnings[0], /damaged/);
});

test('a 4xx from the create endpoint becomes an actionable warning', async () => {
	for (const [code, pattern] of [
		['UnsupportedFormat', /cannot be previewed/],
		['FileTooLarge', /too large/],
		['PreviewQueueFull', /queue is full/],
		['NoPermissions', /role does not allow/],
		['FileNotFound', /no longer in this workspace/],
	]) {
		const window = environment({ create: { id: 'p', state: 'queued' } });
		const provider = window.provider;
		provider.requestOfficePreview = async () => {
			const error = new Error(code);
			error.reason = {
				UnsupportedFormat: 'unsupported', FileTooLarge: 'tooLarge', PreviewQueueFull: 'busy',
				NoPermissions: 'denied', FileNotFound: 'missing',
			}[code];
			throw error;
		};
		const result = await window.open();
		assert.equal(result, undefined);
		assert.match(window.warnings[0], pattern);
	}
});

test('the version picker sends an explicit revision only for a historical version', async () => {
	const versions = [
		{ id: 'r-current', createdAt: 2000, size: 10, current: true, initial: false },
		{ id: 'r-old', createdAt: 1000, size: 10, current: false, initial: true },
	];
	const current = environment({
		create: { id: 'p-5', state: 'ready' },
		versions,
		pickVersion: items => items.find(item => item.current),
	});
	await current.open({ chooseVersion: true });
	// The current version is previewed with no revisionId at all: the server then locks the
	// identity to the revision it reads at request time.
	assert.deepEqual(current.previews, [{ path: '/docs/report.docx' }]);

	const historical = environment({
		create: { id: 'p-6', state: 'ready' },
		versions,
		pickVersion: items => items.find(item => !item.current),
	});
	await historical.open({ chooseVersion: true });
	assert.deepEqual(historical.previews, [{ path: '/docs/report.docx', revisionId: 'r-old' }]);

	const dismissed = environment({ create: { id: 'p-7', state: 'ready' }, versions, pickVersion: () => undefined });
	const result = await dismissed.open({ chooseVersion: true });
	assert.equal(result, undefined);
	assert.equal(dismissed.previews.length, 0, 'dismissing the picker must not create a preview');
});

test('a single version file skips the picker and previews the current revision', async () => {
	const window = environment({
		create: { id: 'p-8', state: 'ready' },
		versions: [{ id: 'r-only', createdAt: 1000, size: 10, current: true, initial: true }],
		pickVersion: () => assert.fail('the picker must not open for a single version'),
	});
	await window.open({ chooseVersion: true });
	assert.deepEqual(window.previews, [{ path: '/docs/report.docx' }]);
});

test('cancelling the wait stops polling and shows no error', async () => {
	const window = environment({
		create: { id: 'p-9', state: 'queued' },
		statuses: [{ state: 'queued' }],
		pickAnswer: true,
	});
	const result = await window.open({ wait: async () => {} });
	assert.equal(result, undefined);
	assert.equal(window.rendered.length, 0);
	assert.equal(window.warnings.length, 0, 'a cancellation is not an error');
});

test('a host without webviews falls back to saving the PDF locally', async () => {
	const target = { scheme: 'file', path: '/home/report.pdf' };
	const window = environment({
		create: { id: 'p-10', state: 'ready', revisionId: 'r-10' },
		hasWebview: false,
		saveDialog: target,
	});
	const saved = await window.open();
	assert.equal(saved, target);
	assert.equal(window.saved.length, 1);
	assert.deepEqual(window.saved[0].target, target);
	assert.match(new TextDecoder().decode(window.saved[0].contents), /^%PDF-/);
});

test('the preview client sends the workspace headers and the file path, never a digest', async () => {
	const module = { exports: {} };
	const requests = [];
	const vscode = { env: { language: 'en' }, EventEmitter: class { constructor() { this.event = () => ({ dispose: () => {} }); } } };
	const response = body => ({
		ok: true, status: 202,
		json: async () => body,
		arrayBuffer: async () => new TextEncoder().encode('%PDF-1.7\n').buffer,
	});
	const fetchStub = async (url, options) => {
		requests.push({ url: String(url), options });
		return response({ id: 'p', state: 'queued', revisionId: 'r' });
	};
	vm.runInNewContext(code, { require: () => vscode, module, URL, URLSearchParams, Headers, fetch: fetchStub });
	const provider = Object.create(module.exports.WorkspaceFileSystem.prototype);
	provider.origin = 'https://workspace.invalid';

	await provider.requestOfficePreview(uri, {});
	const created = requests.at(-1);
	assert.equal(created.url, 'https://workspace.invalid/api/v1/office-previews');
	assert.equal(created.options.method, 'POST');
	assert.equal(created.options.headers.get('Content-Type'), 'application/json');
	assert.equal(created.options.headers.get('X-Log4Stellar-Workspace'), 'notes');
	assert.equal(created.options.headers.get('X-Log4Stellar-Workspace-Account'), 'owner123');
	const body = JSON.parse(created.options.body);
	// The client names the file by path; it never sends a sha256, an object key or a size.
	assert.deepEqual(body, { path: '/docs/report.docx' });
	assert.equal('sha256' in body, false);

	await provider.requestOfficePreview(uri, { revisionId: 'r-old' });
	assert.deepEqual(JSON.parse(requests.at(-1).options.body), { path: '/docs/report.docx', revisionId: 'r-old' });

	await provider.previewStatus(uri, 'p-1');
	assert.equal(requests.at(-1).url, 'https://workspace.invalid/api/v1/office-previews/p-1');
	assert.equal(requests.at(-1).options.method, undefined);

	await provider.previewPdf(uri, 'p-1');
	assert.equal(requests.at(-1).url, 'https://workspace.invalid/api/v1/office-previews/p-1/pdf');
});

test('a preview request without a workspace authority is refused before fetching', async () => {
	const module = { exports: {} };
	let called = false;
	const vscode = { env: { language: 'en' }, EventEmitter: class { constructor() { this.event = () => ({ dispose: () => {} }); } } };
	vm.runInNewContext(code, {
		require: () => vscode, module, URL, URLSearchParams, Headers,
		fetch: async () => { called = true; throw new Error('must not fetch'); },
	});
	const provider = Object.create(module.exports.WorkspaceFileSystem.prototype);
	provider.origin = 'https://workspace.invalid';
	for (const authority of ['', 'mount-', 'file:///tmp']) {
		await assert.rejects(
			provider.requestOfficePreview({ ...uri, authority }, {}),
			error => error.message === 'WorkspaceSessionRequired',
		);
	}
	assert.equal(called, false);
});

test('original PDF preview reads authenticated workspace bytes without Office conversion', async () => {
	const { exports } = environment();
	const pdf = new TextEncoder().encode('%PDF-1.7 fixture');
	const target = { ...uri, path: '/docs/report.PDF' };
	let released = false;
	const token = {
		onCancellationRequested() { return { dispose() { released = true; } }; },
	};
	const result = await exports.readPdfPreview({
		async request(resource, query, { signal }) {
			assert.equal(resource, target);
			assert.deepEqual(plain(query), {});
			assert.equal(signal.aborted, false);
			return new Response(pdf);
		},
	}, target, token);
	assert.deepEqual(Array.from(result), Array.from(pdf));
	assert.ok(released);
});

test('PDF preview refuses an over-limit response before reading its body', async () => {
	const { exports } = environment();
	let cancelled = false;
	const token = { onCancellationRequested: () => ({ dispose() {} }) };
	await assert.rejects(exports.readPdfPreview({
		async request() {
			return {
				headers: new Headers({ 'Content-Length': String(100 * 1024 * 1024 + 1) }),
				body: { cancel: async () => { cancelled = true; } },
				arrayBuffer() { assert.fail('oversized response should not be read'); },
			};
		},
	}, uri, token), { reason: 'tooLarge' });
	assert.ok(cancelled);
});
