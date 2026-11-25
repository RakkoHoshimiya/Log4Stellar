import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	analyzeSkips,
	ciGateJobId,
	ciJobIds,
	ciPlan,
	compareWorkflowWithPlan,
	parseServerFiles,
	parseWorkflow,
	productionMarkers,
	referencesIn,
	summarizeInventory,
	summarizeTap,
	validateWebWorkflow,
	verifyReleaseClosure,
	workflowInventory,
	assertIsolatedStorageConfig,
} from './ci-workflow.mjs';
import {
	candidateDigest,
	checkToolchain,
	describeBuildResources,
	describeRepositoryBaseline,
	parseMeminfo,
	planIntegration,
	releaseNodeMajor,
	traceCandidate,
} from './ci-baseline.mjs';

const app = dirname(fileURLToPath(import.meta.url));
const repo = resolve(app, '../..');

// A copy of the real workflow, so the tests can assert the committed file and the plan
// agree instead of asserting against a fixture that drifts.
const workflowText = await readFile(join(repo, '.github/workflows/web.yml'), 'utf8');

test('the committed Web workflow matches the CI plan', () => {
	const { problems } = compareWorkflowWithPlan(workflowText);
	assert.deepEqual(problems, []);
});

test('the committed Web workflow is valid', () => {
	const { problems } = validateWebWorkflow(workflowText);
	assert.deepEqual(problems, []);
});

test('the workflow runs on pull requests and can be started by hand', () => {
	const document = parseWorkflow(workflowText);
	assert.deepEqual(Object.keys(document.on).sort(), ['pull_request', 'push', 'workflow_dispatch']);
});

test('every Web job is a separate job so one failure cannot hide another', () => {
	const document = parseWorkflow(workflowText);
	for (const id of ciJobIds) {
		assert.ok(document.jobs[id], `missing job ${id}`);
		assert.ok(Array.isArray(document.jobs[id].steps), `${id} must have steps`);
	}
	// The unit job must not carry the integration env; that would make one green job
	// claim coverage it never ran.
	assert.ok(!JSON.stringify(document.jobs.unit).includes('LOG4STELLAR_IT'));
});

test('the gate job depends on every job and runs even when one fails', () => {
	const document = parseWorkflow(workflowText);
	const gate = document.jobs[ciGateJobId];
	assert.deepEqual([...gate.needs].sort(), [...ciJobIds].sort());
	assert.equal(gate.if, 'always()');
});

test('the integration job passes --test-concurrency=1 and starts a PostgreSQL service', () => {
	const document = parseWorkflow(workflowText);
	const job = document.jobs.integration;
	assert.ok(JSON.stringify(job.steps).includes('--test-concurrency=1'));
	assert.ok(job.services?.postgres, 'the integration job needs its own PostgreSQL');
	assert.ok(job.services?.rustfs, 'the integration job needs its own object store');
});

test('every job installs node from .nvmrc, never a literal version', () => {
	const document = parseWorkflow(workflowText);
	for (const [id, job] of Object.entries(document.jobs)) {
		if (!JSON.stringify(job).includes('actions/setup-node')) {
			continue;
		}
		assert.ok(JSON.stringify(job).includes('node-version-file'), `${id} must use node-version-file`);
	}
});

test('a workflow that could touch production is rejected', () => {
	const poisoned = workflowText.replace('LOG4STELLAR_IT=1', 'LOG4STELLAR_IT=1 LOG4STELLAR_STORAGE_CONFIG=/home/log4stellar/.config/log4stellar/workspace-storage.json');
	const { problems } = validateWebWorkflow(poisoned);
	assert.ok(problems.some(problem => problem.includes('production credential directory')), problems.join('\n'));
});

test('a workflow that names the production host is rejected', () => {
	const poisoned = workflowText.replace('--tap "$REPORT_DIR/unit.tap"', '--tap https://192.0.2.233:18990/api/session');
	const { problems } = validateWebWorkflow(poisoned);
	assert.ok(problems.some(problem => problem.includes('production host')), problems.join('\n'));
});

test('a workflow without the unit test command is rejected', () => {
	const poisoned = workflowText.replace('node --test --test-reporter=spec', 'true');
	const { problems } = validateWebWorkflow(poisoned);
	// Any of the three unit commands disappearing is drift, so the assertion is on the
	// job's command being gone rather than on one exact sentence.
	assert.ok(problems.some(problem => problem.includes('does not run')), problems.join('\n'));
});

test('a workflow without a gate job is rejected', () => {
	const start = workflowText.indexOf('  gate:');
	assert.ok(start > 0, 'the committed workflow must have a gate job');
	const text = workflowText.slice(0, start);
	const { problems } = validateWebWorkflow(text);
	assert.ok(problems.some(problem => problem.includes('no gate job')), problems.join('\n'));
});

test('an integration job without isolated services is rejected', () => {
	const text = workflowText.replace(/    services:\n(?:.*\n)*?(?=    steps:)/, '');
	const { problems } = validateWebWorkflow(text);
	assert.ok(problems.some(problem => problem.includes('must start its own PostgreSQL service')), problems.join('\n'));
});

test('the gate job refuses to pass when a required job did not succeed', async () => {
	// Runs the real gate step from web.yml, with the `${{ needs.*.result }}` expressions
	// substituted the way GitHub substitutes them. This is the check that turns four job
	// results into the single required status, so a regression here would let a red
	// pipeline report green.
	const document = parseWorkflow(workflowText);
	const step = document.jobs[ciGateJobId].steps.find(entry => typeof entry.run === 'string');
	const { execFile } = await import('node:child_process');
	const { promisify } = await import('node:util');
	const { mkdtemp, writeFile } = await import('node:fs/promises');
	const { tmpdir } = await import('node:os');
	const run = promisify(execFile);

	const directory = await mkdtemp(join(tmpdir(), 'l4s-ci-gate-'));
	const results = { static: 'success', unit: 'success', integration: 'success', browser: 'success' };

	async function gateScript(overrides) {
		const merged = { ...results, ...overrides };
		const text = step.run
			.replace(/\$\{\{\s*needs\.static\.result\s*\}\}/g, merged.static)
			.replace(/\$\{\{\s*needs\.unit\.result\s*\}\}/g, merged.unit)
			.replace(/\$\{\{\s*needs\.integration\.result\s*\}\}/g, merged.integration)
			.replace(/\$\{\{\s*needs\.browser\.result\s*\}\}/g, merged.browser);
		const path = join(directory, `gate-${Object.values(overrides).join('-') || 'ok'}.sh`);
		await writeFile(path, text, { mode: 0o700 });
		return path;
	}

	const passing = await gateScript({});
	await assert.doesNotReject(run('bash', [passing]));

	for (const [job, result] of [['static', 'failure'], ['unit', 'cancelled'], ['integration', 'skipped'], ['browser', 'failure']]) {
		const path = await gateScript({ [job]: result });
		await assert.rejects(run('bash', [path]), (error) => {
			assert.equal(error.code, 1);
			assert.match(error.stdout, new RegExp(`The Web pipeline is blocked: a required job finished as ${result}\\.`));
			return true;
		}, `a ${result} ${job} job must block the gate`);
	}
});

test('a failing test stays red while the workflow saves both reports', async () => {
	const { execFile } = await import('node:child_process');
	const { promisify } = await import('node:util');
	const { mkdir, mkdtemp, writeFile, rm } = await import('node:fs/promises');
	const { tmpdir } = await import('node:os');
	const run = promisify(execFile);
	const env = { ...process.env, REPORT_DIR: 'reports' };
	delete env.NODE_TEST_CONTEXT;
	const directory = await mkdtemp(join(tmpdir(), 'l4s-ci-red-'));
	try {
		const web = join(directory, 'apps', 'web');
		await mkdir(web, { recursive: true });
		await writeFile(join(web, 'passing.test.mjs'), "import test from 'node:test'; test('example success', () => {});");
		await writeFile(join(web, 'red.test.mjs'), "import test from 'node:test'; test('example failure', () => { throw new Error('deliberate failure'); });");
		const step = parseWorkflow(workflowText).jobs.unit.steps.find(step => step.name === 'Run the Web unit tests');
		await assert.rejects(run('bash', ['-e', '-o', 'pipefail', '-c', step.run], { cwd: directory, env }),
			{ code: 1 });
		assert.match(await readFile(join(directory, 'reports', 'unit.tap'), 'utf8'), /not ok .*example failure/);
		assert.match(await readFile(join(directory, 'reports', 'unit.log'), 'utf8'), /deliberate failure/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test('a skip with a reason is accepted and a skip without one is reported', () => {
	const tap = [
		'TAP version 13',
		'ok 1 - runs # SKIP set LOG4STELLAR_IT=1 to run the PostgreSQL integration tests',
		'ok 2 - other # SKIP',
		'ok 3 - fine',
		'not ok 4 - broken',
	].join('\n');
	const analysis = analyzeSkips(tap);
	assert.equal(analysis.skipped.length, 2);
	assert.deepEqual(analysis.unexplained, ['other']);
	assert.equal(analysis.ok, false);

	const clean = analyzeSkips('ok 1 - x # SKIP set FLAG=1');
	assert.deepEqual(clean.unexplained, []);
	assert.equal(clean.ok, true);
});

test('summarizeTap counts the outcomes a CI threshold needs', () => {
	const tap = ['ok 1 - a', 'ok 2 - b # SKIP because reasons', 'not ok 3 - c', 'ok 4 - d # SKIP'].join('\n');
	assert.deepEqual(summarizeTap(tap), { ok: 1, notOk: 1, skipped: 2, unexplainedSkips: 1 });
});

test('the workflow inventory describes every inherited workflow', async () => {
	const names = (await readdir(join(repo, '.github/workflows'))).filter(name => name.endsWith('.yml')).sort();
	const files = [];
	for (const name of names) {
		files.push({ name, text: await readFile(join(repo, '.github/workflows', name), 'utf8') });
	}
	const rows = workflowInventory(files);
	assert.equal(rows.length, names.length);
	const pr = rows.find(row => row.name === 'pr.yml');
	assert.deepEqual(pr.triggers, ['merge_group', 'pull_request']);
	const linux = rows.find(row => row.name === 'pr-linux-test.yml');
	assert.equal(linux.reusableOnly, true);
	const web = rows.find(row => row.name === 'web.yml');
	assert.deepEqual(web.triggers, ['pull_request', 'push', 'workflow_dispatch']);
});

test('the inventory summary separates entries, reusable and scheduled workflows', async () => {
	const names = (await readdir(join(repo, '.github/workflows'))).filter(name => name.endsWith('.yml')).sort();
	const files = [];
	for (const name of names) {
		files.push({ name, text: await readFile(join(repo, '.github/workflows', name), 'utf8') });
	}
	const summary = summarizeInventory(workflowInventory(files));
	assert.ok(summary.entries.includes('pr.yml'));
	assert.ok(summary.reusable.includes('pr-linux-test.yml'));
	assert.ok(summary.scheduled.includes('codeql.yml'));
	assert.ok(summary.total >= 15);
});

test('a reusable-only workflow is not listed as an entry point', () => {
	const rows = workflowInventory([
		{ name: 'a.yml', text: 'on:\n  workflow_call:\njobs:\n  x:\n    runs-on: ubuntu-24.04\n    steps: []\n' },
		{ name: 'b.yml', text: 'on:\n  pull_request:\njobs:\n  x:\n    runs-on: ubuntu-24.04\n    steps: []\n' },
	]);
	const summary = summarizeInventory(rows);
	assert.deepEqual(summary.entries, ['b.yml']);
	assert.deepEqual(summary.reusable, ['a.yml']);
});

test('the storage configuration must be loopback and must not name production', () => {
	const bad = assertIsolatedStorageConfig({
		postgres: { host: '192.0.2.9', database: 'log4stellar' },
		s3: { endpoint: 'http://192.0.2.9:9000', bucket: 'log4stellar' },
	});
	assert.ok(bad.problems.some(problem => problem.includes('production PostgreSQL')));
	assert.ok(bad.problems.some(problem => problem.includes('production database name')));
	assert.ok(bad.problems.some(problem => problem.includes('production bucket')));
	assert.ok(bad.problems.some(problem => problem.includes('production host')));

	const good = assertIsolatedStorageConfig({
		postgres: { host: '127.0.0.1', database: 'log4stellar_ci' },
		s3: { endpoint: 'http://127.0.0.1:9000', bucket: 'log4stellar-ci' },
	});
	assert.deepEqual(good.problems, []);
});

test('an incomplete storage configuration is refused instead of half-validated', () => {
	const result = assertIsolatedStorageConfig({ postgres: {}, s3: {} });
	assert.ok(result.problems.includes('the storage configuration has no postgres host'));
	assert.ok(result.problems.includes('the storage configuration has no s3 bucket'));
});

test('a non-object storage configuration is refused', () => {
	assert.deepEqual(assertIsolatedStorageConfig(null).problems, ['the storage configuration is not an object']);
});

test('the release package closure finds a module that serve-demo imports but does not list', () => {
	const modules = {
		'serve-demo.mjs': "import { openAuth } from './auth.mjs';\nimport { helper } from './forgotten.mjs';\n",
		'auth.mjs': 'export const openAuth = 1;\n',
	};
	const result = verifyReleaseClosure({
		serverFiles: ['serve-demo.mjs', 'auth.mjs'],
		readModule: (name) => {
			if (!modules[name]) {
				throw new Error('ENOENT');
			}
			return modules[name];
		},
	});
	assert.deepEqual(result.missing, ['forgotten.mjs']);
	assert.deepEqual(result.unknown, []);
});

test('the release package closure reports a listed file that does not exist', () => {
	const result = verifyReleaseClosure({
		serverFiles: ['serve-demo.mjs', 'ghost.mjs'],
		readModule: (name) => {
			if (name === 'serve-demo.mjs') {
				return '';
			}
			throw new Error('ENOENT');
		},
	});
	// A listed file that cannot be read is `unknown`, not `missing`: it is the build
	// script that is wrong about what exists, and the two are reported separately so the
	// message can say which.
	assert.deepEqual(result.missing, []);
	assert.deepEqual(result.unknown, ['ghost.mjs']);
});

test('every module the real release package lists exists and every import is listed', async () => {
	const text = await readFile(join(app, 'build-web-release.mjs'), 'utf8');
	const serverFiles = parseServerFiles(text);
	const result = verifyReleaseClosure({
		serverFiles,
		readModule: (name) => readFileSync(join(app, name), 'utf8'),
	});
	assert.deepEqual(result.missing, []);
	assert.deepEqual(result.unknown, []);
	assert.ok(result.modules > 20, `only ${result.modules} modules were reachable`);
});

import { readFileSync } from 'node:fs';

test('referencesIn reads static imports, dynamic imports and new URL file references', () => {
	const text = [
		"import { a } from './one.mjs';",
		"export { b } from './two.mjs';",
		"const three = await import('./three.mjs');",
		"const four = await readFile(new URL('./four.sql', import.meta.url), 'utf8');",
	].join('\n');
	assert.deepEqual(referencesIn(text), ['four.sql', 'one.mjs', 'three.mjs', 'two.mjs']);
});

test('referencesIn ignores package specifiers', () => {
	assert.deepEqual(referencesIn("import pg from 'pg';\nimport fs from 'node:fs';"), []);
});

test('parseServerFiles reads the array out of the build script', () => {
	const names = parseServerFiles("const serverFiles = [\n\t'a.mjs', 'b.mjs',\n];\n");
	assert.deepEqual(names, ['a.mjs', 'b.mjs']);
});

test('parseServerFiles refuses a missing, unterminated or duplicated array', () => {
	assert.throws(() => parseServerFiles('const other = 1;'), /no longer declares a serverFiles array/);
	assert.throws(() => parseServerFiles("const serverFiles = ['a.mjs'"), /not terminated/);
	assert.throws(() => parseServerFiles("const serverFiles = ['a.mjs', 'a.mjs'];"), /lists a.mjs more than once/);
	assert.throws(() => parseServerFiles('const serverFiles = [];'), /array is empty/);
});

test('the toolchain check refuses a node major that production does not run', () => {
	const bad = checkToolchain({ nvmrc: '26.13.1\n' });
	assert.ok(bad.problems.some(problem => problem.includes('release runs on node 24')), bad.problems.join('\n'));
	const weird = checkToolchain({ nvmrc: 'lts/*\n' });
	assert.ok(weird.problems.some(problem => problem.includes('must pin an exact version')));
	const good = checkToolchain({ nvmrc: '24.22.1\r\n' });
	assert.deepEqual(good.problems, []);
	assert.equal(good.nvmrcMajor, releaseNodeMajor);
});

test('the toolchain check compares the release marker against production', () => {
	const { problems } = checkToolchain({ nvmrc: '24.22.1', releaseMarker: { nodeMajor: 26 } });
	assert.ok(problems.some(problem => problem.includes('built on node 26')));
});

test('parseMeminfo reads the numbers a build cares about', () => {
	const parsed = parseMeminfo([
		'MemTotal:       12235536 kB',
		'MemAvailable:    9469684 kB',
		'SwapTotal:       4194300 kB',
		'SwapFree:        3145728 kB',
	].join('\n'));
	assert.equal(parsed.totalMb, Math.round(12235536 / 1024));
	assert.equal(parsed.availableMb, Math.round(9469684 / 1024));
	assert.equal(parsed.swapUsedMb, Math.round(4194300 / 1024) - Math.round(3145728 / 1024));
});

test('a build host under memory, swap or disk pressure is reported, not ignored', () => {
	const tight = describeBuildResources({
		memory: { availableMb: 900, swapUsedMb: 4000, swapTotalMb: 4095 },
		disk: { availableGb: 3 },
	});
	assert.ok(tight.problems.some(problem => problem.includes('memory is available')));
	assert.ok(tight.problems.some(problem => problem.includes('swap is')));
	assert.ok(tight.problems.some(problem => problem.includes('disk is free')));

	const roomy = describeBuildResources({
		memory: { availableMb: 9000, swapUsedMb: 100, swapTotalMb: 4095 },
		disk: { availableGb: 30 },
	});
	assert.deepEqual(roomy.problems, []);
});

test('the repository baseline reports how far the release branch is ahead of main', async () => {
	const answers = {
		'rev-parse --abbrev-ref HEAD': 'takeover/task1-web-workspace-switch',
		'rev-parse HEAD': 'a'.repeat(40),
		'rev-parse main': 'b'.repeat(40),
		'rev-parse release': 'a'.repeat(40),
		'rev-list --count main..HEAD': '39',
		'rev-list --count HEAD..main': '0',
		'for-each-ref --format=%(refname:short) refs/heads/': 'main\nfeat/one\nfeat/two',
		'rev-list --count HEAD..feat/one': '1',
		'rev-list --count HEAD..feat/two': '0',
	};
	const git = async (args) => answers[args.join(' ')] ?? '';
	const baseline = await describeRepositoryBaseline({ git, releaseBranch: 'release' });
	assert.equal(baseline.aheadOfMain, 39);
	assert.equal(baseline.behindMain, 0);
	assert.deepEqual(baseline.pending, [{ branch: 'feat/one', commits: 1 }]);
	assert.deepEqual(baseline.problems, []);
});

test('a build branch that is behind main, or is not the release branch, is reported', async () => {
	const answers = {
		'rev-parse --abbrev-ref HEAD': 'side',
		'rev-parse HEAD': 'c'.repeat(40),
		'rev-parse main': 'b'.repeat(40),
		'rev-parse release': 'a'.repeat(40),
		'rev-list --count main..HEAD': '0',
		'rev-list --count HEAD..main': '5',
		'for-each-ref --format=%(refname:short) refs/heads/': 'main',
		'rev-list --count HEAD..main': '5',
	};
	const git = async (args) => answers[args.join(' ')] ?? '';
	const baseline = await describeRepositoryBaseline({ git, releaseBranch: 'release' });
	assert.ok(baseline.problems.some(problem => problem.includes('not the release branch')));
	assert.ok(baseline.problems.some(problem => problem.includes('behind main')));
});

test('the integration plan rehearses merges without moving a ref', async () => {
	const git = async (args) => {
		if (args[0] === 'merge-tree') {
			if (args.at(-1) === 'feat/conflicted') {
				const error = new Error('merge conflict');
				error.stderr = 'tree-oid\nCONFLICT (content): notes/plan.md\nAuto-merging notes/plan.md\nERROR: Merge conflict in notes/plan.md';
				throw error;
			}
			return 'tree-oid';
		}
		return '';
	};
	const plan = await planIntegration({ git, branches: ['feat/clean', 'feat/conflicted'] });
	assert.equal(plan[0].clean, true);
	assert.equal(plan[1].clean, false);
	assert.ok(plan[1].conflicted.some(line => line.includes('CONFLICT')), plan[1].conflicted.join('\n'));
});

test('a clean merge-tree run reports no conflicts', async () => {
	const plan = await planIntegration({ git: async () => 'abc123', branches: ['feat/clean'] });
	assert.deepEqual(plan, [{ branch: 'feat/clean', clean: true, conflicted: [] }]);
});

test('a candidate that cannot be traced to a node-24 build is refused', () => {
	const traced = traceCandidate({
		marker: { format: 1, nodeMajor: 26, source: { commit: 'not-a-commit', fingerprint: 'short' } },
		inventory: [],
		nvmrcMajor: 24,
	});
	assert.ok(traced.problems.some(problem => problem.includes('no source commit')));
	assert.ok(traced.problems.some(problem => problem.includes('no source fingerprint')));
	assert.ok(traced.problems.some(problem => problem.includes('built on node 26')));
	assert.ok(traced.problems.some(problem => problem.includes('inventory is empty')));
	assert.equal(traced.digest, undefined);
});

test('a candidate whose commit is not in the repository is refused', () => {
	const traced = traceCandidate({
		marker: { format: 1, nodeMajor: 24, source: { commit: 'a'.repeat(40), fingerprint: 'b'.repeat(64) } },
		inventory: [['a.mjs', 'sha']],
		commitExists: () => false,
		nvmrcMajor: 24,
	});
	assert.ok(traced.problems.some(problem => problem.includes('is not in this repository')));
});

test('a well-formed candidate is digested over its manifest and inventory', () => {
	const marker = { format: 1, platform: 'linux', arch: 'x64', nodeMajor: 24, source: { commit: 'a'.repeat(40), fingerprint: 'b'.repeat(64) } };
	const inventory = [['serve-demo.mjs', 'abc'], ['auth.mjs', 'def']];
	const first = traceCandidate({ marker, inventory, nvmrcMajor: 24, commitExists: () => true });
	assert.deepEqual(first.problems, []);
	assert.match(first.digest, /^[0-9a-f]{64}$/);
	assert.equal(first.files, 2);

	// Order must not matter; a changed digest must.
	const reordered = traceCandidate({ marker, inventory: [...inventory].reverse(), nvmrcMajor: 24, commitExists: () => true });
	assert.equal(reordered.digest, first.digest);
	const changed = traceCandidate({ marker, inventory: [['serve-demo.mjs', 'abc'], ['auth.mjs', 'XYZ']], nvmrcMajor: 24, commitExists: () => true });
	assert.notEqual(changed.digest, first.digest);
});

test('a candidate marked with a future format version is refused', () => {
	const traced = traceCandidate({
		marker: { format: 2, nodeMajor: 24, source: { commit: 'a'.repeat(40), fingerprint: 'b'.repeat(64) } },
		inventory: [['a.mjs', 'sha']],
		nvmrcMajor: 24,
		commitExists: () => true,
	});
	assert.ok(traced.problems.some(problem => problem.includes('format must be 1')));
});

test('candidateDigest does not depend on the build timestamp', () => {
	const marker = { format: 1, platform: 'linux', arch: 'x64', nodeMajor: 24, builtAt: '2026-01-01T00:00:00Z', source: { commit: 'a'.repeat(40), fingerprint: 'b'.repeat(64) } };
	const inventory = [['a.mjs', 'sha']];
	const later = { ...marker, builtAt: '2026-11-24T00:00:00Z' };
	assert.equal(candidateDigest({ marker, inventory }), candidateDigest({ marker: later, inventory }));
});

test('the production markers name the deployment, not a guess', () => {
	assert.deepEqual(productionMarkers.hosts, ['192.0.2.9', '192.0.2.233']);
	assert.equal(productionMarkers.database, 'log4stellar');
	assert.ok(productionMarkers.buckets.includes('log4stellar'));
});
