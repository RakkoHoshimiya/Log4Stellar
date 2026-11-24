/*---------------------------------------------------------------------------------------------
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Utils } from 'vscode-uri';
import { Disposable } from './util/dispose';

const restoreCommand = 'markdown.workspaceTrash.restore';

const labels = {
	en: {
		empty: 'The recycle bin is empty.', loadError: 'Could not load the recycle bin.',
		restore: 'Restore', confirm: 'Restore “{0}” to its original path?',
		conflict: '“{0}” is already in use. Restore the deleted item under a new name?',
		keepBoth: 'Keep Both', restored: 'Restored to {0}.', restoreError: 'Could not restore the deleted item.',
		unknownTime: 'Deletion time unknown',
	},
	'zh-cn': {
		empty: '回收站为空。', loadError: '无法加载回收站。',
		restore: '恢复', confirm: '将「{0}」恢复到原路径？',
		conflict: '「{0}」已被占用。是否换一个名称恢复？',
		keepBoth: '保留两份', restored: '已恢复到 {0}。', restoreError: '无法恢复已删除项。',
		unknownTime: '删除时间未知',
	},
	'zh-tw': {
		empty: '資源回收筒是空的。', loadError: '無法載入資源回收筒。',
		restore: '還原', confirm: '要將「{0}」還原至原路徑嗎？',
		conflict: '「{0}」已被占用。要以新名稱還原嗎？',
		keepBoth: '保留兩份', restored: '已還原至 {0}。', restoreError: '無法還原已刪除項目。',
		unknownTime: '刪除時間未知',
	},
	ja: {
		empty: 'ごみ箱は空です。', loadError: 'ごみ箱を読み込めませんでした。',
		restore: '復元', confirm: '「{0}」を元の場所に復元しますか？',
		conflict: '「{0}」はすでに使用されています。別の名前で復元しますか？',
		keepBoth: '両方を保持', restored: '{0} に復元しました。', restoreError: '削除した項目を復元できませんでした。',
		unknownTime: '削除日時不明',
	},
};

interface TrashItem {
	readonly id: string;
	readonly path: string;
	readonly type: vscode.FileType;
	readonly deletedAt: number | null;
}

export class WorkspaceTrash extends Disposable implements vscode.TreeDataProvider<TrashItem> {
	readonly #changed = this._register(new vscode.EventEmitter<void>());
	readonly onDidChangeTreeData = this.#changed.event;
	readonly #view = this._register(vscode.window.createTreeView('markdown.workspaceTrash', { treeDataProvider: this }));
	readonly #labels = labels[vscode.env.language as keyof typeof labels] ?? labels.en;
	readonly #date = new Intl.DateTimeFormat(vscode.env.language, { dateStyle: 'medium', timeStyle: 'medium' });

	constructor(private readonly root: vscode.Uri) {
		super();
		this._register(vscode.commands.registerCommand(restoreCommand, (item: TrashItem | undefined) => this.restore(item)));
		this._register(vscode.commands.registerCommand('markdown.workspaceTrash.refresh', () => this.#changed.fire()));
		this._register(vscode.workspace.onDidDeleteFiles(() => this.#changed.fire()));
		this._register(vscode.workspace.onDidRenameFiles(() => this.#changed.fire()));
		this._register(this.#view.onDidChangeVisibility(event => {
			if (event.visible) {
				this.#changed.fire();
			}
		}));
	}

	getTreeItem(entry: TrashItem): vscode.TreeItem {
		const resource = this.root.with({ path: entry.path });
		const item = new vscode.TreeItem(resource);
		item.id = entry.id;
		item.iconPath = entry.type === vscode.FileType.Directory ? vscode.ThemeIcon.Folder : vscode.ThemeIcon.File;
		const date = entry.deletedAt === null ? this.#labels.unknownTime : this.#date.format(entry.deletedAt);
		item.description = Utils.dirname(resource).path;
		item.tooltip = entry.path + ' · ' + date;
		item.command = { command: restoreCommand, title: this.#labels.restore, arguments: [entry] };
		return item;
	}

	async getChildren(): Promise<TrashItem[]> {
		try {
			const entries = await vscode.commands.executeCommand<TrashItem[]>('log4stellar.workspace.trash', this.root) ?? [];
			this.#view.message = entries.length ? undefined : this.#labels.empty;
			return entries;
		} catch {
			this.#view.message = this.#labels.loadError;
			return [];
		}
	}

	private async restore(item: TrashItem | undefined): Promise<void> {
		if (!item) {
			return;
		}
		const confirm = this.#labels.confirm.replace('{0}', () => item.path);
		if (await vscode.window.showWarningMessage(confirm, { modal: true }, this.#labels.restore) !== this.#labels.restore) {
			return;
		}
		try {
			let path: string | undefined;
			try {
				path = await vscode.commands.executeCommand<string>('log4stellar.workspace.restoreTrash', this.root, item.id, false);
			} catch (error) {
				if (!(error instanceof vscode.FileSystemError) || error.code !== 'FileExists') {
					throw error;
				}
				const conflict = this.#labels.conflict.replace('{0}', () => item.path);
				if (await vscode.window.showWarningMessage(conflict, { modal: true }, this.#labels.keepBoth) !== this.#labels.keepBoth) {
					return;
				}
				path = await vscode.commands.executeCommand<string>('log4stellar.workspace.restoreTrash', this.root, item.id, true);
			}
			if (path) {
				void vscode.window.showInformationMessage(this.#labels.restored.replace('{0}', () => path));
			}
		} catch (error) {
			void vscode.window.showErrorMessage(this.#labels.restoreError + ' ' + (error instanceof Error ? error.message : ''));
		} finally {
			this.#changed.fire();
		}
	}
}
