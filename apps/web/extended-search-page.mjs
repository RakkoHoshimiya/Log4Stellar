const escapeHtml = value => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');

const copy = {
	en: ['Search revisions and attachments', 'Search terms', 'Scope', 'All', 'Revisions', 'Current attachments', 'Search', 'Search more',
		'Searching…', 'Revision', 'Current attachment', 'Scanned {scanned}, matched {count}, skipped {skipped}',
		'Search is busy. Try again in a few seconds.', 'Your session expired. Sign in again.', 'You do not have access to this workspace.', 'Search failed. Please retry.'],
	'zh-cn': ['历史版本与附件搜索', '搜索词', '搜索范围', '全部', '历史版本', '当前附件', '搜索', '继续搜索',
		'正在搜索…', '历史版本', '当前附件', '扫描 {scanned} 项，匹配 {count} 项，跳过 {skipped} 项',
		'搜索繁忙，请稍后重试。', '会话已过期，请重新登录。', '你没有此工作区的访问权限。', '搜索失败，请重试。'],
	'zh-tw': ['歷史版本與附件搜尋', '搜尋詞', '搜尋範圍', '全部', '歷史版本', '目前附件', '搜尋', '繼續搜尋',
		'正在搜尋…', '歷史版本', '目前附件', '掃描 {scanned} 項，符合 {count} 項，略過 {skipped} 項',
		'搜尋繁忙，請稍後再試。', '工作階段已過期，請重新登入。', '你無法存取此工作區。', '搜尋失敗，請再試一次。'],
	ja: ['バージョン履歴と添付ファイルの検索', '検索語', '検索範囲', 'すべて', 'バージョン履歴', '現在の添付ファイル', '検索', '続けて検索',
		'検索中…', 'バージョン履歴', '現在の添付ファイル', '{scanned} 件を確認、{count} 件一致、{skipped} 件をスキップ',
		'検索が混み合っています。少し待って再試行してください。', 'セッションの有効期限が切れました。再度サインインしてください。', 'このワークスペースにアクセスできません。', '検索に失敗しました。もう一度お試しください。'],
};

export function extendedSearchPage({ locale, workspaceId }) {
	const tag = (locale ?? '').toLowerCase();
	const language = ['zh-tw', 'zh-hk', 'zh-hant'].includes(tag) ? 'zh-tw' : tag.startsWith('zh') ? 'zh-cn' : tag.startsWith('ja') ? 'ja' : 'en';
	const [title, terms, scope, all, history, attachments, search, more, ...status] = copy[language];
	return `<!doctype html><html lang="${language}"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<style>html{color-scheme:light dark}body{font:1rem system-ui;margin:2rem auto;padding:0 1rem;max-width:50rem}
form{display:flex;flex-wrap:wrap;gap:.5rem}input,button,select{font:inherit;padding:.5rem}input{flex:1;min-width:12rem}
li{margin:1rem 0}p{overflow-wrap:anywhere;white-space:pre-line}button[hidden]{display:none}</style>
<main data-workspace="${escapeHtml(workspaceId)}" data-status="${escapeHtml(JSON.stringify(status))}"><h1>${title}</h1>
<form><input type="search" required maxlength="256" aria-label="${terms}">
<select aria-label="${scope}"><option value="all">${all}</option>
<option value="history">${history}</option>
<option value="attachments">${attachments}</option></select>
<button>${search}</button></form>
<p id="status" role="status"></p><ol id="results" aria-label="${title}"></ol>
<button id="more" type="button" hidden>${more}</button></main>
<script src="/advanced-search.js" defer></script></html>`;
}
