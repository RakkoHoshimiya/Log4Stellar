// The first eight entries are the password form; the next five are the second
// factor form (contract §4, §5.3). They are appended rather than merged into one
// array per notice so the password path keeps its existing indices.
const translations = {
	en: ['Sign in', 'Username', 'Password', 'The username or password is incorrect.', 'Too many attempts. Try again in a minute.', 'Your session expired. Sign in again.', 'Switch account', 'This account cannot access this workspace.',
		'Two-step verification', 'Verification code', 'That code is not valid. Try again.', 'Recovery code', 'Enter the 6-digit code from your authenticator app, or one of your recovery codes.'],
	'zh-cn': ['登录', '用户名', '密码', '用户名或密码错误。', '尝试次数过多，请稍后再试。', '会话已过期，请重新登录。', '切换账号', '此账号无权访问工作区。',
		'两步验证', '验证码', '验证码不正确，请重试。', '恢复码', '请输入身份验证器上的 6 位验证码，或使用一个恢复码。'],
	'zh-tw': ['登入', '使用者名稱', '密碼', '使用者名稱或密碼錯誤。', '嘗試次數過多，請稍後再試。', '工作階段已到期，請重新登入。', '切換帳號', '此帳號無權存取工作區。',
		'兩步驗證', '驗證碼', '驗證碼不正確，請重試。', '恢復碼', '請輸入驗證器上的 6 位驗證碼，或使用一個恢復碼。'],
	ja: ['ログイン', 'ユーザー名', 'パスワード', 'ユーザー名またはパスワードが正しくありません。', '試行回数が上限に達しました。しばらくしてからお試しください。', 'セッションの有効期限が切れました。再度ログインしてください。', 'アカウントを切り替え', 'このアカウントはワークスペースにアクセスできません。',
		'2 段階認証', '確認コード', 'コードが正しくありません。もう一度お試しください。', 'リカバリーコード', '認証アプリの 6 桁のコード、またはリカバリーコードを入力してください。'],
};

const authFeedback = {
	en: { unavailable: 'The sign-in service is unavailable. Try again shortly.', reused: 'This code has already been used. Wait for the next code in your authenticator app.' },
	'zh-cn': { unavailable: '登录服务暂时不可用，请稍后再试。', reused: '此验证码已使用，请等待验证器生成下一个验证码。' },
	'zh-tw': { unavailable: '登入服務暫時無法使用，請稍後再試。', reused: '此驗證碼已使用，請等待驗證器產生下一個驗證碼。' },
	ja: { unavailable: 'サインイン サービスを現在利用できません。しばらくしてから再試行してください。', reused: 'このコードは使用済みです。認証アプリの次のコードをお待ちください。' },
};

// The code field accepts both a six digit code and a recovery code, so it is
// sized for the longer one; a typed recovery code may carry separators (§7).
const recoveryCodeInputLimit = 32;

export function webColorScheme(cookie) {
	return cookie === 'light' ? 'light' : 'dark';
}

export function loginPage(locale, notice, scheme, switching) {
	const [title, username, password, invalid, limited, expired, switchAccount, forbidden] = translations[locale] ?? translations.en;
	const { unavailable } = authFeedback[locale] ?? authFeedback.en;
	const message = { invalid, limited, expired, forbidden, unavailable }[notice];
	const heading = switching ? switchAccount : title;
	const invalidFields = notice === 'invalid' ? ' aria-invalid="true" aria-describedby="login-notice"' : '';
	return `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${heading} · Log4Stellar</title>
<style>
:root {
	color-scheme: ${webColorScheme(scheme)};
	font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe WPC", "Segoe UI", system-ui, sans-serif;
	/* Match the workbench's Light 2026 and Dark 2026 theme colors. */
	--editor: light-dark(#fff, #121314);
	--titlebar: light-dark(#fafafd, #191a1b);
	--titlebar-border: light-dark(#f0f1f2, #2a2b2c);
	--titlebar-text: light-dark(#606060, #8c8c8c);
	--widget: light-dark(#fafafd, #202122);
	--widget-border: light-dark(#e4e5e6, #2a2b2c);
	--foreground: light-dark(#202020, #bfbfbf);
	--field: light-dark(#fff, #191a1b);
	--field-border: light-dark(#868686, #707070);
	--focus: light-dark(#0069cc, #3994bc);
	--button: light-dark(#0069cc, #297aa0);
	--button-hover: light-dark(#0063c1, #2b7da3);
	--error-background: light-dark(#fdeded, #3a1d1d);
	--error-border: light-dark(#ad0707, #be1100);
}
:lang(zh-cn) { font-family: "Segoe WPC", "Segoe UI", "Microsoft YaHei", system-ui, sans-serif; }
:lang(zh-tw) { font-family: "Segoe WPC", "Segoe UI", "Microsoft JhengHei", system-ui, sans-serif; }
:lang(ja) { font-family: "Segoe WPC", "Segoe UI", "Yu Gothic UI", "Meiryo UI", system-ui, sans-serif; }
* { box-sizing: border-box; }
body {
	display: grid;
	grid-template-rows: auto 1fr;
	min-height: 100vh;
	min-height: 100svh;
	margin: 0;
	color: var(--foreground);
	background: var(--editor);
}
.workbench-title {
	display: grid;
	place-items: center;
	min-height: 35px;
	padding: 0 16px;
	border-bottom: 1px solid var(--titlebar-border);
	color: var(--titlebar-text);
	background: var(--titlebar);
}
main {
	display: grid;
	place-items: center;
	padding: 24px 16px;
}
.login-panel {
	width: min(100%, 390px);
	border: 1px solid var(--widget-border);
	border-radius: 6px;
	background: var(--widget);
}
h1 {
	margin: 0;
	padding: 16px 24px 14px;
	border-bottom: 1px solid var(--widget-border);
	font-size: 16px;
	font-weight: 600;
	overflow-wrap: anywhere;
}
form {
	display: grid;
	gap: 14px;
	padding: 20px 24px 24px;
}
.field { display: grid; gap: 5px; }
input, button {
	min-height: 34px;
	border: 1px solid transparent;
	border-radius: 4px;
	font: inherit;
}
input {
	width: 100%;
	min-width: 0;
	padding: 6px 9px;
	border-color: var(--field-border);
	color: var(--foreground);
	background: var(--field);
}
input:focus { border-color: var(--focus); }
:where(input, button):focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
input[aria-invalid="true"]:not(:focus) { border-color: var(--error-border); }
button {
	justify-self: end;
	min-width: 96px;
	padding: 5px 16px;
	color: #fff;
	background: var(--button);
	cursor: pointer;
}
button:hover { background: var(--button-hover); }
.notice {
	margin: 0;
	padding: 8px 10px;
	border: 1px solid var(--error-border);
	border-radius: 4px;
	background: var(--error-background);
	overflow-wrap: anywhere;
}
@media (pointer: coarse) {
	input, button { min-height: 44px; }
	input { font-size: 16px; }
}
@media (max-width: 420px) {
	h1 { padding-inline: 18px; }
	form { padding-inline: 18px; }
	button { justify-self: stretch; }
}
@media (forced-colors: active) {
	input, button, .notice { border-color: ButtonText; }
	:where(input, button):focus-visible { outline-color: Highlight; }
}
</style>
</head>
<body>
<header class="workbench-title">Log4Stellar</header>
<main>
<section class="login-panel" aria-labelledby="login-heading">
<h1 id="login-heading">${heading}</h1>
<form method="post" action="/login${switching ? '?switch=1' : ''}">
${message ? `<p class="notice" id="login-notice" role="alert">${message}</p>` : ''}
<div class="field">
<label for="username">${username}</label>
<input id="username" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required maxlength="30"${invalidFields}>
</div>
<div class="field">
<label for="password">${password}</label>
<input id="password" name="password" type="password" autocomplete="current-password" required maxlength="128"${invalidFields}>
</div>
<button type="submit">${title}</button>
</form>
</section>
</main>
</body>
</html>`;
}

/**
 * The second-factor form. It is deliberately a separate document from the
 * password form: the only thing the browser may send from here is a code, and
 * the only cookie it holds is the 600 second challenge (§5.3). Both a TOTP code
 * and a recovery code go through the same field — the server decides which one
 * it was, so the page never tells an attacker that a recovery code was tried.
 */
export function secondFactorPage(locale, notice, scheme) {
	const entries = translations[locale] ?? translations.en;
	const [, , , , , , , , title, codeLabel, codeInvalid, recoveryLabel, instruction] = entries;
	const { unavailable, reused } = authFeedback[locale] ?? authFeedback.en;
	const message = { invalid: codeInvalid, limited: entries[4], unavailable, reused }[notice];
	const resolved = webColorScheme(scheme);
	const panel = `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Log4Stellar</title>
<style>
:root { color-scheme: ${resolved}; font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe WPC", "Segoe UI", system-ui, sans-serif; }
* { box-sizing: border-box; }
body { display: grid; place-items: center; min-height: 100vh; min-height: 100svh; margin: 0; background: light-dark(#fff, #121314); color: light-dark(#202020, #bfbfbf); }
main { width: min(100%, 390px); padding: 24px 16px; }
section { border: 1px solid light-dark(#e4e5e6, #2a2b2c); border-radius: 6px; background: light-dark(#fafafd, #202122); }
h1 { margin: 0; padding: 16px 24px 14px; border-bottom: 1px solid light-dark(#e4e5e6, #2a2b2c); font-size: 16px; font-weight: 600; }
form { display: grid; gap: 14px; padding: 20px 24px 24px; }
p.instruction { margin: 0; }
label { font-weight: 600; }
input, button { min-height: 34px; border-radius: 4px; font: inherit; }
input { width: 100%; padding: 6px 9px; border: 1px solid light-dark(#868686, #707070); background: light-dark(#fff, #191a1b); color: inherit; }
button { justify-self: end; min-width: 96px; padding: 5px 16px; border: 1px solid transparent; color: #fff; background: light-dark(#0069cc, #297aa0); cursor: pointer; }
.notice { margin: 0; padding: 8px 10px; border: 1px solid light-dark(#ad0707, #be1100); border-radius: 4px; background: light-dark(#fdeded, #3a1d1d); overflow-wrap: anywhere; }
@media (pointer: coarse) { input, button { min-height: 44px; } input { font-size: 16px; } }
</style>
</head>
<body>
<main>
<section aria-labelledby="second-factor-heading">
<h1 id="second-factor-heading">${title}</h1>
<form method="post" action="/login">
<p class="instruction">${instruction}</p>
${message ? `<p class="notice" id="login-notice" role="alert">${message}</p>` : ''}
<div class="field">
<label for="code">${codeLabel}</label>
<input id="code" name="code" inputmode="text" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" required maxlength="${recoveryCodeInputLimit}"${message ? ' aria-describedby="login-notice"' : ''}${notice === 'invalid' || notice === 'reused' ? ' aria-invalid="true"' : ''}>
</div>
<p class="instruction">${recoveryLabel}</p>
<button type="submit">${title}</button>
</form>
</section>
</main>
</body>
</html>`;
	return panel;
}
