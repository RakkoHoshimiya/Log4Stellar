const copy = JSON.parse(document.body.dataset.copy);
const accountId = document.body.dataset.account;
const byId = id => document.getElementById(id);
const apiBase = '/api/account-security';
let busy = false;

function notify(message, isError = false) {
	const notice = byId('notice');
	notice.textContent = message;
	notice.toggleAttribute('data-error', isError);
}

async function request(path, body) {
	const headers = { 'X-Log4Stellar-Account': accountId };
	if (body) {
		headers['Content-Type'] = 'application/json';
	}
	const response = await fetch(apiBase + path, {
		method: body ? 'POST' : 'GET',
		cache: 'no-store',
		credentials: 'same-origin',
		headers,
		...(body ? { body: JSON.stringify(body) } : {}),
	});
	const result = await response.json().catch(() => ({}));
	if (!response.ok) {
		const messages = {
			AccountChanged: copy.changed,
			InvalidTotpInput: copy.invalidFactor,
			InvalidTotpCode: copy.invalidFactor,
			TotpCodeReplayed: copy.invalidFactor,
			InvalidRecoveryCode: copy.invalidFactor,
			InvalidRecoveryCodeInput: copy.invalidFactor,
			ReauthenticationRequired: copy.invalidPassword,
			InvalidPasswordInput: copy.invalidNewPassword,
			PasswordTooShort: copy.invalidNewPassword,
			PasswordTooLong: copy.invalidNewPassword,
			PasswordMatchesUsername: copy.invalidNewPassword,
		};
		const fallback = response.status === 401 ? copy.expired : copy.failure;
		throw new Error(Object.hasOwn(messages, result.error) ? messages[result.error] : fallback);
	}
	return result;
}

function run(operation) {
	return async event => {
		event?.preventDefault();
		if (busy) {
			return;
		}
		const target = event?.submitter ?? event?.currentTarget;
		busy = true;
		if (target instanceof HTMLButtonElement) {
			target.disabled = true;
		}
		try {
			await operation(event);
		} catch (error) {
			notify(error.message || copy.failure, true);
		} finally {
			if (target instanceof HTMLButtonElement) {
				target.disabled = false;
			}
			busy = false;
		}
	};
}

function bindForm(id, operation) {
	const form = byId(id);
	form.addEventListener('submit', run(async () => {
		await operation(Object.fromEntries(new FormData(form)));
		form.reset();
	}));
}

function setFactorEnabled(enabled) {
	const state = byId('factorState');
	state.dataset.enabled = String(enabled);
	state.textContent = enabled ? copy.enabled : copy.disabled;
	byId('enroll').hidden = enabled;
	byId('manage').hidden = !enabled;
}

function hideCodes() {
	const panel = byId('codes');
	panel.querySelector('ol').replaceChildren();
	panel.hidden = true;
}

function showCodes(codes) {
	const panel = byId('codes');
	const entries = codes.map(code => {
		const item = document.createElement('li');
		item.textContent = code;
		return item;
	});
	panel.querySelector('ol').replaceChildren(...entries);
	panel.hidden = false;
}

function clearPairing() {
	byId('qr').removeAttribute('src');
	byId('key').textContent = '';
	byId('confirm').reset();
	byId('pairing').hidden = true;
}

function button(text, type = 'button') {
	const control = document.createElement('button');
	control.type = type;
	control.textContent = text;
	return control;
}

function deviceItem(device) {
	const item = document.createElement('li');
	const label = document.createElement('strong');
	label.textContent = device.device + (device.current ? ' · ' + copy.thisDevice : '');
	item.append(label);
	if (device.lastActiveMs > 0) {
		const active = document.createElement('time');
		const date = new Date(device.lastActiveMs);
		active.dateTime = date.toISOString();
		active.textContent = ' · ' + new Intl.DateTimeFormat(document.documentElement.lang, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
		item.append(active);
	}
	const edit = document.createElement('form');
	edit.method = 'post';
	const field = document.createElement('input');
	field.type = 'text';
	field.maxLength = 40;
	field.required = true;
	field.value = device.device;
	field.setAttribute('aria-label', copy.deviceLabel);
	edit.append(field, button(copy.rename, 'submit'));
	edit.addEventListener('submit', run(async () => {
		await request('/sessions/' + device.id + '/label', { label: field.value });
		await refreshDevices();
		notify(copy.saved);
	}));
	item.append(edit);
	if (!device.current) {
		const revoke = button(copy.revoke);
		revoke.addEventListener('click', run(async () => {
			await request('/sessions/' + device.id + '/revoke', {});
			await refreshDevices();
			notify(copy.revoked);
		}));
		item.append(revoke);
	}
	return item;
}

async function refreshDevices() {
	const { sessions } = await request('/sessions');
	const list = byId('devices');
	if (sessions.length) {
		list.replaceChildren(...sessions.map(deviceItem));
	} else {
		const item = document.createElement('li');
		item.textContent = copy.noDevices;
		list.replaceChildren(item);
	}
}

bindForm('password', async ({ password, newPassword }) => {
	await request('/password', { currentPassword: password, newPassword });
	await refreshDevices();
	notify(copy.saved);
});
bindForm('enroll', async values => {
	const { totpURI, totpQr, backupCodes } = await request('/two-factor/enroll', values);
	if (!/^data:image\/gif;base64,[a-z\d+/=]+$/i.test(totpQr)) {
		throw new Error(copy.failure);
	}
	byId('qr').src = totpQr;
	byId('key').textContent = new URL(totpURI).searchParams.get('secret');
	byId('pairing').hidden = false;
	byId('enroll').hidden = true;
	showCodes(backupCodes);
	byId('confirm').elements.code.focus();
});
bindForm('confirm', async values => {
	await request('/two-factor/confirm', values);
	clearPairing();
	setFactorEnabled(true);
	notify(copy.saved);
});
bindForm('rotate', async values => {
	const { backupCodes } = await request('/recovery-codes', values);
	showCodes(backupCodes);
	notify(copy.saved);
});
bindForm('disable', async values => {
	await request('/two-factor/disable', values);
	clearPairing();
	hideCodes();
	setFactorEnabled(false);
	await refreshDevices();
	notify(copy.saved);
});
byId('refresh').addEventListener('click', run(refreshDevices));
byId('hideCodes').addEventListener('click', hideCodes);
window.addEventListener('pagehide', () => {
	document.querySelectorAll('form').forEach(form => form.reset());
	clearPairing();
	hideCodes();
	byId('enroll').hidden = byId('factorState').dataset.enabled === 'true';
});
void run(refreshDevices)();
