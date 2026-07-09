import { App, TFile, parseLinktext, type Pos } from "obsidian";
import type { PdfRect } from "./pdf-layer";
import { parseSelection, type Selection } from "./selection-geom";
import { parseBilinkSubpath } from "./subpath";

interface BacklinkRefBase {
	sourceFile: TFile;
	page: number;
	/** Where in sourceFile this link occurs, for jump-to-exact-line. */
	position: Pos;
}

export type BacklinkRef =
	| (BacklinkRefBase & { kind: "rect"; rect: PdfRect })
	| (BacklinkRefBase & { kind: "selection"; selection: Selection });

/**
 * Finds every link in the vault pointing at `pdfFile` with a rect= or selection=
 * subpath. Uses metadataCache.resolvedLinks to narrow candidate source files first
 * (cheap), then reads each candidate's link cache for the exact subpath.
 */
export function findBacklinksForPDF(app: App, pdfFile: TFile): BacklinkRef[] {
	const refs: BacklinkRef[] = [];
	const resolved = app.metadataCache.resolvedLinks;

	for (const sourcePath in resolved) {
		if (!(pdfFile.path in resolved[sourcePath])) continue;
		const sourceFile = app.vault.getAbstractFileByPath(sourcePath);
		if (!(sourceFile instanceof TFile)) continue;

		const cache = app.metadataCache.getFileCache(sourceFile);
		const links = [...(cache?.links ?? []), ...(cache?.embeds ?? [])];
		for (const link of links) {
			const { path, subpath } = parseLinktext(link.link);
			if (!subpath) continue;

			const dest = app.metadataCache.getFirstLinkpathDest(path, sourcePath);
			if (dest?.path !== pdfFile.path) continue;

			const rectParsed = parseBilinkSubpath(subpath);
			if (rectParsed) {
				refs.push({
					kind: "rect",
					sourceFile,
					page: rectParsed.page,
					rect: rectParsed.rect,
					position: link.position,
				});
				continue;
			}

			const params = new URLSearchParams(subpath.replace(/^#/, ""));
			const pageStr = params.get("page");
			const selStr = params.get("selection");
			if (pageStr && selStr) {
				const page = parseInt(pageStr, 10);
				const selection = parseSelection(selStr);
				if (!Number.isNaN(page) && selection) {
					refs.push({ kind: "selection", sourceFile, page, selection, position: link.position });
				}
			}
		}
	}
	return refs;
}
