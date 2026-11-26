// Deployment wiring for Office previews (05-Office文件预览.md §2, §4, §6).
//
// This is the only module that decides whether the feature exists in a running process.
// When `LOG4STELLAR_OFFICE_PREVIEW` is not explicitly enabled it resolves to `undefined`,
// the gateway is never given an `openOfficePreview` function, and `/api/v1/office-previews`
// stays a path the static application serves — the route behaves as if the code had never
// shipped. That is "功能开关默认关闭，可按部署启用" enforced in one place instead of scattered
// `if (enabled)` checks.
//
// The collaborators are opened lazily and shared per process: one PostgreSQL pool and one
// derived object directory, independent of the number of workspaces, because a preview is
// scoped by the `workspace_id` column rather than by a pool.

import {
	officeConverterPath,
	officePreviewEnabled,
	officePreviewLimits,
	renderProfileFingerprint,
} from './office-preview-contract.mjs';
import { openOfficePreviewStore } from './office-preview-store.mjs';
import { openPreviewBlobs, previewCacheRoot } from './office-preview-blobs.mjs';
import { openOriginalFor } from './office-preview-runner.mjs';
import { runPreviewCycle } from './office-preview-service.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * @param {object} options
 * @param {object} [options.environment] process environment (injectable for a test).
 * @param {string} [options.cacheDirectory] derived PDF root; defaults to a private /tmp path.
 * @param {object} [options.workspaces] `createWorkspaceBackends()` cache, required by startWorker.
 * @returns `undefined` when the feature is off, otherwise the runtime described below.
 */
export async function openOfficePreviewRuntime({ environment = process.env, cacheDirectory, workspaces, logger } = {}) {
	if (!officePreviewEnabled(environment)) {
		return undefined;
	}
	const limits = officePreviewLimits(environment);
	const profileFingerprint = renderProfileFingerprint(environment);
	const converterPath = officeConverterPath(environment);
	const directory = cacheDirectory ?? previewCacheRoot(environment);

	let opening;
	const open = async () => {
		opening ??= (async () => {
			const store = await openOfficePreviewStore(environment);
			const blobs = await openPreviewBlobs({ directory, maxBytes: limits.maxOutputBytes });
			// A crash between "upload" and "publish" leaves attempt specific objects no row
			// references. Removing them at start up is the only safe cleanup, because a live
			// attempt's key is unreadable by anyone else until it publishes (§3).
			await blobs.sweep().catch(error => logger?.({ event: 'office-preview-sweep-failed', error: error.code }));
			return { store, blobs };
		})();
		return opening;
	};

	return {
		/**
		 * The per request scope the HTTP layer expects. It deliberately carries no function
		 * that reads an original: the bytes are read by the worker from the revision recorded
		 * in the row, so an HTTP request can never name a file to convert.
		 */
		async openScope({ workspaceId }) {
			const { store, blobs } = await open();
			return { store, blobs, workspaceId, limits, profileFingerprint };
		},

		/**
		 * Starts the conversion loop in this process. Off by default at the call site: the
		 * pilot runs `office-preview-runner.mjs` as a separate process so a conversion cannot
		 * compete with request handling for memory. Offered here for a single box deployment
		 * and for tests.
		 */
		startWorker({ idleMs = 1000 } = {}) {
			if (!workspaces) {
				throw new Error('The preview worker needs a workspace backend cache.');
			}
			const workerId = 'office-preview-worker-' + process.pid;
			// The backend lease is acquired and released per cycle, so the workspace cache is
			// never pinned by an idle worker.
			let stopped = false;
			const running = (async () => {
				while (!stopped) {
					let leasedWorkspace;
					try {
						const { store, blobs } = await open();
						const openOriginal = openOriginalFor(async id => {
							const backend = await workspaces.acquire(id);
							leasedWorkspace = id;
							return backend;
						}, limits);
						const outcome = await runPreviewCycle({
							store,
							blobs,
							limits,
							workerId,
							converterPath,
							cacheDirectory: directory,
							openOriginal,
							nowMs: Date.now(),
							logger,
						});
						if (!outcome.claimed) {
							await sleep(idleMs);
						}
					} catch (error) {
						logger?.({ event: 'office-preview-cycle-failed', error: error.code ?? error.message });
						await sleep(idleMs);
					} finally {
						if (leasedWorkspace) {
							workspaces.release(leasedWorkspace);
						}
					}
				}
			})();
			// An unhandled rejection here would take the server down for a data problem.
			running.catch(error => logger?.({ event: 'office-preview-worker-stopped', error: error.code }));
			return {
				stop() {
					stopped = true;
					return running;
				},
			};
		},

		limits,
		profileFingerprint,
		converterPath,
		directory,

		/** Opens everything without serving a request (used by the in-process worker). */
		asWorkerCollaborators() {
			return open();
		},

		async close() {
			const opened = await opening?.catch(() => undefined);
			await opened?.store?.close?.().catch(() => {});
		},
	};
}
