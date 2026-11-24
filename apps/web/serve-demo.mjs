/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { cp, readFile, realpath } from 'node:fs/promises';
import { createServer } from 'node:https';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openAuth } from './auth.mjs';
import { authGateway } from './auth-gateway.mjs';
import { webColorScheme } from './login-page.mjs';
import { createLocalWorkspace, isInside } from './local-workspace.mjs';
import { createMonitoring, defaultDiskPath } from './monitoring.mjs';
import { createWorkspaceBackends } from './workspace-backends.mjs';
import { createGitBackend } from './git-service.mjs';
import { openKnowledgeStore } from './knowledge-store.mjs';
import { officePreviewEnabled } from './office-preview-contract.mjs';
import { openOfficePreviewRuntime } from './office-preview-runtime.mjs';
import { WorkspaceError, resolveWorkspaceId, workspaceUploadLimit, workbenchAuthority } from './workspace-contract.mjs';
import { readWebRelease, webExtensionNames, webGrammarPackages } from './web-release.mjs';
import { bindLegacyWorkspaceTenant, openTenantMappingReader } from './tenant-migrate.mjs';
import { legacyTenantId } from './tenant-store.mjs';

const require = createRequire(import.meta.url);
const createApp = require(join(dirname(require.resolve('@vscode/test-web')), 'app.js')).default;
const [workspace, portText = '18990', output = '.build/log4stellar-web', ...extra] = process.argv.slice(2);
const port = Number(portText);
const listenHost = process.env.LOG4STELLAR_DEMO_HOST || '127.0.0.1';
const allowedClients = new Set((process.env.LOG4STELLAR_DEMO_CLIENTS || '').split(',').map(address => address.trim()).filter(Boolean));
if (!workspace || !Number.isInteger(port) || port < 1 || port > 65535 || extra.length) {
	throw new Error('Usage: node serve-demo.mjs <workspace> [port] [build directory | --release]');
}
const certPath = process.env.LOG4STELLAR_TLS_CERT;
const keyPath = process.env.LOG4STELLAR_TLS_KEY;
if (!certPath || !keyPath) {
	throw new Error('Set LOG4STELLAR_TLS_CERT and LOG4STELLAR_TLS_KEY to serve notes over HTTPS.');
}
const backend = process.env.LOG4STELLAR_STORAGE_BACKEND ?? 'local';
if (backend !== 'local' && backend !== 'rustfs') {
	throw new Error('LOG4STELLAR_STORAGE_BACKEND must be local or rustfs.');
}
// The storage-side workspace ID is the single authoritative identifier that the
// auth database, PostgreSQL and the object keys share. With the RustFS backend the
// positional argument already names that workspace, so it wins; otherwise the
// deployment supplies LOG4STELLAR_WORKSPACE_ID, falling back to a compatible default.
const storageWorkspaceId = resolveWorkspaceId({
	explicit: backend === 'rustfs' ? workspace : undefined,
	environment: process.env,
});
const workspacePath = backend === 'local' ? await realpath(workspace) : undefined;
const [cert, key] = await Promise.all([readFile(certPath), readFile(keyPath)]);
const maxUploadBytes = workspaceUploadLimit();
// Accounts allowed to create tenants (comma separated). Empty means the API cannot create
// tenants at all and the operator does it with the CLI — the safer default for a deployment
// that has never thought about who should be allowed to.
const platformAdminIds = new Set((process.env.LOG4STELLAR_PLATFORM_ADMINS || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean));
const auth = await openAuth({ workspaceId: storageWorkspaceId });
if (workspacePath && (isInside(workspacePath, await realpath(auth.path)) || isInside(workspacePath, await realpath(keyPath)))) {
	throw new Error('Keep authentication data and the TLS private key outside the notes workspace.');
}
const webviewHost = process.env.LOG4STELLAR_WEBVIEW_HOST?.toLowerCase();
if (webviewHost && !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(webviewHost)) {
	throw new Error('LOG4STELLAR_WEBVIEW_HOST must be a DNS suffix without a scheme or port.');
}

const runtimePath = dirname(fileURLToPath(import.meta.url));
const release = output === '--release' ? await readWebRelease(join(runtimePath, '..')) : undefined;
const location = release ? join(release.root, 'web') : resolve(output);
const languagePacks = JSON.parse(await readFile(join(location, 'out', 'nls.locales.json'), 'utf8'));
const supported = new Set(languagePacks.map(pack => pack.id));
const extensionPaths = release
	? [...webExtensionNames, 'workspace-files'].map(name => join(release.root, 'extensions', name))
	: [...webExtensionNames.map(name => resolve('extensions', name)), join(runtimePath, 'workspace-extension')];
const extensionManifests = await Promise.all(extensionPaths.map(async path =>
	JSON.parse(await readFile(join(path, 'package.json'), 'utf8'))));
const extensionProposals = Object.fromEntries(extensionManifests
	.filter(({ enabledApiProposals }) => Array.isArray(enabledApiProposals) && enabledApiProposals.length)
	.map(({ publisher, name, enabledApiProposals }) => [
		`${publisher}.${name}`.toLowerCase(), enabledApiProposals,
	]));
const markdownLanguage = extensionManifests.find(({ publisher, name }) => publisher === 'vscode' && name === 'markdown')
	.contributes.languages.find(({ id }) => id === 'markdown');
const markdownPatterns = markdownLanguage.extensions.map(extension => '*' + extension);
const markdownPreviewDefaults = Object.fromEntries(markdownPatterns.map(pattern => [pattern, 'vscode.markdown.preview.editor']));
const officeEditor = extensionManifests.find(manifest => manifest.name === 'workspace-files')
	.contributes.customEditors?.find(editor => editor.viewType === 'log4stellar.officePreview');
const officePreviewDefaults = officePreviewEnabled(process.env) && officeEditor
	? Object.fromEntries(officeEditor.selector.map(({ filenamePattern }) => [filenamePattern, officeEditor.viewType]))
	: {};
const markdownDiffDefaults = Object.fromEntries(markdownPatterns.map(pattern => [pattern, 'default']));

// A checkout build still needs these engines copied from its shared dependencies.
if (!release) {
	await Promise.all(webGrammarPackages.map(name => cp(
		resolve('node_modules', name, 'release'),
		join(location, 'node_modules', name, 'release'),
		{ recursive: true },
	)));
}
const app = await createApp({
	build: { type: 'static', location },
	esm: true,
	folderUri: 'vscode-test-web://mount/',
	extensionPaths,
});

function browserLocale(header) {
	const candidates = header.split(',').map(entry => {
		const [tag, quality] = entry.trim().split(';');
		return { tag, weight: quality === undefined ? 1 : Number(quality.trim().replace(/^q=/i, '')) };
	}).filter(({ weight }) => weight > 0 && weight <= 1).sort((left, right) => right.weight - left.weight);

	for (const { tag } of candidates) {
		let locale;
		try {
			locale = new Intl.Locale(tag);
		} catch {
			continue;
		}
		if (locale.language === 'zh') {
			const traditional = locale.script === 'Hant' || (locale.script !== 'Hans' && ['TW', 'HK', 'MO'].includes(locale.region));
			return traditional ? 'zh-tw' : 'zh-cn';
		}
		if (locale.language === 'en' || supported.has(locale.language)) {
			return locale.language;
		}
	}
	return 'en';
}

function localeOf(ctx) {
	const preference = ctx.cookies.get('vscode.nls.locale');
	return preference === 'en' || supported.has(preference) ? preference : browserLocale(ctx.get('Accept-Language'));
}

if (!release) {
	const workspaceExtension = '/static/extensions/' + webExtensionNames.length + '/';
	const pdfAssets = new Map(['pdf.min.mjs', 'pdf.worker.min.mjs'].map(name =>
		[workspaceExtension + name, join(runtimePath, 'node_modules', 'pdfjs-dist', 'build', name)]));
	app.middleware.unshift(async (ctx, next) => {
		const file = pdfAssets.get(ctx.path);
		if (!file || (ctx.method !== 'GET' && ctx.method !== 'HEAD')) {
			return next();
		}
		ctx.type = 'application/javascript';
		ctx.body = await readFile(file);
	});
}

app.middleware.unshift(async (ctx, next) => {
	await next();
	if (ctx.path !== '/' || typeof ctx.body !== 'string') {
		return;
	}
	ctx.set('Cache-Control', 'no-store');
	// Static test-web builds must explicitly enable proposals for the shipped extensions.
	ctx.body = ctx.body.replace(/(<meta id="vscode-workbench-web-configuration" data-settings=")([^"]*)"/, (_match, before, encoded) => {
		const configuration = JSON.parse(encoded.replaceAll('&quot;', '"'));
		configuration.configurationDefaults = {
			...configuration.configurationDefaults,
			'workbench.colorTheme': 'Dark 2026',
			'window.autoDetectColorScheme': false,
			'diffEditor.hideUnchangedRegions.enabled': true,
			'diffEditor.ignoreTrimWhitespace': false,
			'workbench.editorAssociations': {
				...markdownPreviewDefaults,
					...officePreviewDefaults,
				...configuration.configurationDefaults?.['workbench.editorAssociations'],
			},
			// Keep source diffs so changed lines and navigation remain available.
			'workbench.diffEditorAssociations': {
				...markdownDiffDefaults,
				...configuration.configurationDefaults?.['workbench.diffEditorAssociations'],
			},
		};
		configuration.initialColorTheme = {
			...configuration.initialColorTheme,
			themeType: webColorScheme(ctx.cookies.get('log4stellar.color-scheme')),
		};
		configuration.productConfiguration.extensionEnabledApiProposals = {
			...configuration.productConfiguration.extensionEnabledApiProposals,
			...extensionProposals,
		};
		if (ctx.state.sessionUserId) {
			configuration.folderUri.authority = workbenchAuthority(ctx.state.sessionUserId, ctx.state.workspaceId);
			if (typeof ctx.state.sessionUsername === 'string' && /^[a-z0-9._-]{3,30}$/i.test(ctx.state.sessionUsername)) {
				configuration.productConfiguration.log4stellarWebAccount = ctx.state.sessionUsername;
			}
		}
		if (webviewHost) {
			const portSuffix = auth.origin.port ? ':' + auth.origin.port : '';
			const webviewBase = `https://{{uuid}}.${webviewHost}${portSuffix}/static/build`;
			configuration.productConfiguration.webEndpointUrlTemplate = webviewBase;
			configuration.productConfiguration.webviewContentExternalBaseUrlTemplate = webviewBase + '/out/vs/workbench/contrib/webview/browser/pre/';
		}
		return `${before}${JSON.stringify(configuration).replaceAll('"', '&quot;')}"`;
	});

	const locale = localeOf(ctx);
	const account = ctx.state.sessionUserId;
	if (typeof account === 'string' && /^[a-z0-9_-]+$/i.test(account)) {
		ctx.body = ctx.body.replace('</body>', `<script type="module" id="log4stellar-session-client" data-account="${account}" src="/session-client.js"></script></body>`);
	}
	if (supported.has(locale)) {
		ctx.body = ctx.body.replace('/out/nls.messages.js"', `/out/nls.messages.${locale}.js"`);
	}
});
// A local directory backend serves exactly one workspace; the RustFS backend opens
// any imported workspace on demand. Both go through the same bounded cache.
async function openBackends() {
	if (!workspacePath) {
		const { openRustfsWorkspace } = await import('./rustfs-workspace.mjs');
		return createWorkspaceBackends({ open: workspaceId => openRustfsWorkspace(workspaceId) });
	}
	const local = await createLocalWorkspace(workspacePath);
	const cache = createWorkspaceBackends({
		limit: 1,
		open: async workspaceId => {
			if (workspaceId !== storageWorkspaceId) {
				throw new Error('The local storage backend serves only the workspace ' + storageWorkspaceId + '.');
			}
			return local;
		},
	});
	return cache;
}
const backends = await openBackends();
// The workspace → tenant mapping lives in PostgreSQL next to the workspace rows, so it is
// read through its own small pool rather than through a workspace backend: the tenant API
// needs one row and must not open an object-store client to get it. A deployment without a
// storage configuration (the local-directory backend) has no mapping, and a workspace-scoped
// tenant request is then concealed instead of allowed.
const tenantMapping = await openTenantMappingReader();
if (tenantMapping) {
	// The single-workspace deployment this release inherits belongs to the legacy tenant.
	// Binding is idempotent and never overwrites an active mapping to another tenant.
	try {
		await bindLegacyWorkspaceTenant(tenantMapping, storageWorkspaceId, { tenantId: legacyTenantId });
	} catch (error) {
		throw new Error('Could not resolve the tenant of workspace ' + storageWorkspaceId + ': ' + error.message);
	}
}
// The Office preview pipeline is opt-in per deployment (LOG4STELLAR_OFFICE_PREVIEW=1). While
// it is off this is `undefined`, so the gateway is not given the route at all and
// /api/v1/office-previews behaves as if the code had never shipped.
const officePreview = await openOfficePreviewRuntime({ workspaces: backends });
app.middleware.unshift(authGateway({
	...auth,
	workspaces: backends,
	tenants: auth.tenants,
	readWorkspaceMapping: tenantMapping ? workspaceId => tenantMapping.read(workspaceId) : undefined,
	// Creating a tenant is deployment policy, not a tenant right: the deployment names the
	// accounts allowed to do it, and an empty list means "nobody but the operator CLI".
	isPlatformAdmin: platformAdminIds.size === 0 ? undefined : userId => platformAdminIds.has(userId),
	createTenantRecord: tenantMapping ? async ({ tenantId, idempotencyKey }) => {
		await tenantMapping.recordIntent({ tenantId, idempotencyKey, operation: 'tenant.create' });
	} : undefined,
	// The Git integration is opt-in per deployment: without LOG4STELLAR_GIT_WORKSPACE_ROOTS the
	// backend is a constant 503 GitNotConfigured, and no repository can be associated.
	openGitBackend: ({ workspaceId, actor, storage }) => createGitBackend({ workspaceId, actor, storage }),
	// The knowledge index is derived data in its own PostgreSQL pool. A deployment without a
	// storage configuration (the local-directory backend) has no index: the routes answer 501
	// KnowledgeUnavailable instead of pretending the workspace has no links.
	openKnowledgeStore: async () => {
		try {
			return await openKnowledgeStore();
		} catch (error) {
			if (error instanceof WorkspaceError && error.status === 503) {
				return undefined;
			}
			throw error;
		}
	},
	openOfficePreview: officePreview && (scope => officePreview.openScope(scope)),
}, maxUploadBytes, localeOf, webviewHost));
if (officePreview) {
	// The pilot runs the worker beside the web process on the same box, single concurrency.
	// The conversion slot in PostgreSQL keeps it single even if a second one is started.
	officePreview.startWorker?.({ workspaceId: storageWorkspaceId });
}
if (allowedClients.size) {
	app.middleware.unshift(async (ctx, next) => {
		if (!allowedClients.has(ctx.req.socket.remoteAddress)) {
			ctx.throw(403);
		}
		await next();
	});
}
// Health, readiness and metrics go in front of everything else, including the client
// allowlist and the authentication gateway. Both of those answer before a route is
// chosen — 403 for an unlisted client, 421 for an origin the gateway does not
// recognise — and a probe comes from a load balancer with no cookie and no workspace
// headers. Mounting the probes later would make a healthy instance look dead. The
// three paths are public on purpose; `/readyz` and `/metrics` still refuse clients
// outside LOG4STELLAR_MONITOR_CLIENTS and the loopback range.
const monitoring = createMonitoring({
	backend,
	workspaceId: storageWorkspaceId,
	version: release?.marker?.source?.commit?.slice(0, 12) ?? 'checkout',
	backends,
	diskPath: defaultDiskPath({ workspacePath, storageConfigPath: process.env.LOG4STELLAR_STORAGE_CONFIG }),
	backupDirectory: process.env.LOG4STELLAR_BACKUP_DIR,
	// The restart counter needs one writable file. The auth directory already exists, is
	// private to this deployment and survives a restart next to `auth.sqlite`, so the
	// counter works without extra provisioning; LOG4STELLAR_MONITOR_STATE_FILE moves it.
	stateFile: process.env.LOG4STELLAR_MONITOR_STATE_FILE ?? join(auth.path, 'process-starts.json'),
});
app.middleware.unshift(monitoring);
const monitoringState = await monitoring.start();

const server = createServer({ cert, key }, app.callback());
// Every resource opened above is closed here. The list only grows, and a pool that is
// forgotten leaks a connection for the life of the process: `user_agent` allows ten.
server.on('close', () => {
	monitoring.close();
	void backends.close().catch(error => console.error('Could not close the workspace connections', error.code));
});
server.on('close', () => tenantMapping?.close().catch(error => console.error('Could not close the tenant mapping pool', error.code)));
server.on('close', () => officePreview?.close?.().catch(error => console.error('Could not close the Office preview pipeline', error.code)));
server.listen(port, listenHost, () => console.log(
	`Log4Stellar Web Demo listening at ${auth.origin.origin}`
	+ ` (probe timeout ${monitoringState.timeoutMs}ms, cache ${monitoringState.cacheMs}ms)`));
