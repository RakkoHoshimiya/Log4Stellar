import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { digestFile, releaseInventory, webExtensionNames, webGrammarPackages } from './web-release.mjs';
import { verifyWebRelease } from './verify-web-release.mjs';

const app = dirname(fileURLToPath(import.meta.url));
const repo = resolve(app, '../..');
const git = promisify(execFile);
const serverFiles = [
	'account-security-client.js', 'account-security-ddl.mjs', 'account-security-page.mjs',
	'account-security-runtime.mjs', 'postgres-account-security.mjs', 'account-security.mjs',
	'audit-supply-chain.mjs',
	'auth-gateway.mjs', 'auth.mjs', 'backup-cipher.mjs', 'backup-data.mjs',
	'backup-manifest.mjs', 'backup-schedule.mjs',
	'blob-gc.mjs', 'blob-gc-schema.sql', 'blob-gc-store.mjs', 'blob-retention.mjs',
	// Operational tools ship with the release: the capacity sampler, the retention CLI and
	// the deployment CLIs are what an operator runs on the deployed host, and a release that
	// omits them cannot be measured, pruned or rolled back without checking out the source
	// again.
	'capacity-limits.mjs', 'capacity-load.mjs', 'create-account.mjs', 'deploy-release.mjs',
	'import-workspace.mjs', 'prune-deployment.mjs', 'release-supervisor.mjs', 'storage-retention.mjs',
	'git-contract.mjs', 'git-credentials.mjs', 'git-files.mjs', 'git-migrate.mjs',
	'git-repository.mjs', 'git-schema.sql', 'git-service.mjs', 'git-store.mjs',
	'knowledge-files.mjs', 'knowledge-indexer.mjs', 'knowledge-migrate.mjs',
	'knowledge-parser.mjs', 'knowledge-schema.sql', 'knowledge-store.mjs',
	'local-workspace.mjs', 'login-page.mjs', 'monitoring.mjs',
	// The offline editor ships as browser modules served by offline-files.mjs, so every
	// one of them has to be in the manifest or the editor 404s in a packaged release.
	'offline-client.js', 'offline-contract.js', 'offline-coordinator.js', 'offline-files.mjs',
	'offline-provider.js', 'offline-store.js', 'offline-ui.js',
	// Office document previews (05-Office文件预览.md). Every server module of the pipeline is
	// listed here: the release is a closed manifest, so a file that is not named is not shipped
	// and the feature would fail at import time only in production.
	'office-preview-blobs.mjs', 'office-preview-contract.mjs', 'office-preview-files.mjs',
	'office-preview-migrate.mjs', 'office-preview-runner.mjs', 'office-preview-runtime.mjs',
	'office-preview-schema.sql', 'office-preview-service.mjs', 'office-preview-store.mjs',
	'office-preview-worker.mjs',
	'package.json', 'pnpm-lock.yaml', 'resumable-uploads.mjs', 'uploads-page.mjs', 'uploads-client.js', 'restore-backup.mjs', 'restore-backup-objects.mjs',
	'rustfs-blobs.mjs', 'rustfs-workspace.mjs', 'search-contract.mjs', 'search-files.mjs',
	'extended-search.mjs', 'extended-search-page.mjs', 'extended-search-client.js',
	'extract-office-text.py', 'search-format-sandbox.sh', 'extract-pdf-text.mjs', 'search-indexer.mjs', 'search-schema.sql', 'search-store.mjs', 'serve-demo.mjs', 'session-client.js',
	// The supply-chain audit is an operator gate: it must run against the deployed
	// tree, so both the checks and the CLI ship with the release.
	'supply-chain.mjs',
	'sync-contract.mjs', 'sync-files.mjs', 'sync-migrate.mjs', 'sync-schema.sql', 'sync-store.mjs',
	'create-managed-account.mjs', 'managed-auth.mjs', 'managed-workspaces.mjs', 'managed-workspaces.sql', 'managed-workspace-files.mjs',
	'tenant-management-page.mjs', 'tenant-management-client.js',
	'tenant-contract.mjs', 'tenant-files.mjs', 'tenant-migrate.mjs', 'tenant-schema.sql',
	'tenant-service.mjs', 'tenant-store.mjs', 'tenant-storage.mjs',
	'verify-web-release.mjs', 'web-release.mjs', 'workspace-access.mjs',
	'workspace-backends.mjs', 'workspace-contract.mjs', 'workspace-files.mjs', 'workspace-move.mjs',
	'workspace-members.mjs', 'workspace-schema.sql',
];
const extensions = {
	'markdown-basics': { assets: ['language-configuration.json', 'snippets', 'syntaxes'] },
	'markdown-language-features': {
		bundles: ['browser', 'webview', 'markdownEditor', 'notebook'],
		assets: ['icon.png', 'dist/browser', 'media', 'markdown-editor-out', 'notebook-out', 'schemas'],
	},
	'markdown-math': {
		bundles: ['browser', 'notebook'],
		assets: ['icon.png', 'dist/browser', 'syntaxes', 'notebook-out', 'preview-styles'],
	},
	'mermaid-markdown-features': {
		bundles: ['browser', 'webview'],
		assets: ['dist/browser', 'chat-webview-out', 'markdown-preview-out', 'notebook-out', 'markdown-editor-out', 'ThirdPartyNotices.txt'],
	},
	'theme-defaults': { assets: ['themes', 'fileicons'] },
};

async function run(command, args, cwd = repo) {
	console.log('> ' + [command, ...args].join(' '));
	await new Promise((resolve, reject) => {
		const child = spawn(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' && command === 'pnpm' });
		child.once('error', reject);
		child.once('close', (code, signal) => code === 0 ? resolve() : reject(new Error(command + ' exited with ' + (signal ?? code))));
	});
}

async function copyFiles(from, to, names) {
	for (const name of names) {
		const target = join(to, name);
		await mkdir(dirname(target), { recursive: true });
		await cp(join(from, name), target, { recursive: true });
	}
}

async function getSource() {
	const options = { cwd: repo, maxBuffer: 64 * 1024 * 1024 };
	const [{ stdout: head }, { stdout: changes }, { stdout: files }] = await Promise.all([
		git('git', ['rev-parse', 'HEAD'], options),
		git('git', ['diff', '--no-ext-diff', '--binary', 'HEAD', '--'], options),
		git('git', ['ls-files', '--others', '--exclude-standard', '-z'], options),
	]);
	const commit = head.trim();
	const hash = createHash('sha256').update(commit).update('\0').update(changes).update('\0');
	for (const file of files.split('\0').filter(Boolean).sort()) {
		hash.update(file).update('\0').update(await digestFile(join(repo, file))).update('\0');
	}
	return { commit, fingerprint: hash.digest('hex') };
}

async function assertUnused(path) {
	try {
		await lstat(path);
	} catch (error) {
		if (error.code === 'ENOENT') {
			return;
		}
		throw error;
	}
	throw new Error('Release directory already exists: ' + path);
}

const [output, translations, ...extra] = process.argv.slice(2);
if (!output || extra.length) {
	throw new Error('Usage: node apps/web/build-web-release.mjs <new release directory> [vscode-loc checkout]');
}

const target = resolve(output);
await assertUnused(target);
await mkdir(dirname(target), { recursive: true });
const stage = await mkdtemp(join(dirname(target), '.log4stellar-web-stage-'));
try {
	const source = await getSource();
	const tests = (await readdir(app)).filter(name => name.endsWith('.test.mjs')).sort();
	await run(process.execPath, ['--test', ...tests.map(name => join(app, name))]);

	for (const name of webExtensionNames) {
		const from = join(repo, 'extensions', name);
		const { bundles, assets } = extensions[name];
		for (const bundle of bundles ?? []) {
			await run(process.execPath, ['esbuild.' + bundle + '.mts'], from);
		}
		await copyFiles(from, join(stage, 'extensions', name), ['package.json', 'package.nls.json', ...assets]);
	}
	await copyFiles(join(app, 'workspace-extension'), join(stage, 'extensions', 'workspace-files'),
		['package.json', 'package.nls.json', 'package.nls.zh-cn.json', 'package.nls.zh-tw.json', 'package.nls.ja.json', 'extension.js', 'office-viewer.mjs']);
	const pdfjs = join(app, 'node_modules', 'pdfjs-dist');
	const workspaceExtension = join(stage, 'extensions', 'workspace-files');
	await copyFiles(join(pdfjs, 'build'), workspaceExtension, ['pdf.min.mjs', 'pdf.worker.min.mjs']);
	await cp(join(pdfjs, 'LICENSE'), join(workspaceExtension, 'PDFJS-LICENSE.txt'));

	// A fresh worktree may have installed dependencies with lifecycle scripts disabled.
	await copyFiles(join(repo, 'node_modules', '@vscode', 'codicons', 'dist'),
		join(repo, 'src', 'vs', 'base', 'browser', 'ui', 'codicons', 'codicon'), ['codicon.ttf']);

	const web = join(stage, 'web');
	const out = join(web, 'out');
	await run(process.execPath, ['build/next/index.ts', 'bundle', '--out', relative(repo, out), '--target', 'web', '--nls']);
	await run(process.execPath, ['apps/web/build-locales.mjs', out, ...(translations ? [resolve(translations)] : [])]);
	for (const name of webGrammarPackages) {
		const path = join('node_modules', name);
		await copyFiles(join(repo, path), join(web, path), ['release']);
	}

	const server = join(stage, 'server');
	await copyFiles(app, server, serverFiles);
	await copyFiles(repo, stage, ['LICENSE.txt', 'ThirdPartyNotices.txt']);
	await run('pnpm', ['--dir', server, '--ignore-workspace', 'install', '--prod', '--frozen-lockfile', '--ignore-scripts', '--prefer-offline', '--package-import-method=copy']);
	if ((await getSource()).fingerprint !== source.fingerprint) {
		throw new Error('Source changed during release build. Build again from a stable worktree.');
	}
	const marker = {
		format: 1,
		platform: process.platform,
		arch: process.arch,
		nodeMajor: Number(process.versions.node.split('.')[0]),
		builtAt: new Date().toISOString(),
		source,
		files: await releaseInventory(stage),
	};
	await writeFile(join(stage, 'release.json'), JSON.stringify(marker, null, '\t') + '\n', { flag: 'wx' });
	await verifyWebRelease(stage);
	await assertUnused(target);
	await rename(stage, target);
	console.log('Web release ready: ' + target);
	console.log('Source: ' + source.commit + ' (' + source.fingerprint + ')');
} finally {
	await rm(stage, { recursive: true, force: true });
}
