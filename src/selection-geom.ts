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

export function firstTextNode(node: Node): Text | null {
	const iter = document.createNodeIterator(node, NodeFilter.SHOW_TEXT);
	return iter.nextNode() as Text | null;
}

export interface SelectionLineRect {
	rect: PdfRect;
	/**
	 * Median individual-span height ÷ this merged box's own height — 1 for an
	 * ordinary line, smaller when the box got taller than a normal line because
	 * one of its spans wasn't (a superscript, or a formula character that
	 * happens to sit in the text layer). See mergeIntoLines() for why this
	 * exists: an underline positioned as "X% up from the bottom" reads
	 * differently depending on which of those two heights X% is taken of.
	 */
	heightRatio: number;
}

/**
 * Resolves a `selection=beginIndex,beginOffset,endIndex,endOffset` into on-page
 * rectangles (one per visual line) in PDF-point coordinates, by building a DOM
 * Range across the rendered text-layer spans and reading its client rects. Returns
 * [] if the text layer isn't rendered yet (caller retries on textlayerrendered).
 */
export function computeSelectionRects(pageView: PDFPageView, sel: Selection): SelectionLineRect[] {
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

	const clientRects = Array.from(range.getClientRects()).filter((cr) => cr.width >= 1 && cr.height >= 1);
	const merged = mergeIntoLines(clientRects);

	const rects: SelectionLineRect[] = [];
	for (const line of merged) {
		const [x0, y0] = screenToPdfPoint(pageView, line.left, line.bottom);
		const [x1, y1] = screenToPdfPoint(pageView, line.right, line.top);
		rects.push({ rect: [x0, y0, x1, y1], heightRatio: line.heightRatio });
	}
	return rects;
}

interface LineBox {
	left: number;
	right: number;
	top: number;
	bottom: number;
	heightRatio: number;
}

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = sorted.length >> 1;
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Collapses the per-span client rects of a selection into one box per visual
 * line. Three things this has to get right, all of which showed up as ugly or
 * misplaced marks before:
 *
 * 1. Line grouping used to compare `top` values, which splits a line whenever a
 *    superscript/inline-math span sits higher than its neighbours. Vertical
 *    *overlap* is the robust test instead.
 * 2. Merging only happened when the next rect started at or after the previous
 *    one's right edge; adjacent spans routinely overlap by a fraction of a pixel,
 *    so those fell through and were drawn as a second, overlapping box — which is
 *    what made underlines look doubled and uneven in places.
 * 3. The line's bottom is the MEDIAN of its spans' bottoms, not the maximum. A
 *    single tall span (formula glyph run, descender-heavy word) used to drag the
 *    whole box down, pushing the underline visibly below the text it belongs to.
 *
 * Merging every same-line rect also bridges the blank left by a skipped formula,
 * so the mark reads as one unbroken span. That's cosmetic only — recovering the
 * skipped *text* is formula-md.ts's job.
 *
 * Also tracks each individual span's own height, separately from the merged
 * box's height — see `SelectionLineRect.heightRatio`. A plain line of body text
 * merges spans whose heights all agree, so this ends up ~1. A line where a
 * formula character or a super/subscript sits in the text layer alongside
 * normal text pulls the merged box's `top` up or `bottom` down (span heights
 * disagree) without moving the *median* baseline — so the box grows taller
 * than any single span, and this ratio drops below 1 to record that.
 */
function mergeIntoLines(rects: DOMRect[]): LineBox[] {
	const sorted = [...rects].sort((a, b) => a.top - b.top || a.left - b.left);
	const lines: { left: number; right: number; top: number; maxBottom: number; bottoms: number[]; heights: number[] }[] = [];

	for (const cr of sorted) {
		const prev = lines[lines.length - 1];
		// Rects are sorted by `top`, so a superscript (short, and sitting higher than
		// the body text) can be the one that seeds a line. It overlaps the body text
		// by well under half its own height, so the threshold has to stay low; normal
		// consecutive lines don't overlap vertically at all, so there's plenty of room.
		const overlap = prev ? Math.min(prev.maxBottom, cr.bottom) - Math.max(prev.top, cr.top) : 0;
		const sameLine = prev && overlap > Math.min(prev.maxBottom - prev.top, cr.height) * 0.3;

		if (sameLine) {
			prev.left = Math.min(prev.left, cr.left);
			prev.right = Math.max(prev.right, cr.right);
			prev.top = Math.min(prev.top, cr.top);
			prev.maxBottom = Math.max(prev.maxBottom, cr.bottom);
			prev.bottoms.push(cr.bottom);
			prev.heights.push(cr.height);
		} else {
			lines.push({ left: cr.left, right: cr.right, top: cr.top, maxBottom: cr.bottom, bottoms: [cr.bottom], heights: [cr.height] });
		}
	}

	return lines.map((l) => {
		const bottom = Math.max(median(l.bottoms), l.top + 1);
		const boxHeight = bottom - l.top;
		const refHeight = median(l.heights);
		return { left: l.left, right: l.right, top: l.top, bottom, heightRatio: Math.min(1, refHeight / boxHeight) };
	});
}
