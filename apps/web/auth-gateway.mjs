import { readFile } from 'node:fs/promises';
import { managedWorkspacePath, serveManagedWorkspaceRequest } from './managed-workspace-files.mjs';
import { tenantManagementPage } from './tenant-management-page.mjs';
import { accountSecurityPage } from './account-security-page.mjs';
import {
	accountSecurityErrorCodes,
	accountSecurityRoutes,
	authStates,
	authorizeRequest,
	classifyAuthState,
	securityPaths,
	securityRouteFor,
	twoFactorPendingRedirect,
} from './account-security.mjs';
import { challengeCookieName, clearedChallengeCookie, clearedSessionCookie, readCookie } from './account-security-runtime.mjs';
import { loginPage, secondFactorPage, webColorScheme } from './login-page.mjs';
import { WorkspaceError, isValidWorkspaceId, normalizeWorkspacePath } from './workspace-contract.mjs';
import { allowsWorkspace, authorizeWorkspace, workspaceCapabilities } from './workspace-access.mjs';
import { syncPath, serveSyncRequest } from './sync-files.mjs';
import { gitPath, serveGitRequest } from './git-files.mjs';
import { knowledgeMountPath, serveKnowledgeRequest } from './knowledge-files.mjs';
import { officePreviewPath, serveOfficePreviewRequest } from './office-preview-files.mjs';
import { uploadApiPath, uploadPagePath } from './resumable-uploads.mjs';
import { uploadsPage } from './uploads-page.mjs';
import { mountPath, serveWorkspaceFile } from './workspace-files.mjs';
import { isOfflineRequest, serveOfflineRequest } from './offline-files.mjs';
import { searchPath, serveSearchRequest } from './search-files.mjs';
import { invitationAcceptPath, serveTenantRequest, tenantPath } from './tenant-files.mjs';

import { extendedSearchPagePath, extendedSearchPath } from './extended-search.mjs';
import { extendedSearchPage } from './extended-search-page.mjs';

const extendedSearchClient = await readFile(new URL('./extended-search-client.js', import.meta.url), 'utf8');
const uploadsClient = await readFile(new URL('./uploads-client.js', import.meta.url), 'utf8');
const sessionClient = await readFile(new URL('./session-client.js', import.meta.url), 'utf8');
const accountSecurityClient = await readFile(new URL('./account-security-client.js', import.meta.url), 'utf8');
const tenantManagementClient = await readFile(new URL('./tenant-management-client.js', import.meta.url), 'utf8');
const tenantManagementPath = '/account/tenants';
const accountSecurityPagePath = '/account/security';
const loginPath = '/login';
const workbenchPath = '/';
export const workspaceHeader = 'X-Log4Stellar-Workspace';

function redirect(ctx, path) {
	ctx.status = 303;
	ctx.set('Location', path);
}

function showLogin(ctx, locale, notice, status = 200) {
	ctx.type = 'html';
	ctx.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
	ctx.body = loginPage(locale, notice, webColorScheme(ctx.cookies.get('log4stellar.color-scheme')), ctx.query.switch === '1');
	ctx.status = status;
}

function showSecondFactor(ctx, locale, notice, status = 200) {
	ctx.type = 'html';
	ctx.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
	ctx.body = secondFactorPage(locale, notice, webColorScheme(ctx.cookies.get('log4stellar.color-scheme')));
	ctx.status = status;
}

async function readForm(ctx) {
	if (!ctx.is('application/x-www-form-urlencoded')) {
		ctx.throw(415);
	}
	const chunks = [];
	let length = 0;
	for await (const chunk of ctx.req) {
		length += chunk.length;
		if (length > 2048) {
			ctx.throw(413);
		}
		chunks.push(chunk);
	}
	return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

/**
 * Resolves the workspace a request targets and the caller's role in it. Every
 * failure path is the same 403 so a non-member cannot tell "not a member" from
 * "no such workspace" (contract §5).
 */
async function resolveWorkspace(ctx, session, { defaultWorkspaceId, resolveRole, workspaces, allowsMappedWorkspace, requested = ctx.get(workspaceHeader) }) {
	const workspaceId = typeof requested === 'string' && requested ? requested.toLowerCase() : await defaultWorkspaceId(session.user.id);
	if (!workspaceId || !isValidWorkspaceId(workspaceId)) {
		return undefined;
	}
	const role = await resolveRole(session.user.id, workspaceId);
	if (role === undefined || !await allowsMappedWorkspace(session.user.id, workspaceId)) {
		return undefined;
	}
	let backend;
	try {
		backend = await workspaces.acquire(workspaceId);
	} catch {
		// An unknown or unopened workspace is indistinguishable from a forbidden one.
		return undefined;
	}
	return { id: workspaceId, role, backend };
}

// The account menu addresses a session by a digest.
function routeParameters(pathname) {
	const match = /^\/api\/account-security\/sessions\/([A-Za-z0-9_-]{22})\/(?:label|revoke)$/.exec(pathname);
	return match ? { sessionId: match[1] } : {};
}

// Every optional collaborator here is a mount: `openGitBackend` gates /git/v1,
// `openKnowledgeStore` gates the knowledge mounts, `openOfficePreview` gates
// /api/v1/office-previews, and the four `tenant*` options gate /api/v1/tenants. A
// deployment that does not pass one gets a 404 from that mount rather than an
// unauthenticated route, which is why they default to undefined instead of throwing.
export function authGateway({ auth, origin, canReadWorkspace, matchesWorkspaceAccount, defaultWorkspaceId, workspacesOf, resolveRole, workspaces, openGitBackend, openKnowledgeStore, openOfficePreview, resolveChallenge, accountSecurity, tenants, readWorkspaceMapping, isPlatformAdmin, createTenantRecord, managedWorkspaces, resumableUploads, extendedSearch, hasSecondFactor }, maxUploadBytes, localeOf, webviewHost) {
	async function allowsMappedWorkspace(userId, workspaceId) {
		const mapping = await readWorkspaceMapping?.(workspaceId);
		if (!mapping) {
			return !managedWorkspaces;
		}
		if (mapping.status !== 'active' || !tenants) {
			return false;
		}
		try {
			await tenants.describeMembership(userId, mapping.tenantId);
			return true;
		} catch (error) {
			if (error.status === 404) {
				return false;
			}
			throw error;
		}
	}

	async function callAuth(ctx, endpoint, method = 'GET', body) {
		const headers = new Headers({
			Cookie: ctx.get('Cookie'),
			'User-Agent': ctx.get('User-Agent'),
			'x-log4stellar-peer': ctx.req.socket.remoteAddress,
		});
		if (method !== 'GET') {
			headers.set('Origin', origin.origin);
		}
		if (body !== undefined) {
			headers.set('Content-Type', 'application/json');
		}
		return auth.handler(new Request(new URL('/api/auth/' + endpoint, origin), {
			method, headers, body: body === undefined ? undefined : JSON.stringify(body),
		}));
	}

	function isWebviewOrigin(value) {
		if (!webviewHost || !value.startsWith('https://')) {
			return false;
		}
		const name = value.slice(8);
		const separator = name.indexOf('.');
		const port = origin.port ? ':' + origin.port : '';
		return separator > 0 && /^[0-9a-v]{52}$/.test(name.slice(0, separator))
			&& name.slice(separator + 1) === webviewHost + port;
	}

	/**
	 * Runs one /api/account-security route and turns the runtime's uniform result
	 * into a response. Cookie side effects all funnel through `sendCookie` so a
	 * cleared challenge and a freshly minted session are never dropped.
	 */
	async function dispatchSecurity(ctx, { state, nowMs, route, body, sendCookie }) {
		if (body !== undefined && ctx.body === undefined) {
			ctx.body = body;
		}
		try {
			const result = await accountSecurity.handle({ ctx, state, route: { ...route, params: routeParameters(ctx.path) }, nowMs });
			if (result?.setCookie) {
				sendCookie(result.setCookie);
			}
			if (result?.clearChallenge) {
				sendCookie(clearedChallengeCookie());
			}
			if (result?.clearSessionCookie) {
				sendCookie(clearedSessionCookie());
			}
			ctx.body = result?.body ?? { ok: true };
			return true;
		} catch (error) {
			if (!(error instanceof WorkspaceError)) {
				throw error;
			}
			// Only the stable code leaves the process; the message may carry detail
			// about the account that the caller has not earned.
			ctx.status = error.status;
			ctx.body = { error: error.code };
			return false;
		}
	}

	return async (ctx, next) => {
		if (!ctx.secure || ctx.host !== origin.host) {
			if (ctx.secure && isWebviewOrigin('https://' + ctx.host) && (ctx.method === 'GET' || ctx.method === 'HEAD') && ctx.path.startsWith('/static/build/')) {
				await next();
			} else {
				ctx.status = 421;
			}
			return;
		}

		const mounted = ctx.path === mountPath || ctx.path.startsWith(mountPath + '/');
		const uploading = ctx.path === uploadApiPath || ctx.path.startsWith(uploadApiPath + '/');
		const uploadingPage = ctx.path === uploadPagePath;
		const extendedPage = ctx.path === extendedSearchPagePath;
		if (ctx.path === '/advanced-search.js' && extendedSearch && ctx.method === 'GET') {
			ctx.type = 'application/javascript';
			ctx.body = extendedSearchClient;
			return;
		}
		const syncing = ctx.path === syncPath || ctx.path.startsWith(syncPath + '/');
		const gitting = ctx.path === gitPath || ctx.path.startsWith(gitPath + '/');
		const searching = ctx.path === searchPath || ctx.path.startsWith(searchPath + '/');
		// Backlinks, tags and rename plans live under their own mount: a knowledge request
		// is authorized per workspace exactly like a file request, but it is not a file
		// request, so the static/webview fallthrough must not swallow it.
		const knowing = ctx.path === knowledgeMountPath || ctx.path.startsWith(knowledgeMountPath + '/');
		// Office previews are gated by a feature flag that defaults to off (§4). When the
		// flag is off `openOfficePreview` is not supplied at all, so this route does not
		// exist: the request falls through to the static application exactly like any
		// other unknown path, instead of advertising a disabled API.
		const officePreviewing = typeof openOfficePreview === 'function'
			&& (ctx.path === officePreviewPath || ctx.path.startsWith(officePreviewPath + '/'));
		const api = ctx.path === '/api/session' || ctx.path.startsWith('/api/session/');
		const tenantManagement = ctx.path === tenantManagementPath;
		const accountSettings = ctx.path === accountSecurityPagePath || tenantManagement;
		const login = ctx.path === loginPath;
		const workbench = ctx.path === workbenchPath;
		// Both of these used to fall through to the application. They must not: one
		// is the account-security surface, the other is the authentication library's
		// own API, whose `/list-sessions` returns raw bearer tokens (§4.5 item 4).
		const accountSecurityCall = ctx.path === securityPaths.accountSecurity
			|| ctx.path.startsWith(securityPaths.accountSecurity + '/');
		// The tenant API is a sibling of the workspace mounts, not a child: it addresses a
		// tenant, which is above any workspace, so it cannot be routed by the workspace
		// header the mounts use.
		const managedRequest = Boolean(managedWorkspaces && (ctx.path === managedWorkspacePath || ctx.path.startsWith(managedWorkspacePath + '/')));
		const tenancy = ctx.path === tenantPath || ctx.path.startsWith(tenantPath + '/')
			|| ctx.path === invitationAcceptPath;
		const authApiCall = ctx.path === securityPaths.authApi || ctx.path.startsWith(securityPaths.authApi + '/');
		if (ctx.path === '/uploads.js' && ctx.method === 'GET') {
			ctx.type = 'js';
			ctx.set('Cache-Control', 'no-store');
			ctx.set('X-Content-Type-Options', 'nosniff');
			ctx.body = uploadsClient;
			return;
		}
		if (ctx.path === securityPaths.sessionClient && ctx.method === 'GET') {
			ctx.type = 'js';
			ctx.set('Cache-Control', 'no-store');
			ctx.body = sessionClient;
			return;
		}
		if ([accountSecurityPagePath, tenantManagementPath].some(path => ctx.path === path + '.js') && ctx.method === 'GET') {
			ctx.type = 'js';
			ctx.set('Cache-Control', 'no-store');
			ctx.set('X-Content-Type-Options', 'nosniff');
			ctx.body = ctx.path === tenantManagementPath + '.js' ? tenantManagementClient : accountSecurityClient;
			return;
		}
		// The offline modules are code, not data: they are served before the session gate
		// for the same reason the login page is — a browser that cannot load the client
		// module cannot ask for a session either. Nothing here is workspace content.
		if (isOfflineRequest(ctx.path)) {
			await serveOfflineRequest(ctx);
			return;
		}
		// Every non-application mount must appear here. A mount missing from this condition
		// is served the workbench instead of its handler, which looks like a broken route
		// rather than a routing bug, so the list is kept in the order the booleans are built.
		if (!login && !api && !accountSettings && !mounted && !workbench && !syncing && !gitting && !uploading && !uploadingPage && !extendedPage
			&& !searching && !knowing && !officePreviewing && !tenancy && !managedRequest && !accountSecurityCall && !authApiCall) {
			await next();
			// Permit isolated Markdown webviews to load bundled scripts and styles.
			// Workspace files and session endpoints stay outside this CORS rule.
			const requestOrigin = ctx.get('Origin');
			if ((ctx.method === 'GET' || ctx.method === 'HEAD') && ctx.path.startsWith('/static/extensions/') && isWebviewOrigin(requestOrigin)) {
				ctx.vary('Origin');
				ctx.set('Access-Control-Allow-Origin', requestOrigin);
			}
			return;
		}

		ctx.set('Cache-Control', 'private, no-store');
		ctx.set('X-Content-Type-Options', 'nosniff');
		ctx.set('Referrer-Policy', 'same-origin');
		const reading = ctx.method === 'GET' || ctx.method === 'HEAD';
		if (!reading && ctx.get('Origin') !== origin.origin) {
			ctx.status = 403;
			return;
		}

		// Every Set-Cookie this middleware emits goes through one sink so the
		// cleared-challenge and cleared-session cookies are not lost on a plain
		// koa context, which has no cookie list of its own.
		const cookies = [];
		const sendCookie = value => {
			cookies.push(value);
			ctx.append('Set-Cookie', value);
		};
		ctx.getSetCookie = () => cookies.slice();

		// The library's own endpoints stay closed. `/api/auth/list-sessions` hands
		// back raw bearer tokens (§4.5 item 4), and everything the account menu
		// needs is served from /api/account-security instead.
		if (authApiCall) {
			ctx.status = 404;
			return;
		}

		const nowMs = Date.now();
		let session;
		{
			const statusResponse = await callAuth(ctx, 'get-session');
			if (!statusResponse.ok) {
				const status = statusResponse.status === 429 ? 429 : 503;
				if (login) {
					showLogin(ctx, localeOf(ctx), status === 429 ? 'limited' : 'unavailable', status);
				} else {
					ctx.status = status;
				}
				return;
			}
			session = await statusResponse.json();
		}
		// The challenge is evidence, not a permission: `half` means "the library
		// deleted the session row and handed back this cookie". Nothing here
		// invents a state the database does not already justify.
		const challenge = resolveChallenge
			? await resolveChallenge(readCookie(ctx.get('Cookie'), challengeCookieName), nowMs)
			: undefined;
		const authState = classifyAuthState({ session, challenge, nowMs });
		const gateState = { ...authState, session, challenge };

		if (login && ctx.method === 'POST') {
			const locale = localeOf(ctx);
			const form = await readForm(ctx);
			// A live challenge turns /login into the second-factor form. Dispatching
			// it here keeps the browser on one origin and one cookie jar.
			if (authState.state === authStates.half && form.has('code')) {
				const code = form.get('code');
				const path = /^\d{6}$/.test(code) ? accountSecurityRoutes.verifyTotp : accountSecurityRoutes.verifyRecoveryCode;
				const completed = await dispatchSecurity(ctx, { state: gateState, nowMs, route: securityRouteFor('POST', path), body: { code }, sendCookie });
				if (completed) {
					ctx.body = undefined;
					redirect(ctx, workbenchPath);
				} else {
					const status = ctx.status;
					const error = ctx.body?.error;
					const notice = status >= 500 ? 'unavailable'
						: status === 429 || error === 'TooManyAttempts' ? 'limited'
							: error === accountSecurityErrorCodes.totpCodeReplayed ? 'reused' : 'invalid';
					showSecondFactor(ctx, locale, notice, status);
				}
				return;
			}
			if (form.has('code')) {
				showLogin(ctx, locale, 'expired', 401);
				return;
			}
			const credentials = { username: form.get('username')?.trim() ?? '', password: form.get('password') ?? '', rememberMe: true };
			if (!/^[a-z\d._]{3,30}$/i.test(credentials.username) || credentials.password.length < 8 || credentials.password.length > 128) {
				showLogin(ctx, locale, 'invalid', 401);
				return;
			}
			const response = await callAuth(ctx, 'sign-in/username', 'POST', credentials);
			if (response.ok) {
				const payload = await response.json();
				if (payload?.twoFactorRedirect) {
					// The correct password is only the first factor. Forward the
					// challenge cookie and land on the code form; no session exists.
					for (const value of response.headers.getSetCookie()) {
						sendCookie(value);
					}
					redirect(ctx, twoFactorPendingRedirect);
					return;
				}
				const { user } = payload;
				if (!managedWorkspaces && !await canReadWorkspace(user.id)) {
					// Invalidate the session created by the authentication library before returning.
					const cookie = response.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ');
					const headers = new Headers({ Cookie: cookie, Origin: origin.origin });
					await auth.handler(new Request(new URL('/api/auth/sign-out', origin), { method: 'POST', headers }));
					showLogin(ctx, locale, 'forbidden', 403);
					return;
				}
				for (const value of response.headers.getSetCookie()) {
					sendCookie(value);
				}
				redirect(ctx, workbenchPath);
			} else if (response.status === 429) {
				showLogin(ctx, locale, 'limited', 429);
			} else if (response.status >= 500) {
				showLogin(ctx, locale, 'unavailable', 503);
			} else {
				showLogin(ctx, locale, 'invalid', 401);
			}
			return;
		}

		if (login) {
			if (session && (managedWorkspaces || await canReadWorkspace(session.user.id))) {
				redirect(ctx, workbenchPath);
			} else if (authState.state === authStates.half) {
				showSecondFactor(ctx, localeOf(ctx));
			} else {
				showLogin(ctx, localeOf(ctx), session ? 'forbidden' : ctx.query.expired === '1' ? 'expired' : undefined);
			}
			return;
		}

		if (accountSettings) {
			if (ctx.method !== 'GET' && ctx.method !== 'HEAD') {
				ctx.set('Allow', 'GET, HEAD');
				ctx.status = 405;
				return;
			}
			if (authState.state !== authStates.full) {
				redirect(ctx, authState.state === authStates.half ? twoFactorPendingRedirect : loginPath);
				return;
			}
			ctx.type = 'html';
			ctx.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'; img-src data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
			ctx.body = (tenantManagement ? tenantManagementPage : accountSecurityPage)({
				locale: localeOf(ctx),
				scheme: ctx.cookies.get('log4stellar.color-scheme'),
				accountId: session.user.id,
				twoFactorEnabled: session.user.twoFactorEnabled,
				managed: Boolean(managedWorkspaces),
			});
			ctx.status = 200;
			return;
		}

		if ((uploadingPage || extendedPage) && authState.state !== authStates.full) {
			redirect(ctx, authState.state === authStates.half ? twoFactorPendingRedirect : loginPath);
			return;
		}
		// The single authorization gate (§5.3). It runs before any body is read and
		// before a workspace backend is acquired, which is what makes the refusal
		// uniform: a half-authenticated caller cannot turn a mount into a 404 or a
		// malformed body into a 400.
		const decision = authorizeRequest({ state: authState, method: ctx.method, pathname: ctx.path });
		if (!decision.allow) {
			if (decision.action === 'redirect-challenge') {
				redirect(ctx, decision.location);
				return;
			}
			if (decision.action === 'login' && workbench) {
				redirect(ctx, loginPath);
				return;
			}
			ctx.status = decision.status;
			if (decision.error) {
				ctx.body = { error: decision.error };
			}
			return;
		}

		if (decision.action === 'logout') {
			// Abandoning a challenge is allowed: the browser throws away a cookie
			// that has no session behind it.
			if (authState.state === authStates.half) {
				await accountSecurity?.clearChallenge?.(challenge.identifier);
				ctx.status = 200;
				sendCookie(clearedChallengeCookie());
				ctx.body = { ok: true };
				return;
			}
			const response = await callAuth(ctx, 'sign-out', 'POST');
			for (const value of response.headers.getSetCookie()) {
				sendCookie(value);
			}
			ctx.status = response.ok ? 204 : response.status;
			return;
		}

		if (accountSecurityCall) {
			const route = securityRouteFor(ctx.method, ctx.path);
			if (!route) {
				ctx.status = 404;
				ctx.body = { error: 'NotFound' };
				return;
			}
			const expectedAccount = ctx.get('X-Log4Stellar-Account');
			if (expectedAccount && session?.user?.id !== expectedAccount) {
				ctx.status = 409;
				ctx.body = { error: 'AccountChanged' };
				return;
			}
			if (!accountSecurity) {
				ctx.status = 503;
				return;
			}
			await dispatchSecurity(ctx, { state: gateState, nowMs, route, sendCookie });
			return;
		}

		let secondFactor;
		const verifiedSecondFactor = () => secondFactor ??= Promise.resolve(hasSecondFactor?.(session) ?? false);
		async function canAccessWorkspace(userId, workspaceId) {
			if (!await allowsMappedWorkspace(userId, workspaceId)) return false;
			if (!managedWorkspaces) return true;
			const mapping = await readWorkspaceMapping(workspaceId);
			return Boolean(mapping) && (!await managedWorkspaces.requiresSecondFactor(mapping.tenantId) || await verifiedSecondFactor());
		}

		if (tenancy || managedRequest) {
			// The tenant API requires a full session: a half-authenticated caller holds a
			// challenge cookie and no principal, and every route below keys its decision on
			// `session.user.id`. `authorizeRequest` above already refused anything but a full
			// session for this path, so `session` is present here.
			if (!session?.user?.id) {
				ctx.status = 401;
				return;
			}
			const expected = ctx.get('X-Log4Stellar-Account');
			if (expected && expected !== session.user.id) {
				ctx.status = 409;
				ctx.body = { error: 'AccountChanged' };
				return;
			}
			if (managedRequest) {
				await serveManagedWorkspaceRequest(ctx, { store: managedWorkspaces, principalId: session.user.id, hasSecondFactor: verifiedSecondFactor });
				return;
			}
			if (managedWorkspaces) {
				ctx.status = 404;
				return;
			}
			await serveTenantRequest(ctx, {
				principalId: session.user.id,
				store: tenants,
				readWorkspaceMapping,
				resolveWorkspaceRole: (userId, workspaceId) => resolveRole(userId, workspaceId),
				workspacesOf,
				isPlatformAdmin,
				createTenantRecord,
			});
			return;
		}

		const signOut = ctx.path === '/api/session/logout' && ctx.method === 'POST';
		const activity = ctx.path === '/api/session/activity' && ctx.method === 'POST';
		if ((!reading && !activity && !signOut && !mounted && !syncing && !gitting && !uploading && !searching && !knowing && !officePreviewing)
			|| (api && ctx.path !== '/api/session' && !activity && !signOut)) {
			ctx.status = 405;
			return;
		}
		if (!mounted && !syncing && !gitting && !uploading && !uploadingPage && !extendedPage && !searching && !knowing && !officePreviewing && !managedWorkspaces && !await canReadWorkspace(session.user.id)) {
			ctx.status = 403;
			return;
		}
		const expectedAccount = ctx.get('X-Log4Stellar-Account');
		// Already open workbenches may still send their URI authority in the old header.
		const workspaceAccount = mounted || syncing || gitting || uploading || uploadingPage || extendedPage || searching || knowing || officePreviewing ? ctx.get('X-Log4Stellar-Workspace-Account') || expectedAccount.toLowerCase() : '';
		const mismatchedSession = (api || uploading) && expectedAccount && expectedAccount !== session.user.id;
		const mismatchedWorkspace = workspaceAccount && !await matchesWorkspaceAccount(session.user.id, workspaceAccount);
		if (mismatchedSession || mismatchedWorkspace) {
			ctx.status = 409;
			ctx.body = { error: 'AccountChanged' };
			return;
		}
		if (signOut) {
			const response = await callAuth(ctx, 'sign-out', 'POST');
			ctx.append('Set-Cookie', response.headers.getSetCookie());
			ctx.status = response.ok ? 204 : response.status;
			return;
		}
		if (activity) {
			const response = await callAuth(ctx, 'get-session', 'POST');
			if (!response.ok) {
				ctx.status = response.status;
				return;
			}
			session = await response.json();
			if (!session) {
				ctx.status = 401;
				return;
			}
			ctx.append('Set-Cookie', response.headers.getSetCookie());
		}
		if (api) {
			const workspaces = [];
			for (const workspace of await workspacesOf(session.user.id)) {
				if (await canAccessWorkspace(session.user.id, workspace.id)) {
					workspaces.push(workspace);
				}
			}
			const defaultId = await defaultWorkspaceId(session.user.id);
			ctx.state.workspaceId = workspaces.find(workspace => workspace.id === defaultId)?.id ?? workspaces[0]?.id;
			ctx.body = {
				remainingMs: Math.max(0, Date.parse(session.session.expiresAt) - Date.now()),
				accountId: session.user.id,
				workspaceId: ctx.state.workspaceId,
				workspaces,
			};
		} else if (mounted || syncing || gitting || uploading || uploadingPage || extendedPage || searching || knowing || officePreviewing) {
			// Mounted file, sync, search, knowledge and preview requests are authorized per
			// workspace, not by the login gate.
			const target = await resolveWorkspace(ctx, session, {
				defaultWorkspaceId, resolveRole, workspaces, allowsMappedWorkspace: canAccessWorkspace,
				...(uploadingPage || extendedPage ? { requested: ctx.query.l4sWorkspace } : {}),
			});
			if (!target) {
				ctx.body = { error: 'NoPermissions' };
				ctx.status = 403;
				return;
			}
			ctx.state.workspaceId = target.id;
			ctx.state.workspaceRole = target.role;
			try {
				// The Git backend is built per request and holds no connection: it reads the
				// binding from the database and re-validates the repository path on every call.
				// It borrows `target.backend` so a checkpoint can digest the note the user is
				// looking at (§3.4).
				const gitBackend = gitting ? openGitBackend({ workspaceId: target.id, actor: session.user.id, storage: target.backend }) : undefined;
				const workspace = gitBackend
					? authorizeWorkspace(gitBackend, { role: target.role })
					: authorizeWorkspace(target.backend, { role: target.role });
				if (uploading || uploadingPage) {
					try {
						if (!allowsWorkspace(target.role, workspaceCapabilities.write)) {
							throw new WorkspaceError(403, 'NoPermissions');
						}
						if (!resumableUploads || typeof target.backend.syncPutFile !== 'function') {
							throw new WorkspaceError(501, 'UploadUnavailable');
						}
						if (uploadingPage) {
							const directory = normalizeWorkspacePath(typeof ctx.query.directory === 'string' ? ctx.query.directory : '/');
							ctx.type = 'html';
							ctx.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'");
							ctx.body = uploadsPage({ locale: localeOf(ctx), theme: webColorScheme(ctx.cookies.get('log4stellar.color-scheme')),
								account: session.user.id, workspaceId: target.id, directory, maxBytes: maxUploadBytes });
							ctx.status = 200;
						} else {
							await resumableUploads.handle(ctx, { workspaceId: target.id, accountId: session.user.id, backend: target.backend });
						}
					} catch (error) {
						if (!(error instanceof WorkspaceError)) throw error;
						ctx.body = { error: error.code };
						ctx.status = error.status;
					}
				} else if (gitting) {
					await serveGitRequest(ctx, workspace, gitBackend, target.id, maxUploadBytes);
				} else if (syncing) {
					await serveSyncRequest(ctx, workspace, target.backend, target.id, maxUploadBytes);
				} else if (extendedPage || ctx.path === extendedSearchPath) {
					try {
						workspace.require(workspaceCapabilities.history);
						if (!extendedSearch || typeof target.backend.openRevision !== 'function') {
							throw new WorkspaceError(501, 'SearchUnavailable');
						}
						if (extendedPage) {
							ctx.type = 'html';
							ctx.set('Cache-Control', 'no-store');
							ctx.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
							ctx.body = extendedSearchPage({ locale: localeOf(ctx), workspaceId: target.id });
						} else {
							if (ctx.method !== 'GET') throw new WorkspaceError(405, 'MethodNotAllowed');
							ctx.set('Cache-Control', 'no-store');
							ctx.body = await extendedSearch.search({ workspaceId: target.id, backend: workspace,
								scope: ctx.query.scope, q: ctx.query.q, cursor: ctx.query.cursor });
						}
					} catch (error) {
						if (!(error instanceof WorkspaceError)) throw error;
						if (error.code === 'SearchBusy') ctx.set('Retry-After', '2');
						ctx.body = { error: error.code };
						ctx.status = error.status;
					}
				} else if (searching) {
					await serveSearchRequest(ctx, workspace, target.backend, target.id, maxUploadBytes);
				} else if (knowing) {
					// The index lives in its own pool: it is derived data, not workspace files,
					// and listing backlinks must not hold a workspace backend lease open.
					const store = openKnowledgeStore ? await openKnowledgeStore() : undefined;
					await serveKnowledgeRequest(ctx, workspace, target.backend, target.id, store);
				} else if (officePreviewing) {
					// The preview scope owns the derived-PDF store, not the workspace store: it
					// can read the original through the authorized facade but never writes it.
					const scope = await openOfficePreview({ workspaceId: target.id, storage: target.backend });
					await serveOfficePreviewRequest(ctx, workspace, scope);
				} else {
					await serveWorkspaceFile(ctx, workspace, maxUploadBytes);
				}
			} finally {
				// Hold the cache slot until the response body has been flushed. A response
				// that already ended, already failed, or a test double without one releases
				// immediately: a missed event would pin the slot for the life of the process.
				// The guard keeps a late event from releasing a second time.
				let released = false;
				const release = () => {
					if (!released) {
						released = true;
						workspaces.release(target.id);
					}
				};
				const dead = ctx.res && (ctx.res.writableEnded || ctx.res.destroyed || ctx.res.writableFinished);
				if (typeof ctx.res?.once === 'function' && !dead) {
					ctx.res.once('close', release);
					ctx.res.once('finish', release);
				} else {
					release();
				}
			}
		} else {
			let selectedWorkspaceId = await defaultWorkspaceId(session.user.id);
			if (ctx.path === '/' && ctx.query.l4sWorkspace !== undefined) {
				const requested = ctx.query.l4sWorkspace;
				if (!isValidWorkspaceId(requested) || !await resolveRole(session.user.id, requested)) {
					ctx.status = 403;
					ctx.body = { error: 'NoPermissions' };
					return;
				}
				selectedWorkspaceId = requested;
			}
			if (workbench && managedWorkspaces && !selectedWorkspaceId) {
				redirect(ctx, tenantManagementPath);
				return;
			}
			if (workbench && selectedWorkspaceId && !await canAccessWorkspace(session.user.id, selectedWorkspaceId)) {
				if (ctx.query.l4sWorkspace === undefined) {
					redirect(ctx, tenantManagementPath);
				} else {
					ctx.status = 403;
					ctx.body = { error: 'NoPermissions' };
				}
				return;
			}
			ctx.state.sessionUserId = session.user.id;
			ctx.state.sessionUsername = session.user.username ?? session.user.name;
			ctx.state.workspaceId = selectedWorkspaceId;
			await next();
		}
	};
}
