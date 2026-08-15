# Everything Bilink

Bidirectional referencing, for two different carriers: PDF regions/selections,
and note blocks. Same idea both times — reference something, jump back and forth
— for people who only need that slice, not a full annotation suite.

## PDF ↔ note

- Draw a rectangular selection on a PDF page → get a link. Paste it anywhere.
  - In a note: renders as a live cropped preview (nothing saved to disk, re-crops
    on the fly from the PDF each time).
  - On an Excalidraw canvas: Excalidraw renders the same `rect=` crop natively and
    binds the link to the image element.
- Click that preview (or the highlighted region on the PDF) to jump back and forth.
  One reference jumps directly; multiple references show a picker.
- Text selections use Obsidian's native `selection=` links — this plugin only adds
  the reverse direction (a mark on the PDF page, click to jump to the note).
  Copy a selection with the text inline, as a blockquote, or as the jump link
  alone. The link-only form is the dependable one when a selection crosses a
  formula: PDF formulas usually aren't in the text layer at all, so no amount of
  copying reproduces them.
- Any bookmarks the PDF ships with can be copied out as a nested Markdown list,
  each line linking to the page it jumps to.
- Freeform text boxes can be placed directly on a PDF page — draggable, resizable,
  colorable — stored in the plugin's own data, not written into the PDF file.
- Highlighted regions can be edited in place (drag to move/resize, writes the new
  coordinates back into every note that references it) or deleted everywhere at once.

## Note ↔ note

- Select text in any note → copy it as a block reference (`[[note#^id|selected
  text]]`). Obsidian's native block references are the finest built-in granularity
  (no character-level addressing outside PDF.js), so navigation lands on the whole
  block; the link's title preserves exactly what was selected.
- The `^id` marker is only written after the copy actually succeeds — a failed
  copy leaves the note untouched.
- A cleanup command scans a note for `^id` markers nothing in the vault links to
  anymore, and offers to strip them.

## Settings

- Marks on the page can be an underline, a background highlight, or a box, with a
  configurable color, thickness, and vertical offset — a text selection's box
  spans the whole line height, so where the underline sits relative to the letters
  is a matter of taste and font.
- Every copy command's output is a template over `{{text}}`, `{{link}}`,
  `{{file}}`, `{{page}}` (`\n` for a line break), and the link's own label — the
  `↗` — is configurable too.

## Why

PDF++ does all of the PDF side and much more. This plugin exists for a narrower
need: just the region/selection ↔ note round-trip, without the rest of its surface
area (color coding, annotations, page composer, etc).

## Install

Not on the community plugin list. Clone or use BRAT:

```
Heptazero/obsidian-everything-bilink
```

## Develop

```
npm install
npm run dev    # esbuild watch, builds main.js in place
```

Drop the folder into `<vault>/.obsidian/plugins/everything-bilink` and enable it.
