# PDF Bilink

Minimal bidirectional linking between PDF regions and notes, for people who only
need a small slice of what PDF++ offers.

- Draw a rectangular selection on a PDF page → get a link. Paste it anywhere.
  - In a note: renders as a live cropped preview (nothing saved to disk, re-crops
    on the fly from the PDF each time).
  - On an Excalidraw canvas: Excalidraw renders the same `rect=` crop natively and
    binds the link to the image element.
- Click that preview (or the highlighted region on the PDF) to jump back and forth.
  One reference jumps directly; multiple references show a picker.
- Text selections use Obsidian's native `selection=` links — this plugin only adds
  the reverse direction (a highlight on the PDF page, click to jump to the note).
- Freeform text boxes can be placed directly on a PDF page — draggable, resizable,
  colorable — stored in the plugin's own data, not written into the PDF file.
- Highlighted regions can be edited in place (drag to move/resize, writes the new
  coordinates back into every note that references it) or deleted everywhere at once.

## Why

PDF++ does all of this and much more. This plugin exists for a narrower need:
just the region/selection ↔ note round-trip, without the rest of PDF++'s surface
area (color coding, annotations, page composer, etc).

## Install

Not on the community plugin list. Clone or use BRAT:

```
Heptazero/obsidian-pdf-bilink
```

## Develop

```
npm install
npm run dev    # esbuild watch, builds main.js in place
```

Drop the folder into `<vault>/.obsidian/plugins/pdf-bilink` and enable it.
