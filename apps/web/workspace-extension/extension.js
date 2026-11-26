const vscode = require('vscode');

const scheme = 'vscode-test-web';
function accountFromAuthority(authority) {
  return authority.slice('mount-'.length).split('.')[0].toLowerCase();
}

function workspaceFromAuthority(authority) {
  if (!authority?.startsWith('mount-')) throw new Error('InvalidWorkspaceAuthority');
  const parts = authority.slice('mount-'.length).split('.');
  if (parts.length === 1 && /^[a-z0-9_-]+$/i.test(parts[0])) throw new Error('LegacyWorkspaceIdentityRequiresMigration');
  if (parts.length !== 2 || !/^[a-z0-9_-]+$/i.test(parts[0]) || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(parts[1])) {
    throw new Error('InvalidWorkspaceAuthority');
  }
  return parts[1];
}

const languages = ['en', 'zh-cn', 'zh-tw', 'ja'];

function languageOf() {
	const locale = new Intl.Locale(vscode.env.language || 'en');
	if (locale.language === 'zh') {
		return locale.script === 'Hant' || (locale.script !== 'Hans' && ['TW', 'HK', 'MO'].includes(locale.region))
			? 'zh-tw' : 'zh-cn';
	}
	return locale.language === 'ja' ? 'ja' : 'en';
}

function translated(row) {
	return row[languages.indexOf(languageOf())];
}

const workspaceFeedback = {
	SessionExpired: ['Your session expired. Sign in again.', '会话已过期，请重新登录。', '工作階段已到期，請重新登入。', 'セッションの有効期限が切れました。再度サインインしてください。'],
	AccountChanged: ['The account changed. Reopen the workspace with the active account.', '当前账号已切换，请用当前账号重新打开工作区。', '目前帳號已切換，請使用目前帳號重新開啟工作區。', 'アカウントが変更されました。現在のアカウントでワークスペースを開き直してください。'],
	NoPermissions: ['Your workspace role does not allow this action.', '当前工作区角色没有执行此操作的权限。', '目前工作區角色沒有執行此操作的權限。', '現在のワークスペース ロールではこの操作は許可されていません。'],
	NetworkUnavailable: ['The server could not be reached. Check your connection and try again.', '无法连接服务器，请检查网络后重试。', '無法連線至伺服器，請檢查網路後再試。', 'サーバーに接続できません。接続を確認して再試行してください。'],
	StorageObjectMissing: ['The stored file content is missing. Check the object storage or backup.', '存储中缺少文件内容，请检查对象存储或备份。', '儲存空間缺少檔案內容，請檢查物件儲存或備份。', 'ファイル本体がストレージにありません。オブジェクト ストレージまたはバックアップを確認してください。'],
	SearchUnavailable: ['Full-text search is unavailable in this workspace.', '当前工作区的全文搜索不可用。', '目前工作區無法使用全文搜尋。', 'このワークスペースでは全文検索を利用できません。'],
	InvalidQuery: ['Check the search text and try again.', '请检查搜索内容后重试。', '請檢查搜尋內容後再試。', '検索文字列を確認して再試行してください。'],
	SearchCursorExpired: ['The search results expired. Run the search again.', '搜索结果已过期，请重新搜索。', '搜尋結果已到期，請重新搜尋。', '検索結果の有効期限が切れました。再度検索してください。'],
	IndexRebuilding: ['The search index is being rebuilt. Try again shortly.', '搜索索引正在重建，请稍后再试。', '搜尋索引正在重建，請稍後再試。', '検索インデックスを再構築しています。しばらくしてから再試行してください。'],
	SearchRequestFailed: ['The search failed. Try again.', '搜索失败，请重试。', '搜尋失敗，請再試一次。', '検索に失敗しました。再試行してください。'],
	WorkspaceRequestFailed: ['The workspace request failed. Try again.', '工作区操作失败，请重试。', '工作區操作失敗，請再試一次。', 'ワークスペースの操作に失敗しました。再試行してください。'],
};

function failureCode(status, code, fallback) {
	if (code === 'AccountChanged') return code;
	if (status === 401) return 'SessionExpired';
	if (status === 403) return 'NoPermissions';
	return Object.hasOwn(workspaceFeedback, code) ? code : fallback;
}

function localizedFailure(code) {
	return Object.assign(new Error(translated(workspaceFeedback[code])), { code });
}

const errorNames = {
	FileNotFound: 'FileNotFound',
	FileExists: 'FileExists',
	FileNotADirectory: 'FileNotADirectory',
	FileIsADirectory: 'FileIsADirectory',
};
const saveErrors = {
	'zh-cn': {
		TrashChanged: '回收站内容已变化，请刷新后重试。',
		StorageObjectMissing: '存储中缺少恢复所需的文件内容。请检查对象存储或备份。',
		StorageIntegrityMismatch: '存储中的文件校验失败。请检查对象存储或备份。',
		RestoreParentIsFile: '原路径的上级目录已被同名文件占用。请先移动或重命名该文件，再恢复。',
		FileChanged: '文件在其他会话中已修改。请先保留当前编辑内容，再重新打开文件以核对变更。',
		FileTooLarge: '文件超过服务器的上传大小限制。',
	},
	'zh-tw': {
		TrashChanged: '資源回收筒的內容已變更，請重新整理後再試。',
		StorageObjectMissing: '儲存空間缺少還原所需的檔案內容。請檢查物件儲存或備份。',
		StorageIntegrityMismatch: '儲存中的檔案驗證失敗。請檢查物件儲存或備份。',
		RestoreParentIsFile: '原路徑的上層資料夾已被同名檔案占用。請先移動或重新命名該檔案，再還原。',
		FileChanged: '檔案已在其他工作階段變更。請先保留目前的編輯內容，再重新開啟檔案核對變更。',
		FileTooLarge: '檔案超過伺服器的上傳大小限制。',
	},
	ja: {
		TrashChanged: 'ごみ箱の内容が変更されました。更新してからもう一度お試しください。',
		StorageObjectMissing: '復元に必要なファイルがストレージにありません。オブジェクトストレージまたはバックアップを確認してください。',
		StorageIntegrityMismatch: 'ストレージ内のファイルを検証できませんでした。',
		RestoreParentIsFile: '元の親フォルダーと同じ名前のファイルがあります。移動または名前を変更してから復元してください。',
		FileChanged: 'ファイルは別のセッションで変更されました。現在の編集内容を保持してからファイルを開き直してください。',
		FileTooLarge: 'ファイルがサーバーのアップロード サイズ上限を超えています。',
	},
	en: {
		TrashChanged: 'The recycle bin changed. Refresh it and try again.',
		StorageObjectMissing: 'The file content required for recovery is missing from storage. Check the object store or backup.',
		StorageIntegrityMismatch: 'The stored file did not pass integrity verification. Check the object store or backup.',
		RestoreParentIsFile: 'A file occupies an original parent folder. Move or rename it before restoring.',
		FileChanged: 'The file changed in another session. Save a copy of your edits before reopening the file.',
		FileTooLarge: 'The file exceeds the server upload size limit.',
	},
};

// §4 error codes, mapped to the actionable message the user needs. Anything unmapped is a
// generic failure, because the server deliberately sends no internal detail.
const previewErrors = {
	UnsupportedFormat: 'unsupported',
	FileTooLarge: 'tooLarge',
	PreviewQueueFull: 'busy',
	PreviewNotReady: 'notReady',
	PreviewSourceCorrupt: 'corrupt',
	PreviewPasswordProtected: 'encrypted',
	PreviewTimeout: 'timeout',
	PreviewResourceLimit: 'tooLarge',
	PreviewUnavailable: 'unavailable',
	FileNotFound: 'missing',
	NoPermissions: 'denied',
	AccountChanged: 'accountChanged',
};

function previewError(status, code) {
	const error = new Error(code ?? 'PreviewRequestFailed');
	error.name = 'PreviewRequestFailed';
	error.reason = code === 'AccountChanged' ? 'accountChanged'
		: status === 401 ? 'expired'
			: status === 403 ? 'denied'
				: status === 429 ? 'busy' : previewErrorReason(code);
	error.status = status;
	return error;
}

const previewLabels = {
	en: {
		title: 'Preview', preparing: 'Preparing the document preview…', ready: 'Preview ready.', pollFailed: 'The preview could not be prepared.',
		open: 'Open preview', download: 'Download original', reveal: 'Show preview in browser', cancelled: 'Preview cancelled.',
		failed: 'The preview failed.', unsupported: 'This file format cannot be previewed. Download the original instead.',
		tooLarge: 'The document is too large to preview. Download the original instead.',
		busy: 'The preview queue is full. Try again in a moment.',
		notReady: 'The preview is still being prepared. Try again in a moment.',
		corrupt: 'The document appears to be damaged and cannot be previewed.',
		encrypted: 'Password protected documents cannot be previewed. Download the original instead.',
		timeout: 'Preparing the preview took too long. Try again later.',
		unavailable: 'The preview service is unavailable. Download the original instead.',
		missing: 'The file is no longer in this workspace.', denied: 'Your workspace role does not allow this action.',
		history: 'Choose the version to preview', current: 'Current version', version: 'Version {0}',
	},
	'zh-cn': {
		title: '预览', preparing: '正在准备文档预览…', ready: '预览已就绪。', pollFailed: '无法准备此预览。',
		open: '打开预览', download: '下载原件', reveal: '在浏览器中显示预览', cancelled: '已取消预览。',
		failed: '预览失败。', unsupported: '此文件格式不支持预览，请下载原件。',
		tooLarge: '文档过大，无法生成预览，请下载原件。',
		busy: '预览队列已满，请稍后再试。',
		notReady: '预览仍在准备中，请稍后再试。',
		corrupt: '文档似乎已损坏，无法生成预览。',
		encrypted: '受密码保护的文档无法预览，请下载原件。',
		timeout: '生成预览超时，请稍后再试。',
		unavailable: '预览服务当前不可用，请下载原件。',
		missing: '此文件已不在该工作区。', denied: '当前工作区角色没有执行此操作的权限。',
		history: '选择要预览的版本', current: '当前版本', version: '版本 {0}',
	},
	'zh-tw': {
		title: '預覽', preparing: '正在準備文件預覽…', ready: '預覽已就緒。', pollFailed: '無法準備此預覽。',
		open: '開啟預覽', download: '下載原始檔', reveal: '在瀏覽器中顯示預覽', cancelled: '已取消預覽。',
		failed: '預覽失敗。', unsupported: '此檔案格式不支援預覽，請下載原始檔。',
		tooLarge: '文件過大，無法產生預覽，請下載原始檔。',
		busy: '預覽佇列已滿，請稍後再試。',
		notReady: '預覽仍在準備中，請稍後再試。',
		corrupt: '文件似乎已損毀，無法產生預覽。',
		encrypted: '受密碼保護的文件無法預覽，請下載原始檔。',
		timeout: '產生預覽逾時，請稍後再試。',
		unavailable: '預覽服務目前無法使用，請下載原始檔。',
		missing: '此檔案已不在該工作區。', denied: '目前工作區角色沒有執行此操作的權限。',
		history: '選擇要預覽的版本', current: '目前版本', version: '版本 {0}',
	},
	ja: {
		title: 'プレビュー', preparing: 'ドキュメントのプレビューを準備しています…', ready: 'プレビューの準備ができました。', pollFailed: 'プレビューを準備できませんでした。',
		open: 'プレビューを開く', download: '元のファイルをダウンロード', reveal: 'ブラウザーでプレビューを表示', cancelled: 'プレビューをキャンセルしました。',
		failed: 'プレビューに失敗しました。', unsupported: 'この形式はプレビューできません。元のファイルをダウンロードしてください。',
		tooLarge: 'ドキュメントが大きすぎるためプレビューできません。元のファイルをダウンロードしてください。',
		busy: 'プレビュー キューが満杯です。しばらくしてからもう一度お試しください。',
		notReady: 'プレビューを準備しています。しばらくしてからもう一度お試しください。',
		corrupt: 'ドキュメントが破損しているためプレビューできません。',
		encrypted: 'パスワードで保護されたドキュメントはプレビューできません。元のファイルをダウンロードしてください。',
		timeout: 'プレビューの準備がタイムアウトしました。後でもう一度お試しください。',
		unavailable: 'プレビュー サービスを利用できません。元のファイルをダウンロードしてください。',
		missing: 'このファイルはワークスペースにありません。', denied: 'ワークスペースのロールではこの操作は許可されていません。',
		history: 'プレビューするバージョンを選択', current: '現在のバージョン', version: 'バージョン {0}',
	},
};

class WorkspaceFileSystem {
	constructor(origin) {
		this.origin = origin;
		// Older loaded workbenches omit the expected revision on file operations.
		this.legacyReadVersions = new Map();
		this.changes = new vscode.EventEmitter();
		this.onDidChangeFile = this.changes.event;
		// Each search gets a ticket; a response whose ticket is no longer the newest is
		// dropped instead of being reported, so a slow query can never overwrite the
		// results of the query the user typed afterwards (S03).
		this.searchTicket = 0;
	}

	dispose() {
		this.changes.dispose();
	}

	watch() {
		return new vscode.Disposable(() => {});
	}

	async request(uri, query, options) {
		const path = uri.path.split('/').map(encodeURIComponent).join('/');
		const url = new URL('/static/mount' + path, this.origin);
		url.search = new URLSearchParams(query).toString();
		const headers = new Headers(options?.headers);
		const workspaceId = workspaceFromAuthority(uri.authority);
		if (workspaceId) {
			headers.set('X-Log4Stellar-Workspace', workspaceId);
		}
		if (uri.authority?.startsWith('mount-')) {
			headers.set('X-Log4Stellar-Workspace-Account', accountFromAuthority(uri.authority));
		}
		let response;
		try {
			response = await fetch(url, { cache: 'no-store', redirect: 'error', ...options, headers });
		} catch (error) {
			if (options?.signal?.aborted) throw error;
			throw vscode.FileSystemError.Unavailable(translated(workspaceFeedback.NetworkUnavailable));
		}
		if (response.ok) {
			return response;
		}
		const error = await response.json().catch(() => undefined);
		const code = error?.error;
		const feedback = failureCode(response.status, code, 'WorkspaceRequestFailed');
		if (feedback === 'SessionExpired' || feedback === 'AccountChanged' || feedback === 'NoPermissions') {
			throw vscode.FileSystemError.NoPermissions(translated(workspaceFeedback[feedback]));
		}
		const errorName = Object.hasOwn(errorNames, code) ? errorNames[code] : undefined;
		if (errorName) {
			throw vscode.FileSystemError[errorName](uri);
		}
		const messages = saveErrors[languageOf()];
		if (code === 'FileChanged') {
			const error = new Error(messages.FileChanged);
			error.name = 'FileChanged (FileSystemError)';
			throw error;
		}
		throw vscode.FileSystemError.Unavailable(Object.hasOwn(messages, code) ? messages[code] : translated(workspaceFeedback[feedback]));
	}

	async gitRequest(uri, endpoint, { query, body } = {}) {
		if (!uri.authority?.startsWith('mount-') || uri.authority.length <= 'mount-'.length) {
			throw new Error('WorkspaceSessionRequired');
		}
		const workspaceId = workspaceFromAuthority(uri.authority);
		if (!workspaceId) {
			throw new Error('WorkspaceSessionRequired');
		}
		const url = new URL('/git/v1/' + endpoint, this.origin);
		url.search = new URLSearchParams(query).toString();
		const headers = new Headers({
			'X-Log4Stellar-Workspace': workspaceId,
			'X-Log4Stellar-Workspace-Account': accountFromAuthority(uri.authority),
		});
		if (body !== undefined) {
			headers.set('Content-Type', 'application/json');
		}
		const response = await fetch(url, {
			cache: 'no-store',
			redirect: 'error',
			headers,
			...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
		});
		const payload = await response.json();
		if (!response.ok) {
			throw new Error(payload?.error ?? 'GitRequestFailed');
		}
		return payload;
	}

	async stat(uri) {
		return (await this.request(uri, { stat: '1' })).json();
	}

	// --- Office previews (05-Office文件预览.md §4) -------------------------------------
	//
	// The preview API is versioned under /api/v1 and is *not* the file API: it answers JSON
	// for create/poll and the PDF bytes for the download. It is also the only part of this
	// extension that may be absent from a deployment, so every caller must treat a 404 on
	// the collection as "this build has no preview pipeline" instead of an error.

	async previewRequest(uri, { method = 'GET', endpoint = '', body } = {}) {
		if (!uri.authority?.startsWith('mount-') || uri.authority.length <= 'mount-'.length) {
			throw new Error('WorkspaceSessionRequired');
		}
		const workspaceId = workspaceFromAuthority(uri.authority);
		if (!workspaceId) {
			throw new Error('WorkspaceSessionRequired');
		}
		const url = new URL('/api/v1/office-previews' + endpoint, this.origin);
		const headers = new Headers({
			'X-Log4Stellar-Workspace': workspaceId,
			'X-Log4Stellar-Workspace-Account': accountFromAuthority(uri.authority),
		});
		if (body !== undefined) {
			headers.set('Content-Type', 'application/json');
		}
		try {
			return await fetch(url, {
				cache: 'no-store',
				redirect: 'error',
				headers,
				...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
				...(method === 'GET' ? {} : { method }),
			});
		} catch (error) {
			throw Object.assign(localizedFailure('NetworkUnavailable'), { reason: 'network', cause: error });
		}
	}

	/** `POST /api/v1/office-previews` — 200 ready, 202 queued, else a classified error. */
	async requestOfficePreview(uri, { revisionId } = {}) {
		const body = revisionId === undefined ? { path: uri.path } : { path: uri.path, revisionId };
		const response = await this.previewRequest(uri, { method: 'POST', body });
		return this.previewOutcome(response);
	}

	/** `GET /api/v1/office-previews/:id` — the poll endpoint, JSON only. */
	async previewStatus(uri, previewId) {
		const response = await this.previewRequest(uri, { endpoint: '/' + encodeURIComponent(previewId) });
		const payload = await response.json().catch(() => undefined);
		if (!response.ok) {
			throw previewError(response.status, payload?.error);
		}
		return payload;
	}

	/** `GET /api/v1/office-previews/:id/pdf` — the derived PDF itself. */
	async previewPdf(uri, previewId) {
		const response = await this.previewRequest(uri, { endpoint: '/' + encodeURIComponent(previewId) + '/pdf' });
		if (!response.ok) {
			const payload = await response.json().catch(() => undefined);
			throw previewError(response.status, payload?.error);
		}
		return new Uint8Array(await response.arrayBuffer());
	}

	async previewOutcome(response) {
		const payload = await response.json().catch(() => undefined);
		if (response.ok) {
			return payload;
		}
		// 404 on the collection means the deployment has the feature switched off. That is
		// a first-class answer, not a failure: the UI falls back to the original download.
		throw previewError(response.status, payload?.error);
	}

	async readDirectory(uri) {
		const entries = await (await this.request(uri, { readdir: '1' })).json();
		return entries.map(({ name, type }) => [name, type]);
	}

	async readFile(uri, { expectedEtag } = {}) {
		const headers = expectedEtag ? { 'If-Match': expectedEtag } : undefined;
		const response = await this.request(uri, {}, { headers });
		const contents = new Uint8Array(await response.arrayBuffer());
		if (expectedEtag === undefined) {
			this.legacyReadVersions.set(uri.toString(), response.headers.get('ETag'));
		}
		return contents;
	}

	async writeFile(uri, contents, { create, overwrite, expectedEtag }) {
		const version = expectedEtag ?? this.legacyReadVersions.get(uri.toString());
		const headers = { 'Content-Type': 'application/octet-stream' };
		if (version) {
			headers['If-Match'] = version;
		}
		const response = await this.request(uri, { create: create ? '1' : '0', overwrite: overwrite ? '1' : '0' }, {
			method: 'PUT', headers, body: contents,
		});
		if (expectedEtag === undefined) {
			this.legacyReadVersions.set(uri.toString(), response.headers.get('ETag'));
		}
		const stat = await response.json();
		this.changes.fire([{ type: response.status === 201 ? vscode.FileChangeType.Created : vscode.FileChangeType.Changed, uri }]);
		return stat;
	}

	async createDirectory(uri) {
		await this.request(uri, { mkdir: '1' }, { method: 'POST' });
		this.changes.fire([{ type: vscode.FileChangeType.Created, uri }]);
	}

	async rename(from, to, { overwrite }) {
		if (from.authority !== to.authority) throw new Error('CrossWorkspaceMoveUnsupported');
		await this.request(from, { rename: to.path, overwrite: overwrite ? '1' : '0' }, { method: 'POST' });
		this.changes.fire([
			{ type: vscode.FileChangeType.Deleted, uri: from },
			{ type: vscode.FileChangeType.Created, uri: to },
		]);
	}

	async delete(uri, { recursive, trashId }) {
		const query = { recursive: recursive ? '1' : '0' };
		if (trashId) {
			query.trashId = trashId;
		}
		await this.request(uri, query, { method: 'DELETE' });
		this.changes.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
	}

	async provideFileSearchResults(query, options, token) {
		const limit = options.maxResults ?? 20_000;
		if (limit <= 0 || token.isCancellationRequested) {
			return [];
		}
		const controller = new AbortController();
		const subscription = token.onCancellationRequested(() => controller.abort());
		try {
			const response = await this.request(options.folder, { files: '1', pattern: query.pattern, limit: String(limit) }, { signal: controller.signal });
			const paths = await response.json();
			return paths.map(path => options.folder.with({ path }));
		} catch (error) {
			if (token.isCancellationRequested) {
				return [];
			}
			throw error;
		} finally {
			subscription.dispose();
		}
	}

	// One page of body-text hits from /search/v1. The server has already joined the index
	// back to the live storage metadata, so every item it returns is a file this caller may
	// still read; the extension does not need its own staleness filter.
	async searchText(uri, { query, limit, cursor, signal } = {}) {
		const workspaceId = uri.authority?.startsWith('mount-') ? workspaceFromAuthority(uri.authority) : undefined;
		if (!workspaceId) {
			throw new Error('WorkspaceSessionRequired');
		}
		const url = new URL('/search/v1/query', this.origin);
		const params = { q: query, limit: String(limit) };
		if (cursor) {
			params.cursor = cursor;
		}
		url.search = new URLSearchParams(params).toString();
		let response;
		try {
			response = await fetch(url, {
				cache: 'no-store',
				redirect: 'error',
				headers: new Headers({
					'X-Log4Stellar-Workspace': workspaceId,
					'X-Log4Stellar-Workspace-Account': accountFromAuthority(uri.authority),
				}),
				signal,
			});
		} catch (error) {
			if (signal?.aborted) throw error;
			throw localizedFailure('NetworkUnavailable');
		}
		const payload = await response.json().catch(() => undefined);
		if (!response.ok) {
			throw localizedFailure(failureCode(response.status, payload?.error, 'SearchRequestFailed'));
		}
		return payload;
	}

	/**
	 * Feeds the workspace search panel. Only the newest search reports: a response whose
	 * ticket has been superseded, or whose token was cancelled while it was in flight, is
	 * dropped instead of being rendered (S03).
	 *
	 * The preview is plain text and the highlight is expressed as a Range inside it, so a
	 * note that contains HTML is displayed as text and can never be executed.
	 */
	async provideTextSearchResults(query, options, progress, token) {
		const ticket = ++this.searchTicket;
		if (token.isCancellationRequested) {
			return { limitHit: false };
		}
		const limit = Math.min(Math.max(Number(options.maxResults) || 50, 1), 200);
		const controller = new AbortController();
		const subscription = token.onCancellationRequested(() => controller.abort());
		try {
			const page = await this.searchText(options.folder, { query: query.pattern, limit, signal: controller.signal });
			if (ticket !== this.searchTicket || token.isCancellationRequested) {
				return { limitHit: false };
			}
			for (const item of page.items ?? []) {
				const uri = options.folder.with({ path: item.path });
				const previewStart = new vscode.Position(0, item.excerptOffset);
				const previewEnd = new vscode.Position(0, item.excerptOffset + item.excerptLength);
				const line = Math.max(item.line - 1, 0);
				const column = Math.max(item.column - 1, 0);
				const sourceLength = item.match === 'body' ? item.excerptLength : 0;
				progress.report({
					uri,
					ranges: [new vscode.Range(new vscode.Position(line, column), new vscode.Position(line, column + sourceLength))],
					preview: { text: item.excerpt, matches: [new vscode.Range(previewStart, previewEnd)] },
				});
			}
			return { limitHit: page.hasMore === true };
		} catch (error) {
			if (token.isCancellationRequested || ticket !== this.searchTicket) {
				return { limitHit: false };
			}
			throw error;
		} finally {
			subscription.dispose();
		}
	}
}

function publishRestoredFiles(provider, root, restored) {
	const paths = new Set(restored.flatMap(({ path, createdParents }) => [...createdParents, path]));
	provider.changes.fire([...paths].map(path => ({
		type: vscode.FileChangeType.Created,
		uri: root.with({ path }),
	})));
	void vscode.commands.executeCommand('markdown.workspaceTrash.refresh').then(undefined, () => {});
}

const gitLabels = {
	en: {
		status: 'Working tree', log: 'Commit history', fetch: 'Fetch', push: 'Push', branch: 'Branch',
		clean: 'The working tree is clean.', empty: 'The repository has no commits.', noBinding: 'This workspace has no linked Git repository.',
		noRemote: 'This repository has no remote.', fetchFirst: 'Fetch the configured remote branch before pushing.',
		confirmFetch: 'Fetch updates from the configured remote?', fetched: 'Fetch completed.', pushed: 'Push completed.',
		confirmPush: 'Push {0} at {1} to the configured remote?', denied: 'Your workspace role does not allow this Git action.',
		moved: 'The remote branch changed. Fetch the latest state before trying again.', failed: 'The Git action failed. Refresh the repository status and try again.',
		switchBranch: "Switch branch",
		diverged: 'The push would overwrite remote commits. Integrate the remote changes before pushing.',
		currentBranch: "Current branch",
		noLocalBranches: "There are no other local branches.",
		switched: "Switched to {0}.",
		dirty: "Commit or stash the changes in the repository before switching branches.",
		branchMissing: "The selected branch no longer exists. Refresh the branch list.",
		pushBranchOnly: "Switch to the configured remote branch before pushing.",
		headChanged: "The local commit changed. Review the current commit before pushing.",
	},
	'zh-cn': {
		status: '工作树状态', log: '提交历史', fetch: '拉取远端引用', push: '推送', branch: '分支',
		clean: '工作树没有未提交的改动。', empty: '此仓库还没有提交。', noBinding: '此工作区尚未关联 Git 仓库。',
		noRemote: '此仓库尚未配置远端。', fetchFirst: '请先拉取已配置的远端分支，再推送。',
		confirmFetch: '从已配置的远端拉取更新？', fetched: '已拉取远端引用。', pushed: '已推送。',
		confirmPush: '将分支 {0} 的提交 {1} 推送到已配置的远端？', denied: '当前工作区角色没有执行此 Git 操作的权限。',
		moved: '远端分支已变化，请先重新拉取。', failed: 'Git 操作失败。请刷新仓库状态后重试。',
		switchBranch: "切换分支",
		diverged: '这次推送会覆盖远端提交。请先合并远端变更或完成变基，再推送。',
		currentBranch: "当前分支",
		noLocalBranches: "没有可切换的本地分支。",
		switched: "已切换到 {0}。",
		dirty: "工作树有未提交的改动。请先提交或暂存改动，再切换分支。",
		branchMissing: "选中的分支已不存在，请刷新分支列表。",
		pushBranchOnly: "请先切换到配置的远端分支，再推送。",
		headChanged: "本地提交已变化，请核对当前提交后再推送。",
	},
	'zh-tw': {
		status: '工作樹狀態', log: '提交記錄', fetch: '擷取遠端參照', push: '推送', branch: '分支',
		clean: '工作樹沒有未提交的變更。', empty: '此儲存庫還沒有提交。', noBinding: '此工作區尚未連結 Git 儲存庫。',
		noRemote: '此儲存庫尚未設定遠端。', fetchFirst: '請先擷取已設定的遠端分支，再推送。',
		confirmFetch: '從已設定的遠端擷取更新？', fetched: '已擷取遠端參照。', pushed: '已推送。',
		confirmPush: '將分支 {0} 的提交 {1} 推送到已設定的遠端？', denied: '目前工作區角色沒有執行此 Git 操作的權限。',
		moved: '遠端分支已變更，請先重新擷取。', failed: 'Git 操作失敗。請重新整理儲存庫狀態後再試。',
		switchBranch: "切換分支",
		diverged: '這次推送會覆蓋遠端提交。請先合併遠端變更或完成重定基底，再推送。',
		currentBranch: "目前分支",
		noLocalBranches: "沒有可切換的本機分支。",
		switched: "已切換至 {0}。",
		dirty: "工作樹有未提交的變更。請先提交或暫存變更，再切換分支。",
		branchMissing: "選取的分支已不存在，請重新整理清單。",
		pushBranchOnly: "請先切換到已設定的遠端分支，再推送。",
		headChanged: "本機提交已變更，請確認目前的提交後再推送。",
	},
	ja: {
		status: '作業ツリー', log: 'コミット履歴', fetch: 'フェッチ', push: 'プッシュ', branch: 'ブランチ',
		clean: '作業ツリーに未コミットの変更はありません。', empty: 'このリポジトリにはコミットがありません。', noBinding: 'このワークスペースには Git リポジトリが関連付けられていません。',
		noRemote: 'リモートが設定されていません。', fetchFirst: 'プッシュする前にリモート ブランチをフェッチしてください。',
		confirmFetch: '設定されているリモートから更新をフェッチしますか？', fetched: 'フェッチしました。', pushed: 'プッシュしました。',
		confirmPush: '{0} のコミット {1} を設定済みのリモートにプッシュしますか？', denied: 'ワークスペースのロールではこの Git 操作は許可されていません。',
		moved: 'リモート ブランチが変更されました。再度フェッチしてください。', failed: 'Git 操作に失敗しました。リポジトリの状態を更新してから再試行してください。',
		switchBranch: "ブランチの切り替え",
		diverged: 'このプッシュはリモートのコミットを上書きします。リモートの変更を取り込んでから再度プッシュしてください。',
		currentBranch: "現在のブランチ",
		noLocalBranches: "切り替え先のローカル ブランチがありません。",
		switched: "{0} に切り替えました。",
		dirty: "未コミットの変更があります。コミットまたはスタッシュしてからブランチを切り替えてください。",
		branchMissing: "選択したブランチが存在しません。一覧を更新してください。",
		pushBranchOnly: "プッシュする前に、設定済みのリモート ブランチに切り替えてください。",
		headChanged: "ローカルのコミットが変わりました。現在のコミットを確認してからプッシュしてください。",
	},
};

async function openGitRepository(provider, folder) {
	const labels = gitLabels[languageOf()];
	if (!folder) {
		await vscode.window.showInformationMessage(labels.noBinding);
		return;
	}
	const request = (endpoint, options) => provider.gitRequest(folder.uri, endpoint, options);
	try {
		const { bound, repository } = await request('repository');
		if (!bound) {
			await vscode.window.showInformationMessage(labels.noBinding);
			return;
		}
		const branch = repository.head?.branch;
		const actions = [
			{ id: 'status', label: labels.status },
			{ id: 'log', label: labels.log },
			{ id: 'switchBranch', label: labels.switchBranch },
			...(repository.remoteId ? [{ id: 'fetch', label: labels.fetch }, { id: 'push', label: labels.push }] : []),
		];
		const title = branch ? `${repository.path} · ${labels.branch} ${branch}` : repository.path;
		const action = await vscode.window.showQuickPick(actions, { title });
		switch (action?.id) {
			case 'status': {
				const { workTree } = await request('status');
				if (workTree.clean) {
					await vscode.window.showInformationMessage(labels.clean);
					return;
				}
				const entries = workTree.entries.map(change => ({ label: change.path, description: change.index + change.workTree }));
				await vscode.window.showQuickPick(entries, { title: labels.status, matchOnDescription: true });
				return;
			}
			case 'log': {
				const { commits } = await request('log', { query: { limit: '50' } });
				if (!commits.length) {
					await vscode.window.showInformationMessage(labels.empty);
					return;
				}
				await vscode.window.showQuickPick(commits.map(commit => ({
					label: commit.subject || commit.commit.slice(0, 12),
					description: commit.commit.slice(0, 12),
					detail: [commit.author, commit.date].filter(Boolean).join(' · '),
				})), { title: labels.log, matchOnDescription: true, matchOnDetail: true });
				return;
			}
			case 'switchBranch': {
				const { branches, current } = await request('branches');
				const targets = branches.filter(entry => !entry.current && entry.name !== current);
				if (!targets.length) {
					await vscode.window.showInformationMessage(labels.noLocalBranches);
					return;
				}
				const target = await vscode.window.showQuickPick(targets.map(entry => ({
					label: entry.name,
					description: entry.commit.slice(0, 12),
				})), { title: labels.switchBranch, placeHolder: current ? `${labels.currentBranch} ${current}` : undefined });
				if (!target) return;
				await request('branch', { body: { name: target.label } });
				await vscode.window.showInformationMessage(labels.switched.replace('{0}', () => target.label));
				return;
			}
			case 'fetch': {
				if (await vscode.window.showWarningMessage(labels.confirmFetch, { modal: true }, labels.fetch) === labels.fetch) {
					await request('fetch', { body: {} });
					await vscode.window.showInformationMessage(labels.fetched);
				}
				return;
			}
			case 'push': {
				if (!branch || branch !== repository.remoteBranch || !repository.head.commit) {
					await vscode.window.showWarningMessage(labels.pushBranchOnly);
					return;
				}
				if (!repository.lastFetch) {
					await vscode.window.showWarningMessage(labels.fetchFirst);
					return;
				}
				const confirmation = labels.confirmPush.replace('{0}', () => branch)
					.replace('{1}', () => repository.head.commit.slice(0, 12));
				if (await vscode.window.showWarningMessage(confirmation, { modal: true }, labels.push) === labels.push) {
					await request('push', { body: {
						branch,
						expectedHead: repository.head.commit,
						expectedRemoteId: repository.remoteId,
						expectedRemote: repository.lastFetch.commit,
					} });
					await vscode.window.showInformationMessage(labels.pushed);
				}
			}
		}
	} catch (error) {
		const code = error?.message;
		const errors = {
			NoPermissions: labels.denied, AccountChanged: labels.denied, WorkspaceSessionRequired: labels.denied,
			RemoteChanged: labels.moved, NotFastForward: labels.diverged, HeadChanged: labels.headChanged,
			WorkTreeDirty: labels.dirty, BranchNotFound: labels.branchMissing,
		};
		const message = Object.hasOwn(errors, code) ? errors[code] : labels.failed;
		await vscode.window.showErrorMessage(message);
	}
}

// ---------------------------------------------------------------------------------------
// Preview polling and rendering (05-Office文件预览.md §4 "Web 入口").
// ---------------------------------------------------------------------------------------

/**
 * Asks which revision to preview. Returns `null` for the current version, a revision id for
 * a historical one, and `undefined` when the user dismissed the picker.
 */
async function choosePreviewVersion(provider, uri, labels) {
	if (typeof provider.request !== 'function' || typeof vscode.window.showQuickPick !== 'function') {
		return null;
	}
	// The version list is the file API's own history endpoint: a preview must never invent a
	// revision, and it also must not need a second source of truth for "what versions exist".
	const versions = await (await provider.request(uri, { versions: '1' })).json().catch(() => []);
	if (!Array.isArray(versions) || versions.length <= 1) {
		return null;
	}
	const picked = await vscode.window.showQuickPick(versions.map(version => ({
		label: version.current ? labels.current : labels.version.replace('{0}', String(version.id).slice(0, 8)),
		description: new Date(version.createdAt).toISOString(),
		id: version.id,
		current: version.current === true,
	})), { title: labels.history, matchOnDescription: true });
	if (!picked) {
		return undefined;
	}
	return picked.current ? null : picked.id;
}

/**
 * Polls a queued preview until it is ready, fails, or the caller gives up.
 *
 * The backoff is bounded because the server owns the real limits (one conversion at a time,
 * a 60 s timeout, a 20 job queue): the client only has to avoid hammering it. A terminal
 * state stops immediately, which is what keeps "损坏或密码保护的文件不反复转换" true end to end.
 */
async function pollPreviewStatus(provider, uri, previewId, {
	attempts = 40, firstDelayMs = 400, maxDelayMs = 5000, token,
	wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
	let delay = firstDelayMs;
	let last;
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		if (token?.isCancellationRequested) {
			throw Object.assign(new Error('PreviewCancelled'), { reason: 'cancelled' });
		}
		last = await provider.previewStatus(uri, previewId);
		if (last.state === 'ready') {
			return last;
		}
		if (last.state === 'failed') {
			throw Object.assign(new Error(last.error ?? 'PreviewFailed'), { reason: previewErrorReason(last.error) });
		}
		await wait(delay);
		delay = Math.min(maxDelayMs, Math.round(delay * 1.6));
	}
	// Out of patience, not out of hope: the row keeps converting server side and a later
	// click on the same file will pick it up.
	throw Object.assign(new Error('PreviewNotReady'), { reason: 'notReady', preview: last });
}

function previewMessage(labels, reason, fallback = labels.unavailable) {
	if (reason === 'expired') return translated(workspaceFeedback.SessionExpired);
	if (reason === 'accountChanged') return translated(workspaceFeedback.AccountChanged);
	if (reason === 'network') return translated(workspaceFeedback.NetworkUnavailable);
	return Object.hasOwn(labels, reason) ? labels[reason] : fallback;
}

function previewErrorReason(code) {
	return Object.hasOwn(previewErrors, code) ? previewErrors[code] : 'unavailable';
}

/**
 * Shows a ready PDF in a webview panel.
 *
 * The panel title carries the file name and the revision, so a panel left open across a
 * workspace switch (or a version restore) is visibly stale rather than silently wrong.
 */
async function renderPreviewPane(provider, uri, preview, { labels, extensionUri } = {}) {
	const messages = labels ?? previewLabels[languageOf()];
	const bytes = await provider.previewPdf(uri, preview.id);
	const name = uri.path.split('/').pop() || 'document';
	const version = preview.revisionId ? String(preview.revisionId).slice(0, 8) : '';
	const title = version ? `${name} · ${version}` : name;

	if (typeof vscode.window.createWebviewPanel !== 'function') {
		// A host without webviews still gets a working preview: the bytes are downloaded to
		// the local file system through the normal save path.
		const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(name.replace(/\.[^.]+$/, '') + '.pdf'), title: messages.title });
		if (!target) {
			return undefined;
		}
		await vscode.workspace.fs.writeFile(target, bytes);
		return target;
	}

	const panel = vscode.window.createWebviewPanel(
		'log4stellar.preview',
		title,
		vscode.ViewColumn.Active,
		{ enableScripts: true, localResourceRoots: [extensionUri] },
	);
	configureOfficePreview(panel, extensionUri, messages, async () => bytes);
	return panel;
}

function configureOfficePreview(panel, extensionUri, messages, load, token) {
	const viewerUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'office-viewer.mjs'));
	const assetOrigin = escapeAttribute(new URL(viewerUri.toString()).origin);
	const workerUri = escapeAttribute(new URL('./pdf.worker.min.mjs', viewerUri.toString()).href);
	const pageLabel = translated(['Page {0} of {1}', '第 {0} 页，共 {1} 页', '第 {0} 頁，共 {1} 頁', '{1} ページ中 {0} ページ']);
	const previewLabel = translated(['Document preview', '文档预览', '文件預覽', 'ドキュメントのプレビュー']);
	const emptyLabel = translated(['This document has no preview pages.', '此文档没有可预览的页面。', '此文件沒有可預覽的頁面。', 'このドキュメントにプレビューできるページがありません。']);
	const drawError = translated([
		'The PDF preview could not be displayed. Reopen it to try again.',
		'无法显示 PDF 预览，请重新打开。',
		'無法顯示 PDF 預覽，請重新開啟。',
		'PDF プレビューを表示できません。開き直して再試行してください。',
	]);
	let disposed = false;
	let result;
	const listener = panel.webview.onDidReceiveMessage(async message => {
		if (message?.type !== 'ready' || disposed) {
			return;
		}
		result ??= load();
		try {
			const bytes = await result;
			if (!disposed) {
				await panel.webview.postMessage({ type: 'document', bytes: bytes.slice() });
			}
		} catch (error) {
			if (!disposed && error?.reason !== 'cancelled') {
				const text = previewMessage(messages, error?.reason);
				await panel.webview.postMessage({ type: 'error', text });
			}
		}
	});
	panel.onDidDispose(() => {
		disposed = true;
		listener.dispose();
		token?.cancel();
		token?.dispose();
	});
	panel.webview.html = [
		'<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
		`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${assetOrigin}; worker-src blob:; connect-src ${workerUri}; font-src blob:; style-src 'unsafe-inline';">`,
		'<style>body{margin:0;background:var(--vscode-editor-background);color:var(--vscode-editor-foreground);font-family:var(--vscode-font-family)}',
		'#status{padding:12px;text-align:center}progress{width:min(320px,90%);accent-color:var(--vscode-progressBar-background)}',
		'#pages{padding:12px}section{margin:0 auto 12px;width:100%;background:#fff;box-shadow:0 1px 6px #0004}canvas{display:block;width:100%;height:auto}</style>',
		`</head><body><div id="status" role="status" data-error="${escapeAttribute(drawError)}"><p id="message">${escapeAttribute(messages.preparing)}</p>`,
		`<progress aria-label="${escapeAttribute(messages.preparing)}"></progress></div><main id="pages" tabindex="0" aria-label="${escapeAttribute(previewLabel)}" data-page-label="${escapeAttribute(pageLabel)}" data-empty="${escapeAttribute(emptyLabel)}"></main>`,
		`<script type="module" src="${escapeAttribute(viewerUri.toString())}"></script></body></html>`,
	].join('');
}

function registerOfficeEditor(context, provider) {
	const viewType = 'log4stellar.officePreview';
	context.subscriptions.push(vscode.window.registerCustomEditorProvider(viewType, {
		openCustomDocument(uri) {
			return { uri, dispose() {} };
		},
		resolveCustomEditor(document, panel) {
			const uri = document.uri;
			const token = new vscode.CancellationTokenSource();
			panel.webview.options = { enableScripts: true, localResourceRoots: [context.extensionUri] };
			const labels = previewLabels[languageOf()];
			configureOfficePreview(panel, context.extensionUri, labels, async () => {
				const pending = await provider.requestOfficePreview(uri);
				const ready = pending.state === 'ready' ? pending
					: await pollPreviewStatus(provider, uri, pending.id, { token: token.token });
				if (token.token.isCancellationRequested) {
					throw Object.assign(new Error('PreviewCancelled'), { reason: 'cancelled' });
				}
				return provider.previewPdf(uri, ready.id);
			}, token);
		},
	}));
}

function escapeAttribute(value) {
	return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * The user facing entry point of the preview feature (PV01–PV08 through the UI).
 *
 * It is deliberately tolerant of a deployment without the pipeline: a 404 on the collection
 * means the route does not exist, and the original file is offered instead. The version
 * picker reuses the file API's version history, so a historical revision is always previewed
 * with an explicit `revisionId` — the current version is previewed without one, which locks
 * the identity to the revision the server sees at request time.
 */
async function openOfficePreview(provider, uri, options = {}) {
	const labels = previewLabels[languageOf()];
	if (!uri) {
		return undefined;
	}
	try {
		let revisionId = options.revisionId;
		if (options.chooseVersion) {
			const version = await choosePreviewVersion(provider, uri, labels);
			if (version === undefined) {
				return undefined;
			}
			// `null` means "the user picked the current version": sending no revisionId at all
			// is what makes the server lock the identity to the revision it reads at request
			// time instead of trusting a stale id from the client. A `null` body field would
			// be a 400, so it is normalised to "absent" here.
			revisionId = version ?? undefined;
		}
		const outcome = await provider.requestOfficePreview(uri, { revisionId });
		if (outcome.state === 'ready') {
			return renderPreviewPane(provider, uri, outcome, { labels, extensionUri: options.extensionUri });
		}
		// Still queued: say so, offer to stop waiting, and poll with a bounded backoff.
		const tokenSource = new vscode.CancellationTokenSource();
		void vscode.window.showInformationMessage(labels.preparing, labels.cancelled).then(choice => {
			if (choice) {
				tokenSource.cancel();
			}
		}, () => {});
		try {
			const ready = await pollPreviewStatus(provider, uri, outcome.id, { token: tokenSource.token, wait: options.wait });
			return renderPreviewPane(provider, uri, ready, { labels, extensionUri: options.extensionUri });
		} finally {
			tokenSource.dispose();
		}
	} catch (error) {
		const reason = error?.reason ?? 'unavailable';
		const message = previewMessage(labels, reason);
		if (reason === 'cancelled') {
			return undefined;
		}
		await vscode.window.showWarningMessage(message);
		return undefined;
	}
}


const knowledgeViewId = 'log4stellar.knowledge';
const knowledgeOpenCommand = 'log4stellar.knowledge.open';
const knowledgeMoreCommand = 'log4stellar.knowledge.more';

async function requestKnowledge(provider, uri, route, query = {}, { body, signal } = {}) {
	const workspace = workspaceFromAuthority(uri.authority);
	const url = new URL('/api/knowledge/' + route, provider.origin);
	url.search = new URLSearchParams(query).toString();
	const headers = new Headers({
		'X-Log4Stellar-Workspace': workspace,
		'X-Log4Stellar-Workspace-Account': accountFromAuthority(uri.authority),
	});
	if (body !== undefined) {
		headers.set('Content-Type', 'application/json');
	}
	const response = await fetch(url, {
		cache: 'no-store', redirect: 'error', signal, headers,
		method: body === undefined ? 'GET' : 'POST',
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	if (!response.ok) {
		throw Object.assign(new Error('KnowledgeRequestFailed'), { status: response.status });
	}
	return response.json();
}

function registerKnowledgeView(context, provider) {
	const language = vscode.env.language.toLowerCase();
	const translations = language === 'zh-tw'
		? ['反向連結', '標籤', '失效連結', '開啟 Markdown 筆記以查看反向連結', '沒有結果', '載入更多', '讀取知識關聯失敗', '更新知識索引', '索引更新失敗，請檢查工作區寫入權限', '索引已更新', '未找到目標', '同名歧義']
		: language.startsWith('zh')
			? ['反向链接', '标签', '断链', '打开 Markdown 笔记以查看反向链接', '没有结果', '加载更多', '读取知识关联失败', '更新知识索引', '索引更新失败，请检查工作区写入权限', '索引已更新', '未找到目标', '同名歧义']
			: language === 'ja'
				? ['バックリンク', 'タグ', 'リンク切れ', 'Markdown ノートを開いてください', '結果なし', 'さらに読み込む', 'ナレッジ関連を読み込めません', 'ナレッジ索引を更新', '索引を更新できません。書き込み権限を確認してください', '索引を更新しました', 'リンク先がありません', '同じ名前が複数あります']
				: ['Backlinks', 'Tags', 'Broken links', 'Open a Markdown note to see backlinks', 'No results', 'Load more', 'Could not load knowledge links', 'Update knowledge index', 'Could not update the index. Check your workspace write permission.', 'Index updated', 'Target missing', 'Ambiguous target'];
	const [backlinks, tags, broken, openNote, empty, more, unavailable, reindex, reindexError, updated, missing, ambiguous] = translations;
	const change = new vscode.EventEmitter();
	const pages = new Map();
	let controller = new AbortController();
	const groups = [
		{ id: 'backlinks', label: backlinks },
		{ id: 'tags', label: tags },
		{ id: 'broken', label: broken },
	];

	const root = () => vscode.workspace.workspaceFolders?.find(folder => folder.uri.scheme === scheme)?.uri;
	const active = () => vscode.window.tabGroups.activeTabGroup.activeTab?.input?.uri;
	const markdown = uri => uri?.scheme === scheme && /\.(?:md|markdown|mdown|mkdn|mkd|mdwn|mdtxt|mdtext)$/i.test(uri.path);
	const source = (rootUri, row) => {
		const path = row.sourcePath ?? row.path;
		if (typeof path !== 'string' || !path.startsWith('/')) {
			return undefined;
		}
		const line = row.line;
		const column = row.column;
		const title = path.split('/').pop() || path;
		return { label: title, description: path + ':' + line, uri: rootUri.with({ path }), line, column };
	};
	const refresh = () => {
		controller.abort();
		controller = new AbortController();
		pages.clear();
		change.fire();
	};
	const readPage = async (parent, request, project, cursor) => {
		const signal = controller.signal;
		try {
			const result = await request(cursor, signal);
			if (signal.aborted) {
				return [];
			}
			const items = [...(cursor ? pages.get(parent.id)?.items ?? [] : []), ...project(result)];
			const nextCursor = result.nextCursor;
			pages.set(parent.id, { items, nextCursor, request, project });
			return nextCursor
				? [...items, { label: more, nextCursor, parent }]
				: items.length ? items : [{ label: empty }];
		} catch {
			if (signal.aborted) return [];
			const items = [{ label: unavailable }];
			pages.set(parent.id, { items });
			return items;
		}
	};
	const getChildren = async parent => {
		const rootUri = root();
		if (!rootUri) {
			return [];
		}
		if (!parent) {
			return groups;
		}
		const cached = pages.get(parent.id);
		if (cached) {
			return cached.nextCursor
				? [...cached.items, { label: more, nextCursor: cached.nextCursor, parent }]
				: cached.items.length ? cached.items : [{ label: empty }];
		}
		const load = (route, query, project) => {
			const request = (cursor, signal) => requestKnowledge(provider, rootUri, route, { ...query, ...(cursor ? { cursor } : {}) }, { signal });
			return readPage(parent, request, project);
		};
		const links = body => body.links.map(row => {
			const item = source(rootUri, row);
			if (item && parent.id === 'broken') {
				item.description = (row.status === 'ambiguous' ? ambiguous : missing) + ' · ' + String(row.raw);
			}
			return item;
		}).filter(Boolean);
		if (parent.id === 'backlinks') {
			const uri = active();
			if (!markdown(uri) || uri.authority !== rootUri.authority) {
				return [{ label: openNote }];
			}
			return load('backlinks', { path: uri.path, limit: 50 }, links);
		}
		if (parent.id === 'tags') {
			return load('tags', { limit: 50 }, body => body.tags.map(row => ({
				id: 'tag:' + row.tagKey, label: '#' + row.tag, description: String(row.uses), tagKey: row.tagKey,
			})));
		}
		if (parent.tagKey) {
			return load('tags/' + encodeURIComponent(parent.tagKey), { limit: 50 },
				body => body.occurrences.map(row => source(rootUri, row)).filter(Boolean));
		}
		if (parent.id === 'broken') {
			return load('broken', { limit: 50, excludeExternal: '1' }, links);
		}
		return [];
	};
	context.subscriptions.push(change,
		new vscode.Disposable(() => controller.abort()),
		vscode.window.tabGroups.onDidChangeTabs(refresh),
		vscode.window.tabGroups.onDidChangeTabGroups(refresh),
		vscode.workspace.onDidChangeWorkspaceFolders(refresh),
		vscode.workspace.onDidSaveTextDocument(({ uri }) => { if (markdown(uri)) refresh(); }),
		vscode.window.registerTreeDataProvider(knowledgeViewId, {
			onDidChangeTreeData: change.event,
			getChildren,
			getTreeItem(entry) {
				const item = new vscode.TreeItem(entry.label, entry.id
					? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
				item.id = entry.id;
				item.description = entry.description;
				if (entry.uri) item.command = { command: knowledgeOpenCommand, title: entry.label, arguments: [entry] };
				if (entry.nextCursor) item.command = { command: knowledgeMoreCommand, title: entry.label, arguments: [entry] };
				return item;
			},
		}),
		vscode.commands.registerCommand(knowledgeOpenCommand, async entry => {
			const rootUri = root();
			if (!rootUri || entry?.uri?.scheme !== scheme || entry.uri.authority !== rootUri.authority) {
				return;
			}
			const position = new vscode.Position(Math.max(0, (entry.line || 1) - 1), Math.max(0, (entry.column || 1) - 1));
			const selection = new vscode.Range(position, position);
			const editor = await vscode.window.showTextDocument(entry.uri, { selection });
			editor.revealRange(selection);
		}),
		vscode.commands.registerCommand(knowledgeMoreCommand, async ({ parent, nextCursor }) => {
			const page = pages.get(parent.id);
			if (page?.nextCursor === nextCursor) {
				await readPage(parent, page.request, page.project, nextCursor);
				change.fire(parent);
			}
		}),
		vscode.commands.registerCommand('log4stellar.knowledge.refresh', refresh),
		vscode.commands.registerCommand('log4stellar.knowledge.reindex', async () => {
			const rootUri = root();
			if (!rootUri) return;
			try {
				const result = await vscode.window.withProgress({ title: reindex, location: vscode.ProgressLocation.Notification },
					() => requestKnowledge(provider, rootUri, 'reindex', {}, { body: { force: true } }));
				refresh();
				await vscode.window.showInformationMessage(updated + ': ' + result.indexed
					+ (result.failed.length ? ' · ' + unavailable + ': ' + result.failed.length : ''));
			} catch {
				await vscode.window.showWarningMessage(reindexError);
			}
		}),
	);
}

async function activate(context) {
	const provider = new WorkspaceFileSystem(new URL(context.extensionUri.toString()).origin);
	const root = vscode.workspace.workspaceFolders?.find(folder => folder.uri.scheme === scheme)?.uri ?? vscode.Uri.from({ scheme, path: '/' });
	const capabilities = await provider.request(root, { capabilities: '1' })
		.then(response => response.json())
		.catch(() => undefined);
	context.subscriptions.push(provider);
	context.subscriptions.push(vscode.workspace.registerFileSystemProvider(scheme, provider, { isCaseSensitive: true, serverVersioned: true, serverTrash: capabilities?.recycleBin === true }));
	context.subscriptions.push(vscode.workspace.registerFileSearchProvider(scheme, provider));
	// Body-text search reuses the built-in Search view instead of adding a second search
	// surface, so a hit opens the note at the reported line like any other file hit.
	context.subscriptions.push(vscode.workspace.registerTextSearchProvider(scheme, provider));

	registerOfficeEditor(context, provider);
	if (typeof vscode.window.registerTreeDataProvider === 'function') {
		registerKnowledgeView(context, provider);
	}
	context.subscriptions.push(vscode.commands.registerCommand('log4stellar.workspace.preview', async uri => {
		const resource = uri instanceof vscode.Uri ? uri : undefined;
		const active = resource ?? vscode.window.activeTextEditor?.document?.uri;
		if (!active) {
			return undefined;
		}
		return vscode.commands.executeCommand('vscode.openWith', active, 'log4stellar.officePreview');
	}));
	context.subscriptions.push(vscode.commands.registerCommand('log4stellar.workspace.previewVersion', async uri => {
		const resource = uri instanceof vscode.Uri ? uri : undefined;
		const active = resource ?? vscode.window.activeTextEditor?.document?.uri;
		if (!active) {
			return undefined;
		}
		return openOfficePreview(provider, active, { extensionUri: context.extensionUri, chooseVersion: true });
	}));
	context.subscriptions.push(vscode.commands.registerCommand('log4stellar.workspace.tenants', () =>
		vscode.env.openExternal(vscode.Uri.parse(new URL('/account/tenants', provider.origin).toString()))));
	context.subscriptions.push(vscode.commands.registerCommand('log4stellar.workspace.advancedSearch', () => {
		const folder = vscode.workspace.workspaceFolders?.find(item => item.uri.scheme === scheme);
		if (!folder) return;
		const url = new URL('/advanced-search', provider.origin);
		url.searchParams.set('l4sWorkspace', workspaceFromAuthority(folder.uri.authority));
		return vscode.env.openExternal(vscode.Uri.parse(url.toString()));
	}));
	context.subscriptions.push(vscode.commands.registerCommand('log4stellar.workspace.upload', uri => {
		const root = vscode.workspace.workspaceFolders?.find(item => item.uri.scheme === scheme)?.uri;
		const folder = uri?.scheme === scheme ? uri : root;
		if (!folder) return;
		const workspaceId = workspaceFromAuthority(folder.authority);
		const url = new URL('/uploads', provider.origin);
		url.searchParams.set('l4sWorkspace', workspaceId);
		url.searchParams.set('directory', folder.path);
		return vscode.env.openExternal(vscode.Uri.parse(url.toString()));
	}));
	context.subscriptions.push(vscode.commands.registerCommand('log4stellar.workspace.git', () => {
		const folder = vscode.workspace.workspaceFolders?.find(item => item.uri.scheme === scheme);
		return openGitRepository(provider, folder);
	}));
	context.subscriptions.push(vscode.commands.registerCommand('log4stellar.workspace.capabilities', async () => {
		const folder = vscode.workspace.workspaceFolders?.find(item => item.uri.scheme === scheme);
		return folder ? (await provider.request(folder.uri, { capabilities: '1' })).json() : undefined;
	}));
	context.subscriptions.push(vscode.commands.registerCommand('log4stellar.workspace.versions', async uri =>
		(await provider.request(uri, { versions: '1' })).json()));
	context.subscriptions.push(vscode.commands.registerCommand('log4stellar.workspace.revision', async (uri, version) =>
		(await provider.request(uri, { revision: version })).text()));
	// Saves a historical revision to the local file system. The bytes never leave this extension,
	// because a binary payload cannot round-trip through a command result. The save dialog opens
	// before the download so the browser still sees the user gesture that opened the view.
	// The revision is buffered whole, so exporting a very large attachment costs its full size in
	// memory; that is bounded by the server upload limit (512 MiB by default), and streaming it
	// instead would need a download service this extension does not have in the browser.
	context.subscriptions.push(vscode.commands.registerCommand('log4stellar.workspace.saveRevision', async (uri, version, title) => {
		const name = uri.path.split('/').pop() || 'download';
		const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(name), title });
		if (!target) {
			return undefined;
		}
		const contents = new Uint8Array(await (await provider.request(uri, { revision: version })).arrayBuffer());
		await vscode.workspace.fs.writeFile(target, contents);
		return target;
	}));
	context.subscriptions.push(vscode.commands.registerCommand('log4stellar.workspace.restoreVersion', async (uri, version, expectedVersion) => {
		await provider.request(uri, { restoreVersion: version }, {
			method: 'POST', headers: { 'If-Match': '"' + expectedVersion + '"' },
		});
		provider.changes.fire([{ type: vscode.FileChangeType.Changed, uri }]);
	}));
	context.subscriptions.push(vscode.commands.registerCommand('log4stellar.workspace.trash', async root =>
		(await provider.request(root, { trash: '1' })).json()));
	context.subscriptions.push(vscode.commands.registerCommand('log4stellar.workspace.restoreTrash', async (resource, id, keepBoth) => {
		const root = resource.with({ path: '/' });
		const response = await provider.request(root, { restoreTrash: id, keepBoth: keepBoth ? '1' : '0' }, { method: 'POST' });
		const restored = await response.json();
		publishRestoredFiles(provider, root, [restored]);
		return restored.path;
	}));
	context.subscriptions.push(vscode.commands.registerCommand('log4stellar.workspace.restoreTrashBatch', async (resource, ids) => {
		const root = resource.with({ path: '/' });
		const response = await provider.request(root, { restoreTrashBatch: '1' }, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(ids),
		});
		publishRestoredFiles(provider, root, await response.json());
	}));
	// The recovery views must be reachable even without an open Markdown file.
	const recoveryViews = vscode.extensions.getExtension('vscode.markdown-language-features');
	if (recoveryViews && !recoveryViews.isActive) {
		void recoveryViews.activate().then(undefined, error => console.error('Could not activate Log4Stellar recovery views', error));
	}
}

module.exports = { activate, openGitRepository, openOfficePreview, pollPreviewStatus, renderPreviewPane, WorkspaceFileSystem };
