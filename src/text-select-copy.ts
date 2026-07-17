import { App, Notice, TFile } from "obsidian";
import { getPageInfoForNode } from "./pdf-layer";
import { getTextLayerInfo } from "./selection-geom";

interface ActiveSelection {
	file: TFile;
	pageNumber: number;
	text: string;
	subpath: string;
}

function textDivIndexOf(textDivs: HTMLElement[], node: Node): number {
	const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as HTMLElement);
	if (!el) return -1;
	return textDivs.findIndex((d) => d === el || d.contains(el));
}

/** Reads the current browser text selection, if it's inside a tracked PDF page. */
function readActiveSelection(): ActiveSelection | null {
	const sel = window.getSelection();
	if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
	const text = sel.toString();
	if (!text.trim()) return null;

	const range = sel.getRangeAt(0);
	const info = getPageInfoForNode(range.startContainer);
	if (!info) return null;

	const file = info.view.file;
	if (!(file instanceof TFile) || file.extension !== "pdf") return null;

	const layer = getTextLayerInfo(info.pageView);
	if (!layer) return null;

	const beginIndex = textDivIndexOf(layer.textDivs, range.startContainer);
	const endIndex = textDivIndexOf(layer.textDivs, range.endContainer);
	if (beginIndex < 0 || endIndex < 0) return null;

	const subpath = `#page=${info.pageNumber}&selection=${beginIndex},${range.startOffset},${endIndex},${range.endOffset}`;
	return { file, pageNumber: info.pageNumber, text, subpath };
}

// Wikilink alias / blockquote text can't safely contain these without breaking
// the surrounding markdown syntax.
function sanitizeForInline(text: string): string {
	return text
		.replace(/\s+/g, " ")
		.replace(/[[\]|]/g, "")
		.trim()
		.slice(0, 300);
}

function sanitizeForQuote(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

async function copy(app: App, build: (sel: ActiveSelection) => string): Promise<void> {
	const sel = readActiveSelection();
	if (!sel) {
		new Notice("先在 PDF 上选中一段文字");
		return;
	}
	await navigator.clipboard.writeText(build(sel));
	new Notice("已复制");
}

/** `[[file.pdf#page=N&selection=...|选中的文字]]` — the selected text itself is the alias. */
export function copySelectionAsWikilink(app: App): Promise<void> {
	return copy(app, (sel) => app.fileManager.generateMarkdownLink(sel.file, "", sel.subpath, sanitizeForInline(sel.text)));
}

/** `> 选中的文字\n> [[file.pdf#page=N&selection=...|file, page N]]` */
export function copySelectionAsQuote(app: App): Promise<void> {
	return copy(app, (sel) => {
		const link = app.fileManager.generateMarkdownLink(sel.file, "", sel.subpath);
		return `> ${sanitizeForQuote(sel.text)}\n> ${link}\n`;
	});
}

export function hasActiveTextSelection(): boolean {
	const s = window.getSelection();
	return !!s && !s.isCollapsed && s.toString().trim().length > 0;
}
