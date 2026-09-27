import { Component, FileView, MarkdownView, Notice, Plugin, TFile } from "obsidian";
import { findBacklinksForPDF, type BacklinkRef } from "./backlink-index";
import { cleanUnusedBlockIds } from "./block-ref-cleanup";
import { copyBlockReference, copyBlockReferenceLinkOnly, hasActiveNoteSelection } from "./block-ref-copy";
import { renderBacklinkHighlights } from "./backlink-render";
import { registerRectEmbed } from "./embed";
import { buildSubpath, registerLinkOpenPatch } from "./link-open";
import { copyPdfOutline } from "./outline";
import { getActivePDFView, onPageReady, onTextLayerReady, type PdfRect } from "./pdf-layer";
import type { PDFPageView } from "./pdfjs-types";
import { registerRectPreview } from "./preview";
import { attachRectSelectListener, type RectSelectController } from "./rect-select";
import {
	applyStyleSettings,
	applyTemplate,
	BilinkSettingTab,
	clearStyleSettings,
	loadSettings,
	saveSettings,
	type BilinkSettings,
} from "./settings";
import { copySelection, hasActiveTextSelection } from "./text-select-copy";

const trackedViews = new WeakSet<FileView>();
const trackedPageDivs = new WeakSet<HTMLDivElement>();

export default class PdfBilinkPlugin extends Plugin {
	private rectSelect: RectSelectController = { armed: false };
	private bilinkSettings!: BilinkSettings;

	async onload() {
		this.bilinkSettings = await loadSettings(this);

		applyStyleSettings(this.bilinkSettings);
		this.register(() => clearStyleSettings());
		this.addSettingTab(
			new BilinkSettingTab(this.app, this, this.bilinkSettings, () => {
				applyStyleSettings(this.bilinkSettings);
				void saveSettings(this, this.bilinkSettings);
			})
		);

		registerLinkOpenPatch(this);
		registerRectEmbed(this);
		registerRectPreview(this);

		this.app.workspace.onLayoutReady(() => this.scanPDFViews());
		this.registerEvent(this.app.workspace.on("layout-change", () => this.scanPDFViews()));
		this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.scanPDFViews()));

		this.addRibbonIcon("frame", "Everything Bilink: 框选复制链接", () => this.armRectSelect());
		this.addCommand({
			id: "draw-region-link",
			name: "[PDF 框选] 复制链接",
			checkCallback: (checking) => {
				const view = this.app.workspace.getActiveViewOfType(FileView);
				const active = !!view && view.getViewType() === "pdf";
				if (!checking && active) this.armRectSelect();
				return active;
			},
		});
		this.addCommand({
			id: "copy-selection-as-wikilink",
			name: "[PDF 选区] 单行",
			checkCallback: (checking) => {
				const active = hasActiveTextSelection();
				if (!checking && active) void copySelection(this.app, this.bilinkSettings, "inline");
				return active;
			},
		});
		this.addCommand({
			id: "copy-selection-as-quote",
			name: "[PDF 选区] 引用块",
			checkCallback: (checking) => {
				const active = hasActiveTextSelection();
				if (!checking && active) void copySelection(this.app, this.bilinkSettings, "quote");
				return active;
			},
		});
		this.addCommand({
			id: "copy-selection-link-only",
			name: "[PDF 选区] 仅链接",
			checkCallback: (checking) => {
				const active = hasActiveTextSelection();
				if (!checking && active) void copySelection(this.app, this.bilinkSettings, "link-only");
				return active;
			},
		});
		this.addCommand({
			id: "copy-pdf-outline",
			name: "[PDF] 大纲",
			checkCallback: (checking) => {
				const active = !!getActivePDFView(this.app);
				if (!checking && active) void copyPdfOutline(this.app, this.bilinkSettings);
				return active;
			},
		});
		this.addCommand({
			id: "copy-block-reference",
			name: "[笔记块引用] 引用块",
			checkCallback: (checking) => {
				const active = hasActiveNoteSelection(this.app);
				if (!checking && active) void copyBlockReference(this.app, this.bilinkSettings);
				return active;
			},
		});
		this.addCommand({
			id: "copy-block-reference-link-only",
			name: "[笔记块引用] 仅链接",
			checkCallback: (checking) => {
				const active = hasActiveNoteSelection(this.app);
				if (!checking && active) void copyBlockReferenceLinkOnly(this.app, this.bilinkSettings);
				return active;
			},
		});
		this.addCommand({
			id: "clean-unused-block-ids",
			name: "[笔记] 清理块标记",
			checkCallback: (checking) => {
				const active = !!this.app.workspace.getActiveViewOfType(MarkdownView);
				if (!checking && active) void cleanUnusedBlockIds(this.app);
				return active;
			},
		});
	}

	private armRectSelect(): void {
		this.rectSelect.armed = true;
		new Notice("在 PDF 上拖动框选一块区域");
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

		const pageViews = new Map<number, PDFPageView>();

		// Obsidian can reuse the same FileView (and the same underlying pdf.js
		// viewer/eventBus) when the user switches to a different PDF in the same
		// tab — `view` itself stays alive, only `view.file` changes underneath it.
		// Reading `view.file` fresh on every call (instead of capturing it once
		// above) is what makes highlights follow the file actually open, instead of
		// staying bound to whichever PDF was open when this was first attached.
		let lastPath: string | null = null;
		const currentFile = (): TFile | null => {
			const file = view.file;
			if (!(file instanceof TFile)) return null;
			if (file.path !== lastPath) {
				pageViews.clear(); // drop stale page entries from the previous file
				lastPath = file.path;
			}
			return file;
		};

		const refreshHighlights = () => {
			const file = currentFile();
			if (!file) return;
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
			currentFile();
			pageViews.set(pageNumber, pageView);

			// PDF.js may re-fire pagerendered for the same (recycled) div; only wire
			// the pointer listeners once per div.
			if (!trackedPageDivs.has(pageView.div)) {
				trackedPageDivs.add(pageView.div);

				const detachRect = attachRectSelectListener(pageView, this.rectSelect, (rect) =>
					this.completeRectSelection(view, pageNumber, rect)
				);
				component.register(detachRect);
			}

			refreshHighlights();
		});

		// Text-selection highlights need the text layer, which renders after the page —
		// redraw this page's highlights once it's ready.
		onTextLayerReady(view, component, (pageNumber, pageView) => {
			if (!pageView.pdfPage?.view) return;
			currentFile();
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

		if (this.bilinkSettings.rectCopyMode === "link") {
			// Same "[PDF] 仅链接" template PDF-selection link-only copy uses — no
			// image, just the configured link style, for when the crop preview
			// isn't wanted.
			const link = this.app.fileManager.generateMarkdownLink(file, "", subpath, this.bilinkSettings.jumpLabel || undefined);
			const text = applyTemplate(this.bilinkSettings.linkOnlyTemplate, {
				text: "",
				link,
				file: file.basename,
				page: String(pageNumber),
			});
			await navigator.clipboard.writeText(text);
			new Notice(`已复制区域链接:\n${text}`);
			return;
		}

		// Embed (leading "!"). In a note this plugin renders it as a live cropped
		// image (click-to-jump); pasted onto an Excalidraw canvas, Excalidraw renders
		// the same `rect=` crop natively and binds the link to the image element.
		const embed = "!" + this.app.fileManager.generateMarkdownLink(file, "", subpath);

		await navigator.clipboard.writeText(embed);
		new Notice(`已复制区域链接:\n${embed}`);
	}
}
