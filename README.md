# Pebble

A tiny drag-and-drop website builder that publishes **plain static HTML**, so a
site can be hosted for free on GitHub Pages. It has no database: **the HTML
files are the database.**

This repo is the prototype foundation: a Gridstack-powered editor, Text and
Photo blocks, and the two functions that turn the editor into static HTML and
back again.

```
index.html          ← an example published page (also the page the editor opens)
site.css            ← the stylesheet of the PUBLISHED site (shared with the editor)
editor/
  index.html        ← the editor UI
  editor.css        ← editor-only styling (toolbars, outlines, dialogs)
  engine.js         ← core engine: widgets, serialize, deserialize, autosave, UI
```

## Run it

The editor fetches `../index.html`, so serve the folder over HTTP rather than
opening the file directly:

```bash
python -m http.server 8080
```

Then open <http://localhost:8080/editor/>. (Opened from disk, it still works but
starts from a small built-in example page.)

---

## 1. UX strategy: designed for someone who has never made a website

The person we design for is a 50-year-old starting a hobby blog. She has never
heard of HTML, Git or a repository, and she shouldn't have to. Every decision
comes from one question: *would she understand this without being told?*

| Principle | How it shows up |
|---|---|
| **Use everyday words** | "Box", "Photo", "Big title", "Publish". The UI never says *widget*, *block*, *grid*, *commit* or *deploy*. |
| **One obvious main action** | A single big green **🚀 Publish** button. Everything else is visually quieter. |
| **She never "saves"** | Work autosaves after every change, and a calm "✓ All changes saved" reassures her. Closing the tab loses nothing. |
| **What you see is what visitors get** | The canvas is a sheet of "paper" exactly as wide as the live site, and the editor loads the *same* `site.css` the live site uses. **👀 Preview** shows the real exported HTML at computer or phone size. |
| **Tools appear where she is looking** | The "✥ Move" and "🗑 Remove" buttons and the resize corner only show on the box under her mouse. The text style bar lights up once she clicks into text and stays greyed out (with a hint) until then. |
| **Two ways to do everything** | Drag a tile onto the page *or* just click it. Click the photo box *or* drag a photo file from the desktop onto it. |
| **Moving and typing never fight** | Only the labelled "✥ Move" handle drags a box, so clicking into text to type never moves it by accident. |
| **Mistakes are cheap** | Removing a box shows "Box removed. **Undo**" rather than a scary confirmation dialog. |
| **Nothing breaks the page** | Pasted text arrives as plain text, so no Word or website junk sneaks in. Photos are shrunk automatically. Text styles are limited to a few that always look good together. |
| **Hide the plumbing** | Opening or downloading raw files is tucked under "More options" for the rare times it's needed. |

## 2. Architecture: the HTML is the database

```
   ┌──────────────┐   serializeToStaticHTML()   ┌─────────────────────────┐
   │  Gridstack   │ ──────────────────────────▶ │  clean static HTML       │
   │  editor DOM  │                             │  <section data-gs-x="0"…>│ ──▶ GitHub repo ──▶ GitHub Pages
   │ (live state) │ ◀────────────────────────── │                          │
   └──────────────┘  deserializeToEditor(html)  └─────────────────────────┘
```

Both directions go through one small, plain **page model**:

```js
{ title: "My Garden Diary",
  blocks: [ { type: "text",  x: 0, y: 0, w: 12, h: 2, data: { html: "<h2>Welcome</h2>…" } },
            { type: "image", x: 0, y: 2, w: 7,  h: 6, data: { src: "…", caption: "…" } } ] }
```

### What a published block looks like

```html
<section class="block block--text"
         data-widget-type="text"
         data-gs-x="0" data-gs-y="0" data-gs-w="12" data-gs-h="2"
         style="grid-column:1 / span 12;grid-row:1 / span 2">
  <div class="block__content"><h2>Welcome to my garden diary</h2><p>…</p></div>
</section>
```

- **`data-widget-type` and `data-gs-*`** are the "database": everything the
  editor needs to rebuild the page exactly.
- **`style="grid-column…; grid-row…"`** is the same position written as native
  CSS Grid placement, so the live site needs **no JavaScript at all**.
- **`site.css`** collapses everything to a single column under 720px. Blocks are
  written top-to-bottom, then left-to-right, so the order in the file is also
  the natural reading order on a phone.
- Row sizes are matched: the editor uses 70px rows with an 8px margin, and the
  site uses 54px rows with a 16px gap. Either way, a box of height *h* is
  `70·h − 16` px tall. Static rows use `minmax(54px, auto)`, so text can grow on
  narrower screens instead of being cut off.

### Serialization: `serializeToStaticHTML(options?)`

1. Reads every Gridstack item (position from `gridstackNode`, content via the
   widget's `readData`).
2. Sorts the blocks into reading order.
3. Asks each widget for its clean static markup (`renderStatic`).
4. Writes a complete HTML document. All editor-only markup is left out:
   Gridstack classes, `gs-*` attributes, resize handles, Move/Remove bars,
   `contenteditable`, inputs and placeholders.

### Deserialization: `deserializeToEditor(htmlString)`

1. Parses the file with `DOMParser`. The parsed document is inert, so scripts
   in it never run.
2. Finds `[data-pebble-grid] > [data-widget-type]`, and falls back to any
   `[data-widget-type]` for fragments.
3. Reads and clamps `data-gs-x/y/w/h`, so a hand-edited file can't break the
   grid.
4. Asks each widget to read its content back (`parseStatic`), re-sanitizing it.
5. Rebuilds the Gridstack canvas inside a single `batchUpdate()`.

The prototype checks this round trip: opening the example `index.html` and
serializing it again gives back **byte-identical** HTML.

### Widget registry

Each block type is one entry in `WIDGETS` (in `engine.js`) with five
functions: `defaultData`, `createEditor`, `readData`, `renderStatic` and
`parseStatic`. Adding a Video, Map or Button block means adding one entry.
Serialization and deserialization don't change.

### Safety

Content comes from files and from pasting, so:

- rich text goes through an **allow-list sanitizer** that keeps `p`, `h2`, `h3`,
  `strong`, `em`, `u`, `ul`, `ol`, `li`, `a`, `blockquote` and `br`. Every
  attribute except a safe `href` is stripped, and `<script>`, `<iframe>` and
  similar tags are dropped entirely;
- URLs are checked: no `javascript:` links, and images may only be http(s),
  relative or `data:image/…`;
- photo captions are plain text and always escaped.

### Autosave

Each change is debounced and stored in `localStorage` in **the same HTML
format** that gets published, so reopening the editor also runs
`deserializeToEditor()`. If there is no draft, the editor opens the published
`index.html`.

## 3. Publish (prototype)

**Publish** logs the final HTML to the browser console (look for
`Pebble ▸ Published HTML`). The API is also exposed for experiments:

```js
Pebble.serializeToStaticHTML()        // → full HTML string
Pebble.deserializeToEditor(html)      // → loads it into the editor
Pebble.getPageModel()                 // → plain JSON page model
```

## Next steps toward the real app

- **GitHub publishing:** sign in with GitHub (OAuth or device flow), then
  `PUT /repos/{owner}/{repo}/contents/index.html` with the serialized HTML.
  Pages rebuilds automatically.
- **Photos as files:** photos are currently embedded as `data:` URLs to keep
  the prototype self-contained. The real app should commit them as
  `images/…jpg` next to the page and reference them by path.
- **Multiple pages and a blog post list:** each post is just another HTML file
  in the same format, plus a generated index page.
- **Undo/redo history**, more block types (video, divider, button) and a few
  site-wide themes (colour and font presets that only change `site.css`
  variables).
- **Mobile editing:** the editor is designed for a computer. On small screens it
  still works, but the layout is cramped.

Built with [Gridstack.js](https://gridstackjs.com/) 10.3.1 (MIT).
