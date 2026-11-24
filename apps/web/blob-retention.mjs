import { WorkspaceError } from './workspace-contract.mjs';

/**
 * A configuration mistake the operator can fix. It carries a short `code` (which is all
 * the CLI prints, so a misread environment variable can never echo a secret) and a
 * message naming only the variable at fault.
 */
export class BlobGcSettingError extends Error {
	constructor(code, message) {
		super(message);
		this.name = 'BlobGcSettingError';
		this.code = code;
	}
}

/**
 * The retention policy of the object-storage collector (task 06, 存储对象清理).
 *
 * This module is pure: it reads environment variables and returns plain frozen
 * values, so the server, the CLI and the tests all agree on one definition and the
 * policy can be unit-tested without PostgreSQL or an object store.
 *
 * The two rules that matter for safety live here:
 *   1. Physical deletion is opt-in. Unless LOG4STELLAR_BLOB_GC_APPLY is exactly '1'
 *      the collector runs in dry-run mode and never asks the store to delete.
 *   2. An object is only eligible after a grace period counted from the first run
 *      that observed it as unreferenced. A single observation is never enough: a
 *      write that is still committing may look like an orphan for a moment.
 */

const dayMs = 24 * 60 * 60 * 1000;
const minuteMs = 60 * 1000;

export const blobGcRetention = Object.freeze({
	/** How long an unreferenced object must stay unreferenced before it is eligible. */
	graceMs: 7 * dayMs,
	/** How long a writer may hold a write intent before it is presumed dead. */
	intentTtlMs: 15 * minuteMs,
	/** Objects read from the store per inventory page. */
	maxInventoryPage: 1000,
	/** Candidates swept per apply/resume invocation, so a run remains interruptible. */
	maxSweepBatch: 100,
	/** Minimum accepted grace period: a shorter one would defeat the grace period. */
	minGraceMs: 60 * 60 * 1000,
});

/** The scope string of a single-workspace collector run. */
export function workspaceScope(workspaceId) {
	if (typeof workspaceId !== 'string' || !workspaceId.trim()) {
		throw new WorkspaceError(400, 'invalid_workspace');
	}
	return `workspace:${workspaceId}`;
}

/** Extracts the workspace ID from a scope string, or null for a non-workspace scope. */
export function scopeWorkspaceId(scope) {
	if (typeof scope !== 'string' || !scope.startsWith('workspace:')) return null;
	const workspaceId = scope.slice('workspace:'.length);
	return workspaceId || null;
}

function readInteger(environment, name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
	const raw = environment?.[name];
	if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
	if (!/^\d+$/.test(String(raw).trim())) {
		throw new BlobGcSettingError('invalid_blob_gc_setting', `${name} must be a whole number of milliseconds.`);
	}
	const value = Number(String(raw).trim());
	if (!Number.isSafeInteger(value) || value < min || value > max) {
		throw new BlobGcSettingError('blob_gc_setting_out_of_range', `${name} must be between ${min} and ${max}.`);
	}
	return value;
}

/**
 * Whether a run may physically delete objects. The switch is deliberately narrow: an
 * unset, empty, '0', 'true' or any other spelling keeps the collector in dry-run, so a
 * typo can only ever make it *safer*.
 */
export function applyEnabled(environment = {}) {
	return environment?.LOG4STELLAR_BLOB_GC_APPLY === '1';
}

/**
 * Resolves the collector settings.
 *
 * @param {Record<string, string | undefined>} [environment] process environment.
 * @returns {Readonly<{graceMs: number, intentTtlMs: number, maxInventoryPage: number,
 *   maxSweepBatch: number, apply: boolean, recoveryDirectory: string | null,
 *   workspaces: ReadonlyArray<string>}>}
 */
export function resolveBlobGcSettings(environment = {}) {
	const graceMs = readInteger(environment, 'LOG4STELLAR_BLOB_GC_GRACE_MS', blobGcRetention.graceMs, {
		min: blobGcRetention.minGraceMs,
	});
	const intentTtlMs = readInteger(environment, 'LOG4STELLAR_BLOB_GC_INTENT_TTL_MS', blobGcRetention.intentTtlMs, {
		min: minuteMs,
	});
	const maxSweepBatch = readInteger(environment, 'LOG4STELLAR_BLOB_GC_SWEEP_BATCH', blobGcRetention.maxSweepBatch, {
		min: 1,
		max: 10000,
	});
	const apply = applyEnabled(environment);
	const recoveryRaw = environment?.LOG4STELLAR_BLOB_GC_RECOVERY_DIR;
	const recoveryDirectory = typeof recoveryRaw === 'string' && recoveryRaw.trim()
		? recoveryRaw.trim()
		: null;
	// Without a directory for the verified recovery copy an apply run cannot honour
	// "保留经过恢复验证的副本", so refuse rather than delete without a way back.
	if (apply && !recoveryDirectory) {
		throw new BlobGcSettingError('blob_gc_recovery_dir_required',
			'LOG4STELLAR_BLOB_GC_RECOVERY_DIR is required when LOG4STELLAR_BLOB_GC_APPLY=1.');
	}
	const workspacesRaw = environment?.LOG4STELLAR_BLOB_GC_WORKSPACES;
	const workspaces = typeof workspacesRaw === 'string' && workspacesRaw.trim()
		? Object.freeze(workspacesRaw.split(',').map((value) => value.trim()).filter(Boolean))
		: Object.freeze([]);
	return Object.freeze({
		graceMs,
		intentTtlMs,
		maxInventoryPage: blobGcRetention.maxInventoryPage,
		maxSweepBatch,
		apply,
		recoveryDirectory,
		workspaces,
	});
}
