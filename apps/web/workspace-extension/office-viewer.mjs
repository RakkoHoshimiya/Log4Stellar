import { getDocument, GlobalWorkerOptions } from './pdf.min.mjs';

GlobalWorkerOptions.workerSrc = new URL('./pdf.worker.min.mjs', import.meta.url).href;

const vscode = acquireVsCodeApi();
const status = document.getElementById('status');
const message = document.getElementById('message');
const progress = document.querySelector('progress');
const pages = document.getElementById('pages');
let started = false;

function showError(text = status.dataset.error) {
	status.hidden = false;
	progress.hidden = true;
	message.textContent = text;
}

async function showDocument(bytes) {
	const pdf = await getDocument({ data: bytes, isEvalSupported: false, useWasm: false }).promise;
	const defaultViewport = (await pdf.getPage(1)).getViewport({ scale: 1 });
	const nearby = new Set();
	const rendered = new Set();
	let rendering = false;
	let firstPageShown = false;

	async function renderNearbyPages() {
		if (rendering) {
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
				await page.render({ canvas, viewport }).promise;
				page.cleanup();
				if (nearby.has(element)) {
					element.replaceChildren(canvas);
					rendered.add(element);
					if (!firstPageShown) {
						firstPageShown = true;
						status.hidden = true;
					}
				}
			}
		} catch {
			showError();
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
	const fragment = document.createDocumentFragment();
	for (let number = 1; number <= pdf.numPages; number++) {
		const element = document.createElement('section');
		element.dataset.number = String(number);
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
		void showDocument(data.bytes).catch(() => showError());
	}
});
vscode.postMessage({ type: 'ready' });
