(() => {
	const main = document.querySelector('main');
	const form = main.querySelector('form');
	const input = form.querySelector('input');
	const scope = form.querySelector('select');
	const list = document.querySelector('#results');
	const status = document.querySelector('#status');
	const more = document.querySelector('#more');
	const submit = form.querySelector('button');
	const [searching, revision, attachment, counts, busy, expired, denied, failed] = JSON.parse(main.dataset.status);
	let query;
	let cursor;
	let scanned = 0;
	let skipped = 0;
	let running = false;

	async function search() {
		if (running || !query) return;
		running = true;
		submit.disabled = more.disabled = true;
		status.textContent = searching;
		try {
			const url = new URL('/search/v1/extended', location.origin);
			url.search = new URLSearchParams(query);
			if (cursor) url.searchParams.set('cursor', cursor);
			const response = await fetch(url, { headers: { 'X-Log4Stellar-Workspace': main.dataset.workspace } });
			if (!response.ok) {
				status.textContent = ({ 401: expired, 403: denied, 429: busy })[response.status] ?? failed;
				return;
			}
			const page = await response.json();
			for (const item of page.results) {
				const entry = document.createElement('li');
				const title = document.createElement('strong');
				const type = item.current ? attachment : revision;
				title.textContent = [item.path, type, new Date(item.createdAt).toLocaleString()].join(' · ');
				const excerpt = document.createElement('p');
				excerpt.textContent = item.excerpt;
				entry.append(title, excerpt);
				list.append(entry);
			}
			cursor = page.nextCursor;
			more.hidden = !cursor;
			scanned += page.scanned;
			skipped += page.skipped;
			const count = list.children.length;
			status.textContent = counts.replace('{scanned}', scanned).replace('{count}', count).replace('{skipped}', skipped);
		} catch {
			status.textContent = failed;
		} finally {
			running = submit.disabled = more.disabled = false;
		}
	}
	form.addEventListener('submit', event => {
		event.preventDefault();
		if (running || !input.value.trim()) return;
		list.replaceChildren();
		more.hidden = true;
		cursor = undefined;
		scanned = skipped = 0;
		query = { q: input.value.trim(), scope: scope.value };
		void search();
	});
	more.addEventListener('click', () => void search());
})();
