// Index worker for the workspace full text index (task 01 全文搜索).
//
// The worker is deliberately not a separate process. Enqueueing happens inside the
// storage write transaction, and the queue is drained lazily: after a search opens
// its backend, and after a write that enqueued something. That keeps the deployment
// surface unchanged (no new daemon, no extra connection pool) and makes the crash
// story trivial — a job that is still queued is simply picked up by the next drain.
//
// Nothing here trusts the queue alone. Every job is reconciled against the current
// storage metadata, so a job that describes a revision the file has already moved
// past is requeued against the real revision instead of writing a stale copy.

import { searchLimits, searchMatchText } from './search-contract.mjs';
import {
	applyJob,
	claimIndexJobs,
	findIndexedSource,
	listIndexableFiles,
	prepareRebuild,
	readIndexState,
	requeueIndexJob,
	searchTables,
} from './search-store.mjs';

const decoder = new TextDecoder('utf-8', { fatal: false });

/**
 * Extracts the searchable text of a Markdown note. The original bytes are never
 * modified: this only produces the derived copy that goes into the index, capped at
 * `maxDocumentBytes` of input and `maxBodyChars` of output.
 *
 * The first Markdown heading becomes the title, and the body starts at the first
 * heading because a hit reported in the heading would otherwise be duplicated in
 * both fields. Everything is reported as plain text — the caller is responsible for
 * rendering it, and this function never produces HTML.
 */
export function extractMarkdown(bytes, { maxBytes = searchLimits.maxDocumentBytes, maxChars = searchLimits.maxBodyChars } = {}) {
	const buffer = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? []);
	const truncated = buffer.byteLength > maxBytes;
	const slice = truncated ? buffer.subarray(0, maxBytes) : buffer;
	// A byte cap can cut a multi-byte character in half; TextDecoder drops the
	// incomplete tail instead of inserting a replacement character, so a Chinese note
	// that crosses the cap keeps a clean last character.
	let text = decoder.decode(slice, { stream: truncated });
	text = text.replace(/\r\n?/g, '\n').replace(/\u0000/g, '');
	let title = '';
	const lines = text.split('\n');
	for (const line of lines) {
		const match = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
		if (match) {
			title = match[1].replace(/[*_`~]/g, '').trim();
			break;
		}
	}
	if (title === '') {
		// A note without a heading is still searchable and still has a name in the
		// result list: the last path segment is the least surprising fallback.
		title = '';
	}
	const body = text.length > maxChars ? text.slice(0, maxChars) : text;
	return {
		title,
		body,
		truncated: truncated || text.length > maxChars,
	};
}

/**
 * The line/column pair of a hit, in the units the API promises: `line` is 1-based,
 * `column` is 1-based and counts UTF-16 code units so it lines up with what a
 * JavaScript editor would report for the same offset.
 *
 * `windowStart` is the 1-based character offset the excerpt starts at, so the column
 * of the hit inside the excerpt is `matchPos - windowStart + 1`. Both are converted
 * to UTF-16 here, once, instead of at every call site.
 */
export function locateHit({ windowText, windowStart, matchPos }) {
	const offsetInWindow = Math.max(matchPos - windowStart, 0);
	const before = windowText.slice(0, offsetInWindow);
	const newlines = before.split('\n').length - 1;
	const column = utf16Length(before.slice(before.lastIndexOf('\n') + 1)) + 1;
	return { offsetInWindow, column, newlineCount: newlines };
}

export function utf16Length(value) {
	return value.length;
}

function excerptOf(windowText, offsetInWindow) {
	const start = Math.max(offsetInWindow - 40, 0);
	const end = Math.min(start + searchLimits.maxExcerptChars, windowText.length);
	const raw = windowText.slice(start, end);
	// The excerpt is one line of plain text. Newlines become spaces so a client can render
	// it in a single row without needing to re-flow the note.
	return raw.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
}

// The excerpt is collapsed on the way out, so the offset of the hit inside it is measured
// after the collapse instead of being carried over from the raw window: a lost newline
// would otherwise shift the highlight by a character or two.
function highlightOf(excerpt, needle) {
	const at = excerpt.toLowerCase().indexOf(needle);
	return at < 0 ? { offset: 0, length: 0 } : { offset: at, length: needle.length };
}

/**
 * Builds one API result from a database row. The excerpt is pure text; the client
 * highlights by `excerptOffset`/`excerptLength` and must never inject it as HTML.
 *
 * `where` says which field matched. A note whose heading or file name matched still shows
 * the top of the body as its preview, because there is no body line to point at.
 */
export function matchFromRow(row, query) {
	const needle = searchMatchText(query);
	const where = row.titlePos > 0 ? 'title' : row.bodyPos > 0 ? 'body' : 'path';
	const anchor = row.bodyPos > 0 ? row.bodyPos : row.windowStart;
	const located = locateHit({ windowText: row.windowText, windowStart: row.windowStart, matchPos: anchor });
	const excerpt = excerptOf(row.windowText, located.offsetInWindow);
	const highlight = highlightOf(excerpt, needle);
	return {
		fileId: row.fileId,
		path: row.path,
		revisionId: row.revisionId,
		line: row.linesBefore + located.newlineCount + 1,
		column: located.column,
		match: where,
		excerpt,
		excerptOffset: highlight.offset,
		excerptLength: highlight.length,
	};
}

/**
 * Applies one claimed job against the current storage truth.
 *
 * `scope` is the backend the search is running against; `withTransaction` runs the
 * callback in a write transaction because the document write and the job removal
 * must land together. A revision that moved between the claim and the transaction
 * requeues the job instead of indexing the wrong bytes.
 */
export async function applyIndexJob(job, scope) {
	const { backend, withTransaction } = scope;
	return withTransaction(async connection => {
		const source = await findIndexedSource(connection, job.workspaceId, job.fileId);
		if (source === undefined) {
			// The file is gone: the delete half of the job is what the queue meant, so
			// applying it as a delete is correct regardless of the recorded operation.
			return applyJob(connection, job, undefined);
		}
		if (job.operation === 'delete') {
			// A delete job for a file that still exists means a newer change already
			// brought it back; the row was superseded and is dropped.
			return applyJob(connection, job, undefined);
		}
		let document;
		try {
			const opened = await backend.openRead(source.path);
			const bytes = await readAll(opened);
			const extracted = extractMarkdown(bytes);
			document = {
				revisionId: source.revisionId,
				path: source.path,
				title: extracted.title || basename(source.path),
				body: extracted.body,
				truncated: extracted.truncated,
			};
		} catch (error) {
			if (error && error.status === 404) {
				// The file was removed between the metadata read and the object read.
				return applyJob(connection, job, undefined);
			}
			throw error;
		}
		return applyJob(connection, job, document);
	});
}

function basename(path) {
	const name = path.slice(path.lastIndexOf('/') + 1);
	return name.replace(/\.md$/i, '');
}

// `stream()` is asynchronous — both object stores hand back a promise of a readable —
// so the stream is awaited before it is iterated.
async function readAll(opened) {
	const chunks = [];
	try {
		const stream = await opened.stream();
		for await (const chunk of stream) {
			chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		}
	} finally {
		await opened.close?.();
	}
	return Buffer.concat(chunks);
}

/**
 * Drains the queue for one workspace. Bounded by `maxJobs` so a search request never
 * turns into an unbounded batch: whatever is left stays queued for the next drain.
 */
export async function drainIndexJobs(scope, { maxJobs = 50, nowMs = Date.now() } = {}) {
	let applied = 0;
	let claimed = 0;
	while (claimed < maxJobs) {
		const batch = await scope.withTransaction(connection =>
			claimIndexJobs(connection, scope.workspaceId, { limit: Math.min(25, maxJobs - claimed), nowMs }));
		if (batch.length === 0) {
			break;
		}
		claimed += batch.length;
		for (const job of batch) {
			try {
				if (await applyIndexJob(job, scope)) {
					applied += 1;
				}
			} catch (error) {
				// A failed job goes back to the queue and is retried on the next drain.
				// The attempt counter is what keeps a permanently broken file from
				// spinning forever.
				await scope.withTransaction(connection => requeueIndexJob(connection, job, nowMs)).catch(() => {});
				if (job.attempts >= 2) {
					continue;
				}
				throw error;
			}
		}
	}
	return applied;
}

/**
 * Rebuilds the whole index of one workspace. The generation moves forward inside the
 * same transaction that empties the documents, so a cursor from before the rebuild is
 * refused from the moment the derived copy is gone; the queue then refills it.
 */
export async function rebuildWorkspaceIndex(scope, { nowMs = Date.now() } = {}) {
	const { files, generation } = await scope.withTransaction(async connection => {
		const listed = await listIndexableFiles(connection, scope.workspaceId);
		const bumped = await prepareRebuild(connection, scope.workspaceId, listed, nowMs);
		return { files: listed, generation: bumped };
	});
	// The caller decides whether the rebuild is drained inline; doing it here keeps the
	// endpoint's contract simple (a completed rebuild is searchable when it returns).
	const applied = await drainIndexJobs(scope, { maxJobs: files.length + 25, nowMs });
	return { generation, queued: files.length, applied };
}

export async function indexStatus(scope) {
	return scope.withTransaction(async connection => {
		const state = await readIndexState(connection, scope.workspaceId);
		const { rows } = await connection.query(
			`SELECT count(*)::int AS total FROM ${searchTables.documents} WHERE workspace_id = $1`,
			[scope.workspaceId],
		);
		return { ...state, documents: rows[0].total };
	});
}
