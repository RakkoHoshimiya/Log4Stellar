/**
 * Tests for the account security contract (apps/web/account-security.mjs).
 *
 * These are pure-function tests: no database, no TLS, no better-auth instance,
 * no network. They run on a bare checkout, which is what lets the contract be
 * reviewed and merged before a single runtime line changes.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
	accountSecurityErrorCodes,
	accountSecurityErrorStatus,
	accountSecurityRoutes,
	accountSecuritySchema,
	accountSecurityMountPath,
	admitTotpStep,
	assertAdditiveMigration,
	authStateRank,
	authStates,
	authSurfaces,
	betterAuthTwoFactorFacts,
	challengeCookieName,
	challengePolicy,
	clampIdleSeconds,
	classifyAuthState,
	consumeRecoveryCode,
	describeSession,
	describeSessions,
	describeUserAgent,
	deviceLabelLimits,
	formatRecoveryCode,
	generateRecoveryCodes,
	idlePolicy,
	isIdleExpired,
	isRecoveryCode,
	isSessionId,
	isTotpCode,
	maskAddress,
	matchRecoveryCode,
	normalizeDeviceLabel,
	normalizeRecoveryCode,
	normalizeTotpCode,
	passwordPolicy,
	planPasswordChangeSessions,
	recoveryCodeDigest,
	recoveryCodeParameters,
	recoveryCodeRotation,
	remainingIdleMs,
	requireIdleSession,
	requireRecoveryCode,
	requireSessionId,
	requireTotpCode,
	securityPaths,
	securityRouteFor,
	sessionDescriptorWithheldFields,
	sessionExpiryAfterSecondFactor,
	sessionIdFor,
	surfaceForPath,
	totpInputLimits,
	totpParameters,
	totpStepFor,
	totpStepWindow,
	trustDeviceCookieName,
	twoFactorNonGoals,
	twoFactorPendingRedirect,
	unknownDeviceLabel,
	validateNewPassword,
	verifySecurityInvariants,
	redirectForAuthState,
	authorizeRequest,
} from './account-security.mjs';
import { WorkspaceError } from './workspace-contract.mjs';

function code(operation) {
	try {
		operation();
	} catch (error) {
		return error;
	}
	return undefined;
}

// --- contract invariants ---------------------------------------------------

test('every error code has exactly one status', () => {
	const codes = Object.keys(accountSecurityErrorCodes);
	const statuses = Object.keys(accountSecurityErrorStatus);
	assert.equal(codes.length, statuses.length);
	for (const name of codes) {
		const value = accountSecurityErrorCodes[name];
		assert.equal(typeof value, 'string');
		assert.equal(typeof accountSecurityErrorStatus[value], 'number', `${name} has no status`);
	}
});

test('every status is a client-error status', () => {
	for (const status of Object.values(accountSecurityErrorStatus)) {
		assert.ok(status >= 400 && status < 600, `${status} is not an error status`);
	}
});

test('verifySecurityInvariants reports no violations', () => {
	assert.deepEqual(verifySecurityInvariants(), []);
});

test('the half-authenticated lifetime is far shorter than the idle window', () => {
	// 600s against 86400s is a factor of 144, far beyond "far shorter".
	assert.ok(challengePolicy.maxHalfAuthLifetimeSeconds * 24 <= idlePolicy.defaultIdleSeconds);
	assert.equal(challengePolicy.maxHalfAuthLifetimeSeconds, 600);
	assert.equal(idlePolicy.defaultIdleSeconds, 86_400);
});

test('trusted-device bypass stays disabled', () => {
	assert.equal(challengePolicy.trustDeviceEnabled, false);
	assert.ok(!twoFactorNonGoals.includes('totp-replay-protection'));
});

test('non-goals name the features this contract does not cover', () => {
	for (const goal of ['sms-otp', 'webauthn', 'passkey', 'organisation-enforced-two-factor']) {
		assert.ok(twoFactorNonGoals.includes(goal), `${goal} should be a stated non-goal`);
	}
});

test('schema module only creates, never drops', () => {
	for (const statement of [...accountSecuritySchema.ownTables, ...accountSecuritySchema.ownIndexes]) {
		assert.doesNotThrow(() => assertAdditiveMigration(statement));
	}
	assert.deepEqual(accountSecuritySchema.ownColumns, []);
});

test('assertAdditiveMigration rejects destructive statements', () => {
	for (const statement of [
		'DROP TABLE account_totp_replay',
		'drop index account_totp_replay_updated_idx',
		'ALTER TABLE user DROP COLUMN twoFactorEnabled',
		'ALTER TABLE twoFactor RENAME COLUMN secret TO seed',
	]) {
		const error = code(() => assertAdditiveMigration(statement));
		assert.ok(error instanceof WorkspaceError, `${statement} should be rejected`);
		assert.equal(error.code, 'DestructiveMigration');
	}
});

test('assertAdditiveMigration rejects non-strings', () => {
	assert.throws(() => assertAdditiveMigration(undefined), TypeError);
	assert.throws(() => assertAdditiveMigration('   '), TypeError);
});

test('better-auth facts match the numbers the contract reasons about', () => {
	assert.equal(betterAuthTwoFactorFacts.replayProtection, false, 'the plugin must still lack replay protection for this contract to be needed');
	assert.equal(betterAuthTwoFactorFacts.constantTimeBackupCodeCompare, false);
	assert.equal(betterAuthTwoFactorFacts.listSessionsReturnsToken, true);
	assert.equal(totpParameters.digits, betterAuthTwoFactorFacts.totpDigits);
	assert.equal(totpParameters.periodSeconds, betterAuthTwoFactorFacts.totpPeriodSeconds);
	assert.equal(challengePolicy.cookieMaxAgeSeconds, betterAuthTwoFactorFacts.twoFactorCookieMaxAgeSeconds);
});

// --- cookie names ----------------------------------------------------------

test('challenge cookie name matches better-auth secure prefixing', () => {
	assert.equal(challengeCookieName(), '__Secure-better-auth.two_factor');
	assert.equal(challengeCookieName({ secure: false }), 'better-auth.two_factor');
	assert.equal(challengeCookieName({ cookiePrefix: 'custom' }), '__Secure-custom.two_factor');
	assert.throws(() => challengeCookieName({ cookiePrefix: '' }), TypeError);
});

test('trust device cookie name is derived but the feature is off', () => {
	assert.equal(trustDeviceCookieName(), '__Secure-better-auth.trust_device');
	assert.equal(challengePolicy.trustDeviceEnabled, false);
});

// --- TOTP input ------------------------------------------------------------

test('normalizeTotpCode accepts exactly six digits', () => {
	assert.equal(normalizeTotpCode('123456'), '123456');
	assert.equal(normalizeTotpCode('  123456  '), '123456');
	assert.equal(normalizeTotpCode('000000'), '000000');
	assert.equal(requireTotpCode('987654'), '987654');
});

test('normalizeTotpCode rejects ambiguous or malformed input', () => {
	for (const value of ['12345', '1234567', '123 456', '123-456', '12 34 56', '12345a', 'abcdef', '', '   ', '１２３４５６', '123\n456', '+12345', '1e3456', ' 12345 ']) {
		const error = code(() => normalizeTotpCode(value));
		assert.ok(error instanceof WorkspaceError, `expected rejection for ${JSON.stringify(value)}`);
		assert.equal(error.code, accountSecurityErrorCodes.invalidTotpInput);
		assert.equal(error.status, 400);
	}
});

test('normalizeTotpCode rejects non-strings instead of coercing', () => {
	for (const value of [123456, null, undefined, {}, ['123456']]) {
		assert.throws(() => normalizeTotpCode(value), WorkspaceError);
	}
});

test('isTotpCode never throws', () => {
	assert.equal(isTotpCode('123456'), true);
	assert.equal(isTotpCode('12345'), false);
	assert.equal(isTotpCode(123456), false);
	assert.equal(isTotpCode(null), false);
});

test('a code is never longer than the documented bound', () => {
	assert.equal(totpInputLimits.minLength, totpParameters.digits);
	assert.equal(totpInputLimits.maxLength, totpParameters.digits);
});

// --- TOTP time steps -------------------------------------------------------

test('totpStepFor divides the epoch into thirty second buckets', () => {
	assert.equal(totpStepFor(0), 0);
	assert.equal(totpStepFor(29_999), 0);
	assert.equal(totpStepFor(30_000), 1);
	assert.equal(totpStepFor(59_999), 1);
	assert.equal(totpStepFor(1_700_000_000_000), Math.floor(1_700_000_000_000 / 30_000));
});

test('totpStepFor rejects nonsense input', () => {
	assert.throws(() => totpStepFor(-1), RangeError);
	assert.throws(() => totpStepFor(Number.NaN), RangeError);
	assert.throws(() => totpStepFor(Infinity), RangeError);
	assert.throws(() => totpStepFor(1000, { periodSeconds: 0 }), RangeError);
	assert.throws(() => totpStepFor(1000, { periodSeconds: 1.5 }), RangeError);
});

test('totpStepWindow is the documented +/- one step band', () => {
	assert.deepEqual(totpStepWindow(100), [99, 100, 101]);
	assert.deepEqual(totpStepWindow(1), [0, 1, 2]);
	assert.deepEqual(totpStepWindow(0), [0, 1], 'the window never goes negative');
	assert.deepEqual(totpStepWindow(100, { backward: 0, forward: 0 }), [100]);
	assert.equal(totpParameters.windowBackwardSteps, 1);
	assert.equal(totpParameters.windowForwardSteps, 1);
});

test('totpStepWindow rejects nonsense input', () => {
	assert.throws(() => totpStepWindow(-1), RangeError);
	assert.throws(() => totpStepWindow(1.5), RangeError);
	assert.throws(() => totpStepWindow(5, { backward: -1 }), RangeError);
});

// --- TOTP replay guard (the critical rule) ---------------------------------

test('a fresh step is admitted and becomes the spent step', () => {
	const result = admitTotpStep({ lastUsedStep: 10, step: 11, nowMs: 11 * 30_000 });
	assert.equal(result.accepted, true);
	assert.equal(result.lastUsedStep, 11);
	assert.equal(result.currentStep, 11);
	assert.deepEqual(result.window, [10, 11, 12]);
});

test('reusing the exact same step is refused as a replay', () => {
	const error = code(() => admitTotpStep({ lastUsedStep: 11, step: 11, nowMs: 11 * 30_000 }));
	assert.ok(error instanceof WorkspaceError);
	assert.equal(error.code, accountSecurityErrorCodes.totpCodeReplayed);
	assert.equal(error.status, 401);
});

test('an older step is refused as a replay even inside the acceptance window', () => {
	// Step 10 is inside the +/-1 window of step 11 but was already spent.
	const error = code(() => admitTotpStep({ lastUsedStep: 11, step: 10, nowMs: 11 * 30_000 }));
	assert.equal(error.code, accountSecurityErrorCodes.totpCodeReplayed);
});

test('the same code is accepted once and refused immediately afterwards', () => {
	const nowMs = 1_700_000_000_000;
	const step = totpStepFor(nowMs);
	const first = admitTotpStep({ lastUsedStep: undefined, step, nowMs });
	assert.equal(first.accepted, true);
	const second = code(() => admitTotpStep({ lastUsedStep: first.lastUsedStep, step, nowMs }));
	assert.equal(second.code, accountSecurityErrorCodes.totpCodeReplayed);
});

test('a step outside the window is an invalid code, not a replay', () => {
	const error = code(() => admitTotpStep({ lastUsedStep: undefined, step: 9, nowMs: 11 * 30_000 }));
	assert.equal(error.code, accountSecurityErrorCodes.invalidTotpCode);
	assert.equal(error.status, 401);
});

test('the forward half of the window is admitted for clock drift', () => {
	// A phone a few seconds ahead legitimately produces step+1.
	assert.equal(admitTotpStep({ lastUsedStep: undefined, step: 12, nowMs: 11 * 30_000 }).accepted, true);
});

test('steps beyond the forward window are refused even with no history', () => {
	const error = code(() => admitTotpStep({ lastUsedStep: undefined, step: 13, nowMs: 11 * 30_000 }));
	assert.equal(error.code, accountSecurityErrorCodes.invalidTotpCode);
	assert.equal(error.status, 401);
});

test('a clock that jumps backwards cannot resurrect a spent step', () => {
	const spent = 100;
	const error = code(() => admitTotpStep({ lastUsedStep: spent, step: 99, nowMs: 100 * 30_000 }));
	assert.equal(error.code, accountSecurityErrorCodes.totpCodeReplayed);
});

test('admitTotpStep rejects a malformed stored step instead of guessing', () => {
	assert.throws(() => admitTotpStep({ lastUsedStep: 'five', step: 5 }), RangeError);
	assert.throws(() => admitTotpStep({ lastUsedStep: -1, step: 5 }), RangeError);
});

test('clock-window boundaries are inclusive at both edges', () => {
	const nowMs = 100 * 30_000;
	// Exactly one step behind and one ahead are both accepted for a fresh account.
	assert.equal(admitTotpStep({ lastUsedStep: undefined, step: 99, nowMs }).accepted, true);
	assert.equal(admitTotpStep({ lastUsedStep: undefined, step: 101, nowMs }).accepted, true);
	// Two steps away is refused on both sides.
	assert.equal(code(() => admitTotpStep({ lastUsedStep: undefined, step: 98, nowMs })).code, accountSecurityErrorCodes.invalidTotpCode);
	assert.equal(code(() => admitTotpStep({ lastUsedStep: undefined, step: 102, nowMs })).code, accountSecurityErrorCodes.invalidTotpCode);
});

// --- recovery codes --------------------------------------------------------

test('formatRecoveryCode groups into XXXXX-XXXXX', () => {
	assert.equal(formatRecoveryCode('ABCDEFGHJK'), 'ABCDE-FGHJK');
	assert.equal(formatRecoveryCode('ABC'), 'ABC');
	assert.equal(formatRecoveryCode(''), '');
	assert.throws(() => formatRecoveryCode(42), TypeError);
});

test('normalizeRecoveryCode folds case, whitespace and the printed hyphen', () => {
	const canonical = 'ABCDE-FGHJK';
	for (const variant of ['ABCDE-FGHJK', 'abcde-fghjk', 'ABCDE FGHJK', 'abcdefghjk', '  ABCDE-FGHJK  ', 'ABCDE--FGHJK', 'ABC DE FG HJ K']) {
		assert.equal(normalizeRecoveryCode(variant), canonical, `variant ${JSON.stringify(variant)}`);
	}
	assert.equal(requireRecoveryCode('abcde fghjk'), canonical);
});

test('normalizeRecoveryCode rejects wrong length and non-alphabet symbols', () => {
	for (const value of ['', 'ABCDE', 'ABCDE-FGHJKL', 'ABCDE-FGHJI', 'ABCDE-FGHJO', 'ABCDE-FGHJL', 'ABCDE-FGHJU', 'ABCDE-FGHJ0', 'ABCDE-FGHJ1', 'x'.repeat(64)]) {
		const error = code(() => normalizeRecoveryCode(value));
		assert.ok(error instanceof WorkspaceError, `expected rejection for ${JSON.stringify(value)}`);
		assert.equal(error.code, accountSecurityErrorCodes.invalidRecoveryCodeInput);
	}
});

test('normalizeRecoveryCode refuses Unicode that would fold onto the alphabet', () => {
	// U+017F LATIN SMALL LETTER LONG S uppercases to "S", which is in the
	// alphabet; the permitted-input screen must reject it first.
	for (const value of ['ABCDE-FGHJſ', 'ıBCDE-FGHJK', 'ABCDE-FGHJＫ']) {
		const error = code(() => normalizeRecoveryCode(value));
		assert.equal(error.code, accountSecurityErrorCodes.invalidRecoveryCodeInput, `expected rejection for ${JSON.stringify(value)}`);
	}
});

test('isRecoveryCode never throws', () => {
	assert.equal(isRecoveryCode('ABCDE-FGHJK'), true);
	assert.equal(isRecoveryCode('nope'), false);
	assert.equal(isRecoveryCode(undefined), false);
});

test('the recovery alphabet excludes every easily confused symbol', () => {
	for (const symbol of ['I', 'L', 'O', 'U', '0', '1']) {
		assert.ok(!recoveryCodeParameters.alphabet.includes(symbol), `${symbol} should not be in the alphabet`);
	}
	assert.equal(recoveryCodeParameters.alphabet.length, 30);
	assert.equal(new Set(recoveryCodeParameters.alphabet).size, recoveryCodeParameters.alphabet.length);
	// 30 symbols x 10 characters is still ~49 bits of entropy.
	assert.ok(Math.log2(recoveryCodeParameters.alphabet.length) * recoveryCodeParameters.length >= 48);
});

test('generated recovery codes are canonical, unique and complete', () => {
	const codes = generateRecoveryCodes();
	assert.equal(codes.length, recoveryCodeParameters.count);
	assert.equal(new Set(codes).size, codes.length);
	for (const entry of codes) {
		assert.equal(normalizeRecoveryCode(entry), entry, 'generated codes must already be canonical');
	}
});

test('generateRecoveryCodes honours the requested count', () => {
	assert.equal(generateRecoveryCodes({ count: 1 }).length, 1);
	assert.equal(generateRecoveryCodes({ count: 16 }).length, 16);
	assert.throws(() => generateRecoveryCodes({ count: 0 }), RangeError);
	assert.throws(() => generateRecoveryCodes({ count: 33 }), RangeError);
	assert.throws(() => generateRecoveryCodes({ count: 1.5 }), RangeError);
});

test('recoveryCodeDigest is stable and case-insensitive on the canonical form', () => {
	const digest = recoveryCodeDigest('ABCDE-FGHJK');
	assert.match(digest, /^[0-9a-f]{64}$/);
	assert.equal(recoveryCodeDigest('abcde fghjk'), digest);
	assert.notEqual(recoveryCodeDigest('ABCDE-FGHJM'), digest);
});

test('matchRecoveryCode finds the code and returns the remainder', () => {
	const codes = ['ABCDE-FGHJK', 'MNPQR-STVWX', 'YZ234-56789'];
	const result = matchRecoveryCode('mnpqr stvwx', codes);
	assert.equal(result.matched, true);
	assert.deepEqual([...result.remaining], ['ABCDE-FGHJK', 'YZ234-56789']);
});

test('matchRecoveryCode reports a miss without removing anything', () => {
	const codes = ['ABCDE-FGHJK', 'MNPQR-STVWX'];
	const result = matchRecoveryCode('ZZZZZ-ZZZZZ', codes);
	assert.equal(result.matched, false);
	assert.deepEqual([...result.remaining], [...codes]);
});

test('a recovery code is single use', () => {
	const codes = generateRecoveryCodes({ count: 3 });
	const chosen = codes[1];
	const first = consumeRecoveryCode(chosen, codes);
	assert.equal(first.matched, true);
	assert.equal([...first.remaining].includes(chosen), false);
	assert.equal(first.remaining.length, 2);
	// Redeeming it against the updated set fails: the code is gone.
	const second = code(() => consumeRecoveryCode(chosen, first.remaining));
	assert.equal(second.code, accountSecurityErrorCodes.invalidRecoveryCode);
});

test('consuming an unknown code is a 401 invalid code', () => {
	const error = code(() => consumeRecoveryCode('ZZZZZ-ZZZZZ', generateRecoveryCodes()));
	assert.equal(error.code, accountSecurityErrorCodes.invalidRecoveryCode);
	assert.equal(error.status, 401);
});

test('consuming from an empty set is a distinct exhausted conflict', () => {
	const error = code(() => consumeRecoveryCode('ABCDE-FGHJK', []));
	assert.equal(error.code, accountSecurityErrorCodes.recoveryCodesExhausted);
	assert.equal(error.status, 409);
});

test('rotation invalidates every previous code', () => {
	assert.equal(recoveryCodeRotation.invalidatesPrevious, true);
	assert.equal(recoveryCodeRotation.requiresPassword, true);
	assert.equal(recoveryCodeRotation.requiresSecondFactor, true);
	assert.equal(recoveryCodeRotation.showsCodesOnce, true);
	const before = generateRecoveryCodes();
	const after = generateRecoveryCodes();
	const overlap = after.filter(entry => before.includes(entry));
	assert.equal(overlap.length, 0);
});

// --- device labels ---------------------------------------------------------

test('normalizeDeviceLabel collapses whitespace and strips control characters', () => {
	assert.equal(normalizeDeviceLabel('  My   laptop  '), 'My laptop');
	assert.equal(normalizeDeviceLabel('laptop\n\tPC'), 'laptop PC');
	assert.equal(normalizeDeviceLabel('a\u0000b'), 'a b');
	assert.equal(normalizeDeviceLabel('x\u202Ey'), 'x y', 'RTL override must not survive into the UI');
	assert.equal(normalizeDeviceLabel(undefined), undefined);
	assert.equal(normalizeDeviceLabel(null), undefined);
});

test('normalizeDeviceLabel enforces length bounds', () => {
	assert.equal(normalizeDeviceLabel('a'.repeat(deviceLabelLimits.maxLength)).length, deviceLabelLimits.maxLength);
	const tooLong = code(() => normalizeDeviceLabel('a'.repeat(deviceLabelLimits.maxLength + 1)));
	assert.equal(tooLong.code, accountSecurityErrorCodes.invalidDeviceLabel);
	const empty = code(() => normalizeDeviceLabel('   '));
	assert.equal(empty.code, accountSecurityErrorCodes.invalidDeviceLabel);
	assert.throws(() => normalizeDeviceLabel(7), WorkspaceError);
});

// --- address masking -------------------------------------------------------

test('maskAddress reduces IPv4 to its /24 network', () => {
	assert.equal(maskAddress('203.0.113.42'), '203.0.113.0/24');
	assert.equal(maskAddress('10.1.2.3'), '10.1.2.0/24');
	assert.equal(maskAddress('::ffff:203.0.113.42'), '203.0.113.0/24');
});

test('maskAddress reduces IPv6 to its /48 network', () => {
	assert.equal(maskAddress('2001:db8:abcd:1::5'), '2001:db8:abcd::/48');
	assert.equal(maskAddress('fe80::1'), 'fe80:0:0::/48');
	assert.equal(maskAddress('::1'), '0:0:0::/48');
	assert.equal(maskAddress('2001:db8:abcd:1:2:3:4:5'), '2001:db8:abcd::/48');
});

test('maskAddress refuses to echo anything it cannot parse', () => {
	for (const value of [undefined, null, '', 'not-an-address', '999.1.2.3']) {
		assert.equal(maskAddress(value), null, `expected null for ${JSON.stringify(value)}`);
	}
});

// --- session identifiers ---------------------------------------------------

test('sessionIdFor is a stable one-way identifier', () => {
	const id = sessionIdFor('some-session-token');
	assert.match(id, /^[A-Za-z0-9_-]{22}$/);
	assert.equal(sessionIdFor('some-session-token'), id);
	assert.notEqual(sessionIdFor('another-session-token'), id);
	assert.equal(isSessionId(id), true);
	assert.equal(requireSessionId(id), id);
	// The digest must not contain the token itself.
	assert.equal(id.includes('some-session-token'), false);
});

test('sessionIdFor refuses missing or absurd tokens', () => {
	for (const value of ['', 'x'.repeat(513), 42, null, undefined]) {
		assert.throws(() => sessionIdFor(value), WorkspaceError);
	}
});

test('isSessionId rejects malformed identifiers', () => {
	for (const value of ['', 'short', 'x'.repeat(23), 'x'.repeat(21), 'has space here!!!!!!!!', 42, null]) {
		assert.equal(isSessionId(value), false, `expected false for ${JSON.stringify(value)}`);
	}
	const error = code(() => requireSessionId('bad'));
	assert.equal(error.code, accountSecurityErrorCodes.invalidSessionId);
	assert.equal(error.status, 400);
});

// --- user agent description ------------------------------------------------

test('describeUserAgent recognises the common desktop browsers', () => {
	const chrome = describeUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36');
	assert.equal(chrome.browser, 'Chrome');
	assert.equal(chrome.browserVersion, '141');
	assert.equal(chrome.platform, 'Windows');
	assert.equal(chrome.label, 'Windows · Chrome');

	const firefox = describeUserAgent('Mozilla/5.0 (X11; Linux x86_64; rv:148.0) Gecko/20100101 Firefox/148.0');
	assert.equal(firefox.browser, 'Firefox');
	assert.equal(firefox.platform, 'Linux');
});

test('describeUserAgent prefers Edge over Chrome for the same string', () => {
	const edge = describeUserAgent('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0');
	assert.equal(edge.browser, 'Edge');
	assert.equal(edge.browserVersion, '141');
});

test('describeUserAgent recognises Safari only by its Version token', () => {
	const safari = describeUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15');
	assert.equal(safari.browser, 'Safari');
	assert.equal(safari.platform, 'macOS');
});

test('describeUserAgent falls back to an unknown label', () => {
	const unknown = describeUserAgent('something-weird/1.0');
	assert.equal(unknown.label, unknownDeviceLabel);
	assert.equal(unknown.browser, undefined);
	assert.equal(unknown.platform, undefined);
	assert.equal(describeUserAgent(undefined).label, unknownDeviceLabel);
	assert.equal(describeUserAgent('').label, unknownDeviceLabel);
});

test('describeUserAgent never echoes attacker-controlled markup', () => {
	const hostile = describeUserAgent('Mozilla/5.0 (Windows NT 10.0) <script>alert(1)</script> Chrome/141.0.0.0');
	assert.equal(hostile.label, 'Windows · Chrome');
	assert.equal(hostile.label.includes('<script>'), false);
	assert.equal(describeUserAgent('<img src=x onerror=alert(1)>').label, unknownDeviceLabel);
});

test('describeUserAgent truncates oversized input', () => {
	const noisy = `${'A'.repeat(4000)} Chrome/141.0.0.0`;
	const described = describeUserAgent(noisy);
	assert.equal(described.label, unknownDeviceLabel, 'a pasted blob longer than the cap is not parsed');
});

// --- session descriptors ---------------------------------------------------

const sampleSession = Object.freeze({
	token: 'current-token-value',
	userId: 'user-1',
	ipAddress: '203.0.113.42',
	userAgent: 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
	createdAt: new Date('2026-11-20T10:00:00Z'),
	updatedAt: new Date('2026-11-22T09:00:00Z'),
	expiresAt: new Date('2026-11-23T09:00:00Z'),
});

test('describeSession exposes only the allowlisted fields', () => {
	const nowMs = Date.parse('2026-11-22T12:00:00Z');
	const descriptor = describeSession(sampleSession, { currentToken: 'current-token-value', nowMs });
	assert.equal(descriptor.id, sessionIdFor('current-token-value'));
	assert.equal(descriptor.current, true);
	assert.equal(descriptor.device, 'Windows · Chrome');
	assert.equal(descriptor.browser, 'Chrome');
	assert.equal(descriptor.platform, 'Windows');
	assert.equal(descriptor.createdAtMs, Date.parse('2026-11-20T10:00:00Z'));
	assert.equal(descriptor.lastActiveMs, Date.parse('2026-11-22T09:00:00Z'));
	assert.equal(descriptor.expiresInMs, Date.parse('2026-11-23T09:00:00Z') - nowMs);
	assert.equal(Object.hasOwn(descriptor, 'network'), false, 'the network label is opt-in');
});

test('describeSession never leaks the secret fields', () => {
	const descriptor = describeSession(sampleSession, { currentToken: 'current-token-value', includeNetwork: true });
	const serialised = JSON.stringify(descriptor);
	for (const field of sessionDescriptorWithheldFields) {
		assert.equal(Object.hasOwn(descriptor, field), false, `${field} must not be a descriptor key`);
	}
	assert.equal(serialised.includes('current-token-value'), false, 'the token must not appear anywhere');
	assert.equal(serialised.includes('Mozilla/5.0'), false, 'the raw user agent must not appear');
	assert.equal(serialised.includes('203.0.113.42'), false, 'the full address must not appear');
	assert.equal(descriptor.network, '203.0.113.0/24');
});

test('describeSession marks foreign sessions as not current', () => {
	const descriptor = describeSession(sampleSession, { currentToken: 'a-different-token' });
	assert.equal(descriptor.current, false);
	assert.equal(describeSession(sampleSession).current, false);
});

test('describeSession prefers a user-chosen label when one is valid', () => {
	const id = sessionIdFor('current-token-value');
	const descriptor = describeSession(sampleSession, { currentToken: 'current-token-value', labels: { [id]: '  我的   台式机 ' } });
	assert.equal(descriptor.device, '我的 台式机');
	// An invalid label must fall back to the derived one instead of throwing.
	const fallback = describeSession(sampleSession, { currentToken: 'current-token-value', labels: { [id]: '\u0000'.repeat(3) } });
	assert.equal(fallback.device, 'Windows · Chrome');
});

test('describeSession tolerates string timestamps and missing fields', () => {
	const descriptor = describeSession({ token: 'abc', expiresAt: '2026-11-23T09:00:00Z' }, { nowMs: Date.parse('2026-11-22T09:00:00Z') });
	assert.equal(descriptor.createdAtMs, 0);
	assert.equal(descriptor.lastActiveMs, 0);
	assert.equal(descriptor.device, unknownDeviceLabel);
	assert.equal(descriptor.expiresInMs, 24 * 60 * 60 * 1000);
});

test('describeSession rejects a missing row instead of inventing one', () => {
	assert.throws(() => describeSession(undefined), TypeError);
	assert.throws(() => describeSession('token'), TypeError);
});

test('describeSessions puts the current device first then newest activity', () => {
	const sessions = [
		{ token: 'token-a', updatedAt: new Date('2026-11-21T09:00:00Z'), expiresAt: new Date('2026-11-24T09:00:00Z') },
		{ token: 'token-current', updatedAt: new Date('2026-11-20T09:00:00Z'), expiresAt: new Date('2026-11-24T09:00:00Z') },
		{ token: 'token-b', updatedAt: new Date('2026-11-22T09:00:00Z'), expiresAt: new Date('2026-11-24T09:00:00Z') },
	];
	const described = describeSessions(sessions, { currentToken: 'token-current', nowMs: Date.parse('2026-11-22T12:00:00Z') });
	assert.equal(described.length, 3);
	assert.equal(described[0].current, true);
	assert.equal(described[1].lastActiveMs, Date.parse('2026-11-22T09:00:00Z'));
	assert.equal(described[2].lastActiveMs, Date.parse('2026-11-21T09:00:00Z'));
	assert.throws(() => describeSessions('nope'), TypeError);
});

// --- authentication state classification -----------------------------------

const liveSession = Object.freeze({
	user: Object.freeze({ id: 'user-1' }),
	session: Object.freeze({ token: 'token', expiresAt: new Date('2026-11-23T09:00:00Z') }),
});
const nowMs = Date.parse('2026-11-22T09:00:00Z');

test('a live session is fully authenticated', () => {
	const result = classifyAuthState({ session: liveSession, nowMs });
	assert.equal(result.state, authStates.full);
	assert.equal(result.authenticated, true);
	assert.equal(result.challengeLive, false);
	assert.equal(result.redirectTo, undefined);
});

test('an expired session is exactly like a missing one', () => {
	for (const session of [undefined, null, {}, { user: { id: 'u' }, session: {} }, { user: { id: 'u' }, session: { expiresAt: new Date('2026-11-22T08:59:59Z') } }]) {
		const result = classifyAuthState({ session, nowMs });
		assert.equal(result.state, authStates.anonymous, `session ${JSON.stringify(session)}`);
		assert.equal(result.redirectTo, securityPaths.login);
	}
});

test('a live challenge without a session is half authenticated', () => {
	const result = classifyAuthState({ session: undefined, challenge: { identifier: '2fa-abc', expiresAtMs: nowMs + 60_000 }, nowMs });
	assert.equal(result.state, authStates.half);
	assert.equal(result.challengeLive, true);
	assert.equal(result.redirectTo, twoFactorPendingRedirect);
	assert.equal(result.attemptsRemaining, challengePolicy.maxAttempts);
});

test('an expired challenge is unauthenticated', () => {
	const result = classifyAuthState({ session: undefined, challenge: { identifier: '2fa-abc', expiresAtMs: nowMs - 1 }, nowMs });
	assert.equal(result.state, authStates.anonymous);
	assert.equal(result.challengeLive, false);
	assert.equal(result.redirectTo, securityPaths.login);
});

test('a challenge without an identifier cannot authenticate anything', () => {
	for (const challenge of [{}, { identifier: '' }, { identifier: 42, expiresAtMs: nowMs + 60_000 }, null]) {
		assert.equal(classifyAuthState({ session: undefined, challenge, nowMs }).state, authStates.anonymous);
	}
});

test('a live session outranks a stale challenge cookie', () => {
	const result = classifyAuthState({ session: liveSession, challenge: { identifier: '2fa-abc', expiresAtMs: nowMs + 60_000 }, nowMs });
	assert.equal(result.state, authStates.full);
	assert.equal(result.challengeLive, false);
});

test('attempts remaining is clamped at zero', () => {
	const result = classifyAuthState({ session: undefined, challenge: { identifier: '2fa-abc', expiresAtMs: nowMs + 60_000, attemptsUsed: 99 }, nowMs });
	assert.equal(result.attemptsRemaining, 0);
});

test('classifyAuthState rejects a nonsense clock', () => {
	assert.throws(() => classifyAuthState({ session: liveSession, nowMs: -1 }), RangeError);
	assert.throws(() => classifyAuthState({ session: liveSession, nowMs: Number.NaN }), RangeError);
});

test('auth state ranks are ordered', () => {
	assert.ok(authStateRank[authStates.anonymous] < authStateRank[authStates.half]);
	assert.ok(authStateRank[authStates.half] < authStateRank[authStates.full]);
});

// --- surfaces and routes ---------------------------------------------------

test('surfaceForPath classifies the gateway paths', () => {
	assert.equal(surfaceForPath('/login'), authSurfaces.challenge);
	assert.equal(surfaceForPath('/session-client.js'), authSurfaces.public);
	assert.equal(surfaceForPath('/static/build/index.js'), authSurfaces.public);
	assert.equal(surfaceForPath('/api/account-security/sessions'), authSurfaces.security);
	assert.equal(surfaceForPath('/static/mount/notes/a.md'), authSurfaces.notes);
	assert.equal(surfaceForPath('/'), authSurfaces.notes);
	assert.equal(surfaceForPath('/api/session'), authSurfaces.notes);
	assert.equal(surfaceForPath('/api/session/activity'), authSurfaces.notes);
	assert.equal(surfaceForPath('/some-future-route'), authSurfaces.notes, 'unknown paths default to the strict surface');
	assert.equal(surfaceForPath(''), authSurfaces.notes);
	assert.equal(surfaceForPath(undefined), authSurfaces.notes);
});

test('security routes are reachable only with the documented method', () => {
	const verify = securityRouteFor('POST', accountSecurityRoutes.verifyTotp);
	assert.equal(verify.action, 'verify-totp');
	assert.equal(verify.requires, authStates.anonymous);
	assert.equal(securityRouteFor('GET', accountSecurityRoutes.verifyTotp), undefined);
	assert.equal(securityRouteFor('POST', `${accountSecurityRoutes.verifyTotp}?x=1`).action, 'verify-totp');
	assert.equal(securityRouteFor('POST', '/api/account-security/unknown'), undefined);
	assert.equal(securityRouteFor(undefined, accountSecurityRoutes.verifyTotp), undefined);
});

test('session sub-routes only match a well-formed identifier', () => {
	const id = sessionIdFor('token');
	assert.equal(securityRouteFor('POST', `/api/account-security/sessions/${id}/revoke`).action, 'revoke-session');
	assert.equal(securityRouteFor('POST', `/api/account-security/sessions/${id}/label`).action, 'label-session');
	assert.equal(securityRouteFor('POST', '/api/account-security/sessions/short/revoke'), undefined);
	assert.equal(securityRouteFor('POST', `/api/account-security/sessions/${id}/delete`), undefined);
});

test('the account security mount path matches the route prefix', () => {
	for (const route of Object.values(accountSecurityRoutes)) {
		assert.ok(route.startsWith(`${accountSecurityMountPath}/`), `${route} should sit under the mount path`);
	}
});

// --- the authorization gate ------------------------------------------------

test('a half-authenticated caller cannot read notes on any surface', () => {
	const half = authStates.half;
	for (const pathname of ['/api/session', '/api/session/activity', '/static/mount/notes/a.md', '/static/mount']) {
		const result = authorizeRequest({ state: half, method: 'GET', pathname });
		assert.equal(result.allow, false, `half-auth must be refused on ${pathname}`);
		assert.equal(result.action, 'challenge');
		assert.equal(result.error, accountSecurityErrorCodes.twoFactorPending);
	}
	// The workbench document is a redirect rather than a 403 so a browser
	// lands on the challenge form instead of a bare error page.
	const workbench = authorizeRequest({ state: half, method: 'GET', pathname: '/' });
	assert.equal(workbench.allow, false);
	assert.equal(workbench.action, 'redirect-challenge');
});

test('a half-authenticated workbench document is redirected, not served', () => {
	const result = authorizeRequest({ state: authStates.half, method: 'GET', pathname: '/' });
	assert.equal(result.allow, false);
	assert.equal(result.status, 303);
	assert.equal(result.location, twoFactorPendingRedirect);
	assert.equal(authorizeRequest({ state: authStates.half, method: 'GET', pathname: '/index.html' }).allow, false);
});

test('a half-authenticated caller cannot reach any full-auth security route', () => {
	for (const [method, route] of [
		['POST', accountSecurityRoutes.changePassword],
		['POST', accountSecurityRoutes.enroll],
		['POST', accountSecurityRoutes.disable],
		['GET', accountSecurityRoutes.listSessions],
		['POST', accountSecurityRoutes.regenerateRecoveryCodes],
	]) {
		const result = authorizeRequest({ state: authStates.half, method, pathname: route });
		assert.equal(result.allow, false, `${method} ${route} must be refused`);
		assert.equal(result.status, 403);
		assert.equal(result.error, accountSecurityErrorCodes.twoFactorPending);
	}
});

test('authorization precedes body validation on a half-authenticated request', () => {
	// A half-auth caller sends garbage to the password route. The gate must
	// answer 403 before any validator sees the payload.
	const gate = authorizeRequest({ state: authStates.half, method: 'POST', pathname: accountSecurityRoutes.changePassword });
	assert.equal(gate.status, 403);
	assert.equal(gate.error, accountSecurityErrorCodes.twoFactorPending);
	assert.notEqual(gate.status, 400);
});

test('the verify routes are reachable while half authenticated', () => {
	assert.equal(authorizeRequest({ state: authStates.half, method: 'POST', pathname: accountSecurityRoutes.verifyTotp }).allow, true);
	assert.equal(authorizeRequest({ state: authStates.half, method: 'POST', pathname: accountSecurityRoutes.verifyRecoveryCode }).allow, true);
	assert.equal(authorizeRequest({ state: authStates.anonymous, method: 'POST', pathname: accountSecurityRoutes.verifyTotp }).allow, true);
});

test('a fully authenticated caller reads notes and uses security routes', () => {
	for (const pathname of ['/', '/api/session', '/static/mount/notes/a.md']) {
		assert.equal(authorizeRequest({ state: authStates.full, method: 'GET', pathname }).allow, true, pathname);
	}
	for (const [method, route] of [
		['POST', accountSecurityRoutes.changePassword],
		['GET', accountSecurityRoutes.listSessions],
		['POST', accountSecurityRoutes.disable],
	]) {
		assert.equal(authorizeRequest({ state: authStates.full, method, pathname: route }).allow, true, route);
	}
});

test('an anonymous caller is redirected from the workbench and refused elsewhere', () => {
	const workbench = authorizeRequest({ state: authStates.anonymous, method: 'GET', pathname: '/' });
	assert.equal(workbench.allow, false);
	assert.equal(workbench.action, 'login');
	const api = authorizeRequest({ state: authStates.anonymous, method: 'GET', pathname: '/api/session' });
	assert.equal(api.allow, false);
	assert.equal(api.status, 401);
	assert.equal(api.error, accountSecurityErrorCodes.challengeRequired);
});

test('anonymous callers still get the public login assets', () => {
	assert.equal(authorizeRequest({ state: authStates.anonymous, method: 'GET', pathname: '/session-client.js' }).allow, true);
	assert.equal(authorizeRequest({ state: authStates.anonymous, method: 'GET', pathname: '/static/build/app.js' }).allow, true);
	assert.equal(authorizeRequest({ state: authStates.anonymous, method: 'GET', pathname: '/login' }).allow, true);
});

test('logout is allowed while half authenticated so a user can abandon the challenge', () => {
	const result = authorizeRequest({ state: authStates.half, method: 'POST', pathname: securityPaths.logout });
	assert.equal(result.allow, true);
	assert.equal(result.action, 'logout');
	assert.equal(authorizeRequest({ state: authStates.anonymous, method: 'POST', pathname: securityPaths.logout }).allow, false);
});

test('an unknown state falls back to anonymous rather than being trusted', () => {
	const result = authorizeRequest({ state: 'superuser', method: 'GET', pathname: '/' });
	assert.equal(result.allow, false);
	assert.equal(result.status, 401);
	const undefinedState = authorizeRequest({ method: 'GET', pathname: '/' });
	assert.equal(undefinedState.allow, false);
});

test('redirectForAuthState names the right destination per state', () => {
	assert.equal(redirectForAuthState(authStates.full), undefined);
	assert.equal(redirectForAuthState(authStates.half), twoFactorPendingRedirect);
	assert.equal(redirectForAuthState(authStates.anonymous), securityPaths.login);
});

test('the half-auth matrix is exhaustive over states and surfaces', () => {
	const cases = [
		[authStates.full, 'GET', '/', true],
		[authStates.full, 'GET', '/api/session', true],
		[authStates.half, 'GET', '/api/session', false],
		[authStates.half, 'GET', '/static/mount/x', false],
		[authStates.anonymous, 'GET', '/api/session', false],
		[authStates.anonymous, 'GET', '/static/mount/x', false],
		[authStates.anonymous, 'GET', '/static/build/x.js', true],
	];
	for (const [state, method, pathname, expected] of cases) {
		assert.equal(authorizeRequest({ state, method, pathname }).allow, expected, `${state} ${method} ${pathname}`);
	}
});

// --- idle expiry -----------------------------------------------------------

test('clampIdleSeconds keeps sane values and rejects the rest', () => {
	assert.equal(clampIdleSeconds(idlePolicy.defaultIdleSeconds), idlePolicy.defaultIdleSeconds);
	assert.equal(clampIdleSeconds(3600), 3600);
	assert.equal(clampIdleSeconds(59), idlePolicy.defaultIdleSeconds);
	assert.equal(clampIdleSeconds(1_000_000_000), idlePolicy.defaultIdleSeconds);
	assert.equal(clampIdleSeconds('3600'), 3600);
	assert.equal(clampIdleSeconds('nonsense'), idlePolicy.defaultIdleSeconds);
	assert.equal(clampIdleSeconds(undefined), idlePolicy.defaultIdleSeconds);
	assert.equal(clampIdleSeconds(1.5), idlePolicy.defaultIdleSeconds);
	assert.equal(clampIdleSeconds(Number.NaN), idlePolicy.defaultIdleSeconds);
});

test('the idle default is still 24 hours', () => {
	assert.equal(idlePolicy.defaultIdleSeconds, 86_400);
	assert.equal(idlePolicy.updateAgeSeconds, 0);
});

test('relative expiry is computed from the second factor, not the password', () => {
	const completedAtMs = Date.parse('2026-11-22T09:00:00Z');
	const firstFactorAtMs = completedAtMs - 120_000;
	const result = sessionExpiryAfterSecondFactor({ completedAtMs });
	assert.equal(result.expiresAtMs, completedAtMs + 24 * 60 * 60 * 1000);
	assert.equal(result.idleSeconds, idlePolicy.defaultIdleSeconds);
	assert.notEqual(result.expiresAtMs, firstFactorAtMs + 24 * 60 * 60 * 1000);
	const custom = sessionExpiryAfterSecondFactor({ completedAtMs, idleSeconds: 3600 });
	assert.equal(custom.expiresAtMs, completedAtMs + 3_600_000);
});

test('sessionExpiryAfterSecondFactor rejects a nonsense clock', () => {
	assert.throws(() => sessionExpiryAfterSecondFactor({ completedAtMs: -1 }), RangeError);
	assert.throws(() => sessionExpiryAfterSecondFactor({ completedAtMs: Number.NaN }), RangeError);
});

test('remainingIdleMs never goes negative and accepts both row shapes', () => {
	const expiresAt = new Date('2026-11-22T10:00:00Z');
	const now = Date.parse('2026-11-22T09:00:00Z');
	assert.equal(remainingIdleMs({ session: { expiresAt } }, now), 3_600_000);
	assert.equal(remainingIdleMs({ expiresAt }, now), 3_600_000);
	assert.equal(remainingIdleMs({ expiresAt }, Date.parse('2026-11-23T00:00:00Z')), 0);
	assert.equal(remainingIdleMs({}, now), 0);
	assert.equal(remainingIdleMs(undefined, now), 0);
});

test('isIdleExpired treats the deadline instant as expired', () => {
	const expiresAt = new Date('2026-11-22T10:00:00Z');
	assert.equal(isIdleExpired({ expiresAt }, Date.parse('2026-11-22T09:59:59Z')), false);
	assert.equal(isIdleExpired({ expiresAt }, Date.parse('2026-11-22T10:00:00Z')), true);
	assert.equal(isIdleExpired({ expiresAt }, Date.parse('2026-11-22T10:00:01Z')), true);
});

test('requireIdleSession throws a 401 for an expired session', () => {
	const expiresAt = new Date('2026-11-22T10:00:00Z');
	assert.doesNotThrow(() => requireIdleSession({ expiresAt }, Date.parse('2026-11-22T09:00:00Z')));
	const error = code(() => requireIdleSession({ expiresAt }, Date.parse('2026-11-22T11:00:00Z')));
	assert.ok(error instanceof WorkspaceError);
	assert.equal(error.code, accountSecurityErrorCodes.sessionExpired);
	assert.equal(error.status, 401);
});

// --- password policy -------------------------------------------------------

test('validateNewPassword enforces the documented bounds without normalising', () => {
	assert.equal(validateNewPassword('  correct horse  '), '  correct horse  ');
	assert.equal(validateNewPassword('a'.repeat(passwordPolicy.minLength)).length, passwordPolicy.minLength);
	assert.equal(validateNewPassword('a'.repeat(passwordPolicy.maxLength)).length, passwordPolicy.maxLength);
});

test('validateNewPassword reports each rejection with its own code', () => {
	const short = code(() => validateNewPassword('short'));
	assert.equal(short.code, accountSecurityErrorCodes.passwordTooShort);
	const long = code(() => validateNewPassword('a'.repeat(passwordPolicy.maxLength + 1)));
	assert.equal(long.code, accountSecurityErrorCodes.passwordTooLong);
	const blank = code(() => validateNewPassword('        '));
	assert.equal(blank.code, accountSecurityErrorCodes.invalidPasswordInput);
	const control = code(() => validateNewPassword('goodpass\u0000word'));
	assert.equal(control.code, accountSecurityErrorCodes.invalidPasswordInput);
	const same = code(() => validateNewPassword('alice1234', { username: 'Alice1234' }));
	assert.equal(same.code, accountSecurityErrorCodes.passwordMatchesUsername);
	assert.throws(() => validateNewPassword(undefined), WorkspaceError);
});

test('password policy revokes other sessions by default', () => {
	assert.equal(passwordPolicy.revokeOtherSessions, true);
	assert.equal(passwordPolicy.requireCurrentPassword, true);
	assert.equal(passwordPolicy.allowSameAsCurrent, false);
});

test('planPasswordChangeSessions keeps the current session and revokes the rest', () => {
	const ids = [sessionIdFor('token-a'), sessionIdFor('token-current'), sessionIdFor('token-b')];
	const plan = planPasswordChangeSessions({ sessions: ids, currentSessionId: ids[1] });
	assert.deepEqual([...plan.revokeIds], [ids[0], ids[2]]);
	assert.deepEqual([...plan.keepIds], [ids[1]]);
});

test('planPasswordChangeSessions can keep everything when asked', () => {
	const ids = [sessionIdFor('token-a'), sessionIdFor('token-b')];
	const plan = planPasswordChangeSessions({ sessions: ids, currentSessionId: ids[0], revokeOtherSessions: false });
	assert.deepEqual([...plan.revokeIds], []);
	assert.equal(plan.keepIds.length, 2);
});

test('planPasswordChangeSessions accepts raw rows and rejects bad identifiers', () => {
	const plan = planPasswordChangeSessions({ sessions: [{ token: 'token-a' }, { token: 'token-b' }], currentSessionId: sessionIdFor('token-a') });
	assert.deepEqual([...plan.revokeIds], [sessionIdFor('token-b')]);
	assert.throws(() => planPasswordChangeSessions({ sessions: ['not-a-session-id'], currentSessionId: 'x' }), WorkspaceError);
	assert.throws(() => planPasswordChangeSessions({ sessions: 'nope' }), TypeError);
});

// --- frozen contract objects ----------------------------------------------

test('the exported constant tables are frozen', () => {
	for (const value of [authStates, authStateRank, totpParameters, totpInputLimits, recoveryCodeParameters, recoveryCodeRotation, deviceLabelLimits, passwordPolicy, challengePolicy, idlePolicy, betterAuthTwoFactorFacts, accountSecurityRoutes, accountSecuritySchema, securityPaths, authSurfaces]) {
		assert.ok(Object.isFrozen(value), 'exported constant tables must be frozen');
	}
});
