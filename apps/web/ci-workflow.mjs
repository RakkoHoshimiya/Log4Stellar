import { load } from 'js-yaml';

/**
 * The Web CI contract.
 *
 * The task book asks for two things that are easy to fake and hard to keep: an inventory
 * of what the existing workflows actually trigger on, and *one* explicit entry for the
 * Web package. Both are encoded here as data plus pure checks, so the workflow file, the
 * local rehearsal and the tests cannot drift apart without a test failing.
 *
 * Nothing in this module reaches the filesystem: callers pass the YAML text and the file
 * lists in. That keeps it usable from a unit test, from the CI job that validates the
 * workflow, and from a laptop.
 */

/** The single source of truth for what the Web jobs run. `web.yml` must match it. */
export const ciPlan = Object.freeze({
	static: Object.freeze({
		name: 'Web / Static',
		requiredCommands: Object.freeze([
			// The static job syntax-checks every server module; naming one file here would
			// let a new module skip the check.
			'node --check',
			'node apps/web/verify-ci-flow.mjs --static',
		]),
	}),
	unit: Object.freeze({
		name: 'Web / Unit',
		requiredCommands: Object.freeze([
			'pnpm install --frozen-lockfile',
			// TAP is captured to a file so the next step can prove that every skip carries a
			// reason; a silent skip of a gated suite is indistinguishable from a pass.
			'node --test --test-reporter=tap --test-reporter-destination=web-tap.txt apps/web/*.test.mjs',
			'node --test apps/web/*.test.mjs',
			'node apps/web/verify-ci-flow.mjs --tap web-tap.txt',
		]),
	}),
	integration: Object.freeze({
		name: 'Web / Integration',
		requiredCommands: Object.freeze([
			'pnpm install --frozen-lockfile',
			'node apps/web/verify-ci-flow.mjs --isolated-storage',
			'LOG4STELLAR_IT=1 node --test --test-concurrency=1 apps/web/*.test.mjs',
		]),
	}),
	browser: Object.freeze({
		name: 'Web / Browser',
		requiredCommands: Object.freeze([
			'pnpm install --frozen-lockfile',
			'pnpm exec playwright install --with-deps chromium',
			'LOG4STELLAR_BROWSER_IT=1 node --test apps/web/*.browser.test.mjs',
		]),
	}),
});

export const ciJobIds = Object.freeze(Object.keys(ciPlan));

/** Gate job that turns four job results into one required check. */
export const ciGateJobId = 'gate';

/**
 * Places that only exist in production. A test job that mentions any of these is a test
 * job that can write to real user data, so the workflow is rejected instead of warned.
 */
export const productionMarkers = Object.freeze({
	hosts: Object.freeze(['192.0.2.9', '192.0.2.233']),
	buckets: Object.freeze(['log4stellar']),
	database: 'log4stellar',
	accountDir: '/home/log4stellar/.config/log4stellar',
	authDir: '/home/log4stellar/.cache/log4stellar-demo/auth',
});

/** Parses a workflow file. YAML 1.2 keeps `on` a string, which is what we need. */
export function parseWorkflow(text, name = 'workflow') {
	const document = load(text);
	if (!document || typeof document !== 'object' || Array.isArray(document)) {
		throw new TypeError(`${name} is not a workflow mapping`);
	}
	return document;
}

function triggerNames(on) {
	if (typeof on === 'string') {
		return [on];
	}
	if (Array.isArray(on)) {
		return on.map(String);
	}
	if (on && typeof on === 'object') {
		return Object.keys(on);
	}
	return [];
}

function runnerLabels(document) {
	const labels = new Set();
	for (const job of Object.values(document.jobs ?? {})) {
		const runsOn = job?.['runs-on'];
		if (typeof runsOn === 'string') {
			labels.add(runsOn);
		} else if (Array.isArray(runsOn)) {
			for (const label of runsOn) {
				labels.add(String(label));
			}
		}
		if (typeof job?.uses === 'string') {
			labels.add('reusable:' + job.uses);
		}
	}
	return [...labels].sort();
}

/** One row per workflow file: what triggers it, where it runs, how big it is. */
export function workflowInventory(files) {
	return files.map(({ name, text }) => {
		const document = parseWorkflow(text, name);
		const jobs = document.jobs ?? {};
		const labels = runnerLabels(document);
		return {
			name,
			title: document.name ?? name,
			triggers: triggerNames(document.on).sort(),
			jobs: Object.keys(jobs).length,
			runners: labels,
			// Every label in this repository is a GitHub-hosted runner or a custom larger
			// runner registered on GitHub. Naming them is the useful fact; guessing which
			// machine a label resolves to is not something a static check can know, and an
			// earlier version of this row wrongly called `vscode-large-runners-*` local.
			hosted: labels.length === 0 || labels.every(label => !label.startsWith('self-hosted')),
			hasPermissionsBlock: Object.hasOwn(document, 'permissions'),
			reusableOnly: triggerNames(document.on).length === 1 && triggerNames(document.on)[0] === 'workflow_call',
		};
	});
}

/**
 * Summarises the inventory the way the task book asks: which workflows are entry points,
 * which are reusable, which are scheduled, and how many are inherited from upstream.
 */
export function summarizeInventory(rows) {
	const entries = rows.filter(row => row.triggers.some(trigger => trigger === 'pull_request' || trigger === 'push')).map(row => row.name);
	const scheduled = rows.filter(row => row.triggers.includes('schedule')).map(row => row.name);
	const manual = rows.filter(row => row.triggers.includes('workflow_dispatch')).map(row => row.name);
	const reusable = rows.filter(row => row.reusableOnly).map(row => row.name);
	return {
		total: rows.length,
		entries: entries.sort(),
		scheduled: scheduled.sort(),
		manual: manual.sort(),
		reusable: reusable.sort(),
		inherited: rows.filter(row => !row.name.startsWith('web.')).length,
	};
}

function stepCommands(document) {
	const commands = [];
	for (const job of Object.values(document.jobs ?? {})) {
		for (const step of job?.steps ?? []) {
			if (typeof step?.run === 'string') {
				commands.push({ job: undefined, run: step.run });
			}
		}
	}
	return commands;
}

function commandsOfJob(job) {
	const commands = [];
	for (const step of job?.steps ?? []) {
		if (typeof step?.run === 'string' || Array.isArray(step?.run)) {
			const run = Array.isArray(step.run) ? step.run.join('\n') : step.run;
			commands.push(run);
		}
	}
	return commands;
}

/** Every string anywhere in the document, for the production-marker scan. */
function stringsOf(value, out = []) {
	if (typeof value === 'string') {
		out.push(value);
	} else if (Array.isArray(value)) {
		for (const item of value) {
			stringsOf(item, out);
		}
	} else if (value && typeof value === 'object') {
		for (const [key, item] of Object.entries(value)) {
			out.push(key);
			stringsOf(item, out);
		}
	}
	return out;
}

/**
 * Rejects a Web CI entry that could touch production, that installs whatever node it
 * finds, or that runs the integration suite without the connection budget it needs.
 */
export function validateWebWorkflow(text, { plan = ciPlan, markers = productionMarkers } = {}) {
	const document = parseWorkflow(text, 'web.yml');
	const problems = [];

	const triggers = triggerNames(document.on);
	if (!triggers.includes('pull_request')) {
		problems.push('the Web workflow must run on pull_request');
	}
	if (!triggers.includes('workflow_dispatch')) {
		problems.push('the Web workflow must be startable by hand (workflow_dispatch)');
	}
	if (document.permissions?.contents !== 'read') {
		problems.push('the Web workflow must declare permissions: contents: read');
	}

	const jobs = document.jobs ?? {};
	for (const id of ciJobIds) {
		const job = jobs[id];
		if (!job) {
			problems.push(`the Web workflow has no ${id} job`);
			continue;
		}
		const commands = commandsOfJob(job);
		const joined = commands.join('\n');
		for (const required of plan[id].requiredCommands) {
			if (!joined.includes(required)) {
				problems.push(`the ${id} job does not run: ${required}`);
			}
		}
		const runsOn = job['runs-on'];
		const label = Array.isArray(runsOn) ? runsOn.join(' ') : runsOn;
		if (!/^ubuntu-\d+\.\d+$/.test(String(label ?? ''))) {
			problems.push(`the ${id} job must pin an ubuntu runner label, found ${JSON.stringify(label)}`);
		}
		if (id === 'integration') {
			if (!/--test-concurrency=1/.test(joined)) {
				problems.push('the integration job must pass --test-concurrency=1; the test role allows 10 connections');
			}
			if (!job.services || Object.keys(job.services).length === 0) {
				problems.push('the integration job must start its own PostgreSQL service');
			}
		}
		if (id === 'browser' && !/LOG4STELLAR_BROWSER_IT=1/.test(joined)) {
			problems.push('the browser job must set LOG4STELLAR_BROWSER_IT=1');
		}
	}

	const gate = jobs[ciGateJobId];
	if (!gate) {
		problems.push('the Web workflow has no gate job to report a single check');
	} else {
		const needed = Array.isArray(gate.needs) ? gate.needs : [gate.needs].filter(Boolean);
		const missing = ciJobIds.filter(id => !needed.includes(id));
		if (missing.length > 0) {
			problems.push(`the gate job must depend on ${missing.join(', ')}`);
		}
		if (!/always\(\)/.test(JSON.stringify(gate))) {
			problems.push('the gate job must run with if: always() so a failed job still reports');
		}
	}

	// Node comes from .nvmrc everywhere: a job that installs "node" is a job that will
	// one day install 26 while production runs 24 and the release refuses to load.
	const nodeSteps = (document.jobs ?? {});
	for (const [id, job] of Object.entries(nodeSteps)) {
		const text = JSON.stringify(job);
		const hasSetup = /actions\/setup-node/.test(text);
		if (hasSetup && !/node-version-file/.test(text)) {
			problems.push(`the ${id} job installs node without node-version-file: .nvmrc`);
		}
		if (/node-version:\s*['"]?(?!.*nvmrc)/.test(text) && /actions\/setup-node/.test(text) && !/node-version-file/.test(text)) {
			problems.push(`the ${id} job pins node by literal version; use .nvmrc`);
		}
	}

	for (const value of stringsOf(document)) {
		for (const host of markers.hosts) {
			if (value.includes(host)) {
				problems.push(`the Web workflow mentions a production host (${host}): ${value.slice(0, 80)}`);
			}
		}
		if (value.includes(markers.accountDir) || value.includes(markers.authDir)) {
			problems.push(`the Web workflow mentions a production credential directory: ${value.slice(0, 80)}`);
		}
	}

	const shared = jobs.unit;
	if (shared && /LOG4STELLAR_IT=1/.test(JSON.stringify(shared))) {
		problems.push('the unit job must not run the integration suite; keep it a separate job');
	}

	return { problems, triggers, jobs: Object.keys(jobs) };
}

/**
 * The storage configuration a test job is allowed to use. Anything that points at the
 * production cluster, database or bucket is refused: the integration suite creates
 * workspaces, uploads objects and deletes them.
 */
export function assertIsolatedStorageConfig(config, { markers = productionMarkers } = {}) {
	const problems = [];
	if (!config || typeof config !== 'object') {
		return { problems: ['the storage configuration is not an object'] };
	}
	const postgres = config.postgres ?? {};
	const s3 = config.s3 ?? {};
	const host = String(postgres.host ?? '');
	const bucket = String(s3.bucket ?? '');
	const database = String(postgres.database ?? '');
	const endpoint = String(s3.endpoint ?? '');

	if (!host) {
		problems.push('the storage configuration has no postgres host');
	} else if (markers.hosts.includes(host)) {
		problems.push(`the storage configuration points at production PostgreSQL ${host}`);
	} else if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
		problems.push(`the storage configuration postgres host must be loopback in CI, found ${host}`);
	}
	if (!database) {
		problems.push('the storage configuration has no postgres database');
	} else if (database === markers.database) {
		problems.push(`the storage configuration uses the production database name ${database}`);
	}
	if (!bucket) {
		problems.push('the storage configuration has no s3 bucket');
	} else if (markers.buckets.includes(bucket)) {
		problems.push(`the storage configuration uses the production bucket ${bucket}`);
	}
	for (const [label, value] of [['postgres', host], ['s3 endpoint', endpoint]]) {
		for (const marker of markers.hosts) {
			if (value.includes(marker)) {
				problems.push(`the storage configuration ${label} mentions production host ${marker}`);
			}
		}
	}
	return { problems, host, database, bucket };
}

/**
 * The release package is a hand-written list of file names. Every import of
 * `serve-demo.mjs` must be listed or the packaged server fails at startup — which is
 * exactly the class of bug that only shows up on the deployment host.
 */
export function verifyReleaseClosure({ serverFiles, readModule }) {
	const listed = new Set(serverFiles);
	const missing = new Set();
	const visited = new Set();
	const queue = ['serve-demo.mjs'];
	while (queue.length > 0) {
		const name = queue.shift();
		if (visited.has(name)) {
			continue;
		}
		visited.add(name);
		let text;
		try {
			text = readModule(name);
		} catch {
			missing.add(name);
			continue;
		}
		for (const specifier of referencesIn(text)) {
			if (!listed.has(specifier)) {
				missing.add(specifier);
			}
			if (!visited.has(specifier)) {
				queue.push(specifier);
			}
		}
	}
	const unknown = serverFiles.filter(name => {
		try {
			readModule(name);
			return false;
		} catch {
			return true;
		}
	});
	return { missing: [...missing].sort(), unknown: unknown.sort(), modules: visited.size };
}

/** Relative module specifiers and `new URL('./x', import.meta.url)` file references. */
export function referencesIn(text) {
	const names = new Set();
	for (const match of text.matchAll(/(?:^|[\s;])(?:import|export)[^'"]*?from\s*['"](\.\/[^'"]+)['"]/g)) {
		names.add(match[1].slice(2));
	}
	for (const match of text.matchAll(/import\s*\(\s*['"](\.\/[^'"]+)['"]\s*\)/g)) {
		names.add(match[1].slice(2));
	}
	for (const match of text.matchAll(/new URL\(\s*['"](\.\/[^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g)) {
		names.add(match[1].slice(2));
	}
	for (const match of text.matchAll(/readFile\(\s*join\(\s*app\s*,\s*['"]([^'"]+)['"]/g)) {
		names.add(match[1]);
	}
	return [...names].sort();
}

/**
 * Reads the `serverFiles` array out of the build script. The build script cannot be
 * imported for this: it builds on import, which is why the list is parsed as text.
 */
export function parseServerFiles(text) {
	const start = text.indexOf('const serverFiles = [');
	if (start < 0) {
		throw new Error('build-web-release.mjs no longer declares a serverFiles array');
	}
	const end = text.indexOf('];', start);
	if (end < 0) {
		throw new Error('the serverFiles array is not terminated');
	}
	const body = text.slice(start, end);
	const names = [...body.matchAll(/'([^']+)'/g)].map(match => match[1]);
	if (names.length === 0) {
		throw new Error('the serverFiles array is empty');
	}
	const duplicate = names.filter((name, index) => names.indexOf(name) !== index);
	if (duplicate.length > 0) {
		throw new Error(`the serverFiles array lists ${duplicate[0]} more than once`);
	}
	return names;
}

/**
 * Reads TAP output and reports every skip that came without a reason.
 *
 * A skip without a reason is the CI failure mode this repository has already paid for:
 * five integration suites and the browser suite are gated on environment variables, and
 * a run that silently skips them looks exactly like a run that passed them. TAP puts the
 * reason after `# SKIP `; the assertion here is that the text after it is not empty.
 */
export function analyzeSkips(tapText) {
	const skipped = [];
	const unexplained = [];
	for (const line of tapText.split('\n')) {
		const match = line.match(/^\s*ok\s+\d+\s+-\s+(.*?)\s+#\s*SKIP\b\s*(.*)$/);
		if (!match) {
			continue;
		}
		const [, name, reason] = match;
		skipped.push({ name, reason });
		if (!reason.trim()) {
			unexplained.push(name);
		}
	}
	return { skipped, unexplained, ok: unexplained.length === 0 };
}

/** Counts the test outcomes a TAP stream reports, so a CI job can assert thresholds. */
export function summarizeTap(tapText) {
	const counts = { ok: 0, notOk: 0, skipped: 0, unexplainedSkips: 0 };
	for (const line of tapText.split('\n')) {
		const ok = line.match(/^\s*ok\s+\d+\s+-\s+/);
		if (ok) {
			if (/#\s*SKIP\b/.test(line)) {
				counts.skipped += 1;
				if (!/#\s*SKIP\b\s*\S/.test(line)) {
					counts.unexplainedSkips += 1;
				}
			} else {
				counts.ok += 1;
			}
			continue;
		}
		if (/^\s*not ok\s+\d+\s+-\s+/.test(line)) {
			counts.notOk += 1;
		}
	}
	return counts;
}

/** Compares the committed workflow against the plan; any drift is a failure. */
export function compareWorkflowWithPlan(text, { plan = ciPlan } = {}) {
	const document = parseWorkflow(text, 'web.yml');
	const problems = [];
	const jobs = document.jobs ?? {};
	for (const id of ciJobIds) {
		const job = jobs[id];
		if (!job) {
			problems.push(`the workflow has no ${id} job`);
			continue;
		}
		const joined = commandsOfJob(job).join('\n');
		for (const command of plan[id].requiredCommands) {
			if (!joined.includes(command)) {
				problems.push(`the ${id} job has drifted from the plan: missing ${JSON.stringify(command)}`);
			}
		}
		if (job.name !== plan[id].name) {
			problems.push(`the ${id} job is named ${JSON.stringify(job.name)}, the plan says ${JSON.stringify(plan[id].name)}`);
		}
	}
	return { problems };
}

export { stepCommands };
