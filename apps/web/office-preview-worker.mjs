// The conversion worker (05-Office文件预览.md §2, §4, §5).
//
// Everything that touches a child process lives here. The rules from the task book are
// enforced structurally rather than by convention:
//
//   * the command is an **argument array**, never a shell string, so a file name can
//     never become an option or a second command;
//   * every job runs in its **own temporary directory** with its **own LibreOffice
//     user profile** (`-env:UserInstallation=file://…`), so a hostile document cannot
//     read another job's state and a crashed profile cannot poison the next run;
//   * the child gets a minimal environment with **no storage credentials**, so a
//     document that manages to run something cannot reach PostgreSQL or the bucket;
//   * the process group is killed on timeout, so `soffice`'s helper processes cannot
//     outlive the job and keep writing;
//   * the output is verified (`%PDF-` magic *and* the size budget) before the caller is
//     allowed to upload it, so a failed conversion can never publish a half written or
//     oversized object.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkspaceError } from './workspace-contract.mjs';
import { officePreviewErrorCodes as codes, looksLikePdf } from './office-preview-contract.mjs';

/** Where the input copy lives inside one job directory. */
export function jobInputPath(jobDirectory, extension) {
	return join(jobDirectory, 'input', 'document' + extension);
}

export function jobOutputDirectory(jobDirectory) {
	return join(jobDirectory, 'output');
}

export function jobProfileDirectory(jobDirectory) {
	return join(jobDirectory, 'profile');
}

/**
 * Maps what LibreOffice prints to a user facing classification (§4). The raw text is
 * used only for this decision: it is never returned to a client and never stored, so a
 * message that happens to contain a path cannot leak through an error response.
 */
export function classifyConverterFailure({ stderr = '', stdout = '', timedOut = false, exitCode = 0 }) {
	const text = `${stdout}\n${stderr}`;
	if (timedOut) {
		return { code: codes.timeout, retryable: false };
	}
	// A password protected OOXML file cannot be decrypted without the password, so a
	// retry would fail identically.
	if (/password|encrypted|EncryptedPackage|could not be decrypted/i.test(text)) {
		return { code: codes.passwordProtected, retryable: false };
	}
	// "Please verify input parameters" / "SfxBaseModel::impl_store … Error Area:Io" is
	// what a truncated or hand built zip produces: the document is broken, and a retry
	// would fail the same way.
	// "source file could not be loaded" is what LibreOffice 24.2 prints for a zip that
	// is not a valid OOXML package; the 0xc1x / impl_store family is the same class of
	// failure from the store side.
	if (/input parameters|impl_store|general input\/output error|is not a valid|could not be loaded|corrupt|zip/i.test(text)) {
		return { code: codes.corruptSource, retryable: false };
	}
	if (/no space left|cannot allocate|out of memory|disk quota/i.test(text)) {
		return { code: codes.resourceLimit, retryable: true };
	}
	// An unexplained non-zero exit is treated as transient: the contract says a
	// temporary fault gets a bounded number of retries, and a permanent one burns
	// through the attempt cap and stops.
	return { code: codes.unavailable, retryable: true };
}

function statusFor(code) {
	switch (code) {
		case codes.corruptSource:
		case codes.passwordProtected:
			// The document itself is the problem, so 415 matches "unsupported content"
			// rather than "server broke".
			return 415;
		case codes.resourceLimit:
			return 413;
		case codes.timeout:
			return 504;
		default:
			return 503;
	}
}

function killProcessGroup(child) {
	const pid = child?.pid;
	if (!pid) {
		return;
	}
	try {
		// A negative pid targets the whole group created by `detached: true`.
		process.kill(-pid, 'SIGKILL');
	} catch {
		try {
			process.kill(pid, 'SIGKILL');
		} catch {
			// Already gone.
		}
	}
}

/**
 * §1 `convertOfficeToPdf`. Runs one conversion in an already prepared job directory.
 *
 * Returns `{ outputPath, size, sha256, durationMs }`. The caller owns the job
 * directory and removes it (also on failure) — see `runPreviewJob`.
 */
export async function convertOfficeToPdf({
	inputPath,
	jobDirectory,
	converterPath,
	timeoutMs,
	maxOutputBytes,
	environment = process.env,
}) {
	const outputDirectory = jobOutputDirectory(jobDirectory);
	const profileDirectory = jobProfileDirectory(jobDirectory);
	await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
	await mkdir(profileDirectory, { recursive: true, mode: 0o700 });

	// The argument array *is* the security boundary: no shell, no interpolation, and
	// the input path is a fixed name this module wrote itself.
	const args = [
		`-env:UserInstallation=file://${profileDirectory}`,
		'--headless',
		'--norestore',
		'--nolockcheck',
		'--nodefault',
		'--nofirststartwizard',
		'--nologo',
		'--convert-to',
		'pdf:writer_pdf_Export',
		'--outdir',
		outputDirectory,
		inputPath,
	];

	// A minimal, credential free environment. HOME points into the job directory so
	// nothing can reach the service account's own LibreOffice state, and no
	// LOG4STELLAR_* variable is forwarded.
	const childEnvironment = {
		PATH: environment.PATH ?? '/usr/local/bin:/usr/bin:/bin',
		HOME: profileDirectory,
		TMPDIR: jobDirectory,
		LANG: 'C.UTF-8',
		LC_ALL: 'C.UTF-8',
		SAL_USE_VCLPLUGIN: 'svp',
	};

	const started = Date.now();
	const result = await new Promise(resolve => {
		let child;
		try {
			child = spawn(converterPath, args, {
				cwd: jobDirectory,
				env: childEnvironment,
				stdio: ['ignore', 'pipe', 'pipe'],
				// Its own process group, so a timeout can take down the helper processes
				// LibreOffice forks instead of leaving them writing into the output.
				detached: true,
			});
		} catch (error) {
			resolve({ exitCode: -1, stderr: `spawn failed: ${error.code ?? error.message}`, stdout: '', timedOut: false, child: undefined });
			return;
		}
		let stdout = '';
		let stderr = '';
		let timedOut = false;
		let settled = false;
		// Keep only a tail: a broken document can make LibreOffice print a lot, and this
		// text is only used for classification.
		const keep = (previous, chunk) => {
			const text = previous + chunk.toString('utf8');
			return text.length > 8192 ? text.slice(-8192) : text;
		};
		const finish = (exitCode, signal) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			resolve({ exitCode, signal, stdout, stderr, timedOut, child });
		};
		child.stdout?.on('data', chunk => { stdout = keep(stdout, chunk); });
		child.stderr?.on('data', chunk => { stderr = keep(stderr, chunk); });
		child.on('error', error => {
			stderr = keep(`${stderr}\nspawn failed: ${error.code ?? error.message}`, '');
			finish(-1, undefined);
		});
		child.on('close', (exitCode, signal) => finish(exitCode ?? -1, signal));
		const timer = setTimeout(() => {
			timedOut = true;
			killProcessGroup(child);
		}, timeoutMs);
	});

	const durationMs = Date.now() - started;
	// Always kill the group: `soffice` sometimes leaves a `soffice.bin` behind even after
	// a successful exit, and a leftover would hold the profile directory open.
	killProcessGroup(result.child);

	if (result.timedOut) {
		throw new WorkspaceError(statusFor(codes.timeout), codes.timeout);
	}

	const outputPath = join(outputDirectory, 'document.pdf');
	let outputStat;
	try {
		outputStat = await stat(outputPath);
	} catch (error) {
		if (error.code !== 'ENOENT') {
			throw error;
		}
		outputStat = undefined;
	}

	if (!outputStat || outputStat.size === 0) {
		const failure = classifyConverterFailure({
			stdout: result.stdout,
			stderr: result.stderr,
			exitCode: result.exitCode,
		});
		const error = new WorkspaceError(statusFor(failure.code), failure.code);
		error.retryable = failure.retryable;
		throw error;
	}

	// §4 "转换输出必须校验是有效 PDF，并复核大小" — magic plus budget.
	if (outputStat.size > maxOutputBytes) {
		const error = new WorkspaceError(413, codes.resourceLimit);
		error.retryable = true;
		throw error;
	}
	const verified = await verifyPdfOutput(outputPath, { maxOutputBytes });
	return {
		outputPath,
		size: verified.size,
		sha256: verified.sha256,
		durationMs,
		stdout: result.stdout,
		stderr: result.stderr,
	};
}

/**
 * §5 `verifyPdfOutput`: a file is publishable only when it is a PDF and inside the
 * output budget. Anything else counts as a failed attempt, so a partial render is never
 * served and the cache never accounts for bytes that are not a document.
 */
export async function verifyPdfOutput(path, { maxOutputBytes }) {
	const found = await stat(path);
	if (!found.isFile() || found.size === 0) {
		throw new WorkspaceError(502, codes.unavailable);
	}
	if (found.size > maxOutputBytes) {
		throw new WorkspaceError(413, codes.resourceLimit);
	}
	const whole = await readFile(path);
	if (!looksLikePdf(whole.subarray(0, 8), found.size, maxOutputBytes)) {
		throw new WorkspaceError(502, codes.unavailable);
	}
	const sha256 = createHash('sha256').update(whole).digest('hex');
	return { size: found.size, sha256 };
}

/** A private job directory per attempt, under the preview cache root. */
export async function createJobDirectory(baseDirectory = tmpdir()) {
	const parent = join(baseDirectory, 'jobs');
	await mkdir(parent, { recursive: true, mode: 0o700 });
	return mkdtemp(join(parent, 'job-'));
}

/**
 * Runs one claimed job end to end: write the original bytes into the job directory,
 * convert, verify, upload to the attempt specific key, and always remove the job
 * directory. The caller owns the database transitions, so this function is testable
 * with a fake source reader, a fake converter and a fake blob store.
 */
export async function runPreviewJob({
	job,
	openSource,
	blobs,
	converterPath,
	timeoutMs,
	maxOutputBytes,
	cacheDirectory,
}) {
	const jobDirectory = await createJobDirectory(cacheDirectory);
	try {
		const inputPath = jobInputPath(jobDirectory, job.extension);
		await mkdir(dirname(inputPath), { recursive: true, mode: 0o700 });
		const buffer = await openSource();
		if (!buffer) {
			throw new WorkspaceError(404, codes.notFound);
		}
		// The copy is bounded by the input budget: a source that grew (or a version row
		// that lies about its size) is rejected before LibreOffice ever sees it.
		if (buffer.length > job.maxInputBytes) {
			const error = new WorkspaceError(413, codes.fileTooLarge);
			error.retryable = false;
			throw error;
		}
		await writeFile(inputPath, buffer, { mode: 0o600 });
		const converted = await convertOfficeToPdf({
			inputPath,
			jobDirectory,
			converterPath,
			timeoutMs,
			maxOutputBytes,
		});
		const upload = await blobs.put(job.objectKey, createReadStream(converted.outputPath), maxOutputBytes);
		return {
			objectKey: job.objectKey,
			size: upload.size,
			sha256: upload.sha256,
			durationMs: converted.durationMs,
		};
	} finally {
		await rm(jobDirectory, { recursive: true, force: true }).catch(() => {});
	}
}
