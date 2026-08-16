import { App, Menu, Notice, TFile } from "obsidian";
import type { BacklinkRef } from "./backlink-index";
import { deleteRefsFromSources, updateRectInSources } from "./backlink-edit";
import { ConfirmModal } from "./confirm-modal";
import { getOverlayLayer, placeRect, screenToPdfPoint, type PdfRect } from "./pdf-layer";
import type { PDFPageView } from "./pdfjs-types";
import { computeSelectionRects, type SelectionLineRect } from "./selection-geom";
import { buildSubpath } from "./subpath";

interface HighlightItem {
	page: number;
	/** One or more boxes to draw (a text selection can wrap across lines). */
	rects: SelectionLineRect[];
	refs: BacklinkRef[];
	/** Rect anchors can be dragged/resized; selection anchors are text-bound, so no. */
	editable: boolean;
	copyLink: () => void;
}

function openRef(app: App, ref: BacklinkRef): void {
	// Open the referencing note in a new tab (the click starts on the PDF tab, so
	// reusing the most-recent leaf would replace the PDF you're looking at).
	app.workspace.getLeaf("tab").openFile(ref.sourceFile, { eState: { line: ref.position.start.line } });
}

/** Groups rect refs by identical rounded rect; each becomes one editable highlight. */
function buildRectItems(app: App, pdfFile: TFile, refs: BacklinkRef[]): HighlightItem[] {
	const groups = new Map<string, { rect: PdfRect; page: number; refs: BacklinkRef[] }>();
	for (const ref of refs) {
		if (ref.kind !== "rect") continue;
		const key = ref.rect.map((n) => Math.round(n)).join(",");
		const g = groups.get(key) ?? { rect: ref.rect, page: ref.page, refs: [] };
		g.refs.push(ref);
		groups.set(key, g);
	}
	return [...groups.values()].map((g) => ({
		page: g.page,
		rects: [{ rect: g.rect, heightRatio: 1, hasGap: false }],
		refs: g.refs,
		editable: true,
		copyLink: () => {
			const embed = "!" + app.fileManager.generateMarkdownLink(pdfFile, "", buildSubpath(g.page, g.rect));
			void navigator.clipboard.writeText(embed);
			new Notice("已复制链接");
		},
	}));
}

/** Resolves selection refs to text-layer line rects; groups by identical selection. */
function buildSelectionItems(
	app: App,
	pdfFile: TFile,
	pageView: PDFPageView,
	refs: BacklinkRef[]
): HighlightItem[] {
	const groups = new Map<string, { page: number; selKey: string; refs: BacklinkRef[]; rects: SelectionLineRect[] }>();
	for (const ref of refs) {
		if (ref.kind !== "selection") continue;
		const key = ref.selection.join(",");
		let g = groups.get(key);
		if (!g) {
			g = { page: ref.page, selKey: key, refs: [], rects: computeSelectionRects(pageView, ref.selection) };
			groups.set(key, g);
		}
		g.refs.push(ref);
	}
	const items: HighlightItem[] = [];
	for (const g of groups.values()) {
		if (g.rects.length === 0) continue; // text layer not ready yet; retry later
		items.push({
			page: g.page,
			rects: g.rects,
			refs: g.refs,
			editable: false,
			copyLink: () => {
				const link = app.fileManager.generateMarkdownLink(pdfFile, "", `#page=${g.page}&selection=${g.selKey}`);
				void navigator.clipboard.writeText(link);
				new Notice("已复制链接");
			},
		});
	}
	return items;
}

/** Turns a (rect) highlight box into a move/resize editor; on ✓ writes new coords to all refs. */
function enterRectEdit(app: App, pageView: PDFPageView, layer: HTMLElement, box: HTMLElement, refs: BacklinkRef[], rect: PdfRect): void {
	box.addClass("pdf-bilink-editing");

	const startDrag = (grab: (m: PointerEvent, start: PointerEvent, r: DOMRect, lr: DOMRect) => void) => (ev: PointerEvent) => {
		ev.preventDefault();
		ev.stopPropagation();
		const r = box.getBoundingClientRect();
		const lr = layer.getBoundingClientRect();
		box.style.left = `${r.left - lr.left}px`;
		box.style.top = `${r.top - lr.top}px`;
		box.style.width = `${r.width}px`;
		box.style.height = `${r.height}px`;
		const onMove = (m: PointerEvent) => grab(m, ev, r, lr);
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", () => window.removeEventListener("pointermove", onMove), { once: true });
	};

	const moveGrip = box.createDiv("pdf-bilink-edit-grip");
	moveGrip.addEventListener(
		"pointerdown",
		startDrag((m, start, r, lr) => {
			box.style.left = `${r.left - lr.left + (m.clientX - start.clientX)}px`;
			box.style.top = `${r.top - lr.top + (m.clientY - start.clientY)}px`;
		})
	);

	const resizeHandle = box.createDiv("pdf-bilink-edit-resize");
	resizeHandle.addEventListener(
		"pointerdown",
		startDrag((m, start, r) => {
			box.style.width = `${Math.max(8, r.width + (m.clientX - start.clientX))}px`;
			box.style.height = `${Math.max(8, r.height + (m.clientY - start.clientY))}px`;
		})
	);

	const bar = box.createDiv("pdf-bilink-edit-bar");
	const ok = bar.createEl("button", { text: "✓" });
	const cancel = bar.createEl("button", { text: "✗" });
	const finish = () => box.removeClasses(["pdf-bilink-editing"]);

	ok.addEventListener("click", async (e) => {
		e.stopPropagation();
		const r = box.getBoundingClientRect();
		const [x0, y0] = screenToPdfPoint(pageView, r.left, r.bottom);
		const [x1, y1] = screenToPdfPoint(pageView, r.right, r.top);
		finish();
		const n = await updateRectInSources(app, refs, [x0, y0, x1, y1]);
		new Notice(`已更新 ${n} 处引用的区域`);
	});

	cancel.addEventListener("click", (e) => {
		e.stopPropagation();
		box.style.left = box.style.top = box.style.width = box.style.height = "";
		placeRect(pageView, layer, rect, box);
		finish();
	});
}

function showMenu(app: App, pageView: PDFPageView, layer: HTMLElement, box: HTMLElement, item: HighlightItem, ev: MouseEvent): void {
	const menu = new Menu();
	menu.addItem((i) => i.setTitle("复制链接").setIcon("copy").onClick(() => item.copyLink()));
	if (item.editable) {
		menu.addItem((i) =>
			i
				.setTitle("编辑区域(改大小/位置)")
				.setIcon("move")
				.onClick(() => enterRectEdit(app, pageView, layer, box, item.refs, item.rects[0].rect))
		);
	}
	menu.addItem((i) =>
		i
			.setTitle(`删除全部引用 (${item.refs.length})`)
			.setIcon("trash")
			.onClick(() =>
				new ConfirmModal(
					app,
					`将从 ${item.refs.length} 处笔记中删除引用此处的链接,这会修改这些笔记文件。确定?`,
					"删除",
					async () => {
						const n = await deleteRefsFromSources(app, item.refs);
						new Notice(`已删除 ${n} 处引用`);
					}
				).open()
			)
	);
	menu.addSeparator();
	menu.addItem((i) => i.setTitle("引用的位置:").setIsLabel(true));
	for (const ref of item.refs) {
		menu.addItem((i) => i.setTitle(ref.sourceFile.basename).setIcon("file-text").onClick(() => openRef(app, ref)));
	}
	menu.showAtMouseEvent(ev);
}

/** Redraws this page's persistent backlink highlights (rect + text-selection) to match `refs`. */
export function renderBacklinkHighlights(app: App, pdfFile: TFile, pageView: PDFPageView, refs: BacklinkRef[]): void {
	const layer = getOverlayLayer(pageView);
	layer.querySelectorAll(":scope > .pdf-bilink-persistent-highlight").forEach((el) => el.remove());
	if (refs.length === 0) return;

	const items = [...buildRectItems(app, pdfFile, refs), ...buildSelectionItems(app, pdfFile, pageView, refs)];

	for (const item of items) {
		// One item may draw several boxes (multi-line selection); they share handlers.
		for (const { rect, heightRatio, hasGap } of item.rects) {
			// Rect selections stay boxes (they represent an actual region); text
			// selections render as an underline (reads more like normal markup).
			const classes = [
				"pdf-bilink-persistent-highlight",
				item.editable ? "pdf-bilink-kind-rect" : "pdf-bilink-kind-selection",
			];
			// A gap-bridging line has no text-layer geometry for whatever it skipped
			// over (usually a formula), so the mark can't be trusted to hug the
			// baseline here — see styles.css, which pushes it down instead of up.
			if (hasGap) classes.push("pdf-bilink-has-gap");
			const box = layer.createDiv(classes.join(" "));
			box.setCssStyles({ pointerEvents: "auto", cursor: "pointer" });
			// Scales the underline's configured offset down when this box is taller
			// than a normal single line (a formula character or super/subscript
			// mixed into the selected span) — see SelectionLineRect.heightRatio.
			box.style.setProperty("--bilink-line-ratio", String(heightRatio));
			if (item.refs.length > 1) box.setAttribute("aria-label", `${item.refs.length} 处引用`);
			placeRect(pageView, layer, rect, box);

			// Single click → menu; double click → jump if exactly one reference. A short
			// timer distinguishes the two so the menu doesn't fire on a double-click.
			let clickTimer: number | null = null;
			box.addEventListener("click", (ev) => {
				ev.preventDefault();
				ev.stopPropagation();
				if (box.hasClass("pdf-bilink-editing")) return;
				if (clickTimer !== null) return;
				const mouseEv = ev as MouseEvent;
				clickTimer = window.setTimeout(() => {
					clickTimer = null;
					showMenu(app, pageView, layer, box, item, mouseEv);
				}, 250);
			});
			box.addEventListener("dblclick", (ev) => {
				ev.preventDefault();
				ev.stopPropagation();
				if (clickTimer !== null) {
					window.clearTimeout(clickTimer);
					clickTimer = null;
				}
				if (item.refs.length === 1) openRef(app, item.refs[0]);
			});
		}
	}
}
