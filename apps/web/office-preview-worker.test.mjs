import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
	classifyConverterFailure,
	convertOfficeToPdf,
	createJobDirectory,
	jobInputPath,
	jobOutputDirectory,
	jobProfileDirectory,
	runPreviewJob,
	verifyPdfOutput,
} from './office-preview-worker.mjs';
import { officePreviewErrorCodes as codes, officePreviewLimits } from './office-preview-contract.mjs';

// §1/§4/§5 of the task book require the conversion to be a plain argument array, to run
// in a private directory and profile, to be killed as a group on timeout, and to have its
// output verified before upload. All of that is pinned here with **real child processes**
// but a *fake* converter, so the assertions are about the harness rather than LibreOffice.
// The genuine soffice run is exercised separately (office-preview-integration evidence).

const limits = officePreviewLimits({});

/** Writes an executable fake converter and returns its path. */
async function fakeConverter(body) {
	const directory = await mkdtemp(join(tmpdir(), 'l4s-fake-converter-'));
	const path = join(directory, 'fake-soffice');
	await writeFile(path, body, { mode: 0o700 });
	await chmod(path, 0o700);
	return path;
}

// Records the exact argv it received and the environment it was given, then produces a
// minimal but genuine PDF. The record lands in the output directory the worker passed.
const healthyConverter = `#!/bin/sh
outdir=""
previous=""
for argument in "$@"; do
	if [ "$previous" = "--outdir" ]; then outdir="$argument"; fi
	previous="$argument"
done
printf '%s\\n' "$@" > "$outdir/arguments.txt"
env | sort > "$outdir/environment.txt"
printf '%%PDF-1.7\\n1 0 obj\\n<<>>\\nendobj\\ntrailer\\n<<>>\\n%%%%EOF\\n' > "$outdir/document.pdf"
`;

test('the helper paths keep the input, output and profile inside the job directory', () => {
	const job = '/tmp/jobs/job-abc';
	assert.equal(jobInputPath(job, '.docx'), '/tmp/jobs/job-abc/input/document.docx');
	assert.equal(jobInputPath(job, '.xlsx'), '/tmp/jobs/job-abc/input/document.xlsx');
	assert.equal(jobOutputDirectory(job), '/tmp/jobs/job-abc/output');
	assert.equal(jobProfileDirectory(job), '/tmp/jobs/job-abc/profile');
});

test('a job directory is private, unique and under the given root', async () => {
	const base = await mkdtemp(join(tmpdir(), 'l4s-jobs-'));
	const first = await createJobDirectory(base);
	const second = await createJobDirectory(base);
	assert.notEqual(first, second);
	assert.ok(first.startsWith(join(base, 'jobs')));
	const found = await stat(first);
	assert.equal(found.isDirectory(), true);
	// The mode is what stops another local account from reading the job's input.
	assert.equal(found.mode & 0o077, 0);
});

test('the conversion command is an argument array with an isolated profile', async () => {
	const converterPath = await fakeConverter(healthyConverter);
	const jobDirectory = await mkdtemp(join(tmpdir(), 'l4s-job-'));
	const inputDirectory = join(jobDirectory, 'input');
	await mkdir(inputDirectory, { recursive: true });
	const inputPath = jobInputPath(jobDirectory, '.docx');
	await writeFile(inputPath, 'not really a docx');

	const result = await convertOfficeToPdf({
		inputPath,
		jobDirectory,
		converterPath,
		timeoutMs: limits.timeoutMs,
		maxOutputBytes: limits.maxOutputBytes,
	});
	assert.ok(result.size > 0);
	assert.match(result.sha256, /^[0-9a-f]{64}$/);

	// The exact argv shape from the task book, and every path inside the job directory.
	const argv = (await readFile(join(jobOutputDirectory(jobDirectory), 'arguments.txt'), 'utf8')).trim().split('\n');
	const profileDirectory = jobProfileDirectory(jobDirectory);
	assert.equal(argv[0], `-env:UserInstallation=file://${profileDirectory}`);
	assert.deepEqual(argv.slice(1), [
		'--headless',
		'--norestore',
		'--nolockcheck',
		'--nodefault',
		'--nofirststartwizard',
		'--nologo',
		'--convert-to',
		'pdf:writer_pdf_Export',
		'--outdir',
		jobOutputDirectory(jobDirectory),
		inputPath,
	]);
	// Nothing that looks like a shell metacharacter got a chance to be interpreted: the
	// input is a fixed name this module wrote, and it arrived as one argv entry.
	assert.equal(argv.at(-1), inputPath);
});

test('the child gets a minimal environment with no storage credentials', async () => {
	const converterPath = await fakeConverter(healthyConverter);
	const jobDirectory = await mkdtemp(join(tmpdir(), 'l4s-job-'));
	await mkdir(join(jobDirectory, 'input'), { recursive: true });
	await writeFile(jobInputPath(jobDirectory, '.docx'), 'x');
	await convertOfficeToPdf({
		inputPath: jobInputPath(jobDirectory, '.docx'),
		jobDirectory,
		converterPath,
		timeoutMs: limits.timeoutMs,
		maxOutputBytes: limits.maxOutputBytes,
		// A polluted parent environment must not reach the child.
		environment: {
			PATH: '/usr/local/bin:/usr/bin:/bin',
			LOG4STELLAR_STORAGE_CONFIG: '/home/log4stellar/.config/log4stellar/workspace-storage.json',
			LOG4STELLAR_S3_SECRET: 'super-secret',
			AWS_SECRET_ACCESS_KEY: 'also-secret',
		},
	});
	const environment = await readFile(join(jobOutputDirectory(jobDirectory), 'environment.txt'), 'utf8');
	assert.doesNotMatch(environment, /LOG4STELLAR_/);
	assert.doesNotMatch(environment, /super-secret|also-secret/);
	assert.match(environment, /SAL_USE_VCLPLUGIN=svp/);
	assert.match(environment, new RegExp('HOME=' + jobProfileDirectory(jobDirectory)));
	assert.match(environment, new RegExp('TMPDIR=' + jobDirectory));
});

test('a timeout kills the process group and reports PreviewTimeout', async () => {
	// The fake converter outlives the timeout, so this only returns if the worker kills
	// the group; a plain child.kill() would also work here, but the group kill is what
	// removes LibreOffice's helpers.
	const converterPath = await fakeConverter('#!/bin/sh\nsleep 30\n');
	const jobDirectory = await mkdtemp(join(tmpdir(), 'l4s-job-'));
	await mkdir(join(jobDirectory, 'input'), { recursive: true });
	await writeFile(jobInputPath(jobDirectory, '.docx'), 'x');
	const started = Date.now();
	await assert.rejects(
		convertOfficeToPdf({
			inputPath: jobInputPath(jobDirectory, '.docx'),
			jobDirectory,
			converterPath,
			timeoutMs: 150,
			maxOutputBytes: limits.maxOutputBytes,
		}),
		error => error.code === codes.timeout && error.status === 504,
	);
	// The deadline, not the child, decided when this finished.
	assert.ok(Date.now() - started < 10_000);
});

test('a converter that writes nothing is classified from its output', async () => {
	// An unexplained failure stays retryable; the permanent classifications are covered
	// by the `classifyConverterFailure` cases below.
	const converterPath = await fakeConverter('#!/bin/sh\necho "Error: something unexpected happened" >&2\nexit 1\n');
	const jobDirectory = await mkdtemp(join(tmpdir(), 'l4s-job-'));
	await mkdir(join(jobDirectory, 'input'), { recursive: true });
	await writeFile(jobInputPath(jobDirectory, '.docx'), 'x');
	await assert.rejects(
		convertOfficeToPdf({
			inputPath: jobInputPath(jobDirectory, '.docx'),
			jobDirectory,
			converterPath,
			timeoutMs: limits.timeoutMs,
			maxOutputBytes: limits.maxOutputBytes,
		}),
		error => error.code === codes.unavailable && error.retryable === true,
	);
});

test('a converter that produces a non PDF is rejected before upload', async () => {
	const converterPath = await fakeConverter('#!/bin/sh\noutdir=""\nprevious=""\nfor argument in "$@"; do\n\tif [ "$previous" = "--outdir" ]; then outdir="$argument"; fi\n\tprevious="$argument"\ndone\nprintf "PK\\003\\004 not a pdf" > "$outdir/document.pdf"\n');
	const jobDirectory = await mkdtemp(join(tmpdir(), 'l4s-job-'));
	await mkdir(join(jobDirectory, 'input'), { recursive: true });
	await writeFile(jobInputPath(jobDirectory, '.docx'), 'x');
	await assert.rejects(
		convertOfficeToPdf({
			inputPath: jobInputPath(jobDirectory, '.docx'),
			jobDirectory,
			converterPath,
			timeoutMs: limits.timeoutMs,
			maxOutputBytes: limits.maxOutputBytes,
		}),
		error => error.status === 502,
	);
});

test('an output above the budget is rejected', async () => {
	const converterPath = await fakeConverter(healthyConverter);
	const jobDirectory = await mkdtemp(join(tmpdir(), 'l4s-job-'));
	await mkdir(join(jobDirectory, 'input'), { recursive: true });
	await writeFile(jobInputPath(jobDirectory, '.docx'), 'x');
	await assert.rejects(
		convertOfficeToPdf({
			inputPath: jobInputPath(jobDirectory, '.docx'),
			jobDirectory,
			converterPath,
			timeoutMs: limits.timeoutMs,
			maxOutputBytes: 32,
		}),
		error => error.status === 413 && error.code === codes.resourceLimit,
	);
});

test('verifyPdfOutput accepts only a genuine PDF inside the budget', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'l4s-verify-'));
	const good = join(directory, 'good.pdf');
	await writeFile(good, '%PDF-1.7\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');
	const verified = await verifyPdfOutput(good, { maxOutputBytes: 1024 });
	assert.ok(verified.size > 0);
	assert.match(verified.sha256, /^[0-9a-f]{64}$/);

	const fake = join(directory, 'fake.pdf');
	await writeFile(fake, 'PK\u0003\u0004 this is a docx');
	await assert.rejects(verifyPdfOutput(fake, { maxOutputBytes: 1024 }), error => error.status === 502);

	const empty = join(directory, 'empty.pdf');
	await writeFile(empty, '');
	await assert.rejects(verifyPdfOutput(empty, { maxOutputBytes: 1024 }), error => error.status === 502);

	const huge = join(directory, 'huge.pdf');
	await writeFile(huge, '%PDF-1.7\n' + 'x'.repeat(2048));
	await assert.rejects(verifyPdfOutput(huge, { maxOutputBytes: 1024 }), error => error.status === 413);

	await assert.rejects(verifyPdfOutput(join(directory, 'missing.pdf'), { maxOutputBytes: 1024 }), error => error.code === 'ENOENT');
});

test('converter failures are classified into actionable, non retryable codes', () => {
	// A password protected document cannot be retried into working.
	assert.deepEqual(
		classifyConverterFailure({ stderr: 'Error: source file could not be decrypted', exitCode: 1 }),
		{ code: codes.passwordProtected, retryable: false },
	);
	assert.deepEqual(
		classifyConverterFailure({ stderr: 'Error: Please verify input parameters...', exitCode: 1 }),
		{ code: codes.corruptSource, retryable: false },
	);
	// "impl_store … Error Area:Io" is what a truncated OOXML produces.
	assert.deepEqual(
		classifyConverterFailure({ stderr: 'SfxBaseModel::impl_store failed: 0xc10(Error Area:Io Class:Write Code:16)', exitCode: 1 }),
		{ code: codes.corruptSource, retryable: false },
	);
	// Environmental problems are transient and may be retried within the cap.
	assert.deepEqual(
		classifyConverterFailure({ stderr: 'write error: No space left on device', exitCode: 1 }),
		{ code: codes.resourceLimit, retryable: true },
	);
	assert.deepEqual(
		classifyConverterFailure({ stderr: 'Killed', exitCode: -1 }),
		{ code: codes.unavailable, retryable: true },
	);
	// A timeout is final: the file did not finish within a budget that was chosen for it.
	assert.deepEqual(classifyConverterFailure({ timedOut: true }), { code: codes.timeout, retryable: false });
});

test('runPreviewJob writes the original, converts, uploads and cleans up', async () => {
	const converterPath = await fakeConverter(healthyConverter);
	const base = await mkdtemp(join(tmpdir(), 'l4s-run-'));
	const objectKey = 'office-previews/ab/' + 'a'.repeat(64) + '/11111111-1111-4111-8111-111111111111.pdf';
	let uploadedBytes;
	let uploadLimit;
	const blobs = {
		async put(key, source, limit) {
			assert.equal(key, objectKey);
			uploadLimit = limit;
			const chunks = [];
			for await (const chunk of source) {
				chunks.push(chunk);
			}
			uploadedBytes = Buffer.concat(chunks);
			return { key, size: uploadedBytes.length, sha256: 'b'.repeat(64) };
		},
	};
	const result = await runPreviewJob({
		job: { extension: '.docx', objectKey, maxInputBytes: limits.maxInputBytes },
		openSource: async () => Buffer.from('original document bytes'),
		blobs,
		converterPath,
		timeoutMs: limits.timeoutMs,
		maxOutputBytes: limits.maxOutputBytes,
		cacheDirectory: base,
	});
	assert.equal(result.objectKey, objectKey);
	assert.equal(result.size, uploadedBytes.length);
	assert.match(uploadedBytes.subarray(0, 5).toString('latin1'), /^%PDF-/);
	assert.equal(uploadLimit, limits.maxOutputBytes);
	// The job directory (input copy, profile, output) is removed even on success.
	const remaining = await readdir(join(base, 'jobs'));
	assert.deepEqual(remaining, []);
});

test('runPreviewJob removes the job directory and uploads nothing on failure', async () => {
	const converterPath = await fakeConverter('#!/bin/sh\nexit 1\n');
	const base = await mkdtemp(join(tmpdir(), 'l4s-run-'));
	let put = false;
	const blobs = { async put() { put = true; throw new Error('must not upload'); } };
	await assert.rejects(
		runPreviewJob({
			job: { extension: '.docx', objectKey: 'office-previews/ab/' + 'a'.repeat(64) + '/11111111-1111-4111-8111-111111111111.pdf', maxInputBytes: limits.maxInputBytes },
			openSource: async () => Buffer.from('original'),
			blobs,
			converterPath,
			timeoutMs: limits.timeoutMs,
			maxOutputBytes: limits.maxOutputBytes,
			cacheDirectory: base,
		}),
		error => error.code === codes.unavailable,
	);
	assert.equal(put, false);
	assert.deepEqual(await readdir(join(base, 'jobs')), []);
});

test('a source that grew past the input budget is refused before conversion', async () => {
	// A fake converter that would succeed if it were ever started: the assertion is that
	// it is not, because the bounded copy happens first.
	const converterPath = await fakeConverter(healthyConverter);
	const base = await mkdtemp(join(tmpdir(), 'l4s-run-'));
	const blobs = { async put() { throw new Error('must not upload'); } };
	await assert.rejects(
		runPreviewJob({
			job: { extension: '.docx', objectKey: 'office-previews/ab/' + 'a'.repeat(64) + '/11111111-1111-4111-8111-111111111111.pdf', maxInputBytes: 4 },
			openSource: async () => Buffer.from('much more than four bytes'),
			blobs,
			converterPath,
			timeoutMs: limits.timeoutMs,
			maxOutputBytes: limits.maxOutputBytes,
			cacheDirectory: base,
		}),
		error => error.status === 413 && error.code === codes.fileTooLarge,
	);
	assert.deepEqual(await readdir(join(base, 'jobs')), []);
});
