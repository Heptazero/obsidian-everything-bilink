import { App, Notice, TFile } from "obsidian";
import { autoRecoverGap, extractFormulas, findCompanionMarkdown, FormulaPickerModal, type FormulaCandidate } from "./formula-md";
import { getPageInfoForNode } from "./pdf-layer";
import { firstTextNode, getTextLayerInfo } from "./selection-geom";
import { applyTemplate, type BilinkSettings } from "./settings";

interface ActiveSelection {
	file: TFile;
	pageNumber: number;
	/** Text built segment-by-segment (see TextSegment), not window.getSelection().toString() —
	 * needed so gap positions are known, not just the flattened, gap-silently-omitted string. */
	segments: TextSegment[];
	subpath: string;
}

interface TextSegment {
	text: string;
	rect: DOMRect;
}

function textDivIndexOf(textDivs: HTMLElement[], node: Node): number {
	const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as HTMLElement);
	if (!el) return -1;
	return textDivs.findIndex((d) => d === el || d.contains(el));
}

/**
 * DOM Range boundaries mean different things depending on the container: a
 * character offset if it's a Text node, but a CHILD-NODE index if it's an
 * Element — and browsers commonly hand back an element container (with offset
 * 0 or 1) when a selection edge lands exactly on a text span's boundary. Using
 * that index as if it were always a character offset produces a small but
 * consistent drift right at span edges — this normalizes either shape down to
 * a real (text node, char offset) pair. pdf.js text-layer spans have a single
 * text-node child, so an element container's offset only ever means "before
 * it" (0) or "after it" (character length).
 */
function resolveBoundary(container: Node, offset: number): { node: Text; offset: number } | null {
	if (container.nodeType === Node.TEXT_NODE) {
		return { node: container as Text, offset };
	}
	const textNode = firstTextNode(container);
	if (!textNode) return null;
	return { node: textNode, offset: offset === 0 ? 0 : textNode.length };
}

/**
 * Splits the selected text into one segment per spanned textDiv (not one flat
 * string) so a gap where a non-selectable formula was skipped can be detected
 * AND located — window.getSelection().toString() silently concatenates across
 * such gaps with nothing marking where they were.
 */
function buildSegments(textDivs: HTMLElement[], beginIndex: number, beginOffset: number, endIndex: number, endOffset: number): TextSegment[] {
	const segments: TextSegment[] = [];
	for (let i = beginIndex; i <= endIndex; i++) {
		const div = textDivs[i];
		if (!div) continue;
		const full = div.textContent ?? "";
		const from = i === beginIndex ? beginOffset : 0;
		const to = i === endIndex ? endOffset : full.length;
		const text = full.slice(from, to);
		if (!text) continue;
		segments.push({ text, rect: div.getBoundingClientRect() });
	}
	return segments;
}

/** Same visual line, but with a horizontal jump much wider than a normal space —
 * the signature of a selection that skipped over non-selectable content (a
 * formula rendered as glyphs/vector paths pdf.js's text layer can't select). */
function hasGapBetween(a: DOMRect, b: DOMRect): boolean {
	const sameLine = Math.abs(a.top - b.top) < Math.min(a.height, b.height) * 0.6;
	if (!sameLine) return false;
	const gap = b.left - a.right;
	return gap > Math.max(a.height, b.height) * 1.5;
}

/** Reads the current browser text selection, if it's inside a tracked PDF page. */
function readActiveSelection(): ActiveSelection | null {
	const sel = window.getSelection();
	if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;

	const range = sel.getRangeAt(0);
	const info = getPageInfoForNode(range.startContainer);
	if (!info) return null;

	const file = info.view.file;
	if (!(file instanceof TFile) || file.extension !== "pdf") return null;

	const layer = getTextLayerInfo(info.pageView);
	if (!layer) return null;

	const start = resolveBoundary(range.startContainer, range.startOffset);
	const end = resolveBoundary(range.endContainer, range.endOffset);
	if (!start || !end) return null;

	const beginIndex = textDivIndexOf(layer.textDivs, start.node);
	const endIndex = textDivIndexOf(layer.textDivs, end.node);
	if (beginIndex < 0 || endIndex < 0) return null;

	const segments = buildSegments(layer.textDivs, beginIndex, start.offset, endIndex, end.offset);
	if (segments.length === 0) return null;

	const subpath = `#page=${info.pageNumber}&selection=${beginIndex},${start.offset},${endIndex},${end.offset}`;
	return { file, pageNumber: info.pageNumber, segments, subpath };
}

function pickFormula(app: App, candidates: FormulaCandidate[]): Promise<FormulaCandidate | null> {
	return new Promise((resolve) => {
		let resolved = false;
		const modal = new FormulaPickerModal(app, candidates, (c) => {
			resolved = true;
			resolve(c);
		});
		const originalOnClose = modal.onClose.bind(modal);
		modal.onClose = () => {
			originalOnClose();
			if (!resolved) resolve(null);
		};
		modal.open();
	});
}

/**
 * Joins segments into one string. Wherever a gap was detected, first tries to
 * auto-recover the real content by anchoring on the surrounding (known-good)
 * text in the companion markdown — no prompt, just a direct substitution. Only
 * falls back to the manual picker if that anchor match fails; a gap is left
 * unfilled only if there's no companion file, or the user cancels the picker.
 */
async function assembleText(app: App, settings: BilinkSettings, sel: ActiveSelection): Promise<string> {
	if (settings.formulaRecovery === "off") return sel.segments.map((s) => s.text).join("");

	const gapsExist = sel.segments.some((s, i) => i > 0 && hasGapBetween(sel.segments[i - 1].rect, s.rect));
	let mdContent: string | null = null;
	let candidates: FormulaCandidate[] | null = null;
	if (gapsExist) {
		const md = findCompanionMarkdown(app, sel.file);
		if (md) mdContent = await app.vault.read(md);
		if (!mdContent) new Notice("检测到公式缺口,但没找到同名的 _md.md 可供回填(留空跳过)");
	}

	let result = sel.segments[0]?.text ?? "";
	let searchCursor = 0; // pins each successive gap's search no earlier than the last match
	for (let i = 1; i < sel.segments.length; i++) {
		if (hasGapBetween(sel.segments[i - 1].rect, sel.segments[i].rect) && mdContent) {
			console.debug("everything-bilink:formula-recover", "gap segments", {
				before: sel.segments[i - 1].text,
				after: sel.segments[i].text,
			});
			let filled: string | null = null;
			const recovery = autoRecoverGap(mdContent, sel.segments[i - 1].text, sel.segments[i].text, searchCursor);
			if (recovery) {
				filled = recovery.text;
				searchCursor = recovery.matchEnd;
			} else if (settings.formulaRecovery === "auto+picker") {
				candidates ??= extractFormulas(mdContent);
				if (candidates.length > 0) {
					const picked = await pickFormula(app, candidates);
					filled = picked?.formula ?? null;
				}
			}
			if (filled) result += ` ${filled} `;
		}
		result += sel.segments[i].text;
	}
	return result;
}

function sanitizeText(text: string): string {
	return text.replace(/\s+/g, " ").trim().slice(0, 500);
}

export type CopyMode = "inline" | "quote" | "link-only";

/**
 * Copies the current PDF text selection using the template configured for `mode`.
 *
 * The selected text is emitted as plain paragraph content and the link carries
 * only a short label, rather than the text living inside a wikilink alias: an
 * alias always renders as literal text in Obsidian, which silently broke any
 * LaTeX in the selection.
 *
 * "link-only" skips text extraction altogether — no formula-gap handling, no
 * companion-file lookup — which is the reliable option when a selection crosses
 * formulas, since the jump link alone is unaffected by what the text layer can
 * or can't reproduce.
 */
export async function copySelection(app: App, settings: BilinkSettings, mode: CopyMode): Promise<void> {
	const sel = readActiveSelection();
	if (!sel) {
		new Notice("先在 PDF 上选中一段文字");
		return;
	}

	let text = "";
	if (mode !== "link-only") {
		text = sanitizeText(await assembleText(app, settings, sel));
		if (!text.trim()) {
			new Notice("选区是空的");
			return;
		}
	}

	const link = app.fileManager.generateMarkdownLink(sel.file, "", sel.subpath, settings.jumpLabel || undefined);
	const template =
		mode === "inline" ? settings.selectionTemplate : mode === "quote" ? settings.quoteTemplate : settings.linkOnlyTemplate;

	await navigator.clipboard.writeText(
		applyTemplate(template, { text, link, file: sel.file.basename, page: String(sel.pageNumber) })
	);
	new Notice("已复制");
}

export function hasActiveTextSelection(): boolean {
	const s = window.getSelection();
	return !!s && !s.isCollapsed && s.toString().trim().length > 0;
}
