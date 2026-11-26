console.log = console.warn = console.error;
const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');

const maxInput = 24 * 1024 ** 2;
const chunks = [];
let size = 0;
for await (const bytes of process.stdin) {
	size += bytes.length;
	if (size > maxInput) throw new Error('PDF input too large');
	chunks.push(bytes);
}
const task = getDocument({
	data: new Uint8Array(Buffer.concat(chunks)), useWasm: false, isEvalSupported: false,
	disableFontFace: true, useSystemFonts: false, verbosity: 0,
});
try {
	const pdf = await task.promise;
	const maxText = 48 * 1024;
	let text = '';
	for (let i = 1; i <= Math.min(pdf.numPages, 80) && text.length < maxText; i++) {
		const page = await pdf.getPage(i);
		const content = await page.getTextContent();
		for (const item of content.items) {
			if (typeof item.str === 'string') text += item.str.slice(0, maxText - text.length) + ' ';
			if (text.length >= maxText) break;
		}
		page.cleanup();
	}
	process.stdout.write(text.slice(0, maxText));
} finally {
	await task.destroy();
}
