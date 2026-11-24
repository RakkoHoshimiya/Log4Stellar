/**
 * The account security contract (docs/account-security.md).
 *
 * This module holds constants and pure helpers only: it never imports
 * better-auth, never opens auth.sqlite, never touches a notes backend and
 * never reads the environment. Writing the contract down has to be
 * deployable without changing a single runtime file, so everything that
 * needs a database, a cookie jar or a request object lives behind these
 * functions instead of inside them.
 *
 * Every function here answers one of three questions:
 *   1. may this request proceed, and as which authentication state?
 *   2. is this proof of a second factor acceptable *once*?
 *   3. what may be shown to the account owner about their own sessions?
 *
 * Protocol failures throw WorkspaceError so the HTTP layer can map a code to
 * a status without knowing the reason. Programming errors (a caller passing
 * an object where a string belongs) throw TypeError/RangeError instead:
 * they must never be reported to a client as if they were a policy decision.
 */
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';

import { WorkspaceError } from './workspace-contract.mjs';

/**
 * The three authentication states of a request.
 *
 * `half` exists only while a two-factor challenge is in flight. It is not a
 * weaker session: there is no session row at all, so it cannot be handed to
 * any code path that starts from a session. `classifyAuthState` is the single
 * place that decides which state a request is in.
 */
export const authStates = Object.freeze({
	full: 'full',
	half: 'half',
	anonymous: 'anonymous',
});

/**
 * Numeric rank so "at least half authenticated" is one comparison instead of
 * a chain of ifs. Higher is stronger; `anonymous` is the floor.
 */
export const authStateRank = Object.freeze({
	[authStates.anonymous]: 0,
	[authStates.half]: 1,
	[authStates.full]: 2,
});

/**
 * Paths that already exist in the gateway plus the paths this contract
 * introduces. Kept in one table so the doc and the tests quote the same
 * strings instead of retyping them.
 */
export const securityPaths = Object.freeze({
	login: '/login',
	challenge: '/login?twofactor=1',
	workbench: '/',
	sessionApi: '/api/session',
	activity: '/api/session/activity',
	logout: '/api/session/logout',
	mount: '/static/mount',
	sessionClient: '/session-client.js',
	buildAssets: '/static/build/',
	authApi: '/api/auth',
	accountSecurity: '/api/account-security',
});

/**
 * The surface a request lands on. The classification exists so that "can this
 * state read notes?" is answered by looking at the path once, instead of by
 * every handler remembering to check the authentication state.
 */
export const authSurfaces = Object.freeze({
	notes: 'notes',
	challenge: 'challenge',
	public: 'public',
	security: 'security',
});

/**
 * Which surface a pathname belongs to. Anything not recognised is `notes`,
 * i.e. denied by default: a new route added to the gateway later inherits the
 * strictest rule instead of accidentally becoming public.
 */
export function surfaceForPath(pathname) {
	if (typeof pathname !== 'string' || pathname.length === 0) return authSurfaces.notes;
	const path = pathname.split('?')[0];
	if (path === securityPaths.login) return authSurfaces.challenge;
	if (path === securityPaths.sessionClient) return authSurfaces.public;
	if (path.startsWith(securityPaths.buildAssets)) return authSurfaces.public;
	if (path === securityPaths.accountSecurity || path.startsWith(`${securityPaths.accountSecurity}/`)) {
		return authSurfaces.security;
	}
	return authSurfaces.notes;
}

/** Root of the account-security endpoints this contract specifies. */
export const accountSecurityMountPath = securityPaths.accountSecurity;

/**
 * Proposed endpoints. The account menu in the workbench calls these; none of
 * them exist yet, which is the point of shipping the contract first.
 */
export const accountSecurityRoutes = Object.freeze({
	verifyTotp: '/api/account-security/two-factor/verify',
	verifyRecoveryCode: '/api/account-security/two-factor/verify-recovery-code',
	enroll: '/api/account-security/two-factor/enroll',
	confirmEnrollment: '/api/account-security/two-factor/confirm',
	disable: '/api/account-security/two-factor/disable',
	regenerateRecoveryCodes: '/api/account-security/recovery-codes',
	changePassword: '/api/account-security/password',
	listSessions: '/api/account-security/sessions',
	labelSession: '/api/account-security/sessions/:sessionId/label',
	revokeSession: '/api/account-security/sessions/:sessionId/revoke',
});

const sessionIdPattern = /^[A-Za-z0-9_-]{22}$/;

/**
 * Route table: method + pattern + the weakest state allowed to call it.
 *
 * `anonymous` here does not mean "no protection": the verify routes are
 * reachable without a session precisely because the challenge *replaces* the
 * session, and they are authenticated by the signed challenge cookie plus the
 * single-use verification row. Keeping them at `anonymous` lets the
 * authorization decision happen before the body is parsed, which is the same
 * ordering rule docs/workspace-access.md §3 demands.
 */
const accountSecurityRouteTable = Object.freeze([
	Object.freeze({ method: 'POST', pattern: new RegExp(`^${accountSecurityRoutes.verifyTotp}$`), requires: authStates.anonymous, action: 'verify-totp' }),
	Object.freeze({ method: 'POST', pattern: new RegExp(`^${accountSecurityRoutes.verifyRecoveryCode}$`), requires: authStates.anonymous, action: 'verify-recovery-code' }),
	Object.freeze({ method: 'POST', pattern: new RegExp(`^${accountSecurityRoutes.enroll}$`), requires: authStates.full, action: 'enroll' }),
	Object.freeze({ method: 'POST', pattern: new RegExp(`^${accountSecurityRoutes.confirmEnrollment}$`), requires: authStates.full, action: 'confirm-enrollment' }),
	Object.freeze({ method: 'POST', pattern: new RegExp(`^${accountSecurityRoutes.disable}$`), requires: authStates.full, action: 'disable' }),
	Object.freeze({ method: 'POST', pattern: new RegExp(`^${accountSecurityRoutes.regenerateRecoveryCodes}$`), requires: authStates.full, action: 'regenerate-recovery-codes' }),
	Object.freeze({ method: 'POST', pattern: new RegExp(`^${accountSecurityRoutes.changePassword}$`), requires: authStates.full, action: 'change-password' }),
	Object.freeze({ method: 'GET', pattern: new RegExp(`^${accountSecurityRoutes.listSessions}$`), requires: authStates.full, action: 'list-sessions' }),
	Object.freeze({ method: 'POST', pattern: /^\/api\/account-security\/sessions\/[A-Za-z0-9_-]{22}\/label$/, requires: authStates.full, action: 'label-session' }),
	Object.freeze({ method: 'POST', pattern: /^\/api\/account-security\/sessions\/[A-Za-z0-9_-]{22}\/revoke$/, requires: authStates.full, action: 'revoke-session' }),
]);

/** Look up a security route by method and pathname, or `undefined`. */
export function securityRouteFor(method, pathname) {
	if (typeof method !== 'string' || typeof pathname !== 'string') return undefined;
	const path = pathname.split('?')[0];
	for (const route of accountSecurityRouteTable) {
		if (route.method !== method.toUpperCase()) continue;
		if (route.pattern.test(path)) return route;
	}
	return undefined;
}

/**
 * Error codes and their statuses. Adding a code means adding a row in both
 * objects -- the test suite asserts that, because a code without a status is
 * a 500 waiting to happen.
 */
export const accountSecurityErrorCodes = Object.freeze({
	invalidTotpInput: 'InvalidTotpInput',
	invalidTotpCode: 'InvalidTotpCode',
	totpCodeReplayed: 'TotpCodeReplayed',
	totpNotEnrolled: 'TotpNotEnrolled',
	totpAlreadyEnrolled: 'TotpAlreadyEnrolled',
	challengeExpired: 'TwoFactorChallengeExpired',
	challengeRequired: 'TwoFactorChallengeRequired',
	twoFactorPending: 'TwoFactorPending',
	invalidRecoveryCodeInput: 'InvalidRecoveryCodeInput',
	invalidRecoveryCode: 'InvalidRecoveryCode',
	recoveryCodesExhausted: 'RecoveryCodesExhausted',
	invalidDeviceLabel: 'InvalidDeviceLabel',
	invalidSessionId: 'InvalidSessionId',
	sessionNotFound: 'SessionNotFound',
	sessionExpired: 'SessionExpired',
	invalidPasswordInput: 'InvalidPasswordInput',
	passwordTooShort: 'PasswordTooShort',
	passwordTooLong: 'PasswordTooLong',
	passwordMatchesUsername: 'PasswordMatchesUsername',
	passwordUnchanged: 'PasswordUnchanged',
	reauthenticationRequired: 'ReauthenticationRequired',
});

export const accountSecurityErrorStatus = Object.freeze({
	InvalidTotpInput: 400,
	InvalidTotpCode: 401,
	TotpCodeReplayed: 401,
	TotpNotEnrolled: 409,
	TotpAlreadyEnrolled: 409,
	TwoFactorChallengeExpired: 401,
	TwoFactorChallengeRequired: 401,
	TwoFactorPending: 403,
	InvalidRecoveryCodeInput: 400,
	InvalidRecoveryCode: 401,
	RecoveryCodesExhausted: 409,
	InvalidDeviceLabel: 400,
	InvalidSessionId: 400,
	SessionNotFound: 404,
	SessionExpired: 401,
	InvalidPasswordInput: 400,
	PasswordTooShort: 400,
	PasswordTooLong: 400,
	PasswordMatchesUsername: 400,
	PasswordUnchanged: 400,
	ReauthenticationRequired: 403,
});

/**
 * TOTP parameters, fixed by RFC 6238 and by what authenticator apps actually
 * implement. They are constants rather than options on purpose: a per-user
 * period or digit count would multiply the QR-code compatibility matrix for
 * no security gain, and the verifier's window arithmetic assumes one period.
 *
 * algorithm SHA-1 is not a choice here -- `@better-auth/utils/otp` signs with
 * `createHMAC("SHA-1")` and its QR helper never emits an `algorithm`
 * parameter, so every enrolled app will compute SHA-1 regardless of what this
 * table says. Writing SHA-256 down would produce QR codes that disagree with
 * the server. RFC 6238 keeps SHA-1 for exactly this reason (§1.2, §5.1) and
 * SHA-1's weaknesses do not apply to HMAC as a PRF.
 */
export const totpParameters = Object.freeze({
	algorithm: 'SHA-1',
	digits: 6,
	periodSeconds: 30,
	issuer: 'Log4Stellar',
	minimumSecretBits: 160,
	generatedSecretLength: 32,
	windowBackwardSteps: 1,
	windowForwardSteps: 1,
});

/** Hard bound on the raw input string, checked before any parsing. */
export const totpInputLimits = Object.freeze({ minLength: 6, maxLength: 6 });

const totpInputPattern = new RegExp(`^[0-9]{${totpParameters.digits}}$`);

/**
 * Canonicalise a TOTP code: trim surrounding whitespace, then require exactly
 * `digits` ASCII digits.
 *
 * Deliberately *no* internal separator stripping ("123 456", "123-456").
 * A code is typed or pasted into a six-cell input; allowing separators makes
 * "12 3456" and "1234 56" both normalise to the same value, which turns an
 * unambiguous secret into a guessable one for anyone who only sees part of it
 * (shoulder surfing, a screenshot, a partial log line). Rejecting ambiguous
 * input costs one retry and removes that entire class of leak.
 */
export function normalizeTotpCode(value) {
	if (typeof value !== 'string') throw new WorkspaceError(400, accountSecurityErrorCodes.invalidTotpInput);
	const trimmed = value.trim();
	if (trimmed.length < totpInputLimits.minLength || trimmed.length > totpInputLimits.maxLength) {
		throw new WorkspaceError(400, accountSecurityErrorCodes.invalidTotpInput);
	}
	if (!totpInputPattern.test(trimmed)) throw new WorkspaceError(400, accountSecurityErrorCodes.invalidTotpInput);
	return trimmed;
}

/** `true` when the value is a well-formed TOTP code (no throw). */
export function isTotpCode(value) {
	try {
		normalizeTotpCode(value);
		return true;
	} catch {
		return false;
	}
}

/** Normalise or throw; the shape every verifier should call. */
export function requireTotpCode(value) {
	return normalizeTotpCode(value);
}

/** The RFC 6238 time step (`T` in §4.2) for a wall-clock instant. */
export function totpStepFor(timestampMs, { periodSeconds = totpParameters.periodSeconds } = {}) {
	if (!Number.isFinite(timestampMs) || timestampMs < 0) throw new RangeError('timestampMs must be a non-negative finite number');
	if (!Number.isSafeInteger(periodSeconds) || periodSeconds < 1) throw new RangeError('periodSeconds must be a positive integer');
	return Math.floor(timestampMs / 1000 / periodSeconds);
}

/**
 * The steps a code may legitimately belong to at `step`.
 *
 * The window exists because phone clocks drift and because a code entered at
 * the very end of a step is already stale by the time it reaches the server.
 * ±1 step is the smallest window that covers both; RFC 6238 §5.2 allows
 * "one time step" of drift for time-synchronised servers and warns that a
 * larger window widens replay. Widening it is a security decision, so the
 * numbers live here, not in an env var.
 */
export function totpStepWindow(step, { backward = totpParameters.windowBackwardSteps, forward = totpParameters.windowForwardSteps } = {}) {
	if (!Number.isSafeInteger(step) || step < 0) throw new RangeError('step must be a non-negative integer');
	if (!Number.isSafeInteger(backward) || backward < 0) throw new RangeError('backward must be a non-negative integer');
	if (!Number.isSafeInteger(forward) || forward < 0) throw new RangeError('forward must be a non-negative integer');
	const steps = [];
	for (let offset = -backward; offset <= forward; offset += 1) {
		if (step + offset >= 0) steps.push(step + offset);
	}
	return Object.freeze(steps);
}

/**
 * Decide whether a code computed for `step` may be accepted *now*, given the
 * highest step already spent for this account.
 *
 * This is the replay guard, and it is the single most important rule in this
 * file. Counters are compared with `>`, never `>=`: a code accepted for step
 * S marks S as spent, so the same code (and any other code for S) is refused
 * for the rest of that step. Without it a ±1 window means an observed code
 * stays valid for up to 90 seconds and can be replayed any number of times --
 * the second factor would still be true while the account is being taken over.
 *
 * The comparison is against a persisted `lastUsedStep`; callers must apply it
 * with a compare-and-set (`UPDATE ... WHERE last_used_step < :step`) so two
 * concurrent verifications cannot both win.
 */
export function admitTotpStep({ lastUsedStep, step, nowMs = Date.now(), backward, forward } = {}) {
	if (!Number.isSafeInteger(step) || step < 0) throw new RangeError('step must be a non-negative integer');
	if (lastUsedStep !== undefined && lastUsedStep !== null && (!Number.isSafeInteger(lastUsedStep) || lastUsedStep < 0)) {
		throw new RangeError('lastUsedStep must be a non-negative integer when present');
	}
	const currentStep = totpStepFor(nowMs);
	const window = totpStepWindow(currentStep, { backward, forward });
	if (!window.includes(step)) throw new WorkspaceError(accountSecurityErrorStatus.InvalidTotpCode, accountSecurityErrorCodes.invalidTotpCode);
	const spent = Number.isSafeInteger(lastUsedStep) ? lastUsedStep : -1;
	if (step <= spent) throw new WorkspaceError(accountSecurityErrorStatus.TotpCodeReplayed, accountSecurityErrorCodes.totpCodeReplayed);
	return Object.freeze({ accepted: true, lastUsedStep: step, currentStep, window });
}

/**
 * Recovery code parameters.
 *
 * Crockford-style alphabet: no `I`, `L`, `O`, `U`, and no `0`/`1` either.
 * Thirty symbols is ~4.9 bits each, so ten symbols is ~49 bits -- far more
 * than the ~40 bits a lockout-protected single-use code needs -- and it
 * survives being read off a printed backup or read aloud over a phone far
 * better than mixed case (`l` vs `1`, `O` vs `0`). better-auth's default
 * generator uses `a-zA-Z0-9`, which cannot be canonicalised this way without
 * changing what is stored; the contract therefore injects this generator
 * through `backupCodeOptions.customBackupCodesGenerate` (documented in
 * docs/account-security.md §4.4 as a required config change).
 */
export const recoveryCodeParameters = Object.freeze({
	count: 10,
	length: 10,
	groupSize: 5,
	alphabet: 'ABCDEFGHJKMNPQRSTVWXYZ23456789',
	maxInputLength: 32,
});

const recoveryCodeAlphabet = recoveryCodeParameters.alphabet;
const recoveryCodeCharacterPattern = /^[ABCDEFGHJKMNPQRSTVWXYZ23456789]+$/;
const recoveryCodePermittedInputPattern = /^[A-Za-z0-9\s-]+$/;

/** Group a bare symbol string into the printable `XXXXX-XXXXX` form. */
export function formatRecoveryCode(symbols) {
	if (typeof symbols !== 'string') throw new TypeError('symbols must be a string');
	const group = recoveryCodeParameters.groupSize;
	const groups = [];
	for (let offset = 0; offset < symbols.length; offset += group) groups.push(symbols.slice(offset, offset + group));
	return groups.join('-');
}

/**
 * Canonicalise a recovery code: strip ASCII whitespace and hyphens, uppercase,
 * and require exactly the configured number of symbols from the alphabet.
 *
 * The pre-check on the permitted character set matters: `toUpperCase()` is not
 * a bijection on arbitrary Unicode (`ı` maps to `I`, which is then rejected by
 * the alphabet check, but `ſ` maps to `S`, which is *in* the alphabet). Two
 * different inputs collapsing onto one code is exactly the ambiguity the
 * contract forbids, so anything outside `[A-Za-z0-9\s-]` is refused before
 * folding.
 */
export function normalizeRecoveryCode(value) {
	if (typeof value !== 'string') throw new WorkspaceError(400, accountSecurityErrorCodes.invalidRecoveryCodeInput);
	if (value.length === 0 || value.length > recoveryCodeParameters.maxInputLength) {
		throw new WorkspaceError(400, accountSecurityErrorCodes.invalidRecoveryCodeInput);
	}
	if (!recoveryCodePermittedInputPattern.test(value)) {
		throw new WorkspaceError(400, accountSecurityErrorCodes.invalidRecoveryCodeInput);
	}
	const compact = value.replace(/[\s-]+/g, '').toUpperCase();
	if (compact.length !== recoveryCodeParameters.length) {
		throw new WorkspaceError(400, accountSecurityErrorCodes.invalidRecoveryCodeInput);
	}
	if (!recoveryCodeCharacterPattern.test(compact)) {
		throw new WorkspaceError(400, accountSecurityErrorCodes.invalidRecoveryCodeInput);
	}
	return formatRecoveryCode(compact);
}

/** `true` when the value is a well-formed recovery code (no throw). */
export function isRecoveryCode(value) {
	try {
		normalizeRecoveryCode(value);
		return true;
	} catch {
		return false;
	}
}

/** Normalise or throw. */
export function requireRecoveryCode(value) {
	return normalizeRecoveryCode(value);
}

/**
 * Generate a fresh code set. `randomInt` is the CSPRNG-backed helper from
 * node:crypto, so no new dependency is introduced and no `Math.random` sneaks
 * in. Duplicates are regenerated rather than deduplicated afterwards, so the
 * returned count is always exactly the requested one.
 */
export function generateRecoveryCodes({ count = recoveryCodeParameters.count } = {}) {
	if (!Number.isSafeInteger(count) || count < 1 || count > 32) throw new RangeError('count must be an integer between 1 and 32');
	const seen = new Set();
	const codes = [];
	while (codes.length < count) {
		let symbols = '';
		for (let index = 0; index < recoveryCodeParameters.length; index += 1) {
			symbols += recoveryCodeAlphabet[randomInt(recoveryCodeAlphabet.length)];
		}
		const code = formatRecoveryCode(symbols);
		if (seen.has(code)) continue;
		seen.add(code);
		codes.push(code);
	}
	return Object.freeze(codes);
}

function recoveryCodeDigestBuffer(code) {
	return createHash('sha256').update(code, 'utf8').digest();
}

/**
 * Hex SHA-256 of the canonical code. Storing digests would be one option; the
 * contract keeps better-auth's encrypted-at-rest codes as the source of truth
 * and uses this digest for the constant-time comparison only, so a stolen
 * database copy never yields plaintext codes.
 */
export function recoveryCodeDigest(value) {
	return recoveryCodeDigestBuffer(normalizeRecoveryCode(value)).toString('hex');
}

/**
 * Compare the candidate against every stored code with a constant-time
 * equality and return what is left.
 *
 * Iterating all codes and OR-ing the results is intentional: `Array#includes`
 * (what better-auth's own backup-code verifier uses) short-circuits, so the
 * response time reveals the position of the matching code in the list. That
 * is useless without the codes, but it is free to remove, and the recovery
 * path is the one place where an attacker holds a candidate and gets to retry.
 */
export function matchRecoveryCode(input, stored) {
	const candidate = recoveryCodeDigestBuffer(requireRecoveryCode(input));
	const codes = Array.isArray(stored) ? stored : [];
	const digests = codes.map(code => recoveryCodeDigestBuffer(String(code)));
	let matchedIndex = -1;
	for (let index = 0; index < digests.length; index += 1) {
		const equal = timingSafeEqual(digests[index], candidate);
		if (equal && matchedIndex === -1) matchedIndex = index;
	}
	const remaining = matchedIndex === -1 ? codes.slice() : codes.filter((_, index) => index !== matchedIndex);
	return Object.freeze({ matched: matchedIndex !== -1, remaining: Object.freeze(remaining) });
}

/**
 * Spend a recovery code. Reaching zero remaining codes is reported as a
 * distinct conflict so the UI can force a regeneration instead of silently
 * leaving the account with one factor.
 */
export function consumeRecoveryCode(input, stored) {
	const codes = Array.isArray(stored) ? stored : [];
	if (codes.length === 0) throw new WorkspaceError(409, accountSecurityErrorCodes.recoveryCodesExhausted);
	const result = matchRecoveryCode(input, codes);
	if (!result.matched) throw new WorkspaceError(401, accountSecurityErrorCodes.invalidRecoveryCode);
	return result;
}

/**
 * Regenerating a set replaces all previous codes: the stored ciphertext is
 * overwritten wholesale, so nothing from the old set can be redeemed
 * afterwards. Half-rotation (old codes still valid for a while) is rejected
 * because it doubles the number of live secrets exactly when the user has
 * decided the old ones were compromised.
 */
export const recoveryCodeRotation = Object.freeze({
	invalidatesPrevious: true,
	requiresPassword: true,
	requiresSecondFactor: true,
	showsCodesOnce: true,
	count: recoveryCodeParameters.count,
});

/** User-chosen device labels: short, single line, no control characters. */
export const deviceLabelLimits = Object.freeze({ minLength: 1, maxLength: 40 });

/**
 * Normalise a user-supplied device label. Control characters are removed
 * rather than escaped: the label is rendered into the account menu as text,
 * and a stray newline or RTL override in a session list is a phishing surface
 * (the sibling session appears to be something it is not).
 */
export function normalizeDeviceLabel(value) {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== 'string') throw new WorkspaceError(400, accountSecurityErrorCodes.invalidDeviceLabel);
	// eslint-disable-next-line no-control-regex
	const cleaned = value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim();
	if (cleaned.length < deviceLabelLimits.minLength) throw new WorkspaceError(400, accountSecurityErrorCodes.invalidDeviceLabel);
	if (cleaned.length > deviceLabelLimits.maxLength) throw new WorkspaceError(400, accountSecurityErrorCodes.invalidDeviceLabel);
	return cleaned;
}

function maskIpv4(octets) {
	if (octets.some(octet => !/^\d{1,3}$/.test(octet) || Number(octet) > 255)) return null;
	return `${octets[0]}.${octets[1]}.${octets[2]}.0/24`;
}

function maskIpv6(address) {
	if (!/^[0-9a-f:]+$/i.test(address) || (address.match(/::/g) ?? []).length > 1) return null;
	const [head, tail] = address.includes('::') ? address.split('::') : [address, ''];
	const headGroups = head.length > 0 ? head.split(':') : [];
	const tailGroups = tail.length > 0 ? tail.split(':') : [];
	if (![...headGroups, ...tailGroups].every(group => /^[0-9a-f]{1,4}$/i.test(group))) return null;
	const explicit = headGroups.length + tailGroups.length;
	// `::` stands for one or more zero groups; a full address has eight.
	if (explicit > 8 || (address.includes('::') && explicit === 8)) return null;
	const groups = [...headGroups, ...Array.from({ length: 8 - explicit }, () => '0'), ...tailGroups];
	return `${groups.slice(0, 3).join(':')}::/48`;
}

/**
 * Reduce an address to a network label before it is shown to the user.
 *
 * The session list only needs to answer "is this me or somewhere else?". The
 * full address is not necessary for that and is exactly the field that turns
 * a screenshot of the account page into a location disclosure, so only the
 * network is exposed (and only when the caller opts in).
 */
export function maskAddress(address) {
	if (typeof address !== 'string' || address.length === 0) return null;
	const trimmed = address.trim();
	const withoutPort = trimmed.startsWith('::ffff:') ? trimmed.slice(7) : trimmed;
	const octets = withoutPort.split('.');
	if (octets.length === 4) return maskIpv4(octets);
	if (withoutPort.includes(':')) return maskIpv6(withoutPort);
	return null;
}

/**
 * Opaque, stable, one-way identifier for a session row.
 *
 * better-auth's own `/list-sessions` returns the raw `token`, which *is* the
 * bearer credential: anyone who can read the session list could impersonate
 * every listed device. The public identifier is therefore a truncated
 * SHA-256 of the token; the mapping back to the token never leaves the
 * server. 22 base64url characters is 132 bits, far beyond collision range.
 */
export function sessionIdFor(token) {
	if (typeof token !== 'string' || token.length === 0 || token.length > 512) {
		throw new WorkspaceError(400, accountSecurityErrorCodes.invalidSessionId);
	}
	return createHash('sha256').update(token, 'utf8').digest('base64url').slice(0, 22);
}

/** `true` when the value is shaped like a session identifier. */
export function isSessionId(value) {
	return typeof value === 'string' && sessionIdPattern.test(value);
}

/** Validate a session identifier from a URL, or throw. */
export function requireSessionId(value) {
	if (!isSessionId(value)) throw new WorkspaceError(400, accountSecurityErrorCodes.invalidSessionId);
	return value;
}

const browserMatchers = Object.freeze([
	Object.freeze({ pattern: /Edg\/(\d+)(?:\.\d+)*/, name: 'Edge' }),
	Object.freeze({ pattern: /OPR\/(\d+)/, name: 'Opera' }),
	Object.freeze({ pattern: /Firefox\/(\d+)/, name: 'Firefox' }),
	Object.freeze({ pattern: /Chrome\/(\d+)/, name: 'Chrome' }),
	Object.freeze({ pattern: /Version\/(\d+)(?:\.\d+)* Safari/, name: 'Safari' }),
	Object.freeze({ pattern: /curl\/(\d+)/, name: 'curl' }),
]);

const platformMatchers = Object.freeze([
	Object.freeze({ pattern: /CrOS/, name: 'ChromeOS' }),
	Object.freeze({ pattern: /iPhone|iPad|iPod/, name: 'iOS' }),
	Object.freeze({ pattern: /Android/, name: 'Android' }),
	Object.freeze({ pattern: /Windows NT/, name: 'Windows' }),
	Object.freeze({ pattern: /Mac OS X/, name: 'macOS' }),
	Object.freeze({ pattern: /Linux/, name: 'Linux' }),
]);

/** Fallback label when nothing can be recognised. */
export const unknownDeviceLabel = '未知设备';

/**
 * Derive a short human label from a User-Agent string.
 *
 * The raw User-Agent is never shown: it is attacker-controlled text (any
 * client can send anything) and rendering it into the account page is a
 * cross-site-scripting and phishing surface. Only a name from the fixed
 * tables above plus a major version survives, everything else becomes
 * `unknownDeviceLabel`.
 */
export function describeUserAgent(userAgent) {
	const source = typeof userAgent === 'string' ? userAgent.slice(0, 512) : '';
	let browser;
	let browserVersion;
	for (const matcher of browserMatchers) {
		const match = matcher.pattern.exec(source);
		if (!match) continue;
		browser = matcher.name;
		browserVersion = match[1];
		break;
	}
	let platform;
	for (const matcher of platformMatchers) {
		if (matcher.pattern.test(source)) {
			platform = matcher.name;
			break;
		}
	}
	if (!browser && !platform) return Object.freeze({ browser: undefined, browserVersion: undefined, platform: undefined, label: unknownDeviceLabel });
	const label = [platform, browser].filter(Boolean).join(' · ');
	return Object.freeze({ browser, browserVersion, platform, label: label.length > 0 ? label : unknownDeviceLabel });
}

/**
 * Fields a session descriptor must never contain. Exported so the test suite
 * can assert the descriptor is built from an allowlist rather than by
 * deleting known-bad keys from a copy of the row.
 */
export const sessionDescriptorWithheldFields = Object.freeze([
	'token',
	'ipAddress',
	'userAgent',
	'userId',
	'impersonatedBy',
	'secret',
	'backupCodes',
	'password',
]);

function toMillis(value) {
	if (value instanceof Date) return value.getTime();
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value === 'string') {
		const parsed = Date.parse(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

/**
 * Build the public descriptor for one session row.
 *
 * Built by assignment from an allowlist -- the row is never spread -- because
 * spreading a database row is how `token` ends up in a JSON response after a
 * schema change adds a column nobody remembered. Options:
 *   - `currentToken`: the caller's own token, used to flag "this device"
 *   - `labels`: sessionId -> user-chosen label
 *   - `includeNetwork`: opt in to the masked network label
 *   - `nowMs`: clock injection for tests
 */
export function describeSession(session, { currentToken, labels, includeNetwork = false, nowMs = Date.now() } = {}) {
	if (!session || typeof session !== 'object') throw new TypeError('session must be an object');
	const token = typeof session.token === 'string' ? session.token : '';
	const id = sessionIdFor(token);
	const agent = describeUserAgent(session.userAgent);
	let userLabel;
	try {
		userLabel = normalizeDeviceLabel(labels?.[id]);
	} catch {
		userLabel = undefined;
	}
	const createdAtMs = toMillis(session.createdAt) ?? 0;
	const lastActiveMs = toMillis(session.updatedAt) ?? createdAtMs;
	const expiresAtMs = toMillis(session.expiresAt) ?? 0;
	const descriptor = {
		id,
		device: userLabel ?? agent.label,
		browser: agent.browser,
		platform: agent.platform,
		current: typeof currentToken === 'string' && currentToken.length > 0 ? token === currentToken : false,
		createdAtMs,
		lastActiveMs,
		expiresAtMs,
		expiresInMs: Math.max(0, expiresAtMs - nowMs),
	};
	if (includeNetwork) descriptor.network = maskAddress(session.ipAddress);
	return Object.freeze(descriptor);
}

/**
 * Describe a list of sessions, current device first and then by most recent
 * activity. Sorting is stable in the sense that two sessions with the same
 * timestamp keep their input order, so the list does not reshuffle between
 * polls.
 */
export function describeSessions(sessions, options = {}) {
	if (!Array.isArray(sessions)) throw new TypeError('sessions must be an array');
	const described = sessions.map(session => describeSession(session, options));
	described.sort((left, right) => {
		if (left.current !== right.current) return left.current ? -1 : 1;
		return right.lastActiveMs - left.lastActiveMs;
	});
	return Object.freeze(described);
}

/**
 * Password rules for the change-password flow.
 *
 * `revokeOtherSessions: true` is the default because a password change is the
 * canonical "I think someone else has my password" action: leaving the other
 * sessions alive defeats it. The current session survives (better-auth
 * recreates it), so the user is not logged out of the device they are
 * standing at.
 *
 * Note the asymmetry with `revokeSessionsOnPasswordReset` in auth.mjs: the
 * reset path has no current session to preserve, the change path does. Same
 * intent, different mechanics -- see docs/account-security.md §5.6.
 */
export const passwordPolicy = Object.freeze({
	minLength: 8,
	maxLength: 128,
	requireCurrentPassword: true,
	revokeOtherSessions: true,
	allowSameAsCurrent: false,
});

/**
 * Validate a new password without normalising it. Passwords are compared
 * byte-for-byte by argon2, so trimming or case-folding here would silently
 * change what the user must type at the next login.
 */
export function validateNewPassword(value, { username } = {}) {
	if (typeof value !== 'string') throw new WorkspaceError(400, accountSecurityErrorCodes.invalidPasswordInput);
	// eslint-disable-next-line no-control-regex
	if (/[\u0000-\u001f\u007f]/.test(value)) throw new WorkspaceError(400, accountSecurityErrorCodes.invalidPasswordInput);
	if (value.length < passwordPolicy.minLength) throw new WorkspaceError(400, accountSecurityErrorCodes.passwordTooShort);
	if (value.length > passwordPolicy.maxLength) throw new WorkspaceError(400, accountSecurityErrorCodes.passwordTooLong);
	if (value.trim().length === 0) throw new WorkspaceError(400, accountSecurityErrorCodes.invalidPasswordInput);
	if (typeof username === 'string' && username.length > 0 && value.toLowerCase() === username.toLowerCase()) {
		throw new WorkspaceError(400, accountSecurityErrorCodes.passwordMatchesUsername);
	}
	return value;
}

/**
 * Work out which sessions a password change ends.
 *
 * Revocation is decided before the password is written, so a failure can be
 * retried without having already logged the user's other devices out half-way.
 */
export function planPasswordChangeSessions({ sessions, currentSessionId, revokeOtherSessions = passwordPolicy.revokeOtherSessions } = {}) {
	if (!Array.isArray(sessions)) throw new TypeError('sessions must be an array');
	const ids = sessions.map((session) => {
		if (typeof session === 'string') return requireSessionId(session);
		if (!session || typeof session !== 'object') throw new TypeError('session entries must be objects or identifiers');
		return session.id ?? sessionIdFor(session.token);
	});
	const revokeIds = [];
	const keepIds = [];
	for (const id of ids) {
		if (revokeOtherSessions && id !== currentSessionId) revokeIds.push(id);
		else keepIds.push(id);
	}
	return Object.freeze({ revokeIds: Object.freeze(revokeIds), keepIds: Object.freeze(keepIds) });
}

/**
 * Two-factor challenge policy.
 *
 * `cookieMaxAgeSeconds: 600` mirrors better-auth's `twoFactorCookieMaxAge`
 * default (it is the lifetime of the signed `two_factor` cookie *and* of the
 * verification row that authorises the challenge). Ten minutes is short
 * enough that a stolen half-authenticated cookie is barely useful and long
 * enough to find a phone.
 *
 * `maxAttempts: 5` matches better-auth's `beginAttempt(5)` per challenge, and
 * `rateLimit` matches the plugin's 3-per-10-seconds. `trustDevice` is off:
 * a 30-day "remember this device" cookie converts two factors into one for a
 * month, which contradicts requirement 3 of the task.
 */
export const challengePolicy = Object.freeze({
	cookieMaxAgeSeconds: 600,
	maxHalfAuthLifetimeSeconds: 600,
	maxAttempts: 5,
	rateLimitWindowSeconds: 10,
	rateLimitMax: 3,
	accountLockMaxFailedAttempts: 10,
	accountLockDurationSeconds: 900,
	trustDeviceEnabled: false,
});

/** Where a half-authenticated browser is sent. */
export const twoFactorPendingRedirect = securityPaths.challenge;

/**
 * Decide the authentication state of a request.
 *
 * The inputs are already-verified values: `session` is what better-auth's
 * `get-session` returned (or `null`), and `challenge` is the *validated*
 * challenge descriptor the server derived from the signed `two_factor`
 * cookie plus its `verification` row. This function never looks at a cookie
 * header itself -- signature checking needs the auth secret and must not
 * live in a pure helper.
 *
 * A session is only `full` while it has not expired; an expired row is
 * treated exactly like a missing one so a clock skew cannot briefly grant
 * access.
 */
export function classifyAuthState({ session, challenge, nowMs = Date.now() } = {}) {
	if (!Number.isFinite(nowMs) || nowMs < 0) throw new RangeError('nowMs must be a non-negative finite number');
	const rawSession = session?.session ?? undefined;
	const sessionExpiresAtMs = toMillis(rawSession?.expiresAt);
	const sessionLive = Boolean(rawSession && session?.user) && (sessionExpiresAtMs ?? 0) > nowMs;
	const authenticated = sessionLive;
	const challengeIdentifier = typeof challenge?.identifier === 'string' && challenge.identifier.length > 0 ? challenge.identifier : undefined;
	const challengeExpiresAtMs = toMillis(challenge?.expiresAtMs ?? challenge?.expiresAt);
	const challengeLive = !authenticated && Boolean(challengeIdentifier) && (challengeExpiresAtMs ?? 0) > nowMs;
	const attemptsUsed = Number.isSafeInteger(challenge?.attemptsUsed) && challenge.attemptsUsed >= 0 ? challenge.attemptsUsed : 0;
	const state = authenticated ? authStates.full : challengeLive ? authStates.half : authStates.anonymous;
	return Object.freeze({
		state,
		authenticated,
		challengeLive,
		challengeExpiresAtMs,
		attemptsRemaining: Math.max(0, challengePolicy.maxAttempts - attemptsUsed),
		redirectTo: state === authStates.full ? undefined : state === authStates.half ? twoFactorPendingRedirect : securityPaths.login,
	});
}

function decision(allow, status, action, extra = {}) {
	return Object.freeze({ allow, status, action, ...extra });
}

/**
 * The single authorization gate.
 *
 * Ordering rule (mirrors docs/workspace-access.md §3): the state and the route
 * are checked *before* the body is parsed, so a half-authenticated caller
 * asking for a password change gets 403 `TwoFactorPending`, never a
 * 400 `InvalidPasswordInput` that would tell them their payload reached the
 * validator.
 *
 * `half` is denied on every notes-bearing surface. That is the mechanism
 * behind requirement 3: there is no session row during the challenge, so
 * `/api/session`, `/static/mount/*` and the workbench HTML have nothing to
 * authorise against, and this function refuses them explicitly instead of
 * relying on each handler to remember.
 */
export function authorizeRequest({ state, method = 'GET', pathname = securityPaths.workbench } = {}) {
	const value = typeof state === 'string' ? state : state?.state;
	const current = typeof value === 'string' && Object.hasOwn(authStateRank, value) ? value : authStates.anonymous;
	const route = securityRouteFor(method, pathname);
	if (route) {
		if (route.requires === authStates.anonymous) return decision(true, 200, route.action);
		if (authStateRank[current] >= authStateRank[route.requires]) return decision(true, 200, route.action);
		if (current === authStates.half) {
			return decision(false, accountSecurityErrorStatus.TwoFactorPending, 'challenge', { error: accountSecurityErrorCodes.twoFactorPending });
		}
		return decision(false, 401, 'login', { error: accountSecurityErrorCodes.challengeRequired });
	}
	if (pathname.split('?')[0] === securityPaths.logout && current !== authStates.anonymous) {
		return decision(true, 200, 'logout');
	}
	const surface = surfaceForPath(pathname);
	if (surface === authSurfaces.public) return decision(true, 200, 'serve');
	if (surface === authSurfaces.challenge) return decision(true, 200, current === authStates.half ? 'challenge' : 'login');
	if (current === authStates.full) return decision(true, 200, 'serve');
	if (current === authStates.half) {
		const isWorkbenchDocument = method === 'GET' && pathname.split('?')[0] === securityPaths.workbench;
		if (isWorkbenchDocument) return decision(false, 303, 'redirect-challenge', { location: twoFactorPendingRedirect });
		return decision(false, accountSecurityErrorStatus.TwoFactorPending, 'challenge', { error: accountSecurityErrorCodes.twoFactorPending });
	}
	return decision(false, 401, 'login', { error: accountSecurityErrorCodes.challengeRequired });
}

/** Convenience for handlers that only need the redirect target. */
export function redirectForAuthState(state) {
	const value = typeof state === 'string' ? state : state?.state;
	if (value === authStates.full) return undefined;
	return value === authStates.half ? twoFactorPendingRedirect : securityPaths.login;
}

/**
 * Idle-expiry policy.
 *
 * The 24-hour default and the sliding refresh (`updateAge: 0` plus
 * `deferSessionRefresh`, refreshed by `POST /api/session/activity`) already
 * exist in auth.mjs and must keep working unchanged. This table only pins the
 * numbers the contract reasons about, and the invariant below makes the
 * "half-auth lifetime is far shorter than the idle lifetime" requirement
 * machine-checkable instead of a sentence in a document.
 */
export const idlePolicy = Object.freeze({
	defaultIdleSeconds: 86_400,
	minimumIdleSeconds: 300,
	maximumIdleSeconds: 2_592_000,
	updateAgeSeconds: 0,
});

/** Clamp an idle value from configuration into the accepted range. */
export function clampIdleSeconds(value) {
	const numeric = Number(value);
	if (!Number.isSafeInteger(numeric)) return idlePolicy.defaultIdleSeconds;
	if (numeric < idlePolicy.minimumIdleSeconds || numeric > idlePolicy.maximumIdleSeconds) return idlePolicy.defaultIdleSeconds;
	return numeric;
}

/**
 * Expiry of the session created *after* the second factor succeeds.
 *
 * The clock starts when the second factor completes, not when the password
 * was accepted: otherwise the challenge would eat into the user's 24 hours
 * and a slow authenticator lookup would shorten the session arbitrarily.
 */
export function sessionExpiryAfterSecondFactor({ completedAtMs, idleSeconds = idlePolicy.defaultIdleSeconds } = {}) {
	if (!Number.isFinite(completedAtMs) || completedAtMs < 0) throw new RangeError('completedAtMs must be a non-negative finite number');
	const idle = clampIdleSeconds(idleSeconds);
	return Object.freeze({ expiresAtMs: completedAtMs + idle * 1000, idleSeconds: idle });
}

/** Milliseconds left before the idle deadline (never negative). */
export function remainingIdleMs(session, nowMs = Date.now()) {
	const raw = session?.session ?? session;
	const expiresAtMs = toMillis(raw?.expiresAt);
	if (expiresAtMs === undefined) return 0;
	return Math.max(0, expiresAtMs - nowMs);
}

/** `true` when the session row is at or past its idle deadline. */
export function isIdleExpired(session, nowMs = Date.now()) {
	return remainingIdleMs(session, nowMs) === 0;
}

/** Throw instead of returning a boolean, for handlers that must not continue. */
export function requireIdleSession(session, nowMs = Date.now()) {
	if (isIdleExpired(session, nowMs)) throw new WorkspaceError(401, accountSecurityErrorCodes.sessionExpired);
	return session;
}

/**
 * Facts read from better-auth 1.7.27 (`dist/plugins/two-factor/*` and
 * `dist/api/routes/session.mjs`) rather than assumed. Two of them are the
 * reason this contract has to add code of its own:
 *
 *   - `replayProtection: false` -- the plugin verifies a code against a ±1
 *     step window and never records which step was spent, so the same code
 *     verifies repeatedly for up to 90 seconds.
 *   - `constantTimeBackupCodeCompare: false` -- backup codes are matched with
 *     `Array#includes`, which short-circuits.
 *
 * `listSessionsReturnsToken: true` is why the session list is not proxied:
 * `/api/auth/list-sessions` returns the raw bearer token for every session.
 */
export const betterAuthTwoFactorFacts = Object.freeze({
	version: '1.7.27',
	pluginId: 'two-factor',
	cookiePrefix: 'better-auth',
	twoFactorCookieName: 'two_factor',
	trustDeviceCookieName: 'trust_device',
	twoFactorCookieMaxAgeSeconds: 600,
	trustDeviceCookieMaxAgeSeconds: 2_592_000,
	totpPeriodSeconds: 30,
	totpDigits: 6,
	totpWindowSteps: 1,
	totpAlgorithm: 'SHA-1',
	backupCodeCount: 10,
	backupCodeLength: 10,
	backupCodeAlphabet: 'a-zA-Z0-9',
	challengeMaxAttempts: 5,
	rateLimitWindowSeconds: 10,
	rateLimitMax: 3,
	accountLockMaxFailedAttempts: 10,
	accountLockDurationSeconds: 900,
	replayProtection: false,
	constantTimeBackupCodeCompare: false,
	listSessionsReturnsToken: true,
	deletesSessionCookieDuringChallenge: true,
});

/**
 * Cookie names the implementation must look for. better-auth builds them as
 * `${securePrefix}${cookiePrefix}.${name}` with `__Secure-` because auth.mjs
 * sets `advanced.useSecureCookies: true`; writing the composed name here keeps
 * the gateway from re-deriving the prefix wrongly.
 */
export function challengeCookieName({ cookiePrefix = betterAuthTwoFactorFacts.cookiePrefix, secure = true } = {}) {
	if (typeof cookiePrefix !== 'string' || cookiePrefix.length === 0) throw new TypeError('cookiePrefix must be a non-empty string');
	return `${secure ? '__Secure-' : ''}${cookiePrefix}.${betterAuthTwoFactorFacts.twoFactorCookieName}`;
}

/** Cookie name better-auth would use for the 30-day trusted-device bypass. */
export function trustDeviceCookieName({ cookiePrefix = betterAuthTwoFactorFacts.cookiePrefix, secure = true } = {}) {
	if (typeof cookiePrefix !== 'string' || cookiePrefix.length === 0) throw new TypeError('cookiePrefix must be a non-empty string');
	return `${secure ? '__Secure-' : ''}${cookiePrefix}.${betterAuthTwoFactorFacts.trustDeviceCookieName}`;
}

/**
 * Schema this contract adds, exactly as the migration batch will run it.
 *
 * The two-factor *plugin's* tables and columns are created by better-auth's
 * own migrator (`getMigrations(auth.options).runMigrations()` already runs on
 * every boot); they are listed for review but are not executed here. What we
 * add ourselves is one table for the replay guard and nothing else -- the
 * hard constraint is additive only, so no column of an existing table is
 * declared by this module.
 */
export const accountSecuritySchema = Object.freeze({
	pluginTables: Object.freeze(['twoFactor']),
	pluginColumns: Object.freeze([
		Object.freeze({ table: 'user', column: 'twoFactorEnabled', type: 'INTEGER', via: 'better-auth-migration' }),
	]),
	ownTables: Object.freeze([
		'CREATE TABLE IF NOT EXISTS account_totp_replay (user_id TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE, last_used_step INTEGER NOT NULL, updated_at INTEGER NOT NULL) STRICT',
		// Device labels are keyed by the same 22-character one-way digest the API
		// exposes, never by the session token: the label table cannot become a second
		// copy of the bearer token, and a label outliving its session is harmless
		// because the digest is never reused.
		'CREATE TABLE IF NOT EXISTS account_session_label (session_id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE, label TEXT NOT NULL, updated_at INTEGER NOT NULL) STRICT',
	]),
	ownColumns: Object.freeze([]),
	ownIndexes: Object.freeze([
		'CREATE INDEX IF NOT EXISTS account_totp_replay_updated_idx ON account_totp_replay (updated_at)',
		'CREATE INDEX IF NOT EXISTS account_session_label_user_idx ON account_session_label (user_id)',
	]),
});

const destructiveSqlPattern = /\b(?:drop\s+(?:table|column|index)|rename\s+(?:table|column)|alter\s+table\s+\S+\s+drop)\b/i;

/**
 * Guard the migration batch against destructive statements.
 *
 * The rollback story ("switch back to the previous release bundle against the
 * same database") only works if nothing removed a column or table the old
 * code still reads. Every statement in `accountSecuritySchema` is asserted to
 * pass this check by the test suite, and the migration runner is expected to
 * call it too once the batch is wired.
 */
export function assertAdditiveMigration(statement) {
	if (typeof statement !== 'string' || statement.trim().length === 0) throw new TypeError('statement must be a non-empty string');
	if (destructiveSqlPattern.test(statement)) {
		throw new WorkspaceError(500, 'DestructiveMigration');
	}
	return statement;
}

/**
 * Non-goals, recorded as data so the scope cannot quietly grow during review.
 * A capability that is not in this list needs its own threat-model section.
 */
export const twoFactorNonGoals = Object.freeze([
	'sms-otp',
	'webauthn',
	'passkey',
	'trusted-device-30-day-bypass',
	'organisation-enforced-two-factor',
	'per-workspace-two-factor-policy',
	'totp-secret-export',
	'email-otp-fallback',
]);

/**
 * Machine-checked invariants. Returns a frozen list of violations (empty when
 * the contract is self-consistent), so the test suite fails if a future edit
 * makes the half-authenticated window as long as the idle window, or lets the
 * plugin's challenge cookie outlive our policy.
 */
export function verifySecurityInvariants() {
	const violations = [];
	const add = (condition, message) => {
		if (!condition) violations.push(message);
	};
	add(challengePolicy.cookieMaxAgeSeconds * 4 <= idlePolicy.defaultIdleSeconds, 'half-auth lifetime must be at most a quarter of the idle lifetime');
	add(challengePolicy.maxHalfAuthLifetimeSeconds * 24 <= idlePolicy.defaultIdleSeconds, 'half-auth lifetime must be far shorter (at most 1/24) than the idle lifetime');
	add(challengePolicy.maxHalfAuthLifetimeSeconds <= challengePolicy.cookieMaxAgeSeconds, 'half-auth lifetime must not exceed the challenge cookie lifetime');
	add(challengePolicy.cookieMaxAgeSeconds <= betterAuthTwoFactorFacts.twoFactorCookieMaxAgeSeconds, 'challenge cookie must not outlive the plugin cookie');
	add(challengePolicy.maxAttempts === betterAuthTwoFactorFacts.challengeMaxAttempts, 'attempt budget must match the plugin');
	add(challengePolicy.rateLimitWindowSeconds === betterAuthTwoFactorFacts.rateLimitWindowSeconds, 'rate-limit window must match the plugin');
	add(challengePolicy.rateLimitMax === betterAuthTwoFactorFacts.rateLimitMax, 'rate-limit budget must match the plugin');
	add(challengePolicy.trustDeviceEnabled === false, 'trusted-device bypass must stay disabled');
	add(totpParameters.digits === betterAuthTwoFactorFacts.totpDigits, 'TOTP digit count must match the plugin');
	add(totpParameters.periodSeconds === betterAuthTwoFactorFacts.totpPeriodSeconds, 'TOTP period must match the plugin');
	add(totpParameters.algorithm === betterAuthTwoFactorFacts.totpAlgorithm, 'TOTP algorithm must match the plugin HMAC');
	add(totpParameters.minimumSecretBits >= 160, 'TOTP secrets must keep RFC 6238 §5.1 minimum entropy');
	add(betterAuthTwoFactorFacts.replayProtection === false, 'replay guard is only needed while the plugin provides none');
	add(recoveryCodeParameters.count >= 8, 'a backup factor needs at least eight codes');
	add(recoveryCodeParameters.count === recoveryCodeRotation.count, 'rotation must keep the documented count');
	add(recoveryCodeParameters.alphabet.length >= 30, 'the recovery alphabet must keep at least 49 bits across ten symbols');
	add(new Set(recoveryCodeParameters.alphabet).size === recoveryCodeParameters.alphabet.length, 'the recovery alphabet must not repeat a symbol');
	add(recoveryCodeRotation.invalidatesPrevious === true, 'rotation must invalidate previous codes');
	add(idlePolicy.minimumIdleSeconds <= idlePolicy.defaultIdleSeconds && idlePolicy.defaultIdleSeconds <= idlePolicy.maximumIdleSeconds, 'idle bounds must bracket the default');
	add(passwordPolicy.revokeOtherSessions === true, 'password change must revoke other sessions by default');
	add(sessionDescriptorWithheldFields.includes('token'), 'session descriptors must withhold the token');
	for (const route of accountSecurityRouteTable) {
		add(Object.hasOwn(authStateRank, route.requires), `route ${route.action} requires an unknown state`);
	}
	for (const [code, status] of Object.entries(accountSecurityErrorCodes)) {
		add(accountSecurityErrorStatus[status] !== undefined, `error code ${code} has no status`);
		add(Number.isSafeInteger(accountSecurityErrorStatus[status]) && accountSecurityErrorStatus[status] >= 400, `error code ${code} maps to an invalid status`);
	}
	add(Object.keys(accountSecurityErrorCodes).length === Object.keys(accountSecurityErrorStatus).length, 'every error code needs exactly one status');
	for (const statement of [...accountSecuritySchema.ownTables, ...accountSecuritySchema.ownIndexes]) {
		try {
			assertAdditiveMigration(statement);
		} catch {
			violations.push(`own migration is destructive: ${statement}`);
		}
	}
	add(accountSecuritySchema.ownColumns.length === 0, 'this batch must not alter existing columns');
	return Object.freeze(violations);
}
