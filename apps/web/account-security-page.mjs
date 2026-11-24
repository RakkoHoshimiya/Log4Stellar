import { webColorScheme } from './login-page.mjs';

const copy = {
	en: {
		title: 'Account Security', back: 'Return to workspace', password: 'Password', currentPassword: 'Current password',
		newPassword: 'New password', changePassword: 'Change password', devices: 'Signed-in devices', refresh: 'Refresh devices',
		thisDevice: 'This device', revoke: 'Revoke', rename: 'Save label', deviceLabel: 'Device label', noDevices: 'No active devices.',
		twoFactor: 'Two-factor authentication', enabled: 'Enabled', disabled: 'Disabled', enroll: 'Set up authenticator',
		scan: 'Scan with your authenticator app, then enter its six-digit code.', showKey: 'Manual setup key',
		confirm: 'Confirm authenticator', code: 'Authenticator code or recovery code', totpCode: 'Six-digit authenticator code',
		disable: 'Disable two-factor authentication', rotate: 'Generate new recovery codes',
		confirmDisable: 'I understand disabling two-factor authentication reduces account protection.',
		recovery: 'Recovery codes', saveCodes: 'Save these one-time codes somewhere safe. They are shown only once.',
		hide: 'Hide recovery codes', saved: 'Changes saved.', revoked: 'Device signed out.', expired: 'Your session expired. Reopen this page after signing in.',
		changed: 'The active account changed. Reopen this page from the account menu.', failure: 'The request failed. Check your input and try again.',
		invalidFactor: 'The code is invalid or already used. Try another code.', invalidPassword: 'The current password or an additional factor is required.',
		invalidNewPassword: 'Choose a password of 8 to 128 characters that differs from your username.',
	},
	'zh-cn': {
		title: '账户安全', back: '返回工作区', password: '密码', currentPassword: '当前密码',
		newPassword: '新密码', changePassword: '修改密码', devices: '已登录设备', refresh: '刷新设备',
		thisDevice: '当前设备', revoke: '撤销会话', rename: '保存名称', deviceLabel: '设备名称', noDevices: '没有有效会话。',
		twoFactor: '双因素验证', enabled: '已启用', disabled: '未启用', enroll: '绑定验证器',
		scan: '用验证器 App 扫描，再输入它生成的六位验证码。', showKey: '手动设置密钥',
		confirm: '确认绑定', code: '验证器验证码或恢复码', totpCode: '六位验证器验证码',
		disable: '关闭双因素验证', rotate: '生成新的恢复码',
		confirmDisable: '我了解关闭双因素验证会降低账户保护。',
		recovery: '恢复码', saveCodes: '请妥善保存。恢复码均为一次性使用，只在此处显示一次。',
		hide: '隐藏恢复码', saved: '已保存。', revoked: '设备已退出。', expired: '会话已过期。请重新登录后打开此页。',
		changed: '当前账户已切换。请从账户菜单重新打开此页。', failure: '请求失败，请检查输入后重试。',
		invalidFactor: '验证码无效或已使用，请换一个验证码。', invalidPassword: '需要正确的当前密码或额外验证。',
		invalidNewPassword: '请输入 8 至 128 个字符的新密码，且不能与用户名相同。',
	},
	'zh-tw': {
		title: '帳戶安全', back: '返回工作區', password: '密碼', currentPassword: '目前密碼',
		newPassword: '新密碼', changePassword: '變更密碼', devices: '已登入裝置', refresh: '重新整理裝置',
		thisDevice: '目前裝置', revoke: '撤銷工作階段', rename: '儲存名稱', deviceLabel: '裝置名稱', noDevices: '沒有有效工作階段。',
		twoFactor: '雙因素驗證', enabled: '已啟用', disabled: '未啟用', enroll: '綁定驗證器',
		scan: '用驗證器 App 掃描，再輸入其產生的六位驗證碼。', showKey: '手動設定金鑰',
		confirm: '確認綁定', code: '驗證器驗證碼或復原碼', totpCode: '六位驗證器驗證碼',
		disable: '關閉雙因素驗證', rotate: '產生新的復原碼',
		confirmDisable: '我了解關閉雙因素驗證會降低帳戶保護。',
		recovery: '復原碼', saveCodes: '請妥善儲存。復原碼只能使用一次，且只會在此顯示一次。',
		hide: '隱藏復原碼', saved: '已儲存。', revoked: '裝置已登出。', expired: '工作階段已過期。請重新登入並開啟此頁。',
		changed: '目前帳戶已變更。請從帳戶選單重新開啟此頁。', failure: '要求失敗，請檢查輸入後再試。',
		invalidFactor: '驗證碼無效或已使用，請更換驗證碼。', invalidPassword: '需要正確的目前密碼或額外驗證。',
		invalidNewPassword: '請輸入 8 至 128 個字元的新密碼，且不可與使用者名稱相同。',
	},
	ja: {
		title: 'アカウントのセキュリティ', back: 'ワークスペースに戻る', password: 'パスワード', currentPassword: '現在のパスワード',
		newPassword: '新しいパスワード', changePassword: 'パスワードを変更', devices: 'ログイン中のデバイス', refresh: 'デバイスを更新',
		thisDevice: 'このデバイス', revoke: 'セッションを取り消す', rename: '名前を保存', deviceLabel: 'デバイス名', noDevices: '有効なセッションはありません。',
		twoFactor: '二要素認証', enabled: '有効', disabled: '無効', enroll: '認証アプリを設定',
		scan: '認証アプリで読み取り、表示された6桁のコードを入力してください。', showKey: '手動設定キー',
		confirm: '認証アプリを確認', code: '認証コードまたはリカバリーコード', totpCode: '6桁の認証コード',
		disable: '二要素認証を無効にする', rotate: '新しいリカバリーコードを生成',
		confirmDisable: '二要素認証を無効にすると保護が弱くなることを理解しています。',
		recovery: 'リカバリーコード', saveCodes: '安全な場所に保管してください。各コードは1回だけ使用でき、表示も一度だけです。',
		hide: 'コードを隠す', saved: '保存しました。', revoked: 'デバイスをログアウトしました。', expired: 'セッションの有効期限が切れました。ログインしてから開き直してください。',
		changed: 'アカウントが切り替わりました。アカウントメニューから開き直してください。', failure: '処理に失敗しました。入力を確認して再試行してください。',
		invalidFactor: 'コードが無効か使用済みです。別のコードをお試しください。', invalidPassword: '現在の正しいパスワードか追加の認証が必要です。',
		invalidNewPassword: 'ユーザー名とは異なる8～128文字のパスワードを入力してください。',
	},
};

function escapeAttribute(value) {
	return String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
}

function field(label, name, autocomplete, attributes = '') {
	return '<label>' + label + '<input name="' + name + '" required autocomplete="' + autocomplete + '" ' + attributes + '></label>';
}

function button(label) {
	return '<button type="submit">' + label + '</button>';
}

export function accountSecurityPage({ locale, scheme, accountId, twoFactorEnabled }) {
	const language = Object.hasOwn(copy, locale) ? locale : 'en';
	const strings = copy[language];
	const password = field(strings.currentPassword, 'password', 'current-password', 'type="password" maxlength="128"');
	const newPassword = field(strings.newPassword, 'newPassword', 'new-password', 'type="password" minlength="8" maxlength="128"');
	const factor = field(strings.code, 'code', 'one-time-code', 'maxlength="32" autocapitalize="characters" spellcheck="false"');
	const totp = field(strings.totpCode, 'code', 'one-time-code', 'inputmode="numeric" pattern="[0-9]{6}" maxlength="6"');
	const title = strings.title;
	const data = ' data-copy="' + escapeAttribute(JSON.stringify(strings)) + '" data-account="' + escapeAttribute(accountId) + '"';
	return [
		'<!doctype html><html lang="' + language + '"><head><meta charset="utf-8">',
		'<meta name="viewport" content="width=device-width, initial-scale=1"><title>' + title + ' · Log4Stellar</title>',
		'<style>:root{color-scheme:' + webColorScheme(scheme) + ';font:15px/1.55 system-ui,sans-serif}',
		'body{margin:0;background:light-dark(#fff,#171819);color:light-dark(#202020,#d7d7d7)}',
		'main{max-width:44rem;margin:2rem auto;padding:0 1rem 2rem}header{display:flex;align-items:center;justify-content:space-between;gap:1rem;flex-wrap:wrap}',
		'h1,h2,h3{line-height:1.2}a{color:light-dark(#005ab2,#8fc6ff)}section{border:1px solid light-dark(#ddd,#3a3a3a);border-radius:.4rem;padding:1rem;margin-top:1rem}',
		'form,label{display:grid;gap:.5rem}form{gap:.8rem;margin-block:.75rem}input,button{font:inherit;min-height:2.25rem;padding:.2rem .6rem;border-radius:.25rem;border:1px solid light-dark(#999,#777);color:inherit;background:light-dark(#fff,#242526)}',
		'input[type=checkbox]{display:inline;min-height:0;margin-right:.5rem}button{justify-self:start;cursor:pointer}button:disabled{cursor:wait;opacity:.6}',
		'button[type=submit]{background:light-dark(#0066b8,#155783);color:white;border-color:transparent}#notice{min-height:1.55em;margin:0}#notice[data-error]{color:light-dark(#9e1414,#ffa6a6)}',
		'#qr{display:block;background:white;max-width:100%;height:auto}#key{overflow-wrap:anywhere}#codes ol{columns:2;max-width:23rem;padding-inline-start:1.5rem}',
		'#devices li{margin-block:1rem}#devices form{max-width:24rem}#disable label:last-of-type{display:block}[hidden]{display:none!important}</style></head>',
		'<body' + data + '><main><header><h1>' + title + '</h1><a href="/">' + strings.back + '</a></header>',
		'<p id="notice" role="status" aria-live="polite"></p><section><h2>' + strings.password + '</h2>',
		'<form method="post" id="password">' + password + newPassword + button(strings.changePassword) + '</form></section>',
		'<section><h2>' + strings.twoFactor + '</h2><p id="factorState" data-enabled="' + Boolean(twoFactorEnabled) + '">' + (twoFactorEnabled ? strings.enabled : strings.disabled) + '</p>',
		'<form method="post" id="enroll"' + (twoFactorEnabled ? ' hidden' : '') + '>' + password + button(strings.enroll) + '</form>',
		'<div id="pairing" hidden><p>' + strings.scan + '</p><img id="qr" alt="' + strings.enroll + '">',
		'<details><summary>' + strings.showKey + '</summary><code id="key"></code></details>',
		'<form method="post" id="confirm">' + totp + button(strings.confirm) + '</form></div>',
		'<div id="manage"' + (twoFactorEnabled ? '' : ' hidden') + '>',
		'<form method="post" id="rotate">' + password + factor + button(strings.rotate) + '</form>',
		'<form method="post" id="disable">' + password + factor + '<label><input type="checkbox" required>' + strings.confirmDisable + '</label>' + button(strings.disable) + '</form></div>',
		'<div id="codes" hidden><h3>' + strings.recovery + '</h3><p>' + strings.saveCodes + '</p><ol></ol>',
		'<button type="button" id="hideCodes">' + strings.hide + '</button></div></section>',
		'<section><h2>' + strings.devices + '</h2><button type="button" id="refresh">' + strings.refresh + '</button><ul id="devices"></ul></section>',
		'</main><script type="module" src="/account/security.js"></script></body></html>',
	].join('\n');
}
