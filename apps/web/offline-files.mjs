/**
 * Serves the offline-editing modules to the browser (docs/web-offline.md §5).
 *
 * The offline feature is a set of plain ES modules, not a bundle: the workbench loads
 * `offline-client.js` and that file imports its siblings by relative URL. Serving them
 * from one authenticated route keeps them out of `/static/build/`, which is the versioned
 * application bundle and must not change shape between releases for one feature.
 *
 * These files are code, never data. They are read once at startup and served with
 * `no-store`, because a cached copy of an older client against a newer server is exactly
 * the mismatch the schema version check would then have to detect at runtime.
 */

import { readFile } from 'node:fs/promises';

export const offlinePath = '/api/offline-editing';

/** The modules the browser may import. Ordered only for the directory listing. */
export const offlineModules = Object.freeze([
	'offline-client.js',
	'offline-contract.js',
	'offline-coordinator.js',
	'offline-provider.js',
	'offline-store.js',
	'offline-ui.js',
]);

const sources = new Map();
for (const name of offlineModules) {
	sources.set(name, await readFile(new URL('./' + name, import.meta.url), 'utf8'));
}

/** The URL a document imports, so the page and the tests agree on one spelling. */
export function offlineModulePath(name) {
	return offlinePath + '/' + name;
}

/**
 * Answers a GET for one module. A missing module answers 404 with the same body shape as
 * every other API error, so a mistyped import shows up as a broken script rather than as
 * an HTML page that the browser fails to parse with a confusing syntax error.
 */
export async function serveOfflineRequest(ctx) {
	const name = ctx.path.slice(offlinePath.length + 1);
	const source = sources.get(name);
	if (source === undefined) {
		ctx.status = 404;
		ctx.body = { error: 'NotFound' };
		return;
	}
	if (ctx.method !== 'GET' && ctx.method !== 'HEAD') {
		ctx.status = 405;
		ctx.body = { error: 'MethodNotAllowed' };
		return;
	}
	ctx.type = 'js';
	ctx.set('Cache-Control', 'no-store');
	ctx.set('X-Content-Type-Options', 'nosniff');
	ctx.body = source;
}

export function isOfflineRequest(path) {
	return path === offlinePath || path.startsWith(offlinePath + '/');
}
