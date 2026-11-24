/**
 * Reproducible load sampling for one Web instance.
 *
 * The point of this file is that the numbers in `docs/capacity.md` can be re-measured, and
 * that a regression can be attributed to a scenario rather than to "the server felt slow".
 * Every scenario is sampled separately because they compete for different resources: a
 * historical attachment download is disk and socket bound, a preview is CPU and memory
 * bound, a search is database bound, and a release build is memory bound on the same host.
 *
 * Usage:
 *   node apps/web/capacity-load.mjs --base https://127.0.0.1:18990 --scenario idle
 *   node apps/web/capacity-load.mjs --base ... --scenario download --samples 30 --concurrency 8
 *
 * The load generator never signs in on its own: pass `--cookie <value>` for an authenticated
 * scenario, or run the anonymous scenarios only. It refuses to run against a host that looks
 * like production unless `--allow-production` is given, because a load test against the live
 * deployment is an outage, not a measurement.
 */

import { request } from 'node:https';
import { performance } from 'node:perf_hooks';
import { readFileSync } from 'node:fs';

const localLoadHosts = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * The scenarios the capacity taskbook names, each with the request shape it samples.
 *
 * `anonymous` scenarios do not need a session; the rest need `--cookie`. `bytes` marks a
 * scenario that must not buffer the whole body — measuring a 200 MiB download by reading it
 * into memory would measure the load generator instead of the server.
 */
export const loadScenarios = Object.freeze({
	idle: { method: 'GET', path: '/', anonymous: true, label: '空闲（仅确认服务可连接）' },
	login: { method: 'GET', path: '/login', anonymous: true, label: '登录页首字节' },
	browse: { method: 'GET', path: '/api/session', anonymous: false, label: '登录后浏览（会话）' },
	// The path here is only a default: a download sample must name a real attachment, so
	// `--path /static/mount/<file>` replaces it. Sampling the collection itself returns
	// 400 FileIsADirectory and would look like a fast, successful measurement.
	download: { method: 'GET', path: '/static/mount/', anonymous: false, label: '历史附件下载', bytes: true, needsPath: true },
	search: { method: 'GET', path: '/search/v1?q=plan', anonymous: false, label: '全文搜索' },
	preview: { method: 'POST', path: '/api/v1/office-previews', anonymous: false, label: '后台预览入队' },
});

/** Turns a sample list into the statistics the acceptance criteria ask for. */
export function summarizeSamples(samples) {
	const values = samples.filter(value => Number.isFinite(value));
	if (values.length === 0) {
		return { count: 0, min: 0, max: 0, mean: 0, p50: 0, p95: 0, p99: 0, errors: samples.length };
	}
	const sorted = [...values].sort((left, right) => left - right);
	const at = fraction => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))];
	const mean = values.reduce((total, value) => total + value, 0) / values.length;
	return {
		count: values.length,
		min: Math.round(sorted[0]),
		max: Math.round(sorted[sorted.length - 1]),
		mean: Math.round(mean),
		p50: Math.round(at(0.5)),
		p95: Math.round(at(0.95)),
		p99: Math.round(at(0.99)),
		errors: samples.length - values.length,
	};
}

/**
 * One request, timed to first byte and to completion.
 *
 * Uses `node:https` rather than fetch so that `timeToFirstByte` is real and the body can be
 * counted without buffering it.
 */
export function measureRequest({ base, method = 'GET', path = '/', cookie, headers = {}, maxBytes = 64 * 1024 * 1024, timeoutMs = 30_000 }) {
	return new Promise(resolve => {
		const url = new URL(path, base);
		const started = performance.now();
		let firstByte = 0;
		let received = 0;
		let settled = false;
		const settle = result => {
			// Every exit path funnels through here. A body abandoned mid-stream never emits
			// `end`, so without this the promise would never resolve and the run would exit 0
			// with no report at all — which reads as "no problem found".
			if (settled) {
				return;
			}
			settled = true;
			resolve(result);
		};
		const request_ = request(url, { method, headers: { ...(cookie ? { cookie } : {}), ...headers }, rejectUnauthorized: false, timeout: timeoutMs }, response => {
			response.once('data', () => {
				firstByte = performance.now() - started;
			});
			response.on('data', chunk => {
				received += chunk.length;
				if (received > maxBytes) {
					// Stop reading rather than accumulate: the scenario measures the server, and a
					// multi-hundred-MiB body held in memory would make the generator the bottleneck.
					// The byte count is already recorded, so the truncation is reported, not hidden.
					response.destroy();
					settle({ status: response.statusCode, ttfbMs: Math.round(firstByte), totalMs: Math.round(performance.now() - started), bytes: received, truncated: true });
				}
			});
			response.on('end', () => {
				settle({
					status: response.statusCode,
					ttfbMs: Math.round(firstByte),
					totalMs: Math.round(performance.now() - started),
					bytes: received,
					truncated: received > maxBytes,
				});
			});
			response.on('error', error => {
				settle({ status: 0, ttfbMs: Math.round(firstByte), totalMs: Math.round(performance.now() - started), bytes: received, error: error.code ?? error.message });
			});
			response.on('close', () => {
				// A server that closes mid-body without an error still ends the sample.
				settle({ status: response.statusCode, ttfbMs: Math.round(firstByte), totalMs: Math.round(performance.now() - started), bytes: received, truncated: true });
			});
		});
		request_.on('timeout', () => request_.destroy(new Error('timeout')));
		request_.on('error', error => {
			settle({ status: 0, ttfbMs: -1, totalMs: Math.round(performance.now() - started), bytes: 0, error: error.code ?? error.message });
		});
		request_.end();
	});
}

/** Samples one scenario `samples` times with the given concurrency. */
export async function sampleScenario({ base, scenario, cookie, samples = 5, concurrency = 1, timeoutMs = 30_000, path: pathOverride }) {
	const declared = typeof scenario === 'string' ? loadScenarios[scenario] : scenario;
	if (!declared) {
		throw new Error(`Unknown scenario: ${String(scenario)}`);
	}
	const spec = pathOverride === undefined ? declared : { ...declared, path: pathOverride };
	// The session check comes first: without it the request is a 401, and a 401 sampled at
	// `/static/mount/<file>` says nothing about the file or the missing flag.
	if (!spec.anonymous && !cookie) {
		throw new Error(`The ${String(scenario)} scenario needs a session cookie; pass --cookie.`);
	}
	if (declared.needsPath && pathOverride === undefined) {
		throw new Error(`The ${String(scenario)} scenario must name a concrete file; pass --path /static/mount/<file>.`);
	}
	const results = [];
	let next = 0;
	async function worker() {
		for (;;) {
			const index = next;
			next += 1;
			if (index >= samples) {
				return;
			}
			results.push(await measureRequest({
				base,
				method: spec.method,
				path: spec.path,
				cookie: spec.anonymous ? undefined : cookie,
				// Download bodies are counted, never buffered, so a large ceiling costs nothing;
			// it exists to stop a runaway response, not to keep memory small.
			maxBytes: spec.bytes ? 512 * 1024 * 1024 : 64 * 1024 * 1024,
				timeoutMs,
			}));
		}
	}
	const started = performance.now();
	await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, samples)) }, worker));
	const elapsedMs = performance.now() - started;
	const ok = results.filter(result => result.status >= 200 && result.status < 400);
	return {
		scenario: typeof scenario === 'string' ? scenario : 'custom',
		label: spec.label ?? '自定义',
		status: ok.length === results.length ? 'ok' : 'mixed',
		statuses: results.reduce((counts, result) => {
			counts[result.status] = (counts[result.status] ?? 0) + 1;
			return counts;
		}, {}),
		ttfb: summarizeSamples(results.map(result => result.ttfbMs)),
		total: summarizeSamples(results.map(result => result.totalMs)),
		throughputPerSecond: Number((results.length / (elapsedMs / 1000)).toFixed(2)),
		bytes: results.reduce((total, result) => total + result.bytes, 0),
		failures: results.filter(result => result.error).map(result => ({ status: result.status, error: result.error })),
	};
}

/** Parses the flags this script accepts. Throws so a typo does not silently measure nothing. */
export function parseArguments(argv) {
	const options = { base: undefined, scenario: 'idle', samples: 5, concurrency: 1, cookie: undefined, allowProduction: false, timeoutMs: 30_000, out: undefined, path: undefined };
	for (let index = 0; index < argv.length; index += 1) {
		const flag = argv[index];
		const value = argv[index + 1];
		if (flag === '--allow-production') {
			options.allowProduction = true;
			continue;
		}
		if (!flag.startsWith('--')) {
			throw new Error(`Unexpected argument: ${flag}`);
		}
		if (value === undefined) {
			throw new Error(`${flag} needs a value`);
		}
		index += 1;
		if (flag === '--base') {
			options.base = value;
		} else if (flag === '--scenario') {
			if (!loadScenarios[value]) {
				throw new Error(`Unknown scenario: ${value}`);
			}
			options.scenario = value;
		} else if (flag === '--samples') {
			options.samples = Number(value);
		} else if (flag === '--concurrency') {
			options.concurrency = Number(value);
		} else if (flag === '--cookie') {
			options.cookie = value;
		} else if (flag === '--timeout') {
			options.timeoutMs = Number(value) * 1000;
		} else if (flag === '--path') {
			options.path = value;
		} else if (flag === '--out') {
			options.out = value;
		} else {
			throw new Error(`Unknown flag: ${flag}`);
		}
	}
	if (!options.base) {
		throw new Error('Pass --base <https://host:port>.');
	}
	if (!Number.isSafeInteger(options.samples) || options.samples <= 0) {
		throw new Error('--samples must be a positive integer.');
	}
	if (!Number.isSafeInteger(options.concurrency) || options.concurrency <= 0) {
		throw new Error('--concurrency must be a positive integer.');
	}
	return options;
}

/** Refuses to load-test the live deployment. Called before any request is made. */
export function assertNotProduction(base, { allowProduction = false } = {}) {
	const { hostname } = new URL(base);
	if (localLoadHosts.has(hostname) || allowProduction) {
		return;
	}
	throw new Error(`${hostname} is outside loopback. Use --allow-production only for an authorized test target.`);
}

export function renderReport(report) {
	const lines = [
		`# 容量采样 ${report.base}`,
		'',
		`| 场景 | 状态 | 样本 | TTFB p50 | TTFB p95 | 总计 p95 | 状态码 | 吞吐/秒 |`,
		'|---|---|---|---|---|---|---|---|',
	];
	for (const result of report.scenarios) {
		lines.push(`| ${result.label} | ${result.status} | ${result.total.count} | ${result.ttfb.p50} ms | ${result.ttfb.p95} ms | ${result.total.p95} ms | ${Object.entries(result.statuses).map(([code, count]) => `${code}×${count}`).join(' ')} | ${result.throughputPerSecond} |`);
	}
	if (report.resources) {
		lines.push('', `资源：可用 ${report.resources.availableMb} MiB / swap ${report.resources.swapUsedMb} MiB`, '');
	}
	return lines.join('\n');
}

async function main() {
	const options = parseArguments(process.argv.slice(2));
	assertNotProduction(options.base, { allowProduction: options.allowProduction });
	const resources = await readHostResources();
	const result = await sampleScenario(options);
	const report = { base: options.base, sampledAt: new Date().toISOString(), resources, scenarios: [result] };
	const text = renderReport(report);
	console.log(text);
	if (options.out) {
		const { writeFile } = await import('node:fs/promises');
		await writeFile(options.out, JSON.stringify(report, null, 2));
		console.log(`\nJSON 报告：${options.out}`);
	}
	if (result.status !== 'ok') {
		process.exitCode = 1;
	}
}

async function readHostResources() {
	try {
		const meminfo = readFileSync('/proc/meminfo', 'utf8');
		const read = name => Number((meminfo.match(new RegExp(`^${name}:\\s+(\\d+) kB`, 'm')) ?? [])[1] ?? 0) / 1024;
		return {
			availableMb: Math.round(read('MemAvailable')),
			swapTotalMb: Math.round(read('SwapTotal')),
			swapUsedMb: Math.round(read('SwapTotal') - read('SwapFree')),
		};
	} catch {
		return undefined;
	}
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
	main().catch(error => {
		console.error(error.message);
		process.exitCode = 2;
	});
}
