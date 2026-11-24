/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

export const historyScheme = 'log4stellar-history';
const workspaceScheme = 'vscode-test-web';

export function historyQuery(uri: vscode.Uri): { resource: vscode.Uri; version: string } | undefined {
	const params = new URLSearchParams(uri.query);
	const source = params.get('source');
	const version = params.get('version');
	if (source && version) {
		const resource = vscode.Uri.parse(source);
		if (resource.scheme === workspaceScheme) {
			return { resource, version };
		}
	}
	return undefined;
}

export function markdownLinkSource(uri: vscode.Uri): vscode.Uri {
	return uri.scheme === historyScheme ? historyQuery(uri)?.resource ?? uri : uri;
}
