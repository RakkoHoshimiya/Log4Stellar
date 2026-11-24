import assert from 'node:assert/strict';
import { test } from 'node:test';
import { searchLimits } from './search-contract.mjs';
import { extractMarkdown, locateHit, matchFromRow, utf16Length } from './search-indexer.mjs';

// The pure half of the index worker: extraction, hit location and excerpt building.
// These functions decide what a result row looks like, so they are the ones that have to
// prove the line/column contract and that nothing is ever rendered as markup.

const bytesOf = value => Buffer.from(value, 'utf8');

function row({ path = '/notes/plan.md', title = '', body = '', bodyPos = 0, titlePos = 0, pathPos = 0, windowStart = 1, linesBefore = 0, revisionId = 'a'.repeat(36) } = {}) {
	return {
		fileId: 'b'.repeat(36),
		revisionId,
		path,
		indexedMs: 1,
		pathPos,
		titlePos,
		bodyPos,
		windowStart,
		windowText: body,
		linesBefore,
	};
}

// ------------------------------------------------------------------ extraction

test('the first heading becomes the title and the raw Markdown stays intact', () => {
	const extracted = extractMarkdown(bytesOf('# 发布计划\n\n今天是 release day。\n\n## 细节\n- 一\n'));
	assert.equal(extracted.title, '发布计划');
	assert.match(extracted.body, /## 细节/);
	assert.equal(extracted.truncated, false);
	// The body keeps the heading text, so a hit in the body is still findable.
	assert.match(extracted.body, /发布计划/);
});

test('heading markup and closing hashes are stripped from the title only', () => {
	assert.equal(extractMarkdown(bytesOf('### **Launch** `plan` ##\nbody')).title, 'Launch plan');
	assert.equal(extractMarkdown(bytesOf('   ## indented\nx')).title, 'indented');
	// Four spaces is a code block, not a heading.
	assert.equal(extractMarkdown(bytesOf('    # not a heading\nx')).title, '');
	assert.equal(extractMarkdown(bytesOf('plain text with no heading')).title, '');
});

test('windows line endings and NUL bytes are normalized before indexing', () => {
	const extracted = extractMarkdown(bytesOf('# Plan\r\nbody\rmore\u0000tail'));
	assert.equal(extracted.title, 'Plan');
	assert.equal(extracted.body, '# Plan\nbody\nmoretail');
	// A carriage return left in the text would break the line count of a hit.
	assert.doesNotMatch(extracted.body, /\r/);
});

test('a byte cap cuts between characters instead of producing a broken tail', () => {
	// Each Chinese character is 3 bytes, so a 10-byte cap lands inside the fourth one and
	// only the three complete characters survive.
	const extracted = extractMarkdown(bytesOf('发布计划发布计划'), { maxBytes: 10 });
	assert.equal(extracted.truncated, true);
	assert.equal(extracted.body, '发布计');
	// No replacement character is produced, so the indexed text stays clean.
	assert.doesNotMatch(extracted.body, /\uFFFD/);
});

test('a character cap bounds the stored body and is reported as truncated', () => {
	const extracted = extractMarkdown(bytesOf('x'.repeat(50)), { maxChars: 10 });
	assert.equal(extracted.body.length, 10);
	assert.equal(extracted.truncated, true);
	const exact = extractMarkdown(bytesOf('x'.repeat(10)), { maxChars: 10 });
	assert.equal(exact.truncated, false);
});

test('the default caps are the documented limits', () => {
	const long = 'y'.repeat(searchLimits.maxBodyChars + 100);
	const extracted = extractMarkdown(bytesOf(long));
	assert.equal(extracted.body.length, searchLimits.maxBodyChars);
	assert.equal(extracted.truncated, true);
});

test('an empty note yields an empty document rather than throwing', () => {
	for (const input of [Buffer.alloc(0), undefined, null]) {
		const extracted = extractMarkdown(input);
		assert.deepEqual(extracted, { title: '', body: '', truncated: false });
	}
});

// ------------------------------------------------------------------ hit location

test('a hit is reported with a 1-based line and column', () => {
	const windowText = 'first\nsecond\n发布计划 here';
	// matchPos 15 is the second character of the third line, so the column is 2.
	const located = locateHit({ windowText, windowStart: 1, matchPos: 15 });
	assert.equal(located.newlineCount, 2);
	assert.equal(located.column, 2);
	assert.equal(located.offsetInWindow, 14);
});

test('a column counts UTF-16 units, not bytes', () => {
	// "发布" is two characters and six UTF-8 bytes; a byte-based column would say 7.
	const located = locateHit({ windowText: '发布计划', windowStart: 1, matchPos: 3 });
	assert.equal(located.column, 3);
	assert.equal(utf16Length('a发布'), 3);
	// An astral character is two UTF-16 units, which is what an editor reports.
	assert.equal(utf16Length('🙂'), 2);
});

// ------------------------------------------------------------------ result rows

test('a body hit points at the matching line and keeps the excerpt as text', () => {
	const result = matchFromRow(row({
		body: 'line one\nline two 发布计划 line three',
		bodyPos: 19,
		linesBefore: 0,
	}), '发布计划');
	assert.equal(result.match, 'body');
	assert.equal(result.line, 2);
	assert.equal(result.column, 10);
	assert.match(result.excerpt, /发布计划/);
	// The excerpt is a single line of plain text.
	assert.doesNotMatch(result.excerpt, /\n/);
	assert.equal(result.excerpt.slice(result.excerptOffset, result.excerptOffset + result.excerptLength), '发布计划');
});

test('a title hit wins over a body hit and previews from the start of the body', () => {
	const result = matchFromRow(row({
		title: '发布计划',
		titlePos: 1,
		body: '发布计划 is the heading\nbody text',
		bodyPos: 1,
	}), '发布计划');
	assert.equal(result.match, 'title');
	assert.equal(result.line, 1);
	assert.equal(result.excerptOffset, 0);
});

test('a path-only hit is reported as a path match', () => {
	const result = matchFromRow(row({ path: '/notes/发布计划.md', pathPos: 8, body: 'unrelated text' }), '发布计划');
	assert.equal(result.match, 'path');
	assert.equal(result.path, '/notes/发布计划.md');
	// There is no body hit to point at, so the highlight inside the preview is empty
	// rather than wrong.
	assert.equal(result.excerptLength, 0);
});

test('a match inside HTML is passed through as text and never as markup', () => {
	const body = '<img src=x onerror=alert(1)> 发布计划';
	const result = matchFromRow(row({ body, bodyPos: body.indexOf('发布计划') + 1 }), '发布计划');
	// The caller renders this as a preview string; the extension turns it into a Range,
	// so an injection would have to survive being plain text.
	assert.equal(typeof result.excerpt, 'string');
	assert.match(result.excerpt, /<img src=x onerror=alert\(1\)>/);
	assert.equal(result.excerpt.slice(result.excerptOffset, result.excerptOffset + result.excerptLength), '发布计划');
	// No field of the result is HTML: every one of them is data.
	assert.doesNotMatch(JSON.stringify({ ...result, excerpt: '' }), /</);
});

test('the excerpt is trimmed and shortened around a hit far into a long note', () => {
	const body = 'a'.repeat(1000) + 'needle' + 'b'.repeat(1000);
	const windowStart = 1001 - 400 > 1 ? 1001 - 400 : 1;
	const result = matchFromRow(row({
		body: body.slice(windowStart - 1, windowStart - 1 + 800),
		bodyPos: 1001,
		windowStart,
	}), 'needle');
	assert.ok(result.excerpt.length <= searchLimits.maxExcerptChars);
	assert.match(result.excerpt, /needle/);
	assert.equal(result.excerpt.slice(result.excerptOffset, result.excerptOffset + result.excerptLength), 'needle');
});

test('a case-insensitive match still highlights the original casing', () => {
	const result = matchFromRow(row({ body: 'The Launch Plan', bodyPos: 5 }), 'launch');
	assert.equal(result.match, 'body');
	assert.equal(result.excerpt.slice(result.excerptOffset, result.excerptOffset + result.excerptLength), 'Launch');
});

test('the revision id of the row is reported so the client can spot a newer file', () => {
	const revisionId = 'c'.repeat(36);
	const result = matchFromRow(row({ revisionId, body: 'plan', bodyPos: 1 }), 'plan');
	assert.equal(result.revisionId, revisionId);
	assert.equal(result.fileId, 'b'.repeat(36));
});
