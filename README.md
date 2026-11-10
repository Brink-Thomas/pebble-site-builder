# Pebble

A tiny drag-and-drop website builder that publishes **plain static HTML**, so a
site can be hosted for free on GitHub Pages.

Pebble is **data-first**: the whole website is one JSON tree (`site.json`:
pages, sections, columns, blocks, design settings). The editor renders its UI
from that tree with Preact, and a client-side **compiler** turns the tree into
the pristine HTML and CSS that visitors get. Each user's website lives in their
own GitHub repository, which holds `site.json` (for the editor), the compiled
pages, `global.css` and the photos. **Save draft** commits to a `dev` branch,
**Publish** merges `dev` into `main`, which GitHub Pages serves.

```
index.html               ← START PAGE: sign in + "Your websites" (also the OAuth callback URL)
dashboard/               ← start-page script and styles
lib/                     ← plain scripts shared by the start page and the editor
  config.js              ← the only file to edit when deploying (client ID, token endpoint)
  auth.js                ← PebbleAuth: OAuth login, callback, session
  design.js              ← PebbleDesign: escaping, rich-text allow-list, fonts, theme → global.css
  site-state.js          ← PebbleState: the JSON tree (schema, normalising, actions, import of v2–v4 sites)
  compiler.js            ← PebbleCompiler: JSON → static HTML/CSS (compileToStaticHTML, compileSite)
  legacy-format.js       ← PebbleLegacy: reads websites made by Pebble v2–v4 (import only, frozen)
  site-base.css          ← Pebble's base styles (become the body of every global.css)
  github-service.js      ← GitHubClient / GitHubAccount / GitHubService (+ practice-mode mocks)
editor/                  ← THE EDITOR (editor/?site=owner/repo) — ES modules, no build step
  app.js                 ← the root: renders everything from the store
  store.js               ← the in-memory tree, undo/redo, action handlers (addSection, deleteSelected…)
  sync.js                ← GitHub: open, Save draft, Publish, photos
  canvas.js              ← sections / columns / blocks, native drag & drop, hover "+"
  blocks.js              ← each block type's canvas view and Inspector fields
  panels.js  dialogs.js  ← top bar, sidebar, Inspector, Library, Site Settings, photos, preview
  toolbar.js  fields.js  lib.js
worker/                  ← SERVERLESS TOKEN EXCHANGE (Cloudflare Worker)
example-site/            ← WHAT A USER'S REPOSITORY CONTAINS (see "The website format")
```

`example-site/` also seeds the demo repository on first run, and it is a real,
working website: <https://thomasbrink.be/pebble-site-builder/example-site/>

## Run it locally

```bash
python -m http.server 8080
```

Open <http://localhost:8080/>. Without sign-in configured, the **Connect**
button is disabled with a note for the site owner. **"Just looking? Try a
practice website first"** opens practice mode: a demo website stored in your
browser, with nothing going online. To start practice mode over, use **More
options → Reset the demo website** in the editor.

To test sign-in locally, run the token exchange next to it:

```bash
GITHUB_CLIENT_ID=<id> GITHUB_CLIENT_SECRET=<secret> node worker/dev-server.mjs
```

Then, in the browser console on `http://localhost:8080` (this override only
works on localhost):

```js
localStorage.setItem('pebble:dev-config', JSON.stringify({
  githubClientId: '<id>', tokenEndpoint: 'http://localhost:8787/api/token' }))
```

Use a separate OAuth App for development, with callback URL
`http://localhost:8080/`. `node worker/dev-server.mjs --fake` stubs GitHub,
for trying the flow without any credentials.

## Deploy (one time)

1. **Create a GitHub OAuth App**: github.com → Settings → Developer
   settings → OAuth Apps → New OAuth App.
   - Homepage URL and **Authorization callback URL**: where Pebble's start
     page is hosted, e.g. `https://thomasbrink.be/pebble-site-builder/`
   - Note the **Client ID**, then generate a **client secret**.
2. **Deploy the token exchange** (free Cloudflare account):
   ```bash
   cd worker
   npx wrangler login
   npx wrangler secret put GITHUB_CLIENT_SECRET     # paste the secret
   npx wrangler deploy
   ```
   Before deploying, set `GITHUB_CLIENT_ID`, `ALLOWED_ORIGINS` (where
   Pebble is hosted) and `ALLOWED_REDIRECT_URIS` (the callback URL) in
   `wrangler.toml`.
3. **Fill in `lib/config.js`**: `githubClientId` and `tokenEndpoint`
   (`https://pebble-oauth.<you>.workers.dev/api/token`). Neither value is
   secret.
4. Publish Pebble itself (e.g. GitHub Pages, as this repo does).

What users need: a GitHub account with a website repository whose Pages
setting publishes **from a branch, root folder** (`/`), and whose homepage
was made by Pebble. Pebble asks for the `public_repo` scope (free Pages
sites are public). Set `oauthScope: 'repo'` in `config.js` to include
private repositories.

---

## 1. UX strategy: designed for someone who has never made a website

The person we design for is a 50-year-old starting a hobby blog. She has never
heard of HTML, Git or a repository, and she shouldn't have to. Every decision
comes from one question: *would she understand this without being told?*

| Principle | How it shows up |
|---|---|
| **Use everyday words** | "Block", "Section", "Photo", "Page", "Website", "Save draft", "Publish", "hosting account". The UI never says *branch*, *commit*, *merge*, *main*, *dev*, *repository*, *token* or *deploy*. |
| **GitHub is just "her hosting"** | The start page is one calm card: what Pebble does, one **Connect GitHub** button (with the GitHub mark), a sentence saying she can make an account in the next step and that Pebble only changes a website when she presses Save or Publish, and "Try a practice website first". |
| **Add things where she is looking** | No "Add" button in the top bar. Hovering between two sections shows a blue line with a **+**; it opens a small library with **Sections** (one column, two equal, wide + narrow, narrow + wide, three) and **Blocks** (Text, Photo, Card, Button, Blog posts…). Every column has its own **+** at the bottom, and an empty column says **Add a block**. Tiles can be clicked or dragged straight onto any column. A new block is selected straight away, so its settings are already showing in the Inspector. |
| **The sidebar is her website** | **Main Menu** lists the pages that have a link in the site's menu, in menu order. **Other Pages** lists pages that are online but not in the menu. She drags a page between the two lists, or within the Main Menu to reorder it; a small arrow button does the same without dragging. She renames a page right there: double-click the name, or the pencil. **On every page** holds the **Header** and **Footer**. |
| **Blog posts get their own panel** | Clicking **Blog** slides the whole sidebar over to a Blog panel: a big **< Back to Pages** button on top, the Blog page itself, **Write a new post**, and the posts, newest first (renamable the same way). Her first post creates the Blog page; a site without a blog shows **Start a blog**. |
| **A toolbar only when she's writing** | Clicking into text shows a floating toolbar right above that box (pinned under the top bar when there's no room). It has a style dropdown (Main Heading, Heading, Subheading, Paragraph, Small text — names she can change) and icon buttons: bold, italic, underline, highlight (five soft colors), align left / center / right / justify, list and link. It disappears when she leaves the text. |
| **Click it, see its settings** | The right-hand **Inspector** shows the settings of what she clicked and redraws the canvas as she changes them. Photo: replace, shape (its own, wide, classic, square, tall), description (alt text), link, own roundness. Card: background color, text color, border. Button: text, destination, look, position (icons). **Section:** columns (side by side) and their widths in %, a soft box behind a column, how the columns line up, background color, background photo, a color over the photo with its strength in %, and light or dark text. With nothing selected it shows the page's settings (including Delete this page), a blog post's date, cover and summary, or the Header's hero image. |
| **A big hero photo** | Header → Hero image: pick a photo, then choose "Behind the website name and menu" or "Below the menu, as a wide banner", and Small/Medium/Large. |
| **Design in her words** | **Site Settings**: website name; **Branding** (a logo for the Header, with "Logo and website name" or "Logo only" and a size slider, and a favicon for the browser tab); main and second color; **Website font**, with fourteen fonts listed by their real names and a "Use a custom font" box for fonts.google.com; **Text styles** (name, font, size, line spacing, boldness for each); **Roundness** and **Spacing**, each showing its exact value in px. Everything updates live. |
| **Pick a website, not a project** | After connecting: "Hello, Jane! Which website would you like to work on?", a prominent **Create New Site** button, and a grid of square-cornered cards with a thin border, each with a colourful tile, the website's own name (e.g. "My Garden Diary"), its web address and "Updated 3 days ago". Websites made another way sit in a collapsed "Other websites" section, clearly marked as left alone. |
| **Calm failures** | Cancelling on GitHub: "No problem — your hosting account was not connected." An expired or revoked connection: "For your safety, please connect your hosting account again." Never an error code. |
| **Try before connecting** | A practice website she can play with freely, with a banner saying nothing goes online. |
| **Two clear buttons** | **Save draft** keeps her work safe online, where only she can see it. **Publish** puts everything on the website for everyone. Publish also saves first, so she never needs both, and every change made since the last publish goes live together: pages, new pages, photos, and the menu on every page. |
| **Nothing gets lost** | Every edit is also kept in her browser straight away, so closing the tab loses nothing. One status line with a colored square says where things stand: "Changes not saved yet", "Draft saved · not live yet" or "Your website is up to date". |
| **Photos she can find again** | Clicking a photo box opens **Choose a photo**: a big "Add a new photo from your computer" area (or drag one in), and below it every photo she has uploaded, as large thumbnails. One click uses it. The photo in use is marked "In use here". The logo and favicon are chosen from the same library. |
| **Forgiving when something clashes** | If the live site was changed somewhere else, she gets a plain question ("Publish my version" / "Not now") instead of an error. Being offline or losing access gets a sentence that says her changes are kept. |
| **Pages are a simple list** | A **New** badge marks a page that isn't on the live website yet, and an orange square marks changes that aren't saved yet. The **+** next to "Main Menu" asks only for a name and shows the web address it will get. |
| **What you see is what visitors get** | The canvas is drawn with the website's own classes and its own `global.css` and `theme.css`, between the real header and footer, exactly as wide as the live page. **Preview** shows the compiled HTML at computer or phone size (with the phone menu button), and its menu links work. |
| **Moving things is just dragging** | Hold the dots on a block and drag it: a blue line shows where it will land, in the same column, another column or another section. Sections move the same way, or with the up/down arrows. |
| **Tools appear where she is looking** | A block's bar (drag dots with its name, duplicate, trash) shows only on the block under her mouse or the selected one; a section's bar (drag dots, settings, up, down, duplicate, trash) only on the section under her mouse. |
| **Two ways to do everything** | Drag a Library tile onto a column or just click it. Move a section by dragging it or with the arrows. Pick a photo from the library or drop a photo file onto a photo block. |
| **Mistakes are cheap** | **Undo** and **Redo** in the top bar (and Ctrl+Z / Ctrl+Shift+Z) for every change. Removing a block, a section or a page shows "… removed. **Undo**". Changing a section from three columns to one never loses blocks: they move into the column that stays. |
| **One calm look** | Square corners, 1px lines, one icon set ([Lucide](https://lucide.dev), loaded from jsDelivr) and no emoji. Top-bar buttons show an icon and a word; on smaller screens the words hide (the tooltip stays) and on phones the bar shrinks to icons, so it never overflows. |
| **Hide the plumbing** | Technical names, file downloads and the demo reset are tucked under the "…" menu. |

## 2. Architecture

### Signing in: GitHub OAuth (web flow)

```
 Start page (browser)          GitHub                       Token exchange (Worker)
 ────────────────────          ──────                       ───────────────────────
 "Connect…" ── redirect ──▶  /login/oauth/authorize
                             ?client_id&redirect_uri&scope=public_repo&state=<random>
                             she approves Pebble
 ◀── redirect ─────────────  <start page>?code=…&state=…
 check state, strip ?code
 POST {code, redirect_uri} ──────────────────────────────▶  check Origin + redirect_uri
                                                            POST /login/oauth/access_token
                                                            {client_id, client_secret, code}
 ◀──────────────────────────────── {access_token, scope} ── (nothing stored or logged)
 GET /user → name + picture
 save session in localStorage
```

- **`lib/auth.js` (PebbleAuth):** `login()` creates a random `state`
  (sessionStorage, valid for 15 minutes) and redirects. `handleCallback()`
  removes `code` and `state` from the address bar first (no one-time code
  left in history), rejects a missing, expired or mismatched `state`
  (prevents forged logins), exchanges the code, looks up the user and stores
  `{ token, login, name, avatarUrl }`.
- **`worker/src/index.js`:** the only place the client secret exists. It
  answers only allowed origins (CORS), only accepts allowed `redirect_uri`s,
  validates the code's shape, returns `Cache-Control: no-store`, and passes
  GitHub's error codes through (GitHub reports them with HTTP 200 and an
  `error` field). It is a Web-standard `fetch` handler, so it also runs on
  Vercel/Netlify Edge or Deno with a one-line wrapper. 12 unit tests:
  `node worker/test.mjs`.
- **Token use:** `GitHubClient` takes `token: () => PebbleAuth.getToken()`,
  so every request uses the current token, and `onUnauthorized` turns any
  401 (revoked or expired) into "please connect again". The token is never
  put in a URL and is only sent to `api.github.com`.
- **Token storage:** the token sits in `localStorage` so she stays signed in
  on her own computer; **Sign out** removes it. Anything that runs script on
  Pebble's origin could read it, so Pebble keeps a strict no-inline-HTML
  policy (allow-list sanitizer, escaping, inert `DOMParser`). The README's
  next steps list a CSP and short-lived GitHub App tokens as hardening.

### "Your websites": the site selector

`GitHubAccount.listWebsites()`:

1. `GET /user/repos?affiliation=owner,collaborator,organization_member&sort=pushed`
   (paginated), keeping repositories she can push to that have GitHub Pages
   switched on (`has_pages`).
2. For each one, `GET /repos/{o}/{r}/pages` for the real address (custom
   domains included) and the branch and folder Pages serves.
3. It reads `index.html` (draft branch first, then live) and checks for
   Pebble's marker (`<meta name="generator" content="Pebble">`, or
   `data-pebble-grid` for sites from Pebble v2–v4). If found, the card shows
   the site's own name from its header.

Each website gets a status: **ready** (made by Pebble, clickable),
**not-pebble** (made another way) or **unsupported** (Pages serves a
sub-folder such as `/docs`). Clicking a ready card opens
`editor/?site=owner/repo`. The editor then calls `getPublishingInfo()` to
use the right live branch and address. It refuses, with a friendly message
and a "Back to your websites" button, if the homepage isn't a Pebble page,
and it leaves any non-Pebble pages out entirely, so Pebble can never
overwrite a website it didn't make. Tested against a real account: it found
4 websites and correctly marked all 4 as made another way.

### The website format: `site.json` + compiled files

A Pebble website, as files in the user's repository:

```
site.json            THE SOURCE OF TRUTH: the whole website as one JSON tree
global.css           compiled: design variables + Pebble's base styles
theme.css            only if a helper wrote CSS (Site Settings → Advanced)
index.html …         compiled pages      ┐ plain HTML, no JavaScript,
blog/*.html          compiled posts      ┘ header and footer included
assets/images/*      photos
```

**The JSON tree** (`lib/site-state.js`):

```js
{
  generator: "Pebble", version: 5,
  settings: { siteName, theme, typography, branding, hero, customCss },
  blogPage: "blog.html",
  pages:  [{ id, file, title, showInNavbar, sections }],
  posts:  [{ id, file, title, date, thumbnail, excerpt, excerptAuto, sections }],
  header: { sections }, footer: { sections },
}
section = { id, style: { bgColor, bgImage, overlayColor, overlayOpacity, tone, valign },
            columns: [{ id, width, style: { bgColor }, blocks: [{ id, type, data }] }] }
```

Sections are the top-level wrappers of a page; a section has 1–4 columns side
by side (widths add up to 100), and blocks stack top to bottom inside a
column. There are no positions to compute: moving a block is changing its
index in an array. `normalizeSite()` validates anything read from a file or
the browser (known block types and fields only, sanitized rich text, safe
URLs, hex colours, clamped numbers) and keeps a fixed key order, so the same
site always gives the same `site.json` text.

**The actions** (`addSection`, `addBlock`, `deleteNode`, `moveBlock`,
`moveSection`, `setLayout`, `addColumn`, `duplicate`, `addPage`, `addPost`,
`movePage`, `renameDoc`, …) change a tree in place and know nothing about the
DOM, so they are easy to test and reuse.

**The compiler** (`lib/compiler.js`). `compileToStaticHTML(site, file)` loops
through the tree and writes one complete page; `compileSite(site, {baseCss})`
returns every file (`site.json`, `global.css`, `theme.css`, pages, posts).
Blog-post summaries are filled in from the post's first words. Output:

```html
<header class="site-header">
  <section class="page-section">
    <div class="section-columns section-columns--center" style="--columns:42fr 58fr">
      <div class="section-column"><div class="block block-site-title">…</div></div>
      <div class="section-column"><nav class="block block-menu block-menu--right">…</nav></div>
    </div>
  </section>
</header>
<main class="site-main" id="main">
  <section class="page-section page-section--filled page-section--light" style="--section-bg:#6b8b4f">
    <div class="page-section__bg"><img …></div>                 <!-- background photo -->
    <div class="page-section__overlay" style="…"></div>         <!-- colour over it -->
    <div class="section-columns" style="--columns:70fr 30fr">
      <div class="section-column">…blocks…</div>
      <div class="section-column section-column--filled" style="--column-bg:#efe7db">…</div>
    </div>
  </section>
</main>
```

Layout is plain CSS Grid (columns) and Flexbox (blocks in a column); on
phones the columns stack and the header keeps the name and a CSS-only menu
button side by side. No `data-` attributes, ids or scripts are published.

**Saving** compiles the tree and commits only the files whose text differs
from the repository (`site.json` last), and deletes files Pebble no longer
uses: a deleted page, an emptied `theme.css`, or the `site-config.json`,
`header.html` and `footer.html` of older Pebble versions.

**Round-trip guarantee.** Compiling, reading `site.json` back and compiling
again gives byte-identical files. Tested on the example site (every page),
a migrated v4 site, and starter sites with names like "Café & Crêpes <3".

**Websites from Pebble v2–v4** have no `site.json`. When one is opened,
`PebbleState.importLegacy()` reads its `site-config.json`, `header.html`,
`footer.html` and pages (with the frozen `lib/legacy-format.js`). Blocks that
sat side by side on the old grid become columns, the rest stack in reading
order. Unsaved changes the v4 editor kept in the browser are imported too
(`importLegacyDraft`). Pebble then says: "press Publish once to update it";
that publish writes `site.json` and the new pages and removes the old files.

### Blocks

| Block | Published as | Notes |
|---|---|---|
| Text | `section.block.block-text` → `.rich-text` | allow-listed HTML: `h1–h3`, `p(.text-small)`, `strong`, `em`, `u`, `mark.hl-{yellow,green,blue,pink,orange}`, `.align-{center,right,justify}`, lists, links, quotes |
| Photo | `figure.block.block-image(--cropped)` (+ `--block-radius`, `--ratio`) → optional `a.block-image__link`, `figcaption` | shape, caption, alt text, link, own roundness |
| Card | `article.block.block-card(--outline/--shadow/--none)` (+ `--card-bg`, `--card-text`) → `__media`, `__title`, `__text`, `__link` | photo + title + text + optional link; colors; border |
| Button | `div.block.block-button--{left,center,right}` → `a.block-button__link--{primary,accent,secondary}` | main color / second color / outline |
| Blog posts | `section.block.block-blog-feed` → `.blog-feed` of `a.blog-card` | newest first, 3/6/12/all, from the posts in the tree |
| Website name | `div.block.block-site-title` → `a.site-title` → optional `img.site-title__logo`, `span.site-title__name` | header/footer only |
| Site menu | `nav.block.block-menu` → `input.site-menu__toggle` + `label.site-menu__burger` + `ul.site-menu` | header/footer only; Main Menu pages; button on phones |
| Embed code | `div.block.block-embed` | raw HTML for helpers (see below) |

### Design system (`global.css`)

The exported site depends on five variables, set in Site Settings:

```css
:root {
  --primary-color: #b85c38;   /* "Main color"  – buttons, links, current menu item */
  --secondary-color: #6b8b4f; /* "Second color" – dates, card edges, quotes */
  --border-radius: 14px;      /* "Roundness" */
  --font-family: Georgia, …;  /* "Website font" */
  --block-spacing: 16px;      /* "Spacing" – the gap between boxes */
}
```

Each text style adds four more variables, used by `.rich-text h1/h2/h3/p` and `.text-small`:

```css
  --text-title-font: Montserrat, …;   /* or var(--font-family) for "Website font" */
  --text-title-size: 48px;   --text-title-line-height: 1.15;   --text-title-weight: 700;   /* <h1> "Main Heading" */
  --text-heading-…           /* <h2> */      --text-subheading-…   /* <h3> */
  --text-paragraph-…         /* <p>  */      --text-small-…        /* <p class="text-small"> */
```

**Fonts.** Fourteen choices, listed by their real names: Georgia, System Sans,
Palatino, Trebuchet MS, System Rounded, Courier New, plus eight Google Fonts
(Playfair Display, Merriweather, Lora, Roboto, Open Sans, Lato, Montserrat,
Nunito). Each text style can use its own font or follow the website font.
Every Google Font in use (website font, per-style fonts, custom font) goes into
one `@import url("https://fonts.googleapis.com/css2?family=A&family=B…")` as
the first line of `global.css`.

**The custom font escape hatch** (`PebbleDesign.parseCustomFont`) accepts a
font name, a Google Fonts link, an `@import` line or a `<link>` tag copied from
fonts.google.com. It only accepts `fonts.googleapis.com`, extracts the family
names (letters, digits and spaces only), and **rebuilds** the URL from them,
so pasted text can never inject CSS. Tested: another host, a CSS-injection
attempt and a quote break-out are all refused or neutralised.

Values are validated (hex colours, clamped numbers, a fixed list of fonts and
weights, the font rules above), so nothing else can reach the CSS. In the
editor the same `global.css` is built live and the canvas uses the published
classes, so it matches the website at any setting.

### For website helpers (hidden from her)

- **Predictable classes.** Every block has `.block` plus a
  `.block-{type}` class with BEM-style children (table above); regions are
  `.site-header`, `.site-main`, `.site-footer` and `.post-header`. The
  comment at the top of `lib/site-base.css` lists them.
- **theme.css.** Site Settings → **Advanced** (collapsed, at the very
  bottom, with a warning) takes pasted or uploaded CSS. It's saved as
  `theme.css`, linked after `global.css` on every page, and applied live in
  the editor.
- **Embed code.** The "For website helpers" group of the Add drawer has
  **Embed code**, behind a clear warning, for maps, videos and forms. The code
  goes into the page exactly as typed (and into `site.json` as text). It
  **never runs inside the editor**: the canvas shows a
  placeholder, and Preview is a sandboxed frame without scripts, so code can't
  reach her login.

### `GitHubService` (`lib/github-service.js`)

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

### `MockGitHubService`: practice mode

The demo extends `GitHubService` and replaces **only** `_request()` with a
small in-browser fake of the endpoints above. It stores git blobs with real
SHAs, commits with parents, branch refs, three-way merges with conflict
detection, and compare, all in `localStorage`, seeded from `example-site/`.
Every other line (branches, base64, queueing, merges, conflict handling) is
the same code that talks to github.com, so the demo exercises the real logic.
It reports the repository as private, so photos take the authenticated
download path.

### The editor (`editor/`, Preact)

The editor is ES modules loaded straight from the repository: Preact and htm
come from one pinned CDN file (`htm@3.1.1/preact/standalone.module.js`,
13 kB), icons from Lucide 0.460.0. No build step, so GitHub Pages serves it
as-is.

- **One store** (`store.js`): `store.site` is the JSON tree; `store.ui` holds
  what's open and selected. Every change goes through `change(fn)`, which
  snapshots the tree for undo, runs a PebbleState action, and repaints.
  Preact redraws only what differs; the DOM is never read back.
- **Typing** is the one exception: text editors write into the tree on every
  keystroke without repainting (the browser is already showing the text),
  one undo step per burst. They re-read the tree only when another block
  lands in their place, after undo/redo, or when the same field changed in
  the Inspector.
- **Action handlers** the UI calls: `addSection(index, layout)` pushes a new
  section into the doc at that index and selects it; `deleteSelected()`
  splices the selected block or section out of the tree (with Undo in the
  toast, and the Delete key); `addBlock`, `moveBlock`, `moveSection`,
  `duplicateNode`, `setLayout`, `openDoc`, `createPage`, `createPost`,
  `renameDoc`, `movePage`, `deleteDoc`.
- **Drag and drop** (`canvas.js`) is the browser's own HTML5 drag and drop.
  Blocks are dragged by their handle (so selecting text still works), the
  drop index comes from the middles of the blocks under the mouse, and
  dropping calls `moveBlock()` or, for a Library tile, `addBlock()`. Sections
  and pages in the sidebar work the same way.
- **Autosave**: 0.6 s after a change the tree is compiled, compared with the
  repository (that's the orange dots and the status line) and kept in
  `localStorage`, so closing the tab loses nothing.
- **Save draft / Publish** (`sync.js`): commit the changed files to `dev`,
  then `compare main...dev` and merge. A clash gets the plain "Publish my
  version / Not now" question.

### Adding a block type

Add it in three small places: its data and defaults in
`PebbleState.BLOCK_TYPES` + `normalizeBlockData`, its HTML in
`PebbleCompiler`'s `RENDER`, and its canvas view and Inspector fields in
`editor/blocks.js` (`EDITORS`). The Library, drag and drop, saving and undo
work without further changes.

### Safety

- Websites are read from `site.json`, which is validated field by field;
  older pages are parsed with `DOMParser` (inert, scripts never run).
- Rich text goes through an **allow-list sanitizer** both when it's typed and
  when it's compiled. Every attribute except a safe `href` and Pebble's own
  classes is stripped.
- No `javascript:` URLs. Images may only be http(s), relative paths or
  `data:image/…` (`blob:` URLs are used only for on-screen previews).
- Photo uploads are limited to JPEG, PNG, GIF and WebP (HEIC is converted
  where the browser can read it); SVG is refused.
- The token is only ever sent to `api.github.com`; the client secret lives
  only in the worker.
- Pebble only opens websites it made, and `commitFile()` / `deleteFile()`
  only accept Pebble's own file names (pages, `blog/*.html`, `site.json`,
  `global.css`, `theme.css`, and the old `site-config.json`).
- Embed code is the one deliberate exception to "no raw HTML". It is
  published as-is but never executed in the editor (placeholder on the canvas,
  sandboxed preview without scripts).
- Names, captions and menu labels are always escaped.

## 3. Public API (browser console)

```js
Pebble.site                          // the JSON tree
Pebble.compile()                     // every file of the website (what Save would compare)
Pebble.compileToStaticHTML('about.html')
const A = await Pebble.actions       // the store's action handlers
A.addSection(1, 'main')              // a wide + narrow section at index 1
A.select(id); A.deleteSelected()
A.undo(); A.redo()
Pebble.store.pending                 // the files Save draft would write or delete
await Pebble.store.service.listCommits('main')   // demo only: history of the fake repo
```

## Versions

- `main`: the current version, deployed by GitHub Pages.
- `v4-stable`: the version before the data-first rewrite (Gridstack canvas,
  each page's HTML read back as the database, rows of sections with free-form
  grids). Its websites are imported into `site.json` when opened; one
  Publish moves them over.
- `v3-stable`: the version before sections, the hover "+" library, the
  sliding blog panel, branding (logo, favicon), the phone menu button,
  per-style fonts and the Lucide redesign. Its websites open in the current
  version; their pages are rewritten once with sections markup, and Pebble asks
  her to press Publish once.
- `v2-stable`: the version before the sidebar menus, floating text toolbar,
  Inspector, hero image and typography settings. Its websites open in the
  current version unchanged; Pebble only rewrites `global.css` and
  `site-config.json` with the new design options.
- `v1-stable`: the version before the header/footer, blog, component
  library and Site Settings work (single-page format with its own header per
  page). Websites made with it are upgraded automatically when opened.

## Next steps toward the real app

- **Hardening:** a Content-Security-Policy, and a GitHub App instead of an
  OAuth App, for per-repository access and expiring tokens. A "Sign out
  everywhere" option could revoke the grant through the worker.
- **One commit per save:** the Git Data API (blobs → tree → commit → update
  ref) would save several pages as one atomic commit.
- **Photo management:** delete or rename photos.
- More block types (gallery, video, contact form via a helper service), and
  theme presets.

Built with [Preact](https://preactjs.com/) + [htm](https://github.com/developit/htm) 3.1.1 (MIT) and [Lucide](https://lucide.dev/) icons 0.460.0 (ISC).
