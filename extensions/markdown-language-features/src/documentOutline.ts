/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { IMdParser } from './markdownEngine';
import { MarkdownEditorProvider } from './preview/markdownEditorProvider';
import { StaticMarkdownPreview } from './preview/preview';
import type { MarkdownPreviewManager } from './preview/previewManager';
import { Disposable } from './util/dispose';
import { isMarkdownFile } from './util/file';

const viewId = 'markdown.documentOutline';
const revealCommand = 'markdown.documentOutline.reveal';

interface OutlineHeading {
	readonly resource: vscode.Uri;
	readonly line: number;
	readonly title: string;
	readonly children: OutlineHeading[];
}

export class MarkdownDocumentOutline extends Disposable implements vscode.TreeDataProvider<OutlineHeading> {
	readonly #onDidChangeTreeData = this._register(new vscode.EventEmitter<void>());
	readonly onDidChangeTreeData = this.#onDidChangeTreeData.event;

	constructor(
		private readonly parser: IMdParser,
		private readonly previews: MarkdownPreviewManager,
		private readonly richEditor: MarkdownEditorProvider,
	) {
		super();
		this._register(vscode.window.registerTreeDataProvider(viewId, this));
		this._register(vscode.commands.registerCommand(revealCommand, (heading: OutlineHeading) => this.reveal(heading)));
		this._register(vscode.window.tabGroups.onDidChangeTabs(() => this.#onDidChangeTreeData.fire()));
		this._register(vscode.window.tabGroups.onDidChangeTabGroups(() => this.#onDidChangeTreeData.fire()));
		this._register(this.previews.onDidChangeActivePreview(() => this.#onDidChangeTreeData.fire()));
		this._register(vscode.workspace.onDidChangeTextDocument(({ document, contentChanges }) => {
			if (contentChanges.length && document.uri.toString() === activeMarkdownResource(this.previews)?.toString()) {
				this.#onDidChangeTreeData.fire();
			}
		}));
	}

	getTreeItem(heading: OutlineHeading): vscode.TreeItem {
		const state = heading.children.length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None;
		const item = new vscode.TreeItem(heading.title, state);
		item.command = { command: revealCommand, title: heading.title, arguments: [heading] };
		return item;
	}

	async getChildren(heading?: OutlineHeading): Promise<OutlineHeading[]> {
		if (heading) {
			return heading.children;
		}
		const resource = activeMarkdownResource(this.previews);
		if (!resource) {
			return [];
		}

		let document: vscode.TextDocument;
		try {
			document = await vscode.workspace.openTextDocument(resource);
		} catch {
			return [];
		}
		if (!isMarkdownFile(document)) {
			return [];
		}

		const roots: OutlineHeading[] = [];
		let parent: OutlineHeading | undefined;
		const tokens = await this.parser.tokenize(document);
		for (let i = 0; i < tokens.length; i++) {
			const token = tokens[i];
			if (token.type !== 'heading_open' || !token.map || (token.tag !== 'h1' && token.tag !== 'h2')) {
				continue;
			}
			const inline = tokens[i + 1];
			const title = inline?.children?.map(child => child.content).join('').trim() || inline?.content.trim();
			if (!title) {
				continue;
			}
			const entry: OutlineHeading = { resource, line: token.map[0], title, children: [] };
			if (token.tag === 'h1') {
				parent = entry;
				roots.push(entry);
			} else {
				(parent?.children ?? roots).push(entry);
			}
		}
		return roots;
	}

	private async reveal(heading: OutlineHeading): Promise<void> {
		if (activeMarkdownResource(this.previews)?.toString() !== heading.resource.toString()) {
			return;
		}
		const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
		const position = new vscode.Position(heading.line, 0);
		const range = new vscode.Range(position, position);
		if (input instanceof vscode.TabInputCustom && input.viewType === MarkdownEditorProvider.viewType) {
			await this.richEditor.revealOutlineHeading(range);
		} else if (!(input instanceof vscode.TabInputText) && this.previews.revealActivePreviewLine(heading.resource, heading.line)) {
			return;
		} else {
			const editor = await vscode.window.showTextDocument(heading.resource, { selection: range, preserveFocus: true });
			editor.revealRange(range, vscode.TextEditorRevealType.AtTop);
		}
	}
}

export function activeMarkdownResource(previews: MarkdownPreviewManager): vscode.Uri | undefined {
	const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
	if (input instanceof vscode.TabInputText) {
		return input.uri;
	}
	if (input instanceof vscode.TabInputCustom
		&& (input.viewType === MarkdownEditorProvider.viewType || input.viewType === StaticMarkdownPreview.customEditorViewType)) {
		return input.uri;
	}
	if (input instanceof vscode.TabInputWebview) {
		return previews.activePreviewResource;
	}
	return undefined;
}
