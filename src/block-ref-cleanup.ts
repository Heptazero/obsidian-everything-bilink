import { App, MarkdownView, Notice, TFile, parseLinktext } from "obsidian";
import { ConfirmModal } from "./confirm-modal";

/** True if any file in the vault has a link resolving to exactly `file#^blockId`. */
function vaultReferencesBlock(app: App, file: TFile, blockId: string): boolean {
	const resolved = app.metadataCache.resolvedLinks;
	for (const sourcePath in resolved) {
		if (!(file.path in resolved[sourcePath])) continue;
		const sourceFile = app.vault.getAbstractFileByPath(sourcePath);
		if (!(sourceFile instanceof TFile)) continue;

		const cache = app.metadataCache.getFileCache(sourceFile);
		const links = [...(cache?.links ?? []), ...(cache?.embeds ?? [])];
		for (const link of links) {
			const { path, subpath } = parseLinktext(link.link);
			if (subpath !== `#^${blockId}`) continue;
			const dest = app.metadataCache.getFirstLinkpathDest(path, sourcePath);
			if (dest?.path === file.path) return true;
		}
	}
	return false;
}

interface OrphanCandidate {
	line: number;
	id: string;
}

function findOrphanCandidates(app: App, file: TFile, content: string): OrphanCandidate[] {
	const orphans: OrphanCandidate[] = [];
	content.split("\n").forEach((lineText, line) => {
		const m = lineText.match(/\^([A-Za-z0-9-]+)\s*$/);
		if (m && !vaultReferencesBlock(app, file, m[1])) orphans.push({ line, id: m[1] });
	});
	return orphans;
}

/**
 * Scans the active note for `^blockid` markers that nothing in the vault links to,
 * and offers to strip them. Covers the case a successful copy's link was later
 * deleted from wherever it was pasted — nothing else in this plugin cleans that up
 * automatically, since the marker lives in the source note, not the reference.
 */
export async function cleanUnusedBlockIds(app: App): Promise<void> {
	const view = app.workspace.getActiveViewOfType(MarkdownView);
	const file = view?.file;
	if (!view || !(file instanceof TFile)) {
		new Notice("先打开一篇笔记");
		return;
	}

	const orphans = findOrphanCandidates(app, file, view.editor.getValue());
	if (orphans.length === 0) {
		new Notice("没有发现未被引用的块标记");
		return;
	}

	new ConfirmModal(
		app,
		`发现 ${orphans.length} 处没有任何笔记引用的块标记(^id),是否清除?只删标记本身,不动正文内容。`,
		"清除",
		() => {
			const editor = view.editor;
			// Bottom-to-top so earlier line numbers stay valid as edits apply.
			for (const o of [...orphans].sort((a, b) => b.line - a.line)) {
				const cleaned = editor.getLine(o.line).replace(/\s*\^[A-Za-z0-9-]+\s*$/, "");
				editor.setLine(o.line, cleaned);
			}
			new Notice(`已清除 ${orphans.length} 处块标记`);
		}
	).open();
}
