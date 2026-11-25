(() => {
	'use strict';

	const { strings, accountId } = JSON.parse(new TextDecoder().decode(
		Uint8Array.from(atob(document.body.dataset.config), character => character.charCodeAt(0))));
	const get = id => document.getElementById(id);
	const select = get('tenant');
	const scope = get('scope');
	const admin = get('admin');
	const notice = get('notice');
	const api = '/api/v1/tenants';
	const date = new Intl.DateTimeFormat(document.documentElement.lang, { dateStyle: 'medium', timeStyle: 'short' });
	const errorLabels = {
		AccountChanged: 'changed', LastAdmin: 'lastAdmin', VersionConflict: 'conflict', InvitationNotPending: 'conflict',
	};
	let blocked = false;

	function element(tag, text) {
		const node = document.createElement(tag);
		node.textContent = text ?? '';
		return node;
	}

	function button(label, run) {
		const node = element('button', label);
		node.type = 'button';
		node.addEventListener('click', run);
		return node;
	}

	function announce(label, error = false) {
		notice.textContent = strings[label] ?? '';
		notice.toggleAttribute('data-error', error);
	}

	async function request(path, method = 'GET', body) {
		const headers = { 'X-Log4Stellar-Account': accountId };
		if (body !== undefined) {
			headers['Content-Type'] = 'application/json';
		}
		const response = await fetch(path, { method, headers, body: JSON.stringify(body), cache: 'no-store', redirect: 'error' });
		const data = await response.json().catch(() => undefined);
		if (!response.ok) {
			throw Object.assign(new Error(data?.error), { status: response.status, code: data?.error });
		}
		return data;
	}

	function clearToken() {
		get('issued-token').value = '';
		get('token-box').hidden = true;
	}

	function setBusy(busy) {
		for (const control of document.querySelectorAll('button, select, input')) {
			control.disabled = blocked || busy;
		}
	}

	async function perform(run, { invitation = false } = {}) {
		setBusy(true);
		announce('loading');
		try {
			announce(await run());
		} catch (error) {
			const label = error.status === 401 ? 'expired'
				: invitation && error.status === 404 ? 'badToken'
					: errorLabels[error.code] ?? 'failed';
			if (label === 'expired' || label === 'changed') {
				blocked = true;
				clearToken();
				get('invite-input').value = '';
				get('email').value = '';
				select.replaceChildren();
				scope.hidden = true;
				for (const id of ['workspaces', 'members', 'invitations', 'audit']) {
					get(id).replaceChildren();
				}
				get('sign-in').hidden = label !== 'expired';
			} else if (error.status === 403 || (!invitation && error.status === 404)) {
				clearToken();
				scope.hidden = true;
			}
			announce(label, true);
		} finally {
			setBusy(false);
		}
	}

	const tenantUrl = () => api + '/' + encodeURIComponent(select.value);
	const roleText = role => strings[{ 1: 'member', 2: 'admin' }[role] ?? role] ?? String(role);

	function formatList(container, rows, render) {
		container.replaceChildren(...rows.map(render));
		if (!rows.length) {
			container.append(element('li', strings.empty));
		}
	}

	async function page(key, url, render, more = null) {
		const container = get(key);
		const query = new URLSearchParams();
		if (more) {
			query.set('cursor', more.cursor);
		}
		const data = await request(url + (more ? '?' + query : ''));
		const rows = data[key === 'audit' ? 'entries' : key];
		if (more) {
			more.node.remove();
			container.append(...rows.map(render));
		} else {
			formatList(container, rows, render);
		}
		if (data.nextCursor !== null) {
			const node = element('li');
			node.append(button(strings.more, () => perform(() => page(key, url, render, { cursor: data.nextCursor, node }))));
			container.append(node);
		}
	}

	function memberRow(base, member) {
		const row = element('li');
		row.className = 'row';
		const name = member.username ?? member.userId;
		const identity = element('span', name);
		identity.className = 'identity';
		const role = element('select');
		role.setAttribute('aria-label', strings.role + ' · ' + name);
		for (const [value, label] of [[1, 'member'], [2, 'admin']]) {
			role.add(new Option(strings[label], String(value)));
		}
		role.value = String(member.role);
		const url = base + '/members/' + encodeURIComponent(member.userId);
		const save = button(strings.save, () => perform(async () => {
			await request(url, 'PATCH', { role: Number(role.value), version: member.version });
			await loadTenants(select.value);
			return 'saved';
		}));
		const remove = button(strings.remove, () => {
			if (window.confirm(strings.confirmRemove)) {
				void perform(async () => {
					await request(url + '?' + new URLSearchParams({ version: member.version }), 'DELETE');
					await loadTenants(select.value);
					return 'saved';
				});
			}
		});
		row.append(identity, role, save, remove);
		return row;
	}

	function invitationRow(base, invitation) {
		const row = element('li');
		row.className = 'row';
		const identity = element('span', [invitation.email, roleText(invitation.role), date.format(invitation.expiresMs)].join(' · '));
		identity.className = 'identity';
		row.append(identity, button(strings.revoke, () => {
			if (window.confirm(strings.confirmRevoke)) {
				void perform(async () => {
					await request(base + '/invitations/' + encodeURIComponent(invitation.invitationId), 'DELETE');
					clearToken();
					await loadScope();
					return 'saved';
				});
			}
		}));
		return row;
	}

	async function loadScope() {
		scope.hidden = true;
		admin.hidden = true;
		const selected = select.selectedOptions[0];
		if (!selected) {
			return 'noTenant';
		}
		const base = tenantUrl();
		const { workspaces } = await request(base + '/workspaces');
		formatList(get('workspaces'), workspaces, workspace => {
			const row = element('li');
			const link = element('a', workspace.id);
			link.href = '/?' + new URLSearchParams({ l4sWorkspace: workspace.id });
			row.append(link, ' · ' + roleText(workspace.role));
			return row;
		});
		if (selected.dataset.role === '2') {
			// Await all responses before making any controls active again, even if one failed.
			const results = await Promise.allSettled([
				page('members', base + '/members', member => memberRow(base, member)),
				page('invitations', base + '/invitations', invitation => invitationRow(base, invitation)),
				page('audit', base + '/audit', entry => element('li',
					[date.format(entry.atMs), strings[entry.action] ?? entry.action, entry.actorId, entry.target].filter(Boolean).join(' · '))),
			]);
			const failed = results.find(result => result.status === 'rejected');
			if (failed) {
				throw failed.reason;
			}
			admin.hidden = false;
		}
		scope.hidden = false;
	}

	async function loadTenants(preferred) {
		clearToken();
		scope.hidden = true;
		const { tenants } = await request(api);
		select.replaceChildren(...tenants.map(tenant => {
			const option = new Option(tenant.name + ' · ' + roleText(tenant.role), tenant.tenantId);
			option.dataset.role = tenant.role;
			return option;
		}));
		if (tenants.some(tenant => tenant.tenantId === preferred)) {
			select.value = preferred;
		}
		return loadScope();
	}

	select.addEventListener('change', () => {
		clearToken();
		get('issue').reset();
		void perform(loadScope);
	});
	get('refresh').addEventListener('click', () => perform(() => loadTenants(select.value)));
	get('dismiss').addEventListener('click', clearToken);
	get('issue').addEventListener('submit', event => {
		event.preventDefault();
		void perform(async () => {
			const base = tenantUrl();
			const result = await request(base + '/invitations', 'POST', { email: get('email').value, role: get('invite-role').value });
			event.target.reset();
			get('issued-token').value = result.token;
			get('token-box').hidden = false;
			await loadScope();
			return 'saved';
		});
	});
	get('accept').addEventListener('submit', event => {
		event.preventDefault();
		void perform(async () => {
			const result = await request('/api/v1/invitations/accept', 'POST', { token: get('invite-input').value.trim() });
			event.target.reset();
			await loadTenants(result.tenantId);
			return 'saved';
		}, { invitation: true });
	});
	window.addEventListener('pagehide', () => {
		clearToken();
		get('accept').reset();
	});
	void perform(loadTenants);
})();
