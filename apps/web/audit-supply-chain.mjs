// Release gate for task 13: permission and supply-chain maintenance.
//
// Usage:
//   node apps/web/audit-supply-chain.mjs [--json] [--config <dir>] [--auth <dir>] [--demo <dir>]
//
// Exit code 1 means at least one problem was found. The command never writes
// anything, never contacts the network and never prints a credential value, so it
// is safe to run from a release script and to paste its output into a ticket.
//
// Every check is individually named in the report. A check that could not run at
// all (an unreadable root, for example) is reported as a problem rather than
// skipped: a gate that passes because it did not look is worse than no gate.

import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
	checkCredentialPermissions,
	checkLicenseArtifacts,
	checkPinnedVersions,
	checkSeparationOfDuties,
	checkTlsCertificate,
	describeCredentialInventory,
	renderSupplyChainReport,
	scanDocuments,
} from './supply-chain.mjs';

/** Versions this release is expected to ship. */
const expectedVersions = {
	'@aws-sdk/client-s3': '3.1173.0',
	'@node-rs/argon2': '2.2.2',
	'@vscode/test-web': '0.0.81',
	'better-auth': '1.7.27',
	pg: '8.23.1',
	'qrcode-generator': '2.0.4',
};

/**
 * The documented deployment identity split. It is declared here rather than
 * discovered from the host because the point of the check is to state what the
 * deployment is supposed to look like; proving the host matches it is a separate
 * rehearsal step, recorded in apps/web/docs/supply-chain.md.
 */
const documentedIdentities = [
	{
		id: 'web-service',
		// The serving identity reads and writes workspace content but can never
		// publish a release, so compromising it cannot be escalated into shipping
		// arbitrary code.
		capabilities: ['workspace.read', 'workspace.history', 'workspace.write', 'workspace.delete', 'workspace.restore', 'workspace.git.write'],
	},
	{ id: 'release-operator', capabilities: ['release.publish', 'release.rollback'] },
	{ id: 'backup-operator', capabilities: ['backup.restore', 'workspace.history'] },
];

const usage = 'Usage: node apps/web/audit-supply-chain.mjs [--json] [--config <dir>] [--auth <dir>] [--demo <dir>]';

function parseArguments(argv) {
	const options = { json: false };
	const roots = {
		configDir: process.env.LOG4STELLAR_CONFIG_DIR ?? join(homedir(), '.config', 'log4stellar'),
		authDir: process.env.LOG4STELLAR_AUTH_DIR ?? join(homedir(), '.cache', 'log4stellar-demo', 'auth'),
		demoDir: join(homedir(), '.cache', 'log4stellar-demo'),
	};
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === '--json') {
			options.json = true;
		} else if (argument === '--config' || argument === '--auth' || argument === '--demo') {
			const value = argv[index + 1];
			if (!value) {
				throw new Error(usage);
			}
			if (argument === '--config') {
				roots.configDir = value;
			} else if (argument === '--auth') {
				roots.authDir = value;
			} else {
				roots.demoDir = value;
			}
			index += 1;
		} else {
			throw new Error(usage);
		}
	}
	return { options, roots };
}

/** Stat wrapper shaped for checkCredentialPermissions. */
async function statPath(path) {
	try {
		const info = await stat(path);
		return { mode: info.mode, isFile: info.isFile(), isDirectory: info.isDirectory(), size: info.size, mtimeMs: info.mtimeMs };
	} catch {
		return undefined;
	}
}

/**
 * Collects the text of the documentation and log files a leak would show up in.
 * Only a bounded number of log files is read, newest first, so a host with a large
 * log directory does not turn the audit into an IO storm.
 */
async function collectDocuments(paths, logDirectories) {
	const documents = [];
	const unreadable = [];
	for (const path of paths) {
		try {
			documents.push({ name: path, text: await readFile(path, 'utf8') });
		} catch {
			unreadable.push(path);
		}
	}
	for (const directory of logDirectories) {
		let names = [];
		try {
			names = (await readdir(directory)).filter(name => name.endsWith('.log'));
		} catch {
			// A host without a log directory is not a failure of this check.
			continue;
		}
		const newest = [];
		for (const name of names) {
			const path = join(directory, name);
			const info = await statPath(path);
			if (info) {
				newest.push({ path, time: info.mtimeMs ?? 0 });
			}
		}
		newest.sort((left, right) => right.time - left.time);
		for (const { path } of newest.slice(0, 20)) {
			try {
				documents.push({ name: path, text: await readFile(path, 'utf8') });
			} catch {
				unreadable.push(path);
			}
		}
	}
	return { documents, unreadable };
}

const app = new URL('.', import.meta.url).pathname;
const { options, roots } = parseArguments(process.argv.slice(2));

const sections = [];
const entries = describeCredentialInventory(roots);
const permissions = await checkCredentialPermissions(entries, statPath);
sections.push({ title: 'credential permissions', problems: permissions.problems });

let tls;
try {
	tls = checkTlsCertificate({ certificate: await readFile(join(roots.demoDir, 'tls', 'server.crt')) });
	sections.push({
		title: 'TLS certificate',
		problems: tls.problems.map(detail => ({ name: 'server.crt', kind: 'Expiry', detail })),
	});
} catch (error) {
	sections.push({ title: 'TLS certificate', problems: [{ name: 'server.crt', kind: 'Unreadable', detail: error.message }] });
}

const manifest = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'));
const versions = checkPinnedVersions({ packageManifest: manifest, expected: expectedVersions });
sections.push({ title: 'pinned versions', problems: versions.problems });

// Every component in the obligation table must have a license text available to
// ship. The Code - OSS notices live at the repository root; a missing one is a
// distribution problem, so it belongs in the gate rather than in a checklist.
const repositoryRoot = join(app, '..', '..');
const licenses = checkLicenseArtifacts({
	files: await Promise.all(
		['LICENSE.txt', 'ThirdPartyNotices.txt'].map(async name => ({
			name,
			present: (await statPath(join(repositoryRoot, name))) !== undefined,
		})),
	),
});
sections.push({ title: 'license artifacts', problems: licenses.problems });

const collected = await collectDocuments(
	['README.md', 'docs/workspace-access.md', 'docs/incremental-sync.md', 'docs/account-security.md'].map(name => join(app, name)),
	[join(roots.configDir, 'logs'), join(roots.demoDir)],
);
const scan = scanDocuments(collected);
sections.push({
	title: 'secret scan',
	problems: [
		...scan.findings.map(finding => ({
			name: finding.document,
			kind: 'Secret',
			detail: 'line ' + finding.line + ' column ' + finding.column + ' matches ' + finding.pattern + ' (' + finding.preview + ')',
		})),
		...scan.unreadable.map(name => ({ name, kind: 'Unreadable', detail: 'document could not be read, so it was not scanned' })),
	],
});

const duties = checkSeparationOfDuties({ identities: documentedIdentities });
sections.push({ title: 'separation of duties', problems: duties.problems });

const report = { generatedAt: Date.now(), sections };
if (options.json) {
	console.log(JSON.stringify(report, null, 2));
} else {
	process.stdout.write(renderSupplyChainReport(report));
	console.log('');
	console.log('checks:', sections.length, 'credentials:', entries.length, 'documents scanned:', scan.documents.length);
}
if (sections.some(section => section.problems.length > 0)) {
	process.exitCode = 1;
}
