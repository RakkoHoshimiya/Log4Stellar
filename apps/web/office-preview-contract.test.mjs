import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	attemptObjectKey,
	convertibleFormatOf,
	convertibleExtensions,
	downloadOnlyExtensions,
	extensionOf,
	fileTooLarge,
	isValidPreviewId,
	isValidSourceDigest,
	looksLikePdf,
	makePreviewKey,
	notReady,
	officeConverterPath,
	officePreviewEnabled,
	officePreviewErrorCodes as codes,
	officePreviewLimits,
	officePreviewPath,
	officePreviewStates as states,
	previewCacheControl,
	previewNotFound,
	queueFull,
	renderProfileFingerprint,
	unsupportedFormat,
} from './office-preview-contract.mjs';
import { WorkspaceError } from './workspace-contract.mjs';

// PV01 (format support) and the key/limit rules of §5 live in one pure module, so they
// are pinned here without PostgreSQL, LibreOffice or an HTTP context.

const sha = 'a'.repeat(64);
const fileId = '11111111-1111-4111-8111-111111111111';
const revisionId = '22222222-2222-4222-8222-222222222222';

const source = {
	workspaceId: 'l4s-test-unit',
	fileId,
	revisionId,
	sha256: sha,
	sizeBytes: 1024,
	path: '/docs/report.docx',
};

test('PV01: only the three OOXML formats are convertible', () => {
	assert.deepEqual([...convertibleExtensions.keys()], ['.docx', '.xlsx', '.pptx']);
	assert.equal(convertibleFormatOf('/a/b.docx'), '.docx');
	assert.equal(convertibleFormatOf('/a/b.XLSX'), '.xlsx');
	assert.equal(convertibleFormatOf('/a/b.pptx'), '.pptx');
	// The legacy, macro enabled and ODF families are download only, and every one of
	// them must be recognised as such instead of being attempted and failing later.
	for (const extension of downloadOnlyExtensions) {
		assert.equal(convertibleFormatOf('/a/b' + extension), undefined, extension + ' must stay download only');
	}
	assert.equal(convertibleFormatOf('/a/b.pdf'), undefined);
	assert.equal(convertibleFormatOf('/a/b'), undefined);
	assert.equal(convertibleFormatOf('/a/.docx'), undefined, 'a dotfile has no extension');
});

test('extensionOf keeps only a real trailing extension', () => {
	assert.equal(extensionOf('/a/b/Report.DOCX'), '.docx');
	assert.equal(extensionOf('report.docx'), '.docx');
	assert.equal(extensionOf('/a/b/'), '');
	assert.equal(extensionOf('/a/b.d/report'), '');
	assert.equal(extensionOf(''), '');
});

test('the route prefix is a sibling of the other API mounts, not a file route', () => {
	assert.equal(officePreviewPath, '/api/v1/office-previews');
	assert.ok(!officePreviewPath.startsWith('/static/mount'));
});

test('PILOT limits are the documented defaults and every one is overridable', () => {
	const defaults = officePreviewLimits({});
	assert.equal(defaults.maxInputBytes, 25 * 1024 * 1024);
	assert.equal(defaults.maxOutputBytes, 100 * 1024 * 1024);
	assert.equal(defaults.timeoutMs, 60_000);
	assert.equal(defaults.maxQueued, 20);
	assert.equal(defaults.cacheBytes, 5 * 1024 * 1024 * 1024);
	assert.equal(defaults.maxAttempts, 3);
	assert.equal(defaults.leaseMs, 120_000);

	const tuned = officePreviewLimits({
		LOG4STELLAR_OFFICE_MAX_INPUT_BYTES: '1024',
		LOG4STELLAR_OFFICE_MAX_OUTPUT_BYTES: '2048',
		LOG4STELLAR_OFFICE_TIMEOUT_MS: '1500',
		LOG4STELLAR_OFFICE_MAX_QUEUED: '0',
		LOG4STELLAR_OFFICE_CACHE_BYTES: '4096',
		LOG4STELLAR_OFFICE_MAX_ATTEMPTS: '1',
		LOG4STELLAR_OFFICE_LEASE_MS: '5000',
	});
	assert.deepEqual(tuned, {
		maxInputBytes: 1024,
		maxOutputBytes: 2048,
		timeoutMs: 1500,
		maxQueued: 0,
		cacheBytes: 4096,
		maxAttempts: 1,
		leaseMs: 5000,
	});

	// A garbage or out of range value falls back instead of disabling a guard: a typo
	// in the deployment must not turn the input limit into `NaN`.
	assert.equal(officePreviewLimits({ LOG4STELLAR_OFFICE_MAX_INPUT_BYTES: 'lots' }).maxInputBytes, 25 * 1024 * 1024);
	assert.equal(officePreviewLimits({ LOG4STELLAR_OFFICE_MAX_INPUT_BYTES: '0' }).maxInputBytes, 25 * 1024 * 1024);
	assert.equal(officePreviewLimits({ LOG4STELLAR_OFFICE_LEASE_MS: '-5' }).leaseMs, 120_000);
	assert.equal(officePreviewLimits({ LOG4STELLAR_OFFICE_MAX_QUEUED: '' }).maxQueued, 20);
});

test('the feature flag is off unless explicitly enabled', () => {
	assert.equal(officePreviewEnabled({}), false);
	assert.equal(officePreviewEnabled({ LOG4STELLAR_OFFICE_PREVIEW: '0' }), false);
	assert.equal(officePreviewEnabled({ LOG4STELLAR_OFFICE_PREVIEW: 'yes' }), false);
	assert.equal(officePreviewEnabled({ LOG4STELLAR_OFFICE_PREVIEW: '1' }), true);
	assert.equal(officePreviewEnabled({ LOG4STELLAR_OFFICE_PREVIEW: 'true' }), true);
});

test('the converter path defaults to the system soffice and is overridable', () => {
	assert.equal(officeConverterPath({}), '/usr/bin/soffice');
	assert.equal(officeConverterPath({ LOG4STELLAR_OFFICE_SOFFICE: '/opt/lo/soffice' }), '/opt/lo/soffice');
});

test('the render profile fingerprint changes with the build, fonts and filter', () => {
	const base = renderProfileFingerprint({});
	assert.match(base, /^[0-9a-f]{32}$/);
	// Stable for one deployment: two calls must agree or every request would miss.
	assert.equal(renderProfileFingerprint({}), base);
	assert.notEqual(renderProfileFingerprint({ LOG4STELLAR_OFFICE_SOFFICE_VERSION: 'LibreOffice 25.2' }), base);
	assert.notEqual(renderProfileFingerprint({ LOG4STELLAR_OFFICE_FONTS: 'noto-only' }), base);
	assert.notEqual(renderProfileFingerprint({ LOG4STELLAR_OFFICE_SOFFICE: '/opt/lo/soffice' }), base);
	// It must never depend on the document, which is why it takes only configuration.
	assert.equal(renderProfileFingerprint({}), base);
});

test('the dedupe key is a pure function of the authoritative identity', () => {
	const key = makePreviewKey(source, 'b'.repeat(32));
	assert.match(key, /^[0-9a-f]{64}$/);
	assert.equal(makePreviewKey(source, 'b'.repeat(32)), key);

	// Every input moves the key, so two documents can never share a cache entry.
	const variants = [
		{ ...source, workspaceId: 'l4s-test-other' },
		{ ...source, fileId: '33333333-3333-4333-8333-333333333333' },
		{ ...source, revisionId: '44444444-4444-4444-8444-444444444444' },
		{ ...source, sha256: 'c'.repeat(64) },
	];
	for (const variant of variants) {
		assert.notEqual(makePreviewKey(variant, 'b'.repeat(32)), key);
	}
	assert.notEqual(makePreviewKey(source, 'd'.repeat(32)), key);

	// A missing or malformed identity is a client error, never a silent shared key.
	const rejectsAsInvalid = variant => {
		assert.throws(() => makePreviewKey(variant, 'b'.repeat(32)), { name: 'Error', code: 'InvalidRequest' });
	};
	rejectsAsInvalid({ ...source, sha256: 'short' });
	rejectsAsInvalid({ ...source, sha256: undefined });
	rejectsAsInvalid({ ...source, fileId: undefined });
	rejectsAsInvalid({ ...source, revisionId: undefined });
	rejectsAsInvalid({ ...source, workspaceId: '' });
});

test('the object key is attempt specific and scoped to the preview prefix', () => {
	const key = makePreviewKey(source, 'b'.repeat(32));
	const attemptA = '55555555-5555-4555-8555-555555555555';
	const attemptB = '66666666-6666-4666-8666-666666666666';
	assert.equal(attemptObjectKey(key, attemptA), `office-previews/${key.slice(0, 2)}/${key}/${attemptA}.pdf`);
	assert.notEqual(attemptObjectKey(key, attemptA), attemptObjectKey(key, attemptB));
	assert.throws(() => attemptObjectKey('nope', attemptA), { code: 'InvalidRequest' });
	assert.throws(() => attemptObjectKey(key, 'not-a-uuid'), { code: 'InvalidRequest' });
});

test('identifiers are validated strictly', () => {
	assert.equal(isValidPreviewId('AB12CD34-AB12-4AB1-8AB1-AB12CD34AB12'), true);
	assert.equal(isValidPreviewId('11111111-1111-4111-8111-111111111111'), true);
	assert.equal(isValidPreviewId('11111111-1111-4111-8111'), false);
	assert.equal(isValidPreviewId('../../etc/passwd'), false);
	assert.equal(isValidPreviewId(undefined), false);
	assert.equal(isValidSourceDigest(sha), true);
	assert.equal(isValidSourceDigest(sha.toUpperCase()), false);
	assert.equal(isValidSourceDigest(sha.slice(1)), false);
});

test('looksLikePdf requires the magic bytes and a size inside the budget', () => {
	assert.equal(looksLikePdf(Buffer.from('%PDF-1.7\n'), 9, 1000), true);
	assert.equal(looksLikePdf(Buffer.from('%PDF-'), 5, 1000), true);
	assert.equal(looksLikePdf(Buffer.from('%HTM'), 4, 1000), false);
	assert.equal(looksLikePdf(Buffer.from('PK\u0003\u0004binary'), 10, 1000), false);
	assert.equal(looksLikePdf(Buffer.from('%PDF-1.7\n'), 0, 1000), false);
	assert.equal(looksLikePdf(Buffer.from('%PDF-1.7\n'), 1001, 1000), false);
	assert.equal(looksLikePdf('not a buffer', 9, 1000), false);
	assert.equal(looksLikePdf(Buffer.from('%PDF-1.7\n'), Number.NaN, 1000), false);
});

test('§4 error codes map to the documented statuses', () => {
	const cases = [
		[unsupportedFormat, 415, codes.unsupportedFormat],
		[fileTooLarge, 413, codes.fileTooLarge],
		[queueFull, 429, codes.queueFull],
		[notReady, 409, codes.notReady],
		[previewNotFound, 404, codes.notFound],
	];
	for (const [make, status, code] of cases) {
		const error = make();
		assert.ok(error instanceof WorkspaceError);
		assert.equal(error.status, status);
		assert.equal(error.code, code);
	}
	// Content problems are never retryable: a broken file must not be converted again.
	assert.equal(unsupportedFormat().retryable, false);
	assert.equal(fileTooLarge().retryable, false);
});

test('previews are never cached by a shared proxy', () => {
	assert.equal(previewCacheControl, 'private, no-store');
});

test('the state vocabulary is the one the schema check constraint allows', () => {
	assert.deepEqual(Object.values(states).sort(), ['evicted', 'failed', 'queued', 'ready', 'running']);
});
