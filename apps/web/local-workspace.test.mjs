import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { createLocalWorkspace } from './local-workspace.mjs';

async function fixture(t) {
	const temp = await mkdtemp(join(tmpdir(), 'log4stellar-workspace-'));
	t.after(() => rm(temp, { force: true, recursive: true }));
	const notes = join(temp, 'notes');
	await mkdir(notes);
	return { workspace: await createLocalWorkspace(notes), notes, temp };
}

function upload(workspace, path, bytes, etag, maxBytes = 1024) {
	return workspace.writeFile(path, Readable.from([Buffer.from(bytes)]), {
		create: true,
		overwrite: Boolean(etag),
		etag,
		maxBytes,
	});
}

test('a saved revision survives restart and permits one concurrent update', async t => {
	const { workspace, notes } = await fixture(t);
	const created = await upload(workspace, '/note.md', '# first');
	const reopened = await createLocalWorkspace(notes);
	assert.equal((await reopened.stat('/note.md')).etag, created.etag);
	const writes = await Promise.allSettled([
		upload(reopened, '/note.md', '# tab A', created.etag),
		upload(reopened, '/note.md', '# tab B', created.etag),
	]);
	assert.equal(writes.filter(write => write.status === 'fulfilled').length, 1);
	assert.equal(writes.find(write => write.status === 'rejected').reason.code, 'FileChanged');
	assert.match(await readFile(join(notes, 'note.md'), 'utf8'), /^# tab [AB]$/);
});

test('failed uploads and paths outside the workspace leave the saved file intact', async t => {
	const { workspace, notes, temp } = await fixture(t);
	const created = await upload(workspace, '/note.md', 'original');
	await symlink(temp, join(notes, 'link'));
	await assert.rejects(() => upload(workspace, '/link/would-escape.md', 'escape'), { code: 'NoPermissions' });
	await assert.rejects(() => upload(workspace, '/../would-escape.md', 'escape'), { code: 'InvalidPath' });
	await assert.rejects(() => upload(workspace, '/note.md', 'oversized', created.etag, 2), { code: 'FileTooLarge' });
	assert.equal(await readFile(join(notes, 'note.md'), 'utf8'), 'original');
	assert.equal((await workspace.stat('/note.md')).etag, created.etag);
});
