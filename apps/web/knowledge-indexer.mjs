// Keeps the knowledge index (links, backlinks, tags) in step with the note bodies.
//
// The index is a pure derivative of storage_entries / storage_file_versions: nothing here writes
// the storage tables or the objects. A rebuild can be thrown away at any moment and recomputed
// byte for byte, which is what makes the migration safe to roll back (knowledge-schema.sql).
//
// Identity rules (docs/knowledge-links.md §2):
//   * a link is stored against the *stable* file ID of its target, so a rename never invalidates
//     a backlink;
//   * a link row records the source revision it was parsed from, so a note edited since the last
//     index pass is simply re-parsed and never mixed with rows from an older revision;
//   * a target name that matches more than one note is `ambiguous` with the candidate count. The
//     resolver never picks one, because a wrong guess silently rewrites somebody's link.

import { posix } from 'node:path';
import { Readable } from 'node:stream';
import { describeTarget, linkStatuses, parseKnowledge, knowledgeParserVersion } from './knowledge-parser.mjs';
import { WorkspaceError, workspaceUploadLimit } from './workspace-contract.mjs';

/** How many candidate notes the ambiguity report carries for the UI. */
const maxReportedCandidates = 10;

/** Reads a revision body as UTF-8 text. The revision and the bytes must agree. */
async function readBody(backend, path, revisionId) {
	let handle;
	if (revisionId && typeof backend.openRevision === 'function') {
		handle = await backend.openRevision(path, revisionId);
	} else {
		handle = await backend.openRead(path);
	}
	try {
		const stream = await handle.stream();
		const chunks = [];
		for await (const chunk of stream) {
			chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
		}
		return Buffer.concat(chunks).toString('utf8');
	} finally {
		if (typeof handle.close === 'function') {
			handle.close();
		}
	}
}

/**
 * Normalises a tag into the key used for grouping, listing and prefix queries. The display form
 * is kept verbatim, because `#API` and `#api` should look the way the author typed them. Whether
 * they are the same tag is an open product question (docs/knowledge-links.md); v1 groups
 * case-insensitively so a tag cloud cannot show the same tag twice.
 */
export function knowledgeTagKey(tag) {
	return String(tag).toLowerCase();
}

function candidateReport(row) {
	return { fileId: row.file_id, path: row.path };
}

const extensionPattern = /\.[A-Za-z0-9]+$/;

/**
 * The file names a bare wiki target may stand for. Obsidian writes `[[笔记B]]` for `笔记B.md`, so
 * a name-only link has to be matched against the note name with and without its extension —
 * otherwise every wiki link in the product would look broken.
 */
function nameKeysFor(targetName) {
	const lower = String(targetName).toLowerCase();
	const keys = new Set([lower]);
	if (!extensionPattern.test(lower)) {
		keys.add(lower + '.md');
	}
	return keys;
}

/**
 * Resolves one parsed target inside a workspace.
 *
 * `scope` is `{ workspaceId, store }`. The result carries the four states the API exposes:
 *   resolved  – exactly one target,
 *   missing   – nothing matches,
 *   ambiguous – more than one note shares the name; `candidates` lists them and the caller must
 *               let a human choose (docs/knowledge-links.md §K01),
 *   external  – not a workspace file at all.
 */
export async function resolveLink(scope, sourceFileId, rawTarget, { descriptor, candidates, kind = 'wiki', sourcePath = '/' } = {}) {
	const target = descriptor ?? describeTarget(rawTarget, { kind, sourcePath });
	const base = {
		raw: target.raw,
		kind: target.kind ?? kind,
		targetPath: target.targetPath ?? null,
		targetName: target.targetName ?? null,
		anchor: target.anchor ?? null,
		alias: target.alias ?? null,
	};

	if (target.external) {
		return { ...base, status: 'external', targetFileId: null, candidateCount: 0, candidates: [] };
	}

	if (target.self) {
		// `[back to top](#intro)` or `[[#intro]]`: the target is the source document itself.
		return {
			...base,
			status: 'resolved',
			targetFileId: sourceFileId,
			candidateCount: 1,
			candidates: [],
		};
	}

	if (target.targetPath !== null) {
		// A path-shaped target (`../a.md`, `/notes/a.md`, `[[dir/a]]`) is explicit: if it does
		// not exist that is a missing link, not an invitation to guess a same-named note.
		const row = await scope.store.readFileByPath(scope.workspaceId, target.targetPath);
		if (!row) {
			return { ...base, status: 'missing', targetFileId: null, candidateCount: 0, candidates: [] };
		}
		return {
			...base,
			status: 'resolved',
			targetPath: row.path,
			targetName: target.targetName ?? null,
			targetFileId: row.file_id,
			candidateCount: 1,
			candidates: [],
		};
	}

	if (target.targetName === null) {
		return { ...base, status: 'missing', targetFileId: null, candidateCount: 0, candidates: [] };
	}

	// A bare name (`[[笔记B]]`). One match resolves, several are reported as ambiguous so the UI
	// can ask; a name-only link is never rewritten automatically.
	const keys = nameKeysFor(target.targetName);
	// The indexer looks names up once per document and passes the result in; a caller resolving a
	// single link (the API, a test) gets the lookup here instead of an empty candidate list that
	// would turn every wiki link into a false `missing`.
	const pool = candidates ?? await scope.store.listCandidateFiles(scope.workspaceId, [...keys]);
	const matches = pool.filter(row => keys.has(String(row.name_key).toLowerCase()));
	if (matches.length === 1) {
		return {
			...base,
			status: 'resolved',
			targetPath: matches[0].path,
			targetFileId: matches[0].file_id,
			candidateCount: 1,
			candidates: [],
		};
	}
	if (matches.length > 1) {
		return {
			...base,
			status: 'ambiguous',
			targetFileId: null,
			candidateCount: matches.length,
			candidates: matches.slice(0, maxReportedCandidates).map(candidateReport),
		};
	}
	return { ...base, status: 'missing', targetFileId: null, candidateCount: 0, candidates: [] };
}

/**
 * The names a parsed document refers to without a path, so candidates can be fetched once.
 * Both spellings are requested (`笔记B` and `笔记B.md`) because the stored name is the file name.
 */
function nameOnlyTargets(links) {
	const names = new Set();
	for (const link of links) {
		if (link.external || link.self) {
			continue;
		}
		if (link.targetPath === null && link.targetName !== null) {
			for (const key of nameKeysFor(link.targetName)) {
				names.add(key);
			}
		}
	}
	return [...names];
}

/**
 * Parses one note revision and resolves its links. Returns storage rows, never touching the
 * database: the caller decides when to write them.
 */
export async function describeNoteIndex(scope, { path, fileId, revisionId, body }) {
	const parsed = parseKnowledge(body, path);
	const names = nameOnlyTargets(parsed.links, path);
	const candidates = names.length
		? await scope.store.listCandidateFiles(scope.workspaceId, names)
		: [];
	const links = [];
	for (const link of parsed.links) {
		const resolved = await resolveLink(scope, fileId, link.raw, {
			descriptor: link,
			candidates,
			kind: link.kind,
			sourcePath: path,
		});
		links.push({
			kind: resolved.kind,
			raw: resolved.raw,
			targetPath: resolved.targetPath,
			targetName: resolved.targetName,
			targetFileId: resolved.targetFileId,
			anchor: resolved.anchor,
			alias: resolved.alias,
			status: resolved.status,
			candidateCount: resolved.candidateCount,
			line: link.line,
			column: link.column,
		});
	}
	const tags = parsed.tags.map(tag => ({
		tag: tag.tag,
		tagKey: knowledgeTagKey(tag.tag),
		line: tag.line,
		column: tag.column,
	}));
	return { revisionId, links, tags, frontMatter: parsed.frontMatter };
}

/**
 * Re-indexes one file: read the live revision, parse it, replace that file's rows in one
 * transaction. Returns `{ indexed: false }` when the stored rows already describe this revision,
 * so a caller may call this on every save without paying for a no-op rewrite.
 *
 * `scope` carries an optional `connection` when the caller already owns a transaction (the
 * sync-store.mjs convention); otherwise this opens one.
 */
export async function updateKnowledgeIndex(scope, fileId, revision, { force = false } = {}) {
	const live = revision?.path ? revision : await scope.store.readLiveFile(scope.workspaceId, fileId);
	if (!live) {
		return { fileId, indexed: false, reason: 'missing' };
	}
	const revisionId = revision?.revisionId ?? live.revision_id;
	const path = revision?.path ?? live.path;
	if (!force) {
		const state = await scope.store.readIndexState(scope.workspaceId, fileId);
		if (state && state.revisionId === revisionId && state.parserVersion === knowledgeParserVersion) {
			return { fileId, revisionId, indexed: false, reason: 'current' };
		}
	}
	const body = await readBody(scope.backend, path, revisionId);
	const described = await describeNoteIndex(scope, { path, fileId, revisionId, body });
	const write = async (connection) => {
		await scope.store.replaceFileIndex(connection, {
			workspaceId: scope.workspaceId,
			fileId,
			revisionId,
			parserVersion: knowledgeParserVersion,
			links: described.links,
			tags: described.tags,
			indexedAt: Date.now(),
		});
	};
	if (scope.connection) {
		await write(scope.connection);
	} else {
		await scope.store.transaction(write);
	}
	return {
		fileId,
		revisionId,
		indexed: true,
		linkCount: described.links.length,
		tagCount: described.tags.length,
		links: described.links,
		tags: described.tags,
	};
}

/**
 * Brings the whole workspace index up to date. Files whose indexed revision already matches the
 * live revision are skipped, so this is cheap to run after a restore, an import or a restart,
 * and it converges from an empty or half-written index.
 */
export async function rebuildKnowledgeIndex(scope, { force = false, limit = Number.POSITIVE_INFINITY } = {}) {
	const files = await scope.store.listLiveFiles(scope.workspaceId);
	const report = { considered: files.length, indexed: 0, skipped: 0, failed: [], links: 0, tags: 0 };
	let seen = 0;
	for (const file of files) {
		if (seen >= limit) {
			break;
		}
		seen++;
		if (!force && file.indexedRevisionId === file.revisionId && file.parserVersion === knowledgeParserVersion) {
			report.skipped++;
			continue;
		}
		try {
			const result = await updateKnowledgeIndex(scope, file.fileId, {
				path: file.path,
				revisionId: file.revisionId,
			}, { force: true });
			report.indexed++;
			report.links += result.linkCount ?? 0;
			report.tags += result.tagCount ?? 0;
		} catch (error) {
			// One unreadable note must not abort the rebuild: the rest of the workspace stays
			// indexed and the failure is reported with its stable file ID.
			report.failed.push({ fileId: file.fileId, path: file.path, error: error?.code ?? error?.message ?? 'UnknownError' });
		}
	}
	return report;
}

/**
 * Proposes the rewrite a rename or move would need: every source document that links to this
 * file, the exact text it currently contains, and the text it would contain afterwards.
 *
 * This is a preview on purpose. The storage backend can commit one file atomically, but it has
 * no cross-file transaction that also touches the objects, so a multi-file rewrite cannot be
 * all-or-nothing (docs/knowledge-links.md §4). Producing a plan is safe; claiming to have applied
 * it is not.
 */
export async function planLinkRewrite(scope, fileId, newPath) {
	const live = await scope.store.readLiveFile(scope.workspaceId, fileId);
	const target = live ? { path: live.path, fileId: live.file_id, revisionId: live.revision_id } : null;
	const links = await scope.store.listLinksToFile(scope.workspaceId, fileId);

	const files = new Map();
	for (const link of links) {
		// Only a link that actually points at this file can be rewritten. An `ambiguous` or
		// `missing` row has no target identity, so rewriting it would be a guess (K01).
		if (link.status !== 'resolved') {
			continue;
		}
		const replacement = rewriteTarget(link, newPath);
		const entry = files.get(link.sourceFileId) ?? {
			fileId: link.sourceFileId,
			path: link.sourcePath,
			revisionId: link.sourceRevisionId,
			etag: link.sourceEtag,
			edits: [],
		};
		entry.edits.push({
			line: link.line,
			column: link.column,
			kind: link.kind,
			raw: link.raw,
			replacement,
			anchor: link.anchor,
			alias: link.alias,
		});
		files.set(link.sourceFileId, entry);
	}

	const affected = [...files.values()].sort((left, right) => String(left.path).localeCompare(String(right.path)));
	const planId = planIdFor(scope.workspaceId, fileId, newPath, affected);
	return {
		planId,
		target,
		newPath,
		affectedFiles: affected,
		editCount: affected.reduce((total, file) => total + file.edits.length, 0),
		// The honest answer the API surfaces: several notes cannot be rewritten together with
		// their objects in one transaction, so the UI offers a manual entry point instead of a
		// button that would claim success for a half-applied rename (docs/knowledge-links.md §4).
		applicable: affected.length <= 1,
		requiresAtomicRewrite: affected.length > 1,
		manual: affected.length > 1
			? 'Several notes link here. The storage backend cannot commit them together with their objects yet, so the rewrite must be applied by hand.'
			: null,
	};
}

/**
 * The replacement text for one link target. The author's syntax is preserved: a relative
 * Markdown destination stays relative, a wiki link keeps its anchor and alias, and an external
 * or document-local target is never touched.
 */
function rewriteTarget(link, newPath) {
	if (link.kind === 'markdown') {
		const relative = posix.relative(posix.dirname(link.sourcePath ?? '/'), newPath);
		const destination = relative === '' ? '.' : relative;
		return link.anchor ? destination + '#' + link.anchor : destination;
	}
	if (link.kind === 'wiki') {
		// Obsidian names vault-root notes without a leading slash and without the extension.
		let name = newPath.startsWith('/') ? newPath.slice(1) : newPath;
		name = name.replace(/\.md$/i, '');
		if (link.anchor) {
			name += '#' + link.anchor;
		}
		if (link.alias) {
			name += '|' + link.alias;
		}
		return name;
	}
	return link.raw;
}

function planIdFor(workspaceId, fileId, newPath, affected) {
	const parts = [workspaceId, fileId, newPath, ...affected.map(file => `${file.fileId}@${file.revisionId}`)];
	// Stable for the same inputs, so re-posting the same preview yields the same identity and a
	// stale preview can be recognised as stale.
	let hash = 0x811c9dc5;
	for (const part of parts.join('\u0000')) {
		hash ^= part.codePointAt(0) & 0xff;
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, '0');
}

/**
 * Submits a preview. Nothing is written, and that is the deliverable: the backend has no
 * cross-file transaction that also covers the object store, so a multi-file rewrite cannot be
 * all or nothing (docs/knowledge-links.md §4). What this *does* guarantee is that a stale
 * preview can never overwrite anything — a source that changed since the preview, or a plan
 * whose inputs moved, is refused with 409 and no note is touched.
 */
export async function applyLinkRewrite(scope, { fileId, newPath, expectedRevisions = [], planId } = {}) {
	const plan = await planLinkRewrite(scope, fileId, newPath);
	if (planId !== undefined && planId !== plan.planId) {
		throw new WorkspaceError(409, 'StalePlan');
	}
	const expected = new Map();
	for (const entry of expectedRevisions) {
		if (entry && typeof entry.fileId === 'string') {
			expected.set(entry.fileId, entry.revisionId ?? null);
		}
	}
	const conflicts = [];
	for (const file of plan.affectedFiles) {
		const live = await scope.store.readLiveFile(scope.workspaceId, file.fileId);
		const current = live ? live.revision_id : null;
		if (!expected.has(file.fileId)) {
			conflicts.push({ fileId: file.fileId, path: file.path, reason: 'NotExpected' });
		} else if (expected.get(file.fileId) !== current) {
			// The note was edited (or renamed, or trashed) after the preview was taken. Refusing
			// here is what guarantees "no overwrite on conflict": the preview and the file the
			// user is looking at no longer agree (§K03).
			conflicts.push({ fileId: file.fileId, path: file.path, reason: 'Changed' });
		}
	}
	if (conflicts.length) {
		throw rewriteError(409, 'RewriteConflict', { conflicts, plan });
	}
	if (plan.affectedFiles.length > 1) {
		// Refused on purpose: several notes plus their objects cannot be committed together, so
		// answering 200 would claim a rewrite that never happened.
		throw rewriteError(501, 'RewriteNotAtomic', { plan });
	}
	if (!plan.affectedFiles.length) {
		return { planId: plan.planId, wrote: [], affectedFiles: [], editCount: 0 };
	}

	// Exactly one source document: a single write is atomic on its own (one revision, one
	// object), which is the only case the current backend can honestly promise.
	const [file] = plan.affectedFiles;
	const live = await scope.store.readLiveFile(scope.workspaceId, file.fileId);
	const body = await readBody(scope.backend, live.path, live.revision_id);
	const rewritten = rewriteBody(body, file.edits);
	if (rewritten === null) {
		// A defensive check in depth: the preview said line/column X holds this link, but the
		// bytes disagree. Writing anyway could mangle the note, so nothing is written.
		throw rewriteError(409, 'RewriteConflict', { plan, reason: 'UnstableSource' });
	}
	await scope.backend.writeFile(live.path, Readable.from([Buffer.from(rewritten, 'utf8')]), {
		overwrite: true,
		etag: `"${live.revision_id}"`,
		maxBytes: workspaceUploadLimit(),
	});
	return {
		planId: plan.planId,
		wrote: [{ fileId: file.fileId, path: live.path, editCount: file.edits.length }],
		affectedFiles: plan.affectedFiles,
		editCount: plan.editCount,
	};
}

function rewriteError(status, code, extra = {}) {
	const error = new WorkspaceError(status, code);
	Object.assign(error, extra);
	return error;
}

/**
 * Applies the edits of one document, or returns null when the text at the recorded position is
 * no longer the link the preview described. Pure and total: it either produces a document in
 * which exactly the intended targets changed, or refuses.
 */
export function rewriteBody(body, edits) {
	const lines = body.split(/\r\n|\r|\n/);
	// Right to left, so an earlier edit never shifts a later position.
	const ordered = [...edits].sort((left, right) => (right.line - left.line) || (right.column - left.column));
	for (const edit of ordered) {
		const index = edit.line - 1;
		if (index < 0 || index >= lines.length) {
			return null;
		}
		const from = lines[index];
		// `column` is the 1-based position of the link's opening marker *as code points*; the raw
		// target sits after it. Counting code points keeps an emoji or a CJK character earlier in
		// the line from shifting the edit.
		const points = Array.from(from);
		const offset = edit.column - 1;
		const opening = edit.kind === 'wiki' ? '[[' : '[';
		if (offset < 0 || points.slice(offset, offset + opening.length).join('') !== opening) {
			// The bytes no longer match the indexed positions. Refusing is the only safe answer:
			// guessing a nearby target could rewrite the wrong link in a note the user edited.
			return null;
		}
		const raw = String(edit.raw);
		const target = String(edit.replacement ?? '');
		const start = points.slice(offset + opening.length).join('').indexOf(raw);
		if (start === -1) {
			return null;
		}
		const absolute = offset + opening.length + Array.from(points.slice(offset + opening.length).join('').slice(0, start)).length;
		const before = points.slice(0, absolute).join('');
		const after = points.slice(absolute + raw.length).join('');
		lines[index] = before + target + after;
	}
	return lines.join('\n');
}

export { linkStatuses, knowledgeParserVersion };
