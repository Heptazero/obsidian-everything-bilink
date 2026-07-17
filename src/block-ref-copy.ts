import { App, Editor, MarkdownView, Notice, TFile } from "obsidian";

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

// Wikilink alias can't safely contain these without breaking [[...]] syntax.
function sanitizeAlias(text: string): string {
	return text
		.replace(/\s+/g, " ")
		.replace(/[[\]|]/g, "")
		.trim()
		.slice(0, 300);
}

/**
 * Copies `[[note#^blockid|selected text]]` for the current editor selection.
 * Navigation lands on the whole block (Obsidian's native finest granularity);
 * the alias preserves exactly what was selected for display.
 *
 * The `^blockid` marker is only written into the note AFTER the clipboard write
 * succeeds — previously it was written unconditionally up front, so even a copy
 * that failed (or was never actually pasted anywhere) left a permanent orphaned
 * marker with nothing referencing it.
 */
export async function copyBlockReference(app: App): Promise<void> {
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

	const link = app.fileManager.generateMarkdownLink(file, "", `#^${id}`, sanitizeAlias(selectedText));

	try {
		await navigator.clipboard.writeText(link);
	} catch (err) {
		new Notice(`复制失败,笔记未被修改: ${err instanceof Error ? err.message : err}`);
		return;
	}

	if (!existing) writeBlockId(editor, end, id);
	new Notice("已复制引用链接");
}

export function hasActiveNoteSelection(app: App): boolean {
	const view = app.workspace.getActiveViewOfType(MarkdownView);
	return !!view && view.editor.getSelection().trim().length > 0;
}
