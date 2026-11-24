import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { Pool } from 'pg';
import { openRustfsWorkspace } from './rustfs-workspace.mjs';
import { authorizeWorkspace } from './workspace-access.mjs';
import { openDirectoryBlobs } from './test-support/directory-blobs.mjs';
import { openOfficePreviewStore, closeOfficePreviewStore } from './office-preview-store.mjs';
import { openPreviewBlobs } from './office-preview-blobs.mjs';
import { officePreviewLimits, officePreviewPath, renderProfileFingerprint } from './office-preview-contract.mjs';
import { openOriginalFor } from './office-preview-runner.mjs';
import { runPreviewCycle } from './office-preview-service.mjs';
import { serveOfficePreviewRequest } from './office-preview-files.mjs';

// End to end tests for the Office preview pipeline against real PostgreSQL, real storage
// metadata and the real LibreOffice binary. Opt in like the other integration tests:
//
//   cp /home/log4stellar/.config/log4stellar/workspace-storage.json /tmp/l4s-officeint.json
//   chmod 600 /tmp/l4s-officeint.json
//   LOG4STELLAR_STORAGE_CONFIG=/tmp/l4s-officeint.json LOG4STELLAR_IT=1 \
//     node --test --test-concurrency=1 apps/web/office-preview.integration.test.mjs
//
// Two deliberate choices:
//
//   * the PDF cache is a directory under /tmp, never the RustFS bucket. Previews are
//     derived data and the pilot stores them next to the workspace, not inside it.
//   * the original blobs use `openDirectoryBlobs`, the same stand-in the sync and git
//     integration tests use, so no object ever reaches the production bucket. The
//     metadata is still the real PostgreSQL schema.
//
// Every workspace matches `l4s-it-office-*` and every row and both temporary roots are
// removed afterwards. One sample of each convertible format is produced by LibreOffice
// itself from an OpenDocument source, because a hand-built OOXML zip is rejected by the
// converter and would not prove anything.
const enabled = process.env.LOG4STELLAR_IT === '1';
const configPath = process.env.LOG4STELLAR_STORAGE_CONFIG;
const skip = !enabled
	? 'set LOG4STELLAR_IT=1 to run the Office preview integration tests'
	: !configPath
		? 'set LOG4STELLAR_STORAGE_CONFIG to an isolated storage JSON copy'
		: false;
const converter = process.env.LOG4STELLAR_OFFICE_SOFFICE || '/usr/bin/soffice';

function storageConfig() {
	if (!configPath) {
		throw new Error('Set LOG4STELLAR_STORAGE_CONFIG to run the Office preview integration tests.');
	}
	return JSON.parse(readFileSync(configPath, 'utf8'));
}

function spoolDirectory() {
	return join(dirname(configPath), 'spool');
}

const documents = {
	'.docx': {
		source: 'document.fodt',
		extension: 'docx',
		odf: `<?xml version="1.0" encoding="UTF-8"?>
<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" office:version="1.3" office:mimetype="application/vnd.oasis.opendocument.text">
 <office:body><office:text>
  <text:h text:style-name="Heading_20_1">季度报告 Quarterly Report</text:h>
  <text:p>Office 预览转换夹具：中文与 ASCII 混排，用于验证 LibreOffice → PDF 管线的端到端行为。</text:p>
  <text:p>第一段正文内容，包含数字 12345 与标点符号、括号（示例）以及长句子以触发换行与分页逻辑。</text:p>
  <text:p>第二段正文内容，重复出现以产生多个文本行，验证分页符与行距处理是否正确。</text:p>
  <text:p>第三段正文内容，结束。</text:p>
 </office:text></office:body>
</office:document>
`,
	},
	'.xlsx': {
		source: 'sheet.fods',
		extension: 'xlsx',
		odf: `<?xml version="1.0" encoding="UTF-8"?>
<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" office:version="1.3" office:mimetype="application/vnd.oasis.opendocument.spreadsheet">
 <office:body><office:spreadsheet>
  <table:table table:name="预算">
   <table:table-row><table:table-cell office:value-type="string"><text:p>项目</text:p></table:table-cell><table:table-cell office:value-type="string"><text:p>金额</text:p></table:table-cell></table:table-row>
   <table:table-row><table:table-cell office:value-type="string"><text:p>服务器</text:p></table:table-cell><table:table-cell office:value-type="float" office:value="1200"><text:p>1200</text:p></table:table-cell></table:table-row>
   <table:table-row><table:table-cell office:value-type="string"><text:p>存储</text:p></table:table-cell><table:table-cell office:value-type="float" office:value="800"><text:p>800</text:p></table:table-cell></table:table-row>
  </table:table>
 </office:spreadsheet></office:body>
</office:document>
`,
	},
	'.pptx': {
		source: 'deck.fodp',
		extension: 'pptx',
		odf: `<?xml version="1.0" encoding="UTF-8"?>
<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0" office:version="1.3" office:mimetype="application/vnd.oasis.opendocument.presentation">
 <office:body><office:presentation>
  <draw:page draw:name="page1" presentation:class="title">
   <draw:frame svg:width="24cm" svg:height="3cm" svg:x="2cm" svg:y="6cm"><draw:text-box><text:p>演示文稿标题</text:p></draw:text-box></draw:frame>
  </draw:page>
  <draw:page draw:name="page2" presentation:class="outline">
   <draw:frame svg:width="24cm" svg:height="10cm" svg:x="2cm" svg:y="4cm"><draw:text-box><text:p>要点一</text:p><text:p>要点二</text:p></draw:text-box></draw:frame>
  </draw:page>
 </office:presentation></office:body>
</office:document>
`,
	},
};

/** Runs the real converter once, with the same isolated profile shape the worker uses. */
function convert(source, outputDirectory, target, profileDirectory) {
	return new Promise((resolve, reject) => {
		const child = spawn(converter, [
			`-env:UserInstallation=file://${profileDirectory}`,
			'--headless', '--norestore', '--nolockcheck', '--nodefault', '--nologo',
			'--convert-to', target, '--outdir', outputDirectory, source,
		], { stdio: ['ignore', 'pipe', 'pipe'] });
		const err = [];
		child.stderr.on('data', chunk => err.push(chunk));
		child.once('error', reject);
		child.once('close', code => resolve({ code, stderr: Buffer.concat(err).toString('utf8') }));
	});
}

/** Every fixture is produced by LibreOffice from an OpenDocument source. */
async function makeFixtures(directory, profileDirectory) {
	const produced = {};
	for (const [extension, spec] of Object.entries(documents)) {
		const source = join(directory, spec.source);
		await writeFile(source, spec.odf);
		const { code, stderr } = await convert(source, directory, spec.extension, profileDirectory);
		assert.equal(code, 0, `the fixture converter failed: ${stderr}`);
		// LibreOffice names the output after the *source* basename, so the fixture path is
		// derived rather than assumed.
		const file = join(directory, spec.source.replace(/\.[^.]+$/, '.' + spec.extension));
		produced[extension] = { path: file, bytes: await readFile(file) };
		assert.ok(produced[extension].bytes.length > 1000, `${extension} fixture is too small to be real`);
		assert.equal(produced[extension].bytes.subarray(0, 2).toString('latin1'), 'PK', `${extension} is not an OOXML zip`);
	}
	return produced;
}

/** One HTTP request through the real handler and the real capability facade. */
async function call(fixture, { role = 'owner', method = 'GET', path = '', body } = {}) {
	const headers = new Map();
	let payload;
	if (body !== undefined) {
		payload = Buffer.from(JSON.stringify(body));
		headers.set('content-type', 'application/json');
	}
	const ctx = {
		method,
		path: officePreviewPath + path,
		query: {},
		status: undefined,
		body: undefined,
		type: undefined,
		length: undefined,
		req: payload === undefined ? Readable.from([]) : Readable.from([payload]),
		get: name => headers.get(name.toLowerCase()) ?? '',
		set: (name, value) => headers.set(name.toLowerCase(), value),
		is: type => (headers.get('content-type') ?? '').startsWith(type),
	};
	await serveOfficePreviewRequest(
		ctx,
		authorizeWorkspace(fixture.backend, { role }),
		fixture.scope,
	);
	return { status: ctx.status ?? (ctx.body === undefined ? 404 : 200), body: ctx.body, headers, ctx };
}

function countVersions(fixture) {
	return fixture.pool
		.query('SELECT count(*)::int AS n FROM log4stellar.storage_file_versions WHERE workspace_id = $1', [fixture.workspaceId])
		.then(result => result.rows[0].n);
}

async function bodyOf(result) {
	if (result.body?.pipe) {
		const chunks = [];
		for await (const chunk of result.body) {
			chunks.push(chunk);
		}
		return Buffer.concat(chunks);
	}
	return result.body;
}

/**
 * One throw-away workspace, one preview store, one cache directory. The shape mirrors
 * how `serve-demo.mjs` wires the same collaborators in production.
 */
async function scenario(work) {
	const settings = storageConfig();
	const workspaceId = 'l4s-it-office-' + randomUUID().replace(/-/g, '').slice(0, 10);
	const pool = new Pool({ connectionTimeoutMillis: 5000, max: 4, ...settings.postgres });
	const seed = await mkdtemp(join(tmpdir(), 'l4s-office-seed-'));
	const cacheDirectory = await mkdtemp(join(tmpdir(), 'l4s-office-cache-'));
	// The fixture profile lives outside the seeded tree: the workspace import must only see
	// the documents, and a LibreOffice profile directory would add hundreds of files.
	const profileDirectory = await mkdtemp(join(tmpdir(), 'l4s-office-profile-'));
	const environment = { ...process.env, LOG4STELLAR_STORAGE_CONFIG: configPath };
	const limits = officePreviewLimits(environment);
	let importer;
	let backend;
	let store;
	let blobs;
	try {
		const fixtures = await makeFixtures(seed, profileDirectory);
		importer = await openRustfsWorkspace(workspaceId, { importing: true, createBlobs: openDirectoryBlobs });
		await importer.importDirectory(seed, 64 * 1024 * 1024);
		await importer.close();
		importer = undefined;
		backend = await openRustfsWorkspace(workspaceId, { createBlobs: openDirectoryBlobs });
		store = await openOfficePreviewStore(environment);
		blobs = await openPreviewBlobs({ directory: cacheDirectory, maxBytes: limits.maxOutputBytes });
		// The fixtures live under the workspace root, exactly as an imported document does.
		for (const [extension, fixture] of Object.entries(fixtures)) {
			const name = '/' + extension.slice(1) + '-fixture' + extension;
			await backend.writeFile(name, Readable.from([fixture.bytes]), { create: true, maxBytes: 1024 * 1024 });
			fixture.workspacePath = name;
		}
		const scope = {
			store, blobs, workspaceId, limits,
			profileFingerprint: renderProfileFingerprint(environment),
		};
		await work({
			workspaceId, pool, backend, store, blobs, scope, limits, fixtures, cacheDirectory,
			// `index` gives each racing worker its own identity, exactly as two different
			// deployment nodes would have.
			convertOnce: async (index = 0) => runPreviewCycle({
				store, blobs, limits, workerId: 'it-worker-' + process.pid + '-' + index,
				converterPath: converter, cacheDirectory,
				openOriginal: openOriginalFor(async () => backend, limits),
				nowMs: Date.now(),
			}),
		});
	} finally {
		await closeOfficePreviewStore();
		await store?.close?.().catch(() => {});
		await backend?.close?.();
		if (importer) {
			await importer.close().catch(() => {});
		}
		await clean(pool, workspaceId);
		await pool.end();
		await rm(seed, { recursive: true, force: true });
		await rm(cacheDirectory, { recursive: true, force: true });
	}
}

async function clean(pool, workspaceId) {
	await pool.query('DELETE FROM log4stellar.office_previews WHERE workspace_id = $1', [workspaceId]).catch(() => {});
	await pool.query('DELETE FROM log4stellar.office_preview_slots').catch(() => {});
	for (const table of ['storage_file_versions', 'storage_entries']) {
		await pool.query(`DELETE FROM log4stellar.${table} WHERE workspace_id = $1`, [workspaceId]).catch(() => {});
	}
	await pool.query('DELETE FROM log4stellar.storage_workspaces WHERE id = $1', [workspaceId]).catch(() => {});
	await rm(join(spoolDirectory(), 'test-blobs', workspaceId), { recursive: true, force: true });
}

test('PV01/§2: a convertible document is converted by the real LibreOffice', { skip }, async () => {
	await scenario(async fixture => {
		const created = await call(fixture, { method: 'POST', body: { path: fixture.fixtures['.docx'].workspacePath } });
		assert.equal(created.status, 202, JSON.stringify(created.body));
		assert.equal(created.body.state, 'queued');
		assert.match(created.body.id, /^[0-9a-f-]{36}$/);
		assert.equal(created.body.revisionId.length, 36);

		// §3 read-only baseline: the number of original versions must be identical after a
		// preview is produced.
		const versionsBefore = await countVersions(fixture);

		const started = Date.now();
		const outcome = await fixture.convertOnce();
		const elapsed = Date.now() - started;
		assert.equal(outcome.claimed, true);
		assert.equal(outcome.published, true, JSON.stringify(outcome));
		// The pilot budget is 60 s; a cold start on this host is 1–3 s. Keep the assertion
		// generous so a loaded machine does not turn a working pipeline red.
		assert.ok(elapsed < 60_000, `conversion took ${elapsed} ms`);

		const status = await call(fixture, { path: '/' + created.body.id });
		assert.equal(status.status, 200);
		assert.equal(status.body.state, 'ready');
		assert.ok(status.body.size > 1000, 'the PDF must not be empty');

		const pdf = await call(fixture, { path: '/' + created.body.id + '/pdf' });
		assert.equal(pdf.status, 200);
		assert.equal(pdf.ctx.type, 'application/pdf');
		const bytes = await bodyOf(pdf);
		assert.equal(bytes.subarray(0, 5).toString('latin1'), '%PDF-');
		assert.equal(bytes.length, status.body.size);

		// The row and the object agree with what was served.
		const rows = await fixture.pool.query(
			'SELECT state, size_bytes, object_key, attempt_count FROM log4stellar.office_previews WHERE preview_id = $1',
			[created.body.id]);
		assert.equal(rows.rows[0].state, 'ready');
		assert.equal(Number(rows.rows[0].size_bytes), bytes.length);
		assert.match(rows.rows[0].object_key, /^office-previews\/[0-9a-f]{2}\/[0-9a-f]{64}\/[0-9a-f-]{36}\.pdf$/);
		assert.equal(rows.rows[0].attempt_count, 1);
		// §3 read-only: producing a preview creates no version of the original.
		assert.equal(await countVersions(fixture), versionsBefore, 'a preview must not create an original version');
		// 3 ODF sources + 3 OOXML outputs are imported, then the 3 OOXML fixtures are
		// written through the storage API: 9 versions in total, none of them from a preview.
		assert.equal(versionsBefore, 9, 'six imported documents plus three written fixtures');
	});
});

test('§2: every convertible format converts, the download-only formats are refused', { skip }, async () => {
	await scenario(async fixture => {
		for (const extension of ['.xlsx', '.pptx']) {
			const created = await call(fixture, { method: 'POST', body: { path: fixture.fixtures[extension].workspacePath } });
			assert.equal(created.status, 202, extension + ' ' + JSON.stringify(created.body));
			const outcome = await fixture.convertOnce();
			assert.equal(outcome.published, true, extension + ' ' + JSON.stringify(outcome));
			const pdf = await call(fixture, { path: '/' + created.body.id + '/pdf' });
			assert.equal(pdf.status, 200);
			const bytes = await bodyOf(pdf);
			assert.equal(bytes.subarray(0, 5).toString('latin1'), '%PDF-');
		}

		// PV01: a download-only format never reaches the converter.
		await fixture.backend.writeFile('/legacy.doc', Readable.from([Buffer.from('%PDF- not really')]), {
			create: true, maxBytes: 1024 * 1024,
		});
		const refused = await call(fixture, { method: 'POST', body: { path: '/legacy.doc' } });
		assert.equal(refused.status, 415);
		assert.equal(refused.body.error, 'UnsupportedFormat');
		const rows = await fixture.pool.query(
			'SELECT count(*)::int AS n FROM log4stellar.office_previews WHERE workspace_id = $1', [fixture.workspaceId]);
		assert.equal(rows.rows[0].n, 2, 'a refused format must not create a queue row');
	});
});

test('PV02: a second request for the same version reuses the preview and never converts twice', { skip }, async () => {
	await scenario(async fixture => {
		const path = fixture.fixtures['.docx'].workspacePath;
		const first = await call(fixture, { method: 'POST', body: { path } });
		assert.equal(first.status, 202);
		const ready = await fixture.convertOnce();
		assert.equal(ready.published, true);

		const second = await call(fixture, { method: 'POST', body: { path } });
		assert.equal(second.status, 200, 'a ready preview is served without queueing');
		assert.equal(second.body.id, first.body.id);
		assert.equal(second.body.state, 'ready');

		// A concurrent burst on the same version must not create a second job either.
		const burst = await Promise.all([1, 2, 3, 4, 5].map(() => call(fixture, { method: 'POST', body: { path } })));
		for (const response of burst) {
			assert.equal(response.body.id, first.body.id);
		}
		const rows = await fixture.pool.query(
			'SELECT count(*)::int AS n, max(attempt_count)::int AS attempts FROM log4stellar.office_previews WHERE workspace_id = $1',
			[fixture.workspaceId]);
		assert.equal(rows.rows[0].n, 1, 'exactly one row for one version');
		assert.equal(rows.rows[0].attempts, 1, 'exactly one conversion for one version');
	});
});

test('PV03: a historical revision is a distinct preview of the same file', { skip }, async () => {
	await scenario(async fixture => {
		const path = fixture.fixtures['.docx'].workspacePath;
		const current = await call(fixture, { method: 'POST', body: { path } });
		assert.equal(current.status, 202);
		assert.equal((await fixture.convertOnce()).published, true);

		// Save a new version and preview the *previous* one explicitly.
		const previousRevision = current.body.revisionId;
		const updated = await fixture.backend.writeFile(path, Readable.from([Buffer.from('%PDF- replacement')]), {
			overwrite: true, etag: '"' + previousRevision + '"', maxBytes: 1024 * 1024,
		});
		assert.notEqual(updated.revisionId, previousRevision);

		const historical = await call(fixture, { method: 'POST', body: { path, revisionId: previousRevision } });
		assert.equal(historical.status, 200, JSON.stringify(historical.body));
		assert.equal(historical.body.id, current.body.id, 'the historical revision was already converted');

		const rows = await fixture.pool.query(
			`SELECT revision_id, state FROM log4stellar.office_previews WHERE workspace_id = $1 ORDER BY created_ms`,
			[fixture.workspaceId]);
		assert.equal(rows.rows.length, 1);
		assert.equal(rows.rows[0].revision_id, previousRevision);

		// A revision that belongs to another file is not previewable.
		const foreign = await call(fixture, {
			method: 'POST', body: { path: fixture.fixtures['.xlsx'].workspacePath, revisionId: previousRevision },
		});
		assert.equal(foreign.status, 404);
	});
});

test('PV04: a preview id is scoped to its workspace', { skip }, async () => {
	await scenario(async fixture => {
		const created = await call(fixture, { method: 'POST', body: { path: fixture.fixtures['.docx'].workspacePath } });
		assert.equal(created.status, 202);
		await fixture.convertOnce();

		// Same handler, same store, but a different workspace id: the row must not resolve.
		const other = { ...fixture.scope, workspaceId: fixture.workspaceId + '-other' };
		const ctx = {
			method: 'GET', path: officePreviewPath + '/' + created.body.id, query: {},
			req: Readable.from([]), headers: new Map(),
			get(name) { return this.headers.get(name.toLowerCase()) ?? ''; },
			set(name, value) { this.headers.set(name.toLowerCase(), value); },
			is() { return false; },
		};
		await serveOfficePreviewRequest(ctx, authorizeWorkspace(fixture.backend, { role: 'owner' }), other);
		assert.equal(ctx.status, 404);
		assert.equal(ctx.body.error, 'FileNotFound');
		// The owner of the real workspace still sees it.
		const mine = await call(fixture, { path: '/' + created.body.id });
		assert.equal(mine.status, 200);
	});
});

test('PV05: an oversized original is refused before it occupies a queue slot', { skip }, async () => {
	await scenario(async fixture => {
		const big = Buffer.alloc(64 * 1024, 7);
		await fixture.backend.writeFile('/huge.docx', Readable.from([big]), { create: true, maxBytes: 1024 * 1024 });
		const small = { ...fixture.scope, limits: { ...fixture.limits, maxInputBytes: 1024 } };
		const ctx = {
			method: 'POST', path: officePreviewPath, query: {},
			req: Readable.from([Buffer.from(JSON.stringify({ path: '/huge.docx' }))]),
			headers: new Map([['content-type', 'application/json']]),
			get(name) { return this.headers.get(name.toLowerCase()) ?? ''; },
			set(name, value) { this.headers.set(name.toLowerCase(), value); },
			is(type) { return (this.headers.get('content-type') ?? '').startsWith(type); },
		};
		await serveOfficePreviewRequest(ctx, authorizeWorkspace(fixture.backend, { role: 'owner' }), small);
		assert.equal(ctx.status, 413);
		assert.equal(ctx.body.error, 'FileTooLarge');
		const rows = await fixture.pool.query(
			'SELECT count(*)::int AS n FROM log4stellar.office_previews WHERE workspace_id = $1', [fixture.workspaceId]);
		assert.equal(rows.rows[0].n, 0, 'a refused size must not create a row');
	});
});

test('PV06: a crashed worker lease is recovered and retried, a stale attempt cannot publish', { skip }, async () => {
	await scenario(async fixture => {
		const created = await call(fixture, { method: 'POST', body: { path: fixture.fixtures['.docx'].workspacePath } });
		assert.equal(created.status, 202);
		// Simulate a worker that claimed the job and died: the row is `running` with an
		// expired lease and a stale attempt id.
		const attempt = randomUUID();
		await fixture.pool.query(`
			UPDATE log4stellar.office_previews
			SET state = 'running', attempt_id = $2, lease_until_ms = $3, attempt_count = 1
			WHERE preview_id = $1
		`, [created.body.id, attempt, Date.now() - 60_000]);

		const recovered = await fixture.convertOnce();
		assert.equal(recovered.claimed, true);
		assert.equal(recovered.published, true);

		const rows = await fixture.pool.query(
			'SELECT state, attempt_count FROM log4stellar.office_previews WHERE preview_id = $1', [created.body.id]);
		assert.equal(rows.rows[0].state, 'ready');
		assert.equal(rows.rows[0].attempt_count, 2);

		// A late result from the dead attempt must not overwrite the published one.
		const stale = await fixture.store.finalizePreview({
			previewId: created.body.id, attemptId: attempt, objectKey:
				'office-previews/00/' + '0'.repeat(64) + '/' + attempt + '.pdf',
			sizeBytes: 1, nowMs: Date.now(),
		});
		assert.equal(stale, undefined, 'a stale attempt is fenced out');
		const after = await fixture.pool.query(
			'SELECT state, size_bytes FROM log4stellar.office_previews WHERE preview_id = $1', [created.body.id]);
		assert.equal(after.rows[0].state, 'ready');
		assert.ok(Number(after.rows[0].size_bytes) > 1000);
	});
});

test('PV07: an evicted preview is rebuilt on the next request and the PDF route reports 409 meanwhile', { skip }, async () => {
	await scenario(async fixture => {
		const path = fixture.fixtures['.docx'].workspacePath;
		const created = await call(fixture, { method: 'POST', body: { path } });
		assert.equal((await fixture.convertOnce()).published, true);

		await fixture.store.markEvicted(created.body.id, Date.now());
		const gone = await call(fixture, { path: '/' + created.body.id + '/pdf' });
		assert.equal(gone.status, 409);
		assert.equal(gone.body.error, 'PreviewNotReady');

		const again = await call(fixture, { method: 'POST', body: { path } });
		assert.equal(again.status, 202, 'an evicted preview is re-queued, not failed');
		assert.equal(again.body.id, created.body.id, 'the tombstone is reused');
		const rebuilt = await fixture.convertOnce();
		assert.equal(rebuilt.published, true);
		const pdf = await call(fixture, { path: '/' + created.body.id + '/pdf' });
		assert.equal(pdf.status, 200);
	});
});

test('PV08: concurrent workers produce exactly one conversion', { skip }, async () => {
	await scenario(async fixture => {
		const path = fixture.fixtures['.docx'].workspacePath;
		const created = await call(fixture, { method: 'POST', body: { path } });
		assert.equal(created.status, 202);

		// Three workers race for the same queue; the slot makes them strictly serial.
		const outcomes = await Promise.all([0, 1, 2].map(index => fixture.convertOnce(index)));
		assert.equal(outcomes.filter(outcome => outcome.claimed).length, 1, JSON.stringify(outcomes));
		const rows = await fixture.pool.query(
			'SELECT attempt_count FROM log4stellar.office_previews WHERE preview_id = $1', [created.body.id]);
		assert.equal(rows.rows[0].attempt_count, 1);
		// The slot is released when the cycle ends, so the next worker can run.
		const slots = await fixture.pool.query('SELECT count(*)::int AS n FROM log4stellar.office_preview_slots');
		assert.ok(slots.rows[0].n <= 1);
	});
});

test('§4: a corrupt document fails permanently instead of retrying forever', { skip }, async () => {
	await scenario(async fixture => {
		const broken = Buffer.from('PK\u0003\u0004 not a document');
		await fixture.backend.writeFile('/broken.docx', Readable.from([broken]), { create: true, maxBytes: 1024 * 1024 });
		const created = await call(fixture, { method: 'POST', body: { path: '/broken.docx' } });
		assert.equal(created.status, 202);
		const outcome = await fixture.convertOnce();
		assert.equal(outcome.claimed, true);
		assert.equal(outcome.published, false);
		assert.equal(outcome.retryable, false, 'a broken file is not retried');

		const rows = await fixture.pool.query(
			'SELECT state, error_code, retryable FROM log4stellar.office_previews WHERE preview_id = $1', [created.body.id]);
		assert.equal(rows.rows[0].state, 'failed');
		assert.equal(rows.rows[0].retryable, false);

		const status = await call(fixture, { path: '/' + created.body.id });
		assert.equal(status.status, 200);
		assert.equal(status.body.state, 'failed');
		assert.match(status.body.error, /^Preview(SourceCorrupt|Unavailable)$/);

		// A second request for the same broken version reports the classified error.
		const retried = await call(fixture, { method: 'POST', body: { path: '/broken.docx' } });
		assert.equal(retried.status, 415);
		assert.match(retried.body.error, /^Preview(SourceCorrupt|Unavailable)$/);
		const rows2 = await fixture.pool.query(
			'SELECT count(*)::int AS n FROM log4stellar.office_previews WHERE workspace_id = $1', [fixture.workspaceId]);
		assert.equal(rows2.rows[0].n, 1);

		// The original is still downloadable through the normal mount route: a failed
		// preview never touches the document.
		const original = await fixture.backend.openRead('/broken.docx');
		const chunks = [];
		for await (const chunk of await original.stream()) {
			chunks.push(chunk);
		}
		assert.deepEqual(Buffer.concat(chunks), broken, 'a failed preview leaves the original byte identical');
	});
});
