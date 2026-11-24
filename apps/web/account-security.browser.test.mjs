import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openAuth } from './auth.mjs';
import { authGateway } from './auth-gateway.mjs';

const enabled = process.env.LOG4STELLAR_BROWSER_IT === '1';
const require = createRequire(import.meta.url);

function codeFor(base32, now = Date.now()) {
	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
	const bytes = [];
	let acc = 0;
	let bits = 0;
	for (const letter of base32) {
		acc = (acc << 5) | alphabet.indexOf(letter);
		bits += 5;
		if (bits >= 8) {
			bits -= 8;
			bytes.push((acc >>> bits) & 0xff);
		}
	}
	const counter = Buffer.alloc(8);
	counter.writeBigUInt64BE(BigInt(Math.floor(now / 30_000)));
	const hash = createHmac('sha1', Buffer.from(bytes)).update(counter).digest();
	const offset = hash[hash.length - 1] & 0xf;
	return String((hash.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

// The reason is explicit so the CI skip check can prove this suite was deliberately
// skipped instead of silently absent.
const skipReason = enabled ? false : 'set LOG4STELLAR_BROWSER_IT=1 to run the browser integration tests';
test('account-security browser: change credentials, manage devices, set up and recover MFA', { skip: skipReason, timeout: 60_000 }, async () => {
	const { chromium } = await import(process.env.LOG4STELLAR_PLAYWRIGHT_MODULE || 'playwright');
	const Koa = createRequire(require.resolve('@vscode/test-web'))('koa');
	const directory = await mkdtemp(join(tmpdir(), 'l4s-auth-browser-'));
	const cert = join(directory, 'cert.pem');
	const key = join(directory, 'key.pem');
	let browser;
	let auth;
	let server;
	try {
		execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
			'-keyout', key, '-out', cert, '-subj', '/CN=127.0.0.1', '-days', '1'], { stdio: 'ignore' });
		await writeFile(join(directory, 'secret'), randomBytes(48).toString('hex'), { mode: 0o600 });
		const app = new Koa();
		server = createServer({ cert: await readFile(cert), key: await readFile(key) }, app.callback());
		server.listen(0, '127.0.0.1');
		await once(server, 'listening');
		const origin = 'https://127.0.0.1:' + server.address().port;
		process.env.LOG4STELLAR_AUTH_DIR = directory;
		process.env.LOG4STELLAR_WEB_ORIGIN = origin;
		const workspace = 'fixture';
		auth = await openAuth({ workspaceId: workspace });
		const username = 'browser_fixture';
		const password = randomBytes(12).toString('hex');
		const newPassword = randomBytes(12).toString('hex');
		await auth.createAccount(username, password);
		app.use(authGateway(auth, 1024, () => 'en'));
		app.use(ctx => { ctx.body = 'Workspace fixture'; });

		browser = await chromium.launch({ headless: true });
		async function userPage() {
			const context = await browser.newContext({ ignoreHTTPSErrors: true });
			const page = await context.newPage();
			page.setDefaultTimeout(8_000);
			return page;
		}
		async function signIn(page, supplied) {
			await page.goto(origin + '/login');
			await page.locator('input[name=username]').fill(username);
			await page.locator('input[name=password]').fill(supplied);
			await page.locator('button[type=submit]').click();
		}
		const settings = origin + '/account/security';
		const page = await userPage();
		const other = await userPage();
		await page.goto(settings);
		assert.equal(new URL(page.url()).pathname, '/login');
		await signIn(page, password);
		await page.waitForURL(origin + '/');
		await signIn(other, password);
		await other.waitForURL(origin + '/');
		await page.goto(settings);
		await page.getByRole('heading', { name: 'Account Security' }).waitFor();
		const devices = page.locator('#devices');
		const otherRow = devices.locator('li').filter({ has: page.getByRole('button', { name: 'Revoke', exact: true }) });
		await otherRow.getByRole('textbox', { name: 'Device label' }).fill('Browser fixture');
		await otherRow.getByRole('button', { name: 'Save label' }).click();
		await otherRow.locator('strong').getByText('Browser fixture', { exact: true }).waitFor();
		await otherRow.getByRole('button', { name: 'Revoke', exact: true }).click();
		await page.getByText('Device signed out.').waitFor();
		assert.equal(await other.evaluate(() => fetch('/api/session').then(response => response.status)), 401);

		const change = page.locator('#password');
		await change.locator('[name=password]').fill(password);
		await change.locator('[name=newPassword]').fill(newPassword);
		await change.getByRole('button').click();
		await page.getByText('Changes saved.').waitFor();

		const enroll = page.locator('#enroll');
		await enroll.locator('[name=password]').fill(newPassword);
		await enroll.getByRole('button').click();
		await page.waitForFunction(() => document.getElementById('qr').naturalWidth > 0);
		assert.match(await page.locator('#qr').getAttribute('src'), /^data:image\/gif;base64,/);
		const originalCodes = await page.locator('#codes li').allTextContents();
		assert.equal(originalCodes.length, 10);
		const seed = await page.locator('#key').textContent();
		assert.match(seed, /^[A-Z2-7]+$/);
		await page.locator('#confirm [name=code]').fill(codeFor(seed));
		await page.locator('#confirm button').click();
		await page.locator('#factorState[data-enabled=true]').waitFor();
		await page.reload();
		await page.locator('#factorState[data-enabled=true]').waitFor();
		assert.equal(await page.locator('#codes li').count(), 0);

		await signIn(other, newPassword);
		await other.waitForURL(origin + '/login?twofactor=1');
		await other.goto(settings);
		assert.equal(new URL(other.url()).search, '?twofactor=1');
		await other.locator('[name=code]').fill(originalCodes[0]);
		await other.locator('button[type=submit]').click();
		await other.waitForURL(origin + '/');

		const rotate = page.locator('#rotate');
		await rotate.locator('[name=password]').fill(newPassword);
		await rotate.locator('[name=code]').fill(originalCodes[1]);
		await rotate.getByRole('button').click();
		await page.locator('#codes li').first().waitFor();
		const newCodes = await page.locator('#codes li').allTextContents();
		assert.equal(newCodes.length, 10);
		assert.notDeepEqual(newCodes, originalCodes);

		const disable = page.locator('#disable');
		await disable.locator('[name=password]').fill(newPassword);
		await disable.locator('[name=code]').fill(newCodes[0]);
		await disable.locator('input[type=checkbox]').check();
		await disable.getByRole('button').click();
		await page.locator('#factorState[data-enabled=false]').waitFor();
		await page.reload();
		await page.locator('#factorState[data-enabled=false]').waitFor();
		assert.equal(await other.evaluate(() => fetch('/api/session').then(response => response.status)), 401);
	} finally {
		await browser?.close();
		auth?.database.close();
		if (server?.listening) {
			await new Promise(resolve => server.close(resolve));
		}
		await rm(directory, { recursive: true, force: true });
	}
});
