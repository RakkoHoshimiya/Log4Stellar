import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	describeTarget,
	knowledgeParserVersion,
	linkKinds,
	linkStatuses,
	normalizeKnowledgePath,
	parseKnowledge,
} from './knowledge-parser.mjs';

// The parser is the only place that decides what counts as a link or a tag, and the acceptance
// criterion K02 ("the same text in a code block and in the body") is exactly the case where a
// regular expression over the raw text would be wrong. These tests therefore spend most of their
// weight on the *negatives*: fenced code, indented code, code spans, HTML blocks, autolinks,
// escapes and URL fragments.

function links(markdown, sourcePath = '/notes/index.md') {
	return parseKnowledge(markdown, sourcePath).links;
}

function tags(markdown, sourcePath = '/notes/index.md') {
	return parseKnowledge(markdown, sourcePath).tags;
}

function summary(markdown, sourcePath) {
	return parseKnowledge(markdown, sourcePath).links.map(link => ({
		kind: link.kind,
		raw: link.raw,
		targetPath: link.targetPath,
		targetName: link.targetName,
		anchor: link.anchor,
		alias: link.alias,
		external: link.external,
		line: link.line,
		column: link.column,
	}));
}

test('the exported vocabulary matches the documented link kinds and statuses', () => {
	assert.deepEqual([...linkKinds], ['markdown', 'wiki']);
	assert.deepEqual([...linkStatuses], ['resolved', 'missing', 'ambiguous', 'external']);
	assert.equal(knowledgeParserVersion, 1);
});

// ---------------------------------------------------------------------------------------
// K02 — a fenced code block is not body text
// ---------------------------------------------------------------------------------------

test('K02: a wiki link that only appears inside a fenced code block is not indexed', () => {
	const markdown = [
		'# 索引',
		'',
		'```text',
		'[[代码块里的链接]]',
		'#代码块里的标签',
		'[代码块里的标准链接](../nowhere.md)',
		'```',
		'',
		'正文只引用 [[真实链接]]。',
	].join('\n');
	const found = links(markdown);
	assert.deepEqual(found.map(link => link.raw), ['真实链接']);
	assert.deepEqual(found.map(link => link.line), [9]);
	assert.deepEqual(tags(markdown).map(tag => tag.tag), []);
});

test('K02: a tilde fence, an info string and a longer closing fence all behave', () => {
	const markdown = [
		'~~~md title="故意"',
		'[[fence内]] #fence标签',
		'~~~~',
		'',
		'[[fence之后]]',
	].join('\n');
	assert.deepEqual(links(markdown).map(link => link.raw), ['fence之后']);
});

test('K02: an unclosed fence swallows the rest of the document instead of leaking links', () => {
	const markdown = ['# t', '', '```', '[[未闭合]]', '', '仍然在代码块内 [[也不行]]'].join('\n');
	assert.deepEqual(links(markdown), []);
});

test('K02: an indented code block is not body text', () => {
	const markdown = [
		'段落开始。',
		'',
		'    [[缩进代码]] #缩进标签',
		'    [x](../y.md)',
		'',
		'段落结束 [[正文]]。',
	].join('\n');
	assert.deepEqual(links(markdown).map(link => link.raw), ['正文']);
	assert.deepEqual(tags(markdown), []);
});

test('K02: a four-space indented line directly after a paragraph is a lazy continuation, not code', () => {
	// CommonMark §4.4: indented code cannot interrupt a paragraph, so this line is still text.
	const markdown = ['段落第一行', '    [[延续行]]'].join('\n');
	assert.deepEqual(links(markdown).map(link => link.raw), ['延续行']);
});

test('K02: the same text in a code block and in the body yields exactly one entry, in the body', () => {
	const markdown = [
		'`[[重复]]` 是正文里的行内代码。',
		'',
		'```',
		'[[重复]]',
		'```',
		'',
		'正文里真正链接 [[重复]]。',
	].join('\n');
	const found = links(markdown);
	// The code span on line 1 is not a link either, so exactly one entry survives, on line 7.
	assert.equal(found.length, 1);
	assert.equal(found[0].line, 7);
	assert.equal(found[0].column, 9);
});

test('K02: the reported line and column point at the link in the original text', () => {
	const markdown = ['第一行', '第二行 [[目标]] 结尾'].join('\n');
	const [link] = links(markdown);
	assert.equal(link.line, 2);
	// `第二行 ` is four code points, so the `[` sits at column 5.
	assert.equal(link.column, 5);
	// Column counts code points, not UTF-16 units: an emoji ahead of the link is one column.
	const emoji = ['🎉 [[目标]]'].join('\n');
	assert.equal(links(emoji)[0].column, 3);
});

// ---------------------------------------------------------------------------------------
// K02 — inline constructs that hide text
// ---------------------------------------------------------------------------------------

test('K02: a code span hides wiki links, tags and standard links', () => {
	const markdown = '行内 `[[不是链接]] #不是标签 [x](../y.md)` 之后 [[是链接]]';
	const found = links(markdown);
	assert.deepEqual(found.map(link => link.raw), ['是链接']);
	assert.deepEqual(tags(markdown).map(tag => tag.tag), []);
});

test('K02: a double-backtick code span that contains a single backtick is one span', () => {
	const markdown = 'a ``code with ` tick [[hidden]]`` b [[shown]]';
	assert.deepEqual(links(markdown).map(link => link.raw), ['shown']);
});

test('K02: an HTML block hides everything until the next blank line', () => {
	const markdown = [
		'<div class="x">',
		'[[html里的链接]] #html标签',
		'</div>',
		'',
		'[[html之后]]',
	].join('\n');
	assert.deepEqual(links(markdown).map(link => link.raw), ['html之后']);
	assert.deepEqual(tags(markdown), []);
});

test('K02: a comment HTML block ends at the closing marker, not at the blank line', () => {
	const markdown = ['<!-- [[注释里]] -->', '', '[[注释之后]]'].join('\n');
	assert.deepEqual(links(markdown).map(link => link.raw), ['注释之后']);
});

test('K02: a script element is opaque even with blank lines inside it', () => {
	const markdown = ['<script>', '[[脚本一]]', '', '[[脚本二]]', '</script>', '', '[[脚本之后]]'].join('\n');
	assert.deepEqual(links(markdown).map(link => link.raw), ['脚本之后']);
});

test('K02: inline HTML tags are opaque but the surrounding text is not', () => {
	const markdown = '前 <span title="[[属性里]]">[[标签之后]]</span> 后 [[正文]]';
	assert.deepEqual(links(markdown).map(link => link.raw), ['标签之后', '正文']);
});

test('K02: a backslash escape disables a wiki link, a tag and a bracket link', () => {
	const markdown = '\\[[转义链接]] \\#转义标签 \\[x](../y.md) 但 [[正常]]';
	assert.deepEqual(links(markdown).map(link => link.raw), ['正常']);
	assert.deepEqual(tags(markdown), []);
});

test('K02: an autolink and a bare URL never produce tags from their fragment', () => {
	const markdown = '看 <https://example.com/a#section> 与 https://example.com/b#other';
	assert.deepEqual(tags(markdown), []);
	assert.deepEqual(links(markdown), []);
});

test('K02: an image is not a knowledge link but its alt text is still body text', () => {
	const markdown = '![截图 #标签](../img/a.png) 后面 [[正文]]';
	assert.deepEqual(links(markdown).map(link => link.raw), ['正文']);
	assert.deepEqual(tags(markdown).map(tag => tag.tag), ['标签']);
});

// ---------------------------------------------------------------------------------------
// K02 — the positive shapes
// ---------------------------------------------------------------------------------------

test('a standard relative Markdown link keeps its raw text, resolved path and anchor', () => {
	const found = links('[标题](../a.md#锚点)');
	assert.equal(found.length, 1);
	assert.equal(found[0].kind, 'markdown');
	assert.equal(found[0].raw, '../a.md#锚点');
	assert.equal(found[0].targetPath, '/a.md');
	assert.equal(found[0].anchor, '锚点');
	assert.equal(found[0].external, false);
});

test('a Markdown link may carry a title, angle brackets and a nested parenthesis', () => {
	assert.deepEqual(links('[a](../dir/b.md "标题")').map(link => link.targetPath), ['/dir/b.md']);
	assert.deepEqual(links('[a](<../dir/c d.md>)').map(link => link.targetPath), ['/dir/c d.md']);
	assert.deepEqual(links('[a](../dir/e(f).md)').map(link => link.targetPath), ['/dir/e(f).md']);
});

test('a percent-encoded and non-ASCII destination is decoded for the resolved path only', () => {
	// A space ends a bare destination, so a path with spaces must be wrapped in angle brackets
	// (CommonMark §6.3); both spellings still decode to the same workspace path.
	const found = links('[a](../%E7%AC%94%E8%AE%B0/%E4%B8%AD%E6%96%87.md) and [b](<../笔记/空格 名.md>)');
	assert.deepEqual(found.map(link => link.targetPath), ['/笔记/中文.md', '/笔记/空格 名.md']);
	assert.deepEqual(found.map(link => link.raw), [
		'../%E7%AC%94%E8%AE%B0/%E4%B8%AD%E6%96%87.md',
		'../笔记/空格 名.md',
	]);
});

test('an absolute workspace link and a document-local anchor are both recognised', () => {
	const found = links('[x](/notes/a.md) [y](#本页小节)');
	assert.equal(found[0].targetPath, '/notes/a.md');
	assert.equal(found[1].targetPath, '/notes/index.md');
	assert.equal(found[1].anchor, '本页小节');
	assert.equal(found[1].self, true);
});

test('external destinations are recorded as external and never resolved', () => {
	const found = links('[a](https://example.com/x) [b](mailto:someone@example.com) [c](//cdn/x)');
	assert.deepEqual(found.map(link => link.external), [true, true, true]);
	assert.deepEqual(found.map(link => link.targetPath), [null, null, null]);
});

test('an Obsidian wiki link carries its anchor and alias', () => {
	const found = links('[[文件]] [[文件#标题|别名]] [[#只锚点]] [[目录/文件]] [[文件.md]]');
	assert.deepEqual(found.map(link => link.targetName), ['文件', '文件', null, '文件', '文件.md']);
	assert.deepEqual(found.map(link => link.anchor), [null, '标题', '只锚点', null, null]);
	assert.deepEqual(found.map(link => link.alias), [null, '别名', null, null, null]);
	assert.deepEqual(found.map(link => link.kind), ['wiki', 'wiki', 'wiki', 'wiki', 'wiki']);
	assert.equal(found[2].self, true);
	// A wiki target with slashes is vault-relative, so it is not resolved against the source
	// directory the way a Markdown destination is.
	assert.equal(found[3].targetPath, '/目录/文件');
	assert.equal(found[3].targetName, '文件');
});

test('a document-local wiki anchor resolves to the document itself', () => {
	const [link] = links('[[#小节]]');
	assert.equal(link.self, true);
	assert.equal(link.targetPath, '/notes/index.md');
	assert.equal(link.anchor, '小节');
});

test('wiki links respect the surrounding text: not inside words, but after punctuation', () => {
	assert.deepEqual(links('文字[[紧邻]]文字').map(link => link.raw), ['紧邻']);
	assert.deepEqual(links('（[[括号内]]）').map(link => link.raw), ['括号内']);
});

// ---------------------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------------------

test('body tags are extracted with their position, excluding pure numbers and URL fragments', () => {
	const markdown = ['标签 #项目/子项 与 #中文标签 但不是 #12345 也不是 URL 片段 x#frag'].join('\n');
	assert.deepEqual(tags(markdown).map(tag => tag.tag), ['项目/子项', '中文标签']);
	assert.deepEqual(tags(markdown).map(tag => tag.column), [4, 13]);
});

test('a tag inside a heading, list item or block quote is still body text', () => {
	const markdown = ['# 标题 #标题标签', '', '- 项目 #列表标签', '', '> 引用 #引用标签'].join('\n');
	assert.deepEqual(tags(markdown).map(tag => tag.tag), ['标题标签', '列表标签', '引用标签']);
});

test('a tag must start at a boundary and stops at punctuation', () => {
	assert.deepEqual(tags('a#inline 不是标签').map(tag => tag.tag), []);
	assert.deepEqual(tags('#标签，后面').map(tag => tag.tag), ['标签']);
});

test('URL fragments in standard Markdown destinations are not tags', () => {
	const markdown = '[标题](../a.md#锚点) 与 [外链](https://x.y/z#frag)';
	assert.deepEqual(tags(markdown), []);
});

// ---------------------------------------------------------------------------------------
// Front matter, headings and damaged input
// ---------------------------------------------------------------------------------------

test('YAML front matter is skipped and does not shift the reported line numbers', () => {
	const markdown = ['---', 'tags: [alpha]', 'title: 标题 #不是正文标签', '---', '', '正文 #真正标签'].join('\n');
	const result = parseKnowledge(markdown, '/notes/index.md');
	assert.equal(result.frontMatter, true);
	assert.deepEqual(result.tags.map(tag => tag.tag), ['真正标签']);
	assert.deepEqual(result.tags.map(tag => tag.line), [6]);
});

test('a thematic break followed by another is not mistaken for front matter', () => {
	const markdown = ['---', '', '正文 #标签', '', '---'].join('\n');
	const result = parseKnowledge(markdown, '/notes/index.md');
	assert.equal(result.frontMatter, false);
	assert.deepEqual(result.tags.map(tag => tag.tag), ['标签']);
});

test('setext heading underlines and table delimiter rows are not content', () => {
	const markdown = ['标题 [[链接一]]', '===', '', '| 列 | 列 |', '| --- | --- |', '| [[单元格]] | #表格标签 |'].join('\n');
	assert.deepEqual(links(markdown).map(link => link.raw), ['链接一', '单元格']);
	assert.deepEqual(tags(markdown).map(tag => tag.tag), ['表格标签']);
});

test('damaged Markdown does not throw and never invents links', () => {
	const samples = [
		'[[未闭合',
		'[未闭合](',
		'[a](b',
		'`未闭合的行内代码 [[x]]',
		'[[]]',
		'[[|]]',
		'[[#]]',
		']] [[',
		'[嵌套 [方括号] 文本](../a.md)',
	];
	for (const sample of samples) {
		const result = parseKnowledge(sample, '/notes/index.md');
		assert.ok(Array.isArray(result.links));
		assert.ok(Array.isArray(result.tags));
	}
	assert.deepEqual(links('[[未闭合').map(link => link.raw), []);
	assert.deepEqual(links('[[]]'), []);
	assert.deepEqual(links('[[#]]'), []);
});

test('CRLF and CR line endings report the same positions as LF', () => {
	const markdown = '第一行\r\n第二行 [[链接]]\r\n\r\n#标签\r\n';
	const found = links(markdown);
	assert.equal(found[0].line, 2);
	assert.equal(found[0].column, 5);
	assert.deepEqual(tags(markdown).map(tag => tag.tag), ['标签']);
});

test('a circular pair of documents is parsed symmetrically', () => {
	const a = parseKnowledge('指向 [[b]]', '/notes/a.md');
	const b = parseKnowledge('指向 [[a]]', '/notes/b.md');
	assert.equal(a.links[0].targetName, 'b');
	assert.equal(b.links[0].targetName, 'a');
});

test('parseKnowledge() rejects a non-string document instead of coercing it', () => {
	assert.throws(() => parseKnowledge(undefined), TypeError);
	assert.throws(() => parseKnowledge(Buffer.from('x')), TypeError);
});

// ---------------------------------------------------------------------------------------
// Target descriptors and path normalisation
// ---------------------------------------------------------------------------------------

test('normalizeKnowledgePath() folds dot segments, separators and duplicate slashes', () => {
	assert.equal(normalizeKnowledgePath('a/b/../c'), '/a/c');
	assert.equal(normalizeKnowledgePath('/a//b/./c/'), '/a/b/c');
	assert.equal(normalizeKnowledgePath('\\\\a\\b'), '/a/b');
	assert.equal(normalizeKnowledgePath('../..'), '/');
	assert.equal(normalizeKnowledgePath(''), '/');
});

test('describeTarget() keeps the raw text beside the interpretation', () => {
	const wiki = describeTarget('笔记#章节|别名', { kind: 'wiki', sourcePath: '/notes/a.md' });
	assert.deepEqual(
		{ raw: wiki.raw, targetName: wiki.targetName, anchor: wiki.anchor, alias: wiki.alias },
		{ raw: '笔记#章节|别名', targetName: '笔记', anchor: '章节', alias: '别名' },
	);
	const relative = describeTarget('../b.md', { kind: 'markdown', sourcePath: '/notes/deep/a.md' });
	assert.equal(relative.targetPath, '/notes/b.md');
	assert.equal(relative.raw, '../b.md');
	assert.throws(() => describeTarget(7), TypeError);
});
