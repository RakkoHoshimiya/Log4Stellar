/**
 * Lazily opens workspace backends by ID and keeps at most `limit` of them alive.
 *
 * A backend holds a PostgreSQL pool and an object-store client, so the cache is
 * bounded. Eviction never closes a backend that a request is still using:
 * `acquire` takes a lease and the caller releases it once the response is done.
 * Different workspace IDs never share a backend instance.
 */
export function createWorkspaceBackends({ open, limit = 8 } = {}) {
	if (typeof open !== 'function') {
		throw new Error('A workspace backend factory requires an open(workspaceId) function.');
	}
	if (!Number.isInteger(limit) || limit < 1) {
		throw new Error('The workspace backend cache limit must be a positive integer.');
	}

	let entries = new Map();
	let closed = false;
	// Concurrent requests for one workspace must share a single open() call, or the
	// process would briefly hold two pools for the same ID.
	const opening = new Map();

	function touch(id, entry) {
		entries.delete(id);
		entries.set(id, entry);
	}

	function closeEntry(entry) {
		entry.closed = true;
		return Promise.resolve(entry.backend.close?.()).catch(() => {});
	}

	function evict() {
		for (const [id, entry] of entries) {
			if (entries.size <= limit) {
				return;
			}
			if (entry.leases > 0 || entry.closed) {
				continue;
			}
			entries.delete(id);
			void closeEntry(entry);
		}
	}

	function install(workspaceId, backend) {
		const existing = entries.get(workspaceId);
		if (existing && !existing.closed) {
			existing.leases++;
			touch(workspaceId, existing);
			if (backend !== existing.backend) {
				void Promise.resolve(backend.close?.()).catch(() => {});
			}
			return existing.backend;
		}
		const entry = { backend, leases: 1, closed: false };
		entries.set(workspaceId, entry);
		evict();
		return backend;
	}

	async function acquire(workspaceId) {
		if (closed) {
			throw new Error('The workspace backend cache has been closed.');
		}
		const cached = entries.get(workspaceId);
		if (cached && !cached.closed) {
			cached.leases++;
			touch(workspaceId, cached);
			return cached.backend;
		}
		let pending = opening.get(workspaceId);
		if (!pending) {
			pending = (async () => {
				try {
					return await open(workspaceId);
				} finally {
					opening.delete(workspaceId);
				}
			})();
			opening.set(workspaceId, pending);
		}
		const backend = await pending;
		// close() may have swapped the map while open() was running. Installing the new
		// backend into the fresh map would leave it open for the life of the process,
		// because nothing would ever evict it, so close it here and report the failure.
		if (closed) {
			await Promise.resolve(backend.close?.()).catch(() => {});
			throw new Error('The workspace backend cache has been closed.');
		}
		return install(workspaceId, backend);
	}

	function release(workspaceId) {
		const entry = entries.get(workspaceId);
		if (!entry) {
			return;
		}
		entry.leases = Math.max(0, entry.leases - 1);
		if (entry.leases === 0) {
			evict();
		}
	}

	async function close() {
		closed = true;
		const pending = entries;
		entries = new Map();
		await Promise.allSettled([...pending.values()].map(entry => closeEntry(entry)));
	}

	return {
		acquire,
		release,
		close,
		/** Test and diagnostic hook; production code never needs the entry count. */
		get size() {
			return entries.size;
		},
		/**
		 * Read-only snapshot for the monitoring endpoint.
		 *
		 * `opening` is the backlog that matters: it counts requests queued behind an
		 * in-progress open of the same workspace. `pools` reports the PostgreSQL pools of
		 * the live backends, but only for backends that expose one, so this stays honest
		 * under the local-directory backend.
		 */
		stats() {
			const pools = [];
			for (const entry of entries.values()) {
				const pool = entry.backend?.pool ?? entry.backend?.postgres?.pool;
				if (pool && typeof pool === 'object') {
					pools.push({
						total: Number(pool.totalCount ?? 0),
						idle: Number(pool.idleCount ?? 0),
						waiting: Number(pool.waitingCount ?? 0),
					});
				}
			}
			return { open: entries.size, opening: opening.size, limit, pools };
		},
	};
}
