import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { releaseInventory } from './web-release.mjs';

test('release inventory covers file contents and relocatable links', async t => {
	const directory = await mkdtemp(join(tmpdir(), 'log4stellar-inventory-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const root = join(directory, 'release');
	await mkdir(root);
	await writeFile(join(root, 'release.json'), '{}');
	const entry = join(root, 'entry.js');
	await writeFile(entry, 'one');
	await symlink('entry.js', join(root, 'alias.js'));
	const before = await releaseInventory(root);
	assert.deepEqual(before.map(([name]) => name), ['alias.js', 'entry.js']);
	assert.equal(before[0][1], 'link:entry.js');

	await writeFile(entry, 'two');
	assert.notEqual((await releaseInventory(root))[1][1], before[1][1]);

	await symlink(entry, join(root, 'absolute.js'));
	await assert.rejects(releaseInventory(root), /outside the package: absolute.js/);
	await rm(join(root, 'absolute.js'));
	await writeFile(join(directory, 'shared.js'), 'shared');
	await symlink('../shared.js', join(root, 'external.js'));
	await assert.rejects(releaseInventory(root), /outside the package: external.js/);
});
