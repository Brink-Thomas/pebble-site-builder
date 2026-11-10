# Pebble

A tiny drag-and-drop website builder that publishes **plain static HTML**, so a
site can be hosted for free on GitHub Pages. It has no database: **the HTML
files are the database.**

Pebble is a **central web app**: she connects her hosting account (GitHub),
picks one of her websites, and edits it. Each user's website lives in their own
GitHub repository, which holds nothing but the published website: stitched
HTML pages and blog posts, `site-config.json`, `global.css`, the header and
footer partials, and the photos. The editor reads those files through the
GitHub REST API, turns them into an editable canvas, and writes the changes back:
**Save draft** to a `dev` branch, **Publish live** by merging `dev` into `main`,
which GitHub Pages serves.

```
index.html               ← START PAGE: "Connect your hosting account" + "Your websites"
                           (also the GitHub OAuth callback URL)
dashboard/               ← start-page script and styles
lib/                     ← shared by the start page and the editor
  config.js              ← the only file to edit when deploying (client ID, token endpoint)
  auth.js                ← PebbleAuth: OAuth login, callback, session
  site-format.js         ← PebbleFormat: the website format — blocks, stitching,
                           site-config.json, global.css, upgrading older sites
  site-base.css          ← Pebble's base styles (become the body of every global.css)
  github-service.js      ← GitHubClient / GitHubAccount / GitHubService (+ practice-mode mocks)
editor/                  ← THE EDITOR (opened as editor/?site=owner/repo)
  index.html  editor.css
  engine.js              ← block editors, Gridstack canvas, pages/posts/header/footer,
                           Add drawer, Site Settings, save draft / publish live, photos
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
| **Use everyday words** | "Box", "Photo", "Page", "Website", "Save draft", "Publish live", "hosting account". The UI never says *branch*, *commit*, *merge*, *main*, *dev*, *repository*, *token* or *deploy*. |
| **GitHub is just "her hosting"** | One big button: **Connect your Hosting Account (GitHub)**, with a sentence explaining that GitHub keeps her website online for free and that she can make an account in the next step. Under it, a reassurance: Pebble only changes a website when she opens it and presses Save or Publish. |
| **Add things with one big button** | **＋ Add** opens a drawer of boxes with big icons and one-line descriptions — Text, Photo, Card, Button, Blog posts — that she drags straight onto the page (or clicks). A newly added box is selected straight away, so its settings are already showing in the Inspector on the right. |
| **The sidebar is her website** | **Main Menu** lists the pages that have a link in the site's menu, in menu order. **Other Pages** lists pages that are online but not in the menu. She drags a page between the two lists, or within the Main Menu to reorder it; a small ↓/↑ button does the same without dragging. **On every page** holds the **Header** and **Footer**, named as such. |
| **Blog posts don't clutter** | Posts nest under the **Blog** page and stay hidden until she clicks “▸ 3 blog posts”. **＋ Write a blog post** sits inside that list. Her first post creates the Blog page; a site without a blog shows **📰 Start a blog**. |
| **A toolbar only when she's writing** | Clicking into text shows a floating toolbar right above that box (pinned under the top bar when there's no room). It has a style dropdown (Main Heading, Heading, Subheading, Paragraph, Small text — names she can change), **B**, *I*, U, 🖍️ highlight (five soft colors), alignment (left, center, right, justify), list and link. It disappears when she leaves the text. |
| **Click a box, see its settings** | The right-hand **Inspector** shows the clicked box's settings and redraws the canvas as she changes them. Photo: replace, description (alt text), link, own roundness. Card: background color, text color, border. Button: text, destination (her pages and posts), main color / second color / outline. With nothing selected it shows the page's settings, a blog post's date, cover and summary, or the Header's hero image. |
| **A big hero photo** | Header → 🌄 Hero image: pick a photo, then choose "Behind the website name and menu" or "Below the menu, as a wide banner", and Small/Medium/Large. |
| **Design in her words** | **🎨 Site Settings**: main and second color; **Letters**, with ten popular fonts and a "Use a custom font" box that takes a font name or a link from fonts.google.com; **Text styles** (name, size, line spacing, boldness for each); **Roundness** (Square ↔ Round); **Spacing** (Snug ↔ Airy). Everything updates live. |
| **Pick a website, not a project** | After connecting: "Hello, Jane! 👋 Which website would you like to work on?" and a grid of big cards, each with a colourful tile, the website's own name (read from its header, e.g. "My Garden Diary"), its web address and "Updated 3 days ago". Websites made another way sit in a collapsed "Other websites" section, clearly marked as left alone. |
| **Calm failures** | Cancelling on GitHub: "No problem — your hosting account was not connected." An expired or revoked connection: "For your safety, please connect your hosting account again." Never an error code. |
| **Try before connecting** | A practice website she can play with freely, with a banner saying nothing goes online. |
| **Two clear buttons** | **💾 Save draft** keeps her work safe online, where only she can see it. **🚀 Publish live** puts everything on the website for everyone. Publish live also saves first, so she never needs both, and every change made since the last publish goes live together: pages, new pages, photos, and the menu on every page. |
| **Nothing gets lost** | Every edit is also kept in her browser straight away, so closing the tab loses nothing. One plain status line says where things stand: "● Changes not saved yet", "✓ Draft saved · not live yet" or "✓ Your website is up to date". |
| **Photos she can find again** | Clicking a photo box opens **Choose a photo**: a big "Add a new photo from your computer" area (or drag one in), and below it every photo she has uploaded, as large thumbnails. One click uses it. The photo in use is marked "✓ In use here". |
| **Forgiving when something clashes** | If the live site was changed somewhere else, she gets a plain question ("Publish my version" / "Not now") instead of an error. Being offline or losing access gets a sentence that says her changes are kept. |
| **Pages are a simple list** | "Your pages" in the sidebar: 🏠 Home, 📄 About me… A **New** badge marks a page that isn't on the live website yet, and an orange dot marks changes that aren't saved yet. **＋ Add a new page** asks only for a name and shows the web address it will get. |
| **What you see is what visitors get** | The page sits between the site's real header and footer, uses the site's own `global.css` and `theme.css`, and is exactly as wide as the live page. The block layout is pixel-identical. **👀 Preview** shows the real exported HTML at computer or phone size, and its menu links work. |
| **Things stay where she puts them** | Free-form layout: a box dropped low on the page stays there, with empty space above it. Faint row lines show it's a canvas, and the full grid appears while she drags. |
| **Tools appear where she is looking** | "✥ Move", "🗑 Remove" and the resize corner show only on the box under her mouse. The text style bar lights up once she clicks into text. |
| **Two ways to do everything** | Drag a tile onto the page or just click it. Pick a photo from the library or drop a photo file onto the box. Switch pages from the sidebar or from the menu on the page. |
| **Mistakes are cheap** | Removing a box shows "Box removed. **Undo**", and the box comes back in exactly the same spot. |
| **Hide the plumbing** | Technical names, file downloads and the demo reset are tucked under "More options". |

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
3. It reads `index.html` (draft branch first, then live) and checks for the
   `data-pebble-grid` marker. If found, the card shows the site's own name
   from its header.

Each website gets a status: **ready** (made by Pebble, clickable),
**not-pebble** (made another way) or **unsupported** (Pages serves a
sub-folder such as `/docs`). Clicking a ready card opens
`editor/?site=owner/repo`. The editor then calls `getPublishingInfo()` to
use the right live branch and address. It refuses, with a friendly message
and a "Back to your websites" button, if the homepage isn't a Pebble page,
and it leaves any non-Pebble pages out entirely, so Pebble can never
overwrite a website it didn't make. Tested against a real account: it found
4 websites and correctly marked all 4 as made another way.

### The website format (`lib/site-format.js`)

A Pebble website, as files in the user's repository:

```
site-config.json     site name · pages (order + showInNavbar = Main Menu / Other Pages)
                     · blogPage · blog posts (title, date, thumbnail, excerpt)
                     · header.hero · theme · typography (text styles, custom font)
                     · customCss flag
global.css           :root { --primary-color … } + Pebble's base styles
theme.css            optional extra CSS from a helper (loaded after global.css)
header.html          the top of every page    ┐ "partials": a grid of blocks,
footer.html          the bottom of every page ┘ edited like a page
index.html …         pages        ┐ STITCHED: <head> + header + page + footer,
blog/*.html          blog posts   ┘ so visitors get plain HTML with no JavaScript
assets/images/*      photos
```

**Client-side static generation.** The editor keeps the website as plain data
(config, a list of blocks per page/post/partial, custom CSS). When she saves,
`PebbleFormat.buildSiteFiles()` renders **every** file from that data:
`site-config.json`, `global.css`, `theme.css`, both partials, and each page
and post wrapped in the header and footer. It then commits **only the files
whose text changed**. That single rule makes everything consistent:

- editing the footer, renaming a page or hiding it from the menu re-stitches
  every page that shows it;
- publishing a new post updates every page with a Blog posts box;
- untouched files produce no commit.

**Hero image.** `config.header.hero` = `{ enabled, src, position: behind|below, size: small|medium|large }`.
It is rendered into the header region as an `<img>`: behind the grid
(`.site-header--hero` with a dark gradient for legibility) or as a banner below
it (`.site-hero`).

**The stitching** (`stitchPage`). Each page gets `<head>` (title, description
for posts, `global.css`, plus `theme.css` if present), the header region, an
automatic post header for blog posts (date, title, cover photo), the page grid
and the footer region. Paths are stored relative to the site root
(`about.html`, `assets/images/x.jpg`, `blog/my-post.html`) and are given a
`../` prefix when rendered into a page inside `blog/`. The prefix is removed
again when the page is read back.

**Round-trip guarantee.** Reading any file back and rendering it again gives
**byte-identical** output. Tested: every file of a saved site, starter
websites, and names such as "Café & Crêpes <3".

**Upgrading older websites.** A site made before this format (no
`site-config.json`, each page carrying its own header, `site.css`) is
upgraded in memory when opened. Its name and menu order come from the old
header, pages keep their blocks, and the default header and footer are added.
Pebble tells her: "press Publish live once to put it online".

### Blocks

| Block | Published as | Notes |
|---|---|---|
| Text | `section.editor-block.block-text` → `.rich-text` | allow-listed HTML: `h1–h3`, `p(.text-small)`, `strong`, `em`, `u`, `mark.hl-{yellow,green,blue,pink,orange}`, `.align-{center,right,justify}`, lists, links, quotes |
| Photo | `figure.editor-block.block-image` (+ `data-radius`, `--block-radius`) → optional `a.block-image__link` | caption; alt text; link; own roundness |
| Card | `article.editor-block.block-card(--outline/--shadow/--none)` (+ `data-bg`, `data-text-color`, `data-border`, `--card-bg`, `--card-text`) → `__media`, `__title`, `__text`, `__link` | photo + title + text + optional link; colors; border |
| Button | `div.editor-block.block-button--{left,center,right}` → `a.block-button__link--{primary,accent,secondary}` | main color / second color / outline; links to a page, a post or another website |
| Blog posts | `section.editor-block.block-blog-feed` → `.blog-feed` of `a.blog-card` | generated from `site-config.json` when stitched: newest first, 3/6/12/all |
| Website name | `div.editor-block.block-site-title` → `a.site-title` | header/footer only; from `siteName` |
| Site menu | `nav.editor-block.block-menu` → `ul.site-menu` | header/footer only; pages with `showInNavbar` |
| Embed code | `div.editor-block.block-embed` | raw HTML for helpers (see below) |

Every block also carries `data-widget-type` and `data-gs-x/y/w/h` (what Pebble
reads back) and an inline CSS Grid placement (what visitors see).

### Design system (`global.css`)

The exported site depends on five variables, set in Site Settings:

```css
:root {
  --primary-color: #b85c38;   /* "Main color"  – buttons, links, current menu item */
  --secondary-color: #6b8b4f; /* "Second color" – dates, card edges, quotes */
  --border-radius: 14px;      /* "Roundness" */
  --font-family: Georgia, …;  /* "Letters" – one of six safe font stacks */
  --block-spacing: 16px;      /* "Spacing" – the gap between boxes */
}
```

Each text style adds three more variables, used by `.rich-text h1/h2/h3/p` and `.text-small`:

```css
  --text-title-size: 48px;   --text-title-line-height: 1.15;   --text-title-weight: 700;   /* <h1> "Main Heading" */
  --text-heading-…           /* <h2> */      --text-subheading-…   /* <h3> */
  --text-paragraph-…         /* <p>  */      --text-small-…        /* <p class="text-small"> */
```

**Fonts.** Ten choices: Georgia and the system font, plus eight Google Fonts
(Playfair Display, Merriweather, Lora, Roboto, Open Sans, Lato, Montserrat,
Nunito). A Google Font adds `@import url("https://fonts.googleapis.com/…")` as
the first line of `global.css`.

**The custom font escape hatch** (`PebbleFormat.parseCustomFont`) accepts a
font name, a Google Fonts link, an `@import` line or a `<link>` tag copied from
fonts.google.com. It only accepts `fonts.googleapis.com`, extracts the family
names (letters, digits and spaces only), and **rebuilds** the URL from them,
so pasted text can never inject CSS. Tested: another host, a CSS-injection
attempt and a quote break-out are all refused or neutralised.

Values are validated (hex colours, clamped numbers, a fixed list of fonts and
weights, the font rules above), so nothing else can reach the CSS. In the editor the same `global.css` is built
live, and Gridstack's margin follows `--block-spacing`, so the canvas keeps
matching the published grid at any spacing.

### For website helpers (hidden from her)

- **Predictable classes.** Every block has `.editor-block` plus a
  `.block-{type}` class with BEM-style children (table above); regions are
  `.site-header`, `.site-main`, `.site-footer` and `.post-header`. The
  comment at the top of `lib/site-base.css` lists them.
- **theme.css.** Site Settings → **Advanced** (collapsed, at the very
  bottom, with a warning) takes pasted or uploaded CSS. It's saved as
  `theme.css`, linked after `global.css` on every page, and applied live in
  the editor.
- **Embed code.** The "For website helpers" group of the Add drawer has
  **Embed code**, behind a clear warning, for maps, videos and forms. The code
  goes into the page exactly as typed, with a base64 copy in `data-code` for
  exact round trips. It **never runs inside the editor**: the canvas shows a
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

### Editor state (`editor/engine.js`)

```js
store = {
  remote:    Map(path → { content, sha }),  // files in the repo (draft branch, else live)
  livePaths: Set(paths on the live branch), // → "New" badges
  config, docs, customCss,                  // the site being edited (see site-format.js)
  current:   "about.html",                  // the doc on the canvas
}
```

- **Start-up:** find where Pages publishes, read `dev` if it exists
  (otherwise `main`), list the root and `blog/`, fetch every site file, and
  build the site data from `site-config.json` and the partials (or upgrade an
  older site). Then put back changes kept in this browser and reopen the last
  doc.
- **Editing:** one doc at a time on the canvas: a page, a post, or the
  header/footer. Switching docs copies the canvas into `docs`. Every change
  is kept in `localStorage` as data, and the sidebar dots come from comparing
  the rendered files with `remote`.
- **Floating toolbar:** it shows when a `.text-editor` gets focus or the text
  cursor enters one (it doesn't rely on focus events alone), and it keeps her
  selection while she uses the style dropdown. Alignment and "Small text"
  set classes on the paragraphs in the selection. Highlights come from the
  browser's `hiliteColor`; the allow-list maps any background colour, whether
  on a `span` or directly on `b`/`u`/`i`/`a`, to the nearest of five
  `mark.hl-*` classes.
- **Inspector:** each block type lists its fields (`text`, `select`, `link`,
  `color`, `radius`, `photo`, `code`, `date`, `toggle`). A change updates the
  block's data and redraws it on the canvas at once. The published HTML
  carries the same values as `data-` attributes.
- **Save draft:** commit every changed file to `dev`. **Publish live:** save,
  `compare main...dev` (which also catches photos and drafts saved elsewhere),
  then merge. The "Your website is live!" dialog lists pages, posts,
  "Top and bottom of your pages", "Your website’s look" and new photos.

### Free-form layout (whitespace)

- **Editor:** Gridstack is initialised with `float: true`, so blocks stay
  exactly where they are dropped instead of packing to the top. `minRow`
  keeps empty rows visible to drop into. Click-to-add puts new boxes under the
  lowest box (`engine.getRow()`), not under the empty rows at the bottom.
- **Saved file:** every block gets explicit grid lines
  (`grid-row: 11 / span 3`). CSS Grid creates the empty rows in between by
  itself, each at least one row tall.
- **Sizes match:** the editor uses 70px rows with an item margin of half the
  spacing, and `global.css` uses rows of (70px − spacing) with a gap of
  `--block-spacing`. A block at row *y* therefore starts at `70·y` px in both,
  at any Spacing setting.
- **Phones:** blocks stack in reading order, and desktop whitespace is
  intentionally collapsed. A big empty gap on a small screen just looks broken.
- Positions read from a file are clamped so a hand-edited file can't break the
  grid, but `y` is kept as written because whitespace is intended. A block
  without a position goes under the lowest block.

### Adding a block type

Add it in two places: its published HTML in `PebbleFormat.BLOCKS`
(`render`, `parse`, `defaults`) and its editing UI in `EDITORS`
(`create`, `read`, and `inspector` fields for the right-hand panel). The Add
drawer, saving, stitching and round-tripping work without further changes.

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
- The token is only ever sent to `api.github.com`; the client secret lives
  only in the worker.
- Pebble only opens websites whose homepage it made, and never writes
  pages it didn't make. `commitFile()` only accepts Pebble's own file names
  (pages, `blog/*.html`, `site-config.json`, `global.css`, `theme.css`).
- Embed code is the one deliberate exception to "no raw HTML". It is
  published as-is but never executed in the editor (placeholder on the canvas,
  sandboxed preview without scripts).
- Page and site names, captions and menu labels are always escaped. New page
  file names must match `^[a-z0-9][a-z0-9-]*\.html$`, which the service also
  enforces.

## 3. Public API (browser console)

```js
Pebble.serializeToStaticHTML()       // the open page → HTML
Pebble.deserializeToEditor(html)     // HTML → the open page
Pebble.readCanvas()                  // the open page's blocks as plain data
Pebble.buildFiles()                  // every file of the website, rendered from data
Pebble.pendingChanges()              // the files Save draft would write
Pebble.store                         // config, docs, remote files
await Pebble.service.compareDraftToLive()
await Pebble.service.listCommits('main')   // demo only: history of the fake repo
```

## Versions

- `main`: the current version, deployed by GitHub Pages.
- `v2-stable`: the version before the sidebar menus, floating text toolbar,
  Inspector, hero image and typography settings. Its websites open in the
  current version unchanged; Pebble only rewrites `global.css` and
  `site-config.json` with the new design options.
- `v1-stable`: the version before the header/footer, blog, component
  library and Site Settings work (single-page format with its own header per
  page). Websites made with it are upgraded automatically when opened.

## Next steps toward the real app

- **Create a new website** from the start page: create the repository,
  commit the starter files, and switch on Pages (`POST /repos/{o}/{r}/pages`),
  all through the API.
- **Hardening:** a Content-Security-Policy, and a GitHub App instead of an
  OAuth App, for per-repository access and expiring tokens. A "Sign out
  everywhere" option could revoke the grant through the worker.
- **One commit per save:** the Git Data API (blobs → tree → commit → update
  ref) would save several pages as one atomic commit.
- **Photo and page management:** delete or rename photos; delete, rename
  and reorder pages.
- Undo/redo history, more block types, and theme presets.

Built with [Gridstack.js](https://gridstackjs.com/) 10.3.1 (MIT).
