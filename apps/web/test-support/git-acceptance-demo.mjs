// Prints a readable trace of the four acceptance scenarios of the Git integration
// against real PostgreSQL, real storage metadata and real `git` (2.43). It is
// evidence, not a test: the assertions live in apps/web/git-integration.test.mjs.
// Run it with the same opt-in switch:
//
//   cp /home/log4stellar/.config/log4stellar/workspace-storage.json /tmp/l4s-gitint.json
//   chmod 600 /tmp/l4s-gitint.json
//   LOG4STELLAR_STORAGE_CONFIG=/tmp/l4s-gitint.json LOG4STELLAR_IT=1 \
//     node apps/web/test-support/git-acceptance-demo.mjs
//
// Every workspace is `l4s-it-git-*` and is deleted again, including its blob
// directory and both temporary roots. No remote is ever on the network: a remote
// here is always a `git init --bare` directory under /tmp.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { Pool } from 'pg';
import { openRustfsWorkspace } from '../rustfs-workspace.mjs';
import { authorizeWorkspace } from '../workspace-access.mjs';
import { createGitBackend, resetGitLocksForTest } from '../git-service.mjs';
import { createGitSecret, readGitSecret } from '../git-credentials.mjs';
import { closeGitStore, openGitStore } from '../git-store.mjs';
import { serveGitRequest } from '../git-files.mjs';
import { openDirectoryBlobs } from './directory-blobs.mjs';

if (process.env.LOG4STELLAR_IT !== '1') {
	console.error('Set LOG4STELLAR_IT=1 (and LOG4STELLAR_STORAGE_CONFIG) to run this demo.');
	process.exit(2);
}
const configPath = process.env.LOG4STELLAR_STORAGE_CONFIG;
if (!configPath) {
	console.error('Set LOG4STELLAR_STORAGE_CONFIG to run this demo.');
	process.exit(2);
}
const settings = JSON.parse(readFileSync(configPath, 'utf8'));
const spool = join(dirname(configPath), 'spool');
const maxBytes = 64 * 1024 * 1024;

const head = text => console.log('\n=== ' + text + ' ===');
const show = value => JSON.stringify(value);

const gitEnv = {
	...process.env,
	GIT_AUTHOR_NAME: 'Test',
	GIT_AUTHOR_EMAIL: 'test@example.invalid',
	GIT_COMMITTER_NAME: 'Test',
	GIT_COMMITTER_EMAIL: 'test@example.invalid',
	GIT_CONFIG_NOSYSTEM: '1',
};

/** Plain git, used only for fixtures and for cross-checking the service against the CLI. */
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

const headOf = async (repo, ref = 'HEAD') => (await plain(['rev-parse', ref], repo)).stdout;

/** One /git/v1 request through the real handler and the real capability facade. */
async function request(gitBackend, workspaceId, { role = 'owner', method = 'GET', path = '/', query = {}, body } = {}) {
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
	await serveGitRequest(ctx, authorizeWorkspace(gitBackend, { role }), gitBackend, workspaceId, maxBytes);
	return { status: ctx.status ?? (ctx.body === undefined ? 404 : 200), body: ctx.body };
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
	await rm(join(spool, 'test-blobs', workspaceId), { recursive: true, force: true });
}

async function scenario(work) {
	const workspaceId = 'l4s-it-git-' + randomUUID().replace(/-/g, '').slice(0, 10);
	const pool = new Pool({ connectionTimeoutMillis: 5000, max: 4, ...settings.postgres });
	const seed = await mkdtemp(join(tmpdir(), 'l4s-git-demo-seed-'));
	const root = await mkdtemp(join(tmpdir(), 'l4s-git-demo-root-'));
	let backend;
	let store;
	try {
		const importer = await openRustfsWorkspace(workspaceId, { importing: true, createBlobs: openDirectoryBlobs });
		await importer.importDirectory(seed, maxBytes);
		await importer.close();
		backend = await openRustfsWorkspace(workspaceId, { createBlobs: openDirectoryBlobs });
		if (!await readGitSecret(configPath)) {
			await createGitSecret(configPath).catch(error => {
				if (error?.code !== 'RepositoryImmutable') {
					throw error;
				}
			});
		}
		const environment = { ...process.env, LOG4STELLAR_STORAGE_CONFIG: configPath, LOG4STELLAR_GIT_WORKSPACE_ROOTS: JSON.stringify({ [workspaceId]: [root] }) };
		store = await openGitStore(environment);
		const gitBackend = createGitBackend({ workspaceId, actor: 'demo-user', storage: backend, environment });
		await work({ workspaceId, pool, backend, root, environment, gitBackend });
	} finally {
		resetGitLocksForTest();
		await closeGitStore();
		await store?.close?.().catch(() => {});
		await backend?.close?.();
		await clean(pool, workspaceId);
		await pool.end();
		await rm(seed, { recursive: true, force: true });
		await rm(root, { recursive: true, force: true });
	}
}

const git = (fixture, options) => request(fixture.gitBackend, fixture.workspaceId, options);

// ---------------------------------------------------------------------------------------
head('0. 关联仓库、读取状态/提交/分支');
await scenario(async fixture => {
	const repo = await makeRepository(fixture.root, 'app');
	const remote = await makeBare(fixture.root, 'app-remote');

	console.log('未关联时 GET /repository ->', show(await git(fixture, { path: '/repository' })));

	const bound = await git(fixture, {
		method: 'PUT',
		path: '/repository',
		body: { path: repo, remote, remoteBranch: 'main', defaultBranch: 'main' },
	});
	console.log('PUT /repository ->', bound.status, show(bound.body));
	console.log('  响应里含远端绝对路径? ', JSON.stringify(bound.body).includes(remote), '｜含服务端根目录? ',
		JSON.stringify(bound.body).includes(fixture.root), '｜remoteId 长度:', bound.body.repository.remoteId.length);

	const status = await git(fixture, { path: '/status' });
	console.log('GET /status ->', status.status, show({
		head: status.body.repository.head,
		clean: status.body.workTree.clean,
		upstream: status.body.upstream,
	}));

	const log = await git(fixture, { path: '/log', query: { limit: '3' } });
	console.log('GET /log ->', log.status, log.body.commits.map(commit => commit.commit.slice(0, 7) + ' ' + commit.subject));

	const branches = await git(fixture, { path: '/branches' });
	console.log('GET /branches ->', branches.status, show(branches.body));

	const pushed = await git(fixture, { method: 'POST', path: '/push', body: {} });
	console.log('POST /push ->', pushed.status, show(pushed.body));
	console.log('   远端 main =', await headOf(remote, 'refs/heads/main'), '｜本地 main =', await headOf(repo));
	const fetched = await git(fixture, { method: 'POST', path: '/fetch' });
	console.log('POST /fetch ->', fetched.status, show(fetched.body));
});

// ---------------------------------------------------------------------------------------
head('1a. 验收①-凭证失效：绑定的凭证被吊销 -> 502 RemoteAuthenticationFailed（不是 401/403）');
await scenario(async fixture => {
	const repo = await makeRepository(fixture.root, 'app');
	const remote = await makeBare(fixture.root, 'app-remote');
	const credential = await git(fixture, {
		method: 'PUT',
		path: '/credentials',
		body: { kind: 'https-token', label: 'ci', secret: 'demo-token-not-a-real-credential' },
	});
	console.log('PUT /credentials ->', credential.status, show(credential.body));
	console.log('   响应里含明文 secret? ', JSON.stringify(credential.body).includes('demo-token-not-a-real-credential'));
	await git(fixture, { method: 'PUT', path: '/repository', body: { path: repo, remote, credentialId: credential.body.credentialId } });
	console.log('PUT /repository（引用该凭证） -> 200');
	console.log('DELETE /credentials/<id> 仍被引用 ->', show(await git(fixture, { method: 'DELETE', path: '/credentials/' + credential.body.credentialId })));

	// Revoking the credential out from under the binding must not fall back to an anonymous call.
	await fixture.pool.query(
		'DELETE FROM log4stellar.git_credentials WHERE workspace_id = $1 AND credential_id = $2',
		[fixture.workspaceId, credential.body.credentialId]);
	const fetchResponse = await git(fixture, { method: 'POST', path: '/fetch' });
	console.log('凭证被吊销后 POST /fetch ->', fetchResponse.status, show(fetchResponse.body));
	console.log('   是 401 吗?', fetchResponse.status === 401, '｜是 403 吗?', fetchResponse.status === 403,
		'｜是 502 吗?', fetchResponse.status === 502);
});

head('1b. 验收①-远端不可达：远端目录消失 -> 502 RemoteUnavailable（不泄露 URL 与路径）');
await scenario(async fixture => {
	const repo = await makeRepository(fixture.root, 'app');
	const remote = await makeBare(fixture.root, 'gone-remote');
	await git(fixture, { method: 'PUT', path: '/repository', body: { path: repo, remote } });
	console.log('已绑定远端:', remote.replace(fixture.root, '<root>'));
	await rm(remote, { recursive: true, force: true });
	console.log('把远端目录整个删掉，模拟凭证/远端失效');

	const fetchResponse = await git(fixture, { method: 'POST', path: '/fetch' });
	console.log('POST /fetch ->', fetchResponse.status, show(fetchResponse.body));
	console.log('   响应里含远端绝对路径?', JSON.stringify(fetchResponse.body).includes(remote),
		'｜含 /tmp/ ?', String(fetchResponse.body.detail ?? '').includes('/tmp/'));
	const pushResponse = await git(fixture, { method: 'POST', path: '/push', body: {} });
	console.log('POST /push  ->', pushResponse.status, show(pushResponse.body));
});

// ---------------------------------------------------------------------------------------
head('2. 验收②-非快进推送 -> 409 NotFastForward，且远端 ref 不移动');
await scenario(async fixture => {
	const repo = await makeRepository(fixture.root, 'app');
	const remote = await makeBare(fixture.root, 'app-remote');
	await git(fixture, { method: 'PUT', path: '/repository', body: { path: repo, remote } });

	console.log('先正常推一次 ->', show(await git(fixture, { method: 'POST', path: '/push', body: {} })));

	// Someone else advances the remote first.
	const other = join(fixture.root, 'other');
	await plain(['clone', '--quiet', remote, other], fixture.root);
	await commitFile(other, 'theirs.txt', 'theirs\n', 'their commit');
	await plain(['push', '--quiet', remote, 'main:refs/heads/main'], other);
	const remoteHeadBefore = await headOf(remote, 'refs/heads/main');
	console.log('另一台机器先推了一个提交，远端 main =', remoteHeadBefore);

	await commitFile(repo, 'ours.txt', 'ours\n', 'our commit');
	console.log('本地也提交了（历史已分叉），本地 main =', await headOf(repo));

	const rejected = await git(fixture, { method: 'POST', path: '/push', body: {} });
	console.log('POST /push ->', rejected.status, show(rejected.body));
	const remoteHeadAfter = await headOf(remote, 'refs/heads/main');
	console.log('   远端 main 推前 =', remoteHeadBefore);
	console.log('   远端 main 推后 =', remoteHeadAfter, '｜未移动?', remoteHeadAfter === remoteHeadBefore);

	const stale = await git(fixture, { method: 'POST', path: '/push', body: { expectedRemote: 'f'.repeat(40) } });
	console.log('带过期 expectedRemote ->', stale.status, show(stale.body));
	const forced = await git(fixture, { method: 'POST', path: '/push', body: { force: true } });
	console.log('带 force: true      ->', forced.status, show(forced.body));
});

// ---------------------------------------------------------------------------------------
head('3. 验收③-工作树有未保存修改 -> 切分支 422 WorkTreeDirty，工作树逐字节不变');
await scenario(async fixture => {
	const repo = await makeRepository(fixture.root, 'app');
	await plain(['switch', '--quiet', '--create', 'side'], repo);
	await commitFile(repo, 'shared.txt', 'side\n', 'side commit');
	await plain(['switch', '--quiet', 'main'], repo);
	await commitFile(repo, 'shared.txt', 'main\n', 'main commit');
	await git(fixture, { method: 'PUT', path: '/repository', body: { path: repo } });

	await writeFile(join(repo, 'shared.txt'), 'unsaved edit\n');
	console.log('制造未提交改动: shared.txt =', JSON.stringify(await readFile(join(repo, 'shared.txt'), 'utf8')));

	const status = await git(fixture, { path: '/status' });
	console.log('GET /status ->', status.status, show({
		clean: status.body.workTree.clean,
		entries: status.body.workTree.entries.map(entry => ({ path: entry.path, index: entry.index, workTree: entry.workTree })),
	}));

	const statusBefore = (await plain(['status', '--porcelain'], repo)).stdout;
	const refused = await git(fixture, { method: 'POST', path: '/branch', body: { name: 'side' } });
	console.log('POST /branch {name:"side"} ->', refused.status, show(refused.body));
	console.log('   文件内容仍是', JSON.stringify(await readFile(join(repo, 'shared.txt'), 'utf8')),
		'｜git status --porcelain 未变?', (await plain(['status', '--porcelain'], repo)).stdout === statusBefore,
		'｜HEAD 仍是', (await plain(['rev-parse', '--abbrev-ref', 'HEAD'], repo)).stdout);
});

// ---------------------------------------------------------------------------------------
head('4. 验收④-切换分支后状态正确：status/branches/log 与 git CLI 一致');
await scenario(async fixture => {
	const repo = await makeRepository(fixture.root, 'app');
	await plain(['switch', '--quiet', '--create', 'side'], repo);
	await commitFile(repo, 'side.txt', 'side\n', 'side commit');
	const sideHead = await headOf(repo);
	await plain(['switch', '--quiet', 'main'], repo);
	await git(fixture, { method: 'PUT', path: '/repository', body: { path: repo } });

	const before = await git(fixture, { path: '/status' });
	console.log('切换前 GET /status -> head =', show(before.body.repository.head));

	const switched = await git(fixture, { method: 'POST', path: '/branch', body: { name: 'side' } });
	console.log('POST /branch {name:"side"} ->', switched.status, show({
		head: switched.body.repository.head,
		clean: switched.body.workTree.clean,
	}));
	console.log('   git rev-parse --abbrev-ref HEAD =', (await plain(['rev-parse', '--abbrev-ref', 'HEAD'], repo)).stdout,
		'｜与之相同?', switched.body.repository.head.branch === (await plain(['rev-parse', '--abbrev-ref', 'HEAD'], repo)).stdout);

	const status = await git(fixture, { path: '/status' });
	console.log('切换后 GET /status  -> head =', show(status.body.repository.head), '｜clean =', status.body.workTree.clean);
	const branches = await git(fixture, { path: '/branches' });
	console.log('切换后 GET /branches ->', show({ current: branches.body.current, branches: branches.body.branches.map(entry => entry.name) }));
	const log = await git(fixture, { path: '/log', query: { limit: '2' } });
	console.log('切换后 GET /log ->', log.body.commits.map(commit => commit.commit.slice(0, 7) + ' ' + commit.subject));
	console.log('   git log -1 --format=%H =', (await plain(['log', '-1', '--format=%H'], repo)).stdout,
		'｜与 API 首条一致?', log.body.commits[0].commit === sideHead);

	const missing = await git(fixture, { method: 'POST', path: '/branch', body: { name: 'no-such-branch' } });
	console.log('切到不存在的分支 ->', missing.status, show(missing.body));
});

// ---------------------------------------------------------------------------------------
head('5. 检查点关联 commit（含笔记软引用）');
await scenario(async fixture => {
	const repo = await makeRepository(fixture.root, 'app');
	await git(fixture, { method: 'PUT', path: '/repository', body: { path: repo } });
	const commit = await headOf(repo);
	await fixture.backend.createDirectory('/notes');
	await fixture.backend.writeFile('/notes/plan.md', Readable.from([Buffer.from('# plan v1\n')]), { create: true, maxBytes });
	const revision = (await fixture.backend.stat('/notes/plan.md')).etag.replaceAll('"', '');

	const created = await git(fixture, {
		method: 'POST',
		path: '/checkpoints',
		body: { name: 'v1.0', note: '首个可用版本', notePath: '/notes/plan.md' },
	});
	console.log('POST /checkpoints ->', created.status, show(created.body));
	console.log('   钉住的 commit 与 HEAD 一致?', created.body.commit === commit, '｜笔记 revision 一致?', created.body.noteReference.revisionId === revision);

	await fixture.backend.writeFile('/notes/plan.md', Readable.from([Buffer.from('# plan v2\n')]), {
		overwrite: true, etag: '"' + revision + '"', maxBytes,
	});
	const edited = await git(fixture, { path: '/checkpoints' });
	console.log('笔记改过之后 ->', show(edited.body.checkpoints[0].noteReference));

	await fixture.backend.delete('/notes/plan.md');
	const deleted = await git(fixture, { path: '/checkpoints/' + created.body.checkpointId });
	console.log('笔记删掉之后 -> available =', deleted.body.noteReference.available,
		'｜commit 仍可读?', deleted.body.commit === commit);

	const duplicate = await git(fixture, { method: 'POST', path: '/checkpoints', body: { name: 'V1.0' } });
	console.log('同名（大小写不同）->', duplicate.status, show(duplicate.body));
});

// ---------------------------------------------------------------------------------------
head('6. 判权：读写分离（viewer 可读可 fetch，不可 push/切分支；editor 可 push 不可绑定）');
await scenario(async fixture => {
	const repo = await makeRepository(fixture.root, 'app');
	const remote = await makeBare(fixture.root, 'app-remote');
	await git(fixture, { method: 'PUT', path: '/repository', body: { path: repo, remote } });

	for (const role of ['viewer', 'editor', 'owner']) {
		const rows = [];
		for (const [method, path, body] of [
			['GET', '/status', undefined],
			['POST', '/fetch', undefined],
			['POST', '/push', {}],
			['POST', '/branch', { name: 'main' }],
			['PUT', '/repository', { path: repo }],
			['PUT', '/credentials', { kind: 'https-token', label: 'x', secret: 'y' }],
		]) {
			const response = await git(fixture, { role, method, path, body });
			rows.push(method + ' ' + path + ' -> ' + response.status +
				(response.status >= 400 ? ' ' + show(response.body) : ''));
		}
		console.log(role.padEnd(7), rows.join(' | '));
	}
});

head('done');
