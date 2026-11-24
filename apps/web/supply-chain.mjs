// Production credential inventory, TLS expiry and supply-chain hygiene checks.
//
// Every helper here is pure with respect to the network and to the production
// services: it reads local files, local manifests and a caller-supplied `stat`
// surface, and never opens a database or an object store. That makes the whole
// module safe to run from a test suite and from a release gate.
//
// Security invariant: nothing in this module ever returns a secret. Findings
// carry the kind of match, the line number and a redacted preview (a short
// prefix plus the original length), which is enough to locate a leak without
// copying it into a log, a ticket or a commit.

import { X509Certificate } from 'node:crypto';

/** The sensitivity classes a credential can fall into. */
export const credentialSensitivity = Object.freeze({
	/** A value that grants access on its own: never printed, never committed. */
	secret: 'secret',
	/** A non-secret configuration file that still must not be world readable. */
	config: 'config',
	/** A directory whose contents include secrets. */
	directory: 'directory',
});

/** Required permission bits per sensitivity class, as octal strings. */
export const credentialModes = Object.freeze({
	secret: '600',
	config: '600',
	directory: '700',
});

/**
 * One row of the credential inventory. `purpose` and `rotation` are the only
 * fields an operator needs to answer "who holds this and when does it change",
 * so they are mandatory and a missing one is a finding rather than a default.
 *
 * @typedef {object} CredentialEntry
 * @property {string} id Stable identifier used by tests and reports.
 * @property {string} purpose One line: what the credential grants.
 * @property {string} path Absolute path on the deployment host.
 * @property {'secret'|'config'|'directory'} sensitivity
 * @property {string} rotation When the value is supposed to change.
 * @property {string} responsible Who rotates and restores it.
 * @property {boolean} [required] Whether a missing entry blocks a deployment.
 */

/**
 * The credential inventory for the documented single-host deployment. Paths are
 * derived from the supplied roots so a rehearsal can point the same inventory at
 * an isolated plant under /tmp.
 *
 * @param {{configDir: string, authDir: string, demoDir?: string, home?: string}} roots
 * @returns {CredentialEntry[]}
 */
export function describeCredentialInventory({ configDir, authDir, demoDir }) {
	/** @type {CredentialEntry[]} */
	const entries = [
		{
			id: 'account-database-directory',
			purpose: 'Directory holding the SQLite account store and its secret; keeps the WAL and shared-memory files private too.',
			path: authDir,
			sensitivity: credentialSensitivity.directory,
			rotation: 'Not rotatable in place: recreate the directory when moving the account store.',
			responsible: 'deployment owner',
			required: true,
		},
		{
			id: 'account-database',
			purpose: 'SQLite account store: users, sessions, workspace members and MFA material.',
			path: authDir + '/auth.sqlite',
			sensitivity: credentialSensitivity.config,
			rotation: 'Not rotatable in place: migrate by copying with VACUUM INTO (see backup-data.mjs).',
			responsible: 'deployment owner',
			required: true,
		},
		{
			id: 'auth-secret',
			purpose: 'Signing secret for better-auth sessions; whoever holds it can forge a session cookie.',
			path: authDir + '/secret',
			sensitivity: credentialSensitivity.secret,
			rotation: 'Rotate together with invalidating every session and every workspace credential issued since.',
			responsible: 'deployment owner',
			required: true,
		},
		{
			id: 'git-signing-key',
			purpose: 'HMAC key that signs Git credential hand-outs and oauth state.',
			path: configDir + '/git-secret',
			sensitivity: credentialSensitivity.secret,
			rotation: 'Rotate by issuing a new key and invalidating outstanding Git credentials; a rollback to an older key strands issued credentials.',
			responsible: 'deployment owner',
			required: true,
		},
		{
			id: 'storage-config',
			purpose: 'Object store (S3/RustFS) and PostgreSQL connection settings, including their passwords.',
			path: configDir + '/workspace-storage.json',
			sensitivity: credentialSensitivity.secret,
			rotation: 'Rotate the database role password and the object store key together; both are read at process start, so a restart is required.',
			responsible: 'deployment owner',
			required: true,
		},
		{
			id: 'web-clients',
			purpose: 'Comma separated allow-list of client addresses admitted by the Web origin check.',
			path: configDir + '/web-clients',
			sensitivity: credentialSensitivity.config,
			rotation: 'Edited per deployment; no secret content, but it decides who may reach the origin.',
			responsible: 'deployment owner',
		},
		{
			id: 'blob-spool',
			purpose: 'Temporary spool for object uploads and range reads.',
			path: configDir + '/spool',
			sensitivity: credentialSensitivity.directory,
			rotation: 'Never contains durable data: empty it whenever the service is stopped.',
			responsible: 'deployment owner',
		},
		{
			id: 'tls-private-key',
			purpose: 'Private key for the HTTPS origin the workbench is served from.',
			path: (demoDir ?? '') + '/tls/server.key',
			sensitivity: credentialSensitivity.secret,
			rotation: 'Regenerate the self-signed pair every 12 months and before the certificate expires; the browser must re-trust it.',
			responsible: 'deployment owner',
			required: true,
		},
		{
			id: 'tls-certificate',
			purpose: 'Public certificate for the HTTPS origin, checked for expiry below.',
			path: (demoDir ?? '') + '/tls/server.crt',
			sensitivity: credentialSensitivity.config,
			rotation: 'Same cycle as tls-private-key.',
			responsible: 'deployment owner',
			required: true,
		},
	];
	return entries.map(entry => ({ ...entry, required: entry.required === true }));
}

/**
 * Compares an inventory against observed file modes.
 *
 * @param {CredentialEntry[]} entries
 * @param {(path: string) => Promise<{mode: number, isFile: boolean, isDirectory: boolean, size: number} | undefined>} statPath
 * @returns {Promise<{problems: Array<{id: string, path: string, kind: string, detail: string}>, checked: number}>}
 */
export async function checkCredentialPermissions(entries, statPath) {
	const problems = [];
	let checked = 0;
	for (const entry of entries) {
		const info = await statPath(entry.path);
		if (!info) {
			if (entry.required) {
				problems.push({ id: entry.id, path: entry.path, kind: 'Missing', detail: 'required credential is absent' });
			}
			continue;
		}
		checked += 1;
		const expected = credentialModes[entry.sensitivity];
		const actual = (info.mode & 0o777).toString(8).padStart(3, '0');
		if (actual !== expected) {
			problems.push({
				id: entry.id,
				path: entry.path,
				kind: 'Mode',
				detail: 'expected 0' + expected + ' but found 0' + actual,
			});
		}
		if (entry.sensitivity === credentialSensitivity.directory && !info.isDirectory) {
			problems.push({ id: entry.id, path: entry.path, kind: 'Type', detail: 'expected a directory' });
		}
		if (entry.sensitivity !== credentialSensitivity.directory && !info.isFile) {
			problems.push({ id: entry.id, path: entry.path, kind: 'Type', detail: 'expected a regular file' });
		}
		if (entry.sensitivity === credentialSensitivity.secret && info.size === 0) {
			problems.push({ id: entry.id, path: entry.path, kind: 'Empty', detail: 'secret file is empty' });
		}
	}
	return { problems, checked };
}

/**
 * Parses a PEM certificate and reports the time left before it expires.
 *
 * The warning window is explicit rather than hard-coded so a deployment with a
 * long lived certificate can widen it without changing this module.
 *
 * @param {{certificate: string|Buffer, now?: number, warnBeforeDays?: number}} options
 * @returns {{subject: string, issuer: string, validFrom: string, validTo: string, daysRemaining: number, expiresAt: number, problems: string[]}}
 */
export function checkTlsCertificate({ certificate, now = Date.now(), warnBeforeDays = 30 }) {
	if (!Number.isFinite(now)) {
		throw new TypeError('now must be a finite timestamp');
	}
	if (!Number.isInteger(warnBeforeDays) || warnBeforeDays < 0) {
		throw new TypeError('warnBeforeDays must be a non-negative integer');
	}
	const parsed = new X509Certificate(certificate);
	const expiresAt = Date.parse(parsed.validTo);
	const problems = [];
	if (!Number.isFinite(expiresAt)) {
		throw new Error('Certificate has no parseable expiry date');
	}
	const daysRemaining = Math.floor((expiresAt - now) / 86_400_000);
	if (daysRemaining < 0) {
		problems.push('Certificate expired ' + Math.abs(daysRemaining) + ' day(s) ago');
	} else if (daysRemaining < warnBeforeDays) {
		problems.push('Certificate expires in ' + daysRemaining + ' day(s), inside the ' + warnBeforeDays + ' day warning window');
	}
	if (Date.parse(parsed.validFrom) > now) {
		problems.push('Certificate is not valid yet');
	}
	return {
		subject: String(parsed.subject),
		issuer: String(parsed.issuer),
		validFrom: parsed.validFrom,
		validTo: parsed.validTo,
		daysRemaining,
		expiresAt,
		problems,
	};
}

/**
 * The pinned runtime and package versions that a release is expected to ship.
 * Kept separate from `checkPinnedVersions` so a test can assert the expectation
 * itself rather than only the comparison.
 *
 * @param {{packageManifest: {packageManager?: string, dependencies?: Record<string, string>}, expected: Record<string, string>}} options
 */
export function checkPinnedVersions({ packageManifest, expected }) {
	const actual = { ...(packageManifest.dependencies ?? {}) };
	if (packageManifest.packageManager) {
		actual.packageManager = packageManifest.packageManager;
	}
	const problems = [];
	for (const [name, version] of Object.entries(expected)) {
		const found = actual[name];
		if (found === undefined) {
			problems.push({ name, kind: 'Missing', detail: 'expected ' + version + ' but the manifest does not declare it' });
			continue;
		}
		// A caret or tilde range defeats the point of pinning: a release must ship
		// exactly the version the rehearsal exercised.
		if (found !== version) {
			problems.push({ name, kind: 'Drift', detail: 'expected ' + version + ' but found ' + found });
		}
	}
	return { problems, checked: Object.keys(expected).length };
}

/** License obligations attached to the shipped third-party components. */
export const licenseObligations = Object.freeze([
	{
		component: 'Code - OSS (Microsoft)',
		license: 'MIT',
		obligation: 'Ship LICENSE.txt and ThirdPartyNotices.txt with every release; keep the copyright notice.',
		shippedAs: 'the workbench bundle under <release>/web',
	},
	{
		component: '@vscode/test-web',
		license: 'MIT',
		obligation: 'Notice required; the workbench bundle redistributes it.',
		shippedAs: 'server dependency',
	},
	{
		component: 'vscode-oniguruma / vscode-textmate',
		license: 'MIT',
		obligation: 'Notice required; ship the `release` folder beside the bundle.',
		shippedAs: '<release>/web/node_modules/vscode-*',
	},
	{
		component: '@node-rs/argon2',
		license: 'MIT',
		obligation: 'Notice required; a native artifact is redistributed per platform.',
		shippedAs: 'server dependency',
	},
	{
		component: 'better-auth',
		license: 'MIT',
		obligation: 'Notice required.',
		shippedAs: 'server dependency',
	},
	{
		component: 'pg (node-postgres)',
		license: 'MIT',
		obligation: 'Notice required.',
		shippedAs: 'server dependency',
	},
	{
		component: '@aws-sdk/client-s3',
		license: 'Apache-2.0',
		obligation: 'Ship the Apache-2.0 text and any NOTICE file the package provides.',
		shippedAs: 'server dependency',
	},
	{
		component: 'LibreOffice (office preview worker)',
		license: 'MPL-2.0',
		obligation: 'Installed beside the service, not redistributed; record the version and that it is a separate program invoked over a process boundary.',
		shippedAs: 'system package (/usr/bin/soffice)',
	},
]);

/**
 * @param {{files: Array<{name: string, present: boolean}>}} options
 */
export function checkLicenseArtifacts({ files }) {
	const problems = [];
	for (const file of files) {
		if (!file.present) {
			problems.push({ name: file.name, kind: 'Missing', detail: 'license artifact missing from the release' });
		}
	}
	return { problems, checked: files.length };
}

/**
 * Secret patterns worth scanning for. Each pattern is deliberately narrow: the
 * cost of a false positive here is a noisy gate, and the cost of a false
 * negative is a leaked credential.
 */
export const secretPatterns = Object.freeze([
	{ id: 'private-key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g },
	{ id: 'aws-access-key', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
	{ id: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
	{ id: 'url-credential', pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]{3,}@/gi },
	{
		// A real credential value is a token: word characters plus the base64 and
		// path punctuation that shows up in generated secrets. Requiring that class
		// keeps documentation placeholders (`secret=<base32>`, `token=…`) and prose
		// punctuation out of the results, which matters because a gate that cries
		// wolf on its own docs gets disabled. The lookbehind leaves only the value
		// in the match, so `allow` entries and previews name the value itself
		// rather than whatever quote character happened to precede it.
		id: 'assigned-credential',
		pattern: /(?<=\b(?:password|passwd|secret|token|api[_-]?key|access[_-]?key)\b\s*[:=]\s*["']?)[\w\-+/=.]{8,}/gi,
	},
	{ id: 'hex-64', pattern: /\b[0-9a-f]{64}\b/g },
]);

/**
 * A redacted preview: the first four characters and the total length. Four
 * characters cannot reconstruct a 64 character key and are enough to tell two
 * findings apart while reading a report.
 */
function redact(value) {
	if (value.length <= 4) {
		return 'x'.repeat(value.length) + '/' + value.length;
	}
	return value.slice(0, 4) + '…/' + value.length;
}

/**
 * Scans one text document.
 *
 * Two suppression mechanisms exist because two different false positives do:
 *
 *  - `allow` entries are exact strings a document is allowed to contain (a
 *    documented fake value). Matching is exact on the whole match, so an allow
 *    entry cannot accidentally suppress a neighbouring real secret.
 *  - `allowPatterns` describe a region that is provenance rather than a secret.
 *    A build log legitimately records `Source: <commit> (<sha256>)`, and a digest
 *    there is exactly what an auditor wants to see reproduced; suppressing the
 *    whole matched region keeps that line readable without weakening the rule for
 *    a digest that appears anywhere else.
 *
 * @param {{name: string, text: string, allow?: string[], allowPatterns?: RegExp[]}} options
 * @returns {{findings: Array<{pattern: string, line: number, column: number, preview: string}>, allowlisted: number}}
 */
export function scanForSecrets({ name, text, allow = [], allowPatterns = [] }) {
	if (typeof text !== 'string') {
		throw new TypeError('text must be a string');
	}
	const allowed = new Set(allow);
	/** @type {Array<[number, number]>} */
	const ranges = [];
	for (const value of allowed) {
		for (let index = text.indexOf(value); index >= 0; index = text.indexOf(value, index + value.length)) {
			ranges.push([index, index + value.length]);
		}
	}
	for (const pattern of allowPatterns) {
		// A fresh global regex per document: a shared lastIndex would make the
		// result depend on which document was scanned first.
		const scanner = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
		for (const match of text.matchAll(scanner)) {
			const index = match.index ?? 0;
			ranges.push([index, index + match[0].length]);
		}
	}
	const suppressed = index => ranges.some(([start, end]) => index >= start && index < end);
	const findings = [];
	let allowlisted = 0;
	for (const { id, pattern } of secretPatterns) {
		for (const match of text.matchAll(pattern)) {
			const value = match[0];
			const index = match.index ?? 0;
			if (allowed.has(value) || suppressed(index)) {
				allowlisted += 1;
				continue;
			}
			const before = text.slice(0, index);
			const line = before.split('\n').length;
			const column = index - before.lastIndexOf('\n');
			findings.push({ pattern: id, line, column, preview: redact(value), index });
		}
	}
	findings.sort((left, right) => left.line - right.line || left.column - right.column || left.pattern.localeCompare(right.pattern));
	return {
		findings: findings.map(({ index: _index, ...finding }) => ({ ...finding, document: name })),
		allowlisted,
	};
}

/**
 * Regions that are provenance rather than credentials. A release build log
 * records `Source: <commit> (<sha256>)` and the source fingerprint of the bundle;
 * both are digests an auditor must be able to compare against release.json, so
 * flagging them would train the operator to ignore the gate.
 */
export const provenanceAllowPatterns = Object.freeze([
	/\bSource: [0-9a-f]{7,64} \([0-9a-f]{64}\)/g,
	/\bsource[a-z]*[_ ]?sha256["']?\s*[:=]\s*["']?[0-9a-f]{64}/gi,
	/\b(?:sha256|digest|checksum)["']?\s*[:=]\s*["']?[0-9a-f]{64}/gi,
	/\brelease\.json\b[^\n]*[0-9a-f]{64}/g,
]);

/**
 * Aggregates the per-document scans and decides whether a gate passes. A release
 * gate must never pass because a document could not be read, so unreadable
 * documents are reported separately and fail the gate.
 *
 * @param {{documents: Array<{name: string, text: string, allow?: string[], allowPatterns?: RegExp[]}>, unreadable?: string[], allowPatterns?: RegExp[]}} options
 */
export function scanDocuments({ documents, unreadable = [], allowPatterns = [] }) {
	const findings = [];
	let allowlisted = 0;
	for (const document of documents) {
		const result = scanForSecrets({ ...document, allowPatterns: [...allowPatterns, ...provenanceAllowPatterns, ...(document.allowPatterns ?? [])] });
		findings.push(...result.findings);
		allowlisted += result.allowlisted;
	}
	return {
		findings,
		allowlisted,
		documents: documents.map(document => document.name),
		unreadable: [...unreadable].sort(),
		ok: findings.length === 0 && unreadable.length === 0,
	};
}

/** Capabilities that decide whether an identity may publish or restore. */
export const operationalCapabilities = Object.freeze({
	read: ['workspace.read', 'workspace.history'],
	write: ['workspace.write', 'workspace.delete', 'workspace.restore', 'workspace.git.write'],
	// Publishing is deliberately narrower than "can change data": restoring a
	// backup legitimately needs write access to workspace content, while shipping
	// a new release must never be reachable from an identity that reads content.
	publish: ['release.publish', 'release.rollback'],
	restore: ['backup.restore'],
});

/**
 * Asserts separation of duties: the identity that serves traffic must not be
 * able to publish a release, and the identity that publishes must not be able to
 * read workspace content. Running these as one account is what turns a read
 * compromise into a supply-chain compromise.
 *
 * @param {{identities: Array<{id: string, capabilities: string[]}>}} options
 */
export function checkSeparationOfDuties({ identities }) {
	const lookup = new Map(identities.map(identity => [identity.id, new Set(identity.capabilities)]));
	const problems = [];
	for (const identity of identities) {
		const held = lookup.get(identity.id);
		const hasRead = operationalCapabilities.read.some(capability => held.has(capability));
		const canPublish = operationalCapabilities.publish.some(capability => held.has(capability));
		if (hasRead && canPublish) {
			problems.push({
				id: identity.id,
				kind: 'CombinedRole',
				detail: 'identity both reads workspace content and can publish/rollback releases',
			});
		}
	}
	return { problems, checked: identities.length };
}

/** Renders a stable, secret-free summary suitable for a release log. */
export function renderSupplyChainReport(report) {
	const lines = [];
	const push = (...parts) => lines.push(parts.join(' '));
	push('Log4Stellar supply-chain report');
	push('generated:', new Date(report.generatedAt ?? Date.now()).toISOString());
	for (const section of report.sections ?? []) {
		push('');
		push('## ' + section.title + ': ' + (section.problems.length === 0 ? 'ok' : section.problems.length + ' problem(s)'));
		for (const problem of section.problems) {
			push('  - [' + problem.kind + '] ' + (problem.id ?? problem.name ?? '') + ': ' + problem.detail);
		}
	}
	return lines.join('\n') + '\n';
}
