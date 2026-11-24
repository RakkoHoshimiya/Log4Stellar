import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

/**
 * Baseline and provenance helpers for the Web CI entry.
 *
 * The task book's first requirement is to *record* which commit the release was built
 * from before anything else can be trusted: this repository's `main` is 39 commits
 * behind the branch that production runs, so "build from main" would produce a package
 * that cannot even load the Web server. Every function here takes its inputs as
 * arguments instead of reaching for the filesystem or for git, because a check that can
 * only run on the build host cannot be tested.
 */

const execFileAsync = promisify(execFile);

export const defaultGitOptions = { cwd: undefined, maxBuffer: 64 * 1024 * 1024 };

/** Runs git and returns stdout. Injected in tests so no real repository is needed. */
export async function runGit(args, { cwd } = {}) {
	const { stdout } = await execFileAsync('git', args, { ...defaultGitOptions, cwd });
	return stdout.trim();
}

export const releaseNodeMajor = 24;

export const ciRequirementIds = Object.freeze({
	baseline: 'C01',
	integration: 'C02',
	workflow: 'C03',
	candidate: 'C04',
});

/**
 * `.nvmrc` and the release marker's `nodeMajor` must agree, in that direction only:
 * the marker pins the major the release runs on, and the CI entry must install exactly
 * that major, otherwise the artifact loads under the production launcher and dies on
 * `readWebRelease()`'s nodeMajor check.
 */
export function checkToolchain({ nvmrc, releaseMarker, expectedMajor = releaseNodeMajor }) {
	const problems = [];
	const nvmrcText = typeof nvmrc === 'string' ? nvmrc.trim() : '';
	if (!/^v?\d+\.\d+\.\d+$/.test(nvmrcText)) {
		problems.push(`.nvmrc must pin an exact version, found ${JSON.stringify(nvmrcText)}`);
	}
	const nvmrcMajor = Number((nvmrcText.match(/^v?(\d+)/) ?? [])[1]);
	if (Number.isFinite(nvmrcMajor) && nvmrcMajor !== expectedMajor) {
		problems.push(`.nvmrc pins node ${nvmrcText} but the release runs on node ${expectedMajor}`);
	}
	if (releaseMarker !== undefined && releaseMarker !== null) {
		if (releaseMarker.nodeMajor !== expectedMajor) {
			problems.push(`release marker was built on node ${releaseMarker.nodeMajor} but production runs node ${expectedMajor}`);
		}
	}
	return { nvmrcMajor, expectedMajor, problems };
}

/**
 * Describes the repository baseline the way the task book asks for it: the branch that
 * is being built, the release branch, how far `main` and the release branch diverge, and
 * which branches are still pending. `aheadOfMain` is the number that matters — it is the
 * size of the unreviewed delta that production already runs.
 */
export async function describeRepositoryBaseline({ git = runGit, mainBranch = 'main', releaseBranch } = {}) {
	const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD']);
	const commit = await git(['rev-parse', 'HEAD']);
	const main = await git(['rev-parse', mainBranch]);
	const release = releaseBranch ? await git(['rev-parse', releaseBranch]) : undefined;
	const aheadOfMain = Number(await git(['rev-list', '--count', `${mainBranch}..HEAD`]));
	const behindMain = Number(await git(['rev-list', '--count', `HEAD..${mainBranch}`]));
	const pendingRaw = await git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/']);
	const pending = [];
	for (const name of pendingRaw.split('\n').map(value => value.trim()).filter(Boolean)) {
		const count = Number(await git(['rev-list', '--count', `HEAD..${name}`]));
		if (count > 0) {
			pending.push({ branch: name, commits: count });
		}
	}
	pending.sort((left, right) => left.branch.localeCompare(right.branch));

	const problems = [];
	if (releaseBranch && release !== commit) {
		problems.push(`building ${branch} (${commit.slice(0, 11)}) which is not the release branch ${releaseBranch}`);
	}
	if (behindMain > 0) {
		problems.push(`the build branch is ${behindMain} commit(s) behind ${mainBranch}`);
	}
	return {
		branch,
		commit,
		main,
		release,
		aheadOfMain,
		behindMain,
		pending,
		problems,
	};
}

/**
 * Rehearses merging every pending branch into the base without touching any ref.
 * `git merge-tree --write-tree` reports conflicts and writes nothing; using it here is
 * the difference between an integration plan and a guess.
 */
export async function planIntegration({ git = runGit, base = 'HEAD', branches = [] } = {}) {
	const plan = [];
	for (const branch of branches) {
		let output;
		let clean = true;
		try {
			output = await git(['merge-tree', '--write-tree', '--name-only', base, branch]);
		} catch (error) {
			clean = false;
			output = String(error.stderr ?? error.message ?? '').trim();
		}
		const lines = output.split('\n').map(line => line.trim()).filter(Boolean);
		// The first line of a clean run is the resulting tree object id.
		const conflicted = clean ? [] : lines.slice(1).filter(line => line && !line.startsWith('Auto-merging'));
		plan.push({ branch, clean, conflicted });
	}
	return plan;
}

/**
 * The part of a candidate that makes it traceable: which commit, which toolchain, and a
 * digest over the manifest plus the inventory. The digest is what a later auditor
 * compares against; the commit alone would accept a rebuilt package with different bytes.
 */
export function candidateDigest({ marker, inventory }) {
	const hash = createHash('sha256');
	hash.update(JSON.stringify({
		format: marker.format,
		platform: marker.platform,
		arch: marker.arch,
		nodeMajor: marker.nodeMajor,
		commit: marker.source?.commit,
		fingerprint: marker.source?.fingerprint,
	}));
	hash.update('\0');
	for (const [name, value] of [...inventory].sort(([left], [right]) => left.localeCompare(right))) {
		hash.update(name).update('\0').update(value).update('\0');
	}
	return hash.digest('hex');
}

/**
 * Traces a candidate back to a commit that exists in this repository, and refuses one
 * that was built on a different node major than production runs. `commitExists` is
 * injected so the check is testable and so callers can decide whether a shallow clone
 * should fail or warn.
 */
export function traceCandidate({ marker, inventory, commitExists, nvmrcMajor, expectedMajor = releaseNodeMajor }) {
	const problems = [];
	if (marker?.format !== 1) {
		problems.push(`release marker format must be 1, found ${JSON.stringify(marker?.format)}`);
	}
	const commit = marker?.source?.commit ?? '';
	if (!/^[0-9a-f]{40,64}$/.test(commit)) {
		problems.push(`release marker has no source commit, found ${JSON.stringify(commit)}`);
	} else if (commitExists && !commitExists(commit)) {
		problems.push(`source commit ${commit.slice(0, 11)} is not in this repository`);
	}
	const fingerprint = marker?.source?.fingerprint ?? '';
	if (!/^[0-9a-f]{64}$/.test(fingerprint)) {
		problems.push('release marker has no source fingerprint; a dirty build cannot be reproduced');
	}
	if (marker?.nodeMajor !== expectedMajor) {
		problems.push(`candidate was built on node ${marker?.nodeMajor} but production runs node ${expectedMajor}`);
	}
	if (Number.isFinite(nvmrcMajor) && nvmrcMajor !== expectedMajor) {
		problems.push(`.nvmrc pins node ${nvmrcMajor} but production runs node ${expectedMajor}`);
	}
	if (!Array.isArray(inventory) || inventory.length === 0) {
		problems.push('candidate inventory is empty');
	} else {
		const duplicate = inventory.map(([name]) => name).filter((name, index, all) => all.indexOf(name) !== index);
		if (duplicate.length > 0) {
			problems.push(`candidate inventory lists ${duplicate[0]} more than once`);
		}
	}
	return {
		commit,
		digest: problems.length === 0 ? candidateDigest({ marker, inventory }) : undefined,
		files: Array.isArray(inventory) ? inventory.length : 0,
		problems,
	};
}

/** Measures the build host so a failed build can be attributed to pressure, not to luck. */
export function describeBuildResources({ memory, disk, load, now = Date.now() }) {
	const problems = [];
	const availableMb = memory?.availableMb;
	if (Number.isFinite(availableMb) && availableMb < 2048) {
		problems.push(`only ${availableMb} MiB of memory is available; the Web bundle needs about 2 GiB`);
	}
	const swapUsedMb = memory?.swapUsedMb;
	const swapTotalMb = memory?.swapTotalMb;
	if (Number.isFinite(swapUsedMb) && Number.isFinite(swapTotalMb) && swapTotalMb > 0 && swapUsedMb / swapTotalMb > 0.9) {
		problems.push(`swap is ${Math.round((swapUsedMb / swapTotalMb) * 100)}% full; a build will thrash`);
	}
	const availableDiskGb = disk?.availableGb;
	if (Number.isFinite(availableDiskGb) && availableDiskGb < 8) {
		problems.push(`only ${availableDiskGb} GB of disk is free; a staged release needs about 3 GB`);
	}
	return {
		sampledAt: now,
		availableMb,
		swapUsedMb,
		swapTotalMb,
		availableDiskGb,
		load1: load?.one,
		problems,
	};
}

/** Reads /proc/meminfo, split into the two numbers a build actually cares about. */
export function parseMeminfo(text) {
	const value = (key) => {
		const match = text.match(new RegExp('^' + key + ':\\s+(\\d+)', 'm'));
		return match ? Math.round(Number(match[1]) / 1024) : undefined;
	};
	const totalMb = value('MemTotal');
	const availableMb = value('MemAvailable');
	const swapTotalMb = value('SwapTotal');
	const swapFreeMb = value('SwapFree');
	return {
		totalMb,
		availableMb,
		swapTotalMb,
		swapUsedMb: Number.isFinite(swapTotalMb) && Number.isFinite(swapFreeMb) ? swapTotalMb - swapFreeMb : undefined,
	};
}

/** Reads the release marker and inventory of an existing candidate directory. */
export async function readCandidate(directory, { digestFile, releaseInventory }) {
	const marker = JSON.parse(await readFile(join(directory, 'release.json'), 'utf8'));
	const inventory = await releaseInventory(directory);
	return { marker, inventory };
}

export async function fileExists(path) {
	try {
		await stat(path);
		return true;
	} catch (error) {
		if (error.code === 'ENOENT') {
			return false;
		}
		throw error;
	}
}
