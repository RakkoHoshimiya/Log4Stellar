(() => {
	'use strict';

	const { strings, accountId, managed } = JSON.parse(new TextDecoder().decode(
		Uint8Array.from(atob(document.body.dataset.config), character => character.charCodeAt(0))));
	const get = id => document.getElementById(id);
	const select = get('tenant');
	const scope = get('scope');
	const admin = get('admin');
	const notice = get('notice');
	const management = '/api/v2/management';
	const api = managed ? management + '/tenants' : '/api/v1/tenants';
	const date = new Intl.DateTimeFormat(document.documentElement.lang, { dateStyle: 'medium', timeStyle: 'short' });
	const errorLabels = {
		TenantSecondFactorRequired: 'securityVerify', NetworkUnavailable: 'network', InvalidEmail: 'invalidEmail',
		InvalidTenantName: 'invalidName', InvalidWorkspaceName: 'invalidName',
		InvalidTenantRole: 'invalidRole', InvalidWorkspaceRole: 'invalidRole',
		LastAdmin: 'lastAdmin', LastWorkspaceOwner: 'lastOwner', VersionConflict: 'conflict', InvitationNotPending: 'conflict',
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
		let response;
		try {
			response = await fetch(path, { method, headers, body: JSON.stringify(body), cache: 'no-store', redirect: 'error' });
		} catch (error) {
			throw Object.assign(new Error('NetworkUnavailable', { cause: error }), { code: 'NetworkUnavailable' });
		}
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

	function feedbackLabel(error, invitation) {
		if (error.code === 'AccountChanged') return 'changed';
		if (error.status === 401) return 'expired';
		if (invitation && (error.status === 404 || error.code === 'InvalidInvitationToken')) return 'badToken';
		if (Object.hasOwn(errorLabels, error.code)) return errorLabels[error.code];
		if (error.status === 403) return 'denied';
		return error.status === 404 ? 'missing' : 'failed';
	}

	async function perform(run, { invitation = false } = {}) {
		setBusy(true);
		announce('loading');
		try {
			announce(await run());
		} catch (error) {
			const label = feedbackLabel(error, invitation);
			if (label === 'expired' || label === 'changed') {
				blocked = true;
				clearToken();
				get('invite-input').value = '';
				get('email').value = '';
				if (managed) {
					get('platform').hidden = true;
						get('tenant-security').hidden = true;
					get('create-tenant').reset();
					get('create-tenant').elements.initialAdminId.replaceChildren();
					get('platform-tenants').replaceChildren();
					get('workspace-picker').replaceChildren();
					get('workspace-grants').replaceChildren();
				}
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
	const roleText = role => strings[{ 1: 'member', 2: 'admin' }[role]] ?? strings.noAccess;
	const workspaceRoleText = role => strings[{ 1: 'viewer', 2: 'editor', 3: 'owner' }[role]] ?? strings.noAccess;

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
		if (data.nextCursor != null) {
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
			await request(url, managed ? 'PUT' : 'PATCH', { role: Number(role.value), version: member.version, expectedVersion: member.version });
			await loadTenants(select.value);
			return 'saved';
		}));
		const remove = button(strings.remove, () => {
			if (window.confirm(strings.confirmRemove)) {
				void perform(async () => {
					if (managed) {
						await request(url, 'PUT', { role: null, expectedVersion: member.version });
					} else {
						await request(url + '?' + new URLSearchParams({ version: member.version }), 'DELETE');
					}
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

	async function loadSecurity(base, role) {
		const policy = await request(base + '/security');
		get('tenant-security').hidden = false;
		get('tenant-security-state').textContent = policy.verifiedSession
			? policy.requireSecondFactor ? strings.securityRequired : ''
			: strings.securityVerify;
		const save = get('tenant-security-save');
		save.hidden = role !== '2' || !policy.verifiedSession;
		save.textContent = policy.requireSecondFactor ? strings.securityOptional : strings.securityRequire;
		save.onclick = () => void perform(async () => {
			await request(base + '/security', 'PUT', {
				requireSecondFactor: !policy.requireSecondFactor, expectedVersion: policy.version,
			});
			await loadScope();
			return 'saved';
		});
		return !policy.requireSecondFactor || policy.verifiedSession;
	}

	async function loadScope() {
		scope.hidden = true;
		admin.hidden = true;
		if (managed) get('tenant-security').hidden = true;
		const selected = select.selectedOptions[0];
		if (!selected) {
			return 'noTenant';
		}
		const base = tenantUrl();
		if (managed && !await loadSecurity(base, selected.dataset.role)) return 'securityVerify';
		const response = await request(managed ? management + '/workspaces' : base + '/workspaces');
		const workspaces = managed ? response.workspaces.filter(item => item.tenantId === select.value) : response.workspaces;
		formatList(get('workspaces'), workspaces, workspace => {
			const row = element('li');
			const link = element('a', workspace.name ?? workspace.id);
			link.href = '/?' + new URLSearchParams({ l4sWorkspace: workspace.id });
			row.append(link, ' · ' + workspaceRoleText(workspace.role));
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
			if (managed) await loadManagedWorkspaces(base);
			admin.hidden = false;
		}
		scope.hidden = false;
	}

	async function loadTenants(preferred) {
		clearToken();
		scope.hidden = true;
		const { tenants, platformAdmin } = await request(api);
		if (managed) {
			get('platform').hidden = !platformAdmin;
			if (platformAdmin) {
				const directory = await request(management + '/platform');
				setAccountOptions(get('create-tenant').elements.initialAdminId, directory.accounts);
				formatList(get('platform-tenants'), directory.tenants, tenant => element('li', tenant.name));
			}
		}
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

	function setAccountOptions(field, accounts) {
		field.replaceChildren(...accounts.map(account => new Option(account.username ?? account.userId, account.userId)));
	}

	async function loadWorkspaceGrants(base) {
		const id = get('workspace-picker').value;
		if (!id) {
			formatList(get('workspace-grants'), [], () => undefined);
			return;
		}
		const url = base + '/workspaces/' + encodeURIComponent(id) + '/members';
		const { members } = await request(url);
		formatList(get('workspace-grants'), members, member => {
			const row = element('li');
			row.className = 'row';
			const name = member.username ?? member.userId;
			const role = element('select');
			role.setAttribute('aria-label', strings.role + ' · ' + name);
			for (const [value, label] of [[0, 'noAccess'], [1, 'viewer'], [2, 'editor'], [3, 'owner']]) {
				role.add(new Option(strings[label], String(value)));
			}
			role.value = String(member.role ?? 0);
			row.append(element('span', name), role, button(strings.save, () => perform(async () => {
				await request(url + '/' + encodeURIComponent(member.userId), 'PUT', {
					role: Number(role.value) || null, expectedVersion: member.version ?? 0,
				});
				await loadScope();
				return 'saved';
			})));
			return row;
		});
	}

	async function loadManagedWorkspaces(base) {
		const field = get('workspace-picker');
		const previous = field.value;
		const [{ workspaces }, { members }] = await Promise.all([
			request(base + '/workspaces'), request(base + '/members'),
		]);
		setAccountOptions(get('create-workspace').elements.initialOwnerId, members);
		field.replaceChildren(...workspaces.map(workspace => new Option(workspace.name, workspace.id)));
		if (workspaces.some(workspace => workspace.id === previous)) field.value = previous;
		await loadWorkspaceGrants(base);
	}

	if (managed) {
		get('workspace-picker').addEventListener('change', () => perform(() => loadWorkspaceGrants(tenantUrl())));
		for (const [formId, url] of [
			['create-tenant', () => management + '/platform/tenants'],
			['create-workspace', () => tenantUrl() + '/workspaces'],
		]) {
			let pending;
			get(formId).addEventListener('submit', event => {
				event.preventDefault();
				const values = Object.fromEntries(new FormData(event.target));
				const fingerprint = JSON.stringify([url(), values]);
				if (pending?.fingerprint !== fingerprint) pending = { fingerprint, requestId: crypto.randomUUID() };
				void perform(async () => {
					await request(url(), 'POST', { ...values, requestId: pending.requestId });
					pending = undefined;
					event.target.reset();
					await loadTenants(select.value);
					return 'saved';
				});
			});
		}
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
			const result = await request(base + '/invitations', 'POST', { email: get('email').value, role: managed ? (get('invite-role').value === 'admin' ? 2 : 1) : get('invite-role').value });
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
			const result = await request((managed ? management + '/invitations/accept' : '/api/v1/invitations/accept'), 'POST', { token: get('invite-input').value.trim() });
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
