// HTTP layer for the Office preview API (05-Office文件预览.md §4).
//
// Three routes only:
//   POST /api/v1/office-previews            -> 200 ready | 202 queued | 4xx classified
//   GET  /api/v1/office-previews/:id        -> { id, state, revisionId, error? }
//   GET  /api/v1/office-previews/:id/pdf    -> application/pdf (206 for a byte range)
//
// The gate order is copied from git-files.mjs on purpose: the capability is required
// *before* the body is read, the query is parsed or a path parameter is decoded, so an
// unauthorized caller cannot use the error code to probe which previews exist. Every
// response is JSON except the PDF itself, and no response ever carries an object key, a
// local path, a command line or a converter message.

import { randomUUID } from 'node:crypto';
import { WorkspaceError } from './workspace-contract.mjs';
import { workspaceCapabilities as capabilities } from './workspace-access.mjs';
import {
	officePreviewPath,
	officePreviewErrorCodes as codes,
	officePreviewStates as states,
	isValidPreviewId,
	invalidRequest,
	previewCacheControl,
} from './office-preview-contract.mjs';
import {
	openPreviewPdf,
	previewStatus,
	requestOfficePreview,
} from './office-preview-service.mjs';

// The route prefix lives in the contract module, but the gateway only ever talks to
// this one, so it is re-exported here rather than imported twice.
export { officePreviewPath };

const maxBodyBytes = 64 * 1024;

/**
 * Same semantics as workspace-files.mjs `byteRange`, kept local because that one is
 * private to the file route: `undefined` means "serve the whole representation",
 * `{ start, end }` is a satisfiable range, `null` is an unsatisfiable one.
 */
export function byteRange(header, size) {
	const match = /^bytes=(\d*)-(\d*)$/.exec(header);
	if (!match || (!match[1] && !match[2])) {
		return undefined;
	}
	if (size === 0) {
		return null;
	}
	if (!match[1]) {
		const suffix = Number(match[2]);
		if (!(suffix > 0)) {
			return null;
		}
		return { start: Math.max(0, size - suffix), end: size - 1 };
	}
	const start = Number(match[1]);
	if (start >= size) {
		return null;
	}
	const last = match[2] ? Number(match[2]) : size - 1;
	if (last < start) {
		return null;
	}
	return { start, end: Math.min(last, size - 1) };
}

/** Parses the identifier out of `/api/v1/office-previews/<id>[/pdf]`. */
export function previewRoute(path) {
	if (path === officePreviewPath || path === officePreviewPath + '/') {
		return { kind: 'collection' };
	}
	if (!path.startsWith(officePreviewPath + '/')) {
		return undefined;
	}
	const rest = path.slice(officePreviewPath.length + 1);
	const segments = rest.split('/');
	if (segments.length === 1 && segments[0]) {
		return { kind: 'status', previewId: segments[0] };
	}
	if (segments.length === 2 && segments[0] && segments[1] === 'pdf') {
		return { kind: 'pdf', previewId: segments[0] };
	}
	return undefined;
}

async function readJson(ctx) {
	if (!ctx.is('application/json')) {
		throw new WorkspaceError(415, codes.invalidContentType);
	}
	const chunks = [];
	let size = 0;
	for await (const chunk of ctx.req) {
		size += chunk.length;
		if (size > maxBodyBytes) {
			throw new WorkspaceError(413, codes.requestTooLarge);
		}
		chunks.push(chunk);
	}
	const text = Buffer.concat(chunks).toString('utf8');
	if (!text.trim()) {
		throw invalidRequest();
	}
	let value;
	try {
		value = JSON.parse(text);
	} catch {
		throw invalidRequest();
	}
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		throw invalidRequest();
	}
	return value;
}

/**
 * §4 error body is `{ error, requestId }`. The request id is generated per request and
 * also sent as `X-Request-Id`, so a log line and a user report can be matched without
 * ever putting a file path in the response.
 */
function respond(ctx, status, body) {
	ctx.status = status;
	ctx.body = body;
	ctx.set('X-Request-Id', body.requestId);
	return ctx;
}

/**
 * Serves one preview request. `scope` carries the already constructed collaborators:
 * `{ store, blobs, workspaceId, limits, profileFingerprint, openOriginal }`. Throwing is
 * reserved for programming errors; everything a client can cause is answered here.
 */
export async function serveOfficePreviewRequest(ctx, workspace, scope) {
	const requestId = ctx.get?.('X-Request-Id')?.trim() || randomUUID();
	const route = previewRoute(ctx.path);
	const method = ctx.method;
	const reads = method === 'GET' || method === 'HEAD';

	try {
		if (!workspace.require) {
			throw new Error('The workspace must be wrapped by authorizeWorkspace().');
		}
		if (route === undefined) {
			throw new WorkspaceError(404, 'NotFound');
		}
		if (route.kind === 'collection' && method === 'POST') {
			// Creating a preview reads the original and (with an explicit revision) the
			// version history; it never writes anything, so `read` is the right gate and
			// `history` is added only when a past revision is asked for.
			workspace.require(capabilities.read);
			const body = await readJson(ctx);
			if (body.revisionId !== undefined) {
				workspace.require(capabilities.history);
			}
			const { preview, status } = await requestOfficePreview({
				store: scope.store,
				limits: scope.limits,
				profileFingerprint: scope.profileFingerprint,
				workspaceId: scope.workspaceId,
				// The documented body is `{ fileId, revisionId? }`. A browser file tree knows
				// the path instead of the identity, so `{ path, revisionId? }` is accepted as
				// well and resolved to a `fileId` on the server; the client never supplies a
				// digest or a storage key either way (§4).
				fileId: body.fileId,
				path: body.path,
				revisionId: body.revisionId,
			});
			return respond(ctx, status, {
				id: preview.previewId,
				state: preview.state,
				revisionId: preview.revisionId,
				requestId,
			});
		}

		if (route.kind === 'collection') {
			// Anything but POST on the collection is a method error, not a 404: the route
			// exists, and saying so is not a leak.
			throw new WorkspaceError(405, 'MethodNotAllowed');
		}

		if (!reads) {
			throw new WorkspaceError(405, 'MethodNotAllowed');
		}
		// A viewer may read previews; the row is additionally scoped by workspace inside
		// the service, so an id from another workspace is a 404, never a cross read.
		workspace.require(capabilities.read);

		if (!isValidPreviewId(route.previewId)) {
			// A syntactically impossible id cannot name a row, so this is a 404 rather than
			// a validation error: it keeps "wrong workspace" and "garbage id" identical.
			throw new WorkspaceError(404, 'FileNotFound');
		}
		const previewId = route.previewId.toLowerCase();

		if (route.kind === 'status') {
			const body = await previewStatus({
				store: scope.store,
				workspaceId: scope.workspaceId,
				previewId,
			});
			return respond(ctx, 200, { ...body, requestId });
		}

		// The Range header is only interpretable against the recorded object size, so the
		// row is read first, the bounds are resolved from it, and the stream is opened
		// once with the final range. A HEAD request stops before the stream is created.
		const preview = await scope.store.getPreviewByObject(scope.workspaceId, previewId);
		if (!preview) {
			throw new WorkspaceError(404, codes.notFound);
		}
		if (preview.state === states.evicted) {
			// The tombstone says the bytes are gone: the client must re-request, which
			// re-queues the same version (§5 "淘汰后按需重建").
			throw new WorkspaceError(409, codes.notReady);
		}
		if (preview.state !== states.ready || !preview.objectKey) {
			throw new WorkspaceError(409, codes.notReady);
		}
		const header = ctx.get?.('Range');
		const range = header ? byteRange(header, preview.sizeBytes) : undefined;
		if (header && range === null) {
			ctx.set('Content-Range', `bytes */${preview.sizeBytes}`);
			ctx.set('X-Request-Id', requestId);
			ctx.status = 416;
			ctx.body = { error: 'InvalidRange', requestId };
			return ctx;
		}

		ctx.set('Cache-Control', previewCacheControl);
		ctx.set('X-Content-Type-Options', 'nosniff');
		ctx.set('Content-Security-Policy', "sandbox; default-src 'none'");
		ctx.set('Accept-Ranges', 'bytes');
		ctx.set('X-Request-Id', requestId);
		ctx.type = 'application/pdf';

		if (method === 'HEAD') {
			// A HEAD reports the metadata of the representation it would have sent, so it
			// needs the size but not the bytes and must not touch the object store.
			ctx.status = range ? 206 : 200;
			if (range) {
				ctx.set('Content-Range', `bytes ${range.start}-${range.end}/${preview.sizeBytes}`);
				ctx.length = range.end - range.start + 1;
			} else {
				ctx.length = preview.sizeBytes;
			}
			ctx.body = undefined;
			return ctx;
		}

		let file;
		try {
			file = await scope.blobs.open(preview.objectKey, preview.sizeBytes, range ?? undefined);
		} catch (error) {
			if (error instanceof WorkspaceError && error.code === 'StorageObjectMissing') {
				// §5: a missing object behind a ready row is the "淘汰或异常删除后按需重建"
				// case. Mark the row evicted so the next request re-queues it, and answer 409
				// instead of a confusing 502.
				await scope.store.markEvicted(preview.previewId).catch(() => {});
				throw new WorkspaceError(409, codes.notReady);
			}
			throw error;
		}
		if (range) {
			ctx.status = 206;
			ctx.set('Content-Range', `bytes ${range.start}-${range.end}/${file.size}`);
			ctx.length = range.end - range.start + 1;
		} else {
			ctx.status = 200;
			ctx.length = file.size;
		}
		ctx.body = file.stream;
		return ctx;
	} catch (error) {
		if (error instanceof WorkspaceError) {
			ctx.status = error.status;
			ctx.body = { error: error.code, requestId };
			ctx.set('X-Request-Id', requestId);
			if (error.status === 429) {
				// The queue is full: tell the client how long to wait before retrying
				// instead of letting it hammer the endpoint.
				ctx.set('Retry-After', '5');
			}
			return ctx;
		}
		throw error;
	}
}

/**
 * Resolves a *finished* preview to a byte stream for a caller that already proved its
 * authorization (the extension's download action). Kept separate so the PDF route stays
 * a thin wrapper over it and the streaming rules exist in one place.
 */
export async function streamAuthorizedPreview({ store, blobs, workspaceId, previewId, range }) {
	const { preview, file } = await openPreviewPdf({ store, blobs, workspaceId, previewId, range });
	if (preview.state !== states.ready) {
		throw new WorkspaceError(409, codes.notReady);
	}
	return file;
}
