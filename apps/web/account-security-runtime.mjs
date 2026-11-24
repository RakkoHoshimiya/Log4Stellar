import { createHmac, timingSafeEqual } from 'node:crypto';
import { generateRandomString, symmetricDecrypt, symmetricEncrypt } from 'better-auth/crypto';
import qrcode from 'qrcode-generator';
import {
	accountSecurityErrorCodes,
	accountSecurityRoutes,
	admitTotpStep,
	betterAuthTwoFactorFacts,
	challengePolicy,
	clampIdleSeconds,
	consumeRecoveryCode,
	describeSessions,
	generateRecoveryCodes,
	matchRecoveryCode,
	isRecoveryCode,
	normalizeDeviceLabel,
	normalizeRecoveryCode,
	normalizeTotpCode,
	recoveryCodeParameters,
	requireSessionId,
	sessionExpiryAfterSecondFactor,
	sessionIdFor,
	totpParameters,
	totpStepFor,
	totpStepWindow,
	validateNewPassword,
} from './account-security.mjs';
import { WorkspaceError } from './workspace-contract.mjs';

// Runtime side of the account-security contract. `account-security.mjs` stays
// pure — it decides *whether* something is allowed and *how* a value is
// normalised — while this module owns the three things a pure module cannot:
// the authentication database, the TOTP secret, and the session cookie.
//
// Two invariants shape the code below.
//
// 1. Consuming a TOTP step and creating the session are one transaction. The
//    library verifies codes with an in-memory window and keeps no record of
//    which step it has already accepted, so the replay guard is ours. If the
//    step write committed and the session insert failed, the user would burn a
//    code and get nothing; if the session committed and the step write failed,
//    the same code would keep working. `database.exec('BEGIN IMMEDIATE')` takes
//    the write lock up front (the library's own transaction helper issues a bare
//    `begin`, which does not), and everything below runs synchronously inside it.
//
// 2. Nothing here logs a password, a secret, a token or a recovery code. Errors
//    carry a contract error code and nothing else.

const openSessionsLimit = 200;
const bodyLimitBytes = 8192;
const totpIssuer = totpParameters.issuer;

// --- cookie helpers ------------------------------------------------------

function decodeCookieValue(raw) {
	if (raw.startsWith('"') && raw.endsWith('"')) {
		return raw.slice(1, -1);
	}
	try {
		return decodeURIComponent(raw);
	} catch {
		return raw;
	}
}

export function readCookie(header, name) {
	if (typeof header !== 'string' || header.length === 0) {
		return undefined;
	}
	for (const part of header.split(';')) {
		const trimmed = part.trim();
		if (!trimmed.startsWith(name + '=')) {
			continue;
		}
		return decodeCookieValue(trimmed.substring(name.length + 1));
	}
	return undefined;
}

// Mirrors better-call's signed cookie format: `<payload>.<44-char base64 HMAC>`.
// The HMAC covers the payload exactly as sent, so the payload is neither decoded
// nor re-encoded before it is signed.
function signatureFor(value, secret) {
	return createHmac('sha256', secret).update(value, 'utf8').digest('base64');
}

function verifySignature(payload, signature, secret) {
	if (typeof signature !== 'string' || signature.length !== 44 || !signature.endsWith('=')) {
		return false;
	}
	const expected = Buffer.from(signatureFor(payload, secret), 'utf8');
	const actual = Buffer.from(signature, 'utf8');
	return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function unsignedCookieValue(signed, secret) {
	const split = signed.lastIndexOf('.');
	if (split < 1) {
		return undefined;
	}
	const payload = signed.substring(0, split);
	return verifySignature(payload, signed.substring(split + 1), secret) ? payload : undefined;
}

function serializeCookie({ name, value, maxAgeSeconds, sameSite = 'Lax' }) {
	const parts = [name + '=' + encodeURIComponent(value)];
	parts.push('Max-Age=' + Math.max(0, Math.trunc(maxAgeSeconds)));
	parts.push('Path=/');
	parts.push('HttpOnly');
	parts.push('Secure');
	parts.push('SameSite=' + sameSite);
	return parts.join('; ');
}

export const sessionCookieName = '__Secure-better-auth.session_token';
export const challengeCookieName = '__Secure-better-auth.two_factor';

export function sessionCookie(secret, token, maxAgeSeconds) {
	return serializeCookie({ name: sessionCookieName, value: token + '.' + signatureFor(token, secret), maxAgeSeconds });
}

export function clearedChallengeCookie() {
	return serializeCookie({ name: challengeCookieName, value: '', maxAgeSeconds: 0 });
}

export function clearedSessionCookie() {
	return serializeCookie({ name: sessionCookieName, value: '', maxAgeSeconds: 0 });
}

// --- challenge resolution -------------------------------------------------

// A challenge is live when the cookie signature verifies *and* its verification
// row has not expired. Anything else — missing, malformed, forged, expired — is
// deliberately indistinguishable from "anonymous": a caller must not learn which
// of those it hit (§13.1 A11, A12).
export function createChallengeResolver({ auth, database }) {
	return async function resolveChallenge(rawCookieValue, nowMs = Date.now()) {
		if (typeof rawCookieValue !== 'string' || rawCookieValue.length === 0) {
			return undefined;
		}
		const secret = await resolveSecret(auth);
		if (secret === undefined) {
			return undefined;
		}
		const identifier = unsignedCookieValue(rawCookieValue, secret);
		if (identifier === undefined || !identifier.startsWith('2fa-')) {
			return undefined;
		}
		let row;
		try {
			row = database.prepare('SELECT identifier, value, expiresAt FROM verification WHERE identifier = ?').get(identifier);
		} catch {
			return undefined;
		}
		if (!row) {
			return undefined;
		}
		const expiresAtMs = Date.parse(String(row.expiresAt));
		if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) {
			return undefined;
		}
		return Object.freeze({ identifier: String(row.identifier), userId: String(row.value), expiresAtMs });
	};
}

async function resolveSecret(auth) {
	if (typeof auth?.$context?.then !== 'function') {
		return undefined;
	}
	const context = await auth.$context;
	const secret = context?.secret;
	return typeof secret === 'string' && secret.length >= 32 ? secret : undefined;
}

// --- small database helpers ----------------------------------------------

function userRow(database, userId) {
	const row = database.prepare('SELECT id, username, name, email, twoFactorEnabled FROM user WHERE id = ?').get(userId);
	return row ? Object.freeze({ id: String(row.id), username: row.username ?? null, name: row.name ?? null, email: row.email ?? null, twoFactorEnabled: Number(row.twoFactorEnabled ?? 0) }) : undefined;
}

function twoFactorRow(database, userId) {
	const row = database.prepare('SELECT id, secret, backupCodes, verified, failedVerificationCount, lockedUntil FROM twoFactor WHERE userId = ?').get(userId);
	return row ? Object.freeze({
		id: String(row.id),
		secret: String(row.secret),
		backupCodes: String(row.backupCodes),
		verified: row.verified === null || row.verified === undefined ? true : Boolean(Number(row.verified)),
		failedVerificationCount: Number(row.failedVerificationCount ?? 0),
		lockedUntil: row.lockedUntil ? String(row.lockedUntil) : null,
	}) : undefined;
}

function sessionRows(database, userId, { excludeToken } = {}) {
	const rows = excludeToken === undefined
		? database.prepare('SELECT id, token, expiresAt, createdAt, updatedAt, ipAddress, userAgent FROM session WHERE userId = ? ORDER BY updatedAt DESC LIMIT ' + openSessionsLimit).all(userId)
		: database.prepare('SELECT id, token, expiresAt, createdAt, updatedAt, ipAddress, userAgent FROM session WHERE userId = ? AND token <> ? ORDER BY updatedAt DESC LIMIT ' + openSessionsLimit).all(userId, excludeToken);
	return rows.map(row => ({
		id: String(row.id),
		token: String(row.token),
		expiresAt: String(row.expiresAt),
		createdAt: String(row.createdAt),
		updatedAt: String(row.updatedAt),
		ipAddress: row.ipAddress === null || row.ipAddress === undefined ? null : String(row.ipAddress),
		userAgent: row.userAgent === null || row.userAgent === undefined ? null : String(row.userAgent),
	}));
}

function insertSession(database, { userId, token, secret, idleSeconds, ipAddress, userAgent, nowMs }) {
	const expiry = sessionExpiryAfterSecondFactor({ completedAtMs: nowMs, idleSeconds });
	const now = new Date(nowMs).toISOString();
	database.prepare(
		'INSERT INTO session (id, expiresAt, token, createdAt, updatedAt, ipAddress, userAgent, userId, impersonatedBy) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)',
	).run(generateRandomString(32), new Date(expiry.expiresAtMs).toISOString(), token, now, now, ipAddress, userAgent, userId);
	return { token, expiresAtMs: expiry.expiresAtMs };
}

function touchSession(database, token, nowMs) {
	return database.prepare('UPDATE session SET updatedAt = ? WHERE token = ?').run(new Date(nowMs).toISOString(), token).changes > 0;
}

function deleteSession(database, token) {
	return database.prepare('DELETE FROM session WHERE token = ?').run(token).changes > 0;
}

function deleteOtherSessions(database, userId, keepToken) {
	return database.prepare('DELETE FROM session WHERE userId = ? AND token <> ?').run(userId, keepToken).changes;
}

function writeTransaction(database, update) {
	database.exec('BEGIN IMMEDIATE');
	try {
		const result = update();
		database.exec('COMMIT');
		return result;
	} catch (error) {
		database.exec('ROLLBACK');
		throw error;
	}
}

function claimTotpStep(database, userId, step, nowMs) {
	const claimed = database.prepare(
		`INSERT INTO account_totp_replay (user_id, last_used_step, updated_at) VALUES (?, ?, ?)
		ON CONFLICT (user_id) DO UPDATE SET last_used_step = excluded.last_used_step, updated_at = excluded.updated_at
		WHERE account_totp_replay.last_used_step < excluded.last_used_step`,
	).run(userId, step, nowMs);
	if (Number(claimed.changes) !== 1) {
		throw new WorkspaceError(401, accountSecurityErrorCodes.totpCodeReplayed);
	}
}

// --- attempt accounting ---------------------------------------------------

function challengeIdentifierFor(state) {
	return state.challenge?.identifier;
}

function attemptRow(database, identifier) {
	const row = database.prepare('SELECT identifier, value, expiresAt FROM verification WHERE identifier = ?').get('2fa-attempts-' + identifier);
	return row ? { identifier: String(row.identifier), value: String(row.value), expiresAt: String(row.expiresAt) } : undefined;
}

// The library caps a challenge at five attempts and burns the challenge row when
// the cap is reached; the counters live in the verification table exactly as the
// library writes them, so a challenge started before an upgrade keeps working.
function consumeAttempt(database, state) {
	const identifier = challengeIdentifierFor(state);
	if (identifier === undefined) {
		return false;
	}
	return writeTransaction(database, () => {
		const row = attemptRow(database, identifier);
		if (!row) {
			return false;
		}
		const attempts = Number(row.value);
		if (!Number.isSafeInteger(attempts) || attempts >= challengePolicy.maxAttempts) {
			database.prepare('DELETE FROM verification WHERE identifier IN (?, ?)').run(identifier, row.identifier);
			return false;
		}
		database.prepare('UPDATE verification SET value = ? WHERE identifier = ?').run(String(attempts + 1), row.identifier);
		return true;
	});
}

// --- rate limiting --------------------------------------------------------

// Parity with the library's own `two-factor/*` rule (3 requests per 10 seconds).
// In-memory on purpose: this is a throttle, not a security boundary — the replay
// guard, the attempt cap and the account lockout all survive a restart, and this
// only has to keep a brute-force loop from saturating a core.
function createRateLimiter({ windowSeconds = challengePolicy.rateLimitWindowSeconds, max = challengePolicy.rateLimitMax, now = () => Date.now() } = {}) {
	const hits = new Map();
	return function take(key) {
		const nowMs = now();
		const windowStart = nowMs - windowSeconds * 1000;
		const recent = (hits.get(key) ?? []).filter(timestamp => timestamp > windowStart);
		if (recent.length >= max) {
			hits.set(key, recent);
			return false;
		}
		recent.push(nowMs);
		hits.set(key, recent);
		if (hits.size > 4096) {
			for (const [candidate, timestamps] of hits) {
				if (timestamps.every(timestamp => timestamp <= windowStart)) {
					hits.delete(candidate);
				}
			}
		}
		return true;
	};
}

// --- TOTP ----------------------------------------------------------------

const base32Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(text) {
	const bytes = Buffer.from(text, 'utf8');
	let bits = 0;
	let value = 0;
	let encoded = '';
	for (const byte of bytes) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			encoded += base32Alphabet[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	if (bits > 0) {
		encoded += base32Alphabet[(value << (5 - bits)) & 31];
	}
	return encoded;
}

function totpCode(secret, step, digits = totpParameters.digits) {
	const counter = Buffer.alloc(8);
	counter.writeBigUInt64BE(BigInt(step));
	const digest = createHmac('sha1', secret).update(counter).digest();
	const offset = digest[digest.length - 1] & 15;
	const binary = ((digest[offset] & 127) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3];
	return String(binary % 10 ** digits).padStart(digits, '0');
}

// Which step does this code belong to? The contract's window is ±1 step, so at
// most three candidates are tried and every one is compared in constant time.
function totpStepForCode(secret, code, nowMs) {
	const currentStep = totpStepFor(nowMs, { periodSeconds: totpParameters.periodSeconds });
	const window = totpStepWindow(currentStep, { backward: totpParameters.windowBackwardSteps, forward: totpParameters.windowForwardSteps });
	const candidate = Buffer.from(code, 'utf8');
	for (const step of window) {
		const expected = Buffer.from(totpCode(secret, step), 'utf8');
		if (expected.length === candidate.length && timingSafeEqual(expected, candidate)) {
			return step;
		}
	}
	return -1;
}

function totpUri(secret, account) {
	const params = new URLSearchParams();
	params.set('secret', base32Encode(secret));
	params.set('issuer', totpIssuer);
	params.set('digits', String(totpParameters.digits));
	params.set('period', String(totpParameters.periodSeconds));
	return 'otpauth://totp/' + encodeURIComponent(totpIssuer) + ':' + encodeURIComponent(account) + '?' + params.toString();
}

// --- request plumbing ----------------------------------------------------

async function readJsonBody(ctx) {
	if (ctx.body !== undefined && typeof ctx.body === 'object' && !Buffer.isBuffer(ctx.body) && typeof ctx.body.pipe !== 'function') {
		return ctx.body;
	}
	const chunks = [];
	let total = 0;
	const stream = ctx.req;
	if (stream && typeof stream[Symbol.asyncIterator] === 'function') {
		for await (const chunk of stream) {
			total += chunk.length;
			if (total > bodyLimitBytes) {
				throw new WorkspaceError(413, 'RequestTooLarge');
			}
			chunks.push(Buffer.from(chunk));
		}
	}
	if (chunks.length === 0) {
		return Object.create(null);
	}
	const text = Buffer.concat(chunks).toString('utf8');
	try {
		const parsed = JSON.parse(text);
		if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
			throw new WorkspaceError(400, 'InvalidRequestBody');
		}
		return parsed;
	} catch (error) {
		if (error instanceof WorkspaceError) {
			throw error;
		}
		throw new WorkspaceError(400, 'InvalidRequestBody');
	}
}

function requireString(body, field) {
	const value = body?.[field];
	if (typeof value !== 'string') {
		throw new WorkspaceError(400, 'InvalidRequestBody');
	}
	return value;
}

function optionalString(body, field) {
	const value = body?.[field];
	if (value === undefined || value === null) {
		return undefined;
	}
	if (typeof value !== 'string') {
		throw new WorkspaceError(400, 'InvalidRequestBody');
	}
	return value;
}

function requireBoolean(body, field) {
	const value = body?.[field];
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== 'boolean') {
		throw new WorkspaceError(400, 'InvalidRequestBody');
	}
	return value;
}

function decodeBackupCodes(secret, encrypted) {
	try {
		const plain = typeof encrypted === 'string' ? encrypted : '';
		if (plain.length === 0) {
			return [];
		}
		return decodeCodesValue(plain);
	} catch {
		return [];
	}
}

function decodeCodesValue(plain) {
	const parsed = JSON.parse(plain);
	return Array.isArray(parsed) ? parsed.map(String) : [];
}

// --- the runtime ---------------------------------------------------------

export function createAccountSecurityRuntime({ auth, database, secret: providedSecret, idleSeconds, logger } = {}) {
	if (database === undefined || database === null || typeof database.prepare !== 'function') {
		throw new TypeError('createAccountSecurityRuntime requires the authentication database');
	}
	const idle = clampIdleSeconds(idleSeconds ?? Number(process.env.LOG4STELLAR_IDLE_SECONDS ?? 86_400));
	const limit = createRateLimiter();
	let secretPromise;

	function secretOf() {
		if (providedSecret !== undefined) {
			return Promise.resolve(providedSecret);
		}
		secretPromise ??= resolveSecret(auth);
		return secretPromise;
	}

	async function requireSecret() {
		const secret = await secretOf();
		if (typeof secret !== 'string' || secret.length < 32) {
			throw new WorkspaceError(503, 'AccountSecurityUnavailable');
		}
		return secret;
	}

	function currentSessionRow(token) {
		const row = database.prepare('SELECT id, token, userId, expiresAt FROM session WHERE token = ?').get(token);
		return row ? { id: String(row.id), token: String(row.token), userId: String(row.userId), expiresAt: String(row.expiresAt) } : undefined;
	}

	function requireCurrentSession(state) {
		const token = state?.session?.session?.token;
		if (typeof token !== 'string') {
			throw new WorkspaceError(401, accountSecurityErrorCodes.twoFactorChallengeRequired);
		}
		const row = currentSessionRow(token);
		if (!row) {
			throw new WorkspaceError(401, accountSecurityErrorCodes.sessionExpired);
		}
		return row;
	}

	// Verifies `password` against the credential account of `userId` without ever
	// copying the supplied value anywhere it could be logged.
	async function assertPassword(userId, password) {
		if (typeof password !== 'string' || password.length === 0) {
			throw new WorkspaceError(401, accountSecurityErrorCodes.reauthenticationRequired);
		}
		const context = await auth.$context;
		const account = database.prepare("SELECT id, password FROM account WHERE userId = ? AND providerId = 'credential'").get(userId);
		if (!account || typeof account.password !== 'string') {
			throw new WorkspaceError(401, accountSecurityErrorCodes.reauthenticationRequired);
		}
		const valid = await context.password.verify({ hash: String(account.password), password });
		if (!valid) {
			throw new WorkspaceError(401, accountSecurityErrorCodes.reauthenticationRequired);
		}
		return String(account.id);
	}

	function metadataOf(ctx) {
		const forwarded = ctx.get('x-log4stellar-peer');
		const remote = typeof forwarded === 'string' && forwarded.length > 0 ? forwarded : (ctx.req?.socket?.remoteAddress ?? '');
		return { ipAddress: String(remote).slice(0, 128), userAgent: String(ctx.get('user-agent') ?? '').slice(0, 256) };
	}

	// --- two-factor verification -----------------------------------------

	async function verifyTotpCode({ userId, row, code, nowMs, allowUnverified = false }) {
		if (!row) {
			throw new WorkspaceError(409, accountSecurityErrorCodes.totpNotEnrolled);
		}
		if (!row.verified && !allowUnverified) {
			throw new WorkspaceError(409, accountSecurityErrorCodes.totpNotEnrolled);
		}
		const secret = await requireSecret();
		let plainSecret;
		try {
			plainSecret = await symmetricDecrypt({ key: secret, data: row.secret });
		} catch {
			throw new WorkspaceError(503, 'AccountSecurityUnavailable');
		}
		const step = totpStepForCode(plainSecret, code, nowMs);
		if (step === -1) {
			return { ok: false, reason: 'invalid' };
		}
		const replay = database.prepare('SELECT last_used_step FROM account_totp_replay WHERE user_id = ?').get(userId);
		try {
			admitTotpStep({
				lastUsedStep: replay ? Number(replay.last_used_step) : undefined,
				step,
				nowMs,
				backward: totpParameters.windowBackwardSteps,
				forward: totpParameters.windowForwardSteps,
			});
		} catch (error) {
			if (error instanceof WorkspaceError) {
				return { ok: false, reason: error.code === accountSecurityErrorCodes.totpCodeReplayed ? 'replayed' : 'invalid' };
			}
			throw error;
		}
		return { ok: true, step };
	}

	// Exchange the second factor once. The challenge row and session live in the same database.
	function exchangeChallengeForSession({ state, row, ctx, nowMs, consumeFactor }) {
		const { identifier, userId } = state.challenge;
		const { ipAddress, userAgent } = metadataOf(ctx);
		const token = generateRandomString(32);
		return writeTransaction(database, () => {
			const current = twoFactorRow(database, userId);
			if (!current?.verified || current.id !== row.id || current.secret !== row.secret) {
				throw new WorkspaceError(409, accountSecurityErrorCodes.totpNotEnrolled);
			}
			assertUnlocked(current, nowMs);
			const consumed = database.prepare('DELETE FROM verification WHERE identifier = ? AND value = ?').run(identifier, userId);
			if (Number(consumed.changes) !== 1) {
				throw new WorkspaceError(401, accountSecurityErrorCodes.twoFactorChallengeRequired);
			}
			consumeFactor();
			database.prepare('DELETE FROM verification WHERE identifier = ?').run('2fa-attempts-' + identifier);
			database.prepare('UPDATE twoFactor SET failedVerificationCount = 0, lockedUntil = NULL WHERE id = ?').run(row.id);
			insertSession(database, { userId, token, idleSeconds: idle, ipAddress, userAgent, nowMs });
			return token;
		});
	}

	function assertUnlocked(row, nowMs) {
		if (row.lockedUntil && Date.parse(row.lockedUntil) > nowMs) {
			throw new WorkspaceError(429, 'AccountTemporarilyLocked');
		}
	}

	function requireChallengeAttempt(state, row, nowMs) {
		if (!row?.verified) {
			throw new WorkspaceError(409, accountSecurityErrorCodes.totpNotEnrolled);
		}
		assertUnlocked(row, nowMs);
		if (!consumeAttempt(database, state)) {
			throw new WorkspaceError(400, 'TooManyAttempts');
		}
	}

	// --- route handlers ---------------------------------------------------

	async function verifyTotp({ ctx, state, nowMs }) {
		if (!state.challengeLive) {
			throw new WorkspaceError(401, accountSecurityErrorCodes.twoFactorChallengeRequired);
		}
		if (!limit('verify:' + state.challenge.identifier)) {
			throw new WorkspaceError(429, 'TooManyRequests');
		}
		const body = await readJsonBody(ctx);
		const code = normalizeTotpCode(body.code);
		const userId = state.challenge.userId;
		const row = twoFactorRow(database, userId);
		requireChallengeAttempt(state, row, nowMs);
		const result = await verifyTotpCode({ userId, row, code, nowMs });
		if (!result.ok) {
			if (result.reason === 'replayed') {
				throw new WorkspaceError(401, accountSecurityErrorCodes.totpCodeReplayed);
			}
			recordFailure(userId, nowMs);
			throw new WorkspaceError(401, accountSecurityErrorCodes.invalidTotpCode);
		}
		const secret = await requireSecret();
		const token = exchangeChallengeForSession({
			state, row, ctx, nowMs,
			consumeFactor: () => claimTotpStep(database, userId, result.step, nowMs),
		});
		return { body: { ok: true }, setCookie: sessionCookie(secret, token, idle), clearChallenge: true, userId };
	}

	async function verifyRecoveryCode({ ctx, state, nowMs }) {
		if (!state.challengeLive) {
			throw new WorkspaceError(401, accountSecurityErrorCodes.twoFactorChallengeRequired);
		}
		if (!limit('verify:' + state.challenge.identifier)) {
			throw new WorkspaceError(429, 'TooManyRequests');
		}
		const body = await readJsonBody(ctx);
		const supplied = normalizeRecoveryCode(body.code);
		const userId = state.challenge.userId;
		const row = twoFactorRow(database, userId);
		requireChallengeAttempt(state, row, nowMs);
		const secret = await requireSecret();
		const stored = await decodeEncryptedCodes(secret, row.backupCodes);
		let matched;
		try {
			matched = consumeRecoveryCode(supplied, stored);
		} catch (error) {
			if (error instanceof WorkspaceError && error.code === accountSecurityErrorCodes.invalidRecoveryCode) {
				recordFailure(userId, nowMs);
			}
			throw error;
		}
		const encoded = await symmetricEncrypt({ key: secret, data: JSON.stringify(matched.remaining) });
		const token = exchangeChallengeForSession({
			state, row, ctx, nowMs,
			consumeFactor() {
				const written = database.prepare('UPDATE twoFactor SET backupCodes = ? WHERE id = ? AND backupCodes = ?').run(encoded, row.id, row.backupCodes);
				if (Number(written.changes) !== 1) {
					throw new WorkspaceError(409, 'ConcurrentRecoveryCodeRotation');
				}
			},
		});
		return { body: { ok: true, remaining: matched.remaining.length }, setCookie: sessionCookie(secret, token, idle), clearChallenge: true, userId };
	}

	async function decodeEncryptedCodes(secret, encrypted) {
		if (typeof encrypted !== 'string' || encrypted.length === 0) {
			return [];
		}
		try {
			return decodeCodesValue(await symmetricDecrypt({ key: secret, data: encrypted }));
		} catch {
			return [];
		}
	}

	function recordFailure(userId, nowMs) {
		writeTransaction(database, () => {
			const row = twoFactorRow(database, userId);
			if (!row || (row.lockedUntil && Date.parse(row.lockedUntil) > nowMs)) {
				return;
			}
			const count = row.lockedUntil ? 1 : row.failedVerificationCount + 1;
			const lockedUntil = count >= challengePolicy.accountLockMaxFailedAttempts
				? new Date(nowMs + challengePolicy.accountLockDurationSeconds * 1000).toISOString()
				: null;
			database.prepare('UPDATE twoFactor SET failedVerificationCount = ?, lockedUntil = ? WHERE id = ?').run(count, lockedUntil, row.id);
		});
	}

	async function enroll({ ctx, state }) {
		const current = requireCurrentSession(state);
		const user = userRow(database, current.userId);
		const body = await readJsonBody(ctx);
		await assertPassword(current.userId, optionalString(body, 'password'));
		const secret = await requireSecret();
		const plainSecret = generateRandomString(totpParameters.generatedSecretLength);
		const encryptedSecret = await symmetricEncrypt({ key: secret, data: plainSecret });
		const codes = generateRecoveryCodes({ count: recoveryCodeParameters.count });
		const encryptedCodes = await symmetricEncrypt({ key: secret, data: JSON.stringify(codes) });
		writeTransaction(database, () => {
			requireCurrentSession(state);
			const existing = twoFactorRow(database, current.userId);
			if (existing?.verified) {
				throw new WorkspaceError(409, accountSecurityErrorCodes.totpAlreadyEnrolled);
			}
			if (existing) {
				database.prepare('UPDATE twoFactor SET secret = ?, backupCodes = ?, verified = 0, failedVerificationCount = 0, lockedUntil = NULL WHERE id = ?').run(encryptedSecret, encryptedCodes, existing.id);
			} else {
				database.prepare('INSERT INTO twoFactor (id, secret, backupCodes, userId, verified, failedVerificationCount, lockedUntil) VALUES (?, ?, ?, ?, 0, 0, NULL)').run(generateRandomString(32), encryptedSecret, encryptedCodes, current.userId);
			}
		});
		const uri = totpUri(plainSecret, user?.email ?? user?.username ?? current.userId);
		const qr = qrcode(0, 'M');
		qr.addData(uri);
		qr.make();
		return { body: { method: 'totp', totpURI: uri, totpQr: qr.createDataURL(4), backupCodes: codes } };
	}

	async function confirmEnrollment({ ctx, state, nowMs }) {
		const current = requireCurrentSession(state);
		const body = await readJsonBody(ctx);
		const code = normalizeTotpCode(body.code);
		const row = twoFactorRow(database, current.userId);
		if (!row || row.verified) {
			throw new WorkspaceError(409, row ? accountSecurityErrorCodes.totpAlreadyEnrolled : accountSecurityErrorCodes.totpNotEnrolled);
		}
		assertUnlocked(row, nowMs);
		const result = await verifyTotpCode({ userId: current.userId, row, code, nowMs, allowUnverified: true });
		if (!result.ok) {
			recordFailure(current.userId, nowMs);
			throw new WorkspaceError(401, result.reason === 'replayed' ? accountSecurityErrorCodes.totpCodeReplayed : accountSecurityErrorCodes.invalidTotpCode);
		}
		writeTransaction(database, () => {
			requireCurrentSession(state);
			const updated = database.prepare(
				'UPDATE twoFactor SET verified = 1, failedVerificationCount = 0, lockedUntil = NULL WHERE id = ? AND secret = ? AND verified = 0',
			).run(row.id, row.secret);
			if (Number(updated.changes) !== 1) {
				throw new WorkspaceError(409, 'TotpEnrollmentChanged');
			}
			claimTotpStep(database, current.userId, result.step, nowMs);
			database.prepare('UPDATE user SET twoFactorEnabled = 1 WHERE id = ?').run(current.userId);
		});
		return { body: { ok: true, twoFactorEnabled: true } };
	}

	async function verifyManagementFactor({ state, password, code, nowMs }) {
		const current = requireCurrentSession(state);
		await assertPassword(current.userId, password);
		if (!code) {
			throw new WorkspaceError(403, accountSecurityErrorCodes.reauthenticationRequired);
		}
		const row = twoFactorRow(database, current.userId);
		if (!row?.verified) {
			throw new WorkspaceError(409, accountSecurityErrorCodes.totpNotEnrolled);
		}
		assertUnlocked(row, nowMs);
		const secret = await requireSecret();
		if (isRecoveryCode(code)) {
			const stored = await decodeEncryptedCodes(secret, row.backupCodes);
			consumeRecoveryCode(code, stored);
			return { current, row, secret, step: undefined };
		}
		const result = await verifyTotpCode({ userId: current.userId, row, code: normalizeTotpCode(code), nowMs });
		if (!result.ok) {
			throw new WorkspaceError(401, result.reason === 'replayed' ? accountSecurityErrorCodes.totpCodeReplayed : accountSecurityErrorCodes.invalidTotpCode);
		}
		return { current, row, secret, step: result.step };
	}

	async function disable({ ctx, state, nowMs }) {
		const body = await readJsonBody(ctx);
		const { current, row, secret, step } = await verifyManagementFactor({
			state, password: optionalString(body, 'password'), code: optionalString(body, 'code'), nowMs,
		});
		const token = generateRandomString(32);
		const { ipAddress, userAgent } = metadataOf(ctx);
		const revoked = writeTransaction(database, () => {
			requireCurrentSession(state);
			const deleted = database.prepare('DELETE FROM twoFactor WHERE id = ? AND secret = ? AND backupCodes = ?').run(row.id, row.secret, row.backupCodes);
			if (Number(deleted.changes) !== 1) {
				throw new WorkspaceError(409, 'TotpEnrollmentChanged');
			}
			if (step !== undefined) {
				claimTotpStep(database, current.userId, step, nowMs);
			}
			database.prepare('UPDATE user SET twoFactorEnabled = 0 WHERE id = ?').run(current.userId);
			const otherSessions = deleteOtherSessions(database, current.userId, current.token);
			deleteSession(database, current.token);
			insertSession(database, { userId: current.userId, token, idleSeconds: idle, ipAddress, userAgent, nowMs });
			return otherSessions;
		});
		return {
			body: { ok: true, twoFactorEnabled: false, revokedSessions: revoked },
			setCookie: sessionCookie(secret, token, idle),
		};
	}

	async function regenerateRecoveryCodes({ ctx, state, nowMs }) {
		const body = await readJsonBody(ctx);
		const { current, row, secret, step } = await verifyManagementFactor({
			state, password: optionalString(body, 'password'), code: optionalString(body, 'code'), nowMs,
		});
		const codes = generateRecoveryCodes({ count: recoveryCodeParameters.count });
		const encoded = await symmetricEncrypt({ key: secret, data: JSON.stringify(codes) });
		writeTransaction(database, () => {
			requireCurrentSession(state);
			const written = database.prepare('UPDATE twoFactor SET backupCodes = ? WHERE id = ? AND secret = ? AND backupCodes = ?').run(encoded, row.id, row.secret, row.backupCodes);
			if (Number(written.changes) !== 1) {
				throw new WorkspaceError(409, 'ConcurrentRecoveryCodeRotation');
			}
			if (step !== undefined) {
				claimTotpStep(database, current.userId, step, nowMs);
			}
		});
		return { body: { backupCodes: codes } };
	}

	async function changePassword({ ctx, state }) {
		const current = requireCurrentSession(state);
		const body = await readJsonBody(ctx);
		const currentPassword = optionalString(body, 'currentPassword');
		const newPassword = requireString(body, 'newPassword');
		const user = userRow(database, current.userId);
		// Order matters: reauthentication first, then policy. A wrong current
		// password must not reveal whether the new one would have been acceptable.
		const accountId = await assertPassword(current.userId, currentPassword);
		validateNewPassword(newPassword, { username: user?.username ?? '' });
		const context = await auth.$context;
		const hashed = await context.password.hash(newPassword);
		const { ipAddress, userAgent } = metadataOf(ctx);
		const token = generateRandomString(32);
		const nowMs = Date.now();
		database.exec('BEGIN IMMEDIATE');
		try {
			database.prepare('UPDATE account SET password = ?, updatedAt = ? WHERE id = ?').run(hashed, new Date(nowMs).toISOString(), accountId);
			deleteOtherSessions(database, current.userId, current.token);
			deleteSession(database, current.token);
			insertSession(database, { userId: current.userId, token, idleSeconds: idle, ipAddress, userAgent, nowMs });
			database.exec('COMMIT');
		} catch (error) {
			try {
				database.exec('ROLLBACK');
			} catch {
				// ignore
			}
			throw error;
		}
		const secret = await requireSecret();
		// The caller keeps their identity but receives a fresh token: every other
		// device is now anonymous while this one stays signed in (E1-E3).
		return { body: { ok: true }, setCookie: sessionCookie(secret, token, idle), userId: current.userId };
	}

	function labelsFor(userId) {
		const rows = database.prepare('SELECT session_id, label FROM account_session_label WHERE user_id = ?').all(userId);
		const labels = Object.create(null);
		for (const row of rows) {
			labels[String(row.session_id)] = String(row.label);
		}
		return labels;
	}

	async function listSessions({ ctx, state, nowMs }) {
		const current = requireCurrentSession(state);
		const includeNetwork = ctx.query?.includeNetwork === 'true';
		const sessions = sessionRows(database, current.userId, { excludeToken: undefined });
		const described = describeSessions(sessions.map(row => ({
			id: row.id,
			token: row.token,
			expiresAt: row.expiresAt,
			createdAt: row.createdAt,
			updatedAt: row.updatedAt,
			ipAddress: row.ipAddress,
			userAgent: row.userAgent,
		})), {
			currentToken: current.token,
			labels: labelsFor(current.userId),
			includeNetwork,
			nowMs,
		});
		return { body: { sessions: described } };
	}

	async function labelSession({ ctx, state, route, nowMs }) {
		const current = requireCurrentSession(state);
		const sessionId = requireSessionId(route.params.sessionId);
		const body = await readJsonBody(ctx);
		const label = normalizeDeviceLabel(body.label);
		if (label === undefined) {
			throw new WorkspaceError(400, accountSecurityErrorCodes.invalidDeviceLabel);
		}
		const match = sessionRows(database, current.userId).find(row => sessionIdFor(row.token) === sessionId);
		if (!match) {
			throw new WorkspaceError(404, accountSecurityErrorCodes.sessionNotFound);
		}
		database.prepare(
			`INSERT INTO account_session_label (session_id, user_id, label, updated_at) VALUES (?, ?, ?, ?)
			ON CONFLICT (session_id) DO UPDATE SET label = excluded.label, updated_at = excluded.updated_at`,
		).run(sessionId, current.userId, label, nowMs);
		return { body: { ok: true, id: sessionId, device: label } };
	}

	async function revokeSession({ ctx, state, route }) {
		const current = requireCurrentSession(state);
		const sessionId = requireSessionId(route.params.sessionId);
		const match = sessionRows(database, current.userId).find(row => sessionIdFor(row.token) === sessionId);
		if (!match) {
			throw new WorkspaceError(404, accountSecurityErrorCodes.sessionNotFound);
		}
		deleteSession(database, match.token);
		database.prepare('DELETE FROM account_session_label WHERE session_id = ?').run(sessionId);
		const revokedCurrent = match.token === current.token;
		return {
			body: { ok: true, revoked: true, current: revokedCurrent },
			clearSessionCookie: revokedCurrent,
		};
	}

	async function handle({ ctx, state, route, nowMs = Date.now() }) {
		switch (route.action) {
			case 'verify-totp':
				return verifyTotp({ ctx, state, nowMs });
			case 'verify-recovery-code':
				return verifyRecoveryCode({ ctx, state, nowMs });
			case 'enroll':
				return enroll({ ctx, state });
			case 'confirm-enrollment':
				return confirmEnrollment({ ctx, state, nowMs });
			case 'disable':
				return disable({ ctx, state, nowMs });
			case 'regenerate-recovery-codes':
				return regenerateRecoveryCodes({ ctx, state, nowMs });
			case 'change-password':
				return changePassword({ ctx, state, nowMs });
			case 'list-sessions':
				return listSessions({ ctx, state, nowMs });
			case 'label-session':
				return labelSession({ ctx, state, route, nowMs });
			case 'revoke-session':
				return revokeSession({ ctx, state, route });
			default:
				throw new WorkspaceError(404, 'NotFound');
		}
	}

	return {
		handle,
		config: Object.freeze({ idleSeconds: idle, routes: accountSecurityRoutes }),
		// Exposed for tests and for the gateway's logout path.
		clearChallenge(identifier) {
			if (typeof identifier !== 'string') {
				return;
			}
			database.prepare('DELETE FROM verification WHERE identifier IN (?, ?)').run(identifier, '2fa-attempts-' + identifier);
		},
		touchSession: token => touchSession(database, token, Date.now()),
	};
}

export const accountSecurityRuntimeFacts = Object.freeze({
	totpAlgorithm: totpParameters.algorithm,
	sessionCookieName,
	challengeCookieName,
	bodyLimitBytes,
	secondaryFactorRequiredToUnbind: true,
});

export { consumeRecoveryCode, matchRecoveryCode, challengePolicy };
