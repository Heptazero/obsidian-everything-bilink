import { App, Editor, MarkdownView, Notice, TFile } from "obsidian";
import { applyTemplate, type BilinkSettings } from "./settings";

/**
 * Finds the line range of the "block" containing `line`. List items are treated
 * as one-line blocks (the common case); everything else is a blank-line-delimited
 * paragraph. Multi-line list-item continuations and nested structures aren't
 * specially handled in this first pass — they fall back to the paragraph rule.
 */
function findBlockRange(editor: Editor, line: number): { start: number; end: number } {
	const lineText = editor.getLine(line);
	if (/^\s*([-*+]|\d+\.)\s/.test(lineText)) {
		return { start: line, end: line };
	}
	let start = line;
	while (start > 0 && editor.getLine(start - 1).trim() !== "") start--;
	let end = line;
	const lastLine = editor.lastLine();
	while (end < lastLine && editor.getLine(end + 1).trim() !== "") end++;
	return { start, end };
}

/** An existing trailing `^id` on the block's last line, if any — read-only, no write. */
function existingBlockId(editor: Editor, end: number): string | null {
	return editor.getLine(end).match(/\^([A-Za-z0-9-]+)\s*$/)?.[1] ?? null;
}

/** Appends ` ^id` to the block's last line. Only call this after the copy has succeeded. */
function writeBlockId(editor: Editor, end: number, id: string): void {
	const lineText = editor.getLine(end);
	const pos = { line: end, ch: lineText.length };
	editor.replaceRange(` ^${id}`, pos, pos);
}

function sanitizeQuoteText(text: string): string {
	return text.replace(/\s+/g, " ").trim().slice(0, 500);
}

/**
 * Shared by both block-reference copy modes below. Finds/creates the `^blockid`
 * on the selection's containing block, builds the clipboard text via `template`,
 * and only writes the id into the note AFTER the clipboard write succeeds —
 * previously it was written unconditionally up front, so even a copy that
 * failed (or was never actually pasted anywhere) left a permanent orphaned
 * marker with nothing referencing it.
 */
async function copyWithBlockId(app: App, settings: BilinkSettings, template: string): Promise<void> {
	const view = app.workspace.getActiveViewOfType(MarkdownView);
	if (!view) {
		new Notice("先在一篇笔记里选中文字");
		return;
	}
	const selectedText = view.editor.getSelection();
	if (!selectedText.trim()) {
		new Notice("先选中一段文字");
		return;
	}
	const file = view.file;
	if (!(file instanceof TFile)) return;

	const editor = view.editor;
	const from = editor.getCursor("from");
	const { end } = findBlockRange(editor, from.line);
	const existing = existingBlockId(editor, end);
	const id = existing ?? Math.random().toString(36).slice(2, 8);

	const link = app.fileManager.generateMarkdownLink(file, "", `#^${id}`, settings.jumpLabel || undefined);
	const text = applyTemplate(template, { text: sanitizeQuoteText(selectedText), link, file: file.basename, page: "" });

	try {
		await navigator.clipboard.writeText(text);
	} catch (err) {
		new Notice(`复制失败,笔记未被修改: ${err instanceof Error ? err.message : err}`);
		return;
	}

	if (!existing) writeBlockId(editor, end, id);
	new Notice("已复制");
}

/**
 * `> {selected text}[[note#^blockid|↗]]` — the real text sits in the blockquote
 * body (rendered as normal Markdown — LaTeX, bold, etc. all work); the link
 * carries only a jump arrow, since a wikilink ALIAS is always rendered as plain
 * text in Obsidian — putting the actual content there (the previous approach)
 * silently broke any formula in the selection. Navigation lands on the whole
 * block (Obsidian's native finest granularity).
 */
export function copyBlockReference(app: App, settings: BilinkSettings): Promise<void> {
	return copyWithBlockId(app, settings, settings.blockRefTemplate);
}

/** Just `[[note#^blockid|↗]]` — no quoted text, so nothing about the copy can be broken by LaTeX in the selection. */
export function copyBlockReferenceLinkOnly(app: App, settings: BilinkSettings): Promise<void> {
	return copyWithBlockId(app, settings, settings.blockLinkOnlyTemplate);
}

export function hasActiveNoteSelection(app: App): boolean {
	const view = app.workspace.getActiveViewOfType(MarkdownView);
	return !!view && view.editor.getSelection().trim().length > 0;
}
