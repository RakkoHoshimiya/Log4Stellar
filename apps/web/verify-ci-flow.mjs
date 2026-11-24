import { readdir, readFile, mkdtemp, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync, statfsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { releaseInventory } from './web-release.mjs';
import {
	analyzeSkips,
	ciPlan,
	compareWorkflowWithPlan,
	parseServerFiles,
	productionMarkers,
	summarizeInventory,
	validateWebWorkflow,
	verifyReleaseClosure,
	workflowInventory,
	assertIsolatedStorageConfig,
} from './ci-workflow.mjs';
import {
	checkToolchain,
	describeBuildResources,
	describeRepositoryBaseline,
	parseMeminfo,
	planIntegration,
	readCandidate,
	traceCandidate,
	runGit,
} from './ci-baseline.mjs';

/**
 * Rehearses the Web CI entry on the machine that is about to run it.
 *
 * The task book's acceptance criteria end with "a deliberately failing test blocks the
 * pipeline" and "failure logs are reproducible" — both are about the *entry*, not about
 * the tests. So this tool re-runs every check the workflow runs, in the same order, and
 * prints what it would publish. Nothing here needs a database unless asked, which is what
 * makes it usable in the static job.
 */

const app = dirname(fileURLToPath(import.meta.url));
const repo = resolve(app, '../..');

const args = process.argv.slice(2);
const flag = (name) => args.includes('--' + name);
const valueOf = (name) => {
	const index = args.indexOf('--' + name);
	return index >= 0 && args[index + 1] && !args[index + 1].startsWith('--') ? args[index + 1] : undefined;
};

function line(label, value) {
	console.log(`${label}: ${value}`);
}

async function staticChecks() {
	const problems = [];
	const workflowPath = join(repo, '.github/workflows/web.yml');
	if (!existsSync(workflowPath)) {
		problems.push('.github/workflows/web.yml does not exist');
	} else {
		const text = await readFile(workflowPath, 'utf8');
		const validation = validateWebWorkflow(text);
		problems.push(...validation.problems.map(problem => 'web.yml: ' + problem));
		const drift = compareWorkflowWithPlan(text);
		problems.push(...drift.problems.map(problem => 'web.yml: ' + problem));
	}

	const nvmrc = await readFile(join(repo, '.nvmrc'), 'utf8').catch(() => '');
	const toolchain = checkToolchain({ nvmrc });
	problems.push(...toolchain.problems);

	const buildText = await readFile(join(app, 'build-web-release.mjs'), 'utf8');
	const serverFiles = parseServerFiles(buildText);
	const closure = verifyReleaseClosure({
		serverFiles,
		readModule: (name) => readFileSync(join(app, name), 'utf8'),
	});
	problems.push(...closure.missing.map(name => `the release package does not list ${name}, which serve-demo.mjs imports`));
	problems.push(...closure.unknown.map(name => `the release package lists ${name}, which does not exist`));

	const workflows = [];
	const names = (await readdir(join(repo, '.github/workflows'))).filter(name => name.endsWith('.yml')).sort();
	for (const name of names) {
		workflows.push({ name, text: await readFile(join(repo, '.github/workflows', name), 'utf8') });
	}
	const inventory = workflowInventory(workflows);
	const summary = summarizeInventory(inventory);

	line('workflows', summary.total);
	line('entry workflows', summary.entries.join(', ') || '(none)');
	line('reusable workflows', summary.reusable.join(', ') || '(none)');
	line('web jobs', Object.values(ciPlan).map(job => job.name).join(', '));
	line('release package modules', closure.modules + ' reachable, ' + serverFiles.length + ' listed');
	line('node', `${(nvmrc || '').trim()} (.nvmrc), production major ${toolchain.expectedMajor}`);
	line('checks', problems.length === 0 ? 'ok' : problems.length + ' problem(s)');
	for (const problem of problems) {
		console.error('  - ' + problem);
	}
	return problems;
}

async function inventoryReport() {
	const names = (await readdir(join(repo, '.github/workflows'))).filter(name => name.endsWith('.yml')).sort();
	const files = [];
	for (const name of names) {
		files.push({ name, text: await readFile(join(repo, '.github/workflows', name), 'utf8') });
	}
	const rows = workflowInventory(files);
	const summary = summarizeInventory(rows);
	console.log('| 工作流 | 触发 | 作业 | runner 标签 |');
	console.log('|---|---|---|---|');
	for (const row of rows) {
		console.log(`| ${row.name} | ${row.triggers.join(', ')} | ${row.jobs} | ${row.runners.join(', ') || '(none)'} |`);
	}
	console.log('');
	line('total', summary.total);
	line('entries', summary.entries.length);
	line('reusable', summary.reusable.length);
	line('scheduled', summary.scheduled.join(', ') || '(none)');
	return [];
}

async function baselineReport() {
	const problems = [];
	const baseline = await describeRepositoryBaseline({
		releaseBranch: 'takeover/task1-web-workspace-switch',
	});
	line('branch', baseline.branch);
	line('commit', baseline.commit);
	line('main', baseline.main);
	line('release branch', baseline.release ?? '(none)');
	line('commits ahead of main', baseline.aheadOfMain);
	line('commits behind main', baseline.behindMain);
	line('pending branches', baseline.pending.map(entry => `${entry.branch}(+${entry.commits})`).join(', ') || '(none)');
	problems.push(...baseline.problems);

	const plan = await planIntegration({ branches: baseline.pending.map(entry => entry.branch) });
	const conflicted = plan.filter(entry => !entry.clean);
	line('integration plan', plan.map(entry => `${entry.branch}:${entry.clean ? 'clean' : 'CONFLICT'}`).join(', ') || '(none)');
	for (const entry of conflicted) {
		problems.push(`${entry.branch} conflicts with ${baseline.branch}: ${entry.conflicted.slice(0, 3).join(', ')}`);
	}
	for (const problem of problems) {
		console.error('  - ' + problem);
	}
	return problems;
}

async function isolatedStorage() {
	const problems = [];
	const source = process.env.LOG4STELLAR_STORAGE_CONFIG;
	let config;
	if (source) {
		config = JSON.parse(await readFile(source, 'utf8'));
		line('source', source);
	} else {
		config = {
			s3: {
				endpoint: process.env.LOG4STELLAR_IT_S3_ENDPOINT ?? 'http://127.0.0.1:9000',
				region: 'us-east-1',
				bucket: process.env.LOG4STELLAR_IT_S3_BUCKET ?? 'log4stellar-ci',
				accessKeyId: process.env.LOG4STELLAR_IT_S3_KEY ?? 'minioadmin',
				secretAccessKey: process.env.LOG4STELLAR_IT_S3_SECRET ?? 'minioadmin',
			},
			postgres: {
				host: process.env.LOG4STELLAR_IT_PG_HOST ?? '127.0.0.1',
				port: Number(process.env.LOG4STELLAR_IT_PG_PORT ?? 5432),
				database: process.env.LOG4STELLAR_IT_PG_DATABASE ?? 'log4stellar_ci',
				user: process.env.LOG4STELLAR_IT_PG_USER ?? 'postgres',
				password: process.env.LOG4STELLAR_IT_PG_PASSWORD ?? 'postgres',
				ssl: false,
			},
		};
		line('source', '(generated)');
	}
	const verdict = assertIsolatedStorageConfig(config);
	problems.push(...verdict.problems);
	line('postgres', `${verdict.host}/${verdict.database}`);
	line('bucket', verdict.bucket);
	if (problems.length === 0) {
		const directory = await mkdtemp(join(tmpdir(), 'l4s-ci-storage-'));
		const path = join(directory, 'workspace-storage.json');
		await writeFile(path, JSON.stringify(config, null, '\t') + '\n', { mode: 0o600 });
		line('config', path);
		console.log('export LOG4STELLAR_STORAGE_CONFIG=' + path);
	}
	for (const problem of problems) {
		console.error('  - ' + problem);
	}
	return problems;
}

async function candidateReport(directory) {
	const problems = [];
	const target = resolve(directory);
	if (!existsSync(join(target, 'release.json'))) {
		console.error('  - ' + target + ' has no release.json');
		return ['no release marker'];
	}
	const { marker, inventory } = await readCandidate(target, { releaseInventory });
	const nvmrc = await readFile(join(repo, '.nvmrc'), 'utf8').catch(() => '');
	const nvmrcMajor = Number(((nvmrc || '').trim().match(/^v?(\d+)/) ?? [])[1]);
	let commitExists;
	try {
		await runGit(['cat-file', '-e', marker.source.commit + '^{commit}'], { cwd: repo });
		commitExists = () => true;
	} catch {
		commitExists = () => false;
	}
	const traced = traceCandidate({ marker, inventory, commitExists, nvmrcMajor });
	problems.push(...traced.problems);
	line('commit', traced.commit);
	line('files', traced.files);
	line('node major', String(marker.nodeMajor));
	line('built at', String(marker.builtAt));
	line('digest', traced.digest ?? '(none: the candidate cannot be traced)');
	for (const problem of problems) {
		console.error('  - ' + problem);
	}
	return problems;
}

async function tapReport(path) {
	if (!path) {
		console.error('  - --tap needs the TAP output file written by the test job');
		return ['no TAP file'];
	}
	const text = await readFile(resolve(path), 'utf8');
	const analysis = analyzeSkips(text);
	line('skipped', String(analysis.skipped.length));
	line('unexplained skips', String(analysis.unexplained.length));
	for (const entry of analysis.skipped) {
		console.log(`  - ${entry.name}: ${entry.reason}`);
	}
	const problems = analysis.unexplained.map(name => `${name} was skipped without a reason`);
	for (const problem of problems) {
		console.error('  - ' + problem);
	}
	return problems;
}

function resourcesReport() {
	const meminfo = parseMeminfo(readFileSync('/proc/meminfo', 'utf8'));
	const stats = statfsSync(repo);
	const disk = { availableGb: Math.round((stats.bavail * stats.bsize) / 1e9) };
	const resources = describeBuildResources({ memory: meminfo, disk });
	line('available memory (MiB)', String(resources.availableMb));
	line('swap used (MiB)', `${resources.swapUsedMb}/${resources.swapTotalMb}`);
	line('disk available (GB)', String(resources.availableDiskGb));
	line('load 1m', String(resources.load1 ?? '(not sampled)'));
	for (const problem of resources.problems) {
		console.error('  - ' + problem);
	}
	return resources.problems;
}

let problems;
if (flag('inventory')) {
	problems = await inventoryReport();
} else if (flag('baseline')) {
	problems = await baselineReport();
} else if (flag('isolated-storage')) {
	problems = await isolatedStorage();
} else if (flag('candidate')) {
	problems = await candidateReport(valueOf('candidate') ?? '.');
} else if (flag('resources')) {
	problems = resourcesReport();
} else if (flag('tap')) {
	problems = await tapReport(valueOf('tap') ?? 'tap.txt');
} else if (flag('static')) {
	problems = await staticChecks();
} else {
	console.error('Usage: node apps/web/verify-ci-flow.mjs [--static | --inventory | --baseline | --isolated-storage | --resources | --candidate <dir> | --tap <file>]');
	process.exitCode = 2;
	problems = undefined;
}

if (problems && problems.length > 0) {
	process.exitCode = 1;
}
