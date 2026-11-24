// Worker entry point and the only bridge from a claimed job to the original bytes
// (05-Office文件预览.md §2, §3, §5).
//
// Two things live here that must not live in the HTTP layer:
//
//   * `openOriginalFor`, the single function that reads an *original* document. It opens
//     the exact revision recorded in the preview row through the already authorized
//     workspace backend and bounds the copy by the input budget. No write method of that
//     backend is ever called from here, which is what makes the task book's "只读结果"
//     requirement structural rather than a promise.
//   * `runPreviewWorker`, the loop a deployment starts next to the web server. One worker
//     is the pilot configuration; a second one on another node simply never wins the
//     deployment wide conversion slot, so "1/3/5 并发只产生一个转换任务" holds across
//     processes, not just inside one.
//
// The CLI exits non-zero only for configuration problems: a document that fails to
// convert is data, not a crash.

import { WorkspaceError } from './workspace-contract.mjs';
import { officePreviewErrorCodes as codes, officePreviewLimits } from './office-preview-contract.mjs';
import { openOfficePreviewStore } from './office-preview-store.mjs';
import { openPreviewBlobs, previewCacheRoot } from './office-preview-blobs.mjs';
import { openRustfsWorkspace } from './rustfs-workspace.mjs';
import { previewSettings, runPreviewCycle } from './office-preview-service.mjs';

/**
 * Collects a bounded original into memory. A conversion needs the bytes on disk anyway and
 * the input budget is 25 MiB, so a buffer keeps "no partial read is ever converted" true
 * without a second copy of the file on disk.
 */
export async function collectOriginal(stream, maxBytes) {
	const chunks = [];
	let total = 0;
	for await (const chunk of stream) {
		total += chunk.length;
		if (total > maxBytes) {
			// The row said one size and the object store returned more, or the file grew
			// between enqueue and claim: refuse rather than convert a truncated document.
			throw Object.assign(new WorkspaceError(413, codes.fileTooLarge), { retryable: false });
		}
		chunks.push(chunk);
	}
	return Buffer.concat(chunks);
}

/**
 * Reads the exact revision of the exact file a preview row was created for.
 *
 * `job.sourcePath` and `job.revisionId` both come from the database — never from a
 * request — so a queued row cannot be steered at another file.
 */
export function openOriginalFor(openBackend, { maxInputBytes }) {
	return async function openOriginal(job) {
		if (!job?.sourcePath || !job?.revisionId) {
			// The file left the tree between enqueue and claim, so a retry would fail the
			// same way forever.
			throw Object.assign(new WorkspaceError(404, codes.notFound), { retryable: false });
		}
		const backend = await openBackend(job.workspaceId);
		const file = await backend.openRevision(job.sourcePath, job.revisionId);
		try {
			// `stream()` is async in this codebase: the storage backends return a promise
			// for the readable (the mount route hands the promise to Koa). Awaiting a
			// non-thenable is a no-op, so this works for both shapes.
			return await collectOriginal(await file.stream(), maxInputBytes);
		} finally {
			await file.close?.();
		}
	};
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * The supervisor loop. Never throws for a conversion failure: `runPreviewCycle` writes
 * those into the row and returns an outcome.
 */
export async function runPreviewWorker({
	store,
	blobs,
	openBackend,
	limits = officePreviewLimits(),
	settings = previewSettings(),
	workerId = 'office-preview-worker-' + process.pid,
	cacheDirectory = previewCacheRoot(),
	converterPath,
	idleMs = 1000,
	maxCycles = Infinity,
	logger = line => console.log(JSON.stringify(line)),
	signal,
}) {
	let cycles = 0;
	let claimed = 0;
	while (cycles < maxCycles && !signal?.aborted) {
		const outcome = await runPreviewCycle({
			store,
			blobs,
			limits,
			workerId,
			converterPath: converterPath ?? settings.converterPath,
			cacheDirectory,
			openOriginal: openOriginalFor(openBackend, limits),
			nowMs: Date.now(),
			logger,
		});
		cycles += 1;
		if (outcome.claimed) {
			claimed += 1;
		} else {
			// Nothing queued (or another node holds the slot). Do not spin.
			await sleep(idleMs);
		}
	}
	return { cycles, claimed };
}

/**
 * Opens everything, runs the loop once (or to completion) and closes what it opened. Used
 * by the CLI and by the integration test.
 */
export async function runPreviewWorkerOnce({
	environment = process.env,
	workspaceId,
	maxCycles = 1,
	cacheDirectory,
	idleMs,
	logger,
	signal,
} = {}) {
	if (!workspaceId) {
		throw new Error('The preview worker needs a workspace id (the storage workspace).');
	}
	const limits = officePreviewLimits(environment);
	const store = await openOfficePreviewStore(environment);
	const blobs = await openPreviewBlobs({
		directory: cacheDirectory ?? previewCacheRoot(environment),
		maxBytes: limits.maxOutputBytes,
	});
	// One backend, reused across cycles: the worker is single concurrency by design.
	const backend = await openRustfsWorkspace(workspaceId);
	try {
		// A worker that starts after a crash must remove the leftovers of the attempt that
		// died, and it must not count `*.part` files against the cache budget.
		await blobs.sweep().catch(() => {});
		return await runPreviewWorker({
			store,
			blobs,
			openBackend: async () => backend,
			limits,
			maxCycles,
			cacheDirectory,
			idleMs,
			logger,
			signal,
		});
	} finally {
		await backend.close?.().catch(() => {});
		await store.close?.().catch(() => {});
	}
}

async function main() {
	const workspaceId = process.argv[2] ?? process.env.LOG4STELLAR_STORAGE_WORKSPACE;
	if (!workspaceId) {
		console.error('usage: office-preview-runner.mjs <workspace-id>');
		process.exitCode = 2;
		return;
	}
	const controller = new AbortController();
	const stop = () => controller.abort();
	process.on('SIGTERM', stop);
	process.on('SIGINT', stop);
	try {
		await runPreviewWorkerOnce({ workspaceId, maxCycles: Infinity, signal: controller.signal });
	} finally {
		process.off('SIGTERM', stop);
		process.off('SIGINT', stop);
	}
}

if (process.argv[1] && import.meta.url === new URL('file://' + process.argv[1]).href) {
	await main();
}
