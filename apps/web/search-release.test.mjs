import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

// The release copies `serverFiles` into `server/` and nothing else, so a module that is
// imported but not listed starts fine in the worktree and then fails on the deployed
// machine with ERR_MODULE_NOT_FOUND. These tests read the manifest as text: the array is
// data, and a missing name is exactly the mistake worth pinning in CI.

const app = fileURLToPath(new URL('.', import.meta.url));

async function serverFiles() {
	const source = await readFile(join(app, 'build-web-release.mjs'), 'utf8');
	const start = source.indexOf('const serverFiles = [');
	assert.ok(start >= 0, 'build-web-release.mjs must declare serverFiles');
	const end = source.indexOf('];', start);
	const body = source.slice(start, end);
	return new Set([...body.matchAll(/'([^']+)'/g)].map(match => match[1]));
}

// Every `from './x.mjs'` of a listed module has to be listed too, transitively from the
// entry points the deployed server actually imports.
async function reachable(entry) {
	const seen = new Set();
	const pending = [entry];
	while (pending.length > 0) {
		const name = pending.pop();
		if (seen.has(name)) {
			continue;
		}
		seen.add(name);
		const source = await readFile(join(app, name), 'utf8');
		for (const match of source.matchAll(/from\s+'(\.\/[^']+)'/g)) {
			const target = match[1].slice(2);
			if (target.endsWith('.mjs') || target.endsWith('.sql') || target.endsWith('.js')) {
				pending.push(target);
			}
		}
	}
	return seen;
}

test('the release ships every module the search feature adds', async () => {
	const listed = await serverFiles();
	for (const name of [
		'search-contract.mjs', 'search-files.mjs', 'search-indexer.mjs',
		'search-schema.sql', 'search-store.mjs',
	]) {
		assert.ok(listed.has(name), `${name} must be in serverFiles`);
		assert.ok(existsSync(join(app, name)), `${name} must exist`);
	}
});

test('the release ships every module reachable from the server entry point', async () => {
	const listed = await serverFiles();
	// serve-demo.mjs is what the deployed server runs; create-account and the two backup
	// tools are the other commands the release ships and can be invoked directly.
	for (const entry of ['serve-demo.mjs', 'create-account.mjs', 'import-workspace.mjs', 'backup-data.mjs', 'restore-backup-objects.mjs']) {
		assert.ok(listed.has(entry), `${entry} must be in serverFiles`);
	}
	const missing = [];
	for (const entry of ['serve-demo.mjs', 'create-account.mjs', 'import-workspace.mjs', 'backup-data.mjs', 'restore-backup-objects.mjs']) {
		for (const name of await reachable(entry)) {
			if (!listed.has(name)) {
				missing.push(name);
			}
		}
	}
	assert.deepEqual(missing, [], 'every imported server module must be listed in serverFiles');
});
