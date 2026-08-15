import { App, Component, debounce, normalizePath, type Plugin } from "obsidian";
import { getOverlayLayer, placeRect, screenToPdfPoint, type PdfRect } from "./pdf-layer";
import type { PDFPageView } from "./pdfjs-types";
import { patchPluginData } from "./settings";

export interface TextBoxAnnotation {
	id: string;
	page: number;
	/** [x0, y0, x1, y1] in PDF points (origin bottom-left). */
	rect: PdfRect;
	/** Font size in PDF points (scaled to the current zoom at render time). */
	fontSize: number;
	/** CSS text color; defaults to a dark ink readable on white pages. */
	color?: string;
	text: string;
	createdAt: number;
	updatedAt: number;
}

interface PluginData {
	version: 1;
	pdfTextBoxes: Record<string, TextBoxAnnotation[]>;
}

const DEFAULT_DATA: PluginData = { version: 1, pdfTextBoxes: {} };
const DEFAULT_WIDTH_PT = 160;
const DEFAULT_HEIGHT_PT = 40;
const DEFAULT_FONT_PT = 12;
const DEFAULT_COLOR = "#1f1f1f";

/** Owns the persisted text-box data and debounced saving. */
export class TextBoxStore {
	private data: PluginData = { ...DEFAULT_DATA };
	// Merges onto whatever is on disk instead of overwriting the file, so saving a
	// text box can't drop the settings block that lives alongside it in data.json.
	private save = debounce(
		() => void patchPluginData(this.plugin, { version: 1, pdfTextBoxes: this.data.pdfTextBoxes }),
		500,
		true
	);

	constructor(private plugin: Plugin) {}

	async load(): Promise<void> {
		const loaded = (await this.plugin.loadData()) as Partial<PluginData> | null;
		this.data = { version: 1, pdfTextBoxes: loaded?.pdfTextBoxes ?? {} };
	}

	private key(pdfPath: string): string {
		return normalizePath(pdfPath);
	}

	boxesFor(pdfPath: string, page: number): TextBoxAnnotation[] {
		return (this.data.pdfTextBoxes[this.key(pdfPath)] ?? []).filter((b) => b.page === page);
	}

	upsert(pdfPath: string, box: TextBoxAnnotation): void {
		const key = this.key(pdfPath);
		const list = (this.data.pdfTextBoxes[key] ??= []);
		const idx = list.findIndex((b) => b.id === box.id);
		if (idx >= 0) list[idx] = box;
		else list.push(box);
		this.save();
	}

	remove(pdfPath: string, id: string): void {
		const key = this.key(pdfPath);
		const list = this.data.pdfTextBoxes[key];
		if (!list) return;
		this.data.pdfTextBoxes[key] = list.filter((b) => b.id !== id);
		this.save();
	}
}

function applyFontSize(el: HTMLElement, fontSizePt: number, pageView: PDFPageView): void {
	const [, y0, , y1] = pageView.pdfPage.view;
	const pageHeight = y1 - y0;
	// cqh = 1% of the overlay layer's height; the layer tracks the page's rendered
	// height, so a font expressed this way scales with zoom automatically.
	el.style.fontSize = `${(fontSizePt / pageHeight) * 100}cqh`;
}

/** Builds one text box's DOM + move/resize/edit/delete interactions inside `layer`. */
function createTextBoxEl(
	app: App,
	pageView: PDFPageView,
	layer: HTMLElement,
	pdfPath: string,
	store: TextBoxStore,
	box: TextBoxAnnotation,
	autoFocus: boolean
): HTMLElement {
	const el = layer.createDiv("pdf-bilink-textbox");
	el.dataset.boxId = box.id;

	const content = el.createDiv("pdf-bilink-textbox-content");
	content.contentEditable = "true";
	content.setText(box.text);
	content.style.color = box.color ?? DEFAULT_COLOR;
	applyFontSize(content, box.fontSize, pageView);

	const toolbar = el.createDiv("pdf-bilink-textbox-toolbar");
	const grip = toolbar.createSpan({ cls: "pdf-bilink-textbox-grip", text: "⠿" });
	const smaller = toolbar.createEl("button", { text: "A−" });
	const larger = toolbar.createEl("button", { text: "A+" });
	const colorInput = toolbar.createEl("input", { cls: "pdf-bilink-textbox-color" });
	colorInput.type = "color";
	colorInput.value = box.color ?? DEFAULT_COLOR;
	const del = toolbar.createEl("button", { text: "×", cls: "pdf-bilink-textbox-del" });

	const resize = el.createDiv("pdf-bilink-textbox-resize");

	placeRect(pageView, layer, box.rect, el);

	const commit = () => {
		box.updatedAt = Date.now();
		store.upsert(pdfPath, box);
	};

	const commitGeometry = () => {
		const r = el.getBoundingClientRect();
		const [x0, y0] = screenToPdfPoint(pageView, r.left, r.bottom);
		const [x1, y1] = screenToPdfPoint(pageView, r.right, r.top);
		box.rect = [x0, y0, x1, y1];
		el.style.width = "";
		el.style.height = "";
		placeRect(pageView, layer, box.rect, el);
		commit();
	};

	// Text editing.
	content.addEventListener("blur", () => {
		if (content.innerText !== box.text) {
			box.text = content.innerText;
			commit();
		}
	});

	// Font size.
	const changeFont = (delta: number) => {
		box.fontSize = Math.max(4, Math.min(200, box.fontSize + delta));
		applyFontSize(content, box.fontSize, pageView);
		commit();
	};
	smaller.addEventListener("click", (e) => {
		e.preventDefault();
		changeFont(-2);
	});
	larger.addEventListener("click", (e) => {
		e.preventDefault();
		changeFont(2);
	});

	// Color.
	colorInput.addEventListener("click", (e) => e.stopPropagation());
	colorInput.addEventListener("input", () => {
		box.color = colorInput.value;
		content.style.color = colorInput.value;
		commit();
	});

	// Delete.
	del.addEventListener("click", (e) => {
		e.preventDefault();
		store.remove(pdfPath, box.id);
		el.remove();
	});

	// Move (drag the grip). Freeze size to px during drag, restore % on release.
	grip.addEventListener("pointerdown", (ev) => {
		ev.preventDefault();
		ev.stopPropagation();
		const layerRect = layer.getBoundingClientRect();
		const elRect = el.getBoundingClientRect();
		const origLeft = elRect.left - layerRect.left;
		const origTop = elRect.top - layerRect.top;
		el.style.width = `${elRect.width}px`;
		el.style.height = `${elRect.height}px`;
		const onMove = (m: PointerEvent) => {
			el.style.left = `${origLeft + (m.clientX - ev.clientX)}px`;
			el.style.top = `${origTop + (m.clientY - ev.clientY)}px`;
		};
		const onUp = () => {
			window.removeEventListener("pointermove", onMove);
			commitGeometry();
		};
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp, { once: true });
	});

	// Resize (drag bottom-right handle).
	resize.addEventListener("pointerdown", (ev) => {
		ev.preventDefault();
		ev.stopPropagation();
		const elRect = el.getBoundingClientRect();
		const layerRect = layer.getBoundingClientRect();
		el.style.left = `${elRect.left - layerRect.left}px`;
		el.style.top = `${elRect.top - layerRect.top}px`;
		const onMove = (m: PointerEvent) => {
			el.style.width = `${Math.max(24, elRect.width + (m.clientX - ev.clientX))}px`;
			el.style.height = `${Math.max(16, elRect.height + (m.clientY - ev.clientY))}px`;
		};
		const onUp = () => {
			window.removeEventListener("pointermove", onMove);
			commitGeometry();
		};
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp, { once: true });
	});

	if (autoFocus) {
		window.setTimeout(() => {
			content.focus();
			const sel = window.getSelection();
			if (sel) sel.selectAllChildren(content);
		}, 0);
	}

	return el;
}

/**
 * Draws all saved text boxes for one page. Safe to call on every page render:
 * if boxes are already present in the layer it does nothing (so it won't clobber
 * an in-progress edit), and it rebuilds only after pdf.js has wiped the layer
 * (e.g. on zoom/scroll re-render) — which is what previously made boxes vanish.
 */
export function renderTextBoxes(
	app: App,
	pageView: PDFPageView,
	pdfPath: string,
	pageNumber: number,
	store: TextBoxStore
): void {
	const layer = getOverlayLayer(pageView);
	if (layer.querySelector(":scope > .pdf-bilink-textbox")) return;
	for (const box of store.boxesFor(pdfPath, pageNumber)) {
		createTextBoxEl(app, pageView, layer, pdfPath, store, box, false);
	}
}

/** Creates a new text box at a click point and immediately focuses it for typing. */
export function placeNewTextBox(
	app: App,
	pageView: PDFPageView,
	pdfPath: string,
	pageNumber: number,
	store: TextBoxStore,
	clientX: number,
	clientY: number
): void {
	const [cx, cy] = screenToPdfPoint(pageView, clientX, clientY);
	const box: TextBoxAnnotation = {
		id: `tb-${Date.now()}-${Math.floor(Math.random() * 1e4)}`,
		page: pageNumber,
		rect: [cx, cy - DEFAULT_HEIGHT_PT, cx + DEFAULT_WIDTH_PT, cy],
		fontSize: DEFAULT_FONT_PT,
		text: "",
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};
	store.upsert(pdfPath, box);
	const layer = getOverlayLayer(pageView);
	createTextBoxEl(app, pageView, layer, pdfPath, store, box, true);
}

/** One-shot arm/disarm state for the "place a text box" tool. */
export interface TextPlaceController {
	armed: boolean;
}

export function attachTextPlaceListener(
	pageView: PDFPageView,
	controller: TextPlaceController,
	onPlace: (clientX: number, clientY: number) => void
): () => void {
	const onPointerDown = (ev: PointerEvent) => {
		if (!controller.armed) return;
		if (ev.button !== 0) return;
		ev.preventDefault();
		ev.stopPropagation();
		controller.armed = false;
		onPlace(ev.clientX, ev.clientY);
	};
	pageView.div.addEventListener("pointerdown", onPointerDown, true);
	return () => pageView.div.removeEventListener("pointerdown", onPointerDown, true);
}
