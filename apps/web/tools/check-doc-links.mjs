#!/usr/bin/env node
// Checks every relative link in the project documentation.
//
// The READMEs are the only onboarding path a new maintainer has, and a stale
// relative link is the cheapest way to make them lie. This script parses the
// Markdown files that ship in the repository, resolves each relative link
// against the file that contains it, and fails with a non-zero exit code when a
// target file or an in-document anchor is missing. External URLs are reported
// but never fetched: the check must work offline.
//
// Usage:
//   node apps/web/tools/check-doc-links.mjs [--list] [file-or-directory ...]
//
// Without arguments it checks the default documentation set (see defaultTargets).
// `--list` prints every link that was resolved instead of only the failures.

import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** Documentation that must stay link-clean. */
const defaultTargets = [
	'README.md',
	'CONTRIBUTING.md',
	'SECURITY.md',
	'apps/web/README.md',
	'apps/web/docs',
];

const arguments_ = process.argv.slice(2);
const list = arguments_.includes('--list');
const requested = arguments_.filter(argument => argument !== '--list');
const targets = (requested.length ? requested : defaultTargets).map(target => resolve(repoRoot, target));

/** Every Markdown file below one target, in a stable order. */
async function collectFiles(target) {
	const info = await stat(target).catch(() => undefined);
	if (!info) throw new Error(`No such file or directory: ${relative(repoRoot, target) || '.'}`);
	if (!info.isDirectory()) return extname(target).toLowerCase() === '.md' ? [target] : [];
	const names = await readdir(target);
	const nested = await Promise.all(names.sort().map(name => collectFiles(join(target, name))));
	return nested.flat();
}

/**
 * Removes fenced blocks and inline code so that a link written as an example
 * (`[text](target)`) is not resolved as if it were real.
 */
function stripCode(text) {
	return text
		.replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1[^\n]*$/gm, '')
		.replace(/(`+)[\s\S]*?\1/g, '');
}

const linkPattern = /!?\[[^\]]*\]\(\s*(<[^>]*>|[^\s()]*(?:\([^\s()]*\)[^\s()]*)*)(?:\s+"[^"]*")?\s*\)/g;

/** GitHub's anchor algorithm: lowercase, drop punctuation, spaces to hyphens. */
function slugify(heading) {
	return heading
		.replace(/<[^>]*>/g, '')
		.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
		.trim()
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s_-]/gu, '')
		.replace(/\s/g, '-');
}

/** Heading anchors of one Markdown file, with GitHub's duplicate suffixes. */
async function anchorsOf(file) {
	const text = stripCode(await readFile(file, 'utf8'));
	const seen = new Map();
	const anchors = new Set();
	for (const line of text.split('\n')) {
		const match = /^(?: {0,3})(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
		if (!match) continue;
		const base = slugify(match[2]);
		const count = seen.get(base) ?? 0;
		seen.set(base, count + 1);
		anchors.add(count === 0 ? base : `${base}-${count}`);
	}
	// Explicit HTML anchors are rare here but cheap to honour.
	for (const match of text.matchAll(/<a\s+(?:id|name)="([^"]+)"/g)) anchors.add(match[1]);
	return anchors;
}

const isExternal = target => /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(target) || target.startsWith('//');

const files = (await Promise.all(targets.map(collectFiles))).flat();
if (files.length === 0) throw new Error('No Markdown files matched the requested targets.');

const anchorCache = new Map();
async function anchorsFor(file) {
	if (!anchorCache.has(file)) anchorCache.set(file, await anchorsOf(file));
	return anchorCache.get(file);
}

const failures = [];
const resolvedLinks = [];
let checked = 0;
let external = 0;

for (const file of files) {
	const text = stripCode(await readFile(file, 'utf8'));
	for (const match of text.matchAll(linkPattern)) {
		let target = match[1].trim();
		if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1);
		if (!target || isExternal(target)) {
			external++;
			continue;
		}
		checked++;
		const where = `${relative(repoRoot, file)}`;
		const hashIndex = target.indexOf('#');
		const rawPath = hashIndex === -1 ? target : target.slice(0, hashIndex);
		const anchor = hashIndex === -1 ? '' : target.slice(hashIndex + 1);
		const destination = rawPath === '' ? file : resolve(dirname(file), decodeURI(rawPath.replace(/^<|>$/g, '')));

		const info = await stat(destination).catch(() => undefined);
		if (!info) {
			failures.push(`${where}: missing target ${target}`);
			continue;
		}
		if (!rawPath.startsWith('/') && !isAbsolute(rawPath) && !destination.startsWith(repoRoot + sep) && destination !== repoRoot) {
			failures.push(`${where}: target escapes the repository ${target}`);
			continue;
		}
		if (anchor) {
			if (!info.isFile() || extname(destination).toLowerCase() !== '.md') {
				failures.push(`${where}: anchor on a non-Markdown target ${target}`);
				continue;
			}
			const anchors = await anchorsFor(destination);
			if (!anchors.has(decodeURI(anchor))) {
				failures.push(`${where}: missing anchor ${target}`);
				continue;
			}
		}
		resolvedLinks.push(`${where} -> ${target}`);
	}
}

if (list) {
	for (const link of resolvedLinks) console.log(`ok ${link}`);
}

if (failures.length) {
	console.error(`Documentation links: ${failures.length} broken of ${checked} relative links in ${files.length} files.\n`);
	for (const failure of failures) console.error(`  ${failure}`);
	console.error('\nFix the target or the anchor; anchors follow the GitHub heading slug algorithm.');
	process.exit(1);
}

console.log(`Documentation links: ${checked} relative links in ${files.length} files resolve (${external} external links not fetched).`);
