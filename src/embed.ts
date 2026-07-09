import { App, Component, TFile } from "obsidian";
import { renderRectToDataUrl } from "./render-image";
import { buildSubpath, LINK_PARAM, parseBilinkSubpath, type ParsedBilink } from "./subpath";

// Obsidian's embed registry is an undocumented internal. All access to it is
// confined to THIS file (the adapter boundary) so the rest of the plugin never
// touches internals directly.
interface EmbedContext {
	app: App;
	containerEl: HTMLElement;
	sourcePath: string;
}
type EmbedCreator = (ctx: EmbedContext, file: TFile, subpath?: string) => Component;

/**
 * Renders a `![[pdf#page=N&bilinkrect=...]]` embed as a live cropped image of that
 * region, in both Live Preview and Reading View (unlike a markdown post-processor,
 * which only fires in Reading View). Image is rendered in memory (no file saved);
 * clicking it navigates to the PDF region via the same openLinkText patch used for
 * plain links.
 */
class RectEmbed extends Component {
	constructor(
		private app: App,
		private ctx: EmbedContext,
		private file: TFile,
		private parsed: ParsedBilink
	) {
		super();
	}

	async loadFile(): Promise<void> {
		const { containerEl } = this.ctx;
		containerEl.empty();
		containerEl.addClass("pdf-bilink-embed");

		const img = containerEl.createEl("img", { cls: "pdf-bilink-embed-img" });
		const linktext = this.file.path + buildSubpath(this.parsed.page, this.parsed.rect);
		img.addEventListener("click", (ev) => {
			ev.preventDefault();
			ev.stopPropagation();
			this.app.workspace.openLinkText(linktext, this.ctx.sourcePath, false);
		});

		const url = await renderRectToDataUrl(this.app, this.file, this.parsed.page, this.parsed.rect);
		if (url) {
			img.src = url;
		} else {
			containerEl.setText("⚠ PDF Bilink: 无法渲染该区域(先打开一次任意 PDF 让 pdf.js 加载,再刷新)");
		}
	}
}

export function registerRectEmbed(plugin: { app: App; register: (cb: () => void) => void }): void {
	const registry = (plugin.app as unknown as { embedRegistry?: { embedByExtension?: Record<string, EmbedCreator> } })
		.embedRegistry;
	if (!registry?.embedByExtension) {
		console.warn("pdf-bilink: app.embedRegistry unavailable — embed preview disabled.");
		return;
	}

	const original: EmbedCreator | undefined = registry.embedByExtension["pdf"];

	registry.embedByExtension["pdf"] = ((ctx, file, subpath) => {
		if (subpath && subpath.includes(`${LINK_PARAM}=`)) {
			const normalized = subpath.startsWith("#") ? subpath : `#${subpath}`;
			const parsed = parseBilinkSubpath(normalized);
			if (parsed) return new RectEmbed(plugin.app, ctx, file, parsed);
		}
		// Every other PDF embed falls through to Obsidian's own creator untouched.
		if (original) return original(ctx, file, subpath);
		return new Component();
	}) as EmbedCreator;

	plugin.register(() => {
		if (original) registry.embedByExtension!["pdf"] = original;
		else delete registry.embedByExtension!["pdf"];
	});
}
