import { around } from "monkey-around";
import { App, Component, FileView, TFile, Workspace, parseLinktext } from "obsidian";
import { getOverlayLayer, onPageReady, placeRect, type PdfRect } from "./pdf-layer";
import { LINK_PARAM, parseBilinkSubpath } from "./subpath";

export { buildSubpath, LINK_PARAM } from "./subpath";

function findExistingPdfLeaf(app: App, file: TFile) {
	for (const leaf of app.workspace.getLeavesOfType("pdf")) {
		const view = leaf.view as FileView;
		if (view.file?.path === file.path) return leaf;
	}
	return null;
}

/**
 * Flashes a highlight over `rect` on `page` once it renders, then scrolls it into
 * view. Does NOT handle the page-level jump — that's left to Obsidian's own native
 * `page=` subpath handling (already correct; only the exact-rect part is missing).
 */
function flashRect(plugin: { addChild: Component["addChild"] }, view: FileView, page: number, rect: PdfRect): void {
	const component = new Component();
	plugin.addChild(component);

	onPageReady(view, component, (pageNumber, pageView) => {
		if (pageNumber !== page) return;
		// Guard against acting on a not-yet-fully-initialized page stub (pdf.js
		// creates page view objects before their content/geometry is ready).
		if (!pageView.pdfPage?.view) return;

		component.unload();

		const layer = getOverlayLayer(pageView);
		const box = layer.createDiv("pdf-bilink-flash-highlight");
		placeRect(pageView, layer, rect, box);
		box.scrollIntoView({ block: "center", inline: "center" });

		setTimeout(() => box.addClass("pdf-bilink-fade-out"), 1200);
		setTimeout(() => box.remove(), 1600);
	});
}

/**
 * Patches Workspace.prototype.openLinkText (a public, stable API) so that links
 * carrying our custom `bilinkrect=` subpath reuse an already-open leaf for that PDF
 * instead of always spawning a new pane (mirrors PDF++'s singleTabForSinglePDF
 * technique), then refines the native page-level jump down to the exact rect.
 * Falls through to default behavior for every other link.
 */
export function registerLinkOpenPatch(plugin: {
	app: App;
	register: Component["register"];
	addChild: Component["addChild"];
}): void {
	plugin.register(
		around(Workspace.prototype, {
			openLinkText(old) {
				return function (
					this: Workspace,
					linktext: string,
					sourcePath: string,
					newLeaf?: boolean,
					openViewState?: Record<string, unknown>
				) {
					const { path, subpath } = parseLinktext(linktext);
					const handled = subpath?.includes(`${LINK_PARAM}=`)
						? (() => {
								const file = plugin.app.metadataCache.getFirstLinkpathDest(path, sourcePath ?? "");
								if (!(file instanceof TFile) || file.extension !== "pdf") return null;
								const parsed = parseBilinkSubpath(subpath!);
								if (!parsed) return null;
								return { file, parsed };
							})()
						: null;

					if (!handled) {
						return old.call(this, linktext, sourcePath, newLeaf, openViewState);
					}

					const { file, parsed } = handled;
					return (async () => {
						const existing = findExistingPdfLeaf(plugin.app, file);
						let leaf = existing;
						if (existing && !newLeaf) {
							// WorkspaceLeaf has no public openLinkText; openFile + eState.subpath
							// is the same mechanism Workspace.openLinkText uses internally to
							// drive a FileView's native page-jump (confirmed by the page-level
							// jump already working via the default openLinkText path).
							await existing.openFile(file, { eState: { subpath } });
							plugin.app.workspace.revealLeaf(existing);
						} else {
							await old.call(this, linktext, sourcePath, newLeaf, openViewState);
							leaf = findExistingPdfLeaf(plugin.app, file) ?? plugin.app.workspace.getMostRecentLeaf();
						}
						if (leaf) flashRect(plugin, leaf.view as FileView, parsed.page, parsed.rect);
					})();
				};
			},
		})
	);
}
