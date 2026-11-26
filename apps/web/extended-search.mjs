import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { WorkspaceError } from './workspace-contract.mjs';

export const extendedSearchPath = '/search/v1/extended';
export const extendedSearchPagePath = '/advanced-search';
const binaryLimit = 24 * 1024 ** 2;
const textLimit = 48 * 1024;
const historyPageLength = 32;
const attachmentPageLength = 8;
const legacyFormats = new Set(['doc', 'xls', 'ppt']);
const formats = new Set(['md', 'markdown', 'txt', 'pdf', 'docx', 'xlsx', 'pptx', ...legacyFormats]);
const fail = (status, code) => { throw new WorkspaceError(status, code); };

async function collect(stream, limit) {
	let size = 0;
	const chunks = [];
	try {
		for await (const bytes of stream) {
			size += bytes.length;
			if (size > limit) fail(413, 'SearchContentTooLarge');
			chunks.push(bytes);
		}
		return Buffer.concat(chunks, size);
	} finally {
		stream.destroy?.();
	}
}

function extract(program, args, bytes, timeout = 5500) {
	return new Promise((resolve, reject) => {
		const child = execFile(program, args, { timeout, killSignal: 'SIGKILL', maxBuffer: textLimit * 4 + 4096 },
			(error, stdout) => error ? reject(error) : resolve(stdout.slice(0, textLimit)));
		child.stdin.on('error', () => {});
		child.stdin.end(bytes);
	});
}

export async function extractSearchText(format, opened, formatRunner) {
	if (!formats.has(format)) fail(415, 'SearchUnsupportedFormat');
	if (['md', 'markdown', 'txt'].includes(format)) {
		if (!opened.size) return '';
		const range = opened.size > textLimit ? { start: 0, end: textLimit - 1 } : undefined;
		return (await collect(await opened.stream(range), textLimit)).toString('utf8');
	}
	if (opened.size > binaryLimit) fail(413, 'SearchContentTooLarge');
	if (legacyFormats.has(format) && !formatRunner) fail(503, 'SearchFormatUnavailable');
	const data = await collect(await opened.stream(), binaryLimit);
	if (format === 'pdf') {
		const text = await extract(process.execPath, ['--max-old-space-size=128',
			fileURLToPath(new URL('./extract-pdf-text.mjs', import.meta.url))], data);

		if (text.trim() || !formatRunner) return text;
		const recognized = await extract(formatRunner, ['ocr-pdf'], data, 18_000);
		return recognized.replace(/(\p{Script=Han})[ \t]+(?=\p{Script=Han})/gu, '$1');
	}
	if (legacyFormats.has(format)) {
		return extract(formatRunner, [format], data, 18_000);
	}
	return extract('python3', ['-I', fileURLToPath(new URL('./extract-office-text.py', import.meta.url)), format], data);
}

function signature(workspace, scope, query) {
	return createHash('sha256').update(JSON.stringify([workspace,scope,query])).digest('hex');
}

function decodeCursor(value, expected) {
	if (value === undefined) return {};
	try {
		if (typeof value !== 'string' || value.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
		const [identity, path, revision] = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
		if (identity !== expected || typeof path !== 'string' || !path.startsWith('/') ||
			typeof revision !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(revision)) throw new Error();
		return { path, revision };
	} catch {
		return fail(400, 'InvalidSearchCursor');
	}
}

export function createSearchGate({ concurrency = 2, capacity = 8, waitMs = 4000 } = {}) {
	let active = 0;
	const waiting = [];
	return async function run(search) {
		if (active >= concurrency) {
			if (waiting.length >= capacity) fail(429, 'SearchBusy');
			await new Promise((resolve, reject) => {
				const ticket = () => { clearTimeout(timer); resolve(); };
				const timer = setTimeout(() => {
					waiting.splice(waiting.indexOf(ticket), 1);
					reject(new WorkspaceError(429, 'SearchBusy'));
				}, waitMs);
				waiting.push(ticket);
			});
		} else {
			active++;
		}
		try {
			return await search();
		} finally {
			const next = waiting.shift();
			if (next) next();
			else active--;
		}
	};
}

export function openExtendedSearch(postgres, { formatRunner = process.env.LOG4STELLAR_SEARCH_FORMAT_RUNNER } = {}) {
	const pool = new Pool({ ...postgres, max: 2, connectionTimeoutMillis: 5000 });
	const cache = new Map();
	const run = createSearchGate();

	return {
		async search({ workspaceId, backend, scope, q, cursor }) {
			if (!['history', 'attachments', 'all'].includes(scope) ||
				typeof q !== 'string' || !q.trim() || q.length > 256) fail(400, 'InvalidQuery');
			const query = q.trim().toLocaleLowerCase();
			const key = signature(workspaceId, scope, query);
			const after = decodeCursor(cursor, key);
			return run(async () => {
				const pageLength = scope === 'history' ? historyPageLength : attachmentPageLength;
				// Index candidates are joined to live entries so trash and replaced files
				// never surface through their retained historical versions.
				const { rows } = await pool.query(`
					SELECT e.path, v.revision_id, v.sha256, v.created_ms,
					       e.revision_id = v.revision_id AS current
					FROM log4stellar.storage_entries e
					JOIN log4stellar.storage_file_versions v ON v.workspace_id = e.workspace_id AND v.file_id = e.file_id
					WHERE e.workspace_id = $1 AND e.kind = 1
					  AND ($3::text IS NULL OR (e.path, v.revision_id) > ($3, $4::uuid))
					  AND (
						($2 <> 'attachments' AND e.revision_id <> v.revision_id AND lower(e.path) ~ '[.](md|markdown|txt|pdf|docx|xlsx|pptx|doc|xls|ppt)$')
						OR ($2 <> 'history' AND e.revision_id = v.revision_id AND lower(e.path) ~ '[.](pdf|docx|xlsx|pptx|doc|xls|ppt)$')
					  )
					ORDER BY e.path, v.revision_id LIMIT $5
				`, [workspaceId, scope, after.path ?? null, after.revision ?? null, pageLength + 1]);
				const scanned = rows.slice(0, pageLength);
				const results = [];
				let skipped = 0;
				const find = async row => {
					const format = row.path.split('.').at(-1).toLowerCase();
					const cacheKey = JSON.stringify([workspaceId, format, row.sha256]);
					try {
						// Reauthorize each version against the live path, even on a cache hit.
						const opened = await backend.openRevision(row.path, row.revision_id);
						try {
							let pending = cache.get(cacheKey);
							if (pending === undefined) {
								pending = extractSearchText(format, opened, formatRunner);
								cache.set(cacheKey, pending);
								if (cache.size > 128) cache.delete(cache.keys().next().value);
							}
							const text = await pending.catch(error => {
								if (cache.get(cacheKey) === pending) cache.delete(cacheKey);
								throw error;
							});
							const index = text.toLocaleLowerCase().indexOf(query);
							if (index !== -1) return { path:row.path, revisionId:row.revision_id, current:row.current,
								createdAt:Number(row.created_ms), excerpt:text.slice(Math.max(0,index-48),index+query.length+72) };
						} finally {
							await opened.close?.();
						}
					} catch {
						skipped++;
					}
				};
				const deadline = Date.now() + 8_000;
				let processed = 0;
				while (processed < scanned.length && Date.now() < deadline) {
					const batch = scanned.slice(processed, processed + 2);
					results.push(...(await Promise.all(batch.map(find))).filter(Boolean));
					processed += batch.length;
				}
				const last = scanned[processed - 1];
				return {
					results, skipped, scanned:processed,
					nextCursor: rows.length > processed
						? Buffer.from(JSON.stringify([key,last.path,last.revision_id])).toString('base64url') : null,
				};
			});
		},
		close: () => pool.end(),
	};
}
