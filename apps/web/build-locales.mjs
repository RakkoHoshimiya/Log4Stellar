/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { coreOverrides, extensionManifestOverrides, overrideLanguages } from './locale-overrides.mjs';

const revision = '62d5443b567022539ba6e8565b0f43f5f6b3682b';
const source = `https://raw.githubusercontent.com/microsoft/vscode-loc/${revision}`;
const languages = [
	{ id: 'zh-cn', label: '简体中文', pack: 'zh-hans' },
	{ id: 'zh-tw', label: '繁體中文', pack: 'zh-hant' },
	{ id: 'ja', label: '日本語', pack: 'ja' },
];
const extensionIds = [
	'vscode.markdown',
	'vscode.markdown-language-features',
	'vscode.markdown-math',
	'vscode.mermaid-markdown-features',
	'vscode.theme-defaults',
];

const out = resolve(process.argv[2] ?? '.build/log4stellar-web/out');
const readJson = async file => JSON.parse(await readFile(join(out, file), 'utf8'));
const [keys, english] = await Promise.all([readJson('nls.keys.json'), readJson('nls.messages.json')]);

const translationsRepo = process.argv[3];
const runGit = promisify(execFile);

async function download(resource) {
	if (translationsRepo) {
		const { stdout } = await runGit('git', ['-C', translationsRepo, 'show', `${revision}:${resource}`], { maxBuffer: 8 * 1024 * 1024 });
		return stdout;
	}
	for (let attempt = 1; ; attempt++) {
		try {
			const response = await fetch(`${source}/${resource}`, { signal: AbortSignal.timeout(30_000) });
			if (!response.ok) {
				throw new Error(`vscode-loc returned ${response.status} for ${resource}`);
			}
			return await response.text();
		} catch (error) {
			if (attempt === 3) {
				throw new Error(`Could not download ${resource}`, { cause: error });
			}
			await new Promise(resolve => setTimeout(resolve, attempt * 1000));
		}
	}
}

const localeManifest = await Promise.all(languages.map(async ({ id, label, pack }) => {
	const translations = `i18n/vscode-language-pack-${pack}/translations`;
	const { contents } = JSON.parse(await download(`${translations}/main.i18n.json`));
	const overrideLanguage = overrideLanguages.indexOf(id);
	let index = 0;
	let translated = 0;
	const messages = keys.flatMap(([moduleId, moduleKeys]) => moduleKeys.map(key => {
		const value = coreOverrides[moduleId]?.[key]?.[overrideLanguage] ?? contents[moduleId]?.[key];
		const fallback = english[index++];
		if (typeof value === 'string' && value.length > 0) {
			translated++;
			return value;
		}
		return fallback;
	}));
	if (index !== english.length || translated === 0) {
		throw new Error(`Translation keys do not match the bundled messages for ${id}`);
	}
	const translationPath = join(out, 'nls', id);
	await mkdir(translationPath, { recursive: true });
	await Promise.all([
		writeFile(join(out, `nls.messages.${id}.js`),
			`/* Microsoft vscode-loc ${revision}, MIT; see vscode-loc.LICENSE.md */\n`
			+ `globalThis._VSCODE_NLS_MESSAGES = ${JSON.stringify(messages)};\n`
			+ `globalThis._VSCODE_NLS_LANGUAGE = ${JSON.stringify(id)};\n`),
		...extensionIds.map(async extensionId => {
			const name = `${extensionId}.i18n.json`;
			const data = JSON.parse(await download(`${translations}/extensions/${name}`));
			const overrides = extensionManifestOverrides[extensionId];
			if (overrides) {
				data.contents.package = {
					...data.contents.package,
					...Object.fromEntries(Object.entries(overrides).map(([key, values]) => [key, values[overrideLanguage]])),
				};
			}
			await writeFile(join(translationPath, name), JSON.stringify(data));
		}),
	]);
	console.log(`${id}: ${translated}/${index} translated core strings`);
	return { id, label, extensions: extensionIds };
}));
await writeFile(join(out, 'vscode-loc.LICENSE.md'), await download('LICENSE.md'));
await writeFile(join(out, 'nls.locales.json'), JSON.stringify(localeManifest));
