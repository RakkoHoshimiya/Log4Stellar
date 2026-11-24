import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
	buildReadiness,
	checkDiskSpace,
	checkLiveness,
	classifyProbeError,
	createMetricsRegistry,
	createMonitoring,
	createStructuredLogger,
	defaultLatencyBuckets,
	defaultProbeCacheMs,
	defaultProbeTimeoutMs,
	isMonitorClient,
	normalizeRoute,
	parseMonitorClients,
	poolStats,
	probePostgres,
	probeRustfs,
	readBackupFreshness,
	readStorageConfig,
	requestIdFor,
	skipCheck,
	trackProcessStarts,
	withTimeout,
} from './monitoring.mjs';

const quiet = { debug() {}, info() {}, warn() {}, error() {} };

test('the probe defaults stay inside the documented budget', () => {
	assert.equal(defaultProbeTimeoutMs, 1500);
	assert.equal(defaultProbeCacheMs, 5000);
	assert.ok(defaultProbeCacheMs >= defaultProbeTimeoutMs);
});

test('checkLiveness reports uptime without touching a dependency', () => {
	const liveness = checkLiveness({ startedAtMs: 1000, now: 61_000, pid: 42, version: 'abc' });
	assert.deepEqual(liveness, {
		status: 'ok',
		checkedAt: '1970-01-01T00:01:01.000Z',
		startedAt: '1970-01-01T00:00:01.000Z',
		uptimeSeconds: 60,
		pid: 42,
		version: 'abc',
	});
});

test('checkLiveness never reports a negative uptime', () => {
	const liveness = checkLiveness({ startedAtMs: 2000, now: 1000 });
	assert.equal(liveness.uptimeSeconds, 0);
});

test('withTimeout returns the work result when it finishes in time', async () => {
	assert.equal(await withTimeout(async () => 'done', 50, 'fast'), 'done');
});

test('withTimeout rejects a hanging probe as a timeout', async () => {
	await assert.rejects(withTimeout(() => new Promise(() => {}), 10, 'PostgreSQL'), error => {
		assert.equal(error.code, 'ProbeTimeout');
		assert.match(error.message, /PostgreSQL probe did not answer within 10ms/);
		return true;
	});
});

test('withTimeout refuses a nonsensical timeout', async () => {
	await assert.rejects(withTimeout(async () => 'x', 0), /positive number of milliseconds/);
});

test('classifyProbeError keeps the category and drops the message', () => {
	const refused = Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:5432'), { code: 'ECONNREFUSED' });
	assert.deepEqual(classifyProbeError(refused), { category: 'unreachable', code: 'ECONNREFUSED' });
	assert.deepEqual(classifyProbeError(Object.assign(new Error('bad password'), { code: '28P01' })), { category: 'rejected', code: '28P01' });
	assert.deepEqual(classifyProbeError(Object.assign(new Error('no db'), { code: '3D000' })), { category: 'missing_database', code: '3D000' });
	assert.deepEqual(classifyProbeError(Object.assign(new Error('denied'), { code: '42501' })), { category: 'forbidden', code: '42501' });
	assert.deepEqual(classifyProbeError(Object.assign(new Error('aborted'), { name: 'AbortError' })), { category: 'timeout', code: 'AbortError' });
	assert.deepEqual(classifyProbeError(Object.assign(new Error('slow'), { code: 'UND_ERR_CONNECT_TIMEOUT' })), { category: 'timeout', code: 'UND_ERR_CONNECT_TIMEOUT' });
	assert.deepEqual(classifyProbeError(Object.assign(new Error('boom'), { $metadata: { httpStatusCode: 503 } })), { category: 'upstream', code: 'Http503' });
	assert.deepEqual(classifyProbeError(Object.assign(new Error('nope'), { statusCode: 403 })), { category: 'rejected', code: 'Http403' });
	assert.deepEqual(classifyProbeError(new Error('weird')), { category: 'error', code: 'Unknown' });
	const timeout = classifyProbeError(Object.assign(new Error('x'), { code: 'ProbeTimeout' }));
	assert.deepEqual(timeout, { category: 'timeout', code: 'ProbeTimeout' });
});

test('classifyProbeError never leaks the connection string', () => {
	const error = Object.assign(new Error('password authentication failed for postgres://user:secret@db:5432/app'), { code: '28P01' });
	const classified = classifyProbeError(error);
	assert.equal(JSON.stringify(classified).includes('secret'), false);
});

test('probePostgres opens one capped connection and closes it', async () => {
	const calls = [];
	class FakePool {
		constructor(options) {
			calls.push({ kind: 'constructor', options });
		}
		async query(sql) {
			calls.push({ kind: 'query', sql });
			if (sql.includes('pg_stat_activity')) {
				return { rows: [{ total: 7, idle: 4, waiting: 0 }] };
			}
			return { rows: [{ ok: 1 }], rowCount: 1 };
		}
		async end() {
			calls.push({ kind: 'end' });
		}
	}
	const result = await probePostgres({ postgres: { host: 'db', database: 'app', user: 'agent', password: 'secret' }, timeoutMs: 900, Pool: FakePool });
	assert.equal(result.ok, true);
	assert.deepEqual(result.detail, { rows: 1, serverConnections: 7, serverIdle: 4, serverWaiting: 0 });
	const options = calls.find(call => call.kind === 'constructor').options;
	assert.equal(options.max, 1);
	assert.equal(options.connectionTimeoutMillis, 900);
	assert.equal(options.query_timeout, 900);
	assert.equal(options.statement_timeout, 900);
	assert.equal(options.allowExitOnIdle, true);
	assert.equal(calls.at(-1).kind, 'end');
});

test('probePostgres closes the pool even when the query fails', async () => {
	let ended = false;
	class FailingPool {
		async query() {
			throw Object.assign(new Error('down'), { code: 'ECONNREFUSED' });
		}
		async end() {
			ended = true;
		}
	}
	await assert.rejects(probePostgres({ postgres: { host: 'db' }, Pool: FailingPool }), /down/);
	assert.equal(ended, true);
});

test('probePostgres still succeeds when the crowd query is not permitted', async () => {
	class HalfPool {
		async query(sql) {
			if (sql.includes('pg_stat_activity')) {
				throw Object.assign(new Error('permission denied'), { code: '42501' });
			}
			return { rows: [{ ok: 1 }] };
		}
		async end() {}
	}
	const result = await probePostgres({ postgres: { host: 'db' }, Pool: HalfPool });
	assert.equal(result.ok, true);
	assert.deepEqual(result.detail, { rows: 1 });
});

test('probePostgres refuses to run without connection details', async () => {
	await assert.rejects(probePostgres({}), /requires connection details/);
});

test('probeRustfs issues a bucket HEAD and destroys the client', async () => {
	const seen = [];
	class FakeClient {
		constructor(options) {
			seen.push({ kind: 'constructor', options });
		}
		async send(command) {
			seen.push({ kind: 'send', command });
			return {};
		}
		destroy() {
			seen.push({ kind: 'destroy' });
		}
	}
	const result = await probeRustfs({
		s3: { endpoint: 'http://s3:9000', bucket: 'notes', accessKeyId: 'key', secretAccessKey: 'secret' },
		timeoutMs: 800,
		S3Client: FakeClient,
	});
	assert.equal(result.ok, true);
	const options = seen.find(entry => entry.kind === 'constructor').options;
	assert.equal(options.forcePathStyle, true);
	assert.equal(options.maxAttempts, 1);
	assert.equal(options.requestHandler.requestTimeout, 800);
	assert.equal(options.credentials.accessKeyId, 'key');
	const command = seen.find(entry => entry.kind === 'send').command;
	assert.equal(command.constructor.name, 'HeadBucketCommand');
	assert.equal(command.input.Bucket, 'notes');
	assert.equal(seen.at(-1).kind, 'destroy');
});

test('probeRustfs destroys the client when the bucket is unreachable', async () => {
	let destroyed = false;
	class FailingClient {
		async send() {
			throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
		}
		destroy() {
			destroyed = true;
		}
	}
	await assert.rejects(probeRustfs({
		s3: { endpoint: 'http://127.0.0.1:1', bucket: 'notes', accessKeyId: 'k', secretAccessKey: 's' },
		S3Client: FailingClient,
	}), /ECONNREFUSED/);
	assert.equal(destroyed, true);
});

test('probeRustfs requires a complete configuration', async () => {
	await assert.rejects(probeRustfs({ s3: { endpoint: 'http://s3:9000' } }), /endpoint, bucket and access credentials/);
});

test('poolStats reads the counters of a live pool', () => {
	assert.deepEqual(poolStats({ totalCount: 3, idleCount: 2, waitingCount: 1 }), { total: 3, idle: 2, waiting: 1 });
	assert.deepEqual(poolStats({}), { total: 0, idle: 0, waiting: 0 });
	assert.equal(poolStats(undefined), undefined);
	assert.equal(poolStats('nope'), undefined);
});

test('readStorageConfig tolerates a local-directory deployment', async () => {
	const result = await readStorageConfig({});
	assert.equal(result.configured, false);
	assert.match(result.reason, /local directory backend/);
});

test('readStorageConfig reports an unreadable file instead of throwing', async () => {
	const result = await readStorageConfig({ LOG4STELLAR_STORAGE_CONFIG: join(tmpdir(), 'log4stellar-missing-config.json') });
	assert.equal(result.configured, false);
	assert.match(result.reason, /could not be read/);
});

test('readStorageConfig names the missing halves', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'log4stellar-monitor-'));
	const path = join(directory, 'storage.json');
	await writeFile(path, JSON.stringify({ postgres: { host: 'db', database: 'app', user: 'agent', password: 'secret' } }));
	const result = await readStorageConfig({ LOG4STELLAR_STORAGE_CONFIG: path });
	assert.equal(result.configured, false);
	assert.match(result.reason, /missing s3/);
});

test('readStorageConfig accepts a complete configuration', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'log4stellar-monitor-'));
	const path = join(directory, 'storage.json');
	await writeFile(path, JSON.stringify({
		postgres: { host: 'db', database: 'app', user: 'agent', password: 'secret' },
		s3: { endpoint: 'http://s3:9000', bucket: 'notes', accessKeyId: 'key', secretAccessKey: 'secret' },
	}));
	const result = await readStorageConfig({ LOG4STELLAR_STORAGE_CONFIG: path });
	assert.equal(result.configured, true);
	assert.equal(result.postgres.host, 'db');
	assert.equal(result.s3.bucket, 'notes');
});

test('checkDiskSpace converts blocks to bytes with an injectable statfs', async () => {
	const space = await checkDiskSpace('/data', {
		statfs: async () => ({ bsize: 4096, blocks: 1000, bavail: 250 }),
		now: 5000,
	});
	assert.deepEqual(space, {
		path: '/data',
		availableBytes: 250 * 4096,
		totalBytes: 1000 * 4096,
		availableRatio: 0.25,
		checkedAt: '1970-01-01T00:00:05.000Z',
	});
});

test('checkDiskSpace survives a filesystem that reports nothing', async () => {
	const space = await checkDiskSpace('/data', { statfs: async () => ({}) });
	assert.equal(space.availableBytes, 0);
	assert.equal(space.totalBytes, 0);
	assert.equal(space.availableRatio, 0);
});

test('readBackupFreshness reads the manifest next to the directory', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'log4stellar-backup-'));
	const createdAt = '2026-01-02T03:04:05.000Z';
	await writeFile(join(directory, 'manifest.json'), JSON.stringify({ format: 1, createdAt }));
	const freshness = await readBackupFreshness(directory, { now: Date.parse(createdAt) + 3600_000 });
	assert.equal(freshness.present, true);
	assert.equal(freshness.createdAt, createdAt);
	assert.equal(freshness.ageSeconds, 3600);
});

test('readBackupFreshness picks the newest dated subdirectory', async () => {
	const root = await mkdtemp(join(tmpdir(), 'log4stellar-backup-'));
	for (const [name, createdAt] of [['2026-01-01', '2026-01-01T00:00:00.000Z'], ['2026-01-02', '2026-01-02T00:00:00.000Z']]) {
		await mkdir(join(root, name));
		await writeFile(join(root, name, 'manifest.json'), JSON.stringify({ format: 1, createdAt }));
	}
	const freshness = await readBackupFreshness(root, { now: Date.parse('2026-01-03T00:00:00.000Z') });
	assert.equal(freshness.present, true);
	assert.equal(freshness.createdAt, '2026-01-02T00:00:00.000Z');
	assert.equal(freshness.ageSeconds, 86400);
});

test('readBackupFreshness reports a missing backup without throwing', async () => {
	const freshness = await readBackupFreshness(join(tmpdir(), 'log4stellar-no-backup-here'));
	assert.equal(freshness.present, false);
	assert.match(freshness.reason, /could not be read/);
	assert.equal((await readBackupFreshness(undefined)).present, false);
});

test('readBackupFreshness ignores a manifest stamped in the future', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'log4stellar-backup-'));
	await writeFile(join(directory, 'manifest.json'), JSON.stringify({ createdAt: '2030-01-01T00:00:00.000Z' }));
	const freshness = await readBackupFreshness(directory, { now: Date.parse('2026-01-01T00:00:00.000Z') });
	assert.equal(freshness.present, false);
});

test('buildReadiness is ready when every required probe passes', async () => {
	const readiness = buildReadiness({
		checks: [
			{ name: 'postgres', required: true, run: async () => ({ detail: { rows: 1 } }) },
			{ name: 'rustfs', required: true, run: async () => ({}) },
		],
		now: () => 1000,
	});
	const result = await readiness();
	assert.equal(result.status, 'ready');
	assert.equal(result.ready, true);
	assert.equal(result.degraded, false);
	assert.deepEqual(result.checks.map(check => check.status), ['up', 'up']);
	assert.equal(result.checks[0].durationMs, 0);
	assert.equal(result.cached, false);
});

test('buildReadiness is not ready when a required probe fails', async () => {
	const readiness = buildReadiness({
		checks: [{
			name: 'postgres',
			required: true,
			run: async () => {
				throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
			},
		}],
		now: () => 1000,
	});
	const result = await readiness();
	assert.equal(result.status, 'not_ready');
	assert.equal(result.ready, false);
	assert.deepEqual(result.checks[0].error, { category: 'unreachable', code: 'ECONNREFUSED' });
});

test('buildReadiness is not ready when a required probe fails', async () => {
	const readiness = buildReadiness({
		checks: [{
			name: 'postgres',
			required: true,
			run: async () => {
				throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
			},
		}],
		now: () => 1000,
	});
	const result = await readiness();
	assert.equal(result.status, 'not_ready');
	assert.equal(result.ready, false);
	assert.deepEqual(result.checks[0].error, { category: 'unreachable', code: 'ECONNREFUSED' });
	// A dependency probe reports a category and a driver code and nothing else: a driver
	// message can name the host, the user or the whole connection string.
	assert.equal(result.checks[0].reason, undefined);
});

test('a self-describing local check keeps a redacted reason', async () => {
	const readiness = buildReadiness({
		checks: [{
			name: 'disk',
			required: true,
			exposeReason: true,
			run: async () => {
				throw new Error('Only 0MiB remain on /srv/log4stellar (postgres://agent:drillpass@127.0.0.1:5432/log4stellar).');
			},
		}],
		now: () => 1000,
	});
	const result = await readiness();
	assert.equal(result.status, 'not_ready');
	assert.equal(result.checks[0].error.category, 'error');
	assert.match(result.checks[0].reason, /Only 0MiB remain on \/srv\/log4stellar/);
	// The redaction still runs, so an operator-facing sentence cannot become a leak.
	assert.doesNotMatch(result.checks[0].reason, /drillpass/);
	assert.equal(JSON.stringify(result).includes('drillpass'), false);
});

test('a self-describing local check truncates an unbounded sentence', async () => {
	const readiness = buildReadiness({
		checks: [{ name: 'backup', required: false, exposeReason: true, run: async () => { throw new Error('x'.repeat(2000)); } }],
		now: () => 1000,
	});
	const result = await readiness();
	assert.equal(result.checks[0].reason.length, 512);
});

test('buildReadiness degrades but stays ready when an optional probe fails', async () => {
	const readiness = buildReadiness({
		checks: [
			{ name: 'postgres', required: true, run: async () => ({}) },
			{ name: 'backup', required: false, run: async () => { throw new Error('stale'); } },
		],
		now: () => 0,
	});
	const result = await readiness();
	assert.equal(result.status, 'ready_degraded');
	assert.equal(result.ready, true);
	assert.equal(result.degraded, true);
});

test('buildReadiness treats a skipped probe as neither up nor a failure', async () => {
	const readiness = buildReadiness({
		checks: [{ name: 'postgres', required: true, run: async () => { throw skipCheck('local backend'); } }],
		now: () => 0,
	});
	const result = await readiness();
	assert.equal(result.ready, true);
	assert.equal(result.checks[0].status, 'skipped');
	assert.equal(result.checks[0].ok, true);
	assert.equal(result.checks[0].reason, 'local backend');
});

test('buildReadiness caches a result for the cache window', async () => {
	let calls = 0;
	let clock = 0;
	const readiness = buildReadiness({
		checks: [{ name: 'postgres', required: true, run: async () => { calls++; return {}; } }],
		cacheMs: 5000,
		now: () => clock,
	});
	assert.equal((await readiness()).cached, false);
	clock = 4000;
	const cached = await readiness();
	assert.equal(cached.cached, true);
	assert.equal(calls, 1);
	clock = 6000;
	const refreshed = await readiness();
	assert.equal(refreshed.cached, false);
	assert.equal(calls, 2);
});

test('buildReadiness caches failures too, so a dead dependency is not hammered', async () => {
	let calls = 0;
	const readiness = buildReadiness({
		checks: [{
			name: 'postgres',
			required: true,
			run: async () => {
				calls++;
				throw Object.assign(new Error('down'), { code: 'ECONNREFUSED' });
			},
		}],
		cacheMs: 5000,
		now: () => 0,
	});
	assert.equal((await readiness()).ready, false);
	assert.equal((await readiness()).ready, false);
	assert.equal(calls, 1);
});

test('buildReadiness shares one attempt between concurrent polls', async () => {
	let calls = 0;
	const readiness = buildReadiness({
		checks: [{
			name: 'postgres',
			required: true,
			run: async () => {
				calls++;
				await new Promise(resolve => setTimeout(resolve, 5));
				return {};
			},
		}],
		now: () => 0,
	});
	await Promise.all([readiness(), readiness(), readiness()]);
	assert.equal(calls, 1);
});

test('buildReadiness applies the probe timeout', async () => {
	const readiness = buildReadiness({
		checks: [{ name: 'postgres', required: true, run: () => new Promise(() => {}) }],
		timeoutMs: 10,
		now: () => 0,
	});
	const result = await readiness();
	assert.equal(result.ready, false);
	assert.deepEqual(result.checks[0].error, { category: 'timeout', code: 'ProbeTimeout' });
});

test('skipCheck tags the error the readiness builder recognises', () => {
	const error = skipCheck('nothing to probe');
	assert.equal(error.code, 'ProbeSkipped');
	assert.equal(error.message, 'nothing to probe');
});

test('the metrics registry renders the Prometheus text format', () => {
	const metrics = createMetricsRegistry({ buckets: [0.1, 1] });
	metrics.increment('log4stellar_http_requests_total', { method: 'GET', route: 'workbench', status_class: '2xx' });
	metrics.increment('log4stellar_http_requests_total', { method: 'GET', route: 'workbench', status_class: '2xx' });
	metrics.gauge('log4stellar_dependency_up', { dependency: 'postgres' }, 1);
	metrics.observe('log4stellar_http_request_duration_seconds', { method: 'GET', route: 'workbench' }, 0.05);
	metrics.observe('log4stellar_http_request_duration_seconds', { method: 'GET', route: 'workbench' }, 2);
	const text = metrics.render();
	assert.match(text, /# TYPE log4stellar_http_requests_total counter/);
	assert.match(text, /log4stellar_http_requests_total\{method="GET",route="workbench",status_class="2xx"\} 2/);
	assert.match(text, /log4stellar_dependency_up\{dependency="postgres"\} 1/);
	assert.match(text, /# TYPE log4stellar_http_request_duration_seconds histogram/);
	assert.match(text, /log4stellar_http_request_duration_seconds_bucket\{le="0.1",method="GET",route="workbench"\} 1/);
	assert.match(text, /log4stellar_http_request_duration_seconds_bucket\{le="\+Inf",method="GET",route="workbench"\} 2/);
	assert.match(text, /log4stellar_http_request_duration_seconds_sum\{method="GET",route="workbench"\} 2.05/);
	assert.match(text, /log4stellar_http_request_duration_seconds_count\{method="GET",route="workbench"\} 2/);
	assert.ok(text.endsWith('\n'));
});

test('the metrics registry sorts families and escapes label values', () => {
	const metrics = createMetricsRegistry();
	metrics.increment('zzz_total', { path: 'a"b\\c\nd' });
	metrics.increment('aaa_total');
	const text = metrics.render();
	assert.ok(text.indexOf('# TYPE aaa_total') < text.indexOf('# TYPE zzz_total'));
	assert.match(text, /zzz_total\{path="a\\"b\\\\c\\nd"\} 1/);
	assert.match(text, /^aaa_total 1$/m);
});

test('the metrics registry emits nothing for a family with no series', () => {
	const metrics = createMetricsRegistry();
	assert.equal(metrics.render(), '\n');
});

test('the default latency buckets cover a note-taking service', () => {
	assert.deepEqual([...defaultLatencyBuckets], [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]);
});

test('normalizeRoute keeps request paths out of the label space', () => {
	assert.equal(normalizeRoute('/'), 'workbench');
	assert.equal(normalizeRoute('/healthz'), 'healthz');
	assert.equal(normalizeRoute('/readyz'), 'readyz');
	assert.equal(normalizeRoute('/metrics'), 'metrics');
	assert.equal(normalizeRoute('/login'), 'login');
	assert.equal(normalizeRoute('/sync/v1/pull'), 'sync');
	assert.equal(normalizeRoute('/git/v1/repositories'), 'git');
	assert.equal(normalizeRoute('/static/mount/notes/a.md'), 'workspace_files');
	assert.equal(normalizeRoute('/static/extensions/workspace-files/main.js'), 'static_extensions');
	assert.equal(normalizeRoute('/static/build/vscode.js'), 'static_build');
	assert.equal(normalizeRoute('/out/vs/workbench/workbench.web.main.js'), 'static_workbench');
	assert.equal(normalizeRoute('/api/session/42'), 'session_api');
	assert.equal(normalizeRoute('/some/unknown/thing'), 'other');
	assert.equal(normalizeRoute(undefined), 'other');
	assert.equal(normalizeRoute('relative'), 'other');
});

test('normalizeRoute never echoes a workspace identifier', () => {
	const route = normalizeRoute('/static/mount/a-very-long-workspace-id/notes.md');
	assert.equal(route, 'workspace_files');
	assert.equal(route.includes('a-very-long-workspace-id'), false);
});

test('parseMonitorClients understands addresses, CIDR and localhost', () => {
	const parsed = parseMonitorClients('127.0.0.1, 10.1.2.0/24, localhost, 2001:db8::1');
	assert.deepEqual(parsed, [
		{ kind: 'exact', value: '127.0.0.1' },
		{ kind: 'cidr', base: ((10 << 24) | (1 << 16) | (2 << 8)) >>> 0, bits: 24 },
		{ kind: 'exact', value: '127.0.0.1' },
		{ kind: 'exact', value: '2001:db8::1' },
	]);
});

test('parseMonitorClients refuses a wide-open allowlist', () => {
	assert.deepEqual(parseMonitorClients('*'), []);
});

test('isMonitorClient always allows loopback and honours the allowlist', () => {
	assert.equal(isMonitorClient('127.0.0.1', []), true);
	assert.equal(isMonitorClient('::1', []), true);
	assert.equal(isMonitorClient('::ffff:127.0.0.1', []), true);
	assert.equal(isMonitorClient('192.0.2.233', []), false);
	const clients = parseMonitorClients('192.0.2.0/24');
	assert.equal(isMonitorClient('192.0.2.233', clients), true);
	assert.equal(isMonitorClient('198.51.100.1', clients), false);
	assert.equal(isMonitorClient(undefined, clients), false);
	assert.equal(isMonitorClient('', clients), false);
});

test('createStructuredLogger writes one UTC JSON line per event', () => {
	const lines = [];
	const logger = createStructuredLogger({ sink: line => lines.push(line), now: () => new Date('2026-05-06T07:08:09.123Z') });
	logger.info('request', { requestId: 'req-1', method: 'GET', status: 200 });
	const record = JSON.parse(lines[0]);
	assert.equal(record.ts, '2026-05-06T07:08:09.123Z');
	assert.equal(record.level, 'info');
	assert.equal(record.msg, 'request');
	assert.equal(record.requestId, 'req-1');
	assert.equal(record.status, 200);
});

test('createStructuredLogger redacts credentials and object signatures', () => {
	const lines = [];
	const logger = createStructuredLogger({ sink: line => lines.push(line), level: 'debug' });
	logger.warn('probe failed', {
		password: 'hunter2',
		connection: 'postgres://agent:hunter2@db:5432/app',
		url: 'https://s3/x?X-Amz-Signature=deadbeef&X-Amz-Credential=abc',
		authorization: 'Bearer abc',
		nested: { secretAccessKey: 'shhh' },
	});
	const line = lines[0];
	assert.equal(line.includes('hunter2'), false);
	assert.equal(line.includes('deadbeef'), false);
	assert.equal(line.includes('shhh'), false);
	assert.equal(line.includes('[redacted]'), true);
	const record = JSON.parse(line);
	assert.equal(record.password, '[redacted]');
	assert.match(record.connection, /\[redacted\]/);
});

test('createStructuredLogger truncates a runaway value', () => {
	const lines = [];
	const logger = createStructuredLogger({ sink: line => lines.push(line) });
	logger.error('boom', { stack: 'x'.repeat(2000) });
	const record = JSON.parse(lines[0]);
	assert.equal(record.stack.length, 512);
});

test('createStructuredLogger honours the level', () => {
	const lines = [];
	const logger = createStructuredLogger({ sink: line => lines.push(line), level: 'warn' });
	logger.info('ignored');
	logger.warn('kept');
	assert.equal(lines.length, 1);
	assert.match(lines[0], /"msg":"kept"/);
});

test('requestIdFor accepts a well-formed id and replaces anything else', () => {
	assert.equal(requestIdFor('abc-123_X.Y'), 'abc-123_X.Y');
	assert.match(requestIdFor(''), /^[0-9a-f-]{36}$/);
	assert.match(requestIdFor('short'), /^[0-9a-f-]{36}$/);
	assert.match(requestIdFor('bad id with spaces'), /^[0-9a-f-]{36}$/);
	assert.match(requestIdFor('x'.repeat(65)), /^[0-9a-f-]{36}$/);
	assert.match(requestIdFor(undefined), /^[0-9a-f-]{36}$/);
});

test('trackProcessStarts counts restarts across runs', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'log4stellar-state-'));
	const file = join(directory, 'starts.json');
	const first = await trackProcessStarts(file);
	const second = await trackProcessStarts(file);
	assert.deepEqual(first, { tracked: true, starts: 1 });
	assert.deepEqual(second, { tracked: true, starts: 2 });
	const state = JSON.parse(await readFile(file, 'utf8'));
	assert.equal(state.starts, 2);
	assert.match(state.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('trackProcessStarts degrades when the state file cannot be written', async () => {
	const result = await trackProcessStarts(join(tmpdir(), 'log4stellar-missing-dir', 'starts.json'));
	assert.equal(result.tracked, false);
	assert.equal(result.starts, 1);
	assert.deepEqual(await trackProcessStarts(undefined), { tracked: false, starts: 1 });
});

function context({ path = '/', method = 'GET', headers = {}, remoteAddress = '127.0.0.1', throws } = {}) {
	const set = new Map();
	return {
		path,
		method,
		state: {},
		status: 404,
		body: undefined,
		type: undefined,
		req: { socket: { remoteAddress } },
		get(name) {
			return headers[name.toLowerCase()];
		},
		set(name, value) {
			set.set(name, value);
		},
		response: {} ,
		header(name) {
			return set.get(name);
		},
		headerNames: set,
		throw: throws,
	};
}

function middlewareFor(options = {}) {
	return createMonitoring({
		environment: {},
		backend: 'local',
		workspaceId: 'ws-1',
		version: 'test',
		logger: quiet,
		checks: [
			{ name: 'postgres', required: true, run: async () => ({ detail: { rows: 1, serverConnections: 2, serverIdle: 1, serverWaiting: 0 } }) },
			{ name: 'rustfs', required: true, run: async () => ({}) },
		],
		...options,
	});
}

test('the monitoring middleware answers /healthz without a dependency', async () => {
	const middleware = middlewareFor();
	const ctx = context({ path: '/healthz' });
	await middleware(ctx, async () => {});
	assert.equal(ctx.status, 200);
	assert.equal(ctx.body.status, 'ok');
	assert.equal(typeof ctx.body.uptimeSeconds, 'number');
	assert.match(ctx.body.requestId, /^[0-9a-f-]{36}$/);
	assert.equal(ctx.header('X-Request-Id'), ctx.body.requestId);
	assert.equal(ctx.header('Cache-Control'), 'no-store');
});

test('the monitoring middleware echoes a supplied request ID', async () => {
	const middleware = middlewareFor();
	const ctx = context({ path: '/healthz', headers: { 'x-request-id': 'trace-0123456' } });
	await middleware(ctx, async () => {});
	assert.equal(ctx.body.requestId, 'trace-0123456');
	assert.equal(ctx.header('X-Request-Id'), 'trace-0123456');
});

test('the monitoring middleware answers /readyz with the per-check detail', async () => {
	const middleware = middlewareFor();
	const ctx = context({ path: '/readyz' });
	await middleware(ctx, async () => {});
	assert.equal(ctx.status, 200);
	assert.equal(ctx.body.status, 'ready');
	assert.deepEqual(ctx.body.checks.map(check => check.name), ['postgres', 'rustfs']);
	assert.equal(ctx.header('Cache-Control'), 'no-store');
});

test('the monitoring middleware fails /readyz with 503 when a dependency is down', async () => {
	const middleware = middlewareFor({
		checks: [{
			name: 'postgres',
			required: true,
			run: async () => {
				throw Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:5432'), { code: 'ECONNREFUSED' });
			},
		}],
	});
	const ctx = context({ path: '/readyz' });
	await middleware(ctx, async () => {});
	assert.equal(ctx.status, 503);
	assert.equal(ctx.body.status, 'not_ready');
	assert.deepEqual(ctx.body.checks[0].error, { category: 'unreachable', code: 'ECONNREFUSED' });
	assert.equal(JSON.stringify(ctx.body).includes('10.0.0.5'), false);
	assert.equal(typeof ctx.body.durationMs, 'number');
});

test('the monitoring middleware keeps /readyz internal', async () => {
	const middleware = middlewareFor();
	const ctx = context({ path: '/readyz', remoteAddress: '203.0.113.9' });
	await middleware(ctx, async () => {});
	assert.equal(ctx.status, 403);
	assert.deepEqual(Object.keys(ctx.body).sort(), ['error', 'requestId']);
	assert.equal(ctx.body.error, 'Forbidden');
});

test('the monitoring middleware allows a listed scrape client', async () => {
	const middleware = middlewareFor({ environment: { LOG4STELLAR_MONITOR_CLIENTS: '192.0.2.9' } });
	const ctx = context({ path: '/readyz', remoteAddress: '192.0.2.9' });
	await middleware(ctx, async () => {});
	assert.equal(ctx.status, 200);
});

test('the monitoring middleware serves /metrics as Prometheus text', async () => {
	const middleware = middlewareFor();
	const slow = context({ path: '/' });
	await middleware(slow, async () => {
		slow.status = 200;
	});
	const ctx = context({ path: '/metrics' });
	await middleware(ctx, async () => {});
	assert.equal(ctx.status, 200);
	assert.match(ctx.type, /text\/plain/);
	assert.match(ctx.body, /# TYPE log4stellar_http_requests_total counter/);
	assert.match(ctx.body, /log4stellar_http_requests_total\{method="GET",route="workbench",status_class="2xx"\} 1/);
	assert.match(ctx.body, /log4stellar_http_request_duration_seconds_count\{method="GET",route="workbench"\} 1/);
	assert.match(ctx.body, /log4stellar_dependency_up\{dependency="postgres"\} 1/);
	assert.match(ctx.body, /log4stellar_process_resident_memory_bytes \d+/);
	assert.match(ctx.body, /log4stellar_process_uptime_seconds /);
	assert.match(ctx.body, /log4stellar_build_info\{backend="local",version="test"\} 1/);
	assert.match(ctx.body, /log4stellar_pg_server_connections\{state="total"\} 2/);
	assert.match(ctx.body, /log4stellar_readiness_status\{status="ready"\} 1/);
});

test('the monitoring middleware records client and server errors separately', async () => {
	const middleware = middlewareFor();
	const notFound = context({ path: '/missing-page' });
	await middleware(notFound, async () => {
		notFound.status = 404;
	});
	const broken = context({ path: '/broken-page' });
	await middleware(broken, async () => {
		broken.status = 500;
	});
	const metrics = context({ path: '/metrics' });
	await middleware(metrics, async () => {});
	assert.match(metrics.body, /log4stellar_http_client_errors_total\{route="other"\} 1/);
	assert.match(metrics.body, /log4stellar_http_server_errors_total\{route="other"\} 1/);
	assert.match(metrics.body, /log4stellar_http_requests_total\{method="GET",route="other",status_class="4xx"\} 1/);
	assert.match(metrics.body, /log4stellar_http_requests_total\{method="GET",route="other",status_class="5xx"\} 1/);
});

test('the monitoring middleware turns a thrown error into the documented body', async () => {
	const errors = [];
	const middleware = middlewareFor({
		logger: { debug() {}, info() {}, warn() {}, error: (message, fields) => errors.push({ message, fields }) },
	});
	const ctx = context({ path: '/sync/v1/pull' });
	await assert.rejects(middleware(ctx, async () => {
		throw Object.assign(new Error('kaboom'), { code: 'ECONNRESET' });
	}), /kaboom/);
	assert.equal(ctx.status, 500);
	assert.deepEqual(Object.keys(ctx.body).sort(), ['error', 'requestId']);
	assert.equal(ctx.body.error, 'InternalError');
	assert.equal(errors.length, 1);
	assert.equal(errors[0].fields.errorCategory, 'unreachable');
	assert.equal(errors[0].fields.errorCode, 'ECONNRESET');
	assert.equal(errors[0].fields.requestId, ctx.body.requestId);
	assert.match(errors[0].fields.ts === undefined ? 'ok' : errors[0].fields.ts, /^ok$/);
});

test('the monitoring middleware rejects a write to a probe path', async () => {
	const middleware = middlewareFor();
	for (const path of ['/healthz', '/readyz', '/metrics']) {
		const ctx = context({ path, method: 'POST' });
		await middleware(ctx, async () => {
			throw new Error('the probe path must not fall through');
		});
		assert.equal(ctx.status, 405, path);
		assert.equal(ctx.header('Allow'), 'GET, HEAD');
		assert.equal(ctx.body.error, 'MethodNotAllowed');
	}
});

test('the monitoring middleware stops serving probe paths after close', async () => {
	const middleware = middlewareFor();
	const first = context({ path: '/readyz' });
	await middleware(first, async () => {});
	middleware.close();
	const second = context({ path: '/readyz' });
	await middleware(second, async () => {});
	// The cache is dropped, so the check runs again rather than answering from a cache.
	assert.equal(second.body.cached, false);
	assert.equal(second.status, 200);
});

test('the monitoring middleware feeds the gauges from a backend cache', async () => {
	const middleware = middlewareFor({
		backends: {
			stats: () => ({
				open: 2,
				opening: 1,
				limit: 8,
				pools: [{ total: 3, idle: 2, waiting: 0 }, { total: 1, idle: 1, waiting: 1 }],
			}),
		},
	});
	const ctx = context({ path: '/metrics' });
	await middleware(ctx, async () => {});
	assert.match(ctx.body, /log4stellar_workspace_backends_open 2/);
	assert.match(ctx.body, /log4stellar_workspace_backends_opening 1/);
	assert.match(ctx.body, /log4stellar_workspace_backends_limit 8/);
	assert.match(ctx.body, /log4stellar_pg_pool_connections\{state="total"\} 4/);
	assert.match(ctx.body, /log4stellar_pg_pool_connections\{state="idle"\} 3/);
	assert.match(ctx.body, /log4stellar_pg_pool_waiting 1/);
});

test('the monitoring middleware reports the disk gauges from the injected statfs', async () => {
	const middleware = middlewareFor({
		diskPath: '/data',
		statfs: async () => ({ bsize: 4096, blocks: 1000, bavail: 10 }),
		environment: { LOG4STELLAR_MONITOR_DISK_MIN_FREE_RATIO: '0.1' },
		checks: [{ name: 'disk', required: true, run: async () => ({}) }],
	});
	const ctx = context({ path: '/metrics' });
	await middleware(ctx, async () => {});
	assert.match(ctx.body, /log4stellar_disk_available_bytes\{path="\/data"\} 40960/);
	assert.match(ctx.body, /log4stellar_disk_total_bytes\{path="\/data"\} 4096000/);
	assert.match(ctx.body, /log4stellar_disk_available_ratio\{path="\/data"\} 0.01/);
	assert.match(ctx.body, /log4stellar_disk_low\{path="\/data"\} 1/);
});

test('the monitoring middleware reports backup freshness', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'log4stellar-backup-'));
	const createdAt = new Date(Date.now() - 60_000).toISOString();
	await writeFile(join(directory, 'manifest.json'), JSON.stringify({ format: 1, createdAt }));
	const middleware = middlewareFor({ backupDirectory: directory, checks: [{ name: 'backup', required: false, run: async () => ({}) }] });
	const ctx = context({ path: '/metrics' });
	await middleware(ctx, async () => {});
	assert.match(ctx.body, /log4stellar_backup_present 1/);
	assert.match(ctx.body, /log4stellar_backup_age_seconds \d+/);
});

test('the monitoring middleware exposes its collaborators for the drill harness', async () => {
	const middleware = middlewareFor();
	const state = await middleware.start();
	assert.equal(state.timeoutMs, defaultProbeTimeoutMs);
	assert.equal(state.cacheMs, defaultProbeCacheMs);
	assert.equal(typeof middleware.metrics.render, 'function');
	assert.equal(typeof middleware.readiness, 'function');
	assert.equal(typeof middleware.collectGauges, 'function');
	assert.equal(middleware.options.backend, 'local');
	assert.equal(middleware.options.workspaceId, 'ws-1');
});

test('the monitoring middleware reads its knobs from the environment', async () => {
	const middleware = middlewareFor({
		environment: {
			LOG4STELLAR_MONITOR_PROBE_TIMEOUT_MS: '250',
			LOG4STELLAR_MONITOR_PROBE_CACHE_MS: '1000',
			LOG4STELLAR_MONITOR_CLIENTS: '10.0.0.0/8',
		},
	});
	const state = await middleware.start();
	assert.equal(state.timeoutMs, 250);
	assert.equal(state.cacheMs, 1000);
	assert.equal(isMonitorClient('10.9.8.7', middleware.options.clients), true);
});

test('an invalid environment value falls back to the documented default', async () => {
	const middleware = middlewareFor({
		environment: {
			LOG4STELLAR_MONITOR_PROBE_TIMEOUT_MS: 'soon',
			LOG4STELLAR_MONITOR_PROBE_CACHE_MS: '-5',
		},
	});
	const state = await middleware.start();
	assert.equal(state.timeoutMs, defaultProbeTimeoutMs);
	assert.equal(state.cacheMs, defaultProbeCacheMs);
});
