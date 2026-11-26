const labels = {
	en: ['Upload attachment', 'Select a file', 'Upload or resume', 'Pause', 'Cancel upload', 'Open workspace', 'Ready to upload.',
		'Uploading…', 'Finalizing…', 'Paused. Choose the same file to resume.', 'Upload canceled.', 'Uploaded {0}.',
		'A file with that name already exists. The upload was saved as {0}.',
		'Upload failed. Check your connection and resume.', 'This upload has expired. Start again.',
		'Select the original file to resume.', 'File exceeds the server limit.', 'You cannot upload to this workspace.',
		'Sign in again to resume this upload.', 'The server is low on space.', 'Finish or cancel another pending upload first.',
		'This upload is being finalized. Resume to check its result.', 'A staged chunk is damaged. Cancel and start the upload again.'],
	'zh-cn': ['上传附件', '选择文件', '上传或续传', '暂停', '取消上传', '打开工作区', '请选择文件。',
		'正在上传…', '正在保存…', '已暂停。选择同一个文件即可续传。', '已取消上传。', '已上传 {0}。',
		'目标已有同名文件，附件已另存为 {0}。',
		'上传失败，请检查网络后续传。', '上传已过期，请重新开始。',
		'请重新选择原文件以续传。', '文件大小超过服务器限制。', '当前工作区没有上传权限。',
		'请重新登录后续传。', '服务器磁盘空间不足。', '请先完成或取消其他未完成的上传。',
		'文件正在保存。请点续传确认最终结果。', '已上传的分块已损坏，请取消后重新上传。'],
	'zh-tw': ['上傳附件', '選擇檔案', '上傳或續傳', '暫停', '取消上傳', '開啟工作區', '請選擇檔案。',
		'正在上傳…', '正在儲存…', '已暫停。選擇同一個檔案即可續傳。', '已取消上傳。', '已上傳 {0}。',
		'目標已有同名檔案，附件已另存為 {0}。',
		'上傳失敗，請檢查網路後續傳。', '上傳已到期，請重新開始。',
		'請重新選擇原檔案以續傳。', '檔案大小超過伺服器限制。', '目前工作區沒有上傳權限。',
		'請重新登入後續傳。', '伺服器磁碟空間不足。', '請先完成或取消其他未完成的上傳。',
		'檔案正在儲存。請選擇續傳確認結果。', '已上傳的區塊已損壞，請取消並重新上傳。'],
	ja: ['添付ファイルのアップロード', 'ファイルを選択', 'アップロードまたは再開', '一時停止', 'アップロードを取り消す', 'ワークスペースを開く', 'ファイルを選択してください。',
		'アップロード中…', '保存中…', '一時停止しました。同じファイルを選択すると再開できます。', '取り消しました。', '{0} をアップロードしました。',
		'同名のファイルがあります。添付ファイルは {0} として保存されました。',
		'アップロードに失敗しました。接続を確認して再開してください。', 'アップロードの有効期限が切れました。やり直してください。',
		'再開するには元のファイルを選択してください。', 'ファイルがサーバーの上限を超えました。', 'このワークスペースにはアップロードできません。',
		'再度サインインして再開してください。', 'サーバーの空き容量が不足しています。', '他の保留中のアップロードを完了するか取り消してください。',
		'ファイルの保存中です。再開して結果を確認してください。', 'アップロード済みの部分が破損しています。取り消してやり直してください。'],
};

const labelKeys = ['title', 'pick', 'upload', 'pause', 'cancel', 'back', 'ready', 'uploading', 'finalizing', 'paused', 'canceled', 'uploaded', 'renamed', 'failed', 'expired', 'mismatch', 'tooLarge', 'denied', 'signedOut', 'storageFull', 'tooMany', 'uncertain', 'corrupt'];

function escape(text) {
	return text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

export function uploadsPage({ locale, theme, account, workspaceId, directory, maxBytes }) {
	const language = Object.hasOwn(labels, locale) ? locale : 'en';
	const strings = Object.fromEntries(labelKeys.map((key, index) => [key, labels[language][index]]));
	const { title, pick, upload, pause, cancel, back, ready } = strings;
	const state = escape(JSON.stringify({ workspaceId, account, directory, maxBytes, strings }));
	const backUrl = '/?' + new URLSearchParams({ l4sWorkspace: workspaceId });
	return `<!doctype html><html lang="${language}"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · Log4Stellar</title>
<style>
:root{color-scheme:${theme};font:14px/1.5 "Segoe UI",system-ui,sans-serif;color:light-dark(#3b3b3b,#ccc);background:light-dark(#fff,#1f1f1f)}
body{margin:0}.bar{border-bottom:1px solid light-dark(#e5e5e5,#333);padding:12px 22px}a{color:light-dark(#005fb8,#75beff)}
main{max-width:42rem;margin:5vh auto;padding:24px}h1{font-size:23px;margin:0 0 8px}code{overflow-wrap:anywhere}
label{display:grid;gap:8px;margin:20px 0}button{border:1px solid transparent;border-radius:3px;padding:7px 12px;font:inherit;color:inherit;background:light-dark(#eee,#383838);cursor:pointer}
button[type=submit]{background:light-dark(#005fb8,#0e639c);color:#fff}button:disabled{opacity:.55;cursor:default}
button:focus-visible,input:focus-visible,a:focus-visible{outline:2px solid #3794ff;outline-offset:2px}
progress{width:100%;height:12px;accent-color:#007acc;margin-top:20px}
</style><nav class="bar"><a href="${escape(backUrl)}">${back}</a></nav>
<main id="uploads" data-settings="${state}"><h1>${title}</h1><code>${escape(directory)}</code>
<form><label>${pick}<input type="file" required></label>
<button type="submit">${upload}</button> <button type="button" id="pause" disabled>${pause}</button> <button type="button" id="cancel" disabled>${cancel}</button>
</form><progress id="progress" aria-label="${title}" max="100" value="0"></progress>
<p id="message" role="status">${ready}</p></main><script src="/uploads.js" type="module"></script></html>`;
}
