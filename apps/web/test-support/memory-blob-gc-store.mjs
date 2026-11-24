/**
 * In-memory implementations of the two collaborator interfaces the collector needs, so
 * the safety invariants can be proven without PostgreSQL or a shared bucket.
 *
 * `createMemoryBlobGcStore` mirrors the observable behaviour of blob-gc-store.mjs
 * (including the compare-and-set semantics of transitionCandidate); `createFakeInventory`
 * mirrors openRustfsInventory. Both count the operations that matter for the guarantees:
 * an inventory that records zero deletes is the machine-checkable form of "dry-run does
 * not delete anything".
 */

const digestPattern = /^[0-9a-f]{64}$/;

function key(workspaceId, digest) {
	return `${workspaceId}\u0000${digest}`;
}

function copyCandidate(row) {
	return row ? { ...row } : null;
}

export function createMemoryBlobGcStore({ referenceRows = [], now = () => Date.now() } = {}) {
	/** @type {Map<string, object>} */
	const runs = new Map();
	/** @type {Map<string, object>} */
	const candidates = new Map();
	/** @type {Map<string, object>} */
	const intents = new Map();
	/** @type {Map<string, object>} */
	const holds = new Map();
	/** References that come from the metadata tables, seeded with `[ws, digest, blockers]`. */
	const references = new Map();
	for (const row of referenceRows) references.set(key(row[0], row[1]), new Set(row[2] ?? ['versions']));
	const workspaces = new Set();
	let runCounter = 0;

	function note(workspaceId) {
		if (workspaceId) workspaces.add(workspaceId);
	}

	function blockersFor(workspaceId, digest, nowMs) {
		const blockers = new Set(references.get(key(workspaceId, digest)) ?? []);
		for (const intent of intents.values()) {
			if (intent.workspaceId === workspaceId && intent.digest === digest && intent.expiresMs > nowMs) {
				blockers.add('intents');
			}
		}
		for (const hold of holds.values()) {
			const scopeMatches = hold.workspaceId === null || hold.workspaceId === workspaceId;
			const live = hold.expiresMs === null || hold.expiresMs > nowMs;
			if (hold.digest === digest && scopeMatches && live) blockers.add('holds');
		}
		return blockers;
	}

	const store = {
		/** The number of physical deletes requested through this store: always zero. */
		writes: 0,

		async beginRun({ scope, mode, dryRun, startedMs }) {
			runCounter += 1;
			const runId = `00000000-0000-4000-8000-${String(runCounter).padStart(12, '0')}`;
			const run = {
				runId, scope, mode, dryRun, state: 'planned', inventoryCursor: null,
				candidateCount: 0, candidateBytes: 0, deletedCount: 0, deletedBytes: 0,
				startedMs, updatedMs: startedMs,
			};
			runs.set(runId, run);
			return { ...run };
		},

		async readRun(runId) {
			return runs.has(runId) ? { ...runs.get(runId) } : null;
		},

		async updateRun(runId, patch) {
			const run = runs.get(runId);
			if (!run) return null;
			for (const [name, value] of Object.entries(patch)) {
				if (value !== undefined && value !== null) run[name] = value;
			}
			return { ...run };
		},

		async bumpRun(runId, { deletedCount = 0, deletedBytes = 0, updatedMs }) {
			const run = runs.get(runId);
			if (!run) return;
			run.deletedCount += deletedCount;
			run.deletedBytes += deletedBytes;
			if (updatedMs !== undefined) run.updatedMs = updatedMs;
		},

		async findCandidate(workspaceId, digest) {
			return copyCandidate(candidates.get(key(workspaceId, digest)));
		},

		async observeCandidate({ workspaceId, digest, objectVersion, sizeBytes, runId, reason, firstSeenMs, eligibleAfterMs }) {
			note(workspaceId);
			const existing = candidates.get(key(workspaceId, digest));
			const keepDeadlines = existing && (existing.state === 'observed' || existing.state === 'eligible');
			const row = {
				workspaceId,
				digest,
				objectVersion: objectVersion ?? null,
				sizeBytes: sizeBytes ?? 0,
				runId: runId ?? null,
				state: 'observed',
				reason,
				firstSeenMs: keepDeadlines ? existing.firstSeenMs : firstSeenMs,
				eligibleAfterMs: keepDeadlines ? existing.eligibleAfterMs : eligibleAfterMs,
				updatedMs: firstSeenMs,
				recoveryPath: null,
				lastError: null,
			};
			candidates.set(key(workspaceId, digest), row);
			return { ...row };
		},

		async transitionCandidate({ workspaceId, digest, from, to, reason, recoveryPath, lastError, objectVersion, runId, updatedMs }) {
			const row = candidates.get(key(workspaceId, digest));
			if (!row) return null;
			if (!from.includes(row.state)) return null;
			row.state = to;
			if (reason !== undefined && reason !== null) row.reason = reason;
			if (recoveryPath !== undefined && recoveryPath !== null) row.recoveryPath = recoveryPath;
			row.lastError = lastError ?? null;
			if (objectVersion) row.objectVersion = objectVersion;
			if (runId) row.runId = runId;
			if (updatedMs !== undefined) row.updatedMs = updatedMs;
			return { ...row };
		},

		async listCandidates(workspaceId, { states, eligibleByMs, limit = 100 } = {}) {
			return [...candidates.values()]
				.filter((row) => row.workspaceId === workspaceId)
				.filter((row) => !states || states.length === 0 || states.includes(row.state))
				.filter((row) => eligibleByMs === undefined || row.eligibleAfterMs <= eligibleByMs)
				.sort((left, right) => left.firstSeenMs - right.firstSeenMs || left.digest.localeCompare(right.digest))
				.slice(0, limit)
				.map((row) => ({ ...row }));
		},

		async candidateTotals(workspaceId) {
			const totals = {};
			for (const row of candidates.values()) {
				if (row.workspaceId !== workspaceId) continue;
				totals[row.state] ??= { candidates: 0, bytes: 0 };
				totals[row.state].candidates += 1;
				totals[row.state].bytes += row.sizeBytes;
			}
			return totals;
		},

		async isReferenced(workspaceId, digest, { nowMs = now() } = {}) {
			const blockers = [...blockersFor(workspaceId, digest, nowMs)];
			return {
				referenced: blockers.length > 0,
				sources: Object.fromEntries(blockers.map((name) => [name, true])),
				blockers,
			};
		},

		async listIntents(workspaceId, digest, nowMs = now()) {
			return [...intents.values()]
				.filter((row) => row.workspaceId === workspaceId && row.digest === digest && row.expiresMs > nowMs)
				.map((row) => ({ writerId: row.writerId, createdMs: row.createdMs, expiresMs: row.expiresMs }));
		},

		async registerIntent({ workspaceId, digest, writerId, createdMs, expiresMs }) {
			if (!digestPattern.test(digest)) throw new Error('invalid digest');
			note(workspaceId);
			intents.set(key(workspaceId, `${digest}\u0000${writerId}`), { workspaceId, digest, writerId, createdMs, expiresMs });
			return { createdMs, expiresMs };
		},

		async releaseIntent({ workspaceId, digest, writerId }) {
			intents.delete(key(workspaceId, `${digest}\u0000${writerId}`));
		},

		async createHold({ scope, workspaceId, digest, reason, createdMs, expiresMs }) {
			const holdId = `hold-${holds.size + 1}`;
			holds.set(holdId, { holdId, scope, workspaceId: workspaceId ?? null, digest, reason, createdMs, expiresMs: expiresMs ?? null });
			return holdId;
		},

		async releaseHold(holdId) {
			holds.delete(holdId);
		},

		async listHolds(workspaceId, digest, nowMs = now()) {
			return [...holds.values()]
				.filter((row) => row.digest === digest && (row.workspaceId === null || row.workspaceId === workspaceId))
				.filter((row) => row.expiresMs === null || row.expiresMs > nowMs)
				.map((row) => ({ ...row }));
		},

		async pruneIntents({ nowMs = now() } = {}) {
			let removed = 0;
			for (const [id, intent] of intents) {
				if (intent.expiresMs <= nowMs) {
					intents.delete(id);
					removed += 1;
				}
			}
			return removed;
		},

		async workspacesForScope(scope) {
			if (scope === 'all') return [...workspaces].sort();
			if (typeof scope === 'string' && scope.startsWith('workspace:')) {
				const workspaceId = scope.slice('workspace:'.length);
				note(workspaceId);
				return [workspaceId];
			}
			throw new Error('invalid scope');
		},

		// Test-only inspection helpers, deliberately not part of the real store's surface.
		inspect() {
			return {
				runs: [...runs.values()].map((row) => ({ ...row })),
				candidates: [...candidates.values()].map((row) => ({ ...row })),
				intents: [...intents.values()].map((row) => ({ ...row })),
				holds: [...holds.values()].map((row) => ({ ...row })),
			};
		},
	};
	return store;
}

/**
 * An object store with the inventory surface the collector uses.
 *
 * `version` is derived from the content length and a revision counter, so rewriting an
 * object with different bytes (or even the same bytes through `rewrite`) changes its
 * identity — which is exactly the "rebuilt object" case a candidate must never delete.
 */
export function createFakeInventory({ objects = [], now = () => Date.now() } = {}) {
	/** @type {Map<string, object>} */
	const files = new Map();
	let revision = 0;
	const calls = { list: 0, head: 0, delete: 0, copy: 0 };

	function identity(size) {
		revision += 1;
		return `rev:${revision}:${size}`;
	}

	for (const object of objects) {
		files.set(digestKey(object.workspaceId, object.digest), {
			workspaceId: object.workspaceId,
			digest: object.digest,
			sizeBytes: object.sizeBytes ?? 16,
			bytes: object.bytes ?? Buffer.from(object.digest),
			lastModifiedMs: object.lastModifiedMs ?? now(),
			version: identity(object.sizeBytes ?? 16),
		});
	}

	const inventory = {
		calls,
		async list(cursor) {
			calls.list += 1;
			const ordered = [...files.values()].sort((left, right) => digestKey(left.workspaceId, left.digest).localeCompare(digestKey(right.workspaceId, right.digest)));
			const start = cursor ? Number(cursor) : 0;
			const page = ordered.slice(start, start + 2);
			return {
				objects: page.map((file) => ({
					key: `workspaces/${file.workspaceId}/sha256/${file.digest}`,
					digest: file.digest,
					sizeBytes: file.sizeBytes,
					lastModifiedMs: file.lastModifiedMs,
					version: file.version,
				})),
				unmanaged: 0,
				cursor: start + 2 < ordered.length ? String(start + 2) : null,
			};
		},

		async head(digest, workspaceId) {
			calls.head += 1;
			for (const file of files.values()) {
				if (file.digest === digest && (workspaceId === undefined || file.workspaceId === workspaceId)) {
					return { ...file, key: `workspaces/${file.workspaceId}/sha256/${file.digest}` };
				}
			}
			return null;
		},

		async deleteExact(digest, version, workspaceId) {
			calls.delete += 1;
			const found = [...files.values()].find((file) => file.digest === digest && (workspaceId === undefined || file.workspaceId === workspaceId));
			if (!found) return { deleted: false, missing: true };
			if (version && found.version !== version) return { deleted: false, identityChanged: true };
			files.delete(digestKey(found.workspaceId, found.digest));
			return { deleted: true };
		},

		async copyTo() {
			// The recovery copy is exercised by the directory-backed inventory; this fake only
			// records the call so a unit test can assert ordering.
			calls.copy += 1;
			return { path: 'memory' };
		},

		close() {},

		// Test-only helpers.
		get(digest) {
			return [...files.values()].find((file) => file.digest === digest) ?? null;
		},
		put(workspaceId, digest, sizeBytes = 16) {
			const bytes = Buffer.from(digest);
			files.set(digestKey(workspaceId, digest), {
				workspaceId, digest, sizeBytes, bytes, lastModifiedMs: now(), version: identity(sizeBytes),
			});
			return files.get(digestKey(workspaceId, digest));
		},
		rewrite(workspaceId, digest, { sizeBytes = 16, sameBytes = false } = {}) {
			const found = files.get(digestKey(workspaceId, digest));
			if (!found) return null;
			found.sizeBytes = sizeBytes;
			found.bytes = sameBytes ? Buffer.from(digest) : Buffer.from(`${digest}rebuilt`);
			found.lastModifiedMs = now();
			found.version = identity(sizeBytes);
			return found;
		},
	};
	return inventory;
}

function digestKey(workspaceId, digest) {
	return `${workspaceId}\u0000${digest}`;
}
