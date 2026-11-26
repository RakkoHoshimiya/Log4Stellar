import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Readable } from 'node:stream';
import { createSearchGate, extractSearchText } from './extended-search.mjs';
import { extendedSearchPage } from './extended-search-page.mjs';

test('a short burst waits in admission order and excessive backlog is capped', async () => {
	const run = createSearchGate({ concurrency: 1, capacity: 2 });
	const completed = [];
	let resume;
	const first = run(() => new Promise(resolve => { resume = resolve; }));
	const second = run(() => completed.push(2));
	const third = run(() => completed.push(3));
	await assert.rejects(run(() => {}), { code: 'SearchBusy' });
	resume();
	await Promise.all([first, second, third]);
	assert.deepEqual(completed, [2, 3]);
});

test('expired admissions do not consume slots after the current search ends', async () => {
	const run = createSearchGate({ concurrency: 1, capacity: 1, waitMs: 10 });
	let resume;
	const first = run(() => new Promise(resolve => { resume = resolve; }));
	await assert.rejects(run(() => assert.fail('expired ticket executed')), { code: 'SearchBusy' });
	resume();
	await first;
	assert.equal(await run(() => 42), 42);
});

test('the extended search page localizes status and labels in supported languages', () => {
	for (const locale of ['en', 'zh-cn', 'zh-tw', 'ja']) {
		const html = extendedSearchPage({ locale, workspaceId: 'workspace-id' });
		assert.ok(html.includes('lang="' + locale + '"'));
		assert.match(html, /data-status=/);
	}
});

test('legacy format reader requires a configured sandbox before opening a stream', async () => {
	await assert.rejects(extractSearchText('doc', { size: 2, stream: () => assert.fail('unexpected read') }),
		{ code: 'SearchFormatUnavailable' });
	const text = await extractSearchText('md', { size: 4, stream: () => Readable.from([Buffer.from('note')]) });
	assert.equal(text, 'note');
});
