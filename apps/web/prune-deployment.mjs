/**
 * Retention CLI for the files this deployment writes.
 *
 * Dry-run by default, exactly like the blob cleanup: an operator reads the plan, then asks
 * for it to be applied. Directory sizes are measured recursively because a release is 535 MiB
 * of files while `stat()` on the directory itself reports 4 KiB — a plan that reported the
 * latter would look like it reclaimed nothing.
 */

import { readdir, stat } from 'node:fs/promises';
import { realpathSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { applyReclaim, planReclaim, renderReclaimTable, summarizeReclaim } from './storage-retention.mjs';
import { describeCapacityBudget, resolveCapacityLimits, renderCapacityTable } from './capacity-limits.mjs';
import { readFileSync } from 'node:fs';

async function treeSize(path) {
	let total = 0;
	let entries;
	try {
		entries = await readdir(path, { withFileTypes: true });
	} catch {
		return (await stat(path)).size;
	}
	for (const entry of entries) {
		const child = join(path, entry.name);
		if (entry.isDirectory()) {
			total += await treeSize(child);
		} else if (entry.isFile()) {
			try {
				total += (await stat(child)).size;
			} catch {
				// A file swept while the plan runs is not an error; the plan is a snapshot.
			}
		}
	}
	return total;
}

async function listChildren(path) {
	try {
		return await readdir(path, { withFileTypes: true });
	} catch {
		return [];
	}
}

/**
 * Collects the entries the policy governs from the real deployment layout.
 *
 * Every root is configurable so this can run against a rehearsal tree; the defaults are the
 * paths this host actually uses.
 */
export async function collectEntries({
	releases = join(homedir(), '.local/share/log4stellar/releases'),
	activeRelease,
	baseline = join(homedir(), 'Log4Stellar/releases-baseline'),
	buildOutputs = [],
	temporary = [],
} = {}) {
	const entries = [];
	const add = async (path, category, active = false) => {
		try {
			const info = await stat(path);
			entries.push({ path, category, bytes: await treeSize(path), modifiedMs: info.mtimeMs, active });
		} catch {
			// Absent roots are simply not part of the plan.
		}
	};
	for (const entry of await listChildren(releases)) {
		if (entry.isDirectory()) {
			const path = join(releases, entry.name);
			await add(path, 'release', path === activeRelease);
		}
	}
	for (const entry of await listChildren(baseline)) {
		if (entry.isFile() && entry.name.endsWith('.log')) {
			await add(join(baseline, entry.name), 'log');
		}
	}
	for (const path of buildOutputs) {
		await add(path, 'build-output');
	}
	for (const path of temporary) {
		await add(path, 'temporary');
	}
	return entries;
}

/** Resolves the release the deployment is currently serving, or undefined when unknowable. */
function currentReleaseTarget(pointer = process.env.LOG4STELLAR_CURRENT_RELEASE ?? join(homedir(), '.config/log4stellar/current-web-release')) {
	try {
		return realpathSync(pointer);
	} catch {
		return undefined;
	}
}

function hostDiskFreeBytes(path = join(homedir(), 'Log4Stellar')) {
	try {
		const stats = statfsSync(path);
		return stats.bavail * stats.bsize;
	} catch {
		return Infinity;
	}
}

function hostMemory() {
	try {
		const meminfo = readFileSync('/proc/meminfo', 'utf8');
		const read = name => Number((meminfo.match(new RegExp(`^${name}:\\s+(\\d+) kB`, 'm')) ?? [])[1] ?? 0) / 1024;
		return {
			availableMb: Math.round(read('MemAvailable')),
			swapTotalMb: Math.round(read('SwapTotal')),
			swapUsedMb: Math.round(read('SwapTotal') - read('SwapFree')),
		};
	} catch {
		return {};
	}
}

async function main() {
	const argv = process.argv.slice(2);
	const json = argv.includes('--json');
	const apply = argv.includes('--apply');
	const limitsOnly = argv.includes('--limits');
	const limits = resolveCapacityLimits(process.env);

	if (limitsOnly) {
		console.log(renderCapacityTable(limits));
		const budget = describeCapacityBudget({ limits, memory: hostMemory(), disk: { availableBytes: hostDiskFreeBytes() } });
		console.log(`\n资源: ${budget.ok ? 'ok' : budget.problems.join('；')}`);
		process.exitCode = budget.ok ? 0 : 1;
		return;
	}

	// The active release defaults to whatever the deployment pointer resolves to. Without this
	// the planner would only know the newest directory, and "newest" is not the same fact as
	// "in use": an operator can activate an older release as a rollback.
	const active = argv.includes('--active') ? argv[argv.indexOf('--active') + 1] : currentReleaseTarget();
	const entries = await collectEntries({
		activeRelease: active,
		buildOutputs: argv.filter((value, index) => argv[index - 1] === '--build-output'),
		temporary: argv.filter((value, index) => argv[index - 1] === '--temporary'),
	});
	const plan = planReclaim({ entries, now: Date.now(), diskFreeBytes: hostDiskFreeBytes() });
	const summary = summarizeReclaim(plan);

	if (json) {
		console.log(JSON.stringify({ plan, summary }, null, 2));
	} else {
		console.log(renderReclaimTable(plan));
		console.log(`\n合计可回收 ${(summary.totalReclaimBytes / 1048576).toFixed(0)} MiB，保留 ${(summary.totalKeepBytes / 1048576).toFixed(0)} MiB`);
		console.log(plan.diskPressure ? '注意：磁盘低于下限，请优先处理上面的可回收项。' : '磁盘高于下限，可按计划处理。');
	}

	if (plan.problems.length > 0) {
		for (const problem of plan.problems) {
			console.error(problem);
		}
		process.exitCode = 1;
		return;
	}
	if (!apply) {
		if (!json) {
			console.log('\n默认是演练。确认无误后加 --apply 才会真的删除。');
		}
		return;
	}
	// `--apply` deletes. It is gated on the disk having been measured: an unmeasurable disk
	// would make `diskPressure` false by accident rather than by evidence.
	const { rm } = await import('node:fs/promises');
	const result = await applyReclaim(plan, { remove: path => rm(path, { recursive: true, force: true }) });
	console.log(`已回收 ${result.removed.length} 项，${(result.bytes / 1048576).toFixed(0)} MiB`);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
	main().catch(error => {
		console.error(error.message);
		process.exitCode = 2;
	});
}
