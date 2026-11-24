/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Utils } from 'vscode-uri';
import { activeMarkdownResource } from './documentOutline';
import type { MarkdownPreviewManager } from './preview/previewManager';
import { Disposable } from './util/dispose';
import { looksLikeMarkdownPath } from './util/file';
import { WorkspaceTrash } from './workspaceTrash';
import { historyQuery, historyScheme } from './util/historyResource';

const viewId = 'markdown.documentHistory';
const openCommand = 'markdown.documentHistory.open';
const restoreCommand = 'markdown.documentHistory.restore';
const compareCommand = 'markdown.documentHistory.compare';
const saveCommand = 'markdown.documentHistory.save';
const workspaceScheme = 'vscode-test-web';

const historyLabels = {
	en: {
		openNote: 'Open a workspace file to view its versions.', empty: 'No saved versions.',
		loadError: 'Version history could not be loaded.', current: 'Current version', initial: 'Initial version',
		bytes: '{0} bytes', preview: 'Preview Version', revision: 'Revision {0}', openError: 'This version could not be opened.',
		compare: 'Compare with Current Version', comparison: 'History ↔ Current Saved Version',
		identical: 'The selected version and the current saved version have identical content.',
		compareError: 'The versions could not be compared.',
		restore: 'Restore Version', confirm: 'Restore “{0}” to the version from {1}? This creates a new version.',
		dirty: 'Save or discard the unsaved edits before restoring a version.',
		restored: 'The selected content was saved as a new version.', restoreError: 'Could not restore the version.',
		saveTitle: 'Save “{0}” from {1}', saved: 'The selected version was saved.', saveError: 'Could not save the version.',
	},
	'zh-cn': {
		openNote: '打开工作区文件以查看其版本。', empty: '暂无保存的版本。',
		loadError: '无法加载版本历史。', current: '当前版本', initial: '初始版本',
		bytes: '{0} 字节', preview: '预览版本', revision: '历史版本 {0}', openError: '无法打开这个版本。',
		compare: '与当前版本对比', comparison: '历史版本 ↔ 当前保存版',
		identical: '所选版本与当前保存版内容一致。',
		compareError: '无法对比这两个版本。',
		restore: '恢复此版本', confirm: '将「{0}」恢复到 {1} 的版本？恢复会生成一个新版本。',
		dirty: '请先保存或放弃未保存的编辑，再恢复版本。',
		restored: '已将选中的内容保存为新版本。', restoreError: '无法恢复此版本。',
		saveTitle: '另存「{0}」{1} 的版本', saved: '已保存所选版本。', saveError: '无法保存此版本。',
	},
	'zh-tw': {
		openNote: '開啟工作區檔案以查看其版本。', empty: '沒有已儲存的版本。',
		loadError: '無法載入版本記錄。', current: '目前版本', initial: '初始版本',
		bytes: '{0} 位元組', preview: '預覽版本', revision: '歷史版本 {0}', openError: '無法開啟這個版本。',
		compare: '與目前版本比較', comparison: '歷史版本 ↔ 目前儲存版',
		identical: '所選版本與目前儲存版的內容相同。',
		compareError: '無法比較這兩個版本。',
		restore: '還原此版本', confirm: '要將「{0}」還原至 {1} 的版本嗎？還原會建立新版本。',
		dirty: '請先儲存或捨棄未儲存的編輯，再還原版本。',
		restored: '已將所選內容儲存為新版本。', restoreError: '無法還原此版本。',
		saveTitle: '另存「{0}」{1} 的版本', saved: '已儲存所選版本。', saveError: '無法儲存此版本。',
	},
	ja: {
		openNote: 'ワークスペースのファイルを開くとバージョンを確認できます。', empty: '保存されたバージョンはありません。',
		loadError: 'バージョン履歴を読み込めませんでした。', current: '現在のバージョン', initial: '初期バージョン',
		bytes: '{0} バイト', preview: 'バージョンをプレビュー', revision: '履歴バージョン {0}', openError: 'このバージョンを開けませんでした。',
		compare: '現在のバージョンと比較', comparison: '履歴 ↔ 現在の保存済みバージョン',
		identical: '選択したバージョンと現在の保存済みバージョンの内容は同じです。',
		compareError: 'バージョンを比較できませんでした。',
		restore: 'このバージョンを復元', confirm: '「{0}」を {1} のバージョンに復元しますか？新しいバージョンが作成されます。',
		dirty: '復元する前に、未保存の変更を保存または破棄してください。',
		restored: '選択した内容を新しいバージョンとして保存しました。', restoreError: 'このバージョンを復元できませんでした。',
		saveTitle: '「{0}」の {1} のバージョンを保存', saved: '選択したバージョンを保存しました。', saveError: 'このバージョンを保存できませんでした。',
	},
};

interface Version {
	readonly id: string;
	readonly createdAt: number;
	readonly size: number;
	readonly current: boolean;
	readonly initial: boolean;
}

interface VersionItem extends Version {
	readonly resource: vscode.Uri;
	readonly expectedVersion: string;
}

export async function registerMarkdownDocumentHistory(context: vscode.ExtensionContext, previews: MarkdownPreviewManager): Promise<void> {
	if (vscode.env.uiKind !== vscode.UIKind.Web || !vscode.workspace.workspaceFolders?.some(folder => folder.uri.scheme === workspaceScheme)) {
		return;
	}
	try {
		await vscode.extensions.getExtension('log4stellar.workspace-files')?.activate();
		const capabilities = await vscode.commands.executeCommand<{
			versionHistory: boolean;
			versionRestore: boolean;
			recycleBin: boolean;
		}>('log4stellar.workspace.capabilities');
		if (capabilities?.versionHistory) {
			context.subscriptions.push(new MarkdownDocumentHistory(previews, capabilities.versionRestore));
			await vscode.commands.executeCommand('setContext', 'log4stellar.workspaceHistory', true);
			await vscode.commands.executeCommand('setContext', 'log4stellar.workspaceVersionRestore', capabilities.versionRestore);
		}
		if (capabilities?.recycleBin) {
			const folder = vscode.workspace.workspaceFolders?.find(folder => folder.uri.scheme === workspaceScheme);
			if (folder) {
				context.subscriptions.push(new WorkspaceTrash(folder.uri));
				await vscode.commands.executeCommand('setContext', 'log4stellar.workspaceTrash', true);
			}
		}
	} catch {
		// Other Web workspace providers and older servers may not support recovery.
	}
}

class MarkdownDocumentHistory extends Disposable implements vscode.TreeDataProvider<VersionItem> {
	readonly #changed = this._register(new vscode.EventEmitter<void>());
	readonly onDidChangeTreeData = this.#changed.event;
	readonly #view = this._register(vscode.window.createTreeView(viewId, { treeDataProvider: this, showCollapseAll: false }));
	readonly #labels = historyLabels[vscode.env.language as keyof typeof historyLabels] ?? historyLabels.en;
	readonly #date = new Intl.DateTimeFormat(vscode.env.language, { dateStyle: 'medium', timeStyle: 'medium' });
	#requestId = 0;
	#compareRequest = 0;

	constructor(private readonly previews: MarkdownPreviewManager, private readonly canRestore: boolean) {
		super();
		this._register(vscode.window.tabGroups.onDidChangeTabs(() => this.#changed.fire()));
		this._register(vscode.window.tabGroups.onDidChangeTabGroups(() => this.#changed.fire()));
		this._register(previews.onDidChangeActivePreview(() => this.#changed.fire()));
		this._register(vscode.workspace.onDidSaveTextDocument(document => {
			if (document.uri.toString() === this.activeResource()?.toString()) {
				this.#changed.fire();
			}
		}));
		this._register(vscode.workspace.registerTextDocumentContentProvider(historyScheme, {
			provideTextDocumentContent: async uri => {
				const history = historyQuery(uri);
				if (!history) {
					throw new Error(this.#labels.openError);
				}
				return vscode.commands.executeCommand<string>('log4stellar.workspace.revision', history.resource, history.version);
			},
		}));
		this._register(vscode.commands.registerCommand(openCommand, (version: VersionItem | undefined) => this.open(version)));
		this._register(vscode.commands.registerCommand(compareCommand, (version: VersionItem | undefined) => this.compare(version)));
		this._register(vscode.commands.registerCommand(restoreCommand, (version: VersionItem) => this.restore(version)));
		this._register(vscode.commands.registerCommand(saveCommand, (version: VersionItem | undefined) => this.save(version)));
		this._register(this.#view.onDidChangeVisibility(event => {
			if (event.visible) {
				this.#changed.fire();
			}
		}));
	}

	private activeResource(): vscode.Uri | undefined {
		const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
		let resource: vscode.Uri | undefined;
		if (input instanceof vscode.TabInputTextDiff) {
			resource = input.modified.scheme === historyScheme ? input.modified : undefined;
		} else if (input instanceof vscode.TabInputCustom || input instanceof vscode.TabInputNotebook) {
			resource = input.uri;
		} else {
			resource = activeMarkdownResource(this.previews);
		}
		if (resource?.scheme === historyScheme) {
			resource = historyQuery(resource)?.resource;
		}
		return resource?.scheme === workspaceScheme ? resource : undefined;
	}

	getTreeItem(version: VersionItem): vscode.TreeItem {
		const date = this.#date.format(version.createdAt);
		const item = new vscode.TreeItem(date);
		item.id = version.id;
		item.iconPath = new vscode.ThemeIcon(version.current ? 'check' : 'history');
		item.description = version.current ? this.#labels.current : version.initial ? this.#labels.initial : undefined;
		item.tooltip = date + ' · ' + this.#labels.bytes.replace('{0}', String(version.size));
		if (looksLikeMarkdownPath(version.resource)) {
			item.contextValue = version.current ? 'log4stellarMarkdownCurrentVersion' : 'log4stellarMarkdownHistoricalVersion';
			item.command = version.current
				? { command: openCommand, title: this.#labels.preview, arguments: [version] }
				: { command: compareCommand, title: this.#labels.compare, arguments: [version] };
		} else if (!version.current) {
			// Attachments have no text representation to preview or compare, so the only useful
			// action on a historical version is exporting it; it is offered as an inline button
			// rather than a row command so selecting a version never opens a save dialog.
			item.contextValue = 'log4stellarHistoricalVersion';
		}
		return item;
	}

	async getChildren(): Promise<VersionItem[]> {
		const request = ++this.#requestId;
		const resource = this.activeResource();
		this.#view.description = resource ? Utils.basename(resource) : undefined;
		if (!resource) {
			this.#view.message = this.#labels.openNote;
			return [];
		}
		this.#view.message = undefined;
		try {
			const versions = await vscode.commands.executeCommand<Version[]>('log4stellar.workspace.versions', resource);
			if (request !== this.#requestId) {
				return [];
			}
			const current = versions?.find(version => version.current);
			if (!versions || !current) {
				this.#view.message = this.#labels.empty;
				return [];
			}
			return versions.map(version => ({ ...version, resource, expectedVersion: current.id }));
		} catch {
			if (request === this.#requestId) {
				this.#view.message = this.#labels.loadError;
			}
			return [];
		}
	}

	private async restore(version: VersionItem | undefined): Promise<void> {
		if (!this.canRestore || !version || version.current || this.activeResource()?.toString() !== version.resource.toString()) {
			return;
		}
		const isDirty = () => {
			const uri = version.resource.toString();
			return vscode.workspace.textDocuments.some(document => document.isDirty && document.uri.toString() === uri)
				|| vscode.window.tabGroups.all.some(group => group.tabs.some(tab => {
					const input = tab.input;
					return tab.isDirty && (input instanceof vscode.TabInputCustom || input instanceof vscode.TabInputNotebook)
						&& input.uri.toString() === uri;
				}));
		};
		if (isDirty()) {
			void vscode.window.showWarningMessage(this.#labels.dirty);
			return;
		}
		const message = this.#labels.confirm
			.replace('{0}', () => Utils.basename(version.resource))
			.replace('{1}', () => this.#date.format(version.createdAt));
		if (await vscode.window.showWarningMessage(message, { modal: true }, this.#labels.restore) !== this.#labels.restore) {
			return;
		}
		if (isDirty()) {
			void vscode.window.showWarningMessage(this.#labels.dirty);
			return;
		}
		try {
			await vscode.commands.executeCommand('log4stellar.workspace.restoreVersion', version.resource, version.id, version.expectedVersion);
			void vscode.window.showInformationMessage(this.#labels.restored);
		} catch (error) {
			void vscode.window.showErrorMessage(this.#labels.restoreError + ' ' + (error instanceof Error ? error.message : ''));
		} finally {
			this.#changed.fire();
		}
	}

	private async save(version: VersionItem | undefined): Promise<void> {
		if (!version || this.activeResource()?.toString() !== version.resource.toString()) {
			return;
		}
		const title = this.#labels.saveTitle
			.replace('{0}', () => Utils.basename(version.resource))
			.replace('{1}', () => this.#date.format(version.createdAt));
		try {
			const target = await vscode.commands.executeCommand<vscode.Uri | undefined>(
				'log4stellar.workspace.saveRevision', version.resource, version.id, title);
			if (target) {
				void vscode.window.showInformationMessage(this.#labels.saved);
			}
		} catch (error) {
			void vscode.window.showErrorMessage(this.#labels.saveError + ' ' + (error instanceof Error ? error.message : ''));
		}
	}

	private versionUri(resource: vscode.Uri, version: Version): vscode.Uri {
		const stamp = new Date(version.createdAt).toISOString().slice(0, 19).replace(/:/g, '-');
		const label = version.current ? this.#labels.current + ' ' + stamp : this.#labels.revision.replace('{0}', stamp);
		const query = new URLSearchParams({ source: resource.toString(), version: version.id });
		return vscode.Uri.joinPath(Utils.dirname(resource), Utils.basename(resource).replace(/\.[^.]+$/, '') + ' · ' + label + '.md')
			.with({ scheme: historyScheme, query: query.toString() });
	}

	private async compare(version: VersionItem | undefined): Promise<void> {
		if (!version || version.current || !looksLikeMarkdownPath(version.resource)
			|| this.activeResource()?.toString() !== version.resource.toString()) {
			return;
		}
		const request = ++this.#compareRequest;
		const isActive = () => request === this.#compareRequest && this.activeResource()?.toString() === version.resource.toString();
		try {
			const versions = await vscode.commands.executeCommand<Version[]>('log4stellar.workspace.versions', version.resource);
			const current = versions?.find(candidate => candidate.current);
			if (!current) {
				throw new Error(this.#labels.loadError);
			}
			const original = this.versionUri(version.resource, version);
			const modified = this.versionUri(version.resource, current);
			const [originalDocument, modifiedDocument] = await Promise.all([
				vscode.workspace.openTextDocument(original),
				vscode.workspace.openTextDocument(modified),
			]);
			if (!isActive()) {
				return;
			}
			if (originalDocument.getText() === modifiedDocument.getText()) {
				void vscode.window.showInformationMessage(this.#labels.identical);
				return;
			}
			const title = Utils.basename(version.resource) + ' · ' + this.#labels.comparison;
			await vscode.commands.executeCommand('vscode.diff', original, modified, title, { preview: true });
		} catch {
			if (isActive()) {
				void vscode.window.showErrorMessage(this.#labels.compareError);
			}
		}
	}

	private async open(version: VersionItem | undefined): Promise<void> {
		if (!version || !looksLikeMarkdownPath(version.resource) || this.activeResource()?.toString() !== version.resource.toString()) {
			return;
		}
		const virtual = this.versionUri(version.resource, version);
		try {
			await vscode.workspace.openTextDocument(virtual);
			const column = vscode.window.tabGroups.activeTabGroup.viewColumn;
			this.previews.openDynamicPreview(virtual, { resourceColumn: column, previewColumn: column, locked: true });
		} catch {
			void vscode.window.showErrorMessage(this.#labels.openError);
		}
	}
}
