const sessionScript = new URL(import.meta.url);
const url = path => new URL(path, sessionScript.origin);
const account = document.getElementById('log4stellar-session-client')?.dataset.account;
let refreshInProgress;
let signOutInProgress = false;
let lastActivity = 0;
let activityTimer;
let nextCheck;

// A 403 with `TwoFactorPending` means the password was accepted but the second
// factor was not, so the browser belongs on the challenge form rather than the
// plain login page (?twofactor=1 makes that page render the code field).
function loginTarget(status, error) {
	if (status === 401) {
		return '/login?expired=1';
	}
	return error === 'TwoFactorPending' ? '/login?twofactor=1' : '/login';
}

function handleStatus(status, error) {
	if (!signOutInProgress && (status === 401 || status === 403)) {
		location.replace(url(loginTarget(status, error)));
	}
}

async function statusError(response) {
	if (response.status !== 403) {
		return undefined;
	}
	try {
		return (await response.clone().json())?.error;
	} catch {
		return undefined;
	}
}

async function request(path, options) {
	try {
		const headers = account ? { 'X-Log4Stellar-Account': account } : undefined;
		const response = await fetch(url(path), { cache: 'no-store', headers, signal: AbortSignal.timeout(10_000), ...options });
		if (response.status === 409) {
			location.replace(url('/'));
		}
		handleStatus(response.status, await statusError(response));
		return response;
	} catch {
		// A temporary network failure leaves the editor open for the next attempt.
	}
}

async function checkSession() {
	clearTimeout(nextCheck);
	if (document.hidden || signOutInProgress) {
		return;
	}
	const response = await request('/api/session');
	const session = response?.ok ? await response.json().catch(() => undefined) : undefined;
	const delay = session?.remainingMs;
	const wait = typeof delay === 'number' ? Math.max(200, Math.min(delay + 100, 60_000)) : 60_000;
	nextCheck = setTimeout(checkSession, wait);
}

async function refreshSession() {
	if (refreshInProgress || document.hidden || signOutInProgress) {
		return;
	}
	lastActivity = Date.now();
	refreshInProgress = request('/api/session/activity', { method: 'POST', keepalive: true });
	const response = await refreshInProgress;
	refreshInProgress = undefined;
	if (response?.ok && !signOutInProgress) {
		checkSession();
	}
}

function scheduleActivity() {
	if (document.hidden || signOutInProgress) {
		return;
	}
	clearTimeout(activityTimer);
	activityTimer = setTimeout(refreshSession, Math.max(0, 1500 - (Date.now() - lastActivity)));
}

function recordActivity(event) {
	if (event.isTrusted) {
		scheduleActivity();
	}
}

window.addEventListener('vscode-webview-user-activity', scheduleActivity);
for (const event of ['keydown', 'pointerdown', 'pointerup', 'wheel', 'touchend']) {
	window.addEventListener(event, recordActivity, { capture: true, passive: true });
}
document.addEventListener('visibilitychange', checkSession);


const workspaceDialogLabels = {
  en: { title: 'Switch Workspace', current: ' (current)', cancel: 'Cancel', empty: 'No accessible workspaces.' },
  'zh-cn': { title: '切换工作区', current: '（当前）', cancel: '取消', empty: '没有可访问的工作区。' },
  'zh-tw': { title: '切換工作區', current: '（目前）', cancel: '取消', empty: '沒有可存取的工作區。' },
  ja: { title: 'ワークスペースの切り替え', current: '（現在）', cancel: 'キャンセル', empty: '利用可能なワークスペースがありません。' },
};

function workspaceDialogLanguage() {
  const preference = document.cookie.split('; ').find(part => part.startsWith('vscode.nls.locale='));
  let explicit;
  try {
    if (preference) explicit = decodeURIComponent(preference.slice('vscode.nls.locale='.length));
  } catch {
    // A stale or malformed cookie can fall back to the browser preferences.
  }
  for (const candidate of [explicit, ...(navigator.languages ?? []), navigator.language]) {
    if (!candidate || candidate === 'auto') continue;
    try {
      const locale = new Intl.Locale(candidate);
      if (locale.language === 'zh') {
        return locale.script === 'Hant' || (locale.script !== 'Hans' && ['TW', 'HK', 'MO'].includes(locale.region))
          ? 'zh-tw' : 'zh-cn';
      }
      if (locale.language === 'ja' || locale.language === 'en') return locale.language;
    } catch {
      // Try the next preference.
    }
  }
  return 'en';
}

let workspaceDialogOpen = false;
window.addEventListener('log4stellar-switch-workspace', async event => {
  event.preventDefault();
  if (workspaceDialogOpen || signOutInProgress) return;
  workspaceDialogOpen = true;
  const response = await request('/api/session');
  const state = response?.ok ? await response.json().catch(() => undefined) : undefined;
  if (!Array.isArray(state?.workspaces)) {
    workspaceDialogOpen = false;
    event.detail.onError();
    return;
  }
  const labels = workspaceDialogLabels[workspaceDialogLanguage()];
  const dialog = document.createElement('dialog');
  dialog.setAttribute('aria-labelledby', 'l4s-workspace-title');
  dialog.style.cssText = 'background:var(--vscode-quickInput-background,#252526);color:var(--vscode-quickInput-foreground,#ddd);border:1px solid var(--vscode-focusBorder,#007acc);padding:20px;min-width:300px;font:13px sans-serif';
  const title = document.createElement('h2');
  title.id = 'l4s-workspace-title';
  title.textContent = labels.title;
  dialog.append(title);
  const current = new URL(location.href).searchParams.get('l4sWorkspace') || state.workspaceId;
  const workspaces = state.workspaces.filter(workspace =>
    typeof workspace?.id === 'string' && /^[a-z0-9][a-z0-9-]{0,62}$/.test(workspace.id));
  if (!workspaces.length) {
    const empty = document.createElement('p');
    empty.textContent = labels.empty;
    dialog.append(empty);
  }
  for (const workspace of workspaces) {
    const button = document.createElement('button');
    button.type = 'button';
    button.style.cssText = 'display:block;width:100%;padding:8px;margin:4px 0;text-align:left;color:inherit;background:transparent;border:1px solid transparent;cursor:pointer';
    const name = typeof workspace.name === 'string' && workspace.name.trim() ? workspace.name : workspace.id;
    button.textContent = name + (workspace.id === current ? labels.current : '');
    button.disabled = workspace.id === current;
    button.addEventListener('click', async () => {
      dialog.close();
      if (!await event.detail.onSelect()) return;
      const target = new URL('/', location.origin);
      target.searchParams.set('l4sWorkspace', workspace.id);
      location.assign(target);
    });
    dialog.append(button);
  }
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = labels.cancel;
  cancel.addEventListener('click', () => dialog.close());
  dialog.append(cancel);
  dialog.addEventListener('close', () => { dialog.remove(); workspaceDialogOpen = false; }, { once: true });
  document.body.append(dialog);
  dialog.showModal();
});

window.addEventListener('log4stellar-end-session', async event => {
	event.preventDefault();
	if (signOutInProgress) {
		return;
	}
	signOutInProgress = true;
	clearTimeout(activityTimer);
	clearTimeout(nextCheck);
	// Finish any cookie refresh before clearing the authenticated session.
	await refreshInProgress;
	const response = await request('/api/session/logout', { method: 'POST' });
	if (response?.ok || response?.status === 401) {
		location.replace(url(event.detail.switchAccount ? '/login?switch=1' : '/login'));
		return;
	}
	if (response?.status !== 409) {
		signOutInProgress = false;
		event.detail.onError();
		checkSession();
	}
});
checkSession();

// The workbench owns the selected theme. Remember its scheme for the sign-in page.
function synchronizeLoginTheme() {
	const workbench = document.querySelector('.monaco-workbench');
	if (!workbench) {
		return false;
	}
	let previous;
	const update = () => {
		const classes = workbench.classList;
		const scheme = classes.contains('vs') || classes.contains('hc-light') ? 'light'
			: classes.contains('vs-dark') || classes.contains('hc-black') ? 'dark' : undefined;
		if (scheme && scheme !== previous) {
			document.cookie = `log4stellar.color-scheme=${scheme}; Path=/; Max-Age=31536000; SameSite=Lax; Secure`;
			previous = scheme;
		}
	};
	new MutationObserver(update).observe(workbench, { attributes: true, attributeFilter: ['class'] });
	update();
	return true;
}

if (!synchronizeLoginTheme()) {
	const observer = new MutationObserver(() => {
		if (synchronizeLoginTheme()) {
			observer.disconnect();
		}
	});
	observer.observe(document.body, { childList: true, subtree: true });
}
