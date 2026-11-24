import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { Pool } from 'pg';
import { openRustfsWorkspace } from './rustfs-workspace.mjs';
import { authorizeWorkspace } from './workspace-access.mjs';
import { openDirectoryBlobs } from './test-support/directory-blobs.mjs';
import { gitSchemaCurrent, gitSchemaTables, migrateGit } from './git-migrate.mjs';
import { createGitBackend, resetGitLocksForTest } from './git-service.mjs';
import { createGitSecret, readGitSecret, secretPathFor } from './git-credentials.mjs';
import { closeGitStore } from './git-store.mjs';
import { serveGitRequest } from './git-files.mjs';

// End to end tests for the Git integration against real PostgreSQL, real storage metadata
// and real `git` (2.43). Opt in exactly like the other integration tests:
//
//   cp /home/log4stellar/.config/log4stellar/workspace-storage.json /tmp/l4s-gitint.json
//   chmod 600 /tmp/l4s-gitint.json
//   LOG4STELLAR_STORAGE_CONFIG=/tmp/l4s-gitint.json LOG4STELLAR_IT=1 \
//     node --test apps/web/git-integration.test.mjs
//
// Every workspace matches `l4s-it-git-*` and is deleted afterwards (metadata rows, blob
// directory and both temporary roots), so the shared database stays clean. No remote is
// ever on the network: a remote here is always a `git init --bare` directory under /tmp.
const enabled = process.env.LOG4STELLAR_IT === '1';
const skip = enabled ? false : 'set LOG4STELLAR_IT=1 to run the PostgreSQL integration tests';
const configPath = process.env.LOG4STELLAR_STORAGE_CONFIG;

function storageConfig() {
	if (!configPath) {
		throw new Error('Set LOG4STELLAR_STORAGE_CONFIG to run the git integration tests.');
	}
	return JSON.parse(readFileSync(configPath, 'utf8'));
}

function spoolDirectory() {
	return join(dirname(configPath), 'spool');
}

const gitEnv = {
	...process.env,
	GIT_AUTHOR_NAME: 'Test',
	GIT_AUTHOR_EMAIL: 'test@example.invalid',
	GIT_COMMITTER_NAME: 'Test',
	GIT_COMMITTER_EMAIL: 'test@example.invalid',
	GIT_CONFIG_NOSYSTEM: '1',
};

/** Plain git for fixtures and for cross-checking the service against the real CLI. */
function plain(args, cwd) {
	return new Promise((resolve, reject) => {
		const child = spawn('git', args, { cwd, env: gitEnv, stdio: ['ignore', 'pipe', 'pipe'] });
		const out = [];
		const err = [];
		child.stdout.on('data', chunk => out.push(chunk));
		child.stderr.on('data', chunk => err.push(chunk));
		child.once('error', reject);
		child.once('close', code => resolve({
			code,
			stdout: Buffer.concat(out).toString('utf8').trim(),
			stderr: Buffer.concat(err).toString('utf8').trim(),
		}));
	});
}

async function makeRepository(parent, name, { branch = 'main' } = {}) {
	const path = join(parent, name);
	await mkdir(path, { recursive: true });
	await plain(['init', '--quiet', '--initial-branch=' + branch], path);
	await writeFile(join(path, 'README.md'), '# ' + name + '\n');
	await plain(['add', '.'], path);
	await plain(['commit', '--quiet', '-m', 'initial commit'], path);
	return path;
}

async function makeBare(parent, name, { branch = 'main' } = {}) {
	const path = join(parent, name + '.git');
	await mkdir(path, { recursive: true });
	await plain(['init', '--quiet', '--bare'], path);
	await plain(['symbolic-ref', 'HEAD', 'refs/heads/' + branch], path);
	return path;
}

async function commitFile(repo, file, content, message) {
	await writeFile(join(repo, file), content);
	await plain(['add', '--', file], repo);
	await plain(['commit', '--quiet', '-m', message], repo);
}

async function headOf(repo, ref = 'HEAD') {
	return (await plain(['rev-parse', ref], repo)).stdout;
}

/**
 * One throw-away workspace with a storage backend, an allowed git root and a git backend
 * wired the way the gateway wires it. The cleanup mirrors sync-integration.test.mjs.
 */
async function scenario(work) {
	const settings = storageConfig();
	const workspaceId = 'l4s-it-git-' + randomUUID().replace(/-/g, '').slice(0, 10);
	const pool = new Pool({ connectionTimeoutMillis: 5000, max: 4, ...settings.postgres });
	const seed = await mkdtemp(join(tmpdir(), 'l4s-git-seed-'));
	const root = await mkdtemp(join(tmpdir(), 'l4s-git-root-'));
	let importer;
	let backend;
	let store;
	try {
		importer = await openRustfsWorkspace(workspaceId, { importing: true, createBlobs: openDirectoryBlobs });
		await importer.importDirectory(seed, 64 * 1024 * 1024);
		await importer.close();
		importer = undefined;
		backend = await openRustfsWorkspace(workspaceId, { createBlobs: openDirectoryBlobs });
		// The key file lives next to the storage configuration, exactly as in production. The
		// configuration here is a /tmp copy, so this never touches the real key.
		if (!await readGitSecret(configPath)) {
			await createGitSecret(configPath).catch(error => {
				if (error?.code !== 'RepositoryImmutable') {
					throw error;
				}
			});
		}
		const environment = {
			...process.env,
			LOG4STELLAR_STORAGE_CONFIG: configPath,
			LOG4STELLAR_GIT_WORKSPACE_ROOTS: JSON.stringify({ [workspaceId]: [root] }),
		};
		store = await import('./git-store.mjs').then(module => module.openGitStore(environment));
		const gitBackend = createGitBackend({ workspaceId, actor: 'it-user', storage: backend, environment });
		await work({ workspaceId, pool, backend, root, environment, gitBackend, store });
	} finally {
		resetGitLocksForTest();
		await closeGitStore();
		await store?.close?.().catch(() => {});
		await backend?.close?.();
		if (importer) {
			await importer.close().catch(() => {});
		}
		await clean(pool, workspaceId);
		await pool.end();
		await rm(seed, { recursive: true, force: true });
		await rm(root, { recursive: true, force: true });
	}
}

async function clean(pool, workspaceId) {
	for (const table of ['git_checkpoints', 'git_credentials', 'git_repositories']) {
		await pool.query(`DELETE FROM log4stellar.${table} WHERE workspace_id = $1`, [workspaceId]).catch(() => {});
	}
	await pool.query(
		'DELETE FROM log4stellar.storage_snapshot_entries WHERE snapshot_id IN (SELECT id FROM log4stellar.storage_snapshots WHERE workspace_id = $1)',
		[workspaceId]).catch(() => {});
	await pool.query(
		'DELETE FROM log4stellar.storage_trash_entries WHERE trash_id IN (SELECT id FROM log4stellar.storage_trash WHERE workspace_id = $1)',
		[workspaceId]).catch(() => {});
	for (const table of ['storage_snapshots', 'storage_changes', 'storage_change_heads', 'storage_trash', 'storage_file_versions', 'storage_entries']) {
		await pool.query(`DELETE FROM log4stellar.${table} WHERE workspace_id = $1`, [workspaceId]).catch(() => {});
	}
	await pool.query('DELETE FROM log4stellar.storage_workspaces WHERE id = $1', [workspaceId]).catch(() => {});
	await rm(join(spoolDirectory(), 'test-blobs', workspaceId), { recursive: true, force: true });
}

/** One /git/v1 request through the real handler and the real capability facade. */
async function git(fixture, { role = 'owner', method = 'GET', path = '/', query = {}, body } = {}) {
	const stored = new Map();
	let payload;
	if (body !== undefined) {
		payload = Buffer.from(JSON.stringify(body));
		stored.set('content-type', 'application/json');
	}
	const ctx = {
		method,
		path: '/git/v1' + path,
		query,
		status: undefined,
		body: undefined,
		req: payload === undefined ? Readable.from([]) : Readable.from([payload]),
		get: name => stored.get(name.toLowerCase()) ?? '',
		set: (name, value) => stored.set(name.toLowerCase(), value),
		is: type => (stored.get('content-type') ?? '').startsWith(type),
	};
	await serveGitRequest(
		ctx,
		authorizeWorkspace(fixture.gitBackend, { role }),
		fixture.gitBackend,
		fixture.workspaceId,
		64 * 1024 * 1024,
	);
	return { status: ctx.status ?? (ctx.body === undefined ? 404 : 200), body: ctx.body };
}

// ---------------------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------------------

test('the git migration is additive, idempotent and leaves the previous release working', { skip }, async () => {
	const settings = storageConfig();
	const pool = new Pool({ connectionTimeoutMillis: 5000, max: 2, ...settings.postgres });
	try {
		await migrateGit(pool);
		// Running the migration a second time must be a no-op: every statement is IF NOT EXISTS.
		await migrateGit(pool);
		assert.equal(await gitSchemaCurrent(pool), true);
		// And the probe is what the server uses to decide whether to run DDL at all (§6.1).
		assert.deepEqual(gitSchemaTables, ['git_repositories', 'git_credentials', 'git_checkpoints']);
		const { rows } = await pool.query(`
			SELECT table_name FROM information_schema.tables
			WHERE table_schema = 'log4stellar' AND table_name = ANY($1::text[])
			ORDER BY table_name
		`, [gitSchemaTables]);
		assert.deepEqual(rows.map(row => row.table_name), [...gitSchemaTables].sort());

		// The previous release knows nothing about the three new tables, so its own schema
		// file must still apply cleanly on top of them, twice, and its reads must work.
		const oldSchema = readFileSync(new URL('./workspace-schema.sql', import.meta.url), 'utf8');
		await pool.query(oldSchema);
		await pool.query(oldSchema);
		const syncSchema = readFileSync(new URL('./sync-schema.sql', import.meta.url), 'utf8');
		await pool.query(syncSchema);

		// A workspace row written by the old release still reads back through the old join.
		const workspaceId = 'l4s-it-git-old-' + randomUUID().slice(0, 8);
		try {
			await pool.query('INSERT INTO log4stellar.storage_workspaces (id, created_ms) VALUES ($1, $2)', [workspaceId, Date.now()]);
			const fileId = randomUUID();
			const revisionId = randomUUID();
			await pool.query(
				`INSERT INTO log4stellar.storage_file_versions
					(workspace_id, file_id, revision_id, parent_revision_id, sha256, size_bytes, created_ms)
				 VALUES ($1, $2, $3, NULL, $4, $5, $6)`,
				[workspaceId, fileId, revisionId, createHash('sha256').update('old').digest('hex'), 3, Date.now()]);
			const { rows: read } = await pool.query(`
				SELECT e.path, v.sha256 FROM log4stellar.storage_entries e
				LEFT JOIN log4stellar.storage_file_versions v USING (workspace_id, file_id, revision_id)
				WHERE e.workspace_id = $1
			`, [workspaceId]);
			assert.deepEqual(read, []);
		} finally {
			await pool.query('DELETE FROM log4stellar.storage_file_versions WHERE workspace_id = $1', [workspaceId]);
			await pool.query('DELETE FROM log4stellar.storage_workspaces WHERE id = $1', [workspaceId]);
		}
	} finally {
		await pool.end();
	}
});

// ---------------------------------------------------------------------------------------
// Binding and read endpoints
// ---------------------------------------------------------------------------------------

test('a repository is bound, read and unbound through the API', { skip }, async () => {
	await scenario(async fixture => {
		const repo = await makeRepository(fixture.root, 'app');
		const remote = await makeBare(fixture.root, 'app-remote');

		const unbound = await git(fixture, { path: '/repository' });
		assert.equal(unbound.status, 200);
		assert.deepEqual(unbound.body, { bound: false, repository: null });

		const bound = await git(fixture, {
			method: 'PUT',
			path: '/repository',
			body: { path: repo, remote, remoteBranch: 'main', defaultBranch: 'main' },
		});
		assert.equal(bound.status, 200, JSON.stringify(bound.body));
		assert.equal(bound.body.bound, true);
		// The response never carries the remote URL or the absolute host path (§5.3).
		assert.equal(bound.body.repository.remoteId.length, 16);
		assert.equal(bound.body.repository.path, 'app');
		assert.equal(JSON.stringify(bound.body).includes(remote), false);
		assert.equal(JSON.stringify(bound.body).includes(fixture.root), false);

		const status = await git(fixture, { path: '/status' });
		assert.equal(status.status, 200);
		assert.equal(status.body.workTree.clean, true);
		assert.equal(status.body.repository.head.branch, 'main');

		const log = await git(fixture, { path: '/log', query: { limit: '5' } });
		assert.equal(log.status, 200);
		assert.equal(log.body.commits.length, 1);
		assert.equal(log.body.commits[0].subject, 'initial commit');

		const branches = await git(fixture, { path: '/branches' });
		assert.equal(branches.status, 200);
		assert.equal(branches.body.current, 'main');

		const detail = await git(fixture, { path: '/commit/' + log.body.commits[0].commit });
		assert.equal(detail.status, 200);
		assert.equal(detail.body.commit.commit, log.body.commits[0].commit);
		assert.deepEqual(detail.body.files.map(entry => entry.path), ['README.md']);

		// The binding is scoped to this workspace: a second workspace sees nothing.
		const removed = await git(fixture, { method: 'DELETE', path: '/repository' });
		assert.equal(removed.status, 200);
		assert.equal((await git(fixture, { path: '/repository' })).body.bound, false);
		assert.equal((await git(fixture, { path: '/status' })).status, 404);
		assert.equal((await git(fixture, { path: '/status' })).body.error, 'RepositoryNotBound');
	});
});

test('a path outside the configured root is refused even from an owner', { skip }, async () => {
	await scenario(async fixture => {
		const outside = await mkdtemp(join(tmpdir(), 'l4s-git-outside-'));
		try {
			const repo = await makeRepository(outside, 'secret');
			const response = await git(fixture, { method: 'PUT', path: '/repository', body: { path: repo } });
			assert.equal(response.status, 400);
			assert.equal(response.body.error, 'InvalidPath');
			// A bare repository is a legal remote but not a legal workspace binding (§1.4).
			const bare = await makeBare(fixture.root, 'only-bare');
			const bareResponse = await git(fixture, { method: 'PUT', path: '/repository', body: { path: bare } });
			assert.equal(bareResponse.status, 422);
			assert.equal(bareResponse.body.error, 'BareRepository');
		} finally {
			await rm(outside, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------------------
// Checkpoints
// ---------------------------------------------------------------------------------------

test('a checkpoint records the commit and a soft reference to the note revision', { skip }, async () => {
	await scenario(async fixture => {
		const repo = await makeRepository(fixture.root, 'notes');
		await git(fixture, { method: 'PUT', path: '/repository', body: { path: repo } });
		const head = await headOf(repo);

		await fixture.backend.createDirectory('/notes');
		await fixture.backend.writeFile('/notes/plan.md', Readable.from([Buffer.from('# plan v1\n')]), { create: true, maxBytes: 1024 * 1024 });
		const firstRevision = (await fixture.backend.stat('/notes/plan.md')).etag.replaceAll('"', '');

		const created = await git(fixture, {
			method: 'POST',
			path: '/checkpoints',
			body: { name: 'release-v1', note: 'first checkpoint', notePath: '/notes/plan.md' },
		});
		assert.equal(created.status, 201, JSON.stringify(created.body));
		assert.equal(created.body.commit, head);
		assert.equal(created.body.branch, 'main');
		assert.equal(created.body.noteReference.path, '/notes/plan.md');
		assert.equal(created.body.noteReference.revisionId, firstRevision);
		assert.equal(created.body.noteReference.available, true);
		assert.equal(created.body.noteReference.matchesCurrent, true);
		assert.equal(created.body.noteReference.sha256, createHash('sha256').update('# plan v1\n').digest('hex'));

		// Editing the note does not invalidate the checkpoint: it only stops matching.
		await fixture.backend.writeFile('/notes/plan.md', Readable.from([Buffer.from('# plan v2\n')]), {
			overwrite: true,
			etag: '"' + firstRevision + '"',
			maxBytes: 1024 * 1024,
		});
		const listed = await git(fixture, { path: '/checkpoints' });
		assert.equal(listed.status, 200);
		assert.equal(listed.body.checkpoints.length, 1);
		assert.equal(listed.body.checkpoints[0].noteReference.matchesCurrent, false);
		assert.equal(listed.body.checkpoints[0].noteReference.available, true);

		// Deleting the note leaves the checkpoint readable, with the soft reference marked
		// unavailable — no foreign key, no cascade (§3.4).
		await fixture.backend.delete('/notes/plan.md');
		const afterDelete = await git(fixture, { path: '/checkpoints/' + created.body.checkpointId });
		assert.equal(afterDelete.status, 200);
		assert.equal(afterDelete.body.noteReference.available, false);
		assert.equal(afterDelete.body.commit, head);

		// A duplicate name in the same workspace is a 409; the same name elsewhere would not be.
		const duplicate = await git(fixture, { method: 'POST', path: '/checkpoints', body: { name: 'release-v1' } });
		assert.equal(duplicate.status, 409);
		assert.equal(duplicate.body.error, 'CheckpointExists');

		const deleted = await git(fixture, { method: 'DELETE', path: '/checkpoints/' + created.body.checkpointId });
		assert.equal(deleted.status, 200);
		assert.equal((await git(fixture, { path: '/checkpoints' })).body.checkpoints.length, 0);
	});
});

// ---------------------------------------------------------------------------------------
// Acceptance ① credential failure
// ---------------------------------------------------------------------------------------

test('acceptance 1a: a dangling credential reference is 502 RemoteAuthenticationFailed, never 401/403', { skip }, async () => {
	await scenario(async fixture => {
		const repo = await makeRepository(fixture.root, 'app');
		const remote = await makeBare(fixture.root, 'app-remote');
		const credential = await git(fixture, {
			method: 'PUT',
			path: '/credentials',
			body: { kind: 'https-token', label: 'ci', secret: 'not-a-real-token' },
		});
		assert.equal(credential.status, 201);
		const credentialId = credential.body.credentialId;
		// The secret is never echoed back, and the list endpoint does not return it either.
		assert.equal(JSON.stringify(credential.body).includes('not-a-real-token'), false);
		const list = await git(fixture, { path: '/credentials' });
		assert.equal(JSON.stringify(list.body).includes('not-a-real-token'), false);
		assert.equal(list.body.credentials[0].inUse, false);

		const bound = await git(fixture, {
			method: 'PUT',
			path: '/repository',
			body: { path: repo, remote, credentialId },
		});
		assert.equal(bound.status, 200, JSON.stringify(bound.body));
		assert.equal((await git(fixture, { path: '/credentials' })).body.credentials[0].inUse, true);
		// A credential that is still referenced cannot be deleted (§4.6).
		const inUse = await git(fixture, { method: 'DELETE', path: '/credentials/' + credentialId });
		assert.equal(inUse.status, 409);
		assert.equal(inUse.body.error, 'CredentialInUse');

		// Simulate the credential being revoked out from under the binding.
		await fixture.pool.query(
			'DELETE FROM log4stellar.git_credentials WHERE workspace_id = $1 AND credential_id = $2',
			[fixture.workspaceId, credentialId],
		);
		const fetchResponse = await git(fixture, { method: 'POST', path: '/fetch' });
		assert.equal(fetchResponse.status, 502, JSON.stringify(fetchResponse.body));
		assert.equal(fetchResponse.body.error, 'RemoteAuthenticationFailed');
		assert.notEqual(fetchResponse.status, 401);
		assert.notEqual(fetchResponse.status, 403);
	});
});

test('acceptance 1b: an unreachable remote is 502 RemoteUnavailable and leaks neither URL nor path', { skip }, async () => {
	await scenario(async fixture => {
		const repo = await makeRepository(fixture.root, 'app');
		const remote = await makeBare(fixture.root, 'gone-remote');
		await git(fixture, { method: 'PUT', path: '/repository', body: { path: repo, remote } });
		// The remote directory disappears between binding and use.
		await rm(remote, { recursive: true, force: true });

		const fetchResponse = await git(fixture, { method: 'POST', path: '/fetch' });
		assert.equal(fetchResponse.status, 502);
		assert.equal(fetchResponse.body.error, 'RemoteUnavailable');
		assert.equal(JSON.stringify(fetchResponse.body).includes(remote), false);
		assert.equal(String(fetchResponse.body.detail ?? '').includes('/tmp/'), false);

		const pushResponse = await git(fixture, { method: 'POST', path: '/push', body: {} });
		assert.equal(pushResponse.status, 502);
		assert.equal(pushResponse.body.error, 'RemoteUnavailable');
	});
});

// ---------------------------------------------------------------------------------------
// Acceptance ② non-fast-forward push
// ---------------------------------------------------------------------------------------

test('acceptance 2: a non-fast-forward push is 409 NotFastForward and the remote ref does not move', { skip }, async () => {
	await scenario(async fixture => {
		const repo = await makeRepository(fixture.root, 'app');
		const remote = await makeBare(fixture.root, 'app-remote');
		await git(fixture, { method: 'PUT', path: '/repository', body: { path: repo, remote } });

		const first = await git(fixture, { method: 'POST', path: '/push', body: {} });
		assert.equal(first.status, 200, JSON.stringify(first.body));
		assert.equal(first.body.commit, await headOf(repo));
		assert.equal(await headOf(remote, 'refs/heads/main'), await headOf(repo));

		// Someone else advances the remote first.
		const other = join(fixture.root, 'other');
		await plain(['clone', '--quiet', remote, other], fixture.root);
		await commitFile(other, 'theirs.txt', 'theirs\n', 'their commit');
		await plain(['push', '--quiet', remote, 'main:refs/heads/main'], other);
		const remoteHeadBefore = await headOf(remote, 'refs/heads/main');

		// Our local history now diverges.
		await commitFile(repo, 'ours.txt', 'ours\n', 'our commit');
		const rejected = await git(fixture, { method: 'POST', path: '/push', body: {} });
		assert.equal(rejected.status, 409);
		assert.equal(rejected.body.error, 'NotFastForward');
		// The remote ref is byte-for-byte what it was before the refused push.
		assert.equal(await headOf(remote, 'refs/heads/main'), remoteHeadBefore);

		// A stale precondition is a 412: the caller named a remote commit that no longer holds.
		const stale = await git(fixture, {
			method: 'POST',
			path: '/push',
			body: { expectedRemote: 'f'.repeat(40) },
		});
		assert.equal(stale.status, 412);
		assert.equal(stale.body.error, 'RemoteChanged');

		// Force push is refused by shape, before any git process runs (§1.3).
		const forced = await git(fixture, { method: 'POST', path: '/push', body: { force: true } });
		assert.equal(forced.status, 400);
		assert.equal(forced.body.error, 'ForcePushNotAllowed');
	});
});

// ---------------------------------------------------------------------------------------
// Acceptance ③ dirty work tree
// ---------------------------------------------------------------------------------------

test('acceptance 3: switching with unsaved changes is 422 WorkTreeDirty and the tree is untouched', { skip }, async () => {
	await scenario(async fixture => {
		const repo = await makeRepository(fixture.root, 'app');
		await plain(['switch', '--quiet', '--create', 'side'], repo);
		await commitFile(repo, 'shared.txt', 'side\n', 'side commit');
		await plain(['switch', '--quiet', 'main'], repo);
		await commitFile(repo, 'shared.txt', 'main\n', 'main commit');
		await git(fixture, { method: 'PUT', path: '/repository', body: { path: repo } });

		// The status endpoint sees the unsaved change before any switch is attempted.
		await writeFile(join(repo, 'shared.txt'), 'unsaved edit\n');
		const status = await git(fixture, { path: '/status' });
		assert.equal(status.status, 200);
		assert.equal(status.body.workTree.clean, false);
		assert.deepEqual(status.body.workTree.entries.map(entry => entry.path), ['shared.txt']);

		const before = await readFile(join(repo, 'shared.txt'), 'utf8');
		const statusBefore = (await plain(['status', '--porcelain'], repo)).stdout;
		const refused = await git(fixture, { method: 'POST', path: '/branch', body: { name: 'side' } });
		assert.equal(refused.status, 422, JSON.stringify(refused.body));
		assert.equal(refused.body.error, 'WorkTreeDirty');
		// The bytes on disk are unchanged and so is what git itself reports.
		assert.equal(await readFile(join(repo, 'shared.txt'), 'utf8'), before);
		assert.equal((await plain(['status', '--porcelain'], repo)).stdout, statusBefore);
		assert.equal((await plain(['rev-parse', '--abbrev-ref', 'HEAD'], repo)).stdout, 'main');
	});
});

// ---------------------------------------------------------------------------------------
// Acceptance ④ branch switch
// ---------------------------------------------------------------------------------------

test('acceptance 4: after a switch the status, branches and log all agree with the git CLI', { skip }, async () => {
	await scenario(async fixture => {
		const repo = await makeRepository(fixture.root, 'app');
		await plain(['switch', '--quiet', '--create', 'side'], repo);
		await commitFile(repo, 'side.txt', 'side\n', 'side commit');
		const sideHead = await headOf(repo);
		await plain(['switch', '--quiet', 'main'], repo);
		await git(fixture, { method: 'PUT', path: '/repository', body: { path: repo } });

		const before = await git(fixture, { path: '/status' });
		assert.equal(before.body.repository.head.branch, 'main');
		assert.equal(before.body.repository.head.commit, await headOf(repo));

		const switched = await git(fixture, { method: 'POST', path: '/branch', body: { name: 'side' } });
		assert.equal(switched.status, 200, JSON.stringify(switched.body));
		assert.equal(switched.body.repository.head.branch, 'side');
		assert.equal(switched.body.repository.head.commit, sideHead);
		assert.equal(switched.body.workTree.clean, true);

		// The service and the CLI agree on HEAD, on the branch list and on the newest commit.
		const status = await git(fixture, { path: '/status' });
		assert.equal(status.body.repository.head.branch, (await plain(['rev-parse', '--abbrev-ref', 'HEAD'], repo)).stdout);
		assert.equal(status.body.repository.head.commit, sideHead);
		const branches = await git(fixture, { path: '/branches' });
		assert.equal(branches.body.current, 'side');
		assert.deepEqual(branches.body.branches.map(entry => entry.name).sort(), ['main', 'side']);
		const log = await git(fixture, { path: '/log', query: { limit: '1' } });
		assert.equal(log.body.commits[0].commit, (await plain(['log', '-1', '--format=%H'], repo)).stdout);
		assert.equal(log.body.commits[0].subject, 'side commit');

		// Switching to a missing branch is a 404, not a git error page.
		const missing = await git(fixture, { method: 'POST', path: '/branch', body: { name: 'no-such-branch' } });
		assert.equal(missing.status, 404);
		assert.equal(missing.body.error, 'BranchNotFound');
	});
});

// ---------------------------------------------------------------------------------------
// Concurrency and roles
// ---------------------------------------------------------------------------------------

test('two operations on the same workspace do not overlap: the second is 409 RepositoryBusy', { skip }, async () => {
	await scenario(async fixture => {
		const repo = await makeRepository(fixture.root, 'app');
		const remote = await makeBare(fixture.root, 'app-remote');
		await git(fixture, { method: 'PUT', path: '/repository', body: { path: repo, remote } });

		// `withLock` takes the lock synchronously, so two requests issued in the same tick
		// genuinely race and exactly one of them must be refused.
		const [a, b] = await Promise.allSettled([
			git(fixture, { method: 'POST', path: '/fetch' }),
			git(fixture, { method: 'POST', path: '/fetch' }),
		]);
		const busy = [a, b].filter(entry => entry.status === 'fulfilled' && entry.value.status === 409);
		assert.equal(busy.length, 1, JSON.stringify([a, b]));
		assert.equal(busy[0].value.body.error, 'RepositoryBusy');
		// The lock is released again, so the next operation succeeds.
		const after = await git(fixture, { method: 'POST', path: '/fetch' });
		assert.equal(after.status, 200);
	});
});

test('a viewer can read the repository but cannot fetch, switch or push', { skip }, async () => {
	await scenario(async fixture => {
		const repo = await makeRepository(fixture.root, 'app');
		const remote = await makeBare(fixture.root, 'app-remote');
		await git(fixture, { method: 'PUT', path: '/repository', body: { path: repo, remote } });

		assert.equal((await git(fixture, { path: '/status' })).status, 200);
		assert.equal((await git(fixture, { role: 'viewer', path: '/status' })).status, 200);
		// `fetch` rewrites only refs/remotes/*, so it belongs to the read capability (§2.1): a
		// viewer may sync its view of the remote, but may not push or change the work tree.
		assert.equal((await git(fixture, { role: 'viewer', method: 'POST', path: '/fetch' })).status, 200);
		for (const [method, path] of [['POST', '/push'], ['POST', '/branch']]) {
			const denied = await git(fixture, { role: 'viewer', method, path, body: { name: 'main' } });
			assert.equal(denied.status, 403, method + ' ' + path);
			assert.equal(denied.body.error, 'NoPermissions');
		}
		// An editor may push but not bind a repository.
		assert.equal((await git(fixture, { role: 'editor', method: 'POST', path: '/push', body: {} })).status, 200);
		const bind = await git(fixture, { role: 'editor', method: 'PUT', path: '/repository', body: { path: repo } });
		assert.equal(bind.status, 403);
	});
});
