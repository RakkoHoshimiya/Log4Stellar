import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { readWebRelease, releaseInventory, webExtensionNames, webGrammarPackages } from './web-release.mjs';

const execute = promisify(execFile);

async function testPort() {
	const socket = createServer();
	socket.listen(0, '127.0.0.1');
	await once(socket, 'listening');
	const { port } = socket.address();
	socket.close();
	await once(socket, 'close');
	return port;
}

function request(origin, cert, path, { method = 'GET', headers = {}, body } = {}) {
	return new Promise((resolve, reject) => {
		const call = httpsRequest(new URL(path, origin), { method, headers, ca: cert, signal: AbortSignal.timeout(10_000) }, response => {
			const chunks = [];
			response.on('data', chunk => chunks.push(chunk));
			response.on('error', reject);
			response.on('end', () => resolve({
				status: response.statusCode,
				headers: response.headers,
				body: Buffer.concat(chunks),
			}));
		});
		call.on('error', reject);
		call.end(body);
	});
}

async function smokeRelease(root) {
	const temp = await mkdtemp(join(tmpdir(), 'log4stellar-release-'));
	let server;
	let serverExit;
	let log = '';
	try {
		const auth = join(temp, 'auth');
		const notes = join(temp, 'notes');
		const certPath = join(temp, 'server.crt');
		const key = join(temp, 'server.key');
		await Promise.all([mkdir(auth, { mode: 0o700 }), mkdir(notes)]);
		await Promise.all([
			writeFile(join(auth, 'secret'), randomBytes(32).toString('hex'), { mode: 0o600 }),
			writeFile(join(notes, 'Release.md'), '# Release check\n', 'utf8'),
			execute('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
				'-subj', '/CN=Log4Stellar release fixture', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', key, '-out', certPath]),
		]);
		const cert = await readFile(certPath);
		const port = await testPort();
		const origin = 'https://127.0.0.1:' + port;
		const env = {
			PATH: process.env.PATH,
			LOG4STELLAR_AUTH_DIR: auth,
			LOG4STELLAR_WEB_ORIGIN: origin,
			LOG4STELLAR_TLS_CERT: certPath,
			LOG4STELLAR_TLS_KEY: key,
			LOG4STELLAR_STORAGE_BACKEND: 'local',
		};
		const username = 'release_check';
		const password = randomBytes(24).toString('hex');
		const account = spawn(process.execPath, [join(root, 'server/create-account.mjs'), username], {
			cwd: temp, env, stdio: ['pipe', 'ignore', 'pipe'],
		});
		let setup = '';
		account.stderr.on('data', chunk => { setup += chunk; });
		account.stdin.end(password);
		const [accountStatus] = await once(account, 'close');
		if (accountStatus !== 0) {
			throw new Error('Could not provision the release fixture: ' + setup);
		}
		server = spawn(process.execPath, [join(root, 'server/serve-demo.mjs'), notes, String(port), '--release'], {
			cwd: temp, env, stdio: ['ignore', 'pipe', 'pipe'],
		});
		for (const stream of [server.stdout, server.stderr]) {
			stream.on('data', chunk => { log = (log + chunk).slice(-6_000); });
		}
		serverExit = once(server, 'close');
		const get = (path, options) => request(origin, cert, path, options);
		let login;
		for (let i = 0; i < 40 && server.exitCode === null; i++) {
			login = await get('/login').catch(() => undefined);
			if (login) {
				break;
			}
			await setTimeout(175);
		}
		assert.equal(login?.status, 200, 'release must boot outside its source checkout');
		assert.equal((await get('/static/mount/Release.md')).status, 401);
		const protectedSecurity = await get('/account/security');
		assert.equal(protectedSecurity.status, 303);
		assert.equal(protectedSecurity.headers.location, '/login');
		assert.equal((await get('/static/build/server/auth.mjs')).status, 404);
		const formHeaders = { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' };
		const signedIn = await get('/login', {
			method: 'POST', headers: formHeaders, body: new URLSearchParams({ username, password }).toString(),
		});
		assert.equal(signedIn.status, 303);
		const cookie = signedIn.headers['set-cookie'].map(value => value.split(';', 1)[0]).join('; ');
		const options = { headers: { Cookie: cookie, 'Accept-Language': 'zh-CN' } };
		const workbench = await get('/', options);
		assert.equal(workbench.status, 200);
		const security = await get('/account/security', options);
		assert.equal(security.status, 200);
		assert.match(security.body.toString(), /账户安全/);
		assert.match(security.headers['content-security-policy'], /script-src 'self'/);
		assert.equal((await get('/account/security.js')).status, 200);
		const html = workbench.body.toString();
		assert.match(html, /nls\.messages\.zh-cn\.js/);
		const config = html.match(/<meta id="vscode-workbench-web-configuration" data-settings="([^"]+)"/);
		assert.ok(config, 'workbench configuration');
		const { configurationDefaults } = JSON.parse(config[1].replaceAll('&quot;', '"'));
		assert.equal(configurationDefaults['workbench.editorAssociations']['*.md'], 'vscode.markdown.preview.editor');
		assert.equal(configurationDefaults['workbench.diffEditorAssociations']['*.md'], 'default');
		const asset = '/static/build/out/vs/workbench/workbench.web.main.internal.js';
		assert.equal((await get(asset, { method: 'HEAD' })).status, 200);
		for (const locale of ['zh-cn', 'zh-tw', 'ja']) {
			assert.equal((await get('/static/build/out/nls.messages.' + locale + '.js', { method: 'HEAD' })).status, 200);
		}
		for (const name of webGrammarPackages) {
			const entry = name === 'vscode-oniguruma' ? 'onig.wasm' : 'main.js';
			assert.equal((await get('/static/build/node_modules/' + name + '/release/' + entry, { method: 'HEAD' })).status, 200);
		}
		for (const [index, name] of [...webExtensionNames, 'workspace-files'].entries()) {
			const path = '/static/extensions/' + index + '/';
			const response = await get(path + 'package.json');
			assert.equal(response.status, 200, 'release must serve ' + name);
			const { browser } = JSON.parse(response.body);
			if (browser) {
				const entry = browser.replace(/^\.\//, '') + (browser.endsWith('.js') ? '' : '.js');
				assert.equal((await get(path + entry, { method: 'HEAD' })).status, 200, name + ' browser bundle');
			}
		}
		for (const asset of ['office-viewer.mjs', 'pdf.min.mjs', 'pdf.worker.min.mjs', 'PDFJS-LICENSE.txt']) {
			const url = '/static/extensions/' + webExtensionNames.length + '/' + asset;
			assert.equal((await get(url, { method: 'HEAD' })).status, 200, 'Office preview ' + asset);
		}
		const previews = [
			['markdown-language-features', 'media/index.js'],
			['markdown-language-features', 'markdown-editor-out/editor.js'],
			['markdown-math', 'preview-styles/index.css'],
			['mermaid-markdown-features', 'markdown-preview-out/index.js'],
			['theme-defaults', 'themes/dark_modern.json'],
		];
		for (const [name, asset] of previews) {
			const url = '/static/extensions/' + webExtensionNames.indexOf(name) + '/' + asset;
			assert.equal((await get(url, { method: 'HEAD' })).status, 200, name + ' ' + asset);
		}
		const note = await get('/static/mount/Release.md', options);
		assert.equal(note.status, 200);
		assert.equal(note.body.toString(), '# Release check\n');
		assert.equal((await get('/api/session', options)).status, 200);
		assert.equal((await get('/api/session/logout', {
			method: 'POST', headers: { Cookie: cookie, Origin: origin },
		})).status, 204);
		assert.equal((await get('/static/mount/Release.md', options)).status, 401);
	} catch (error) {
		if (log) {
			console.error(log);
		}
		throw error;
	} finally {
		if (server?.exitCode === null) {
			server.kill();
			await serverExit;
		}
		await rm(temp, { recursive: true, force: true });
	}
}

export async function verifyWebRelease(directory) {
	const { root, marker } = await readWebRelease(directory);
	const inventory = await releaseInventory(root);
	const expected = new Map(marker.files);
	for (const [name, digest] of inventory) {
		assert.equal(digest, expected.get(name), 'Unexpected or modified release file: ' + name);
		expected.delete(name);
	}
	assert.equal(expected.size, 0, 'Missing release file: ' + expected.keys().next().value);
	await smokeRelease(root);
	console.log('Verified release files, startup, authentication, localized workbench, built-in extensions and workspace access.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	if (!process.argv[2] || process.argv.length !== 3) {
		throw new Error('Usage: node apps/web/verify-web-release.mjs <release directory>');
	}
	await verifyWebRelease(process.argv[2]);
}
