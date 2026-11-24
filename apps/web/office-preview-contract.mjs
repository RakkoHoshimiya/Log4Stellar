// Constants, validators and error semantics for the Office preview API
// (项目进度跟踪表/大肥鱼工作区/05-Office文件预览.md).
//
// This module is pure: no file system, no database, no child process. Everything a
// request can be rejected for is decided here, before any I/O happens, so the order
// of checks is testable without PostgreSQL or LibreOffice.

import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { WorkspaceError } from './workspace-contract.mjs';

// Sibling of /static/mount, /sync/v1 and /git/v1. It is *not* a workspace file
// route: previews are derived objects with their own lifecycle, so they must never
// be reachable through the mount path (§3, §4).
export const officePreviewPath = '/api/v1/office-previews';

// §3: the first release converts exactly these three OOXML text formats. Legacy
// binary formats (.doc/.xls/.ppt), macro enabled variants and everything else stay
// download-only, which is why they are "unsupported" rather than an error the user
// can retry.
export const convertibleExtensions = new Map([
	['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
	['.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
	['.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
]);

// Explicitly listed so a 415 can say "open the original instead" with certainty
// instead of guessing from the failure of a conversion attempt.
export const downloadOnlyExtensions = [
	'.doc', '.dot', '.xls', '.xlt', '.ppt', '.pot',
	'.docm', '.dotm', '.xlsm', '.xltm', '.pptm', '.potm',
	'.odt', '.ods', '.odp', '.rtf', '.csv',
];

export const officePreviewStates = {
	queued: 'queued',
	running: 'running',
	ready: 'ready',
	failed: 'failed',
	// §5: a ready entry whose derived PDF was removed by the cache budget is kept
	// as a tombstone so the dedupe key still maps to one row. A later request for
	// the same version re-queues it instead of inserting a second job.
	evicted: 'evicted',
};

export const officePreviewErrorCodes = {
	unsupportedFormat: 'UnsupportedFormat',
	fileTooLarge: 'FileTooLarge',
	queueFull: 'PreviewQueueFull',
	notReady: 'PreviewNotReady',
	notFound: 'FileNotFound',
	invalidRequest: 'InvalidRequest',
	invalidContentType: 'InvalidContentType',
	requestTooLarge: 'RequestTooLarge',
	noPermissions: 'NoPermissions',
	// Failure classifications carry an actionable code to the client (§4). They
	// never contain a path, an object key or a command line.
	corruptSource: 'PreviewSourceCorrupt',
	passwordProtected: 'PreviewPasswordProtected',
	timeout: 'PreviewTimeout',
	resourceLimit: 'PreviewResourceLimit',
	unavailable: 'PreviewUnavailable',
};

// §2 startup budget. Every value is an operational setting with the pilot default
// from the task book; nothing is hardcoded into the conversion path.
export function officePreviewLimits(environment = process.env) {
	const number = (name, fallback, minimum) => {
		const raw = environment[name];
		if (raw === undefined || raw === '') {
			return fallback;
		}
		const value = Number(raw);
		return Number.isFinite(value) && value >= minimum ? Math.floor(value) : fallback;
	};
	return {
		maxInputBytes: number('LOG4STELLAR_OFFICE_MAX_INPUT_BYTES', 25 * 1024 * 1024, 1),
		maxOutputBytes: number('LOG4STELLAR_OFFICE_MAX_OUTPUT_BYTES', 100 * 1024 * 1024, 1),
		timeoutMs: number('LOG4STELLAR_OFFICE_TIMEOUT_MS', 60_000, 1),
		maxQueued: number('LOG4STELLAR_OFFICE_MAX_QUEUED', 20, 0),
		cacheBytes: number('LOG4STELLAR_OFFICE_CACHE_BYTES', 5 * 1024 * 1024 * 1024, 0),
		// §5 "临时故障只允许有限次自动重试": a transient failure (worker died, disk
		// full) is retried, a permanent one (corrupt, password protected, too large)
		// is not, so a broken file is never converted in a loop.
		maxAttempts: number('LOG4STELLAR_OFFICE_MAX_ATTEMPTS', 3, 1),
		leaseMs: number('LOG4STELLAR_OFFICE_LEASE_MS', 120_000, 1_000),
	};
}

// §4: the feature flag defaults to off. When it is off the routes behave as if they
// did not exist, so the release can ship the code and enable it per deployment.
export function officePreviewEnabled(environment = process.env) {
	const value = environment.LOG4STELLAR_OFFICE_PREVIEW;
	return value === '1' || value === 'true';
}

/** `soffice` location, overridable for a packaged install with a pinned build. */
export function officeConverterPath(environment = process.env) {
	return environment.LOG4STELLAR_OFFICE_SOFFICE || '/usr/bin/soffice';
}

/**
 * Fingerprint of the conversion environment (§1, §2.4). The render profile is part
 * of the dedupe key, so changing the LibreOffice build, the export filter or the
 * font set must produce new cache entries instead of silently serving a PDF that was
 * paginated by the previous profile. It is derived from configuration only — never
 * from the file — so all requests in one deployment agree.
 */
export function renderProfileFingerprint(environment = process.env) {
	const profile = {
		converter: officeConverterPath(environment),
		version: environment.LOG4STELLAR_OFFICE_SOFFICE_VERSION ?? 'LibreOffice 24.2',
		// CJK fonts decide Office pagination and chart widths, so the declared font
		// set is part of the fingerprint rather than an undocumented dependency.
		fonts: environment.LOG4STELLAR_OFFICE_FONTS ?? 'cjk-default',
		filter: 'pdf:writer_pdf_Export',
	};
	const digest = createHash('sha256').update(JSON.stringify(profile)).digest('hex');
	return digest.slice(0, 32);
}

/** Lowercase extension including the dot, from a workspace path. */
export function extensionOf(path) {
	const name = posix.basename(String(path ?? ''));
	const index = name.lastIndexOf('.');
	return index <= 0 ? '' : name.slice(index).toLowerCase();
}

export function convertibleFormatOf(path) {
	const extension = extensionOf(path);
	return convertibleExtensions.has(extension) ? extension : undefined;
}

export class OfficePreviewError extends WorkspaceError {
	constructor(status, code, { retryable = false } = {}) {
		super(status, code);
		this.retryable = retryable;
	}
}

/** §4 error mapping, in one place so the HTTP layer cannot invent its own. */
export function unsupportedFormat() {
	return new OfficePreviewError(415, officePreviewErrorCodes.unsupportedFormat);
}

export function fileTooLarge() {
	return new OfficePreviewError(413, officePreviewErrorCodes.fileTooLarge);
}

export function queueFull() {
	return new OfficePreviewError(429, officePreviewErrorCodes.queueFull);
}

export function notReady() {
	return new OfficePreviewError(409, officePreviewErrorCodes.notReady);
}

export function previewNotFound() {
	return new OfficePreviewError(404, officePreviewErrorCodes.notFound);
}

export function invalidRequest() {
	return new OfficePreviewError(400, officePreviewErrorCodes.invalidRequest);
}

// A preview identifier is a UUID. It is never an access credential (§4): every read
// re-authorizes the workspace, the file and the exact revision.
const previewIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const digestPattern = /^[0-9a-f]{64}$/;

export function isValidPreviewId(value) {
	return typeof value === 'string' && previewIdPattern.test(value.toLowerCase());
}

export function isValidSourceDigest(value) {
	return typeof value === 'string' && digestPattern.test(value);
}

/**
 * §5 `makePreviewKey(source, renderProfile)`: one cache key per (workspace, file,
 * version, content, profile). `fileId` and `revisionId` come from authoritative
 * metadata, never from the client, and the digest is read from the version row, so
 * two different files can never share a cache entry.
 */
export function makePreviewKey(source, profileFingerprint) {
	if (!source?.workspaceId || !source.fileId || !source.revisionId || !isValidSourceDigest(source.sha256)) {
		throw invalidRequest();
	}
	const material = [
		'log4stellar-office-preview-v1',
		source.workspaceId,
		source.fileId,
		source.revisionId,
		source.sha256,
		profileFingerprint,
	].join('\n');
	return createHash('sha256').update(material).digest('hex');
}

/**
 * Object key for one conversion attempt. It is derived on the server from the key
 * and the attempt id, so a late worker that lost its lease can only ever overwrite
 * its own attempt and never a published result (§3).
 */
export function attemptObjectKey(previewKey, attemptId) {
	if (!isValidSourceDigest(previewKey) || !isValidPreviewId(attemptId)) {
		throw invalidRequest();
	}
	return `office-previews/${previewKey.slice(0, 2)}/${previewKey}/${attemptId}.pdf`;
}

/** True when the bytes really start with a PDF header and fit the output budget. */
export function looksLikePdf(head, size, maxBytes) {
	if (!Buffer.isBuffer(head) || head.length < 5 || head.subarray(0, 5).toString('latin1') !== '%PDF-') {
		return false;
	}
	return Number.isFinite(size) && size > 0 && size <= maxBytes;
}

/** Cache-Control for derived PDFs: private, never cached by a shared proxy (§4). */
export const previewCacheControl = 'private, no-store';
