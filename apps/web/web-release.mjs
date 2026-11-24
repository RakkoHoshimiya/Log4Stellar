import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, readFile, readlink, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';

export const webExtensionNames = [
	'markdown-basics', 'markdown-language-features', 'markdown-math', 'mermaid-markdown-features', 'theme-defaults',
];
export const webGrammarPackages = ['vscode-oniguruma', 'vscode-textmate'];

export async function digestFile(path) {
	const hash = createHash('sha256');
	for await (const chunk of createReadStream(path)) {
		hash.update(chunk);
	}
	return hash.digest('hex');
}

export async function releaseInventory(path) {
	const root = await realpath(path);
	const result = [];

	async function collect(directory) {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const file = join(directory, entry.name);
			const name = relative(root, file).split(sep).join('/');
			if (name === 'release.json') {
				continue;
			}
			if (entry.isDirectory()) {
				await collect(file);
			} else if (entry.isSymbolicLink()) {
				const link = await readlink(file);
				const target = await realpath(file);
				const fromRoot = relative(root, target);
				if (isAbsolute(link) || isAbsolute(fromRoot) || fromRoot === '..' || fromRoot.startsWith('..' + sep)) {
					throw new Error('Release link points outside the package: ' + name);
				}
				result.push([name, 'link:' + link]);
			} else if (entry.isFile()) {
				result.push([name, await digestFile(file)]);
			} else {
				throw new Error('Unsupported file type in release: ' + name);
			}
		}
	}

	await collect(root);
	return result.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
}

export async function readWebRelease(directory) {
	const root = await realpath(directory);
	const marker = JSON.parse(await readFile(join(root, 'release.json'), 'utf8'));
	if (marker.format !== 1 || marker.platform !== process.platform || marker.arch !== process.arch
		|| marker.nodeMajor !== Number(process.versions.node.split('.')[0]) || !Array.isArray(marker.files)) {
		throw new Error('Incompatible Log4Stellar Web release: ' + root);
	}
	return { root, marker };
}
