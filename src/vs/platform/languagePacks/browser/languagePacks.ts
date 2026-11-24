/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationTokenSource } from '../../../base/common/cancellation.js';
import { Lazy } from '../../../base/common/lazy.js';
import { FileAccess } from '../../../base/common/network.js';
import { LANGUAGE_DEFAULT } from '../../../base/common/platform.js';
import { URI } from '../../../base/common/uri.js';
import { IExtensionGalleryService } from '../../extensionManagement/common/extensionManagement.js';
import { IExtensionResourceLoaderService } from '../../extensionResourceLoader/common/extensionResourceLoader.js';
import { ILanguagePackItem, LanguagePackBaseService } from '../common/languagePacks.js';
import { ILogService } from '../../log/common/log.js';

interface IBundledLanguagePack {
	readonly id: string;
	readonly label: string;
	readonly extensions: readonly string[];
}

export class WebLanguagePacksService extends LanguagePackBaseService {
	private readonly bundledLanguagePacks = new Lazy(async (): Promise<readonly IBundledLanguagePack[]> => {
		try {
			const response = await fetch(FileAccess.asBrowserUri('nls.locales.json').toString());
			return response.ok ? await response.json() : [];
		} catch (error) {
			this.logService.trace('Unable to read bundled language packs', error);
			return [];
		}
	});

	constructor(
		@IExtensionResourceLoaderService private readonly extensionResourceLoaderService: IExtensionResourceLoaderService,
		@IExtensionGalleryService extensionGalleryService: IExtensionGalleryService,
		@ILogService private readonly logService: ILogService
	) {
		super(extensionGalleryService);
	}

	async getBuiltInExtensionTranslationsUri(id: string, language: string, options?: { bundledOnly?: boolean }): Promise<URI | undefined> {
		const bundledLanguage = (await this.bundledLanguagePacks.value).find(pack => pack.id === language);
		if (bundledLanguage?.extensions.includes(id)) {
			return FileAccess.asBrowserUri(`nls/${language}/${id}.i18n.json`);
		}
		if (options?.bundledOnly || !this.extensionGalleryService.isEnabled()) {
			return undefined;
		}

		const queryTimeout = new CancellationTokenSource();
		setTimeout(() => queryTimeout.cancel(), 1000);

		// First get the extensions that supports the language (there should only be one but just in case let's include more results)
		let result;
		try {
			result = await this.extensionGalleryService.query({
				text: `tag:"lp-${language}"`,
				pageSize: 5
			}, queryTimeout.token);
		} catch (err) {
			this.logService.error(err);
			return undefined;
		}

		const languagePackExtensions = result.firstPage.find(e => e.properties.localizedLanguages?.length);
		if (!languagePackExtensions) {
			this.logService.trace(`No language pack found for language ${language}`);
			return undefined;
		}

		// Then get the manifest for that extension
		const manifestTimeout = new CancellationTokenSource();
		setTimeout(() => queryTimeout.cancel(), 1000);
		const manifest = await this.extensionGalleryService.getManifest(languagePackExtensions, manifestTimeout.token);

		// Find the translation from the language pack
		const localization = manifest?.contributes?.localizations?.find(l => l.languageId === language);
		const translation = localization?.translations.find(t => t.id === id);
		if (!translation) {
			this.logService.trace(`No translation found for id '${id}, in ${manifest?.name}`);
			return undefined;
		}

		// get the resource uri and return it
		const uri = await this.extensionResourceLoaderService.getExtensionGalleryResourceURL({
			// If translation is defined then manifest should have been defined.
			name: manifest!.name,
			publisher: manifest!.publisher,
			version: manifest!.version
		});
		if (!uri) {
			this.logService.trace('Gallery does not provide extension resources.');
			return undefined;
		}

		return URI.joinPath(uri, translation.path);
	}

	async getInstalledLanguages(): Promise<ILanguagePackItem[]> {
		const bundled = await this.bundledLanguagePacks.value;
		return [
			this.createQuickPickItem(LANGUAGE_DEFAULT, 'English'),
			...bundled.map(pack => this.createQuickPickItem(pack.id, pack.label)),
		];
	}
}
