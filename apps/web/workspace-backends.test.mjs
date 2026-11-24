import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWorkspaceBackends } from './workspace-backends.mjs';

function factory(options) {
	const opened = [];
	const closed = [];
	const cache = createWorkspaceBackends({
		...options,
		open: async workspaceId => {
			opened.push(workspaceId);
			if (options?.fail?.(workspaceId)) {
				throw new Error('Cannot open ' + workspaceId);
			}
			return {
				workspaceId,
				async close() {
					closed.push(workspaceId);
				},
			};
		},
	});
	return { cache, opened, closed };
}

test('opens a workspace once and reuses the instance while it is cached', async () => {
	const { cache, opened } = factory({});
	const first = await cache.acquire('team-notes');
	const second = await cache.acquire('team-notes');
	assert.equal(first, second);
	assert.deepEqual(opened, ['team-notes']);
	cache.release('team-notes');
	cache.release('team-notes');
	assert.equal(cache.size, 1);
	await cache.close();
});

test('concurrent requests for one workspace share a single open call', async () => {
	let resolve;
	const opened = [];
	const cache = createWorkspaceBackends({
		open: workspaceId => {
			opened.push(workspaceId);
			return new Promise(done => {
				resolve = () => done({ workspaceId, close: async () => {} });
			});
		},
	});
	const pending = [cache.acquire('team-notes'), cache.acquire('team-notes'), cache.acquire('team-notes')];
	resolve();
	const backends = await Promise.all(pending);
	assert.equal(new Set(backends).size, 1);
	assert.deepEqual(opened, ['team-notes']);
	await cache.close();
});

test('evicts least recently used entries but never one that is still leased', async () => {
	const { cache, opened, closed } = factory({ limit: 2 });
	const a = await cache.acquire('workspace-a');
	cache.release('workspace-a');
	const b = await cache.acquire('workspace-b');
	cache.release('workspace-b');
	// Re-acquire A so B becomes the least recently used entry.
	assert.equal(await cache.acquire('workspace-a'), a);

	// A is leased right now, so eviction must take B instead of closing A mid-request.
	const c = await cache.acquire('workspace-c');
	assert.equal(cache.size, 2);
	await new Promise(resolve => setImmediate(resolve));
	assert.deepEqual(closed, ['workspace-b']);
	assert.equal(cache.size, 2);
	assert.ok(b);

	// Once the last lease is released the cache trims down to the limit.
	cache.release('workspace-a');
	cache.release('workspace-c');
	await new Promise(resolve => setImmediate(resolve));
	assert.deepEqual(opened, ['workspace-a', 'workspace-b', 'workspace-c']);
	assert.deepEqual(closed, ['workspace-b']);
	await cache.close();
});

test('a failing open is not cached and can be retried', async () => {
	let attempts = 0;
	const cache = createWorkspaceBackends({
		open: async workspaceId => {
			attempts++;
			if (attempts === 1) {
				throw new Error('The RustFS workspace must be imported before it can be opened.');
			}
			return { workspaceId, close: async () => {} };
		},
	});
	await assert.rejects(() => cache.acquire('missing'), /must be imported/);
	assert.equal(cache.size, 0);
	await cache.acquire('missing');
	assert.equal(attempts, 2);
	assert.equal(cache.size, 1);
	await cache.close();
});

test('closing the cache closes every cached backend and refuses new work', async () => {
	const { cache, closed } = factory({});
	await cache.acquire('workspace-a');
	await cache.acquire('workspace-b');
	await cache.close();
	assert.deepEqual(closed.sort(), ['workspace-a', 'workspace-b']);
	assert.equal(cache.size, 0);
	await assert.rejects(() => cache.acquire('workspace-a'), /has been closed/);
	// Closing twice is a no-op, so process shutdown can be unconditional.
	await cache.close();
});

test('rejects an unusable factory configuration', () => {
	assert.throws(() => createWorkspaceBackends({}), /open\(workspaceId\)/);
	assert.throws(() => createWorkspaceBackends({ open: () => {}, limit: 0 }), /positive integer/);
	assert.throws(() => createWorkspaceBackends({ open: () => {}, limit: 1.5 }), /positive integer/);
});

test('a backend without close() is evicted without an error', async () => {
	const cache = createWorkspaceBackends({ limit: 1, open: async workspaceId => ({ workspaceId }) });
	await cache.acquire('workspace-a');
	cache.release('workspace-a');
	await cache.acquire('workspace-b');
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(cache.size, 1);
	await cache.close();
});

test('a backend opened while the cache closes is closed instead of cached', async () => {
	// The cache used to check `closed` only before awaiting `open()`, so an open that
	// finished after `close()` was installed into the fresh map and never closed,
	// leaking a PostgreSQL pool and an object-store client (review finding M3.1).
	const closed = [];
	let finish;
	const cache = createWorkspaceBackends({
		open: () => new Promise(resolve => {
			finish = () => resolve({ workspaceId: 'workspace-a', close: async () => { closed.push('workspace-a'); } });
		}),
	});
	const pending = cache.acquire('workspace-a');
	await cache.close();
	finish();
	await assert.rejects(() => pending, /has been closed/);
	assert.deepEqual(closed, ['workspace-a']);
	assert.equal(cache.size, 0);
});
