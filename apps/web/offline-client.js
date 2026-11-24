/**
 * The browser entry point for offline editing (docs/web-offline.md §5).
 *
 * Nothing else in the feature touches `window`, `document` or `fetch`: this module is
 * where the store, the coordinator and the banner are wired to a real page. Keeping that
 * wiring in one place is what lets every other file run unmodified in a Node test and
 * keeps a DOM assumption from leaking into replay logic.
 *
 * It is served at `/api/offline-editing/offline-client.js` and imported by the workbench
 * shell. The workbench reads `window.log4stellarOffline` after the import resolves.
 */

import {
	normalizeOfflineScope,
	offlineEnabled,
	opBlockReasons,
} from './offline-contract.js';
import { openOfflineStore } from './offline-store.js';
import {
	createLeaseManager,
	drainOutbox,
	verifyReplayScope,
} from './offline-coordinator.js';
import {
	documentStatus,
	readCachedDocument,
	writeOfflineDraft,
} from './offline-provider.js';
import {
	offlineBanner,
	outboxRows,
	renderOfflineBanner,
} from './offline-ui.js';

/** The device id the sync API expects; it must be stable across reloads of one tab. */
function deviceId() {
	const key = 'log4stellar.offline.device';
	try {
		const existing = window.localStorage.getItem(key);
		if (existing) {
			return existing;
		}
		const created = 'tab-' + String(Math.random()).slice(2, 10);
		window.localStorage.setItem(key, created);
		return created;
	} catch {
		// A browser that refuses localStorage (private mode, disabled storage) still gets a
		// working session; only the device identity is weaker, and the server treats an
		// unfamiliar device as a new one anyway.
		return 'tab-unbound';
	}
}

/** Asks the server who we are. It is the only network call in this file. */
async function authenticate() {
	const response = await fetch('/api/session', { cache: 'no-store', credentials: 'same-origin' });
	if (!response.ok) {
		return { ok: false, status: response.status };
	}
	const body = await response.json();
	return {
		ok: true,
		origin: window.location.origin,
		accountId: body.accountId,
		tenantId: 'default',
		workspaceId: body.workspaceId,
		expiresMs: Date.now() + (body.remainingMs ?? 0),
	};
}

/**
 * Uploads one operation with the SAME idempotency key it was enqueued with. The key is
 * the reason a lost response produces one version instead of two, so it is read from the
 * stored operation and never minted here.
 */
async function commit(operation) {
	const response = await fetch('/sync/v1/file', {
		method: 'PUT',
		cache: 'no-store',
		credentials: 'same-origin',
		headers: {
			'Content-Type': 'application/json',
			'X-Log4Stellar-Device': operation.deviceId ?? deviceId(),
			'Idempotency-Key': operation.idempotencyKey,
			...(operation.baseRevision ? { 'X-Log4Stellar-Base-Revision': operation.baseRevision } : {}),
		},
		body: JSON.stringify({ path: operation.path, text: operation.text, mode: operation.mode }),
	});
	const body = await response.json().catch(() => ({}));
	return { status: response.status, body };
}

/**
 * Builds the offline controller for the current page. Returns `undefined` when offline
 * editing is not available (a shared browser, or no account), so the caller can simply
 * skip rendering instead of catching an exception on every keystroke.
 */
export async function createOfflineController({ root, sharedDevice = false, indexedDB = window.indexedDB } = {}) {
	const session = await authenticate();
	if (!session.ok) {
		return undefined;
	}
	const scope = normalizeOfflineScope({
		origin: session.origin,
		accountId: session.accountId,
		tenantId: session.tenantId,
		workspaceId: session.workspaceId,
		sharedDevice,
	});
	if (!offlineEnabled(scope)) {
		return undefined;
	}

	const store = await openOfflineStore({ scope, indexedDB });
	const lease = createLeaseManager({ store, writerId: deviceId() });

	async function refresh() {
		const [operations, scopeRecord, drafts] = await Promise.all([
			store.listOutbox(),
			store.readScopeRecord(),
			store.listDrafts(),
		]);
		const view = offlineBanner({ operations, scopeRecord, drafts, online: navigator.onLine });
		renderOfflineBanner(root, view);
		return view;
	}

	return Object.freeze({
		scope,
		store,
		refresh,
		async replay() {
			const summary = await drainOutbox({
				store,
				scope,
				authenticate,
				commit,
				acquireLease: () => lease.acquire(),
				releaseLease: () => lease.release(),
			});
			await refresh();
			return summary;
		},
		async save(path, bytes, baseRevision) {
			const result = await writeOfflineDraft({ store, path, bytes, baseRevision, deviceId: deviceId() });
			await refresh();
			return result;
		},
		async open(path) {
			return readCachedDocument({ store, path });
		},
		async status(path) {
			return documentStatus({ store, path });
		},
		async exportAll() {
			return store.exportAllDrafts();
		},
		async verify() {
			return verifyReplayScope({ scope, authenticate });
		},
		rows(operations) {
			return outboxRows({ operations });
		},
		reasons: opBlockReasons,
		close() {
			store.close();
		},
	});
}

if (typeof window !== 'undefined') {
	window.log4stellarOffline = { createOfflineController };
}
