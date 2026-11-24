import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import {
	admitRequest,
	capacityEnvironment,
	capacityLimits,
	describeCapacityBudget,
	renderCapacityTable,
	resolveCapacityLimits,
} from './capacity-limits.mjs';
import { assertNotProduction, loadScenarios, parseArguments, sampleScenario, summarizeSamples } from './capacity-load.mjs';
import {
	applyReclaim,
	planReclaim,
	protectedPaths,
	reclaimCategories,
	retentionPolicy,
	summarizeReclaim,
} from './storage-retention.mjs';

const gib = 1024 * 1024 * 1024;
const mib = 1024 * 1024;
const day = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------- capacity limits

test('the defaults match what the deployment actually has to survive', () => {
	// These numbers are quoted in docs/capacity.md, so a change here is a documentation change.
	assert.equal(capacityLimits.uploadBytes, 512 * mib);
	assert.equal(capacityLimits.previewQueueMax, 20);
	assert.equal(capacityLimits.previewMemoryMb, 2048);
	assert.equal(capacityLimits.previewTimeoutMs, 60_000);
	assert.equal(capacityLimits.indexDrainBatch, 25);
	assert.equal(capacityLimits.databasePoolMax, 8);
	assert.equal(capacityLimits.temporaryBytes, 8 * 1024 * mib);
	assert.equal(capacityLimits.clientConcurrency, 16);
});

test('every limit has an environment variable and every variable has a limit', () => {
	// A limit nobody can override is a limit nobody can tune on the host it is wrong for;
	// a variable with no limit is a typo that silently does nothing.
	assert.deepEqual(Object.keys(capacityEnvironment).sort(), [
		'clientConcurrency', 'databasePoolMax', 'indexDrainBatch', 'previewMemoryMb',
		'previewQueueMax', 'previewTimeoutMs', 'temporaryBytes', 'uploadBytes',
	]);
});

test('an absent or empty override keeps the default', () => {
	const limits = resolveCapacityLimits({});
	assert.deepEqual(limits, capacityLimits);
	const partially = resolveCapacityLimits({ LOG4STELLAR_PREVIEW_QUEUE_MAX: '' });
	assert.equal(partially.previewQueueMax, capacityLimits.previewQueueMax);
});

test('a valid override is adopted as a number', () => {
	const limits = resolveCapacityLimits({ LOG4STELLAR_PREVIEW_QUEUE_MAX: '4', LOG4STELLAR_INDEX_DRAIN_BATCH: '5' });
	assert.equal(limits.previewQueueMax, 4);
	assert.equal(limits.indexDrainBatch, 5);
	assert.equal(limits.uploadBytes, capacityLimits.uploadBytes);
});

test('a malformed override fails at start-up instead of being clamped', () => {
	// Clamping hides operator error: `--samples` style typos would otherwise turn into a
	// silently different limit than the one in the runbook.
	assert.throws(() => resolveCapacityLimits({ LOG4STELLAR_PREVIEW_QUEUE_MAX: 'lots' }), /LOG4STELLAR_PREVIEW_QUEUE_MAX must be a positive integer/);
	assert.throws(() => resolveCapacityLimits({ LOG4STELLAR_PREVIEW_QUEUE_MAX: '0' }), /must be a positive integer/);
	assert.throws(() => resolveCapacityLimits({ LOG4STELLAR_PREVIEW_QUEUE_MAX: '-3' }), /must be a positive integer/);
	assert.throws(() => resolveCapacityLimits({ LOG4STELLAR_PREVIEW_QUEUE_MAX: '1.5' }), /must be a positive integer/);
});

test('an override above a hard ceiling is rejected', () => {
	// 4 GiB is more than a third of the host: two concurrent uploads would take it down.
	assert.throws(() => resolveCapacityLimits({ LOG4STELLAR_MAX_UPLOAD_BYTES: String(5 * 1024 * mib) }), /must not exceed 4096 MiB/);
	// The role cannot open more than 10 connections, so a larger pool converts a capacity
	// problem into a connection-refused problem.
	assert.throws(() => resolveCapacityLimits({ LOG4STELLAR_DATABASE_POOL_MAX: '11' }), /must not exceed the role connection limit of 10/);
});

test('an unrelated environment variable is ignored rather than rejected', () => {
	// The real process environment holds dozens of unrelated variables.
	const limits = resolveCapacityLimits({ PATH: '/usr/bin', LOG4STELLAR_WEB_ORIGIN: 'https://example.test' });
	assert.deepEqual(limits, capacityLimits);
});

test('admission names the limit that fired so a 429 can explain itself', () => {
	const denied = admitRequest(capacityLimits, { class: 'preview', queued: capacityLimits.previewQueueMax });
	assert.deepEqual(denied, { admitted: false, limit: 'previewQueueMax', reason: 'PreviewQueueFull' });

	const search = admitRequest(capacityLimits, { class: 'search', inFlight: capacityLimits.searchConcurrency });
	assert.equal(search.admitted, false);
	assert.equal(search.reason, 'SearchBusy');

	const backup = admitRequest(capacityLimits, { class: 'backup', inFlight: 1 });
	assert.deepEqual(backup, { admitted: false, limit: 'backupConcurrency', reason: 'BackupAlreadyRunning' });

	const build = admitRequest(capacityLimits, { class: 'build', inFlight: 1 });
	assert.equal(build.reason, 'BuildAlreadyRunning');
});

test('admission under the limit is granted', () => {
	for (const kind of ['upload', 'preview', 'search', 'backup', 'build']) {
		const result = admitRequest(capacityLimits, { class: kind, inFlight: 0, queued: 0 });
		assert.equal(result.admitted, true, kind);
	}
});

test('an unknown request class is a programming error, not a default allow', () => {
	// Defaulting to "allowed" here would let a new route bypass every cap by typo.
	assert.throws(() => admitRequest(capacityLimits, { class: 'gitt' }), /Unknown request class: gitt/);
});

test('the budget reports each pressure it found', () => {
	const memory = { availableMb: 512, swapTotalMb: 4096, swapUsedMb: 4000 };
	const disk = { availableBytes: 2 * gib };
	const report = describeCapacityBudget({ limits: capacityLimits, memory, disk, temporary: 9 * 1024 * mib });
	assert.equal(report.ok, false);
	assert.equal(report.problems.length, 4);
	assert.match(report.problems[0], /available memory 512 MiB is below the conversion budget of 2048 MiB/);
	assert.match(report.problems[1], /swap is 98% used/);
	assert.match(report.problems[2], /disk has 2048 MiB free but 8192 MiB of scratch is budgeted/);
	assert.match(report.problems[3], /temporary space in use is 9216 MiB/);
});

test('a healthy host has no budget problems and reports headroom', () => {
	const report = describeCapacityBudget({
		limits: capacityLimits,
		memory: { availableMb: 9000, swapTotalMb: 4096, swapUsedMb: 100 },
		disk: { availableBytes: 30 * gib },
		temporary: 0,
	});
	assert.equal(report.ok, true);
	assert.equal(report.headroomMb, 6952);
});

test('swapping at 90% exactly is still acceptable', () => {
	// The threshold is >90, not >=90: the host idles around 24% used and spikes to 97%, so a
	// hard boundary at 90 would refuse conversions during normal load.
	const report = describeCapacityBudget({
		limits: capacityLimits,
		memory: { availableMb: 9000, swapTotalMb: 4096, swapUsedMb: 3686 },
		disk: { availableBytes: 30 * gib },
	});
	assert.equal(report.ok, true);
});

test('the rendered table quotes the same numbers the code enforces', () => {
	const table = renderCapacityTable();
	assert.match(table, /\| 上传大小上限 \| 512 MiB \| `LOG4STELLAR_MAX_UPLOAD_BYTES` \|/);
	assert.match(table, /\| 预览队列上限 \| 20 \|/);
	assert.match(table, /\| 数据库连接上限 \| 8 \|/);
	// The doc quotes `renderCapacityTable()` verbatim, so an override rendered here must show.
	const custom = renderCapacityTable({ ...capacityLimits, previewQueueMax: 3 });
	assert.match(custom, /\| 预览队列上限 \| 3 \|/);
});

// ---------------------------------------------------------------- load sampling

test('percentiles are taken over the sample, not over an assumed distribution', () => {
	const stats = summarizeSamples([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
	assert.equal(stats.count, 10);
	assert.equal(stats.min, 1);
	assert.equal(stats.max, 10);
	assert.equal(stats.p50, 5);
	// ceil(0.95 * 10) - 1 = 9, i.e. the tenth value: p95 of ten samples is the max, and
	// pretending otherwise would report a latency no request actually had.
	assert.equal(stats.p95, 10);
	assert.equal(stats.errors, 0);
});

test('failed requests are counted as errors rather than silently dropped', () => {
	const stats = summarizeSamples([10, Number.NaN, 20]);
	assert.equal(stats.count, 2);
	assert.equal(stats.errors, 1);
	assert.equal(stats.max, 20);
});

test('an all-failed sample reports zeroes instead of NaN', () => {
	const stats = summarizeSamples([Number.NaN, Number.NaN]);
	assert.equal(stats.count, 0);
	assert.equal(stats.mean, 0);
	assert.equal(stats.p95, 0);
	assert.equal(stats.errors, 2);
});

test('every scenario the task book names exists and says whether it needs a session', () => {
	assert.deepEqual(Object.keys(loadScenarios).sort(), ['browse', 'download', 'idle', 'login', 'preview', 'search']);
	assert.equal(loadScenarios.idle.anonymous, true);
	assert.equal(loadScenarios.login.anonymous, true);
	assert.equal(loadScenarios.download.anonymous, false);
	assert.equal(loadScenarios.download.bytes, true);
});

test('an authenticated scenario refuses to run without a cookie', async () => {
	// Sampling `download` anonymously would measure a 401, which looks fast and means nothing.
	await assert.rejects(
		() => sampleScenario({ base: 'https://127.0.0.1:1', scenario: 'download', samples: 1 }),
		/The download scenario needs a session cookie/,
	);
});

test('an unknown scenario is rejected before any request', async () => {
	await assert.rejects(() => sampleScenario({ base: 'https://127.0.0.1:1', scenario: 'gitt', samples: 1 }), /Unknown scenario: gitt/);
});

test('arguments are parsed strictly so a typo cannot measure nothing', () => {
	const parsed = parseArguments(['--base', 'https://127.0.0.1:18990', '--scenario', 'idle', '--samples', '3', '--concurrency', '2']);
	assert.equal(parsed.base, 'https://127.0.0.1:18990');
	assert.equal(parsed.scenario, 'idle');
	assert.equal(parsed.samples, 3);
	assert.equal(parsed.concurrency, 2);
	assert.equal(parsed.allowProduction, false);
});

test('argument parsing rejects what it cannot honour', () => {
	assert.throws(() => parseArguments([]), /Pass --base/);
	assert.throws(() => parseArguments(['--base']), /--base needs a value/);
	assert.throws(() => parseArguments(['--base', 'https://x', '--scenario', 'nope']), /Unknown scenario: nope/);
	assert.throws(() => parseArguments(['--base', 'https://x', '--samples', '0']), /--samples must be a positive integer/);
	assert.throws(() => parseArguments(['--base', 'https://x', '--concurrency', '-1']), /--concurrency must be a positive integer/);
	assert.throws(() => parseArguments(['--base', 'https://x', '--nope', '1']), /Unknown flag: --nope/);
	assert.throws(() => parseArguments(['https://x']), /Unexpected argument/);
});

test('the production hosts are refused unless the operator insists', () => {
	for (const host of ['192.0.2.233', 'notes.example.test']) {
		assert.throws(() => assertNotProduction(`https://${host}:18990`), /is outside loopback/);
		assert.doesNotThrow(() => assertNotProduction(`https://${host}:18990`, { allowProduction: true }));
	}
	// A loopback rehearsal requires no override.
	assert.doesNotThrow(() => assertNotProduction('https://127.0.0.1:19446'));
	assert.doesNotThrow(() => assertNotProduction('http://localhost:18990'));
});

// ---------------------------------------------------------------- retention

test('an active release is never planned away', () => {
	const plan = planReclaim({
		now: 1_000 * day,
		entries: [
			{ path: '/releases/current', category: 'release', bytes: 500 * mib, modifiedMs: 0, active: true },
			{ path: '/releases/old', category: 'release', bytes: 500 * mib, modifiedMs: 900 * day },
		],
	});
	const current = plan.decisions.find(entry => entry.path === '/releases/current');
	assert.equal(current.decision, 'keep');
	assert.equal(current.protecting, 'active');
	assert.deepEqual(plan.reclaimable.map(entry => entry.path), []);
});

test('the release budget keeps the current release plus the configured predecessors', () => {
	const entries = Array.from({ length: 4 }, (unused, index) => ({
		path: `/releases/web-2026112${index}`,
		category: 'release',
		bytes: 535 * mib,
		modifiedMs: index * day,
	})).reverse();
	const plan = planReclaim({ now: 10 * day, entries });
	// Reclaimable entries come out in the planner's traversal order: newest first, so the
	// first entry to lose its budget is the younger of the two.
	assert.deepEqual(plan.reclaimable.map(entry => entry.path), ['/releases/web-20261121', '/releases/web-20261120']);
	assert.equal(plan.reclaimable[0].reason, 'exceeded-release-budget');
	assert.equal(plan.reclaimableBytes, 2 * 535 * mib);
});

test('protected names are kept even when the budget would reclaim them', () => {
	// The auth database and the signing key live in the same tree as the releases on this
	// deployment; a count-based rule must not be able to reach them.
	const plan = planReclaim({
		now: 100 * day,
		entries: protectedPaths.slice(0, 4).map(name => ({ path: `/home/log4stellar/.config/log4stellar/${name}`, category: 'release', bytes: 1024, modifiedMs: 0 })),
	});
	for (const decision of plan.decisions) {
		assert.equal(decision.decision, 'keep');
		assert.equal(decision.protecting, 'referenced-by-history');
	}
});

test('temporary entries inside the grace window are kept', () => {
	// A preview running right now writes into the temporary tree; sweeping it would kill the job.
	const plan = planReclaim({
		now: 10 * day,
		entries: [
			{ path: '/tmp/l4s-preview-now', category: 'temporary', bytes: 10, modifiedMs: 10 * day - 60_000 },
			{ path: '/tmp/l4s-preview-old', category: 'temporary', bytes: 20, modifiedMs: 10 * day - 3 * 60 * 60 * 1000 },
		],
	});
	assert.deepEqual(plan.reclaimable.map(entry => entry.path), ['/tmp/l4s-preview-old']);
	assert.equal(plan.reclaimable[0].reason, 'expired-temporary');
	assert.equal(plan.decisions.find(entry => entry.path === '/tmp/l4s-preview-now').protecting, 'within-grace');
});

test('logs are reclaimed by count first and by age second', () => {
	const entries = Array.from({ length: retentionPolicy.keepLogs + 2 }, (unused, index) => ({
		path: `/logs/build-${index}.log`,
		category: 'log',
		bytes: mib,
		modifiedMs: index * day,
	}));
	const plan = planReclaim({ now: 100 * day, entries });
	assert.equal(plan.reclaimable.length, 2);
	for (const entry of plan.reclaimable) {
		assert.equal(entry.reason, 'exceeded-log-age');
	}
	const recent = planReclaim({
		now: 1 * day,
		entries: Array.from({ length: retentionPolicy.keepLogs + 1 }, (unused, index) => ({
			path: `/logs/x-${index}.log`,
			category: 'log',
			bytes: mib,
			modifiedMs: 0,
		})),
	});
	assert.equal(recent.reclaimable.length, 1);
	assert.equal(recent.reclaimable[0].reason, 'exceeded-log-count');
});

test('a fresh build output directory is kept, a stale one is reclaimable', () => {
	const plan = planReclaim({
		now: 30 * day,
		entries: [
			{ path: '/repo/out', category: 'build-output', bytes: 2 * gib, modifiedMs: 30 * day - day },
			{ path: '/repo/out-build', category: 'build-output', bytes: gib, modifiedMs: 0 },
		],
	});
	assert.deepEqual(plan.reclaimable.map(entry => entry.path), ['/repo/out-build']);
	assert.equal(plan.reclaimable[0].reason, 'stale-build-output');
});

test('an entry of an ungoverned category is a programming error, not a deletion', () => {
	// The storage cleanup task owns business objects. If a caller hands a blob here, the plan
	// must say so rather than quietly deciding whether a user's attachment survives.
	const plan = planReclaim({ entries: [{ path: '/bucket/blob', category: 'attachment', bytes: 10, modifiedMs: 0 }] });
	assert.equal(plan.decisions.length, 0);
	assert.deepEqual(plan.problems, ['/bucket/blob has category attachment, which this policy does not govern']);
	assert.deepEqual(reclaimCategories, ['release', 'candidate', 'build-output', 'log', 'temporary']);
});

test('disk pressure is reported without changing the decisions', () => {
	// Reporting pressure is what makes the plan urgent; inventing extra deletions because the
	// disk is low is how a retention tool destroys data.
	const plan = planReclaim({
		now: 10 * day,
		diskFreeBytes: gib,
		entries: [{ path: '/releases/a', category: 'release', bytes: mib, modifiedMs: 0 }],
	});
	assert.equal(plan.diskPressure, true);
	assert.equal(plan.reclaimable.length, 0);
	assert.equal(plan.decisions[0].decision, 'keep');
});

test('applying a plan removes exactly the reclaimable entries', async () => {
	const plan = planReclaim({
		now: 10 * day,
		entries: [
			{ path: '/releases/keep', category: 'release', bytes: mib, modifiedMs: 9 * day },
			{ path: '/releases/old', category: 'release', bytes: mib, modifiedMs: 1 * day },
			{ path: '/releases/older', category: 'release', bytes: mib, modifiedMs: 0 },
		],
	});
	// keepReleases is 2 and the two entries above tie on mtime, so the tie-break is the path:
	// `/releases/keep` and `/releases/old` fill the budget and `/releases/older` goes.
	const removed = [];
	const result = await applyReclaim(plan, { remove: async path => removed.push(path) });
	assert.deepEqual(removed, ['/releases/older']);
	assert.equal(result.removed.length, 1);
	assert.equal(result.bytes, mib);
});

test('applying a plan refuses a target the plan did not mark reclaimable', async () => {
	// If the caller edits the plan between planning and applying, this must fail loudly:
	// a silent filter would leave the operator believing space was reclaimed.
	const plan = planReclaim({
		now: 10 * day,
		entries: [
			{ path: '/releases/keep', category: 'release', bytes: mib, modifiedMs: 9 * day },
			{ path: '/releases/old', category: 'release', bytes: mib, modifiedMs: 1 * day },
			{ path: '/releases/older', category: 'release', bytes: mib, modifiedMs: 0 },
		],
	});
	const tampered = { ...plan, reclaimable: [...plan.reclaimable, { path: '/releases/current-web-release', bytes: mib }] };
	await assert.rejects(() => applyReclaim(tampered, { remove: async () => {} }), /The plan does not mark \/releases\/current-web-release as reclaimable/);
});

test('applying without a remove function is refused', () => {
	assert.rejects(() => applyReclaim({ decisions: [], reclaimable: [] }, {}), /applyReclaim needs a remove function/);
});

test('the summary groups by category so a reviewer can see where the space went', () => {
	const plan = planReclaim({
		now: 10 * day,
		entries: [
			{ path: '/releases/old', category: 'release', bytes: 2 * mib, modifiedMs: 0 },
			{ path: '/releases/keep', category: 'release', bytes: 3 * mib, modifiedMs: 9 * day },
		],
	});
	const summary = summarizeReclaim(plan);
	// keepReleases is 2, so both of these are inside the budget and the summary must show a
	// pure keep bucket with the byte total summed across entries.
	assert.deepEqual(summary.byCategory.release, { keep: 2, reclaim: 0, keepBytes: 5 * mib, reclaimBytes: 0 });
	assert.equal(summary.totalKeepBytes, 5 * mib);
	assert.equal(summary.diskPressure, false);
});

test('a real directory tree is planned and reclaimed without touching anything else', async () => {
	// The pure tests above use synthetic paths. This one proves the policy works on a tree the
	// filesystem actually produced, which is where ordering and naming bugs show up.
	const root = await mkdtemp(join(tmpdir(), 'l4s-capacity-'));
	after(async () => rm(root, { recursive: true, force: true }));
	for (const name of ['releases', 'logs', 'tmp']) {
		await mkdir(join(root, name), { recursive: true });
	}
	const write = async (relative, bytes, ageMs) => {
		const path = join(root, relative);
		await mkdir(join(path, '..'), { recursive: true });
		await writeFile(path, Buffer.alloc(bytes, 1));
		const when = new Date(Date.now() - ageMs);
		const { utimes } = await import('node:fs/promises');
		await utimes(path, when, when);
		return path;
	};
	const active = await write('releases/web-active', 2048, 20 * day);
	const old = await write('releases/web-old', 2048, 20 * day);
	const recentLog = await write('logs/today.log', 256, 0);
	const staleLog = await write('logs/last-month.log', 256, 40 * day);
	const runningTemp = await write('tmp/preview-running', 128, 60_000);

	const entries = [];
	for (const [path, category] of [[active, 'release'], [old, 'release'], [recentLog, 'log'], [staleLog, 'log'], [runningTemp, 'temporary']]) {
		const info = await stat(path);
		entries.push({ path, category, bytes: info.size, modifiedMs: info.mtimeMs, active: path === active });
	}
	const plan = planReclaim({ now: Date.now(), entries, diskFreeBytes: 30 * gib });
	// Nothing is reclaimable yet: the active release is protected, the second release is inside
	// the budget of two, the recent log is inside the count budget, and the temporary entry is
	// inside its grace window.
	assert.deepEqual(plan.reclaimable.map(entry => entry.path), []);
	assert.deepEqual(plan.problems, []);
	assert.equal(plan.decisions.find(entry => entry.path === active).protecting, 'active');
	assert.equal(plan.decisions.find(entry => entry.path === runningTemp).protecting, 'within-grace');
	// Only one log is over the count budget, and it is also over the age budget.
	assert.equal(plan.decisions.find(entry => entry.path === recentLog).decision, 'keep');

	// Now age the log set past the count budget and confirm the sweep is real.
	const many = [];
	for (let index = 0; index < retentionPolicy.keepLogs + 1; index += 1) {
		many.push(await write(`logs/bulk-${index}.log`, 128, index * 1000));
	}
	const logEntries = await Promise.all(many.map(async path => {
		const info = await stat(path);
		return { path, category: 'log', bytes: info.size, modifiedMs: Date.now() - 40 * day };
	}));
	const logPlan = planReclaim({ now: Date.now(), entries: [...logEntries, { path: staleLog, category: 'log', bytes: 256, modifiedMs: Date.now() - 40 * day }] });
	const removed = [];
	await applyReclaim(logPlan, {
		remove: async path => {
			removed.push(path);
			await rm(path);
		},
	});
	assert.equal(removed.length, logPlan.reclaimable.length);
	for (const path of removed) {
		await assert.rejects(() => stat(path), /ENOENT/);
	}
	await assert.doesNotReject(() => stat(active));
});

// ---------------------------------------------------------------- prune CLI

test('a release directory is measured recursively, not by its own inode', async () => {
	// The bug this pins down: the first ad-hoc retention run reported 0 MiB reclaimable for a
	// 507 MiB release because `stat()` on a directory returns the directory entry itself.
	const { collectEntries } = await import('./prune-deployment.mjs');
	const root = await mkdtemp(join(tmpdir(), 'l4s-prune-'));
	after(async () => rm(root, { recursive: true, force: true }));
	const releases = join(root, 'releases');
	const baseline = join(root, 'baseline');
	await mkdir(join(releases, 'web-active', 'server'), { recursive: true });
	await mkdir(join(releases, 'web-old', 'web'), { recursive: true });
	await mkdir(baseline, { recursive: true });
	await writeFile(join(releases, 'web-active', 'server', 'serve-demo.mjs'), Buffer.alloc(1000, 1));
	await writeFile(join(releases, 'web-old', 'web', 'index.js'), Buffer.alloc(4000, 1));
	await writeFile(join(baseline, 'takeover.log'), Buffer.alloc(64, 1));
	// A directory entry that is neither a release nor a log must be ignored rather than guessed at.
	await writeFile(join(baseline, 'notes.txt'), Buffer.alloc(8, 1));

	const active = join(releases, 'web-active');
	const entries = await collectEntries({ releases, activeRelease: active, baseline });
	const activeEntry = entries.find(entry => entry.path === active);
	assert.equal(activeEntry.category, 'release');
	assert.equal(activeEntry.active, true);
	assert.equal(activeEntry.bytes, 1000, 'the tree size is the sum of the files, not the inode size');
	const oldEntry = entries.find(entry => entry.path === join(releases, 'web-old'));
	assert.equal(oldEntry.active, false);
	assert.equal(oldEntry.bytes, 4000);
	assert.deepEqual(entries.filter(entry => entry.category === 'log').map(entry => entry.path), [join(baseline, 'takeover.log')]);

	const plan = planReclaim({ entries, now: Date.now(), diskFreeBytes: 30 * gib });
	// Two releases with keepReleases 2 and one of them active: nothing to reclaim.
	assert.deepEqual(plan.reclaimable.map(entry => entry.path), []);
	assert.equal(plan.decisions.find(entry => entry.path === active).protecting, 'active');
});

test('a missing root is not an error, it is simply not part of the plan', async () => {
	// The CLI runs on hosts where some roots do not exist yet (no baseline logs, no temporary
	// tree); failing there would make the tool unusable exactly where it is needed.
	const { collectEntries } = await import('./prune-deployment.mjs');
	const entries = await collectEntries({
		releases: '/nonexistent/l4s/releases',
		baseline: '/nonexistent/l4s/baseline',
		buildOutputs: ['/nonexistent/l4s/out'],
		temporary: ['/nonexistent/l4s/tmp'],
	});
	assert.deepEqual(entries, []);
});
