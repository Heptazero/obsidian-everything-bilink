import { App, FuzzySuggestModal, TFile } from "obsidian";

export interface FormulaCandidate {
	/** The LaTeX including its `$...$` / `$$...$$` delimiters, ready to splice in. */
	formula: string;
	/** A few words of surrounding text, for telling formulas apart without page anchors. */
	context: string;
}

/**
 * Same folder, `{basename}_md.md` — per this vault's 论文工作流.md convention
 * (e.g. `2023_对应中文翻译.pdf` → `2023_对应中文翻译_md.md`), not just a swapped
 * extension.
 */
export function findCompanionMarkdown(app: App, pdfFile: TFile): TFile | null {
	const mdPath = pdfFile.path.replace(/\.pdf$/i, "_md.md");
	if (mdPath === pdfFile.path) return null; // didn't actually end in .pdf
	const found = app.vault.getAbstractFileByPath(mdPath);
	return found instanceof TFile ? found : null;
}

const ANCHOR_LENS = [16, 10, 6];
const MAX_ANCHOR_SEARCH_WINDOW = 2000;
const MAX_RECOVERED_LEN = 150;
const FORMULA_RE = /\$\$[\s\S]+?\$\$|\$[^$\n]+?\$/;
const ADJACENT_SCAN = 400;

export interface GapRecovery {
	text: string;
	/** Where the match ended in the markdown — pass as `searchFrom` for the next
	 *  gap in the same selection, so a later gap can't match an earlier position
	 *  than one already resolved (selections read top-to-bottom; the markdown
	 *  should too). */
	matchEnd: number;
}

function tailAnchor(text: string, len: number): string {
	return text.replace(/\s+/g, " ").trim().slice(-len);
}
function headAnchor(text: string, len: number): string {
	return text.replace(/\s+/g, " ").trim().slice(0, len);
}

/**
 * Extends [start, end) outward over a formula sitting immediately against that
 * boundary with nothing but whitespace in between — e.g. "...as shown in $x^2$,
 * we..." — such a formula almost certainly belongs to the fragmented run itself,
 * not a separate one that happens to follow it, IF there's no punctuation (comma,
 * period) separating them. A comma/period right before the formula means it's a
 * distinct sentence element, not a continuation — left alone in that case.
 */
function expandOverAdjacentFormula(md: string, start: number, end: number): [number, number] {
	const before = md.slice(Math.max(0, start - ADJACENT_SCAN), start);
	const leftMatch = before.match(new RegExp(`(${FORMULA_RE.source})\\s*$`));
	if (leftMatch && !/[,，.。]\s*$/.test(before.slice(0, leftMatch.index))) {
		start = start - before.length + (leftMatch.index ?? 0);
	}

	const after = md.slice(end, end + ADJACENT_SCAN);
	const rightMatch = after.match(new RegExp(`^\\s*(${FORMULA_RE.source})`));
	if (rightMatch && !/^\s*[,，.。]/.test(after.slice(rightMatch[0].length))) {
		end = end + rightMatch[0].length;
	}

	return [start, end];
}

/**
 * Tries to automatically recover a gap's real content (almost always a formula
 * pdf.js's text layer couldn't select) by anchoring on the text immediately
 * before/after it — which WAS selected, so it's known-good — in the companion
 * markdown, and taking whatever sits between those anchors there. Retries with
 * progressively shorter anchors (a long anchor is more precise but more likely to
 * fail to match verbatim if OCR/rendering introduced tiny whitespace differences).
 *
 * There are no page markers to scope the search, so a short/common anchor can in
 * principle match an unrelated earlier occurrence in a long document — two
 * mitigations: `searchFrom` lets the caller pin the search to start no earlier
 * than a previous gap's match in the same selection (selections read top-to-
 * bottom, so should the markdown), and a recovered span is only accepted if it's
 * short and actually contains a formula — a real gap-fill should be that, not an
 * arbitrary stretch of unrelated prose a wrong match happened to bridge.
 *
 * Returns null if no confident match is found in any attempt — caller should fall
 * back to the manual picker rather than silently guessing wrong.
 */
const LOG = "everything-bilink:formula-recover";

export function autoRecoverGap(md: string, beforeText: string, afterText: string, searchFrom = 0): GapRecovery | null {
	for (const len of ANCHOR_LENS) {
		const before = tailAnchor(beforeText, len);
		const after = headAnchor(afterText, len);
		if (!before || !after) {
			console.debug(LOG, `len=${len}: skipped (empty anchor)`, { before, after });
			continue;
		}

		const beforeIdx = md.indexOf(before, searchFrom);
		if (beforeIdx === -1) {
			console.debug(LOG, `len=${len}: "before" anchor not found in md`, { before, searchFrom });
			continue;
		}
		const gapStart = beforeIdx + before.length;

		const afterIdx = md.indexOf(after, gapStart);
		if (afterIdx === -1) {
			console.debug(LOG, `len=${len}: "before" found at ${beforeIdx}, but "after" anchor not found after it`, {
				before,
				after,
			});
			continue;
		}
		if (afterIdx - gapStart > MAX_ANCHOR_SEARCH_WINDOW) {
			console.debug(LOG, `len=${len}: both anchors found but ${afterIdx - gapStart} chars apart (> ${MAX_ANCHOR_SEARCH_WINDOW} limit)`, {
				before,
				after,
			});
			continue;
		}

		const [start, end] = expandOverAdjacentFormula(md, gapStart, afterIdx);
		const recovered = md.slice(start, end).trim();
		if (!recovered || recovered.length > MAX_RECOVERED_LEN || !recovered.includes("$")) {
			console.debug(LOG, `len=${len}: matched but rejected by sanity check`, {
				recovered,
				length: recovered.length,
				hasDollar: recovered.includes("$"),
			});
			continue;
		}

		console.debug(LOG, `len=${len}: recovered "${recovered}"`);
		return { text: recovered, matchEnd: afterIdx + after.length };
	}
	console.debug(LOG, "no anchor length succeeded — falling back to manual picker", { beforeText, afterText, searchFrom });
	return null;
}

const CONTEXT_CHARS = 40;

/**
 * Extracts every `$$...$$` / `$...$` formula from the companion markdown, each with
 * a bit of surrounding text for the user to visually recognize which one they want
 * — there's no page marker to narrow the search automatically (the companion file
 * is a translation, so the PDF's own selected text can't be substring-matched
 * against it either).
 */
export function extractFormulas(content: string): FormulaCandidate[] {
	const found: Array<{ index: number; candidate: FormulaCandidate }> = [];
	const seenRanges: Array<[number, number]> = [];

	// Block formulas first, so a $$ pair isn't later re-matched as two $ ... $ pairs.
	const blockRe = /\$\$[\s\S]+?\$\$/g;
	let m: RegExpExecArray | null;
	while ((m = blockRe.exec(content))) {
		seenRanges.push([m.index, m.index + m[0].length]);
		found.push({ index: m.index, candidate: makeCandidate(content, m.index, m[0]) });
	}

	const inlineRe = /\$[^$\n]+?\$/g;
	while ((m = inlineRe.exec(content))) {
		const start = m.index;
		const end = start + m[0].length;
		if (seenRanges.some(([s, e]) => start >= s && end <= e)) continue; // inside a $$ block
		found.push({ index: start, candidate: makeCandidate(content, start, m[0]) });
	}

	// Document order — the user has no page markers to go on, so reading order is
	// the only orientation they have when picking from the list.
	found.sort((a, b) => a.index - b.index);
	return found.map((f) => f.candidate);
}

function makeCandidate(content: string, index: number, formula: string): FormulaCandidate {
	const before = content.slice(Math.max(0, index - CONTEXT_CHARS), index).replace(/\s+/g, " ").trim();
	const afterStart = index + formula.length;
	const after = content
		.slice(afterStart, afterStart + CONTEXT_CHARS)
		.replace(/\s+/g, " ")
		.trim();
	return { formula, context: `…${before} 【公式】 ${after}…` };
}

export class FormulaPickerModal extends FuzzySuggestModal<FormulaCandidate> {
	constructor(
		app: App,
		private candidates: FormulaCandidate[],
		private onPick: (candidate: FormulaCandidate) => void
	) {
		super(app);
		this.setPlaceholder("搜索周围文字,找到对应的公式…");
	}

	getItems(): FormulaCandidate[] {
		return this.candidates;
	}

	getItemText(item: FormulaCandidate): string {
		return `${item.context} ${item.formula}`;
	}

	onChooseItem(item: FormulaCandidate): void {
		this.onPick(item);
	}

	renderSuggestion(match: { item: FormulaCandidate }, el: HTMLElement): void {
		el.createDiv({ text: match.item.context });
		el.createEl("code", { text: match.item.formula, cls: "formula-picker-code" });
	}
}
