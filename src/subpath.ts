import type { PdfRect } from "./pdf-layer";

// We use the plain `rect=x0,y0,x1,y1` subpath (4 integers, PDF points) rather than
// a custom param. This is the format the Excalidraw plugin natively recognizes and
// renders as a cropped-image element with the source link auto-bound — so a single
// embed works both in notes (rendered by this plugin) and on an Excalidraw canvas
// (rendered by Excalidraw itself). It is also PDF++'s format; safe here because PDF++
// is not enabled in this vault. If PDF++ is ever re-enabled, the two would both try
// to handle these links.
export const LINK_PARAM = "rect";

export interface ParsedBilink {
	page: number;
	rect: PdfRect;
}

export function buildSubpath(page: number, rect: PdfRect): string {
	const coords = rect.map((n) => Math.round(n)).join(",");
	return `#page=${page}&${LINK_PARAM}=${coords}`;
}

export function parseBilinkSubpath(subpath: string): ParsedBilink | null {
	const params = new URLSearchParams(subpath.replace(/^#/, ""));
	const pageStr = params.get("page");
	const rectStr = params.get(LINK_PARAM);
	if (!pageStr || !rectStr) return null;

	const page = parseInt(pageStr, 10);
	const match = rectStr.match(/^(-?[\d.]+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)$/);
	if (!match || Number.isNaN(page)) return null;

	const rect = match.slice(1, 5).map(Number) as PdfRect;
	return { page, rect };
}
