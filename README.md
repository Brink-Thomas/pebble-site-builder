# Pebble

A tiny drag-and-drop website builder that publishes **plain static HTML**, so a
site can be hosted for free on GitHub Pages. It has no database: **the HTML
files are the database.**

Pebble is a **central editor web app**. Each user's website lives in their own
GitHub repository, which holds nothing but the published pages and one
stylesheet. The editor reads those files through the GitHub API, turns them
into an editable canvas, and commits the changes back.

```
index.html               ← landing page: redirects to the editor
editor/                  ← THE PEBBLE APP (hosted once, for everyone)
  index.html             ← editor UI
  editor.css             ← editor-only styling (toolbars, outlines, dialogs)
  github-service.js      ← GitHubService: the only code that talks to a user's repo (mock)
  engine.js              ← widgets, page format, multi-page store, Gridstack, publish
example-site/            ← WHAT A USER'S REPOSITORY CONTAINS
  index.html  about.html  contact.html
  site.css               ← the site's theme (the editor loads it too)
```

`example-site/` also seeds the demo repository on first run, and it is a real,
working website: <https://thomasbrink.be/pebble-site-builder/example-site/>

## Run it

```bash
python -m http.server 8080
```

Then open <http://localhost:8080/editor/>. It has to be served over HTTP
(`localhost` or `https`): the mock repository seeds itself by fetching
`example-site/` and computes git SHAs with `crypto.subtle`. To start over, use
**More options → Reset the demo website**.

---

## 1. UX strategy: designed for someone who has never made a website

The person we design for is a 50-year-old starting a hobby blog. She has never
heard of HTML, Git or a repository, and she shouldn't have to. Every decision
comes from one question: *would she understand this without being told?*

| Principle | How it shows up |
|---|---|
| **Use everyday words** | "Box", "Photo", "Page", "Big title", "Publish". The UI never says *widget*, *grid*, *file*, *commit* or *deploy*. |
| **One button puts everything live** | A single green **🚀 Publish** updates the whole website: every changed page, new pages, and the menu on all pages. She never publishes page by page. |
| **She never "saves"** | Edits are kept automatically as drafts in her browser, per page. The status says either "✓ Saved · not published yet" or "✓ Everything is published". |
| **Pages are a simple list** | "Your pages" in the sidebar: 🏠 Home, 📄 About me… A **New** badge marks a page that isn't on the website yet, and an orange dot marks unpublished changes. **＋ Add a new page** asks only for a name and shows the web address it will get. |
| **What you see is what visitors get** | The canvas shows the site's real header and menu (clicking a menu item opens that page), uses the site's own `site.css`, and is exactly as wide as the live page. The block layout is pixel-identical. **👀 Preview** shows the real exported HTML at computer or phone size, and its menu links work. |
| **Things stay where she puts them** | Free-form layout: a box dropped low on the page stays there, with empty space above it. Faint row lines show it's a canvas, and the full grid appears while she drags. |
| **Tools appear where she is looking** | "✥ Move", "🗑 Remove" and the resize corner show only on the box under her mouse. The text style bar lights up once she clicks into text. |
| **Two ways to do everything** | Drag a tile onto the page or just click it. Click the photo box or drop a photo file onto it. Switch pages from the sidebar or from the menu on the page. |
| **Mistakes are cheap** | Removing a box shows "Box removed. **Undo**", and the box comes back in exactly the same spot. |
| **Hide the plumbing** | Repository names, file downloads and the demo reset are tucked under "More options". |

## 2. Architecture

### The editor is the controller; the repo is just files

```
 user's GitHub repo                      Pebble editor (central app)
 ──────────────────                      ───────────────────────────
 index.html ─┐                           ┌─ store: pages + drafts + site name
 about.html  │   GitHubService           │
 contact.html├── fetchSiteFiles() ─────▶ │  htmlToPageModel()  ──▶ Gridstack canvas
 site.css   ─┘   fetchPage(file)         │
       ▲                                 │
       └──────── commitPage(file, html) ─┘  pageModelToHtml()  ◀── Gridstack canvas
                       │
                       ▼
                 GitHub Pages rebuilds  →  https://{owner}.github.io/{repo}/
```

### `GitHubService` (`editor/github-service.js`, mocked)

| Method | Real GitHub REST call it stands in for |
|---|---|
| `fetchSiteFiles()` | `GET /repos/{owner}/{repo}/contents/?ref={branch}` |
| `fetchFile(path)` / `fetchPage(file)` | `GET /repos/{owner}/{repo}/contents/{path}` (base64 → text) |
| `commitPage(file, html, {message, sha})` | `PUT /repos/{owner}/{repo}/contents/{file}` with `{message, content: base64, sha, branch}` |

The mock keeps a fake repository in `localStorage`, seeded from
`example-site/`. It returns data shaped like the real API, and it behaves like
GitHub where the editor depends on it:

- every file carries a real **git blob SHA**;
- updating a file requires the SHA you last read, otherwise it throws a
  **409 Conflict**, which is how GitHub stops two browser tabs from overwriting
  each other;
- calls take a small, randomized network delay.

To make it real, replace the method bodies with `fetch()` calls to
`api.github.com`. The UTF-8-safe `toBase64` and `fromBase64` helpers are
already there. Sign-in could use GitHub OAuth or the device flow. The editor
doesn't change.

### Two plain data shapes

```js
// Page model: one page's content
{ file: "about.html", name: "About me",
  blocks: [ { type: "text", x: 2, y: 0, w: 8, h: 4, data: { html: "<h2>About me</h2>…" } } ] }

// Site context: shared by every page (header + menu)
{ siteName: "My Garden Diary",
  pages: [ { file: "index.html", name: "Home" }, { file: "about.html", name: "About me" } ] }
```

`pageModelToHtml(page, site)` and `htmlToPageModel(html, file)` are pure
functions that convert between these shapes and HTML. On top of them:

- `serializeToStaticHTML()` = `pageModelToHtml(getPageModel(), siteContext())`
- `deserializeToEditor(html)` = `loadPageModel(htmlToPageModel(html))`

### What a published page looks like

```html
<header class="site-header">
  <a class="site-name" href="index.html">My Garden Diary</a>
  <nav class="site-nav" aria-label="Pages">
    <a href="index.html">Home</a>
    <a href="about.html" aria-current="page">About me</a>
  </nav>
</header>

<main class="site-grid" data-pebble-grid data-columns="12" data-page-name="About me">
  <section class="block block--text"
           data-widget-type="text" data-gs-x="2" data-gs-y="6" data-gs-w="8" data-gs-h="3"
           style="grid-column:3 / span 8;grid-row:7 / span 3">
    <div class="block__content"><h3>Why I started this blog</h3>…</div>
  </section>
</main>
```

Everything the editor needs is in the HTML itself:

| Information | Where it lives |
|---|---|
| block type and position | `data-widget-type`, `data-gs-x/y/w/h` |
| page name | `data-page-name` on `<main>` (also used in `<title>`) |
| site name | `.site-name` in `index.html`'s header |
| list and order of pages | the files in the repo, ordered by `index.html`'s menu |

### Multi-page state

The store keeps one entry per page:

```js
{ file: "about.html",
  remote: { html, sha } | null,  // last version known to be in the repo (null = brand-new page)
  draft:  "<html…>"     | null } // unpublished edits, saved in localStorage
```

- **Start-up:** list the repo files, fetch `site.css` and all pages, read the
  site name and menu order from `index.html`, put back any drafts (including
  unpublished new pages), and reopen the last page she edited.
- **Switching pages:** save the current page as a draft, fetch the latest copy
  of the target page with `fetchPage()` (unless she has a draft of it: her
  unpublished work wins), clear the canvas, and deserialize the page. A page
  only becomes a draft if its content really differs from the repo version.
- **Add a new page:** ask for a name, derive a safe file name ("Mes
  Recettes!" → `mes-recettes.html`, with a suffix if it's taken), and create a
  blank, unpublished page.
- **Publish:** re-render every page with the current site context and commit
  only the files whose HTML changed. Renaming a page, renaming the site or
  adding a page therefore updates the menu on every page automatically, while
  untouched pages produce no commit. Each commit sends the SHA it read, so a
  change made elsewhere comes back as a friendly "please reload" message
  instead of being overwritten.

### Free-form layout (whitespace)

- **Editor:** Gridstack is initialised with `float: true`, so blocks stay
  exactly where they are dropped instead of packing to the top. `minRow`
  keeps empty rows visible to drop into. Click-to-add puts new boxes under the
  lowest box (`engine.getRow()`), not under the empty rows at the bottom.
- **Saved file:** every block gets explicit grid lines
  (`grid-row: 11 / span 3`). CSS Grid creates the empty rows in between by
  itself, each at least one row tall.
- **Sizes match:** the editor uses 70px rows with an 8px item margin, and
  `site.css` uses 54px rows with a 16px gap, so a block at row *y* starts at
  `70·y` px in both. The prototype measured the example homepage at the same
  pixel offsets and heights in the editor and in the exported page.
- **Phones:** blocks stack in reading order, and desktop whitespace is
  intentionally collapsed. A big empty gap on a small screen just looks broken.
- Positions read from a file are clamped so a hand-edited file can't break the
  grid, but `y` is kept as written because whitespace is intended. A block
  without a position goes under the lowest block.

### Widget registry

Each block type is one entry in `WIDGETS` (in `engine.js`) with five
functions: `defaultData`, `createEditor`, `readData`, `renderStatic` and
`parseStatic`. Adding a Video, Map or Button block means adding one entry.

### Safety

- Pages are parsed with `DOMParser`; the parsed document is inert, so scripts
  never run.
- Rich text goes through an **allow-list sanitizer**: `p`, `h2`, `h3`, `strong`,
  `em`, `u`, `ul`, `ol`, `li`, `a`, `blockquote`, `br`. Every attribute except a
  safe `href` is stripped.
- No `javascript:` URLs. Images may only be http(s), relative or `data:image/…`.
- Page and site names, captions and menu labels are always escaped. New page
  file names must match `^[a-z0-9][a-z0-9-]*\.html$`, which the service also
  enforces.

## 3. Public API (browser console)

```js
Pebble.serializeToStaticHTML()       // the open page → HTML
Pebble.deserializeToEditor(html)     // HTML → the open page
Pebble.getPageModel()                // the open page as plain data
Pebble.pendingChanges()              // pages that would be committed by Publish
await Pebble.service.listCommits()   // history of the mock repository
```

## Next steps toward the real app

- **Real GitHub:** OAuth or device-flow sign-in, then swap in the real calls
  inside `GitHubService`. Creating a repository and enabling Pages for a new
  user can also go through the API.
- **Atomic multi-page publish:** use the Git Data API (one tree, one commit)
  so visitors never see a half-updated menu.
- **Photos as files:** photos are currently embedded as `data:` URLs. Commit
  them as `images/…jpg` instead.
- **Page management:** delete, rename and reorder pages. The menu order is
  already read from `index.html`.
- Undo/redo history, more block types, and theme presets (which only change
  `site.css` variables).

Built with [Gridstack.js](https://gridstackjs.com/) 10.3.1 (MIT).
