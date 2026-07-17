import { Component, FileView, MarkdownView, Notice, Plugin, TFile } from "obsidian";
import { findBacklinksForPDF, type BacklinkRef } from "./backlink-index";
import { cleanUnusedBlockIds } from "./block-ref-cleanup";
import { copyBlockReference, hasActiveNoteSelection } from "./block-ref-copy";
import { renderBacklinkHighlights } from "./backlink-render";
import { registerRectEmbed } from "./embed";
import { buildSubpath, registerLinkOpenPatch } from "./link-open";
import { onPageReady, onTextLayerReady, type PdfRect } from "./pdf-layer";
import type { PDFPageView } from "./pdfjs-types";
import { registerRectPreview } from "./preview";
import { attachRectSelectListener, type RectSelectController } from "./rect-select";
import { copySelectionAsQuote, copySelectionAsWikilink, hasActiveTextSelection } from "./text-select-copy";
import {
	attachTextPlaceListener,
	placeNewTextBox,
	renderTextBoxes,
	TextBoxStore,
	type TextPlaceController,
} from "./text-box";

const trackedViews = new WeakSet<FileView>();
const trackedPageDivs = new WeakSet<HTMLDivElement>();

export default class PdfBilinkPlugin extends Plugin {
	private rectSelect: RectSelectController = { armed: false };
	private textPlace: TextPlaceController = { armed: false };
	private textStore = new TextBoxStore(this);

	async onload() {
		await this.textStore.load();

		registerLinkOpenPatch(this);
		registerRectEmbed(this);
		registerRectPreview(this);

		this.app.workspace.onLayoutReady(() => this.scanPDFViews());
		this.registerEvent(this.app.workspace.on("layout-change", () => this.scanPDFViews()));
		this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.scanPDFViews()));

		this.addRibbonIcon("frame", "Everything Bilink: 框选区域 → 复制链接", () => this.armRectSelect());
		this.addRibbonIcon("type", "Everything Bilink: 在 PDF 上添加文字框", () => this.armTextPlace());
		this.addCommand({
			id: "draw-region-link",
			name: "框选区域 → 复制链接(笔记里是活嵌入,Excalidraw 里是带链接的图片)",
			checkCallback: (checking) => {
				const view = this.app.workspace.getActiveViewOfType(FileView);
				const active = !!view && view.getViewType() === "pdf";
				if (!checking && active) this.armRectSelect();
				return active;
			},
		});
		this.addCommand({
			id: "add-text-box",
			name: "在 PDF 上添加文字框",
			checkCallback: (checking) => {
				const view = this.app.workspace.getActiveViewOfType(FileView);
				const active = !!view && view.getViewType() === "pdf";
				if (!checking && active) this.armTextPlace();
				return active;
			},
		});
		this.addCommand({
			id: "copy-selection-as-wikilink",
			name: "[PDF 选区] 复制为单行双链(标题=选中文字)",
			checkCallback: (checking) => {
				const active = hasActiveTextSelection();
				if (!checking && active) void copySelectionAsWikilink(this.app);
				return active;
			},
		});
		this.addCommand({
			id: "copy-selection-as-quote",
			name: "[PDF 选区] 复制为引用块(> 文字 + 链接两行)",
			checkCallback: (checking) => {
				const active = hasActiveTextSelection();
				if (!checking && active) void copySelectionAsQuote(this.app);
				return active;
			},
		});
		this.addCommand({
			id: "copy-block-reference",
			name: "[笔记选区,非 PDF] 复制为块引用",
			checkCallback: (checking) => {
				const active = hasActiveNoteSelection(this.app);
				if (!checking && active) void copyBlockReference(this.app);
				return active;
			},
		});
		this.addCommand({
			id: "clean-unused-block-ids",
			name: "[笔记] 清理未被引用的块标记(^id)",
			checkCallback: (checking) => {
				const active = !!this.app.workspace.getActiveViewOfType(MarkdownView);
				if (!checking && active) void cleanUnusedBlockIds(this.app);
				return active;
			},
		});
	}

	private armRectSelect(): void {
		this.rectSelect.armed = true;
		this.textPlace.armed = false;
		new Notice("在 PDF 上拖动框选一块区域");
	}

	private armTextPlace(): void {
		this.textPlace.armed = true;
		this.rectSelect.armed = false;
		new Notice("在 PDF 上点击一处放置文字框");
	}

	private scanPDFViews(): void {
		for (const leaf of this.app.workspace.getLeavesOfType("pdf")) {
			const view = leaf.view as FileView;
			if (trackedViews.has(view)) continue;
			trackedViews.add(view);
			this.attachPageHandlers(view);
		}
	}

	private attachPageHandlers(view: FileView): void {
		const component = new Component();
		this.addChild(component);

		const file = view.file;
		if (!(file instanceof TFile)) return;
		const pdfPath = file.path;

		const pageViews = new Map<number, PDFPageView>();

		const refreshHighlights = () => {
			const refs = findBacklinksForPDF(this.app, file);
			const byPage = new Map<number, BacklinkRef[]>();
			for (const ref of refs) {
				if (!byPage.has(ref.page)) byPage.set(ref.page, []);
				byPage.get(ref.page)!.push(ref);
			}
			for (const [pageNumber, pageView] of pageViews) {
				renderBacklinkHighlights(this.app, file, pageView, byPage.get(pageNumber) ?? []);
			}
		};

		onPageReady(view, component, (pageNumber, pageView) => {
			if (!pageView.pdfPage?.view) return; // guard not-yet-ready page stubs
			pageViews.set(pageNumber, pageView);

			// PDF.js may re-fire pagerendered for the same (recycled) div; only wire
			// the pointer listeners once per div.
			if (!trackedPageDivs.has(pageView.div)) {
				trackedPageDivs.add(pageView.div);

				const detachRect = attachRectSelectListener(pageView, this.rectSelect, (rect) =>
					this.completeRectSelection(view, pageNumber, rect)
				);
				const detachText = attachTextPlaceListener(pageView, this.textPlace, (x, y) =>
					placeNewTextBox(this.app, pageView, pdfPath, pageNumber, this.textStore, x, y)
				);
				component.register(detachRect);
				component.register(detachText);
			}

			// Both must re-run on every (re)render — pdf.js wipes the overlay layer on
			// zoom/scroll, so drawing these only once per div made them disappear.
			renderTextBoxes(this.app, pageView, pdfPath, pageNumber, this.textStore);
			refreshHighlights();
		});

		// Text-selection highlights need the text layer, which renders after the page —
		// redraw this page's highlights once it's ready.
		onTextLayerReady(view, component, (pageNumber, pageView) => {
			if (!pageView.pdfPage?.view) return;
			pageViews.set(pageNumber, pageView);
			refreshHighlights();
		});

		// "resolved" (docs: fires "each time files get modified") is the natural fit
		// here, but is unreliable/delayed in practice — "changed" fires deterministically
		// right after any single file's cache updates, so it's the real fix for stale
		// highlights (e.g. a deleted reference not disappearing until something else
		// happened to force a redraw).
		component.registerEvent(this.app.metadataCache.on("resolved", refreshHighlights));
		component.registerEvent(this.app.metadataCache.on("changed", refreshHighlights));
	}

	private async completeRectSelection(view: FileView, pageNumber: number, rect: PdfRect): Promise<void> {
		const file = view.file;
		if (!(file instanceof TFile)) return;

		const subpath = buildSubpath(pageNumber, rect);
		// Embed (leading "!"). In a note this plugin renders it as a live cropped
		// image (click-to-jump); pasted onto an Excalidraw canvas, Excalidraw renders
		// the same `rect=` crop natively and binds the link to the image element.
		const embed = "!" + this.app.fileManager.generateMarkdownLink(file, "", subpath);

		await navigator.clipboard.writeText(embed);
		new Notice(`已复制区域链接:\n${embed}`);
	}
}
