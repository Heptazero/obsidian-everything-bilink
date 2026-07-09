import { TFile, parseLinktext, type Plugin } from "obsidian";
import { renderRectToDataUrl } from "./render-image";
import { LINK_PARAM, parseBilinkSubpath } from "./subpath";

/**
 * Auto-inserts a live-rendered preview image right after any plain internal link
 * carrying a bilinkrect= subpath, in Markdown Reading View. Does NOT touch
 * Obsidian's embed pipeline (no `![[...]]` override, no `embedRegistry` patch) —
 * links stay plain `[[...]]` links; this only decorates what's already rendered,
 * so there's no risk of fighting another plugin's embed handling for .pdf files.
 */
export function registerRectPreview(plugin: Plugin): void {
	const cache = new Map<string, Promise<string | null>>();

	plugin.registerEvent(
		plugin.app.vault.on("modify", (file) => {
			if (!(file instanceof TFile)) return;
			for (const key of cache.keys()) {
				if (key.startsWith(`${file.path}:`)) cache.delete(key);
			}
		})
	);

	plugin.registerMarkdownPostProcessor((el, ctx) => {
		el.querySelectorAll<HTMLAnchorElement>("a.internal-link").forEach((a) => {
			if (a.dataset.pdfBilinkPreview) return;

			const href = a.getAttribute("data-href") ?? a.getAttribute("href");
			if (!href?.includes(`${LINK_PARAM}=`)) return;

			const { path, subpath } = parseLinktext(href);
			if (!subpath) return;
			const parsed = parseBilinkSubpath(subpath);
			if (!parsed) return;

			const file = plugin.app.metadataCache.getFirstLinkpathDest(path, ctx.sourcePath);
			if (!(file instanceof TFile) || file.extension !== "pdf") return;

			a.dataset.pdfBilinkPreview = "1";

			const key = `${file.path}:${parsed.page}:${parsed.rect.join(",")}`;
			let promise = cache.get(key);
			if (!promise) {
				promise = renderRectToDataUrl(plugin.app, file, parsed.page, parsed.rect);
				cache.set(key, promise);
			}

			const img = document.createElement("img");
			img.className = "pdf-bilink-preview-img";
			a.insertAdjacentElement("afterend", img);

			promise.then((dataUrl) => {
				if (dataUrl) img.src = dataUrl;
				else img.remove();
			});
		});
	});
}
