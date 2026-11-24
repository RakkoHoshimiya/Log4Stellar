import { extname } from 'node:path';
import { capabilityForRequest } from './workspace-access.mjs';
import { WorkspaceError, ifMatchHolds } from './workspace-contract.mjs';

export const mountPath = '/static/mount';
const safeInline = new Set(['.md', '.txt', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.mp4', '.webm', '.mp3', '.wav']);
const fileErrors = {
	ENOENT: [404, 'FileNotFound'],
	EEXIST: [409, 'FileExists'],
	ENOTDIR: [400, 'FileNotADirectory'],
	EISDIR: [400, 'FileIsADirectory'],
	ENOTEMPTY: [409, 'DirectoryNotEmpty'],
	EACCES: [403, 'NoPermissions'],
	EPERM: [403, 'NoPermissions'],
	EXDEV: [409, 'DifferentFilesystem'],
	ENOSPC: [507, 'StorageFull'],
};

// Parses a byte range specifier (RFC 9110 section 14.1.2) against a known representation size.
// Returns `undefined` when the whole representation should be served, `{ start, end }` for a
// satisfiable single range, and `null` when the request is a byte range that cannot be
// satisfied. Anything that is not one satisfiable byte range serves the whole representation:
// a server MAY ignore Range, and multi-range requests are not worth a multipart response here.
function byteRange(header, size) {
	const match = /^bytes=(\d*)-(\d*)$/.exec(header);
	if (!match || (!match[1] && !match[2])) {
		return undefined;
	}
	// No byte range of a zero length representation can be satisfied: a 206 part needs both a
	// first-pos and a last-pos, so every range request for an empty attachment is rejected. This
	// guard is load bearing even though the suffix branch below would also fail for size 0: it
	// keeps the rejection independent of how the arithmetic happens to round.
	if (size === 0) {
		return null;
	}
	if (!match[1]) {
		// A suffix-range is satisfiable only with a non-zero suffix-length, so `bytes=-0` is
		// rejected instead of being widened to the whole representation.
		const suffix = Number(match[2]);
		if (!(suffix > 0)) {
			return null;
		}
		// A suffix longer than the representation selects the entire representation.
		return { start: Math.max(0, size - suffix), end: size - 1 };
	}
	const start = Number(match[1]);
	if (start >= size) {
		return null;
	}
	const last = match[2] ? Number(match[2]) : size - 1;
	// A last-pos before the first-pos selects no bytes, so the range is unsatisfiable; a
	// last-pos at or beyond the end simply means "the remainder of the representation".
	if (last < start) {
		return null;
	}
	return { start, end: Math.min(last, size - 1) };
}

async function sendFile(ctx, file, path) {
	const expectedEtag = ctx.get('If-Match');
	if (expectedEtag && !ifMatchHolds(expectedEtag, file.etag)) {
		await file.close();
		throw new WorkspaceError(412, 'FileChanged');
	}
	const ifRange = ctx.get('If-Range');
	const header = ifRange && ifRange !== file.etag ? '' : ctx.get('Range');
	const range = header ? byteRange(header, file.size) : undefined;
	const ext = extname(path).toLowerCase();
	ctx.type = safeInline.has(ext) ? ext : 'application/octet-stream';
	ctx.set('Content-Security-Policy', "sandbox; default-src 'none'");
	ctx.set('X-Content-Type-Options', 'nosniff');
	ctx.set('Accept-Ranges', 'bytes');
	ctx.set('ETag', file.etag);
	if (range === null) {
		await file.close();
		ctx.set('Content-Range', `bytes */${file.size}`);
		// Without an explicit length the framework would fall back to sending the status text as
		// the body, which would make a rejected range look like a successful empty download.
		ctx.length = 0;
		ctx.status = 416;
		return;
	}
	if (range) {
		ctx.set('Content-Range', `bytes ${range.start}-${range.end}/${file.size}`);
	}
	const body = ctx.method === 'HEAD' ? undefined : await file.stream(range);
	ctx.length = range ? range.end - range.start + 1 : file.size;
	ctx.status = range ? 206 : 200;
	if (body) {
		ctx.body = body;
	} else {
		await file.close();
	}
}

async function readTrashBatch(ctx) {
	if (!ctx.is('application/json')) {
		throw new WorkspaceError(415, 'InvalidContentType');
	}
	const chunks = [];
	let size = 0;
	for await (const chunk of ctx.req) {
		size += chunk.length;
		if (size > 1024 * 1024) {
			throw new WorkspaceError(413, 'RequestTooLarge');
		}
		chunks.push(chunk);
	}
	try {
		const ids = JSON.parse(Buffer.concat(chunks).toString('utf8'));
		if (Array.isArray(ids) && ids.length && ids.every(id => typeof id === 'string')) {
			return ids;
		}
	} catch (error) {
		if (!(error instanceof SyntaxError)) {
			throw error;
		}
	}
	throw new WorkspaceError(400, 'InvalidTrashId');
}

export async function serveWorkspaceFile(ctx, workspace, maxBytes) {
	try {
		// Authorization runs before every parameter check, so an unauthorized caller
		// cannot learn the request shape from a 400/415/405 response.
		const rawPath = ctx.path.slice(mountPath.length);
		const capability = capabilityForRequest(ctx.method, ctx.query, { isRoot: rawPath === '' || rawPath === '/' });
		if (capability !== undefined) {
			if (!workspace.require) {
				throw new Error('The workspace must be wrapped by authorizeWorkspace().');
			}
			workspace.require(capability);
		}
		const path = decodeURIComponent(rawPath);
		const isRoot = path === '' || path === '/';
		if ((ctx.query.restoreVersion !== undefined || ctx.query.restoreTrash !== undefined || ctx.query.restoreTrashBatch !== undefined) && ctx.method !== 'POST') {
			ctx.set('Allow', 'POST');
			ctx.status = 405;
			return;
		}
		if ((ctx.query.trash !== undefined || ctx.query.versions !== undefined || ctx.query.revision !== undefined) && ctx.method !== 'GET' && ctx.method !== 'HEAD') {
			ctx.set('Allow', 'GET, HEAD');
			ctx.status = 405;
			return;
		}
		switch (ctx.method) {
			case 'GET':
			case 'HEAD':
				if (ctx.query.capabilities === '1' && isRoot) {
					ctx.body = {
						versionHistory: typeof workspace.listVersions === 'function',
						versionRestore: typeof workspace.restoreRevision === 'function',
						recycleBin: typeof workspace.listTrash === 'function',
						// Body-text search is derived data, so a backend that predates it simply
						// does not advertise it and the client leaves the search surface alone.
						search: typeof workspace.searchDocuments === 'function',
					};
				} else if (ctx.query.trash === '1' && isRoot) {
					if (!workspace.listTrash) {
						throw new WorkspaceError(404, 'FileNotFound');
					}
					ctx.body = await workspace.listTrash();
				} else if (ctx.query.versions === '1') {
					if (!workspace.listVersions) {
						throw new WorkspaceError(404, 'FileNotFound');
					}
					ctx.body = await workspace.listVersions(path);
				} else if (ctx.query.revision !== undefined) {
					if (typeof ctx.query.revision !== 'string') {
						throw new WorkspaceError(400, 'InvalidRevision');
					}
					if (!workspace.openRevision) {
						throw new WorkspaceError(404, 'FileNotFound');
					}
					await sendFile(ctx, await workspace.openRevision(path, ctx.query.revision), path);
				} else if (ctx.query.stat !== undefined) {
					ctx.body = await workspace.stat(path);
				} else if (ctx.query.files === '1') {
					const limit = Math.min(20_000, Number(ctx.query.limit ?? 20_000));
					if (!Number.isSafeInteger(limit) || limit < 1) {
						throw new WorkspaceError(400, 'InvalidLimit');
					}
					const pattern = typeof ctx.query.pattern === 'string' ? ctx.query.pattern : '';
					ctx.body = await workspace.listFiles(path, pattern, limit);
				} else if (ctx.query.readdir !== undefined) {
					ctx.body = await workspace.readDirectory(path);
				} else {
					await sendFile(ctx, await workspace.openRead(path), path);
				}
				return;
			case 'PUT': {
				if (!ctx.is('application/octet-stream')) {
					throw new WorkspaceError(415, 'InvalidContentType');
				}
				const length = ctx.get('Content-Length');
				if (length && Number(length) > maxBytes) {
					throw new WorkspaceError(413, 'FileTooLarge');
				}
				const result = await workspace.writeFile(path, ctx.req, {
					create: ctx.query.create === '1',
					overwrite: ctx.query.overwrite === '1',
					etag: ctx.get('If-Match'),
					maxBytes,
				});
				ctx.set('ETag', result.etag);
				ctx.body = result;
				ctx.status = result.created ? 201 : 200;
				return;
			}
			case 'POST':
				if (ctx.query.restoreVersion !== undefined) {
					if (!workspace.restoreRevision) {
						throw new WorkspaceError(404, 'FileNotFound');
					}
					if (typeof ctx.query.restoreVersion !== 'string') {
						throw new WorkspaceError(400, 'InvalidRevision');
					}
					const result = await workspace.restoreRevision(path, ctx.query.restoreVersion, ctx.get('If-Match'));
					ctx.set('ETag', result.etag);
					ctx.body = result;
					return;
				}
				if (ctx.query.restoreTrashBatch !== undefined) {
					if (!workspace.restoreTrashBatch || !isRoot || ctx.query.restoreTrashBatch !== '1') {
						throw new WorkspaceError(404, 'FileNotFound');
					}
					ctx.body = await workspace.restoreTrashBatch(await readTrashBatch(ctx));
					return;
				}
				if (ctx.query.restoreTrash !== undefined && isRoot) {
					if (!workspace.restoreTrash) {
						throw new WorkspaceError(404, 'FileNotFound');
					}
					if (typeof ctx.query.restoreTrash !== 'string') {
						throw new WorkspaceError(400, 'InvalidTrashId');
					}
					ctx.body = await workspace.restoreTrash(ctx.query.restoreTrash, ctx.query.keepBoth === '1');
					return;
				}
				if (ctx.query.mkdir === '1') {
					await workspace.createDirectory(path);
				} else if (typeof ctx.query.rename === 'string' && ctx.query.rename.length > 0) {
					await workspace.rename(path, ctx.query.rename, ctx.query.overwrite === '1');
				} else {
					throw new WorkspaceError(400, 'InvalidOperation');
				}
				ctx.status = 204;
				return;
			case 'DELETE':
				if (ctx.query.trashId !== undefined && typeof ctx.query.trashId !== 'string') {
					throw new WorkspaceError(400, 'InvalidTrashId');
				}
				await workspace.delete(path, ctx.query.recursive === '1', ctx.query.trashId);
				ctx.status = 204;
				return;
			default:
				ctx.set('Allow', 'GET, HEAD, PUT, POST, DELETE');
				ctx.status = 405;
		}
	} catch (error) {
		const result = error instanceof WorkspaceError ? [error.status, error.code]
			: error instanceof URIError ? [400, 'InvalidPath'] : fileErrors[error.code];
		if (!result) {
			throw error;
		}
		const [status, code] = result;
		ctx.body = { error: code };
		ctx.status = status;
	}
}
