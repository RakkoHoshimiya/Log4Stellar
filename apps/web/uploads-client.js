const settings = JSON.parse(document.getElementById('uploads').dataset.settings);
const { workspaceId, directory, account, maxBytes, strings } = settings;
const fileInput = document.querySelector('input[type=file]');
const submit = document.querySelector('button[type=submit]');
const pause = document.getElementById('pause');
const cancel = document.getElementById('cancel');
const progress = document.getElementById('progress');
const message = document.getElementById('message');
const base = '/api/v1/uploads/';
const headers = { 'X-Log4Stellar-Workspace': workspaceId, 'X-Log4Stellar-Account': account };
const notices = {
	UploadExpired: 'expired', UploadNotFound: 'expired', UploadMismatch: 'mismatch', FileTooLarge: 'tooLarge',
	NoPermissions: 'denied', SessionExpired: 'signedOut', AccountChanged: 'signedOut', UploadStorageFull: 'storageFull',
	TooManyUploads: 'tooMany', UploadFinalizing: 'uncertain', UploadAlreadyCompleted: 'uncertain', UploadPartCorrupt: 'corrupt',
};
let active;
let cancelling = false;

function show(key, value) {
	message.textContent = value === undefined ? strings[key] : strings[key].replace('{0}', () => value);
}

function progressFor(uploaded, size) {
	progress.value = size ? Math.min(100, (uploaded / size) * 100) : 0;
}

function storageKey(file) {
	return 'l4s-upload:' + JSON.stringify([account, workspaceId, directory, file.name, file.size, file.lastModified]);
}

function tokenFor(file) {
	const key = storageKey(file);
	let id = localStorage.getItem(key);
	if (!id) {
		id = crypto.randomUUID();
		localStorage.setItem(key, id);
	}
	return { id, key };
}

async function request(id, method, { body, suffix = '', signal } = {}) {
	const response = await fetch(base + id + suffix, {
		method, credentials: 'same-origin', cache: 'no-store', redirect: 'error',
		headers: body ? { ...headers, 'Content-Type': 'application/json' } : headers,
		body: body ? JSON.stringify(body) : undefined, signal,
	});
	if (response.status === 204) return;
	const payload = await response.json().catch(() => undefined);
	if (!response.ok) throw new Error(response.status === 401 ? 'SessionExpired' : payload?.error ?? 'UploadFailed');
	return payload;
}

function sendChunk(id, offset, blob, total, signal) {
	return new Promise((resolve, reject) => {
		const xhr = new XMLHttpRequest();
		signal.throwIfAborted();
		xhr.open('PATCH', base + id + '?offset=' + offset);
		for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
		xhr.setRequestHeader('Content-Type', 'application/octet-stream');
		const abort = () => xhr.abort();
		signal.addEventListener('abort', abort, { once: true });
		xhr.addEventListener('loadend', () => signal.removeEventListener('abort', abort));
		xhr.upload.onprogress = event => progressFor(offset + event.loaded, total);
		xhr.onload = () => {
			const data = xhr.response;
			if (xhr.status === 200) resolve(data);
			else reject(new Error(xhr.status === 401 ? 'SessionExpired' : data?.error ?? 'UploadFailed'));
		};
		xhr.onerror = () => reject(new Error('UploadFailed'));
		xhr.onabort = () => reject(new DOMException('Paused', 'AbortError'));
		xhr.responseType = 'json';
		xhr.send(blob);
	});
}

async function verifyPrefix(file, { offset, digests, chunkSize }, signal) {
	for (let index = 0; index < digests.length; index++) {
		signal.throwIfAborted();
		const part = file.slice(index * chunkSize, Math.min((index + 1) * chunkSize, offset));
		const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await part.arrayBuffer()))]
			.map(byte => byte.toString(16).padStart(2, '0')).join('');
		if (digest !== digests[index]) throw new Error('UploadMismatch');
	}
}

function updateActions() {
	submit.disabled = Boolean(active) || cancelling;
	fileInput.disabled = Boolean(active) || cancelling;
	pause.disabled = !active || cancelling;
	const file = fileInput.files[0];
	cancel.disabled = cancelling || !file || !localStorage.getItem(storageKey(file));
}

fileInput.addEventListener('change', () => {
	progress.value = 0;
	show('ready');
	updateActions();
});

document.querySelector('form').addEventListener('submit', async event => {
	event.preventDefault();
	const file = fileInput.files[0];
	if (active || cancelling || !file) return;
	if (file.size > maxBytes) return show('tooLarge');
	const entry = tokenFor(file);
	const controller = new AbortController();
	const { signal } = controller;
	active = controller;
	updateActions();
	try {
		show('uploading');
		const path = directory.replace(/\/$/, '') + '/' + file.name;
		let state = await request(entry.id, 'PUT', { body: { path, size: file.size }, signal });
		await verifyPrefix(file, state, signal);
		progressFor(state.offset, file.size);
		while (!state.result && state.offset < file.size) {
			const data = file.slice(state.offset, state.offset + state.chunkSize);
			state = await sendChunk(entry.id, state.offset, data, file.size, signal);
		}
		show('finalizing');
		state = state.result ? state : await request(entry.id, 'POST', { suffix: '/complete', signal });
		localStorage.removeItem(entry.key);
		progress.value = 100;
		show(state.result.renamed ? 'renamed' : 'uploaded', state.result.path);
	} catch (error) {
		if (signal.aborted) {
			if (!cancelling) show('paused');
		} else {
			if (error.message === 'UploadExpired' || error.message === 'UploadNotFound') localStorage.removeItem(entry.key);
			show(Object.hasOwn(notices, error.message) ? notices[error.message] : 'failed');
		}
	} finally {
		active = undefined;
		updateActions();
	}
});

pause.addEventListener('click', () => active?.abort());
cancel.addEventListener('click', async () => {
	const file = fileInput.files[0];
	if (!file || cancel.disabled) return;
	const key = storageKey(file);
	const id = localStorage.getItem(key);
	if (!id) return updateActions();
	cancelling = true;
	updateActions();
	active?.abort();
	try {
		await request(id, 'DELETE');
		localStorage.removeItem(key);
		progress.value = 0;
		show('canceled');
	} catch (error) {
		if (error.message === 'UploadNotFound' || error.message === 'UploadExpired') {
			localStorage.removeItem(key);
			progress.value = 0;
			show('canceled');
		} else show(Object.hasOwn(notices, error.message) ? notices[error.message] : 'failed');
	}
	cancelling = false;
	updateActions();
});
