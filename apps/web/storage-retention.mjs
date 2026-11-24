/**
 * Retention policy for the files the deployment itself writes.
 *
 * This module owns build output, release candidates, logs and temporary scratch only.
 * Business objects (attachment blobs, revision rows) belong to the storage cleanup task and
 * are deliberately not modelled here: deleting a user's attachment because a retention rule
 * fired would be data loss, not housekeeping.
 *
 * The rule that matters most is that a plan is never a delete. `planReclaim()` produces
 * decisions with a reason for every entry, and `applyReclaim()` refuses any decision the
 * plan did not mark as reclaimable. Both are pure over an injected filesystem view, so the
 * policy is testable without deleting anything.
 */

const day = 24 * 60 * 60 * 1000;
const mebibyte = 1024 * 1024;

/** Categories this policy governs, and the ones it must never touch. */
export const reclaimCategories = Object.freeze(['release', 'candidate', 'build-output', 'log', 'temporary']);

export const protectedPaths = Object.freeze([
	// The live symlink target is whatever `current-web-release` points at; the policy is
	// given its real path so a release in use can never be planned away.
	'current-web-release',
	// Backups are referenced by the restore runbook and by pruneBackups() in backup-data.
	'backups',
	// The auth database and the signing key are not retention material.
	'auth.sqlite',
	'git-secret',
	'workspace-storage.json',
]);

export const retentionPolicy = Object.freeze({
	/** Releases kept beyond the active one: current + this many predecessors. */
	keepReleases: 2,
	/** Candidate (never activated) releases kept. */
	keepCandidates: 1,
	/** Log files kept per directory, newest first. */
	keepLogs: 12,
	/** Log age after which a file is reclaimable regardless of count. */
	logMaxAgeMs: 30 * day,
	/** Build output directories are pure derived data; any complete one may go. */
	buildOutputMaxAgeMs: 7 * day,
	/** Temporary entries younger than this are assumed to be in use by a running job. */
	temporaryGraceMs: 2 * 60 * 60 * 1000,
	/** Disk floor: below this, only reclaimable entries are listed and the plan says so. */
	diskFloorBytes: 8 * 1024 * mebibyte,
});

/**
 * The decisions a plan can produce.
 *
 * `keep` entries carry `protecting`, the concrete reason a reviewer can check; `reclaim`
 * entries carry `reason` naming the rule that fired. An entry that matches no rule is `keep`
 * with `protecting: 'no rule applies'`, which is the safest default.
 */
export const reclaimReasons = Object.freeze({
	active: 'active',
	newest: 'newest',
	withinGrace: 'within-grace',
	referencedByHistory: 'referenced-by-history',
	noRule: 'no-rule',
	exceededReleaseBudget: 'exceeded-release-budget',
	exceededCandidateBudget: 'exceeded-candidate-budget',
	exceededLogCount: 'exceeded-log-count',
	exceededLogAge: 'exceeded-log-age',
	staleBuildOutput: 'stale-build-output',
	expiredTemporary: 'expired-temporary',
	diskFloor: 'disk-floor',
});

function sortedNewestFirst(entries) {
	return [...entries].sort((left, right) => (right.modifiedMs ?? 0) - (left.modifiedMs ?? 0) || String(left.path).localeCompare(String(right.path)));
}

function isProtected(entry) {
	if (entry.active) {
		return reclaimReasons.active;
	}
	for (const name of protectedPaths) {
		if (String(entry.path).split('/').includes(name)) {
			return reclaimReasons.referencedByHistory;
		}
	}
	return undefined;
}

/**
 * Plans what the deployment may reclaim.
 *
 * Input shape: `{ entries, now, diskFreeBytes, policy }`, where each entry is
 * `{ path, category, bytes, modifiedMs, active? }`. Output is
 * `{ decisions, reclaimable, reclaimableBytes, problems, diskPressure }` — `problems` is
 * non-empty only for entries whose category is not one this policy governs, which is a
 * programming error rather than a judgement call.
 */
export function planReclaim({ entries = [], now = Date.now(), diskFreeBytes = Infinity, policy = retentionPolicy } = {}) {
	const decisions = [];
	const problems = [];

	const byCategory = new Map();
	for (const entry of entries) {
		if (!reclaimCategories.includes(entry.category)) {
			problems.push(`${entry.path} has category ${String(entry.category)}, which this policy does not govern`);
			continue;
		}
		if (!byCategory.has(entry.category)) {
			byCategory.set(entry.category, []);
		}
		byCategory.get(entry.category).push(entry);
	}

	const keep = (entry, protecting) => decisions.push({ path: entry.path, category: entry.category, bytes: entry.bytes ?? 0, decision: 'keep', protecting });
	const reclaim = (entry, reason) => decisions.push({ path: entry.path, category: entry.category, bytes: entry.bytes ?? 0, decision: 'reclaim', reason });

	for (const category of reclaimCategories) {
		const group = sortedNewestFirst(byCategory.get(category) ?? []);
		// Count budgets only exist for categories where "how many" is the question. Build
		// output and temporary files are judged by age instead, and `Infinity` here would have
		// made every entry "kept as newest" and silently disabled the age rules.
		const budget = category === 'release' ? policy.keepReleases
			: category === 'candidate' ? policy.keepCandidates
			: category === 'log' ? policy.keepLogs
			: undefined;
		let kept = 0;
		for (const entry of group) {
			const protectedBy = isProtected(entry);
			if (protectedBy) {
				keep(entry, protectedBy);
				continue;
			}
			const age = now - Number(entry.modifiedMs ?? 0);
			if (category === 'temporary') {
				if (age < policy.temporaryGraceMs) {
					keep(entry, reclaimReasons.withinGrace);
				} else {
					reclaim(entry, reclaimReasons.expiredTemporary);
				}
				continue;
			}
			if (category === 'build-output') {
				// Build output is derived, but only a *complete* stale directory is safe: a
				// half-finished build being swept by a later run would produce a corrupt artefact.
				if (age > policy.buildOutputMaxAgeMs) {
					reclaim(entry, reclaimReasons.staleBuildOutput);
				} else {
					keep(entry, reclaimReasons.withinGrace);
				}
				continue;
			}
			if (budget !== undefined && kept < budget) {
				kept += 1;
				keep(entry, reclaimReasons.newest);
				continue;
			}
			if (category === 'release') {
				reclaim(entry, reclaimReasons.exceededReleaseBudget);
			} else if (category === 'candidate') {
				reclaim(entry, reclaimReasons.exceededCandidateBudget);
			} else if (category === 'log') {
				reclaim(entry, age > policy.logMaxAgeMs ? reclaimReasons.exceededLogAge : reclaimReasons.exceededLogCount);
			} else {
				keep(entry, reclaimReasons.noRule);
			}
		}
	}

	const reclaimable = decisions.filter(entry => entry.decision === 'reclaim');
	return {
		decisions,
		reclaimable,
		reclaimableBytes: reclaimable.reduce((total, entry) => total + entry.bytes, 0),
		problems,
		diskPressure: Number(diskFreeBytes) < policy.diskFloorBytes,
	};
}

/**
 * Applies a plan.
 *
 * Refuses, rather than filters, when a decision the plan labelled `keep` is passed as a
 * removal target: silently dropping it would make an operator believe space had been
 * reclaimed. The planner has to be wrong for this to fire, and that is worth a hard error.
 */
export async function applyReclaim(plan, { remove } = {}) {
	if (typeof remove !== 'function') {
		throw new Error('applyReclaim needs a remove function so the caller owns the filesystem access.');
	}
	const planned = new Map(plan.decisions.map(entry => [entry.path, entry]));
	const removed = [];
	for (const target of plan.reclaimable) {
		const decision = planned.get(target.path);
		if (!decision || decision.decision !== 'reclaim') {
			throw new Error(`The plan does not mark ${target.path} as reclaimable.`);
		}
		await remove(target.path);
		removed.push(target.path);
	}
	return { removed, bytes: removed.reduce((total, path) => total + (planned.get(path)?.bytes ?? 0), 0) };
}

/** Groups a plan for a report, so a reviewer can see one line per category. */
export function summarizeReclaim(plan) {
	const byCategory = {};
	for (const entry of plan.decisions) {
		const bucket = byCategory[entry.category] ?? { keep: 0, reclaim: 0, keepBytes: 0, reclaimBytes: 0 };
		if (entry.decision === 'reclaim') {
			bucket.reclaim += 1;
			bucket.reclaimBytes += entry.bytes;
		} else {
			bucket.keep += 1;
			bucket.keepBytes += entry.bytes;
		}
		byCategory[entry.category] = bucket;
	}
	return {
		byCategory,
		totalReclaimBytes: plan.reclaimableBytes,
		totalKeepBytes: plan.decisions.filter(entry => entry.decision === 'keep').reduce((total, entry) => total + entry.bytes, 0),
		diskPressure: plan.diskPressure,
	};
}

/** Renders a plan as the table the runbook and the documentation quote. */
export function renderReclaimTable(plan) {
	const lines = ['| 类别 | 路径 | 大小 | 决定 | 依据 |', '|---|---|---|---|---|'];
	const order = { reclaim: 0, keep: 1 };
	const rows = [...plan.decisions].sort((left, right) => (order[left.decision] - order[right.decision]) || String(left.path).localeCompare(String(right.path)));
	for (const entry of rows) {
		const size = `${Math.round(entry.bytes / mebibyte)} MiB`;
		const verdict = entry.decision === 'reclaim' ? '回收' : '保留';
		lines.push(`| ${entry.category} | \`${entry.path}\` | ${size} | ${verdict} | ${entry.decision === 'reclaim' ? entry.reason : entry.protecting} |`);
	}
	return lines.join('\n');
}
