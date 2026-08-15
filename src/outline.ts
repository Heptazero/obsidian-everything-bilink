import { App, Notice, TFile } from "obsidian";
import { getActivePDFView, getPdfDocument } from "./pdf-layer";
import type { PDFDocumentProxy, PDFOutlineItem } from "./pdfjs-types";
import { applyTemplate, type BilinkSettings } from "./settings";

interface FlatEntry {
	title: string;
	depth: number;
	/** 1-based; null when the bookmark points somewhere unresolvable (or is an external URL). */
	page: number | null;
	url?: string | null;
}

/** Wikilink aliases can't contain these without breaking the link syntax. */
function sanitizeAlias(title: string): string {
	return title.replace(/[[\]|#^]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Resolves a bookmark destination to a 1-based page number.
 *
 * A destination is either a named one (a string to be looked up in the document's
 * name tree) or an explicit array whose first element identifies the page — as a
 * page *reference* object in the normal case, but as a plain page index in
 * documents that use the numeric form. Both shapes appear in the wild.
 */
async function destToPage(doc: PDFDocumentProxy, dest: string | unknown[] | null): Promise<number | null> {
	try {
		const explicit = typeof dest === "string" ? await doc.getDestination(dest) : dest;
		if (!Array.isArray(explicit) || explicit.length === 0) return null;
		const ref = explicit[0];
		if (typeof ref === "number") return ref + 1;
		return (await doc.getPageIndex(ref)) + 1;
	} catch {
		return null; // a broken bookmark shouldn't sink the whole outline
	}
}

async function flatten(doc: PDFDocumentProxy, items: PDFOutlineItem[], depth: number, out: FlatEntry[]): Promise<void> {
	for (const item of items) {
		const title = sanitizeAlias(item.title ?? "");
		if (title) {
			out.push({ title, depth, page: item.url ? null : await destToPage(doc, item.dest), url: item.url });
		}
		if (item.items?.length) await flatten(doc, item.items, depth + 1, out);
	}
}

/**
 * Builds a Markdown outline of the active PDF's bookmarks, each line linking to
 * the page it jumps to, and puts it on the clipboard. Read-only with respect to
 * both the PDF and the vault — nothing is written until the user pastes.
 */
export async function copyPdfOutline(app: App, settings: BilinkSettings): Promise<void> {
	const view = getActivePDFView(app);
	const file = view?.file;
	if (!view || !(file instanceof TFile)) {
		new Notice("先打开一个 PDF");
		return;
	}

	const doc = getPdfDocument(view);
	if (!doc) {
		new Notice("PDF 还在加载,稍后再试");
		return;
	}

	const outline = await doc.getOutline();
	if (!outline || outline.length === 0) {
		new Notice("这个 PDF 没有内置大纲(书签)");
		return;
	}

	const entries: FlatEntry[] = [];
	await flatten(doc, outline, 0, entries);
	if (entries.length === 0) {
		new Notice("大纲是空的");
		return;
	}

	const lines = entries.map((e) => {
		const link = e.url
			? `[${e.title}](${e.url})`
			: e.page !== null
				? app.fileManager.generateMarkdownLink(file, "", `#page=${e.page}`, e.title)
				: e.title; // unresolvable destination: keep the heading, drop the link
		return applyTemplate(settings.outlineTemplate, {
			indent: "\t".repeat(e.depth),
			link,
			title: e.title,
			page: e.page !== null ? String(e.page) : "",
			file: file.basename,
			text: e.title,
		});
	});

	await navigator.clipboard.writeText(lines.join("\n") + "\n");
	new Notice(`已复制 ${entries.length} 条大纲`);
}
