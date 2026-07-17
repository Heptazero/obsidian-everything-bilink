import { screenToPdfPoint, type PdfRect } from "./pdf-layer";
import type { PDFPageView, TextLayerInfo } from "./pdfjs-types";

/** Obsidian's native text-selection subpath: 4 integers. */
export type Selection = [number, number, number, number];

export function parseSelection(value: string): Selection | null {
	const m = value.match(/^(\d+),(\d+),(\d+),(\d+)$/);
	if (!m) return null;
	return [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
}

// Obsidian's TextLayerBuilder shape differs by version: v1.8.0+ nests the data
// under `.textLayer`, older versions expose textDivs/textContentItems directly.
export function getTextLayerInfo(pageView: PDFPageView): TextLayerInfo | null {
	const tl = pageView.textLayer as { textLayer?: TextLayerInfo; textDivs?: HTMLElement[] } | undefined;
	if (!tl) return null;
	if (tl.textLayer?.textDivs) return tl.textLayer;
	if (tl.textDivs) return tl as unknown as TextLayerInfo;
	return null;
}

function firstTextNode(node: Node): Text | null {
	const iter = document.createNodeIterator(node, NodeFilter.SHOW_TEXT);
	return iter.nextNode() as Text | null;
}

/**
 * Resolves a `selection=beginIndex,beginOffset,endIndex,endOffset` into on-page
 * rectangles (one per visual line) in PDF-point coordinates, by building a DOM
 * Range across the rendered text-layer spans and reading its client rects. Returns
 * [] if the text layer isn't rendered yet (caller retries on textlayerrendered).
 */
export function computeSelectionRects(pageView: PDFPageView, sel: Selection): PdfRect[] {
	const info = getTextLayerInfo(pageView);
	if (!info) return [];

	const [beginIndex, beginOffset, endIndex, endOffset] = sel;
	const startDiv = info.textDivs[beginIndex];
	const endDiv = info.textDivs[endIndex];
	if (!startDiv || !endDiv) return [];

	const startNode = firstTextNode(startDiv);
	const endNode = firstTextNode(endDiv);
	if (!startNode || !endNode) return [];

	const range = document.createRange();
	try {
		range.setStart(startNode, Math.min(beginOffset, startNode.length));
		range.setEnd(endNode, Math.min(endOffset, endNode.length));
	} catch {
		return [];
	}

	const rects: PdfRect[] = [];
	for (const cr of Array.from(range.getClientRects())) {
		if (cr.width < 1 || cr.height < 1) continue;
		const [x0, y0] = screenToPdfPoint(pageView, cr.left, cr.bottom);
		const [x1, y1] = screenToPdfPoint(pageView, cr.right, cr.top);
		rects.push([x0, y0, x1, y1]);
	}
	return rects;
}
