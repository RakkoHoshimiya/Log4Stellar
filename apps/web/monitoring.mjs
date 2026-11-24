/**
 * Internal liveness, readiness and metrics for the Log4Stellar Web server.
 *
 * Three surfaces, deliberately different in what they are allowed to touch:
 *
 * - `/healthz` answers only "is this process able to serve HTTP". It never opens a
 *   database or object-store connection, so an outage of Postgres or RustFS cannot
 *   get a healthy instance pulled out of rotation. A probe that fails for a reason
 *   outside the process is a readiness problem, not a liveness problem.
 * - `/readyz` answers "can this instance serve real requests right now" by probing
 *   PostgreSQL and the object store. Both probes run under a hard timeout and behind
 *   a short cache with single-flight, because the storage account has only a handful
 *   of PostgreSQL connections in total: an unauthenticated probe endpoint must not
 *   be able to exhaust them.
 * - `/metrics` renders the Prometheus text format from counters kept in this module.
 *   No new dependency, no exporter sidecar.
 *
 * The same probes feed the `log4stellar_dependency_up` gauges, so an alarm on
 * `dependency_up == 0` and an alarm on the 5xx rate cannot disagree about whether an
 * outage is happening.
 */

import { randomUUID } from 'node:crypto';
import { readFile, readdir, statfs, writeFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { Pool } from 'pg';

/** Process start time; the only clock reading taken before the server listens. */
const startedAtMs = Date.now();

/** Probe defaults; both are overridable per deployment and per test. */
export const defaultProbeTimeoutMs = 1500;
export const defaultProbeCacheMs = 5000;

/**
 * Answers whether this process can serve HTTP at all.
 *
 * Deliberately synchronous and dependency free: no timers, no I/O, no import that
 * reaches the network. Everything it reports is state the process already holds.
 *
 * @param {{ startedAtMs?: number, now?: number, pid?: number, version?: string }} [options]
 */
export function checkLiveness({ startedAtMs: started = startedAtMs, now = Date.now(), pid = process.pid, version } = {}) {
	const uptimeSeconds = Math.max(0, (now - started) / 1000);
	return {
		status: 'ok',
		checkedAt: new Date(now).toISOString(),
		startedAt: new Date(started).toISOString(),
		uptimeSeconds: Number(uptimeSeconds.toFixed(3)),
		pid,
		...(version ? { version } : {}),
	};
}

/**
 * Races `work` against a timer so a black-holed dependency cannot hold a probe open.
 * The rejection is tagged, and readiness reports its category rather than its
 * message, because a driver message can embed the connection string it failed on.
 */
export async function withTimeout(work, timeoutMs, label = 'probe') {
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
		throw new Error('A probe timeout must be a positive number of milliseconds.');
	}
	let timer;
	try {
		return await Promise.race([
			Promise.resolve().then(work),
			new Promise((_resolve, reject) => {
				timer = setTimeout(() => reject(probeTimeout(label, timeoutMs)), timeoutMs);
				timer.unref?.();
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

function probeTimeout(label, timeoutMs) {
	const error = new Error(`The ${label} probe did not answer within ${timeoutMs}ms.`);
	error.code = 'ProbeTimeout';
	return error;
}

/**
 * Reduces a driver error to a category that is safe to put in a response body and in
 * a metric label. Connection strings, passwords and object keys never survive this.
 */
export function classifyProbeError(error) {
	const code = typeof error?.code === 'string' ? error.code : undefined;
	if (code === 'ProbeTimeout') {
		return { category: 'timeout', code: 'ProbeTimeout' };
	}
	if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'EPIPE') {
		return { category: 'unreachable', code };
	}
	if (error?.name === 'AbortError' || error?.name === 'TimeoutError' || code === 'ABORT_ERR' || code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'UND_ERR_HEADERS_TIMEOUT') {
		return { category: 'timeout', code: code ?? 'AbortError' };
	}
	// pg reports authentication and missing-database failures before transport ones.
	if (code === '28P01' || code === '28000') {
		return { category: 'rejected', code };
	}
	if (code === '3D000') {
		return { category: 'missing_database', code };
	}
	if (code === '42501') {
		return { category: 'forbidden', code };
	}
	const status = typeof error?.statusCode === 'number' ? error.statusCode : error?.$metadata?.httpStatusCode;
	if (typeof status === 'number') {
		return { category: status >= 500 ? 'upstream' : 'rejected', code: `Http${status}` };
	}
	return { category: 'error', code: code ?? 'Unknown' };
}

/**
 * Probes PostgreSQL with the smallest footprint available.
 *
 * At most one connection, closed immediately, so a monitoring probe cannot itself
 * exhaust the server-side connection limit. `connectionTimeoutMillis` and
 * `query_timeout` bound both the connect and the query phase.
 *
 * The same connection then reads how crowded the server is. That matters here: the
 * application role is limited to ten connections in total, so "how close are we to
 * the limit" is far more actionable than a client-side queue that is usually empty.
 * Reading it costs no extra connection, and a role without access simply omits it.
 */
export async function probePostgres({ postgres, timeoutMs = defaultProbeTimeoutMs, Pool: PoolClass = Pool } = {}) {
	if (!postgres) {
		throw new Error('The PostgreSQL probe requires connection details.');
	}
	const startedProbe = Date.now();
	const pool = new PoolClass({
		...postgres,
		// These are constraints, not hints: they must win over anything in the config.
		connectionTimeoutMillis: timeoutMs,
		query_timeout: timeoutMs,
		statement_timeout: timeoutMs,
		idleTimeoutMillis: 5_000,
		allowExitOnIdle: true,
		max: 1,
	});
	try {
		const result = await withTimeout(() => pool.query('SELECT 1 AS ok'), timeoutMs, 'PostgreSQL');
		const detail = { rows: result.rowCount ?? result.rows?.length ?? 0 };
		const crowd = await withTimeout(() => pool.query(`
			SELECT count(*)::int AS total,
				count(*) FILTER (WHERE state = 'idle')::int AS idle,
				count(*) FILTER (WHERE wait_event_type = 'Lock')::int AS waiting
			FROM pg_stat_activity
			WHERE datname = current_database()
		`), timeoutMs, 'PostgreSQL').catch(() => undefined);
		const row = crowd?.rows?.[0];
		if (row) {
			detail.serverConnections = Number(row.total) || 0;
			detail.serverIdle = Number(row.idle) || 0;
			detail.serverWaiting = Number(row.waiting) || 0;
		}
		return { ok: true, durationMs: Date.now() - startedProbe, detail };
	} finally {
		await Promise.resolve(pool.end()).catch(() => {});
	}
}

/** Reads live counters off a `pg` pool; safe on anything that is not a pool. */
export function poolStats(pool) {
	if (!pool || typeof pool !== 'object') {
		return undefined;
	}
	const total = Number(pool.totalCount ?? 0);
	const idle = Number(pool.idleCount ?? 0);
	const waiting = Number(pool.waitingCount ?? 0);
	return {
		total: Number.isFinite(total) ? total : 0,
		idle: Number.isFinite(idle) ? idle : 0,
		waiting: Number.isFinite(waiting) ? waiting : 0,
	};
}

/**
 * Probes the object store with a bucket HEAD: the cheapest call that proves both
 * reachability and credentials, and one that never creates or reads an object.
 *
 * Credentials come from the storage configuration and are never echoed; only the
 * error category reaches the response.
 */
export async function probeRustfs({ s3, timeoutMs = defaultProbeTimeoutMs, S3Client: ClientClass = S3Client } = {}) {
	const { endpoint, region = 'us-east-1', bucket, accessKeyId, secretAccessKey } = s3 ?? {};
	if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
		throw new Error('The RustFS probe requires an endpoint, bucket and access credentials.');
	}
	const startedProbe = Date.now();
	const client = new ClientClass({
		endpoint,
		region,
		forcePathStyle: true,
		credentials: { accessKeyId, secretAccessKey },
		requestChecksumCalculation: 'WHEN_REQUIRED',
		responseChecksumValidation: 'WHEN_REQUIRED',
		requestHandler: { connectionTimeout: timeoutMs, requestTimeout: timeoutMs },
		// A probe must not retry: the cache and the alarm absorb the retry instead.
		maxAttempts: 1,
	});
	try {
		await withTimeout(() => client.send(new HeadBucketCommand({ Bucket: bucket })), timeoutMs, 'RustFS');
		return { ok: true, durationMs: Date.now() - startedProbe, detail: { bucketResponded: true } };
	} finally {
		client.destroy?.();
	}
}

/**
 * Reads `LOG4STELLAR_STORAGE_CONFIG` the way `rustfs-workspace.mjs` does, but without
 * throwing: a local-directory deployment legitimately has no storage configuration,
 * and readiness must report that as "not required" rather than as down.
 */
export async function readStorageConfig(environment = process.env) {
	const configPath = environment.LOG4STELLAR_STORAGE_CONFIG;
	if (!configPath) {
		return { configured: false, reason: 'LOG4STELLAR_STORAGE_CONFIG is not set; this deployment uses the local directory backend.' };
	}
	let settings;
	try {
		settings = JSON.parse(await readFile(configPath, 'utf8'));
	} catch (error) {
		return { configured: false, configPath, reason: `The storage configuration could not be read (${error?.code ?? 'invalid'}).` };
	}
	const postgres = settings?.postgres;
	const s3 = settings?.s3;
	const missing = [];
	if (!postgres?.host || !postgres?.database || !postgres?.user || !postgres?.password) {
		missing.push('postgres');
	}
	if (!s3?.endpoint || !s3?.bucket || !s3?.accessKeyId || !s3?.secretAccessKey) {
		missing.push('s3');
	}
	if (missing.length) {
		return { configured: false, configPath, reason: `The storage configuration is missing ${missing.join(' and ')} details.` };
	}
	return { configured: true, configPath, postgres, s3 };
}

/**
 * Free space on the filesystem that holds `path`, in bytes and as a ratio.
 *
 * `statfs` is injectable so a drill can simulate a full disk without mounting a real
 * tmpfs or writing to a filesystem that other work depends on.
 */
export async function checkDiskSpace(path, { statfs: statfsImpl = statfs, now = Date.now() } = {}) {
	const info = await statfsImpl(path);
	const blockSize = Number(info.bsize ?? info.frsize ?? 0);
	const available = Number(info.bavail ?? info.bfree ?? 0) * blockSize;
	const total = Number(info.blocks ?? 0) * blockSize;
	return {
		path,
		availableBytes: Number.isFinite(available) ? available : 0,
		totalBytes: Number.isFinite(total) && total > 0 ? total : 0,
		availableRatio: Number.isFinite(available) && total > 0 ? available / total : 0,
		checkedAt: new Date(now).toISOString(),
	};
}

/**
 * Age of the newest backup manifest under a backup root.
 *
 * Accepts either the backup directory itself or a root holding one dated directory
 * per run, which is how `backup-data.mjs` is normally driven (it refuses a
 * destination that already exists). Only `manifest.json` is read, only its
 * `createdAt` field is used, and nothing about the manifest's contents is exported.
 */
export async function readBackupFreshness(directory, { now = Date.now(), readdir: readdirImpl = readdir, readFile: readFileImpl = readFile } = {}) {
	if (!directory) {
		return { present: false, reason: 'No backup directory is configured.' };
	}
	let entries;
	try {
		entries = await readdirImpl(directory, { withFileTypes: true });
	} catch (error) {
		return { present: false, reason: `The backup directory could not be read (${error?.code ?? 'invalid'}).` };
	}
	const candidates = [directory];
	for (const entry of entries) {
		if (entry.isDirectory() && !entry.name.startsWith('.')) {
			candidates.push(join(directory, entry.name));
		}
	}
	let newest;
	for (const candidate of candidates) {
		let manifest;
		try {
			manifest = JSON.parse(await readFileImpl(join(candidate, 'manifest.json'), 'utf8'));
		} catch {
			continue;
		}
		const createdAt = Date.parse(manifest?.createdAt);
		if (!Number.isFinite(createdAt) || createdAt > now) {
			continue;
		}
		if (!newest || createdAt > newest.createdAt) {
			newest = { createdAt, directory: candidate };
		}
	}
	if (!newest) {
		return { present: false, reason: 'No readable backup manifest was found.' };
	}
	return {
		present: true,
		createdAt: new Date(newest.createdAt).toISOString(),
		ageSeconds: Math.max(0, (now - newest.createdAt) / 1000),
		directory: newest.directory,
	};
}

/**
 * Runs the dependency probes and folds them into one readiness answer.
 *
 * Each check is `{ name, required, run }`. A check that does not apply to this
 * deployment is `skipped`, not failed: the local-directory backend has no PostgreSQL,
 * and reporting that as "not ready" would mark every such instance permanently down.
 *
 * A failed probe is cached exactly as briefly as a successful one, so a dependency
 * already known to be down does not receive one connection attempt per scrape or per
 * poll. Concurrent polls share a single attempt.
 */
export function buildReadiness({ checks = [], timeoutMs = defaultProbeTimeoutMs, cacheMs = defaultProbeCacheMs, now = () => Date.now(), cache = new Map() } = {}) {
	return async function readiness() {
		const requestedAt = now();
		const results = await Promise.all(checks.map(check => runCached(check, { cache, cacheMs, timeoutMs, now })));
		const failed = results.filter(result => result.required && !result.ok && result.status !== 'skipped');
		const degraded = results.some(result => !result.required && !result.ok && result.status !== 'skipped');
		const ready = failed.length === 0;
		return {
			status: ready ? (degraded ? 'ready_degraded' : 'ready') : 'not_ready',
			ready,
			degraded,
			checkedAt: new Date(requestedAt).toISOString(),
			durationMs: now() - requestedAt,
			cached: results.length > 0 && results.every(result => result.cached),
			checks: results,
		};
	};
}

async function runCached(check, { cache, cacheMs, timeoutMs, now }) {
	const key = check.name;
	const entry = cache.get(key);
	const at = now();
	if (entry?.settled && at - entry.at < cacheMs) {
		return { ...entry.result, cached: true };
	}
	if (entry?.inflight) {
		return { ...(await entry.inflight), cached: true };
	}
	const startedProbe = now();
	const inflight = (async () => {
		try {
			const outcome = await withTimeout(() => check.run(), timeoutMs, check.name);
			return {
				name: check.name,
				required: check.required !== false,
				status: 'up',
				ok: true,
				durationMs: Math.max(0, now() - startedProbe),
				...(outcome?.detail ? { detail: outcome.detail } : {}),
			};
		} catch (error) {
			if (error?.code === 'ProbeSkipped') {
				return { name: check.name, required: check.required !== false, status: 'skipped', ok: true, durationMs: 0, reason: error.message, cached: false };
			}
			const result = {
				name: check.name,
				required: check.required !== false,
				status: 'down',
				ok: false,
				durationMs: Math.max(0, now() - startedProbe),
				error: classifyProbeError(error),
				cached: false,
			};
			// Local checks (disk, backup) describe themselves in a sentence the operator
			// can act on — "Only 0MiB remain" — and that sentence is the whole value of
			// the answer. Dependency probes deliberately do not: a driver message can
			// carry a host, a user name or a full DSN, so those checks report only the
			// classified category and driver code. `exposeReason` is the opt-in, and the
			// text is redacted even then so a future check cannot leak by accident.
			if (check.exposeReason) {
				result.reason = redactText(error?.message ?? result.error.code);
			}
			return result;
		}
	})();
	cache.set(key, { at, inflight, settled: false });
	const result = await inflight;
	cache.set(key, { at: now(), settled: true, result });
	return { ...result, cached: false };
}

/** Keeps a check out of the readiness answer without reporting it as a failure. */
export function skipCheck(reason) {
	const error = new Error(reason);
	error.code = 'ProbeSkipped';
	return error;
}

/** Histogram buckets in seconds, chosen for an HTTPS note-taking service. */
export const defaultLatencyBuckets = Object.freeze([0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]);

const metricHelp = Object.freeze({
	log4stellar_http_requests_total: 'HTTP requests served, by method, bounded route and status class.',
	log4stellar_http_request_duration_seconds: 'HTTP request latency in seconds, by method and bounded route.',
	log4stellar_http_client_errors_total: 'HTTP responses with a 4xx status, by bounded route.',
	log4stellar_http_server_errors_total: 'HTTP responses with a 5xx status, by bounded route.',
	log4stellar_dependency_up: 'Whether a dependency probe succeeded (1) or failed (0).',
	log4stellar_dependency_probe_seconds: 'Duration of the dependency probe in seconds.',
	log4stellar_dependency_errors_total: 'Dependency probe failures, by dependency, category and driver code.',
	log4stellar_process_resident_memory_bytes: 'Resident set size of the server process.',
	log4stellar_process_heap_used_bytes: 'V8 heap in use.',
	log4stellar_process_heap_total_bytes: 'V8 heap committed.',
	log4stellar_process_external_memory_bytes: 'Memory held by buffers outside the V8 heap.',
	log4stellar_process_uptime_seconds: 'Seconds since this process started.',
	log4stellar_process_starts_total: 'Recorded process starts, when a state file is configured.',
	log4stellar_build_info: 'Always 1; carries the version and storage backend as labels.',
	log4stellar_workspace_backends_open: 'Workspace backends currently held open.',
	log4stellar_workspace_backends_opening: 'Workspace backends currently being opened (the request backlog).',
	log4stellar_workspace_backends_limit: 'Maximum number of workspace backends the cache keeps open.',
	log4stellar_pg_pool_connections: 'PostgreSQL pool connections held by this process, by state.',
	log4stellar_pg_pool_waiting: 'Callers queued for a PostgreSQL connection in this process.',
	log4stellar_pg_server_connections: 'PostgreSQL server connections for this database, by state.',
	log4stellar_pg_server_waiting: 'PostgreSQL server sessions waiting on a lock.',
	log4stellar_readiness_status: 'Always 1; carries the current readiness status as a label.',
	log4stellar_disk_available_bytes: 'Free bytes on the monitored filesystem.',
	log4stellar_disk_total_bytes: 'Total bytes on the monitored filesystem.',
	log4stellar_disk_available_ratio: 'Free space as a fraction of the filesystem.',
	log4stellar_disk_low: 'Whether free disk space is below the configured floor.',
	log4stellar_backup_present: 'Whether a readable backup manifest was found.',
	log4stellar_backup_age_seconds: 'Age of the newest backup in seconds, or -1 when none was found.',
});

/**
 * A small in-memory Prometheus registry.
 *
 * Only counts, sums and gauges live here. There is no unbounded cardinality because
 * the middleware labels a request by *route*, never by path.
 */
export function createMetricsRegistry({ buckets = defaultLatencyBuckets, help = metricHelp } = {}) {
	const families = new Map();

	function family(name) {
		let entry = families.get(name);
		if (!entry) {
			entry = { name, help: help[name] ?? name, type: 'counter', buckets, rows: new Map() };
			families.set(name, entry);
		}
		return entry;
	}

	function rowOf(entry, labels) {
		const key = labelKey(labels);
		let found = entry.rows.get(key);
		if (!found) {
			found = entry.type === 'histogram'
				? { labels: labels ?? {}, counts: entry.buckets.map(() => 0), sum: 0, count: 0 }
				: { labels: labels ?? {}, value: 0 };
			entry.rows.set(key, found);
		}
		if (entry.type === 'histogram' && !found.counts) {
			found.counts = entry.buckets.map(() => 0);
			found.sum = 0;
			found.count = 0;
		}
		return found;
	}

	return {
		increment(name, labels, value = 1) {
			const entry = family(name);
			entry.type = 'counter';
			rowOf(entry, labels).value += value;
			return this;
		},
		gauge(name, labels, value) {
			const entry = family(name);
			entry.type = 'gauge';
			rowOf(entry, labels).value = Number.isFinite(value) ? value : 0;
			return this;
		},
		observe(name, labels, value) {
			const entry = family(name);
			entry.type = 'histogram';
			const found = rowOf(entry, labels);
			found.sum += value;
			found.count += 1;
			entry.buckets.forEach((bound, index) => {
				if (value <= bound) {
					found.counts[index] += 1;
				}
			});
			return this;
		},
		/** Drops every series of one family; used for gauges recomputed per scrape. */
		reset(name) {
			families.delete(name);
			return this;
		},
		render() {
			const lines = [];
			for (const name of [...families.keys()].sort()) {
				const entry = families.get(name);
				if (!entry.rows.size) {
					continue;
				}
				lines.push(`# HELP ${name} ${entry.help}`);
				lines.push(`# TYPE ${name} ${entry.type}`);
				for (const found of entry.rows.values()) {
					if (entry.type === 'histogram') {
						entry.buckets.forEach((bound, index) => {
							lines.push(`${name}_bucket${renderLabels({ ...found.labels, le: formatNumber(bound) })} ${found.counts[index]}`);
						});
						lines.push(`${name}_bucket${renderLabels({ ...found.labels, le: '+Inf' })} ${found.count}`);
						lines.push(`${name}_sum${renderLabels(found.labels)} ${formatNumber(found.sum)}`);
						lines.push(`${name}_count${renderLabels(found.labels)} ${found.count}`);
					} else {
						lines.push(`${name}${renderLabels(found.labels)} ${formatNumber(found.value)}`);
					}
				}
			}
			return lines.join('\n') + '\n';
		},
	};
}

function labelKey(labels) {
	if (!labels) {
		return '';
	}
	return Object.keys(labels).sort().map(key => `${key}=${labels[key]}`).join(',');
}

function renderLabels(labels) {
	const keys = Object.keys(labels ?? {}).sort();
	if (!keys.length) {
		return '';
	}
	return '{' + keys.map(key => `${key}="${escapeLabelValue(labels[key])}"`).join(',') + '}';
}

function escapeLabelValue(value) {
	return String(value).replaceAll('\\', '\\\\').replaceAll('\n', '\\n').replaceAll('"', '\\"');
}

function formatNumber(value) {
	if (!Number.isFinite(value)) {
		return '0';
	}
	return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(6)));
}

/**
 * Collapses a request path to a bounded route label.
 *
 * Request paths carry workspace IDs and file names; using them directly as labels is
 * how an exporter falls over under real traffic. Everything unrecognised is `other`.
 */
export function normalizeRoute(path) {
	if (typeof path !== 'string' || !path.startsWith('/')) {
		return 'other';
	}
	const exact = {
		'/': 'workbench',
		'/healthz': 'healthz',
		'/readyz': 'readyz',
		'/metrics': 'metrics',
		'/login': 'login',
		'/session-client.js': 'session_client',
		'/account/security': 'account_security',
		'/account/security.js': 'account_security',
		'/api/session': 'session_api',
	};
	if (exact[path]) {
		return exact[path];
	}
	const prefixes = [
		['/api/session/', 'session_api'],
		['/api/account-security', 'account_security_api'],
		['/sync/v1', 'sync'],
		['/git/v1', 'git'],
		['/static/mount', 'workspace_files'],
		['/static/extensions/', 'static_extensions'],
		['/static/build/', 'static_build'],
		['/out/', 'static_workbench'],
	];
	for (const [prefix, route] of prefixes) {
		if (path.startsWith(prefix)) {
			return route;
		}
	}
	return 'other';
}

/**
 * Parses the monitoring client allowlist.
 *
 * `/metrics` is an internal surface, so it is loopback-only unless a deployment names
 * the scrape hosts explicitly. An entry is an exact address, a CIDR block, or `*` —
 * and `*` is refused: a metrics endpoint that exposes route traffic to the whole
 * network is a worse default than an unreachable dashboard.
 */
export function parseMonitorClients(text) {
	const entries = String(text ?? '').split(',').map(entry => entry.trim()).filter(Boolean);
	const parsed = [];
	for (const entry of entries) {
		if (entry === '*') {
			continue;
		}
		const cidr = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(entry);
		if (cidr) {
			const base = ipv4ToInt(cidr[1]);
			const bits = Number(cidr[2]);
			if (base !== undefined && bits >= 0 && bits <= 32) {
				parsed.push({ kind: 'cidr', base, bits });
			}
		} else if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(entry)) {
			parsed.push({ kind: 'exact', value: entry });
		} else if (entry === 'localhost') {
			parsed.push({ kind: 'exact', value: '127.0.0.1' });
		} else if (/^[0-9a-f:]+$/i.test(entry)) {
			parsed.push({ kind: 'exact', value: entry.toLowerCase() });
		}
	}
	return parsed;
}

const loopback = Object.freeze(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** Whether a socket address may read the metrics and readiness surface. */
export function isMonitorClient(address, allowlist = []) {
	if (typeof address !== 'string' || !address) {
		return false;
	}
	const normalized = address.toLowerCase();
	if (loopback.includes(normalized)) {
		return true;
	}
	const asInt = ipv4ToInt(normalized);
	for (const entry of allowlist) {
		if (entry.kind === 'exact' && entry.value === normalized) {
			return true;
		}
		if (entry.kind === 'cidr' && asInt !== undefined && entry.bits > 0) {
			const mask = (~0 << (32 - entry.bits)) >>> 0;
			if ((asInt & mask) >>> 0 === (entry.base & mask) >>> 0) {
				return true;
			}
		}
	}
	return false;
}

function ipv4ToInt(address) {
	const match = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address) ?? /^(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address);
	if (!match) {
		return undefined;
	}
	const parts = match[1].split('.').map(Number);
	if (parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) {
		return undefined;
	}
	return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

const secretKey = /pass(word)?|secret|token|authorization|cookie|credential|signature|apikey|api_key/i;

function redactField(key, value, depth = 0) {
	if (secretKey.test(key)) {
		return '[redacted]';
	}
	if (value === undefined || value === null) {
		return undefined;
	}
	if (typeof value === 'string') {
		return redactText(value);
	}
	if (typeof value === 'number' || typeof value === 'boolean') {
		return value;
	}
	// Error objects and plain objects carry the same risk as a top-level field: a
	// driver error can hold the connection options it failed on. Redact them key by
	// key rather than stringifying whatever happens to be inside.
	if (depth < 3 && typeof value === 'object') {
		if (value instanceof Error) {
			return redactText(value.message);
		}
		if (Array.isArray(value)) {
			return value.slice(0, 20).map(item => redactField(key, item, depth + 1));
		}
		const redacted = {};
		for (const [name, inner] of Object.entries(value).slice(0, 40)) {
			const result = redactField(name, inner, depth + 1);
			if (result !== undefined) {
				redacted[name] = result;
			}
		}
		return redacted;
	}
	return redactText(JSON.stringify(value));
}

function redactText(text) {
	return String(text)
		// a URL that carries credentials is still a credential
		.replace(/\/\/[^/\s@]+@/g, '//[redacted]@')
		.replace(/\b(X-Amz-Signature|X-Amz-Credential|X-Amz-Security-Token|sig|token|password|secret)=[^&\s"]+/gi, '$1=[redacted]')
		.slice(0, 512);
}

/**
 * A one-line-per-event JSON logger carrying the fields an incident needs and nothing
 * else.
 *
 * - `ts` is always UTC ISO 8601, so logs from several hosts sort lexically.
 * - `requestId` ties the access line to any error line the same request produced.
 * - The query string is dropped: it is the field most likely to carry a token.
 * - Values pass through a redactor, so a driver error that embeds a connection string
 *   or an object signature cannot reach the log.
 */
export function createStructuredLogger({ sink, level = 'info', now = () => new Date() } = {}) {
	const writer = sink ?? (line => process.stdout.write(line + '\n'));
	const levels = { debug: 10, info: 20, warn: 30, error: 40 };
	const threshold = levels[level] ?? levels.info;
	function log(entryLevel, message, fields = {}) {
		if ((levels[entryLevel] ?? levels.info) < threshold) {
			return;
		}
		const record = { ts: new Date(now()).toISOString(), level: entryLevel, msg: message };
		for (const [key, value] of Object.entries(fields)) {
			const redacted = redactField(key, value);
			if (redacted !== undefined) {
				record[key] = redacted;
			}
		}
		writer(JSON.stringify(record));
	}
	return {
		debug: (message, fields) => log('debug', message, fields),
		info: (message, fields) => log('info', message, fields),
		warn: (message, fields) => log('warn', message, fields),
		error: (message, fields) => log('error', message, fields),
	};
}

/** Accepts a caller-supplied request ID only when it is safe to echo back. */
export function requestIdFor(incoming) {
	const candidate = typeof incoming === 'string' ? incoming.trim() : '';
	return /^[A-Za-z0-9._-]{8,64}$/.test(candidate) ? candidate : randomUUID();
}

/**
 * Reads or advances the persisted start counter, so "how often did this process
 * restart" survives the restart itself. Without a state file the counter reports
 * `tracked="false"` rather than pretending its value means anything.
 */
export async function trackProcessStarts(file, { readFile: readFileImpl = readFile, writeFile: writeFileImpl = writeFile, rename: renameImpl = rename } = {}) {
	if (!file) {
		return { tracked: false, starts: 1 };
	}
	let previous = 0;
	try {
		const state = JSON.parse(await readFileImpl(file, 'utf8'));
		previous = Number.isInteger(state?.starts) ? state.starts : 0;
	} catch {
		previous = 0;
	}
	const starts = previous + 1;
	const temporary = `${file}.${process.pid}.tmp`;
	try {
		await writeFileImpl(temporary, JSON.stringify({ starts, updatedAt: new Date().toISOString() }) + '\n', { mode: 0o600 });
		await renameImpl(temporary, file);
	} catch {
		// A read-only configuration directory must not stop the server from booting.
		return { tracked: false, starts };
	}
	return { tracked: true, starts };
}

/** The filesystem a deployment cares about, for the disk gauges. */
export function defaultDiskPath({ workspacePath, storageConfigPath } = {}) {
	if (workspacePath) {
		return workspacePath;
	}
	if (storageConfigPath) {
		return dirname(storageConfigPath);
	}
	return process.cwd();
}

function positiveInteger(value, fallback) {
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInteger(value, fallback) {
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function nonNegativeFraction(value, fallback) {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : fallback;
}

/**
 * Builds the middleware that serves `/healthz`, `/readyz` and `/metrics` and
 * instruments every other request.
 *
 * Mount it ahead of the authentication gateway: a probe carries no cookie, and the
 * gateway answers 421 to an origin it does not recognise.
 */
export function createMonitoring({
	environment = process.env,
	backend = 'local',
	workspaceId,
	version,
	backends,
	diskPath,
	backupDirectory,
	now = () => Date.now(),
	metrics = createMetricsRegistry(),
	logger,
	probeTimeoutMs,
	probeCacheMs,
	stateFile,
	monitorClients,
	checks,
	statfs: statfsImpl,
} = {}) {
	const timeoutMs = positiveInteger(probeTimeoutMs ?? environment.LOG4STELLAR_MONITOR_PROBE_TIMEOUT_MS, defaultProbeTimeoutMs);
	const cacheMs = positiveInteger(probeCacheMs ?? environment.LOG4STELLAR_MONITOR_PROBE_CACHE_MS, defaultProbeCacheMs);
	const diskMinimumFreeBytes = nonNegativeInteger(environment.LOG4STELLAR_MONITOR_DISK_MIN_FREE_BYTES, 0);
	const diskMinimumFreeRatio = nonNegativeFraction(environment.LOG4STELLAR_MONITOR_DISK_MIN_FREE_RATIO, 0);
	const backupMaximumAgeSeconds = nonNegativeInteger(environment.LOG4STELLAR_MONITOR_BACKUP_MAX_AGE_SECONDS, 0);
	const diskRequired = environment.LOG4STELLAR_MONITOR_DISK_REQUIRED === '1';
	const backupRequired = environment.LOG4STELLAR_MONITOR_BACKUP_REQUIRED === '1';
	const clients = monitorClients ?? parseMonitorClients(environment.LOG4STELLAR_MONITOR_CLIENTS);
	const log = logger ?? createStructuredLogger({ level: environment.LOG4STELLAR_MONITOR_LOG_LEVEL ?? 'info', now: () => new Date(now()) });
	const cache = new Map();
	let starts = { tracked: false, starts: 1 };

	// The storage configuration is a boot-time input: reading it per probe would add a
	// file read to every readiness poll, and the file cannot change under a running
	// deployment without a restart anyway.
	let storage;
	const storagePromise = readStorageConfig(environment).then(
		result => (storage = result),
		() => (storage = { configured: false, reason: 'The storage configuration could not be read.' }),
	);

	const disk = diskPath ? () => checkDiskSpace(diskPath, { statfs: statfsImpl, now: now() }) : undefined;
	const backup = backupDirectory ? () => readBackupFreshness(backupDirectory, { now: now() }) : undefined;

	const liveness = () => checkLiveness({ startedAtMs, now: now(), version });

	function defaultChecks() {
		const list = [];
		if (storage?.configured) {
			list.push({ name: 'postgres', required: true, run: () => probePostgres({ postgres: storage.postgres, timeoutMs }) });
			list.push({ name: 'rustfs', required: true, run: () => probeRustfs({ s3: storage.s3, timeoutMs }) });
		} else {
			list.push({ name: 'postgres', required: false, run: () => skipCheck('No storage configuration; the local directory backend has no PostgreSQL.') });
			list.push({ name: 'rustfs', required: false, run: () => skipCheck('No storage configuration; the local directory backend has no object store.') });
		}
		if (disk) {
			list.push({
				name: 'disk',
				required: diskRequired,
				// The operator needs the number in the sentence, not just "down".
				exposeReason: true,
				run: async () => {
					const space = await disk();
					const lowBytes = diskMinimumFreeBytes > 0 && space.availableBytes < diskMinimumFreeBytes;
					const lowRatio = diskMinimumFreeRatio > 0 && space.availableRatio < diskMinimumFreeRatio;
					if (lowBytes || lowRatio) {
						throw new Error(`Only ${Math.round(space.availableBytes / 1024 / 1024)}MiB remain on ${space.path}.`);
					}
					return { detail: { availableBytes: space.availableBytes, availableRatio: Number(space.availableRatio.toFixed(4)) } };
				},
			});
		}
		if (backup) {
			list.push({
				name: 'backup',
				required: backupRequired,
				exposeReason: true,
				run: async () => {
					const freshness = await backup();
					if (!freshness.present) {
						throw new Error(freshness.reason ?? 'No backup manifest was found.');
					}
					if (backupMaximumAgeSeconds > 0 && freshness.ageSeconds > backupMaximumAgeSeconds) {
						throw new Error(`The newest backup is ${Math.round(freshness.ageSeconds)}s old.`);
					}
					return { detail: { ageSeconds: Math.round(freshness.ageSeconds) } };
				},
			});
		}
		return list;
	}

	// The default check list depends on the storage configuration, which resolves
	// asynchronously; a caller-supplied list (the drills and the tests) is fixed and is
	// evaluated immediately.
	const ready = checks
		? buildReadiness({ checks, timeoutMs, cacheMs, now, cache })
		: async () => {
			await storagePromise;
			return buildReadiness({ checks: defaultChecks(), timeoutMs, cacheMs, now, cache })();
		};

	/** Cheap gauges, refreshed once per scrape. */
	async function collectGauges() {
		const memory = process.memoryUsage();
		metrics.gauge('log4stellar_process_resident_memory_bytes', undefined, memory.rss);
		metrics.gauge('log4stellar_process_heap_used_bytes', undefined, memory.heapUsed);
		metrics.gauge('log4stellar_process_heap_total_bytes', undefined, memory.heapTotal);
		metrics.gauge('log4stellar_process_external_memory_bytes', undefined, memory.external);
		metrics.gauge('log4stellar_process_uptime_seconds', undefined, Number(((now() - startedAtMs) / 1000).toFixed(3)));
		metrics.gauge('log4stellar_process_starts_total', { tracked: String(starts.tracked) }, starts.starts);
		metrics.gauge('log4stellar_build_info', { version: version ?? 'unknown', backend }, 1);

		const stats = typeof backends?.stats === 'function' ? safeCall(() => backends.stats()) : undefined;
		if (stats) {
			metrics.gauge('log4stellar_workspace_backends_open', undefined, stats.open ?? 0);
			metrics.gauge('log4stellar_workspace_backends_opening', undefined, stats.opening ?? 0);
			metrics.gauge('log4stellar_workspace_backends_limit', undefined, stats.limit ?? 0);
			// Sum across live backends: every open backend has its own pool, so the
			// deployment-wide figure is what the capacity limit applies to.
			const pools = Array.isArray(stats.pools) ? stats.pools : [];
			const pool = pools.reduce((total, one) => ({
				total: total.total + (one.total ?? 0),
				idle: total.idle + (one.idle ?? 0),
				waiting: total.waiting + (one.waiting ?? 0),
			}), { total: 0, idle: 0, waiting: 0 });
			metrics.gauge('log4stellar_pg_pool_connections', { state: 'total' }, pool.total);
			metrics.gauge('log4stellar_pg_pool_connections', { state: 'idle' }, pool.idle);
			metrics.gauge('log4stellar_pg_pool_waiting', undefined, pool.waiting);
		}

		const answer = await safeAwait(() => ready());
		if (answer) {
			for (const check of answer.checks) {
				const up = check.status === 'up' || check.status === 'skipped';
				metrics.gauge('log4stellar_dependency_up', { dependency: check.name }, up ? 1 : 0);
				metrics.gauge('log4stellar_dependency_probe_seconds', { dependency: check.name }, Number((check.durationMs / 1000).toFixed(6)));
				if (!up && check.error) {
					metrics.increment('log4stellar_dependency_errors_total', { dependency: check.name, code: check.error.code, category: check.error.category });
				}
				const detail = check.detail ?? {};
				if (check.name === 'postgres') {
					metrics.gauge('log4stellar_pg_server_connections', { state: 'total' }, detail.serverConnections ?? 0);
					metrics.gauge('log4stellar_pg_server_connections', { state: 'idle' }, detail.serverIdle ?? 0);
					metrics.gauge('log4stellar_pg_server_waiting', undefined, detail.serverWaiting ?? 0);
				}
			}
			metrics.gauge('log4stellar_readiness_status', { status: answer.status }, 1);
		}

		const space = disk ? await safeAwait(() => disk()) : undefined;
		if (space) {
			metrics.gauge('log4stellar_disk_available_bytes', { path: space.path }, space.availableBytes);
			metrics.gauge('log4stellar_disk_total_bytes', { path: space.path }, space.totalBytes);
			metrics.gauge('log4stellar_disk_available_ratio', { path: space.path }, Number(space.availableRatio.toFixed(6)));
			const low = (diskMinimumFreeBytes > 0 && space.availableBytes < diskMinimumFreeBytes)
				|| (diskMinimumFreeRatio > 0 && space.availableRatio < diskMinimumFreeRatio);
			metrics.gauge('log4stellar_disk_low', { path: space.path }, low ? 1 : 0);
		}

		const freshness = backup ? await safeAwait(() => backup()) : undefined;
		if (freshness) {
			metrics.gauge('log4stellar_backup_present', undefined, freshness.present ? 1 : 0);
			metrics.gauge('log4stellar_backup_age_seconds', undefined, freshness.present ? Math.round(freshness.ageSeconds) : -1);
		}
	}

	function observe(ctx, requestId, route, startedRequest, status) {
		const method = typeof ctx.method === 'string' ? ctx.method : 'GET';
		metrics.increment('log4stellar_http_requests_total', { method, route, status_class: `${Math.floor(status / 100)}xx` });
		if (route !== 'healthz' && route !== 'readyz' && route !== 'metrics') {
			metrics.observe('log4stellar_http_request_duration_seconds', { method, route }, Math.max(0, now() - startedRequest) / 1000);
			if (status >= 500) {
				metrics.increment('log4stellar_http_server_errors_total', { route });
			} else if (status >= 400) {
				metrics.increment('log4stellar_http_client_errors_total', { route });
			}
		}
		log.debug('request', { requestId, method, route, status, durationMs: Math.max(0, now() - startedRequest) });
	}

	const middleware = async function monitoringMiddleware(ctx, next) {
		const startedRequest = now();
		const requestId = requestIdFor(typeof ctx.get === 'function' ? ctx.get('X-Request-Id') : undefined);
		ctx.state = ctx.state ?? {};
		ctx.state.requestId = requestId;
		if (typeof ctx.set === 'function') {
			ctx.set('X-Request-Id', requestId);
		}

		const route = normalizeRoute(ctx.path);
		if (route === 'healthz' || route === 'readyz' || route === 'metrics') {
			ctx.set('Cache-Control', 'no-store');
			ctx.set('X-Content-Type-Options', 'nosniff');
			if (ctx.method !== 'GET' && ctx.method !== 'HEAD') {
				ctx.status = 405;
				ctx.set('Allow', 'GET, HEAD');
				ctx.body = { error: 'MethodNotAllowed', requestId };
				observe(ctx, requestId, route, startedRequest, 405);
				return;
			}
			if (route === 'healthz') {
				ctx.status = 200;
				ctx.type = 'application/json; charset=utf-8';
				ctx.body = { ...liveness(), requestId };
				observe(ctx, requestId, route, startedRequest, 200);
				return;
			}
			if (!isMonitorClient(ctx.req?.socket?.remoteAddress, clients)) {
				// A readiness body names the deployment's dependencies; keep it internal
				// while still answering, so a misconfigured probe is visible.
				ctx.status = 403;
				ctx.type = 'application/json; charset=utf-8';
				ctx.body = { error: 'Forbidden', requestId };
				observe(ctx, requestId, route, startedRequest, 403);
				return;
			}
			if (route === 'readyz') {
				const result = await ready();
				ctx.status = result.ready ? 200 : 503;
				ctx.type = 'application/json; charset=utf-8';
				ctx.body = { ...result, requestId };
				observe(ctx, requestId, route, startedRequest, ctx.status);
				return;
			}
			await collectGauges();
			ctx.status = 200;
			ctx.type = 'text/plain; version=0.0.4; charset=utf-8';
			ctx.body = metrics.render();
			observe(ctx, requestId, route, startedRequest, 200);
			return;
		}

		try {
			await next();
		} catch (error) {
			const classified = classifyProbeError(error);
			log.error('request failed', {
				requestId,
				method: ctx.method,
				route,
				errorCategory: classified.category,
				errorCode: classified.code,
				error: error?.message,
			});
			metrics.increment('log4stellar_http_requests_total', { method: ctx.method, route, status_class: '5xx' });
			metrics.increment('log4stellar_http_server_errors_total', { route });
			if (typeof ctx.status !== 'number' || ctx.status < 500) {
				ctx.status = 500;
				ctx.type = 'application/json; charset=utf-8';
				ctx.body = { error: 'InternalError', requestId };
			}
			throw error;
		}
		observe(ctx, requestId, route, startedRequest, typeof ctx.status === 'number' ? ctx.status : 404);
	};

	middleware.metrics = metrics;
	middleware.logger = log;
	middleware.liveness = liveness;
	middleware.readiness = ready;
	middleware.collectGauges = collectGauges;
	middleware.options = { timeoutMs, cacheMs, clients, diskPath, backupDirectory, backend, workspaceId };
	middleware.close = () => cache.clear();
	// Boot-time wiring; the caller awaits it before listening.
	middleware.start = async () => {
		starts = await trackProcessStarts(stateFile ?? environment.LOG4STELLAR_MONITOR_STATE_FILE);
		const storageResult = await storagePromise;
		if (storageResult.configured) {
			log.info('monitoring: dependency probes configured', { backend, workspaceId, timeoutMs, cacheMs });
		} else {
			log.info('monitoring: dependency probes skipped', { backend, workspaceId, reason: storageResult.reason });
		}
		return { starts, timeoutMs, cacheMs };
	};
	return middleware;
}

function safeCall(action) {
	try {
		return action();
	} catch {
		return undefined;
	}
}

async function safeAwait(action) {
	try {
		return await action();
	} catch {
		return undefined;
	}
}
