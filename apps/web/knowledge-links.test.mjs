// Unit tests for the knowledge index: link resolution, the ambiguity rule, the rename preview and
// the request contract. No database, no object store, no HTTP server — every rule here is a pure
// function of its inputs, so the interesting cases run in milliseconds.
//
// The PostgreSQL side (backlink queries, the trash round trip, the index migration) lives in
// knowledge-integration.test.mjs, which is opt-in behind LOG4STELLAR_IT.

import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import {
	applyLinkRewrite,
	describeNoteIndex,
	knowledgeTagKey,
	planLinkRewrite,
	resolveLink,
	rewriteBody,
	updateKnowledgeIndex,
} from './knowledge-indexer.mjs';
import { parseKnowledge } from './knowledge-parser.mjs';
import {
	decodeKnowledgeCursor,
	encodeKnowledgeCursor,
	knowledgePageSize,
} from './knowledge-store.mjs';
import { capabilityForKnowledgeRequest, knowledgeRoutes } from './knowledge-files.mjs';
import { WorkspaceError } from './workspace-contract.mjs';

// ---------------------------------------------------------------------------------------
// A tiny in-memory stand-in for knowledge-store.mjs. Only the methods the indexer calls.
// ---------------------------------------------------------------------------------------

function memoryStore(files) {
	const rows = new Map(files.map(file => [file.path, {
		path: file.path,
		file_id: file.fileId,
		revision_id: file.revisionId ?? 'r-' + file.fileId,
		kind: 1,
		name: file.path.split('/').pop(),
	}]));
	const state = new Map();
	return {
		rows,
		state,
		async readFileByPath(_workspaceId, path) {
			return rows.get(path);
		},
		async readLiveFile(_workspaceId, fileId) {
			return [...rows.values()].find(row => row.file_id === fileId);
		},
		async listCandidateFiles(_workspaceId, names) {
			const wanted = new Set(names.map(name => String(name).toLowerCase()));
			return [...rows.values()]
				.filter(row => wanted.has(String(row.name).toLowerCase()))
				.map(row => ({ ...row, name_key: String(row.name).toLowerCase() }));
		},
		async readIndexState(_workspaceId, fileId) {
			return state.get(fileId);
		},
		async listLinksToFile() {
			return [];
		},
		async replaceFileIndex(_connection, entry) {
			state.set(entry.fileId, {
				revisionId: entry.revisionId,
				parserVersion: entry.parserVersion,
				linkCount: entry.links.length,
				tagCount: entry.tags.length,
			});
		},
		async transaction(action) {
			return action({});
		},
	};
}

function scopeFor(store, extra = {}) {
	return { workspaceId: 'l4s-test', store, ...extra };
}

// ---------------------------------------------------------------------------------------
// Resolution: the four statuses and the K01 ambiguity rule
// ---------------------------------------------------------------------------------------

test('a relative path link resolves to the stable file ID of its target', async () => {
	const store = memoryStore([
		{ path: '/notes/a.md', fileId: 'f-a' },
		{ path: '/dir/b.md', fileId: 'f-b' },
	]);
	const resolved = await resolveLink(scopeFor(store), 'f-a', '../dir/b.md', { kind: 'markdown', sourcePath: '/notes/a.md' });
	assert.equal(resolved.status, 'resolved');
	assert.equal(resolved.targetFileId, 'f-b');
	assert.equal(resolved.targetPath, '/dir/b.md');
	assert.equal(resolved.candidateCount, 1);
});

test('a path link to a note that does not exist is missing, never a name guess', async () => {
	// `../dir/gone.md` is explicit. Even though a note named `gone.md` exists elsewhere, the
	// resolver must not silently retarget an explicit path (that would rewrite a wrong link).
	const store = memoryStore([
		{ path: '/notes/a.md', fileId: 'f-a' },
		{ path: '/other/gone.md', fileId: 'f-gone' },
	]);
	const resolved = await resolveLink(scopeFor(store), 'f-a', '../dir/gone.md', { kind: 'markdown', sourcePath: '/notes/a.md' });
	assert.equal(resolved.status, 'missing');
	assert.equal(resolved.targetFileId, null);
});

test('a bare wiki name with one match resolves to that note', async () => {
	const store = memoryStore([
		{ path: '/notes/a.md', fileId: 'f-a' },
		{ path: '/dir/b.md', fileId: 'f-b' },
	]);
	const resolved = await resolveLink(scopeFor(store), 'f-a', 'b', { kind: 'wiki', sourcePath: '/notes/a.md' });
	assert.equal(resolved.status, 'resolved');
	assert.equal(resolved.targetFileId, 'f-b');
});

test('K01: the same name in two directories is ambiguous and lists the candidates', async () => {
	// docs/knowledge-links.md §K01: `[[重名]]` with /x/重名.md and /y/重名.md must not guess.
	const store = memoryStore([
		{ path: '/notes/a.md', fileId: 'f-a' },
		{ path: '/x/重名.md', fileId: 'f-x' },
		{ path: '/y/重名.md', fileId: 'f-y' },
	]);
	const resolved = await resolveLink(scopeFor(store), 'f-a', '重名', { kind: 'wiki', sourcePath: '/notes/a.md' });
	assert.equal(resolved.status, 'ambiguous');
	assert.equal(resolved.targetFileId, null, 'an ambiguous link must not pick a target');
	assert.equal(resolved.candidateCount, 2);
	assert.deepEqual(resolved.candidates.map(candidate => candidate.path), ['/x/重名.md', '/y/重名.md']);
});

test('K01: an ambiguous link is never rewritten by the rename plan', async () => {
	const store = memoryStore([
		{ path: '/notes/a.md', fileId: 'f-a' },
		{ path: '/x/重名.md', fileId: 'f-x' },
	]);
	store.listLinksToFile = async () => [{
		sourceFileId: 'f-a',
		sourceRevisionId: 'r-f-a',
		sourceEtag: '"r-f-a"',
		sourcePath: '/notes/a.md',
		kind: 'wiki',
		raw: '重名',
		targetPath: null,
		targetName: '重名',
		targetFileId: null,
		anchor: null,
		alias: null,
		status: 'ambiguous',
		candidateCount: 2,
		line: 3,
		column: 5,
	}];
	const plan = await planLinkRewrite(scopeFor(store), 'f-x', '/z/重名.md');
	assert.deepEqual(plan.affectedFiles, [], 'nothing may be rewritten from a guess');
	assert.equal(plan.editCount, 0);
});

test('external targets are recorded as external and carry no file identity', async () => {
	const store = memoryStore([{ path: '/notes/a.md', fileId: 'f-a' }]);
	for (const raw of ['https://example.com/x', 'mailto:a@example.com', '//cdn.example.com/y']) {
		const resolved = await resolveLink(scopeFor(store), 'f-a', raw, { kind: 'markdown', sourcePath: '/notes/a.md' });
		assert.equal(resolved.status, 'external', raw);
		assert.equal(resolved.targetFileId, null);
	}
});

test('a document-local anchor resolves to the source document itself', async () => {
	const store = memoryStore([{ path: '/notes/a.md', fileId: 'f-a' }]);
	const markdown = await resolveLink(scopeFor(store), 'f-a', '#intro', { kind: 'markdown', sourcePath: '/notes/a.md' });
	assert.equal(markdown.status, 'resolved');
	assert.equal(markdown.targetFileId, 'f-a');
	assert.equal(markdown.anchor, 'intro');
	const wiki = await resolveLink(scopeFor(store), 'f-a', '#intro', { kind: 'wiki', sourcePath: '/notes/a.md' });
	assert.equal(wiki.status, 'resolved');
	assert.equal(wiki.targetFileId, 'f-a');
});

test('a wiki target resolves through the stored file name, which carries its extension', async () => {
	// `[[笔记B]]` addresses `笔记B.md`: the link has no extension, the stored name does.
	const store = memoryStore([
		{ path: '/notes/a.md', fileId: 'f-a' },
		{ path: '/dir/笔记B.md', fileId: 'f-b' },
	]);
	const resolved = await resolveLink(scopeFor(store), 'f-a', '笔记B', { kind: 'wiki', sourcePath: '/notes/a.md' });
	assert.equal(resolved.status, 'resolved');
	assert.equal(resolved.targetFileId, 'f-b');
});

// ---------------------------------------------------------------------------------------
// K02: the index contains body references only
// ---------------------------------------------------------------------------------------

test('K02: a link inside a fenced code block is not indexed, the identical text in prose is', async () => {
	const store = memoryStore([
		{ path: '/notes/a.md', fileId: 'f-a' },
		{ path: '/dir/b.md', fileId: 'f-b' },
	]);
	const body = [
		'Prose links to [[b]] here.',
		'',
		'```',
		'[[b]]',
		'```',
		'',
		'Tail [[b]] again.',
	].join('\n');
	const described = await describeNoteIndex(scopeFor(store), {
		path: '/notes/a.md', fileId: 'f-a', revisionId: 'r-a', body,
	});
	assert.deepEqual(described.links.map(link => [link.line, link.column]), [[1, 16], [7, 6]]);
	assert.deepEqual(described.links.map(link => link.status), ['resolved', 'resolved']);
});

test('K02: inline code, indented code and HTML blocks do not produce links or tags', async () => {
	const store = memoryStore([{ path: '/notes/a.md', fileId: 'f-a' }]);
	const body = [
		'Inline `[[b]]` and `#tag` are code.',
		'',
		'    [[b]]',
		'    #tag',
		'',
		'<div>',
		'[[b]]',
		'#tag',
		'</div>',
		'',
		'Escaped \\[[b]] and \\#tag are literal.',
	].join('\n');
	const described = await describeNoteIndex(scopeFor(store), {
		path: '/notes/a.md', fileId: 'f-a', revisionId: 'r-a', body,
	});
	assert.deepEqual(described.links, []);
	assert.deepEqual(described.tags, []);
});

test('the index records the source revision, position and raw text of every link', async () => {
	const store = memoryStore([
		{ path: '/notes/a.md', fileId: 'f-a' },
		{ path: '/dir/b.md', fileId: 'f-b' },
	]);
	const body = 'See [B](../dir/b.md#锚点 "标题") and [[b#小节|别名]].\n';
	const described = await describeNoteIndex(scopeFor(store), {
		path: '/notes/a.md', fileId: 'f-a', revisionId: 'r-a', body,
	});
	assert.equal(described.revisionId, 'r-a');
	// `raw` is the destination as the author wrote it, anchor included; the title is not part of
	// the target and therefore not part of the stored raw text.
	assert.deepEqual(described.links.map(link => link.raw), ['../dir/b.md#锚点', 'b#小节|别名']);
	assert.deepEqual(described.links.map(link => link.anchor), ['锚点', '小节']);
	assert.deepEqual(described.links.map(link => link.alias), [null, '别名']);
	// Columns point at the opening marker of the link (`[` and `[[`), counted in code points.
	assert.deepEqual(described.links.map(link => [link.line, link.column]), [[1, 5], [1, 34]]);
});

test('tags keep their display text and are grouped case-insensitively', async () => {
	const store = memoryStore([{ path: '/notes/a.md', fileId: 'f-a' }]);
	const described = await describeNoteIndex(scopeFor(store), {
		path: '/notes/a.md', fileId: 'f-a', revisionId: 'r-a', body: '#API and #api and #项目/子项\n',
	});
	assert.deepEqual(described.tags.map(tag => tag.tag), ['API', 'api', '项目/子项']);
	assert.deepEqual(described.tags.map(tag => tag.tagKey), ['api', 'api', '项目/子项']);
	assert.equal(knowledgeTagKey('项目/子项'), '项目/子项');
});

// ---------------------------------------------------------------------------------------
// updateKnowledgeIndex: idempotence and revision tracking
// ---------------------------------------------------------------------------------------

function fakeBackend(bodies) {
	return {
		async openRead(path) {
			const body = Buffer.from(bodies[path] ?? '', 'utf8');
			return { stream: async () => Readable.from([body]), close: () => {} };
		},
		async openRevision(path, revisionId) {
			const body = Buffer.from(bodies[path + '@' + revisionId] ?? bodies[path] ?? '', 'utf8');
			return { stream: async () => Readable.from([body]), close: () => {} };
		},
	};
}

test('re-indexing the same revision is skipped, a new revision is parsed', async () => {
	const store = memoryStore([{ path: '/notes/a.md', fileId: 'f-a', revisionId: 'r-1' }]);
	const backend = fakeBackend({ '/notes/a.md@r-1': 'see [[b]]' });
	const scope = scopeFor(store, { backend });

	const first = await updateKnowledgeIndex(scope, 'f-a', { path: '/notes/a.md', revisionId: 'r-1' });
	assert.equal(first.indexed, true);
	assert.equal(first.linkCount, 1);

	const second = await updateKnowledgeIndex(scope, 'f-a', { path: '/notes/a.md', revisionId: 'r-1' });
	assert.equal(second.indexed, false);
	assert.equal(second.reason, 'current', 'an unchanged revision must not be re-parsed');

	store.rows.get('/notes/a.md').revision_id = 'r-2';
	const third = await updateKnowledgeIndex(scope, 'f-a', { path: '/notes/a.md', revisionId: 'r-2' });
	assert.equal(third.indexed, true, 'a new revision must be re-parsed');
	assert.equal(third.revisionId, 'r-2');
});

test('a file that no longer exists is reported instead of throwing', async () => {
	const store = memoryStore([]);
	const result = await updateKnowledgeIndex(scopeFor(store, { backend: fakeBackend({}) }), 'f-gone');
	assert.equal(result.indexed, false);
	assert.equal(result.reason, 'missing');
});

// ---------------------------------------------------------------------------------------
// Rename preview and the single-file rewrite
// ---------------------------------------------------------------------------------------

test('the rename preview reports every affected source document and keeps its syntax', async () => {
	const store = memoryStore([
		{ path: '/notes/a.md', fileId: 'f-a' },
		{ path: '/dir/b.md', fileId: 'f-b' },
	]);
	store.listLinksToFile = async () => [
		{
			sourceFileId: 'f-a', sourceRevisionId: 'r-a', sourceEtag: '"r-a"', sourcePath: '/notes/a.md',
			kind: 'markdown', raw: '../dir/b.md', targetPath: '/dir/b.md', targetName: 'b.md',
			targetFileId: 'f-b', anchor: null, alias: null, status: 'resolved', candidateCount: 1,
			line: 2, column: 5,
		},
		{
			sourceFileId: 'f-a', sourceRevisionId: 'r-a', sourceEtag: '"r-a"', sourcePath: '/notes/a.md',
			kind: 'wiki', raw: 'b', targetPath: '/dir/b.md', targetName: 'b.md',
			targetFileId: 'f-b', anchor: null, alias: null, status: 'resolved', candidateCount: 1,
			line: 2, column: 30,
		},
	];
	const plan = await planLinkRewrite(scopeFor(store), 'f-b', '/archive/c.md');
	assert.equal(plan.editCount, 2);
	assert.equal(plan.affectedFiles.length, 1);
	// /notes/a.md → /archive/c.md is one level up, and the wiki form drops the leading slash
	// and the extension (Obsidian addresses notes by name).
	assert.deepEqual(plan.affectedFiles[0].edits.map(edit => edit.replacement), ['../archive/c.md', 'archive/c']);
	assert.equal(plan.applicable, true, 'one source document can be rewritten in a single atomic write');
	assert.equal(plan.planId, (await planLinkRewrite(scopeFor(store), 'f-b', '/archive/c.md')).planId,
		'the same inputs must produce the same plan identity');
});

test('the rename preview names the atomicity limit when several notes link here', async () => {
	const store = memoryStore([
		{ path: '/notes/a.md', fileId: 'f-a' },
		{ path: '/notes/z.md', fileId: 'f-z' },
	]);
	const link = (sourceFileId, sourcePath) => ({
		sourceFileId, sourceRevisionId: 'r-' + sourceFileId, sourceEtag: '"r-' + sourceFileId + '"',
		sourcePath, kind: 'markdown', raw: '%E4%B8%AD.md', targetPath: '/dir/b.md',
		targetName: 'b.md', targetFileId: 'f-b', anchor: null, alias: null, status: 'resolved',
		candidateCount: 1, line: 1, column: 1,
	});
	store.listLinksToFile = async () => [link('f-a', '/notes/a.md'), link('f-z', '/notes/z.md')];
	const plan = await planLinkRewrite(scopeFor(store), 'f-b', '/d/c.md');
	assert.equal(plan.affectedFiles.length, 2);
	assert.equal(plan.applicable, false);
	assert.equal(plan.requiresAtomicRewrite, true);
	assert.match(plan.manual, /by hand/);
});

test('applyLinkRewrite refuses a plan whose source revision moved, and writes nothing', async () => {
	const store = memoryStore([
		{ path: '/notes/a.md', fileId: 'f-a', revisionId: 'r-a' },
		{ path: '/dir/b.md', fileId: 'f-b' },
	]);
	store.listLinksToFile = async () => [{
		sourceFileId: 'f-a', sourceRevisionId: 'r-a', sourceEtag: '"r-a"', sourcePath: '/notes/a.md',
		kind: 'markdown', raw: '../dir/b.md', targetPath: '/dir/b.md', targetName: 'b.md',
		targetFileId: 'f-b', anchor: null, alias: null, status: 'resolved', candidateCount: 1,
		line: 1, column: 5,
	}];
	const writes = [];
	const backend = {
		async openRead() { return { stream: async () => Readable.from([Buffer.from('x')]), close: () => {} }; },
		async writeFile(path) { writes.push(path); },
	};
	const scope = scopeFor(store, { backend });
	await assert.rejects(
		() => applyLinkRewrite(scope, {
			fileId: 'f-b',
			newPath: '/archive/c.md',
			expectedRevisions: [{ fileId: 'f-a', revisionId: 'r-old' }],
		}),
		error => error instanceof WorkspaceError && error.status === 409 && error.code === 'RewriteConflict',
	);
	assert.deepEqual(writes, [], 'a conflict must not overwrite anything');
});

test('applyLinkRewrite writes the single affected note when its revision still matches', async () => {
	const store = memoryStore([
		{ path: '/notes/a.md', fileId: 'f-a', revisionId: 'r-a' },
		{ path: '/dir/b.md', fileId: 'f-b' },
	]);
	store.listLinksToFile = async () => [{
		sourceFileId: 'f-a', sourceRevisionId: 'r-a', sourceEtag: '"r-a"', sourcePath: '/notes/a.md',
		kind: 'markdown', raw: '../dir/b.md', targetPath: '/dir/b.md', targetName: 'b.md',
		targetFileId: 'f-b', anchor: null, alias: null, status: 'resolved', candidateCount: 1,
		line: 2, column: 5,
	}];
	const body = 'Title\nSee [B](../dir/b.md) here.\n';
	const writes = [];
	const backend = {
		async openRead() { return { stream: async () => Readable.from([Buffer.from(body, 'utf8')]), close: () => {} }; },
		async writeFile(path, source, options) {
			const chunks = [];
			for await (const chunk of source) {
				chunks.push(Buffer.from(chunk));
			}
			writes.push({ path, text: Buffer.concat(chunks).toString('utf8'), options });
		},
	};
	const result = await applyLinkRewrite(scopeFor(store, { backend }), {
		fileId: 'f-b',
		newPath: '/archive/c.md',
		expectedRevisions: [{ fileId: 'f-a', revisionId: 'r-a' }],
	});
	assert.equal(result.wrote.length, 1);
	assert.equal(writes.length, 1);
	assert.equal(writes[0].path, '/notes/a.md');
	assert.equal(writes[0].text, 'Title\nSee [B](../archive/c.md) here.\n');
	assert.equal(writes[0].options.etag, '"r-a"', 'the write must carry the revision it was based on');
});

test('rewriteBody counts columns in code points and refuses a stale position', () => {
	const body = 'emoji 😀 then [B](../dir/b.md) tail';
	// The parser reports the opening `[` in code points, so the emoji counts as one column: 14.
	const parsed = parseKnowledge(body, '/notes/a.md');
	assert.deepEqual(parsed.links.map(link => [link.line, link.column]), [[1, 14]]);
	assert.equal(
		rewriteBody(body, [{ line: 1, column: 14, kind: 'markdown', raw: '../dir/b.md', replacement: 'x.md' }]),
		'emoji 😀 then [B](x.md) tail',
	);
	// One column to the right is not the link anymore: refuse rather than guess.
	assert.equal(
		rewriteBody(body, [{ line: 1, column: 15, kind: 'markdown', raw: '../dir/b.md', replacement: 'x.md' }]),
		null,
	);
});

// ---------------------------------------------------------------------------------------
// Request contract
// ---------------------------------------------------------------------------------------

test('the route table maps every documented endpoint to a capability', () => {
	assert.equal(capabilityForKnowledgeRequest('GET', '/api/knowledge/backlinks'), 'workspace.read');
	assert.equal(capabilityForKnowledgeRequest('GET', '/api/knowledge/tags'), 'workspace.read');
	assert.equal(capabilityForKnowledgeRequest('GET', '/api/knowledge/broken'), 'workspace.read');
	assert.equal(capabilityForKnowledgeRequest('POST', '/api/knowledge/rename-plan'), 'workspace.read');
	assert.equal(capabilityForKnowledgeRequest('POST', '/api/knowledge/rename-apply'), 'workspace.write');
	for (const path of Object.values(knowledgeRoutes)) {
		assert.ok(capabilityForKnowledgeRequest('GET', path) || capabilityForKnowledgeRequest('POST', path), path);
	}
});

test('an unknown knowledge route has no capability, so it cannot inherit a default read', () => {
	assert.equal(capabilityForKnowledgeRequest('GET', '/api/knowledge/nope'), undefined);
	assert.equal(capabilityForKnowledgeRequest('DELETE', '/api/knowledge/backlinks'), undefined);
	// A prefix match must not be enough: `/api/knowledge/backlinks/x` is not the endpoint.
	assert.equal(capabilityForKnowledgeRequest('GET', '/api/knowledge/backlinks/x'), undefined);
});

test('a page cursor is bound to its workspace and query kind', () => {
	const token = encodeKnowledgeCursor({ workspaceId: 'ws-a', kind: 'backlinks', path: '/a.md', order: [3, 7] });
	assert.deepEqual(decodeKnowledgeCursor(token, { workspaceId: 'ws-a', kind: 'backlinks' }), { path: '/a.md', order: [3, 7] });
	for (const attempt of [
		() => decodeKnowledgeCursor(token, { workspaceId: 'ws-b', kind: 'backlinks' }),
		() => decodeKnowledgeCursor(token, { workspaceId: 'ws-a', kind: 'broken' }),
		() => decodeKnowledgeCursor('not-a-cursor', { workspaceId: 'ws-a', kind: 'backlinks' }),
		() => decodeKnowledgeCursor('', { workspaceId: 'ws-a', kind: 'backlinks' }),
	]) {
		assert.throws(attempt, error => error instanceof WorkspaceError && error.status === 400 && error.code === 'InvalidCursor');
	}
});

test('a page size outside the allowed range is a 400, not a silent default', () => {
	assert.equal(knowledgePageSize(undefined), 50);
	assert.equal(knowledgePageSize('10'), 10);
	assert.equal(knowledgePageSize('100000'), 200);
	for (const value of ['0', '-1', 'abc', '1.5']) {
		assert.throws(
			() => knowledgePageSize(value),
			error => error instanceof WorkspaceError && error.status === 400 && error.code === 'InvalidPageSize',
			value,
		);
	}
});

test('every knowledge server module is copied into the web release', async () => {
	// build-web-release.mjs copies a hand-written list of server files. A module that is
	// imported but missing from that list only fails at release time, in production, when the
	// release server boots outside its source checkout — so the list is checked here instead.
	const { readFile, readdir } = await import('node:fs/promises');
	const build = await readFile(new URL('./build-web-release.mjs', import.meta.url), 'utf8');
	const start = build.indexOf('const serverFiles = [');
	const end = build.indexOf('];', start);
	assert.ok(start > 0 && end > start, 'build-web-release.mjs must declare serverFiles');
	const listed = new Set([...build.slice(start, end).matchAll(/'([^']+)'/g)].map(match => match[1]));
	const files = await readdir(new URL('.', import.meta.url));
	const knowledge = files.filter(name => /^knowledge-[\w-]+\.(mjs|sql)$/.test(name));
	assert.ok(knowledge.length >= 5, 'expected the knowledge modules next to the build script');
	for (const name of knowledge) {
		assert.ok(listed.has(name), name + ' must be listed in build-web-release.mjs serverFiles');
	}
});
