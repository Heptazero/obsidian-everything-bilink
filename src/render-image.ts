import type { App, TFile } from "obsidian";
import type { PdfRect } from "./pdf-layer";

/**
 * Renders a cropped region of a PDF page to an in-memory canvas (no file written
 * to disk, no dependency on any open PDF view/leaf). Loads its own standalone
 * pdf.js document via the same pdf.js instance Obsidian's built-in PDF viewer
 * already loads onto `window.pdfjsLib` — not a bundled copy of our own.
 */
async function renderRectToCanvas(
	app: App,
	file: TFile,
	pageNumber: number,
	rect: PdfRect,
	scale: number
): Promise<HTMLCanvasElement | null> {
	const pdfjsLib = (window as unknown as { pdfjsLib?: any }).pdfjsLib;
	if (!pdfjsLib) {
		console.warn(
			"pdf-bilink: window.pdfjsLib is not loaded yet (Obsidian only loads it once a PDF has been opened this session). Open any PDF once, then retry."
		);
		return null;
	}

	const buffer = await app.vault.readBinary(file);
	const doc = await pdfjsLib.getDocument({ data: buffer }).promise;
	try {
		const page = await doc.getPage(pageNumber);
		const viewport = page.getViewport({ scale });

		const fullCanvas = document.createElement("canvas");
		fullCanvas.width = Math.ceil(viewport.width);
		fullCanvas.height = Math.ceil(viewport.height);
		const fullCtx = fullCanvas.getContext("2d");
		if (!fullCtx) return null;
		await page.render({ canvasContext: fullCtx, viewport }).promise;

		const [vx0, vy0, vx1, vy1] = viewport.convertToViewportRectangle(rect);
		const left = Math.max(0, Math.min(vx0, vx1));
		const top = Math.max(0, Math.min(vy0, vy1));
		const width = Math.min(fullCanvas.width - left, Math.abs(vx1 - vx0));
		const height = Math.min(fullCanvas.height - top, Math.abs(vy1 - vy0));
		if (width < 1 || height < 1) return null;

		const cropCanvas = document.createElement("canvas");
		cropCanvas.width = Math.ceil(width);
		cropCanvas.height = Math.ceil(height);
		const cropCtx = cropCanvas.getContext("2d");
		if (!cropCtx) return null;
		cropCtx.drawImage(fullCanvas, left, top, width, height, 0, 0, width, height);
		return cropCanvas;
	} finally {
		doc.destroy();
	}
}

/** Cropped region as a PNG data URL (for inline <img src>). */
export async function renderRectToDataUrl(
	app: App,
	file: TFile,
	pageNumber: number,
	rect: PdfRect,
	scale = 3
): Promise<string | null> {
	const canvas = await renderRectToCanvas(app, file, pageNumber, rect, scale);
	return canvas ? canvas.toDataURL("image/png") : null;
}

/** Cropped region as a PNG Blob (for clipboard image copy / drag payloads). */
export async function renderRectToBlob(
	app: App,
	file: TFile,
	pageNumber: number,
	rect: PdfRect,
	scale = 3
): Promise<Blob | null> {
	const canvas = await renderRectToCanvas(app, file, pageNumber, rect, scale);
	if (!canvas) return null;
	return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), "image/png"));
}
