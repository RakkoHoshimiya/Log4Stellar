import { getDocument, GlobalWorkerOptions } from './pdf.min.mjs';

const workerModule = new URL('./pdf.worker.min.mjs', import.meta.url);
const firstPageTimeoutMs = 20_000;

const vscode = acquireVsCodeApi();
const status = document.getElementById('status');
const message = document.getElementById('message');
const progress = document.querySelector('progress');
const pages = document.getElementById('pages');
let started = false;

function showError(text = status.dataset.error) {
	status.hidden = false;
	status.setAttribute('role', 'alert');
	progress.hidden = true;
	message.textContent = text;
}

async function loadDocument(bytes, signal) {
	// Fetch via the Window's webview resource bridge. A worker importing the virtual
	// asset itself can stall before the webview service worker can resolve its client.
	const response = await fetch(workerModule, { credentials: 'omit', signal });
	if (!response.ok) {
		throw new Error('Could not load the PDF worker');
	}
	const source = await response.blob();
	signal.throwIfAborted();
	const workerUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
	try {
		GlobalWorkerOptions.workerSrc = workerUrl;
		const task = getDocument({ data: bytes, isEvalSupported: false, useWasm: false });
		signal.addEventListener('abort', () => {
			URL.revokeObjectURL(workerUrl);
			void task.destroy().catch(() => {});
		}, { once: true });
		return await task.promise;
	} finally {
		URL.revokeObjectURL(workerUrl);
	}
}

async function showDocument(bytes, signal, firstPageRendered, onError) {
	const pdf = await loadDocument(bytes, signal);
	if (pdf.numPages === 0) {
		firstPageRendered();
		showError(pages.dataset.empty);
		return;
	}
	const defaultViewport = (await pdf.getPage(1)).getViewport({ scale: 1 });
	signal.throwIfAborted();
	const nearby = new Set();
	const rendered = new Set();
	let rendering = false;
	let firstPageShown = false;

	async function renderNearbyPages() {
		if (rendering || signal.aborted) {
			return;
		}
		rendering = true;
		try {
			for (const element of nearby) {
				if (rendered.has(element)) {
					continue;
				}
				const number = Number(element.dataset.number);
				const page = await pdf.getPage(number);
				const size = page.getViewport({ scale: 1 });
				element.style.aspectRatio = size.width + ' / ' + size.height;
				element.style.maxWidth = Math.ceil(size.width * 1.5) + 'px';
				if (!nearby.has(element)) {
					continue;
				}
				const scale = Math.min(2, Math.max(1, element.clientWidth / size.width * devicePixelRatio));
				const viewport = page.getViewport({ scale });
				const canvas = document.createElement('canvas');
				canvas.width = Math.ceil(viewport.width);
				canvas.height = Math.ceil(viewport.height);
				canvas.dataset.previewPage = String(number);
				canvas.setAttribute('aria-hidden', 'true');
				await page.render({ canvas, viewport }).promise;
				page.cleanup();
				if (!signal.aborted && nearby.has(element)) {
					element.replaceChildren(canvas);
					rendered.add(element);
					if (!firstPageShown) {
						firstPageShown = true;
						firstPageRendered();
						status.hidden = true;
					}
				}
			}
		} catch {
			onError();
		} finally {
			rendering = false;
		}
	}

	const observer = new IntersectionObserver(entries => {
		for (const { target, isIntersecting } of entries) {
			if (isIntersecting) {
				nearby.add(target);
			} else {
				nearby.delete(target);
				rendered.delete(target);
				target.replaceChildren();
			}
		}
		void renderNearbyPages();
	}, { rootMargin: '800px 0px' });
	signal.addEventListener('abort', () => observer.disconnect(), { once: true });
	const fragment = document.createDocumentFragment();
	for (let number = 1; number <= pdf.numPages; number++) {
		const element = document.createElement('section');
		element.dataset.number = String(number);
		element.setAttribute('aria-label', pages.dataset.pageLabel.replace('{0}', String(number)).replace('{1}', String(pdf.numPages)));
		element.style.aspectRatio = defaultViewport.width + ' / ' + defaultViewport.height;
		element.style.maxWidth = Math.ceil(defaultViewport.width * 1.5) + 'px';
		fragment.append(element);
		observer.observe(element);
	}
	pages.append(fragment);
}

addEventListener('message', ({ data }) => {
	if (data?.type === 'error') {
		showError(data.text);
	} else if (data?.type === 'document' && !started) {
		started = true;
		const controller = new AbortController();
		const fail = () => {
			clearTimeout(deadline);
			if (!controller.signal.aborted) {
				controller.abort();
				showError();
			}
		};
		const deadline = setTimeout(fail, firstPageTimeoutMs);
		void showDocument(data.bytes, controller.signal, () => clearTimeout(deadline), fail).catch(fail);
	}
});
vscode.postMessage({ type: 'ready' });
