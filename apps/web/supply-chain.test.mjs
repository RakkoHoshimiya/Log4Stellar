import assert from 'node:assert/strict';
import test from 'node:test';
import { X509Certificate } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, chmod, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	checkCredentialPermissions,
	checkLicenseArtifacts,
	checkPinnedVersions,
	checkSeparationOfDuties,
	checkTlsCertificate,
	credentialModes,
	credentialSensitivity,
	describeCredentialInventory,
	licenseObligations,
	operationalCapabilities,
	renderSupplyChainReport,
	scanDocuments,
	scanForSecrets,
	secretPatterns,
} from './supply-chain.mjs';

// The inventory is the contract between this module and the deployment: if a
// path moves, the audit must move with it instead of silently reporting "ok".
test('the inventory covers every credential the deployment actually uses', () => {
	const entries = describeCredentialInventory({
		configDir: '/plant/config',
		authDir: '/plant/auth',
		demoDir: '/plant/demo',
	});
	const ids = entries.map(entry => entry.id);
	assert.deepEqual(ids, [
		'account-database-directory',
		'account-database',
		'auth-secret',
		'git-signing-key',
		'storage-config',
		'web-clients',
		'blob-spool',
		'tls-private-key',
		'tls-certificate',
	]);
	for (const entry of entries) {
		// An entry without a rotation story is exactly the credential that gets
		// forgotten for two years, so the field is mandatory rather than optional.
		assert.ok(entry.purpose.length > 0, entry.id + ' has no purpose');
		assert.ok(entry.rotation.length > 0, entry.id + ' has no rotation plan');
		assert.ok(entry.responsible.length > 0, entry.id + ' has no responsible party');
		assert.ok(Object.values(credentialSensitivity).includes(entry.sensitivity));
		assert.ok(entry.path.startsWith('/plant/'), entry.id + ' escaped the plant root: ' + entry.path);
	}
	const metadata = entries.filter(entry => entry.sensitivity === credentialSensitivity.secret).map(entry => entry.id);
	assert.deepEqual(metadata, ['auth-secret', 'git-signing-key', 'storage-config', 'tls-private-key']);
});

test('file modes are compared against the sensitivity class, not a global default', async () => {
	const entries = [
		{ id: 'secret', path: '/p/secret', sensitivity: credentialSensitivity.secret, required: true },
		{ id: 'config', path: '/p/config', sensitivity: credentialSensitivity.config, required: true },
		{ id: 'dir', path: '/p/dir', sensitivity: credentialSensitivity.directory, required: true },
	];
	const observed = {
		'/p/secret': { mode: 0o100600, isFile: true, isDirectory: false, size: 32 },
		'/p/config': { mode: 0o100644, isFile: true, isDirectory: false, size: 32 },
		'/p/dir': { mode: 0o40700, isDirectory: true, isFile: false, size: 4096 },
	};
	const result = await checkCredentialPermissions(entries, async path => observed[path]);
	assert.equal(result.checked, 3);
	// The config file is the only one that drifted from 0600.
	assert.deepEqual(
		result.problems.map(problem => [problem.id, problem.kind]),
		[['config', 'Mode']],
	);
	assert.match(result.problems[0].detail, /expected 0600 but found 0644/);
	assert.equal(credentialModes.directory, '700');
});

test('a missing required credential fails the audit while an optional one does not', async () => {
	const entries = [
		{ id: 'needed', path: '/p/needed', sensitivity: credentialSensitivity.secret, required: true },
		{ id: 'optional', path: '/p/optional', sensitivity: credentialSensitivity.config, required: false },
	];
	const result = await checkCredentialPermissions(entries, async () => undefined);
	assert.equal(result.checked, 0);
	assert.deepEqual(
		result.problems.map(problem => [problem.id, problem.kind]),
		[['needed', 'Missing']],
	);
});

test('an empty secret file is reported instead of being accepted as a mode match', async () => {
	const entries = [{ id: 'secret', path: '/p/secret', sensitivity: credentialSensitivity.secret, required: true }];
	const result = await checkCredentialPermissions(entries, async () => ({
		mode: 0o100600,
		isFile: true,
		isDirectory: false,
		size: 0,
	}));
	assert.deepEqual(
		result.problems.map(problem => problem.kind),
		['Empty'],
	);
});

test('a directory declared as a file, or the reverse, is a type problem', async () => {
	const entries = [
		{ id: 'dir', path: '/p/dir', sensitivity: credentialSensitivity.directory, required: true },
		{ id: 'file', path: '/p/file', sensitivity: credentialSensitivity.secret, required: true },
	];
	const result = await checkCredentialPermissions(entries, async path =>
		path === '/p/dir'
			? { mode: 0o100700, isFile: true, isDirectory: false, size: 1 }
			: { mode: 0o100600, isFile: false, isDirectory: true, size: 1 },
	);
	// With the modes still correct for their declared class, the only thing wrong
	// is the type, so exactly two findings are reported.
	assert.deepEqual(
		result.problems.map(problem => [problem.id, problem.kind]).sort(),
		[
			['dir', 'Type'],
			['file', 'Type'],
		],
	);
});

test('a type swap reports the mode problem too, because each finding must stand alone', async () => {
	const entries = [
		{ id: 'dir', path: '/p/dir', sensitivity: credentialSensitivity.directory, required: true },
		{ id: 'file', path: '/p/file', sensitivity: credentialSensitivity.secret, required: true },
	];
	const result = await checkCredentialPermissions(entries, async path =>
		path === '/p/dir'
			? { mode: 0o100644, isFile: true, isDirectory: false, size: 1 }
			: { mode: 0o100600, isFile: false, isDirectory: true, size: 1 },
	);
	assert.deepEqual(
		result.problems.map(problem => [problem.id, problem.kind]).sort(),
		[
			['dir', 'Mode'],
			['dir', 'Type'],
			['file', 'Type'],
		],
	);
});

const certificatePair = async () => {
	const directory = await mkdtemp(join(tmpdir(), 'l4s-tls-'));
	execFileSync('openssl', [
		'req',
		'-x509',
		'-newkey',
		'rsa:2048',
		'-nodes',
		'-keyout',
		join(directory, 'server.key'),
		'-out',
		join(directory, 'server.crt'),
		'-days',
		'2',
		'-subj',
		'/CN=Log4Stellar Test',
	]);
	return directory;
};

test('certificate expiry is measured in whole days against the supplied clock', async () => {
	const directory = await certificatePair();
	try {
		const pem = await readFile(join(directory, 'server.crt'));
		const parsed = new X509Certificate(pem);
		const result = checkTlsCertificate({ certificate: pem, now: Date.parse(parsed.validFrom), warnBeforeDays: 30 });
		// The test certificate is issued for two days, so it is already inside the
		// default warning window on the day it is issued.
		assert.ok(result.daysRemaining <= 2);
		assert.equal(result.problems.length, 1);
		assert.match(result.problems[0], /inside the 30 day warning window/);
		assert.match(result.subject, /Log4Stellar Test/);
		// A narrow window on the issue date leaves nothing to report.
		assert.deepEqual(checkTlsCertificate({ certificate: pem, now: Date.parse(parsed.validFrom), warnBeforeDays: 1 }).problems, []);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test('an expired certificate is reported as expired rather than as a warning', async () => {
	const directory = await certificatePair();
	try {
		const pem = await readFile(join(directory, 'server.crt'));
		const parsed = new X509Certificate(pem);
		const result = checkTlsCertificate({ certificate: pem, now: Date.parse(parsed.validTo) + 3 * 86_400_000 });
		assert.equal(result.daysRemaining, -3);
		assert.match(result.problems[0], /expired 3 day\(s\) ago/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test('the expiry check rejects a nonsense clock instead of silently passing', async () => {
	const directory = await certificatePair();
	try {
		const pem = await readFile(join(directory, 'server.crt'));
		assert.throws(() => checkTlsCertificate({ certificate: pem, now: Number.NaN }), /now must be a finite timestamp/);
		assert.throws(
			() => checkTlsCertificate({ certificate: pem, warnBeforeDays: -1 }),
			/warnBeforeDays must be a non-negative integer/,
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test('pinned versions report drift and absence separately', () => {
	const result = checkPinnedVersions({
		packageManifest: {
			packageManager: 'pnpm@12.16.0',
			dependencies: { pg: '8.23.1', 'better-auth': '^1.7.27' },
		},
		expected: { packageManager: 'pnpm@12.16.0', pg: '8.23.1', 'better-auth': '1.7.27', 'qrcode-generator': '2.0.4' },
	});
	// A caret range defeats pinning and an absent package is a different problem,
	// so both must be reported, and the pinned ones must stay quiet.
	assert.equal(result.problems.length, 2);
	assert.equal(result.checked, 4);
	assert.deepEqual(
		result.problems.map(problem => [problem.name, problem.kind]).sort(),
		[
			['better-auth', 'Drift'],
			['qrcode-generator', 'Missing'],
		],
	);
});

test('the real apps/web manifest matches the versions the release was built from', async () => {
	const manifest = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'));
	const expected = {
		'@aws-sdk/client-s3': '3.1173.0',
		'@node-rs/argon2': '2.2.2',
		'@vscode/test-web': '0.0.81',
		'better-auth': '1.7.27',
		pg: '8.23.1',
		'qrcode-generator': '2.0.4',
	};
	const result = checkPinnedVersions({ packageManifest: manifest, expected });
	assert.deepEqual(result.problems, []);
	assert.equal(result.checked, 6);
});

test('every shipped dependency carries a license obligation', () => {
	const components = licenseObligations.map(entry => entry.component).join('|');
	for (const name of ['Code - OSS', '@vscode/test-web', 'vscode-oniguruma', '@node-rs/argon2', 'better-auth', 'pg', '@aws-sdk/client-s3', 'LibreOffice']) {
		assert.ok(components.includes(name), 'no obligation recorded for ' + name);
	}
	for (const entry of licenseObligations) {
		assert.ok(entry.license.length > 0, entry.component + ' has no license');
		assert.ok(entry.obligation.length > 0, entry.component + ' has no obligation');
	}
	// The only non-MIT dependency matters: distributing it without the Apache
	// text is a compliance break, so the entry must say so explicitly.
	const apache = licenseObligations.find(entry => entry.component === '@aws-sdk/client-s3');
	assert.equal(apache.license, 'Apache-2.0');
	assert.match(apache.obligation, /Apache-2\.0/);
});

test('missing license artifacts fail the check', () => {
	const result = checkLicenseArtifacts({
		files: [
			{ name: 'LICENSE.txt', present: true },
			{ name: 'ThirdPartyNotices.txt', present: false },
		],
	});
	assert.deepEqual(
		result.problems.map(problem => [problem.name, problem.kind]),
		[['ThirdPartyNotices.txt', 'Missing']],
	);
	assert.equal(result.checked, 2);
});

test('the secret scanner finds each pattern class and redacts what it reports', () => {
	const text = [
		'const harmless = "nothing here";',
		'const key = "-----BEGIN RSA PRIVATE KEY-----";',
		'aws_access_key_id = "AKIAIOSFODNN7EXAMPLE"',
		'password = "hunter2hunter2"',
		'endpoint http://svc:s3cr3tpass@192.0.2.9:9000',
	].join('\n');
	const result = scanForSecrets({ name: 'notes.md', text });
	const ids = result.findings.map(finding => finding.pattern).sort();
	assert.deepEqual(ids, ['assigned-credential', 'aws-access-key', 'private-key', 'url-credential']);
	for (const finding of result.findings) {
		assert.equal(finding.document, 'notes.md');
		// Redaction must never reproduce the matched secret in full.
		assert.ok(!finding.preview.includes('hunter2'), 'preview leaked the secret: ' + finding.preview);
		assert.ok(!finding.preview.includes('s3cr3tpass'), 'preview leaked the secret: ' + finding.preview);
		assert.ok(!finding.preview.includes('AKIAIOSFODNN7EXAMPLE'), 'preview leaked the secret: ' + finding.preview);
	}
	const password = result.findings.find(finding => finding.pattern === 'assigned-credential');
	assert.equal(password.line, 4);
	assert.match(password.preview, /^hunt…\/14$/);
});

test('line and column point at the real location in a multi-line document', () => {
	const text = 'line one\nline two\nline three\n-----BEGIN OPENSSH PRIVATE KEY-----\n';
	const result = scanForSecrets({ name: 'a.log', text });
	assert.equal(result.findings.length, 1);
	assert.equal(result.findings[0].line, 4);
	assert.equal(result.findings[0].column, 1);
});

test('allow entries suppress only the exact value they name', () => {
	const text = 'token = "documented-fake-value"\npassword = "real-production-password"';
	const result = scanForSecrets({ name: 'doc.md', text, allow: ['documented-fake-value'] });
	assert.equal(result.allowlisted, 1);
	assert.equal(result.findings.length, 1);
	assert.match(result.findings[0].preview, /^real/);
});

test('a hexadecimal digest alone is reported, because a 64 character hex run is a key', () => {
	const text = 'value: ' + 'a'.repeat(64);
	const result = scanForSecrets({ name: 'x.txt', text });
	assert.deepEqual(
		result.findings.map(finding => finding.pattern),
		['hex-64'],
	);
});

test('a build log source fingerprint is provenance, not a leaked key', () => {
	const digest = '5e3e0ca94fff32562eb97b8da5ac197a422055efe38b6f6349ee87b628685755';
	const text = 'Source: 68444cbfe14af816e0f6ead7db0c3660fe568fcc (' + digest + ')\n';
	const aggregate = scanDocuments({ documents: [{ name: 'release-build.log', text }] });
	assert.deepEqual(aggregate.findings, []);
	assert.equal(aggregate.ok, true);
	// The same digest anywhere else is still a finding: the suppression must be
	// scoped to the provenance line, not to the value. A `token: <digest>` shape
	// trips both the digest rule and the assignment rule, which is correct.
	const stray = scanDocuments({ documents: [{ name: 'stray.txt', text: 'token: ' + digest }] });
	assert.deepEqual(
		stray.findings.map(finding => finding.pattern).sort(),
		['assigned-credential', 'hex-64'],
	);
});

test('an explicit allowPatterns entry suppresses a region the caller declares benign', () => {
	const text = 'password = "definitely-real-value"';
	const without = scanForSecrets({ name: 'a.txt', text });
	assert.equal(without.findings.length, 1);
	const withPattern = scanForSecrets({ name: 'a.txt', text, allowPatterns: [/password = "definitely-real-value"/] });
	assert.deepEqual(withPattern.findings, []);
	assert.equal(withPattern.allowlisted, 1);
});

test('a shared global pattern is not made stateful by a previous document', () => {
	// Two documents with the same content must produce the same result; a leaked
	// lastIndex on a shared regex would make the second scan silently empty.
	const text = 'secret = "aaaaaaaaaaaa"';
	const first = scanDocuments({ documents: [{ name: 'a.txt', text }] });
	const second = scanDocuments({ documents: [{ name: 'a.txt', text }, { name: 'b.txt', text }] });
	assert.equal(first.findings.length, 1);
	assert.equal(second.findings.length, 2);
	assert.deepEqual(
		second.findings.map(finding => finding.document),
		['a.txt', 'b.txt'],
	);
});

test('scanning many documents fails the gate when one is unreadable', () => {
	const result = scanDocuments({
		documents: [{ name: 'clean.md', text: '# heading\n\nno secrets' }],
		unreadable: ['README.md'],
	});
	assert.equal(result.findings.length, 0);
	assert.equal(result.ok, false);
	assert.deepEqual(result.unreadable, ['README.md']);
});

test('scanning many documents passes only when every document is clean', () => {
	const result = scanDocuments({ documents: [{ name: 'clean.md', text: '# heading\n' }] });
	assert.equal(result.ok, true);
});

test('the shipped README and docs contain no secrets', async () => {
	const documents = [];
	const unreadable = [];
	for (const name of ['README.md', 'docs/workspace-access.md', 'docs/incremental-sync.md', 'docs/account-security.md']) {
		try {
			documents.push({ name, text: await readFile(new URL(name, import.meta.url), 'utf8') });
		} catch {
			unreadable.push(name);
		}
	}
	const result = scanDocuments({ documents, unreadable });
	// The documents must be readable: an unreadable doc is a gate failure, and
	// silently passing would hide exactly the file a secret could live in.
	assert.deepEqual(result.unreadable, []);
	assert.deepEqual(result.findings, []);
});

test('an identity that both reads content and publishes is a separation-of-duties problem', () => {
	const result = checkSeparationOfDuties({
		identities: [
			{ id: 'web-service', capabilities: ['workspace.read', 'workspace.write'] },
			{ id: 'release-operator', capabilities: ['release.publish', 'workspace.read'] },
			{ id: 'backup-operator', capabilities: ['backup.restore'] },
		],
	});
	assert.deepEqual(
		result.problems.map(problem => [problem.id, problem.kind]),
		[['release-operator', 'CombinedRole']],
	);
	assert.equal(result.checked, 3);
});

test('a fully separated set of identities passes', () => {
	const result = checkSeparationOfDuties({
		identities: [
			{ id: 'web-service', capabilities: operationalCapabilities.read },
			{ id: 'release-publisher', capabilities: operationalCapabilities.publish },
		],
	});
	assert.deepEqual(result.problems, []);
});

test('the rendered report names each section and its problem count without secrets', () => {
	const report = renderSupplyChainReport({
		generatedAt: Date.parse('2026-01-02T03:04:05Z'),
		sections: [
			{ title: 'credentials', problems: [{ id: 'storage-config', kind: 'Mode', detail: 'expected 0600 but found 0644' }] },
			{ title: 'tls', problems: [] },
		],
	});
	assert.match(report, /^Log4Stellar supply-chain report\n/);
	assert.match(report, /generated: 2026-01-02T03:04:05\.000Z/);
	assert.match(report, /## credentials: 1 problem\(s\)/);
	assert.match(report, /  - \[Mode\] storage-config: expected 0600 but found 0644/);
	assert.match(report, /## tls: ok/);
});

test('every declared pattern actually matches its own sample, so none is dead code', () => {
	const samples = {
		'private-key': '-----BEGIN PRIVATE KEY-----',
		'aws-access-key': 'AKIAIOSFODNN7EXAMPLE',
		jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop',
		'url-credential': 'postgres://user:password123@host:5432/db',
		'assigned-credential': 'api_key = "abc123def456"',
		'hex-64': 'f'.repeat(64),
	};
	assert.deepEqual(
		secretPatterns.map(entry => entry.id).sort(),
		Object.keys(samples).sort(),
	);
	for (const { id, pattern } of secretPatterns) {
		const fresh = new RegExp(pattern.source, pattern.flags);
		assert.ok(fresh.test(samples[id]), 'pattern ' + id + ' does not match its own sample');
	}
});

test('a real file on disk can be audited through a stat wrapper', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'l4s-audit-'));
	try {
		const secretPath = join(directory, 'git-secret');
		await writeFile(secretPath, 'x'.repeat(65));
		await chmod(secretPath, 0o600);
		const entries = [{ id: 'git-signing-key', path: secretPath, sensitivity: credentialSensitivity.secret, required: true }];
		const statPath = async path => {
			const { stat } = await import('node:fs/promises');
			try {
				const info = await stat(path);
				return { mode: info.mode, isFile: info.isFile(), isDirectory: info.isDirectory(), size: info.size };
			} catch {
				return undefined;
			}
		};
		assert.deepEqual((await checkCredentialPermissions(entries, statPath)).problems, []);
		await mkdir(join(directory, 'spool'), { mode: 0o700 });
		const directoryEntries = [{ id: 'blob-spool', path: join(directory, 'spool'), sensitivity: credentialSensitivity.directory, required: true }];
		assert.deepEqual((await checkCredentialPermissions(directoryEntries, statPath)).problems, []);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
