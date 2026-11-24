// Markdown knowledge extraction: outgoing links and inline tags, with exact line/column positions.
//
// This is deliberately a *scanner over the block structure* and an inline tokenizer on top of
// it, not a pile of regular expressions over the raw text: the acceptance criteria for the
// knowledge index (docs/knowledge-links.md, "K02") are precisely the cases where a regex lies —
// a `[[wiki link]]` or a `#tag` inside a fenced block, an indented code block, a code span, an
// HTML block, or behind a backslash escape is not a link or a tag, and a `#fragment` at the end
// of a URL is not a tag either.
//
// The repository ships no Markdown parser in the server dependency graph (apps/web/package.json
// is pinned by the release lockfile), so this module implements the CommonMark block structure it
// needs — fenced code, indented code, HTML blocks, block quotes, list items, ATX/setext headings,
// thematic breaks, paragraphs — instead of adding a dependency.
//
// Everything here is pure: no I/O, no database, no clock. `parseKnowledge()` is safe to call in
// unit tests and from the indexer, and it never rewrites its input.
//
// Positions are 1-based, `line` counts document lines, `column` counts *Unicode code points* from
// the start of the line (so an emoji or a CJK character is one column, matching what an editor
// shows), and both are measured on the original text including any block quote or list marker.

export const linkKinds = Object.freeze(['markdown', 'wiki']);
export const linkStatuses = Object.freeze(['resolved', 'missing', 'ambiguous', 'external']);

/** Bumped when the extraction semantics change; the indexer stores it to detect stale rows. */
export const knowledgeParserVersion = 1;

const asciiPunctuation = new Set('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'.split(''));

// CommonMark §6.6: the HTML block start condition "type 6" tag names. A line that begins with one
// of these opens an HTML block that runs until the next blank line.
const blockHtmlTags = new Set([
	'address', 'article', 'aside', 'base', 'basefont', 'blockquote', 'body', 'caption', 'center',
	'col', 'colgroup', 'dd', 'details', 'dialog', 'dir', 'div', 'dl', 'dt', 'fieldset',
	'figcaption', 'figure', 'footer', 'form', 'frame', 'frameset', 'h1', 'h2', 'h3', 'h4', 'h5',
	'h6', 'head', 'header', 'hr', 'html', 'iframe', 'legend', 'li', 'link', 'main', 'menu',
	'menuitem', 'nav', 'noframes', 'ol', 'optgroup', 'option', 'p', 'param', 'search', 'section',
	'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'title', 'tr', 'track', 'ul',
]);

// CommonMark §6.6 "type 1": these raw-text elements run until their own closing tag.
const rawTextHtmlTags = new Set(['script', 'pre', 'style', 'textarea']);

const tabWidth = 4;

function codePointLength(text, start = 0, end = text.length) {
	let count = 0;
	for (let index = start; index < end; index++) {
		const code = text.charCodeAt(index);
		// A surrogate pair is one code point (and therefore one column).
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = text.charCodeAt(index + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				index++;
			}
		}
		count++;
	}
	return count;
}

/** Leading indentation of `text`, with a tab counted as four columns. */
function indentWidth(text) {
	let width = 0;
	for (const character of text) {
		if (character === ' ') {
			width++;
		} else if (character === '\t') {
			width += tabWidth - (width % tabWidth);
		} else {
			break;
		}
	}
	return width;
}

function isBlank(line) {
	return line.trim() === '';
}

/**
 * Strips the block quote markers of one line, reporting how many code points were removed so the
 * inline positions stay anchored to the original text.
 */
function stripBlockQuote(line) {
	let text = line;
	let offset = 0;
	for (;;) {
		const match = /^( {0,3})>( ?)/.exec(text);
		if (!match) {
			return { text, offset };
		}
		const consumed = match[1].length + 1 + match[2].length;
		text = text.slice(consumed);
		offset += consumed;
	}
}

/** A list item marker at the start of `text`, e.g. `- `, `* `, `12. `, `3) `. */
function matchListMarker(text) {
	const match = /^( {0,3})([-+*]|\d{1,9}[.)])( +)/.exec(text);
	if (!match) {
		return null;
	}
	return { indent: match[1].length, markerWidth: match[2].length, spaces: match[3].length };
}

function matchFence(text) {
	const match = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(text);
	if (!match) {
		return null;
	}
	const marker = match[2];
	const info = match[3];
	// A backtick fence may not carry a backtick in its info string (CommonMark §4.5).
	if (marker[0] === '`' && info.includes('`')) {
		return null;
	}
	return { width: match[1].length, marker, info: info.trim() };
}

function matchThematicBreak(text) {
	return /^ {0,3}((?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/.test(text);
}

function matchSetextUnderline(text) {
	return /^ {0,3}(?:=+|-+)[ \t]*$/.test(text);
}

function matchAtxHeading(text) {
	const match = /^( {0,3})(#{1,6})(?=[ \t]|$)(.*)$/.exec(text);
	if (!match) {
		return null;
	}
	let body = match[3];
	// Trailing closing sequence: `## title ##` — the closing hashes are not content.
	const closing = /[ \t]+#+[ \t]*$/.exec(body);
	if (closing) {
		body = body.slice(0, closing.index);
	}
	const leading = (body.length - body.replace(/^[ \t]*/, '').length);
	return { offset: match[1].length + match[2].length + leading, text: body.trim() };
}

function matchHtmlBlockStart(text) {
	const match = /^( {0,3})<(!--|\?|!\[CDATA\[|\/?([A-Za-z][A-Za-z0-9-]*))/i.exec(text);
	if (!match) {
		return null;
	}
	const marker = match[2];
	if (marker === '!--') {
		return { kind: 'comment', end: '-->' };
	}
	if (marker === '?' || marker === '![') {
		return { kind: 'blank' };
	}
	const name = (match[3] ?? '').toLowerCase();
	if (rawTextHtmlTags.has(name)) {
		return { kind: 'raw', end: '</' + name };
	}
	if (blockHtmlTags.has(name)) {
		return { kind: 'blank' };
	}
	return null;
}

function isTableDelimiterRow(text) {
	return /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/.test(text) && text.includes('|');
}

/**
 * Splits the document into text blocks (runs of lines that are body text, one block per
 * paragraph/heading/list item) while dropping everything that must never contribute links:
 * fenced and indented code, HTML blocks, front matter, thematic breaks and table delimiter rows.
 */
function scanBlockText(sourceLines) {
	const blocks = [];
	let paragraph = null;
	let listIndent = null;
	let fence;
	let html;
	let index = 0;

	function flush() {
		if (paragraph && paragraph.lines.length) {
			blocks.push(paragraph);
		}
		paragraph = null;
	}

	function appendText(text, offset, lineNumber) {
		if (!paragraph) {
			paragraph = { lines: [] };
		}
		paragraph.lines.push({ text, offset, lineNumber });
	}

	while (index < sourceLines.length) {
		const lineNumber = index + 1;
		const rawLine = sourceLines[index];
		index++;

		if (fence) {
			const quote = stripBlockQuote(rawLine);
			const match = /^( {0,3})(`{3,}|~{3,})[ \t]*$/.exec(quote.text);
			if (match && match[2][0] === fence.marker[0] && match[2].length >= fence.marker.length) {
				fence = null;
			}
			continue;
		}

		if (html) {
			if (html.kind === 'blank') {
				if (isBlank(rawLine)) {
					html = null;
				}
				continue;
			}
			const lowered = rawLine.toLowerCase();
			if (lowered.includes(html.end)) {
				html = null;
			}
			continue;
		}

		const quote = stripBlockQuote(rawLine);
		const text = quote.text;
		const offset = quote.offset;

		if (isBlank(text)) {
			flush();
			continue;
		}

		const fenceMatch = matchFence(text);
		if (fenceMatch) {
			flush();
			fence = { marker: fenceMatch.marker };
			continue;
		}

		const htmlStart = matchHtmlBlockStart(text);
		if (htmlStart) {
			flush();
			if (htmlStart.kind === 'blank') {
				html = { kind: 'blank' };
			} else if (text.toLowerCase().includes(htmlStart.end)) {
				html = null;
			} else {
				html = htmlStart.kind === 'comment' ? { kind: 'comment', end: htmlStart.end } : htmlStart;
			}
			continue;
		}

		if (matchSetextUnderline(text) && paragraph) {
			// `---` / `===` under a paragraph is a heading underline, never content.
			flush();
			continue;
		}

		if (matchThematicBreak(text)) {
			flush();
			continue;
		}

		const heading = matchAtxHeading(text);
		if (heading) {
			flush();
			appendText(heading.text, offset + heading.offset, lineNumber);
			flush();
			continue;
		}

		if (isTableDelimiterRow(text)) {
			flush();
			continue;
		}

		const marker = matchListMarker(text);
		if (marker && !paragraph) {
			// The item's content column: its own indented code (or a nested fence) starts four
			// columns further in (§5.2), which is what `codeIndent` below measures against.
			const consumed = marker.indent + marker.markerWidth + marker.spaces;
			listIndent = consumed;
			appendText(text.slice(consumed), offset + consumed, lineNumber);
			continue;
		}

		const indentation = indentWidth(text);
		const codeIndent = (listIndent ?? 0) + tabWidth;
		if (indentation >= codeIndent && !paragraph) {
			// Indented code block: consume the run of indented (or blank) lines and keep nothing.
			while (index < sourceLines.length) {
				const nextQuote = stripBlockQuote(sourceLines[index]);
				if (isBlank(nextQuote.text)) {
					index++;
					continue;
				}
				if (indentWidth(nextQuote.text) < codeIndent) {
					break;
				}
				index++;
			}
			continue;
		}

		if (marker) {
			// A new list item while a paragraph is open: the marker ends the paragraph.
			flush();
			const consumed = marker.indent + marker.markerWidth + marker.spaces;
			listIndent = consumed;
			appendText(text.slice(consumed), offset + consumed, lineNumber);
			continue;
		}

		if (listIndent !== null && indentation === 0 && paragraph && !matchListMarker(text)) {
			// A lazy continuation line: still text, still part of the list item's paragraph.
			appendText(text, offset, lineNumber);
			continue;
		}

		appendText(text, offset, lineNumber);
	}

	flush();
	return blocks;
}

/** Maps a code-unit offset inside one block's joined text back to a 1-based line/column pair. */
function blockPositions(block) {
	const parts = block.lines.map(line => line.text);
	const joined = parts.join('\n');
	const starts = [];
	let cursor = 0;
	for (const part of parts) {
		starts.push(cursor);
		cursor += part.length + 1;
	}
	return {
		joined,
		positionAt(offset) {
			let low = 0;
			let high = starts.length - 1;
			while (low < high) {
				const middle = (low + high + 1) >> 1;
				if (starts[middle] <= offset) {
					low = middle;
				} else {
					high = middle - 1;
				}
			}
			const line = block.lines[low];
			const within = offset - starts[low];
			const column = line.offset + codePointLength(line.text, 0, within) + 1;
			return { line: line.lineNumber, column };
		},
	};
}

function skipCodeSpan(text, index) {
	let run = 0;
	while (text[index + run] === '`') {
		run++;
	}
	let cursor = index + run;
	while (cursor < text.length) {
		if (text[cursor] === '`') {
			let closing = 0;
			while (text[cursor + closing] === '`') {
				closing++;
			}
			if (closing === run) {
				return cursor + closing;
			}
			cursor += closing;
			continue;
		}
		cursor++;
	}
	// An unmatched backtick run is literal text, not a code span (§6.1 gives the same result for
	// our purposes: nothing after it is treated as code).
	return index + run;
}

/** Index just past the `]` matching the `[` at `index`, or -1. Honours escapes and code spans. */
function matchClosingBracket(text, index) {
	let depth = 0;
	let cursor = index;
	while (cursor < text.length) {
		const character = text[cursor];
		if (character === '\\' && asciiPunctuation.has(text[cursor + 1] ?? '')) {
			cursor += 2;
			continue;
		}
		if (character === '`') {
			cursor = skipCodeSpan(text, cursor);
			continue;
		}
		if (character === '[') {
			depth++;
		} else if (character === ']') {
			depth--;
			if (depth === 0) {
				return cursor;
			}
		}
		cursor++;
	}
	return -1;
}

/** Parses `(destination "optional title")` starting at the `(` at `index`. */
function parseInlineDestination(text, index) {
	if (text[index] !== '(') {
		return null;
	}
	let cursor = index + 1;
	while (cursor < text.length && /\s/.test(text[cursor])) {
		cursor++;
	}
	let destination = '';
	if (text[cursor] === '<') {
		const end = text.indexOf('>', cursor + 1);
		if (end === -1) {
			return null;
		}
		destination = text.slice(cursor + 1, end);
		cursor = end + 1;
	} else {
		let depth = 0;
		const start = cursor;
		while (cursor < text.length) {
			const character = text[cursor];
			if (character === '\\' && asciiPunctuation.has(text[cursor + 1] ?? '')) {
				cursor += 2;
				continue;
			}
			if (/\s/.test(character)) {
				break;
			}
			if (character === '(') {
				depth++;
			} else if (character === ')') {
				if (depth === 0) {
					break;
				}
				depth--;
			}
			cursor++;
		}
		destination = text.slice(start, cursor);
	}
	while (cursor < text.length && /\s/.test(text[cursor])) {
		cursor++;
	}
	const titleOpening = text[cursor];
	if (titleOpening === '"' || titleOpening === '\'' || titleOpening === '(') {
		const closing = titleOpening === '(' ? ')' : titleOpening;
		let scan = cursor + 1;
		while (scan < text.length) {
			if (text[scan] === '\\') {
				scan += 2;
				continue;
			}
			if (text[scan] === closing) {
				break;
			}
			scan++;
		}
		if (scan >= text.length) {
			return null;
		}
		cursor = scan + 1;
		while (cursor < text.length && /\s/.test(text[cursor])) {
			cursor++;
		}
	}
	if (text[cursor] !== ')') {
		return null;
	}
	return { destination, end: cursor + 1 };
}

const tagCharacter = /[\p{L}\p{N}_\-/]/u;
const tagAllDigits = /^\d+$/u;

function isTagBoundary(previous) {
	return previous === undefined
		|| previous === '\n'
		|| /\s/.test(previous)
		|| previous === '(' || previous === '[' || previous === '{' || previous === '>'
		|| previous === '，' || previous === '。' || previous === '；' || previous === '：';
}

function safeDecode(value) {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

/** Normalises a workspace path: always leading `/`, no `.`/`..` segments, no trailing slash. */
export function normalizeKnowledgePath(path) {
	const parts = [];
	for (const segment of String(path).replace(/\\/g, '/').split('/')) {
		if (segment === '' || segment === '.') {
			continue;
		}
		if (segment === '..') {
			parts.pop();
			continue;
		}
		parts.push(segment);
	}
	return '/' + parts.join('/');
}

function directoryOf(path) {
	const normalized = normalizeKnowledgePath(path);
	const cut = normalized.lastIndexOf('/');
	return cut <= 0 ? '/' : normalized.slice(0, cut);
}

function fileNameOf(path) {
	const normalized = normalizeKnowledgePath(path);
	return normalized.slice(normalized.lastIndexOf('/') + 1);
}

/** Splits `target#anchor` into its two halves. */
function splitAnchor(destination) {
	const cut = destination.indexOf('#');
	if (cut === -1) {
		return { path: destination, anchor: null };
	}
	return {
		path: destination.slice(0, cut),
		anchor: safeDecode(destination.slice(cut + 1)) || null,
	};
}

function isExternalDestination(destination) {
	return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(destination) || destination.startsWith('//');
}

/**
 * Turns one raw link target (`../a.md#anchor`, `笔记`, `https://x/y#z`) into the descriptor the
 * resolver needs. Exported because the resolver re-resolves stored raw targets on read.
 */
export function describeTarget(rawTarget, { kind = 'markdown', sourcePath = '/' } = {}) {
	if (typeof rawTarget !== 'string') {
		throw new TypeError('A link target must be a string.');
	}
	if (kind === 'wiki') {
		const bar = rawTarget.indexOf('|');
		const alias = bar === -1 ? null : rawTarget.slice(bar + 1).trim() || null;
		const body = bar === -1 ? rawTarget : rawTarget.slice(0, bar);
		const { path, anchor } = splitAnchor(body.trim());
		const target = path.trim();
		if (target === '') {
			// `[[#heading]]` — a link inside the same document.
			return {
				kind, raw: rawTarget, targetPath: normalizeKnowledgePath(sourcePath), targetName: null,
				anchor, alias, external: false, self: true,
			};
		}
		const decoded = safeDecode(target);
		const pathLike = decoded.includes('/');
		return {
			kind,
			raw: rawTarget,
			targetPath: pathLike ? normalizeKnowledgePath(decoded) : null,
			targetName: pathLike ? fileNameOf(decoded) : decoded,
			anchor,
			alias,
			external: false,
			self: false,
		};
	}
	const { path, anchor } = splitAnchor(rawTarget.trim());
	if (path === '') {
		return {
			kind, raw: rawTarget, targetPath: normalizeKnowledgePath(sourcePath), targetName: null,
			anchor, alias: null, external: false, self: true,
		};
	}
	if (isExternalDestination(path)) {
		return {
			kind, raw: rawTarget, targetPath: null, targetName: null,
			anchor, alias: null, external: true, self: false,
		};
	}
	const decoded = safeDecode(path);
	const absolute = decoded.startsWith('/')
		? normalizeKnowledgePath(decoded)
		: normalizeKnowledgePath(directoryOf(sourcePath) + '/' + decoded);
	return {
		kind,
		raw: rawTarget,
		targetPath: absolute,
		targetName: fileNameOf(absolute),
		anchor,
		alias: null,
		external: false,
		self: false,
	};
}

/**
 * Extracts the links and tags of one Markdown document.
 *
 * `sourcePath` is the document's workspace path; relative Markdown destinations are resolved
 * against its directory so the index can store an absolute path next to the raw text. The result
 * is deterministic and side-effect free.
 */
export function parseKnowledge(markdown, sourcePath = '/') {
	if (typeof markdown !== 'string') {
		throw new TypeError('parseKnowledge() needs the Markdown source as a string.');
	}
	const sourceLines = markdown.split(/\r\n|\r|\n/);
	let start = 0;
	let frontMatter = false;
	// YAML front matter is not body text. Tag handling for it is still an open product question
	// (docs/knowledge-links.md), so the first version deliberately ignores it instead of guessing.
	// The `key: value` heuristic is what separates front matter from a thematic break that happens
	// to be followed by another `---` further down the document.
	if (sourceLines.length && sourceLines[0].trim() === '---') {
		for (let index = 1; index < sourceLines.length; index++) {
			const candidate = sourceLines[index].trim();
			if (candidate === '---' || candidate === '...') {
				const body = sourceLines.slice(1, index);
				if (body.some(line => /^\s*[A-Za-z0-9_-]+\s*:/.test(line))) {
					start = index + 1;
					frontMatter = true;
				}
				break;
			}
		}
	}
	const balancedPath = normalizeKnowledgePath(sourcePath);
	const blocks = scanBlockText(sourceLines.slice(start));
	// Line numbers must stay anchored to the original document, so the slice is compensated.
	const lineShift = start;

	const links = [];
	const tags = [];

	for (const block of blocks) {
		const shifted = {
			lines: block.lines.map(line => ({ ...line, lineNumber: line.lineNumber + lineShift })),
		};
		const { joined, positionAt } = blockPositions(shifted);
		scanInline(joined, (offset, descriptor) => {
			const { line, column } = positionAt(offset);
			links.push({ ...descriptor, line, column });
		}, (offset, tag) => {
			const { line, column } = positionAt(offset);
			tags.push({ tag, line, column });
		}, balancedPath);
	}

	links.sort((left, right) => (left.line - right.line) || (left.column - right.column));
	tags.sort((left, right) => (left.line - right.line) || (left.column - right.column));
	return { links, tags, frontMatter };
}

function scanInline(text, onLink, onTag, sourcePath) {
	let index = 0;
	while (index < text.length) {
		const character = text[index];

		if (character === '\\' && asciiPunctuation.has(text[index + 1] ?? '')) {
			// A backslash escape: `\[\[not a link]]`, `\#not a tag`.
			index += 2;
			continue;
		}

		if (character === '`') {
			index = skipCodeSpan(text, index);
			continue;
		}

		if (character === '<') {
			const end = text.indexOf('>', index + 1);
			if (end !== -1) {
				// Autolinks and inline HTML are opaque: nothing inside them is a tag or wiki link.
				index = end + 1;
				continue;
			}
			index++;
			continue;
		}

		if (character === '!' && text[index + 1] === '[') {
			// Images are embedded media, not knowledge links, but their alt text is body text and
			// may legitimately carry a tag: `![截图 #标签](a.png)`.
			const closing = matchClosingBracket(text, index + 1);
			if (closing !== -1) {
				const destination = parseInlineDestination(text, closing + 1);
				if (destination) {
					scanInline(text.slice(index + 2, closing), () => {}, (offset, tag) => {
						onTag(index + 2 + offset, tag);
					}, sourcePath);
					index = destination.end;
					continue;
				}
			}
			index++;
			continue;
		}

		if (character === '[' && text[index + 1] === '[') {
			const closing = text.indexOf(']]', index + 2);
			if (closing === -1) {
				index += 2;
				continue;
			}
			const inner = text.slice(index + 2, closing);
			// `[[#anchor]]` and `[[file#anchor|alias]]` are the supported Obsidian shapes.
			const descriptor = describeTarget(inner, { kind: 'wiki', sourcePath });
			// `[[]]`, `[[|]]` and `[[#]]` carry neither a target nor an anchor; they are broken
			// markup, not links to the current document.
			if (descriptor.targetName !== null || (descriptor.self && descriptor.anchor !== null)) {
				onLink(index, descriptor);
				index = closing + 2;
				continue;
			}
			index += 2;
			continue;
		}

		if (character === '[') {
			const closing = matchClosingBracket(text, index);
			if (closing === -1) {
				index++;
				continue;
			}
			const destination = parseInlineDestination(text, closing + 1);
			if (!destination) {
				// Reference-style or a plain bracketed text: scan the label for tags, then move on.
				scanInline(text.slice(index + 1, closing), () => {}, (offset, tag) => {
					onTag(index + 1 + offset, tag);
				}, sourcePath);
				index = closing + 1;
				continue;
			}
			const descriptor = describeTarget(destination.destination, { kind: 'markdown', sourcePath });
			onLink(index, descriptor);
			// Tags inside a link label are still body text.
			scanInline(text.slice(index + 1, closing), () => {}, (offset, tag) => {
				onTag(index + 1 + offset, tag);
			}, sourcePath);
			index = destination.end;
			continue;
		}

		if (character === '#') {
			const previous = index === 0 ? undefined : text[index - 1];
			if (isTagBoundary(previous)) {
				let end = index + 1;
				while (end < text.length && tagCharacter.test(text[end])) {
					end++;
				}
				const tag = text.slice(index + 1, end);
				if (tag !== '' && !tagAllDigits.test(tag)) {
					onTag(index, tag);
					index = end;
					continue;
				}
			}
			index++;
			continue;
		}

		index++;
	}
}

export { indentWidth as knowledgeIndentWidth };
