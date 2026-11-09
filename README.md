# Pebble

A tiny drag-and-drop website builder that publishes **plain static HTML**, so a
site can be hosted for free on GitHub Pages. It has no database: **the HTML
files are the database.**

Pebble is a **central editor web app**. Each user's website lives in their own
GitHub repository, which holds nothing but the published pages, one
stylesheet and the photos. The editor reads those files through the GitHub
REST API, turns them into an editable canvas, and writes the changes back:
**Save draft** to a `dev` branch, **Publish live** by merging `dev` into `main`,
which GitHub Pages serves.

```
index.html               ← landing page: redirects to the editor
editor/                  ← THE PEBBLE APP (hosted once, for everyone)
  index.html             ← editor UI
  editor.css             ← editor-only styling (toolbars, outlines, dialogs)
  github-service.js      ← GitHubService (real REST API) + MockGitHubService (demo)
  engine.js              ← widgets, page format, multi-page store, Gridstack,
                           save draft / publish live, photo library
example-site/            ← WHAT A USER'S REPOSITORY CONTAINS
  index.html  about.html  contact.html
  site.css               ← the site's theme (the editor loads it too)
  assets/images/         ← uploaded photos
```

`example-site/` also seeds the demo repository on first run, and it is a real,
working website: <https://thomasbrink.be/pebble-site-builder/example-site/>

## Run it

```bash
python -m http.server 8080
```

Then open <http://localhost:8080/editor/>. It has to be served over HTTP
(`localhost` or `https`): the demo repository seeds itself by fetching
`example-site/` and computes git SHAs with `crypto.subtle`. To start over, use
**More options → Reset the demo website**.

### Edit a real repository

The finished product would get the token from "Sign in with GitHub". Until
then, a developer can point the editor at a real repository from the browser
console. The token is kept in `sessionStorage`, so only for that tab:

```js
Pebble.useGitHub({ owner: 'your-name', repo: 'your-site', token: '<OAuth or fine-grained token>' })
Pebble.useDemo()   // back to the demo
```

The token needs **Contents: read & write** on that repository (classic: `repo`
or `public_repo`). The repository needs a `main` branch with the site in its
root folder, and GitHub Pages set to publish from `main`. The `dev` branch is
created automatically on the first Save draft.

---

## 1. UX strategy: designed for someone who has never made a website

The person we design for is a 50-year-old starting a hobby blog. She has never
heard of HTML, Git or a repository, and she shouldn't have to. Every decision
comes from one question: *would she understand this without being told?*

| Principle | How it shows up |
|---|---|
| **Use everyday words** | "Box", "Photo", "Page", "Save draft", "Publish live". The UI never says *branch*, *commit*, *merge*, *main*, *dev*, *repository* or *deploy*. |
| **Two clear buttons** | **💾 Save draft** keeps her work safe online, where only she can see it. **🚀 Publish live** puts everything on the website for everyone. Publish live also saves first, so she never needs both, and every change made since the last publish goes live together: pages, new pages, photos, and the menu on every page. |
| **Nothing gets lost** | Every edit is also kept in her browser straight away, so closing the tab loses nothing. One plain status line says where things stand: "● Changes not saved yet", "✓ Draft saved · not live yet" or "✓ Your website is up to date". |
| **Photos she can find again** | Clicking a photo box opens **Choose a photo**: a big "Add a new photo from your computer" area (or drag one in), and below it every photo she has uploaded, as large thumbnails. One click uses it. The photo in use is marked "✓ In use here". |
| **Forgiving when something clashes** | If the live site was changed somewhere else, she gets a plain question ("Publish my version" / "Not now") instead of an error. Being offline or losing access gets a sentence that says her changes are kept. |
| **Pages are a simple list** | "Your pages" in the sidebar: 🏠 Home, 📄 About me… A **New** badge marks a page that isn't on the live website yet, and an orange dot marks changes that aren't saved yet. **＋ Add a new page** asks only for a name and shows the web address it will get. |
| **What you see is what visitors get** | The canvas shows the site's real header and menu (clicking a menu item opens that page), uses the site's own `site.css`, and is exactly as wide as the live page. The block layout is pixel-identical. **👀 Preview** shows the real exported HTML at computer or phone size, and its menu links work. |
| **Things stay where she puts them** | Free-form layout: a box dropped low on the page stays there, with empty space above it. Faint row lines show it's a canvas, and the full grid appears while she drags. |
| **Tools appear where she is looking** | "✥ Move", "🗑 Remove" and the resize corner show only on the box under her mouse. The text style bar lights up once she clicks into text. |
| **Two ways to do everything** | Drag a tile onto the page or just click it. Pick a photo from the library or drop a photo file onto the box. Switch pages from the sidebar or from the menu on the page. |
| **Mistakes are cheap** | Removing a box shows "Box removed. **Undo**", and the box comes back in exactly the same spot. |
| **Hide the plumbing** | Repository names, file downloads and the demo reset are tucked under "More options". |

## 2. Architecture

### The editor is the controller; the repo is just files

```
 user's GitHub repo                              Pebble editor (central app)
 ──────────────────                              ───────────────────────────
 dev  (draft)   index.html about.html …  ──read──▶  htmlToPageModel() ─▶ canvas
                site.css  assets/images/*  ◀─PUT─── Save draft: changed pages
                                           ◀─PUT─── photo uploads
        │
        │  POST /merges   ◀─────────────────────── Publish live
        ▼
 main (live)  ──▶ GitHub Pages ──▶ https://{owner}.github.io/{repo}/
```

The editor reads from `dev` once it exists, otherwise from `main`. Page edits
are first kept in the browser; **Save draft** commits every changed page to
`dev`, and **Publish live** saves, then merges `dev` into `main`. Photos are
uploaded to `dev` the moment she adds them, so they're safe and show up in
the library right away. They go live with the next publish.

### `GitHubService` (`editor/github-service.js`)

Real `fetch()` calls to the GitHub REST API (version `2022-11-28`), with
`Authorization: Bearer <token>` and `cache: 'no-store'`, so she never sees a
stale copy right after saving.

| Method | GitHub REST call(s) |
|---|---|
| `getBranchSha(branch)` | `GET /repos/{o}/{r}/git/ref/heads/{branch}` (404 → `null`) |
| `ensureDraftBranch()` | if `dev` is missing: `POST /repos/{o}/{r}/git/refs` `{ ref: "refs/heads/dev", sha: <main head> }` |
| `fetchSiteFiles(ref)` | `GET /repos/{o}/{r}/contents/?ref=` |
| `fetchFile(path, ref)` / `fetchPage(file, ref)` | `GET /repos/{o}/{r}/contents/{path}?ref=`, base64 → UTF-8. Files over 1 MB fall back to the raw media type. |
| `commitPage(file, html, {message, sha})` | `PUT /repos/{o}/{r}/contents/{file}` `{ message, content: base64, branch: "dev", sha }` |
| `uploadImage(blob, {name})` | `PUT …/contents/assets/images/{YYYYMMDD-HHMMSS}-{slug}.jpg` on `dev`; returns the relative path |
| `fetchImageLibrary(ref)` | `GET /repos/{o}/{r}/contents/assets/images?ref=`, image files only, newest uploads first |
| `getImageUrl(path, ref)` | public repo: `raw.githubusercontent.com/{o}/{r}/{ref}/{path}`; private repo: authenticated raw download → `blob:` URL (cached) |
| `compareDraftToLive()` | `GET /repos/{o}/{r}/compare/main...dev` → is anything unpublished, and which files |
| `publishDraft()` | `POST /repos/{o}/{r}/merges` `{ base: "main", head: "dev" }` (201 merged, 204 nothing to do, 409 conflict), then `PATCH …/git/refs/heads/dev` `{ sha: <main head>, force: false }` so `dev` equals `main` again |
| `forcePublishDraft()` | only after "Publish my version": `PUT` each file `dev` changed onto `main` with its current SHA, then `PATCH` `dev` to `main` with `force: true` |

Details that matter:

- **One write at a time.** All writes go through a promise queue
  (`_queue`), because two commits racing for the same branch make GitHub
  reject one of them.
- **No lost updates.** Every `PUT` sends the SHA that was read. If the draft
  changed elsewhere (another computer), GitHub answers 409 and she's asked to
  reload. Her local edits survive the reload and are re-applied.
- **Merge conflicts are a question, not an error.** If `main` was edited
  elsewhere in a way that clashes with the draft, `POST /merges` returns 409.
  She can choose "Publish my version": only the files the draft changed are
  overwritten, other edits on `main` are kept, and `dev` is reset to `main`.
- **Photos.** They're resized in the browser first (max 1600px, JPEG 0.85 or
  PNG; GIFs are kept as-is), converted to base64 with `FileReader`, and
  committed with the contents API. SVG uploads are refused, because an SVG
  served from the site's own domain could run scripts. The block stores the
  **relative** path (`assets/images/…`), which works on GitHub Pages because
  pages live in the repository root. In the editor and in Preview, that path
  is resolved through `getImageUrl()`. A freshly uploaded photo is shown from
  memory straight away, before GitHub's CDN has it.

### `MockGitHubService`: demo mode

The demo extends `GitHubService` and replaces **only** `_request()` with a
small in-browser fake of the endpoints above. It stores git blobs with real
SHAs, commits with parents, branch refs, three-way merges with conflict
detection, and compare, all in `localStorage`, seeded from `example-site/`.
Every other line (branches, base64, queueing, merges, conflict handling) is
the same code that talks to github.com, so the demo exercises the real logic.
It reports the repository as private, so photos take the authenticated
download path.

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
  remote: { html, sha } | null,  // version saved in the repo's draft (null = brand-new page)
  draft:  "<html…>"     | null,  // edits not saved yet, kept in localStorage
  live:   true | false }         // is the page on the live site? (false → "New" badge)
```

- **Start-up:** check whether `dev` exists and read from it (otherwise
  `main`). List the files there and on `main` (for the "New" badges), fetch
  `site.css` and all pages, and ask `compare` whether a saved draft is waiting
  to go live. Then read the site name and menu order from `index.html`, put
  back any edits kept in the browser (including unsaved new pages), and reopen
  the last page she edited.
- **Switching pages:** save the current page as a draft, fetch the latest copy
  of the target page with `fetchPage()` (unless she has a draft of it: her
  unpublished work wins), clear the canvas, and deserialize the page. A page
  only becomes a draft if its content really differs from the repo version.
- **Add a new page:** ask for a name, derive a safe file name ("Mes
  Recettes!" → `mes-recettes.html`, with a suffix if it's taken), and create a
  blank, unpublished page.
- **Save draft:** re-render every page with the current site context and
  commit only the files whose HTML changed to `dev`. Renaming a page,
  renaming the site or adding a page therefore updates the menu on every page
  automatically, while untouched pages produce no commit.
- **Publish live:** Save draft, `compare` `main...dev` (which also catches
  photos, and drafts saved earlier or on another computer), then merge. The
  "Your website is live!" dialog lists the pages and the number of new photos.

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
- No `javascript:` URLs. Images may only be http(s), relative paths or
  `data:image/…` (`blob:` URLs are used only for on-screen previews and are
  never saved).
- Photo uploads are limited to JPEG, PNG, GIF and WebP (HEIC is converted
  where the browser can read it); SVG is refused.
- The token is only ever sent to `api.github.com`.
- Page and site names, captions and menu labels are always escaped. New page
  file names must match `^[a-z0-9][a-z0-9-]*\.html$`, which the service also
  enforces.

## 3. Public API (browser console)

```js
Pebble.serializeToStaticHTML()       // the open page → HTML
Pebble.deserializeToEditor(html)     // HTML → the open page
Pebble.getPageModel()                // the open page as plain data
Pebble.pendingChanges()              // pages Save draft would write
await Pebble.service.compareDraftToLive()
await Pebble.service.listCommits('main')   // demo only: history of the fake repo
```

## Next steps toward the real app

- **Sign in with GitHub** (an OAuth App, or a GitHub App for fine-grained
  per-repository access) instead of the console hook, plus onboarding that
  creates the repository and turns on Pages through the API.
- **One commit per save:** the Git Data API (blobs → tree → commit → update
  ref) would save several pages as one atomic commit, and publish photos and
  pages together.
- **Photo management:** delete or rename photos; generate smaller thumbnails
  for faster libraries.
- **Page management:** delete, rename and reorder pages.
- Undo/redo history, more block types, and theme presets (which only change
  `site.css` variables).

Built with [Gridstack.js](https://gridstackjs.com/) 10.3.1 (MIT).
