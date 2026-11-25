import { webColorScheme } from './login-page.mjs';

const copy = {
	// Each row follows the locale order below.
	title: ['Tenant management', '租户管理', '租戶管理', 'テナント管理'],
	back: ['Back to workspace', '返回工作区', '返回工作區', 'ワークスペースへ戻る'],
	tenant: ['Tenant', '租户', '租戶', 'テナント'],
	refresh: ['Refresh', '刷新', '重新整理', '更新'],
	workspaces: ['Available workspaces', '可访问的工作区', '可存取的工作區', '利用可能なワークスペース'],
	members: ['Members', '成员', '成員', 'メンバー'],
	invitations: ['Pending invitations', '待接受的邀请', '待接受的邀請', '保留中の招待'],
	audit: ['Audit log', '审计日志', '稽核記錄', '監査ログ'],
	invite: ['Create invitation', '创建邀请', '建立邀請', '招待を作成'],
	accept: ['Accept invitation', '接受邀请', '接受邀請', '招待を承諾'],
	email: ['Recipient email for the record', '登记受邀人邮箱', '登記受邀者電子郵件', '記録用の招待先メールアドレス'],
	role: ['Role', '角色', '角色', 'ロール'],
	member: ['Member', '普通成员', '一般成員', 'メンバー'],
	admin: ['Administrator', '管理员', '管理員', '管理者'],
	editor: ['Editor', '编辑者', '編輯者', '編集者'],
	viewer: ['Viewer', '查看者', '檢視者', '閲覧者'],
	owner: ['Owner', '所有者', '擁有者', '所有者'],
	noAccess: ['No access', '无访问权限', '沒有存取權限', 'アクセス権なし'],
	token: ['Invitation token', '邀请码', '邀請碼', '招待トークン'],
	tokenHelp: ['Copy this one-time token and share it with the recipient. It grants tenant membership. Workspace access is assigned separately.', '请复制这枚一次性邀请码并交给受邀人。工作区访问权限需另行分配。', '請複製此一次性邀請碼並交給受邀者。工作區存取權限須另行分配。', 'この使い捨てトークンをコピーして招待先に共有してください。ワークスペースの権限は別途付与します。'],
	dismiss: ['Hide token', '隐藏邀请码', '隱藏邀請碼', 'トークンを隠す'],
	save: ['Save role', '保存角色', '儲存角色', 'ロールを保存'],
	remove: ['Remove member', '移除成员', '移除成員', 'メンバーを削除'],
	revoke: ['Cancel invitation', '撤销邀请', '撤銷邀請', '招待を取り消す'],
	confirmRemove: ['Remove this member from the tenant?', '确定将此成员移出租户？', '確定將此成員移出租戶？', 'このメンバーをテナントから削除しますか？'],
	confirmRevoke: ['Cancel this invitation?', '确定撤销此邀请？', '確定撤銷此邀請？', 'この招待を取り消しますか？'],
	more: ['Load more', '加载更多', '載入更多', 'さらに読み込む'],
	empty: ['No records.', '暂无记录。', '暫無記錄。', '記録はありません。'],
	noTenant: ['No tenants are available. Accept an invitation to join one.', '暂无可用租户。你可以通过邀请码加入。', '暫無可用租戶。你可以透過邀請碼加入。', '利用できるテナントがありません。招待で参加できます。'],
	loading: ['Loading…', '正在加载…', '正在載入…', '読み込み中…'],
	saved: ['Changes saved.', '已保存。', '已儲存。', '変更を保存しました。'],
	failed: ['The request failed. Try refreshing.', '操作失败，请刷新后重试。', '操作失敗，請重新整理後再試。', '操作に失敗しました。更新して再試行してください。'],
	expired: ['Your session expired. Sign in again.', '会话已过期，请重新登录。', '工作階段已過期，請重新登入。', 'セッションが期限切れです。再度サインインしてください。'],
	changed: ['The active account changed. Reload this page.', '当前账号已切换，请重新载入此页。', '目前帳號已切換，請重新載入此頁。', 'アカウントが変更されました。このページを再読み込みしてください。'],
	network: ["The server could not be reached. Check your connection and try again.", "无法连接服务器，请检查网络后重试。", "無法連線至伺服器，請檢查網路後再試。", "サーバーに接続できません。接続を確認して再試行してください。"],
	denied: ["You do not have permission for this management action.", "你没有执行此管理操作的权限。", "你沒有執行此管理操作的權限。", "この管理操作を行う権限がありません。"],
	invalidEmail: ["Enter a valid email address.", "请输入有效的电子邮箱地址。", "請輸入有效的電子郵件地址。", "有効なメールアドレスを入力してください。"],
	invalidRole: ["Select an available role and try again.", "请选择一个可用角色后重试。", "請選擇可用的角色後再試。", "利用可能なロールを選択して再試行してください。"],
	missing: ["This account, tenant, or workspace is no longer available. Refresh the page.", "此账号、租户或工作区当前不可用，请刷新页面。", "此帳號、租戶或工作區目前無法使用，請重新整理頁面。", "このアカウント、テナント、またはワークスペースは利用できません。ページを更新してください。"],
	conflict: ['This record changed. Refresh and try again.', '记录有变更，请刷新后重试。', '記錄已變更，請重新整理後再試。', '記録が変更されました。更新して再試行してください。'],
	lastAdmin: ['Keep at least one tenant administrator.', '租户至少要保留一位管理员。', '租戶至少須保留一位管理員。', 'テナントには少なくとも 1 人の管理者が必要です。'],
	badToken: ['The invitation is invalid, expired, or already used.', '邀请无效、已过期或已被使用。', '邀請無效、已過期或已被使用。', '招待は無効、有効期限切れ、または使用済みです。'],
	signIn: ['Sign in', '登录', '登入', 'サインイン'],
	'tenant.create': ['Tenant created', '创建租户', '建立租戶', 'テナント作成'],
	'tenant.seed': ['Tenant initialized', '初始化租户', '初始化租戶', 'テナント初期化'],
	'invitation.issue': ['Invitation created', '创建邀请', '建立邀請', '招待作成'],
	'invitation.accept': ['Invitation accepted', '接受邀请', '接受邀請', '招待承諾'],
	'invitation.revoke': ['Invitation cancelled', '撤销邀请', '撤銷邀請', '招待取り消し'],
	'member.role': ['Member role changed', '修改成员角色', '變更成員角色', 'メンバーのロール変更'],
	'member.revoke': ['Member removed', '移除成员', '移除成員', 'メンバー削除'],
};
const locales = ['en', 'zh-cn', 'zh-tw', 'ja'];

export function tenantManagementPage({ locale, scheme, accountId }) {
	const language = locales.includes(locale) ? locale : 'en';
	const strings = Object.fromEntries(Object.entries(copy).map(([key, labels]) => [key, labels[locales.indexOf(language)]]));
	const config = Buffer.from(JSON.stringify({ strings, accountId })).toString('base64');
	const { title, back, refresh, accept, token, tenant, workspaces, members, invitations, invite, email, role, member, admin, tokenHelp, dismiss, audit, signIn } = strings;
	return `<!doctype html><html lang="${language}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Log4Stellar</title><style>
:root{color-scheme:${webColorScheme(scheme)};font:14px/1.55 system-ui,sans-serif;background:light-dark(#f6f6f8,#1e1e1e);color:light-dark(#202124,#ddd)}
main{max-width:58rem;margin:2rem auto;padding:0 1rem 2rem}header,.row{display:flex;align-items:center;gap:.75rem;flex-wrap:wrap}header{justify-content:space-between}
h1,h2,h3{line-height:1.25;margin-block:0 .6rem}section{border:1px solid light-dark(#d2d2d6,#444);margin-block:1rem;padding:1rem;border-radius:6px;background:light-dark(#fff,#252526)}
form{margin-block:.6rem}label{display:grid;gap:.15rem}input,select,button{font:inherit;min-height:2.2rem;border:1px solid light-dark(#999,#777);border-radius:4px;padding:.2rem .6rem;background:light-dark(#fff,#333);color:inherit}
input{box-sizing:border-box;width:100%}form button{align-self:end}button{cursor:pointer}button:disabled{opacity:.55;cursor:default}a{color:light-dark(#005ab2,#91c9fa)}
button[type=submit]{background:light-dark(#0066b8,#145a86);color:white;border-color:transparent}
ul{padding-inline-start:1.4rem}li{margin-block:.35rem;overflow-wrap:anywhere}.identity{flex:1;min-width:12rem}
#notice{min-height:1.4em;margin:.25rem 0}#notice[data-error]{color:light-dark(#9c2222,#ffaaaa)}
#token-box{margin-block:.75rem;padding:.75rem;border:1px solid light-dark(#aaa,#777)}[hidden]{display:none!important}
</style><script defer src="/account/tenants.js"></script></head>
<body data-config="${config}"><main><header><h1>${title}</h1><a href="/">${back}</a></header>
<div class="row"><label for="tenant">${tenant}<select id="tenant"></select></label><button id="refresh" type="button">${refresh}</button></div>
<p id="notice" role="status" aria-live="polite">${strings.loading}</p><a id="sign-in" href="/login" hidden>${signIn}</a>
<section><h2>${accept}</h2><form id="accept" class="row"><label for="invite-input">${token}<input id="invite-input" required maxlength="512" autocomplete="off" spellcheck="false"></label><button type="submit">${accept}</button></form></section>
<div id="scope" hidden>
<section><h2>${workspaces}</h2><ul id="workspaces"></ul></section>
<div id="admin" hidden>
<section><h2>${members}</h2><ul id="members"></ul></section>
<section><h2>${invitations}</h2><form id="issue" class="row">
<label for="email">${email}<input id="email" type="email" required maxlength="254"></label>
<label for="invite-role">${role}<select id="invite-role"><option value="member">${member}</option><option value="admin">${admin}</option></select></label>
<button type="submit">${invite}</button></form>
<div id="token-box" hidden><p>${tokenHelp}</p><label for="issued-token">${token}<input id="issued-token" readonly autocomplete="off" spellcheck="false"></label><button id="dismiss" type="button">${dismiss}</button></div>
<ul id="invitations"></ul></section>
<section><h2>${audit}</h2><ol id="audit"></ol></section>
</div></div></main></body></html>`;
}
