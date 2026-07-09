import { App, TFile } from "obsidian";
import type { BacklinkRef } from "./backlink-index";
import type { PdfRect } from "./pdf-layer";

const RECT_RE = /rect=-?[\d.]+,-?[\d.]+,-?[\d.]+,-?[\d.]+/;
// Either kind of PDF-region link, used as a delete-time sanity check against a stale cache.
const REGION_RE = /(rect|selection)=/;

function groupByFile(refs: BacklinkRef[]): Map<TFile, BacklinkRef[]> {
	const map = new Map<TFile, BacklinkRef[]>();
	for (const ref of refs) {
		const list = map.get(ref.sourceFile) ?? [];
		list.push(ref);
		map.set(ref.sourceFile, list);
	}
	return map;
}

/**
 * Rewrites the `rect=` coordinates of every given reference in-place in its source
 * file. Edits within a file are applied end-to-start so earlier byte offsets stay
 * valid. A reference whose cached range no longer contains a `rect=` (stale cache)
 * is skipped rather than risking a bad splice. Returns how many were updated.
 */
export async function updateRectInSources(app: App, refs: BacklinkRef[], newRect: PdfRect): Promise<number> {
	const coords = newRect.map((n) => Math.round(n)).join(",");
	let changed = 0;
	for (const [file, list] of groupByFile(refs)) {
		let content = await app.vault.read(file);
		const sorted = [...list].sort((a, b) => b.position.start.offset - a.position.start.offset);
		for (const ref of sorted) {
			const s = ref.position.start.offset;
			const e = ref.position.end.offset;
			const seg = content.slice(s, e);
			if (!RECT_RE.test(seg)) continue;
			content = content.slice(0, s) + seg.replace(RECT_RE, `rect=${coords}`) + content.slice(e);
			changed++;
		}
		await app.vault.modify(file, content);
	}
	return changed;
}

/** Removes every given reference's link/embed text from its source file. */
export async function deleteRefsFromSources(app: App, refs: BacklinkRef[]): Promise<number> {
	let changed = 0;
	for (const [file, list] of groupByFile(refs)) {
		let content = await app.vault.read(file);
		const sorted = [...list].sort((a, b) => b.position.start.offset - a.position.start.offset);
		for (const ref of sorted) {
			const s = ref.position.start.offset;
			const e = ref.position.end.offset;
			if (!REGION_RE.test(content.slice(s, e))) continue;
			content = content.slice(0, s) + content.slice(e);
			changed++;
		}
		await app.vault.modify(file, content);
	}
	return changed;
}
