/**
 * Capacity limits for one Web process.
 *
 * Every number here exists because the deployment has already been hurt by not having it.
 * The host is a single 11.6 GiB machine that also runs the build, the backups and the
 * production Web process; an unbounded upload, preview queue or index drain lets one
 * request class starve the others. Concurrency is therefore capped per class, not globally:
 * a large attachment download must not be able to block a login.
 */

const mebibyte = 1024 * 1024;

export const capacityLimits = Object.freeze({
	/** Largest single upload the gateway accepts. Also read from LOG4STELLAR_MAX_UPLOAD_BYTES. */
	uploadBytes: 512 * mebibyte,
	/** Preview jobs allowed to sit queued or running before the route answers 429. */
	previewQueueMax: 20,
	/** Address space the conversion worker may use. LibreOffice measures 217-233 MiB per job. */
	previewMemoryMb: 2048,
	/** Wall clock a single conversion may take before it is killed. */
	previewTimeoutMs: 60_000,
	/** Index jobs drained per search request. Lazy, so it must stay small. */
	indexDrainBatch: 25,
	/** Concurrent search requests one process serves before it starts queueing. */
	searchConcurrency: 8,
	/** PostgreSQL connections one workspace backend may hold. Role limit is 10. */
	databasePoolMax: 8,
	/** Backup runs allowed at once. A second run would double the I/O and the disk peak. */
	backupConcurrency: 1,
	/** Release builds allowed at once. Measured peak is ~4 GiB of heap. */
	buildConcurrency: 1,
	/** Bytes of temporary preview/release scratch the process may use. */
	temporaryBytes: 8 * 1024 * mebibyte,
	/** Requests in flight per client before the gateway starts refusing. */
	clientConcurrency: 16,
});

/** Environment names, so the docs and the code cannot drift. */
export const capacityEnvironment = Object.freeze({
	uploadBytes: 'LOG4STELLAR_MAX_UPLOAD_BYTES',
	previewQueueMax: 'LOG4STELLAR_PREVIEW_QUEUE_MAX',
	previewMemoryMb: 'LOG4STELLAR_PREVIEW_MEMORY_MB',
	previewTimeoutMs: 'LOG4STELLAR_PREVIEW_TIMEOUT_MS',
	indexDrainBatch: 'LOG4STELLAR_INDEX_DRAIN_BATCH',
	databasePoolMax: 'LOG4STELLAR_DATABASE_POOL_MAX',
	temporaryBytes: 'LOG4STELLAR_TEMPORARY_BYTES',
	clientConcurrency: 'LOG4STELLAR_CLIENT_CONCURRENCY',
});

const positiveIntegers = new Set([
	'uploadBytes',
	'previewQueueMax',
	'previewMemoryMb',
	'previewTimeoutMs',
	'indexDrainBatch',
	'searchConcurrency',
	'databasePoolMax',
	'backupConcurrency',
	'buildConcurrency',
	'temporaryBytes',
	'clientConcurrency',
]);

/**
 * Resolves the effective limits.
 *
 * A bad override throws instead of being clamped: an operator who typed
 * `LOG4STELLAR_PREVIEW_QUEUE_MAX=lots` must find out at start-up, not by watching the
 * queue grow. Absent overrides fall back to the defaults.
 */
export function resolveCapacityLimits(environment = {}) {
	const limits = { ...capacityLimits };
	const problems = [];
	for (const [key, name] of Object.entries(capacityEnvironment)) {
		const raw = environment[name];
		if (raw === undefined || raw === '') {
			continue;
		}
		const value = Number(raw);
		if (!positiveIntegers.has(key)) {
			problems.push(`${name} is not a configurable limit`);
			continue;
		}
		if (!Number.isSafeInteger(value) || value <= 0) {
			problems.push(`${name} must be a positive integer`);
			continue;
		}
		limits[key] = value;
	}
	if (limits.uploadBytes > 4 * 1024 * mebibyte) {
		// The storage layer buffers one upload per in-flight request; a 4 GiB ceiling on an
		// 11.6 GiB host would let two requests take the machine down.
		problems.push(`${capacityEnvironment.uploadBytes} must not exceed 4096 MiB`);
	}
	if (limits.databasePoolMax > 10) {
		// The deployment role has rolconnlimit 10. A larger pool cannot be used and only
		// converts a capacity problem into a connection-refused problem.
		problems.push(`${capacityEnvironment.databasePoolMax} must not exceed the role connection limit of 10`);
	}
	if (problems.length > 0) {
		throw new Error(problems.join(' '));
	}
	return Object.freeze(limits);
}

/**
 * Decides whether a request class may proceed.
 *
 * The answer carries the limit that was consulted so a 429 can name it; an operator
 * reading the log should not have to guess which cap fired.
 */
export function admitRequest(limits, { class: kind, inFlight = 0, queued = 0 } = {}) {
	if (kind === 'upload') {
		if (inFlight >= limits.clientConcurrency) {
			return { admitted: false, limit: 'clientConcurrency', reason: 'TooManyRequests' };
		}
		return { admitted: true, limit: 'clientConcurrency' };
	}
	if (kind === 'preview') {
		if (queued + inFlight >= limits.previewQueueMax) {
			return { admitted: false, limit: 'previewQueueMax', reason: 'PreviewQueueFull' };
		}
		return { admitted: true, limit: 'previewQueueMax' };
	}
	if (kind === 'search') {
		if (inFlight >= limits.searchConcurrency) {
			// Search degrades to "try again", never to a partial result: a truncated hit list
			// reads as "no such note" and is worse than a retry.
			return { admitted: false, limit: 'searchConcurrency', reason: 'SearchBusy' };
		}
		return { admitted: true, limit: 'searchConcurrency' };
	}
	if (kind === 'backup' || kind === 'build') {
		const limit = kind === 'backup' ? limits.backupConcurrency : limits.buildConcurrency;
		if (inFlight >= limit) {
			return { admitted: false, limit: `${kind}Concurrency`, reason: kind === 'backup' ? 'BackupAlreadyRunning' : 'BuildAlreadyRunning' };
		}
		return { admitted: true, limit: `${kind}Concurrency` };
	}
	throw new Error(`Unknown request class: ${String(kind)}`);
}

/**
 * Budget usage against the host, so a capacity decision can be made from numbers.
 *
 * `temporaryBytes` is deliberately compared as a whole rather than per job: the preview
 * cache, the release staging directory and the backup staging directory share one disk,
 * and a per-job budget that individually fits can still fill it.
 */
export function describeCapacityBudget({ limits, memory = {}, disk = {}, temporary = 0 }) {
	const problems = [];
	const availableMb = Number(memory.availableMb ?? 0);
	const swapUsedMb = Number(memory.swapUsedMb ?? 0);
	const swapTotalMb = Number(memory.swapTotalMb ?? 0);
	const diskAvailableBytes = Number(disk.availableBytes ?? 0);

	if (availableMb > 0 && availableMb < limits.previewMemoryMb) {
		problems.push(`available memory ${availableMb} MiB is below the conversion budget of ${limits.previewMemoryMb} MiB`);
	}
	if (swapTotalMb > 0 && swapUsedMb / swapTotalMb > 0.9) {
		problems.push(`swap is ${Math.round((swapUsedMb / swapTotalMb) * 100)}% used, so a conversion would page`);
	}
	if (diskAvailableBytes > 0 && diskAvailableBytes < limits.temporaryBytes) {
		problems.push(`disk has ${Math.round(diskAvailableBytes / mebibyte)} MiB free but ${Math.round(limits.temporaryBytes / mebibyte)} MiB of scratch is budgeted`);
	}
	if (temporary > limits.temporaryBytes) {
		problems.push(`temporary space in use is ${Math.round(temporary / mebibyte)} MiB, over the ${Math.round(limits.temporaryBytes / mebibyte)} MiB budget`);
	}
	return { problems, ok: problems.length === 0, headroomMb: Math.max(0, availableMb - limits.previewMemoryMb) };
}

/** Renders the limits as the table the documentation quotes. */
export function renderCapacityTable(limits = capacityLimits) {
	const rows = [
		['上传大小上限', `${Math.round(limits.uploadBytes / mebibyte)} MiB`, capacityEnvironment.uploadBytes],
		['预览队列上限', String(limits.previewQueueMax), capacityEnvironment.previewQueueMax],
		['转换内存上限', `${limits.previewMemoryMb} MiB`, capacityEnvironment.previewMemoryMb],
		['转换超时', `${Math.round(limits.previewTimeoutMs / 1000)} 秒`, capacityEnvironment.previewTimeoutMs],
		['单次查询索引抽取', `${limits.indexDrainBatch} 个作业`, capacityEnvironment.indexDrainBatch],
		['数据库连接上限', String(limits.databasePoolMax), capacityEnvironment.databasePoolMax],
		['临时空间预算', `${Math.round(limits.temporaryBytes / mebibyte)} MiB`, capacityEnvironment.temporaryBytes],
		['单客户端并发', String(limits.clientConcurrency), capacityEnvironment.clientConcurrency],
	];
	const lines = ['| 限制 | 值 | 覆盖用环境变量 |', '|---|---|---|'];
	for (const [name, value, variable] of rows) {
		lines.push(`| ${name} | ${value} | \`${variable}\` |`);
	}
	return lines.join('\n');
}
