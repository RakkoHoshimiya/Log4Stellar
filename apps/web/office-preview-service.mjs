// Service layer for Office previews (05-Office文件预览.md §3, §4, §5).
//
// The layering is deliberate: this module owns the *order* of the decisions, the
// store owns the database states, the worker owns the child process and the blob store
// owns the derived bytes. Nothing here touches the workspace object store for writing,
// so "预览流程不写原件" (§3 read-only result) holds by construction.
//
// It is dependency-injected on purpose: every collaborator is passed in, so a unit test
// can drive the whole state machine with a fake clock, a fake converter and an
// in-memory store, and the integration test can use the real ones.

import { randomUUID } from 'node:crypto';
import { WorkspaceError } from './workspace-contract.mjs';
import {
	officePreviewErrorCodes as codes,
	officePreviewStates as states,
	attemptObjectKey,
	convertibleFormatOf,
	extensionOf,
	invalidRequest,
	fileTooLarge,
	makePreviewKey,
	notReady,
	previewNotFound,
	unsupportedFormat,
	officePreviewLimits,
	renderProfileFingerprint,
	officeConverterPath,
} from './office-preview-contract.mjs';
import { runPreviewJob } from './office-preview-worker.mjs';

const fileIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * §5 `resolvePreviewSource`: the single place where a request turns into authoritative
 * metadata. `fileId` and `revisionId` must belong to the same file in this workspace,
 * the digest comes from the version row and never from the client, and the extension
 * decides whether the format is convertible at all. A viewer of the workspace may ask
 * for any *existing* revision: that is exactly the version history right they already
 * have.
 */
export async function resolvePreviewSource({ store, workspaceId, fileId, path, revisionId }) {
	if (revisionId !== undefined && (typeof revisionId !== 'string' || !fileIdPattern.test(revisionId))) {
		throw invalidRequest();
	}
	let source;
	if (fileId !== undefined) {
		if (typeof fileId !== 'string' || !fileIdPattern.test(fileId)) {
			throw invalidRequest();
		}
		source = revisionId === undefined
			? await store.currentVersionSource(workspaceId, fileId)
			: await store.findVersionSource(workspaceId, fileId, revisionId);
	} else if (typeof path === 'string' && path.startsWith('/')) {
		// The web entry point knows the file's path (it lives in a file tree), not its
		// `fileId`; the identity is resolved here, on the server, so a client can never
		// name a digest or a storage key (§4 "前端不能提供 SHA 或对象路径").
		source = await store.sourceByPath(workspaceId, path, revisionId);
	} else {
		throw invalidRequest();
	}
	if (!source) {
		throw previewNotFound();
	}
	const extension = extensionOf(source.path ?? '');
	// The path may be absent when a file was replaced in place; the format check then
	// has no name to look at, so the request is refused rather than converted blindly.
	if (!convertibleFormatOf(source.path ?? '')) {
		throw unsupportedFormat();
	}
	return { ...source, extension };
}

/**
 * §3 `requestOfficePreview`. Returns `{ preview, status }` where status is 200 for a
 * ready entry and 202 for anything that still has to be converted. The dedupe key makes
 * this idempotent: a repeated request for the same version returns the same id, and a
 * concurrent one cannot start a second job.
 */
export async function requestOfficePreview({
	store,
	limits,
	profileFingerprint = renderProfileFingerprint(),
	workspaceId,
	fileId,
	path,
	revisionId,
	nowMs = Date.now(),
}) {
	const source = await resolvePreviewSource({ store, workspaceId, fileId, path, revisionId });
	// Reject an oversized original *before* creating a row: a 4 GiB file must not even
	// occupy a queue slot (§4 FileTooLarge -> 413).
	if (source.sizeBytes > limits.maxInputBytes) {
		throw fileTooLarge();
	}
	const previewKey = makePreviewKey(source, profileFingerprint);
	const preview = await store.getOrEnqueuePreview({
		source,
		profileFingerprint,
		previewKey,
		maxQueued: limits.maxQueued,
		nowMs,
	});
	if (preview.state === states.ready) {
		return { preview, status: 200 };
	}
	if (preview.state === states.failed && !preview.retryable) {
		// A permanent failure is reported as the classified error code, with 415 for the
		// content problems so the UI can offer the original download (§4).
		const status = preview.errorCode === codes.fileTooLarge || preview.errorCode === codes.resourceLimit ? 413 : 415;
		const error = new WorkspaceError(status, preview.errorCode ?? codes.unavailable);
		error.preview = preview;
		throw error;
	}
	return { preview, status: 202 };
}

/**
 * One worker cycle: recover expired leases, take the deployment wide slot, claim the
 * oldest job, convert it and publish. Returns `{ claimed }` so a supervisor can decide
 * whether to keep looping.
 *
 * The order inside the attempt is the order the task book requires (§3, §5):
 * convert -> verify -> reserve cache budget (evicting if needed) -> upload to the
 * attempt key -> publish metadata atomically. A worker that loses its lease before the
 * publish deletes its own object and changes nothing, because the key is attempt
 * specific and nobody else can be reading it.
 */
export async function runPreviewCycle({
	store,
	blobs,
	limits,
	workerId = 'office-preview-worker-' + randomUUID(),
	converterPath = officeConverterPath(),
	cacheDirectory,
	openOriginal,
	nowMs = Date.now(),
	logger,
}) {
	// Recover before claiming so a crashed worker's row is available immediately.
	await store.releaseExpiredLeases(nowMs, limits.maxAttempts);
	const job = await store.claimPreviewJob({
		workerId,
		leaseMs: limits.leaseMs,
		maxAttempts: limits.maxAttempts,
		nowMs,
	});
	if (!job) {
		return { claimed: false };
	}

	const objectKey = attemptObjectKey(job.previewKey, job.attemptId);
	const started = Date.now();
	let uploaded = false;
	try {
		const result = await runPreviewJob({
			job: {
				extension: extensionOf(job.sourcePath ?? '') || '.docx',
				objectKey,
				maxInputBytes: limits.maxInputBytes,
			},
			openSource: () => openOriginal(job),
			blobs,
			converterPath,
			timeoutMs: limits.timeoutMs,
			maxOutputBytes: limits.maxOutputBytes,
			cacheDirectory,
		});
		uploaded = true;

		// §5 "先预留，再上传，再发布元数据": the budget is reserved before the bytes are
		// counted as published, and the eviction candidates come from the store so only
		// derived previews of this workspace are ever considered.
		let reservation = await store.reserveCache({
			previewId: job.previewId,
			attemptId: job.attemptId,
			bytes: result.size,
			budgetBytes: limits.cacheBytes,
			nowMs,
		});
		if (!reservation.ok && limits.cacheBytes > 0) {
			await blobs.evict({
				wantedBytes: result.size,
				budgetBytes: limits.cacheBytes,
				listCandidates: () => store.evictionCandidates(job.workspaceId),
				markEvicted: candidate => store.markEvicted(candidate.previewId, nowMs),
				keep: candidate => candidate.previewId === job.previewId,
			});
			reservation = await store.reserveCache({
				previewId: job.previewId,
				attemptId: job.attemptId,
				bytes: result.size,
				budgetBytes: limits.cacheBytes,
				nowMs,
			});
		}
		if (!reservation.ok) {
			// Even after eviction the budget cannot hold this document. The attempt is
			// failed as a resource limit instead of publishing an unaccounted object.
			const error = new WorkspaceError(413, codes.resourceLimit);
			error.retryable = false;
			throw error;
		}

		const published = await store.finalizePreview({
			previewId: job.previewId,
			attemptId: job.attemptId,
			objectKey,
			sizeBytes: result.size,
			nowMs: Date.now(),
		});
		if (!published) {
			// Lost the lease while converting: another worker owns the row now. Delete our
			// own attempt object; the winner publishes under its own key.
			await blobs.remove(objectKey).catch(() => {});
			uploaded = false;
			logger?.({ event: 'office-preview-lease-lost', previewId: job.previewId, attemptId: job.attemptId });
			return { claimed: true, published: false };
		}
		logger?.({
			event: 'office-preview-ready',
			previewId: job.previewId,
			attemptId: job.attemptId,
			bytes: result.size,
			conversionMs: result.durationMs,
			attemptMs: Date.now() - started,
		});
		return { claimed: true, published: true, preview: published };
	} catch (error) {
		if (uploaded) {
			await blobs.remove(objectKey).catch(() => {});
		}
		const code = error instanceof WorkspaceError ? error.code : codes.unavailable;
		const retryable = error?.retryable ?? (error instanceof WorkspaceError && code === codes.unavailable);
		const outcome = await store.failPreviewAttempt({
			previewId: job.previewId,
			attemptId: job.attemptId,
			errorCode: code,
			retryable,
			maxAttempts: limits.maxAttempts,
			nowMs: Date.now(),
		}).catch(() => undefined);
		logger?.({
			event: 'office-preview-failed',
			previewId: job.previewId,
			attemptId: job.attemptId,
			error: code,
			retryable,
			state: outcome?.state,
			attemptMs: Date.now() - started,
		});
		return { claimed: true, published: false, error: code, retryable };
	} finally {
		// The slot is per conversion, not per worker lifetime: releasing it here is what
		// lets the next cycle (or another node) start as soon as this one is done.
		await store.releaseSlot(workerId).catch(() => {});
	}
}

/**
 * §4 `GET /api/v1/office-previews/:id` — the poll endpoint. Returns the public shape
 * only: id, state, revisionId and a classified error. It never returns an object key,
 * a path, a command line or a converter message.
 */
export function publicPreview(preview) {
	if (!preview) {
		throw previewNotFound();
	}
	const body = {
		id: preview.previewId,
		state: preview.state,
		revisionId: preview.revisionId,
		fileId: preview.fileId,
		createdAt: new Date(preview.createdMs).toISOString(),
		updatedAt: new Date(preview.updatedMs).toISOString(),
	};
	if (preview.state === states.failed && preview.errorCode) {
		body.error = preview.errorCode;
		body.retryable = preview.retryable === true;
	}
	if (preview.state === states.ready) {
		body.size = preview.sizeBytes;
	}
	return body;
}

/**
 * Status of one preview, re-checked against the workspace. A preview id is not a
 * capability (§4): the caller must have read the workspace, and the row must still
 * belong to it, so a re-shared id from another workspace is a plain 404.
 */
export async function previewStatus({ store, workspaceId, previewId }) {
	const preview = await store.getPreview(workspaceId, previewId);
	return publicPreview(preview);
}

/**
 * A ready PDF, or the classified "not ready" error. The bytes are opened from the
 * derived store, and the size recorded in the database is checked against the object so
 * a truncated file is reported as a rebuild candidate instead of being streamed.
 */
export async function openPreviewPdf({ store, blobs, workspaceId, previewId, range }) {
	const preview = await store.getPreviewByObject(workspaceId, previewId);
	if (!preview) {
		throw previewNotFound();
	}
	if (preview.state === states.evicted) {
		// The tombstone says the bytes are gone: re-queue instead of pretending to serve.
		throw notReady();
	}
	if (preview.state !== states.ready || !preview.objectKey) {
		throw notReady();
	}
	let file;
	try {
		file = await blobs.open(preview.objectKey, preview.sizeBytes, range);
	} catch (error) {
		if (error instanceof WorkspaceError && error.code === 'StorageObjectMissing') {
			// §5: a missing object behind a ready row is exactly the "淘汰或异常删除后按需
			// 重建" case. Mark the row evicted so the next request re-queues it, then answer
			// 409 rather than a confusing 502.
			await store.markEvicted(preview.previewId).catch(() => {});
			throw notReady();
		}
		throw error;
	}
	return { preview, file };
}

/** Re-check that the file and revision still exist before streaming bytes. */
export async function assertSourceStillReadable({ store, workspaceId, preview }) {
	if (!preview?.fileId || !preview?.revisionId) {
		throw notReady();
	}
	const exists = await store.versionExists(workspaceId, preview.fileId, preview.revisionId);
	if (!exists) {
		throw previewNotFound();
	}
}

/**
 * Limits with the profile fingerprint already resolved — the HTTP layer needs both and
 * must not compute them differently from the worker.
 */
export function previewSettings(environment = process.env) {
	return {
		limits: officePreviewLimits(environment),
		profileFingerprint: renderProfileFingerprint(environment),
		converterPath: officeConverterPath(environment),
	};
}
