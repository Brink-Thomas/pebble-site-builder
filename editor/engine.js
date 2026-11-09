/* ==========================================================================
   Pebble — core engine
   --------------------------------------------------------------------------
   Pebble is a central editor app. The user's website lives in THEIR GitHub
   repository as plain HTML files, and those files are the only database:

     user's repo                       Pebble editor (this file)
     ───────────                       ─────────────────────────
     index.html  ─┐  GitHubService     ┌─ store: list of pages + drafts
     about.html   ├─ fetchPage() ────▶ │  htmlToPageModel()  ─▶ Gridstack canvas
     contact.html │                    │
     site.css    ─┘ ◀── commitPage() ──┘  pageModelToHtml() ◀─ Gridstack canvas

   Everything goes through two small plain-data shapes:

     Page model   { file: "about.html", name: "About me",
                    blocks: [ { type: "text", x, y, w, h, data: {…} }, … ] }

     Site context { siteName: "My Garden Diary",
                    pages: [ { file: "index.html", name: "Home" }, … ] }

   A published page = page model + site context (the header & menu are the
   same on every page). Saving re-renders EVERY page from its model and
   commits only the files whose HTML actually changed — so renaming a page or
   adding a new one automatically updates the menu on all the others.

   Three layers of "saved", only two of which she ever hears about:
     1. every change    → kept in this browser (localStorage), automatically
     2. "Save draft"    → committed to the repo's draft branch (dev)
     3. "Publish live"  → draft merged into the live branch (main) → GitHub Pages
   Photos are uploaded straight to assets/images/ on the draft branch.

   Sections:
      1. Config
      2. Safety helpers
      3. Widget registry (Text, Photo)
      4. Page format: pageModelToHtml() ⇄ htmlToPageModel()   (pure functions)
      5. Editor canvas: Gridstack + blocks
      6. Site store: pages, drafts, unpublished changes
      7. Pages: open / switch / add
      8. Public API: serializeToStaticHTML() & deserializeToEditor()
      9. Autosave
     10. Save draft & Publish live
     11. Photos: upload + media library
     12. UI wiring
     13. Boot
   ========================================================================== */

(function () {
  'use strict';

  /* ========================================================================
     1. CONFIG
     ======================================================================== */

  const CONFIG = {
    columns: 12,         // grid columns (also in site.css)
    cellHeight: 70,      // px per row in the editor  → site.css: --row + --gap
    margin: 8,           // px around each item       → site.css: --gap = 2 × margin
    minRows: 9,          // empty rows always shown, so there's room to place things low
    themeFile: 'site.css',
    homeFile: 'index.html',
    demoRepo: { owner: 'demo-user', repo: 'my-garden-blog' },
    maxImageSide: 1600,     // photos are shrunk to this many px before upload
    autosaveDelay: 700,
  };

  /**
   * Which repository to edit, and how.
   * The real app gets { owner, repo, token } from "Sign in with GitHub".
   * For development it can be set from the console (kept for this tab only):
   *   Pebble.useGitHub({ owner: 'me', repo: 'my-site', token: 'gho_…' })
   * Without it, Pebble runs on the in-browser demo repository.
   */
  function createService() {
    let cfg = null;
    try { cfg = JSON.parse(sessionStorage.getItem('pebble:github') || 'null'); } catch { /* ignore */ }
    if (cfg && cfg.owner && cfg.repo && cfg.token) return new GitHubService(cfg);
    return new MockGitHubService(CONFIG.demoRepo);
  }

  /* ========================================================================
     2. SAFETY HELPERS
     Pages come from a repository and from pasting, so everything that goes
     into a page is escaped or run through an allow-list first.
     ======================================================================== */

  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function escapeAttr(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /**
   * Return the URL if it is safe, otherwise ''.
   *  'link'  → http(s), mailto, tel, #anchors, relative paths
   *  'image' → http(s), relative paths (assets/images/…), data:image/…,
   *            and blob: (only ever used for on-screen previews)
   */
  function safeUrl(url, kind) {
    const u = String(url ?? '').trim();
    if (!u) return '';
    if (kind === 'image' && /^data:image\/(png|jpe?g|gif|webp|avif|svg\+xml)[;,]/i.test(u)) return u;
    if (kind === 'image' && /^blob:/i.test(u)) return u;
    if (/^https?:\/\//i.test(u)) return u;
    if (kind === 'link' && /^(mailto:|tel:|#)/i.test(u)) return u;
    if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) return u; // relative path
    return '';
  }

  // Tags a text block may contain; others are unwrapped (text kept) or dropped.
  const RICH_TEXT_TAGS = {
    P: 'p', BR: 'br', STRONG: 'strong', B: 'strong', EM: 'em', I: 'em', U: 'u',
    H1: 'h2', H2: 'h2', H3: 'h3', H4: 'h3', UL: 'ul', OL: 'ol', LI: 'li',
    A: 'a', BLOCKQUOTE: 'blockquote', DIV: 'p',
  };
  const DROP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'TEMPLATE', 'NOSCRIPT',
    'SVG', 'MATH', 'FORM', 'INPUT', 'BUTTON', 'SELECT', 'TEXTAREA', 'LINK', 'META', 'HEAD', 'TITLE',
  ]);

  /** Keep only simple semantic tags; links keep a safe href only. */
  function sanitizeRichText(dirtyHtml) {
    const tpl = document.createElement('template');
    tpl.innerHTML = String(dirtyHtml ?? '');
    const out = document.createElement('div');

    (function copyChildren(from, to) {
      for (const node of Array.from(from.childNodes)) {
        if (node.nodeType === Node.TEXT_NODE) {
          to.appendChild(document.createTextNode(node.nodeValue));
          continue;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) continue;

        const tag = node.tagName.toUpperCase();
        if (DROP_TAGS.has(tag)) continue;

        const cleanTag = RICH_TEXT_TAGS[tag];
        if (!cleanTag) { copyChildren(node, to); continue; }

        const el = document.createElement(cleanTag);
        if (cleanTag === 'a') {
          const href = safeUrl(node.getAttribute('href'), 'link');
          if (!href) { copyChildren(node, to); continue; }
          el.setAttribute('href', href);
          if (/^https?:/i.test(href)) el.setAttribute('rel', 'noopener');
        }
        copyChildren(node, el);
        to.appendChild(el);
      }
    })(tpl.content, out);

    // Drop empty paragraphs browsers leave behind (<p><br></p>).
    out.querySelectorAll('p, h2, h3, li').forEach((el) => {
      if (!el.textContent.trim() && !el.querySelector('br')) el.remove();
    });
    return out.innerHTML.trim();
  }

  function isBlankText(el) {
    return !el.textContent.replace(/​/g, '').trim();
  }

  function toInt(value, fallback) {
    const n = parseInt(value, 10);
    return Number.isFinite(n) ? n : fallback;
  }

  /* ========================================================================
     3. WIDGET REGISTRY
     Every block type describes itself with five small functions:
       defaultData()        → data for a brand-new block
       createEditor(data)   → DOM for editing it on the canvas
       readData(bodyEl)     → data, read back out of that DOM
       renderStatic(data)   → { tag, inner, className? } for the live site
       parseStatic(el)      → data, read back out of a published element
     ======================================================================== */

  const WIDGETS = {

    text: {
      label: 'Text',
      defaultSize: { w: 6, h: 3 },
      minSize: { w: 2, h: 1 },
      defaultData: () => ({ html: '' }),

      createEditor(data) {
        const el = document.createElement('div');
        el.className = 'block__content text-editor';
        el.contentEditable = 'true';
        el.spellcheck = true;
        el.dataset.placeholder = 'Click here and start typing…';
        el.innerHTML = sanitizeRichText(data.html);

        const refreshEmpty = () => el.classList.toggle('is-empty', isBlankText(el));
        refreshEmpty();
        el.addEventListener('input', refreshEmpty);

        // Paste as plain text so no hidden Word/website junk gets in.
        el.addEventListener('paste', (e) => {
          e.preventDefault();
          const text = (e.clipboardData || window.clipboardData).getData('text/plain');
          document.execCommand('insertText', false, text);
        });
        return el;
      },

      readData(body) {
        const el = body.querySelector('.text-editor');
        return { html: !el || isBlankText(el) ? '' : sanitizeRichText(el.innerHTML) };
      },

      renderStatic(data) {
        return { tag: 'section', inner: `<div class="block__content">${sanitizeRichText(data.html)}</div>` };
      },

      parseStatic(el) {
        const content = el.querySelector('.block__content') || el;
        return { html: sanitizeRichText(content.innerHTML) };
      },
    },

    image: {
      label: 'Photo',
      defaultSize: { w: 6, h: 5 },
      minSize: { w: 2, h: 2 },
      defaultData: () => ({ src: '', caption: '' }),

      createEditor(data) {
        const wrap = document.createElement('div');
        wrap.className = 'image-editor';
        // _src is what gets saved: normally a repo path like
        // "assets/images/20261109-153012-roses.jpg" (relative, so it works
        // on GitHub Pages). For display it is resolved to a real URL.
        wrap._src = safeUrl(data.src, 'image');
        wrap._caption = data.caption || '';

        const usePhoto = (path) => {
          wrap._src = path;
          render();
          markDirty();
        };

        // Clicking the box opens the photo library (upload or reuse).
        const chooseFromLibrary = () => openMediaLibrary({ current: wrap._src, onPick: usePhoto });

        // Dropping a file from the desktop uploads it directly.
        const uploadDropped = async (file) => {
          try {
            usePhoto(await uploadPhoto(file));
          } catch (err) {
            reportPhotoError(err);
          }
        };

        const render = () => {
          wrap.innerHTML = '';
          if (wrap._src) {
            const media = document.createElement('div');
            media.className = 'block__media';
            const img = document.createElement('img');
            img.alt = wrap._caption || 'Photo';
            img.draggable = false;
            showImage(img, wrap._src);
            media.appendChild(img);

            const change = document.createElement('button');
            change.type = 'button';
            change.className = 'image-change';
            change.textContent = '🔄 Change photo';
            change.addEventListener('click', chooseFromLibrary);
            media.appendChild(change);

            const caption = document.createElement('input');
            caption.type = 'text';
            caption.className = 'image-caption';
            caption.placeholder = 'Write a caption (optional)';
            caption.maxLength = 200;
            caption.value = wrap._caption;
            caption.addEventListener('input', () => {
              wrap._caption = caption.value;
              img.alt = caption.value || 'Photo';
            });
            wrap.append(media, caption);
          } else {
            const empty = document.createElement('button');
            empty.type = 'button';
            empty.className = 'image-empty';
            empty.innerHTML =
              '<span class="image-empty__icon" aria-hidden="true">📷</span>' +
              '<strong>Add a photo</strong>' +
              '<small>Click to pick one of your photos or add a new one</small>';
            empty.addEventListener('click', chooseFromLibrary);
            wrap.appendChild(empty);
          }
        };

        // Drop a photo file from the desktop straight onto the box.
        wrap.addEventListener('dragover', (e) => {
          if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) {
            e.preventDefault();
            wrap.classList.add('is-dragover');
          }
        });
        wrap.addEventListener('dragleave', () => wrap.classList.remove('is-dragover'));
        wrap.addEventListener('drop', (e) => {
          wrap.classList.remove('is-dragover');
          const file = e.dataTransfer && e.dataTransfer.files[0];
          if (file) { e.preventDefault(); uploadDropped(file); }
        });

        render();
        return wrap;
      },

      readData(body) {
        const wrap = body.querySelector('.image-editor');
        return { src: wrap ? wrap._src : '', caption: wrap ? wrap._caption.trim() : '' };
      },

      renderStatic(data) {
        const src = safeUrl(data.src, 'image');
        const caption = (data.caption || '').trim();
        if (!src) return { tag: 'figure', className: 'block--empty', inner: '<div class="block__media"></div>' };
        return {
          tag: 'figure',
          inner:
            `<div class="block__media"><img src="${escapeAttr(src)}" alt="${escapeAttr(caption || 'Photo')}" loading="lazy"></div>` +
            (caption ? `\n      <figcaption>${escapeHtml(caption)}</figcaption>` : ''),
        };
      },

      parseStatic(el) {
        const img = el.querySelector('img');
        const cap = el.querySelector('figcaption');
        return {
          src: img ? safeUrl(img.getAttribute('src'), 'image') : '',
          caption: cap ? cap.textContent.trim() : '',
        };
      },
    },
  };

  /**
   * Prepare a photo for upload: shrink it to a sensible size in the browser
   * (phone photos are often 5–10 MB) and return it as a JPEG/PNG Blob.
   * GIFs are kept as they are, so animations survive. SVG and other types
   * are refused: an uploaded SVG could carry scripts.
   */
  function resizeImage(file, maxSide) {
    return new Promise((resolve, reject) => {
      if (!file || !/^image\/(jpeg|png|gif|webp|heic|heif|avif|bmp)$/i.test(file.type)) {
        return reject(Object.assign(new Error('Not a photo'), { code: 'not-photo' }));
      }
      if (file.type === 'image/gif' && file.size < 5e6) return resolve(file);

      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(url);
        const type = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
        canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not convert photo'))), type, 0.85);
      };
      // e.g. iPhone HEIC photos in browsers that can't read them
      img.onerror = () => { URL.revokeObjectURL(url); reject(Object.assign(new Error('Could not read photo'), { code: 'unreadable' })); };
      img.src = url;
    });
  }

  const isRepoPath = (src) => !!src && !/^(data:|blob:|https?:)/i.test(src);

  /** A URL the browser can display for a saved src (repo paths are resolved). */
  function resolveImageUrl(src) {
    if (!isRepoPath(src)) return Promise.resolve(src);
    return service.getImageUrl(src.replace(/^\.?\//, ''), readRef());
  }

  /** Put a photo into an <img>, resolving repo paths in the background. */
  function showImage(img, src) {
    if (!isRepoPath(src)) { img.src = src; return; }
    img.classList.add('is-loading');
    resolveImageUrl(src)
      .then((url) => { img.src = url; })
      .catch((err) => { console.warn('Pebble: photo not found', src, err); img.classList.add('is-broken'); })
      .finally(() => img.classList.remove('is-loading'));
  }

  /* ========================================================================
     4. PAGE FORMAT — pure functions, no editor involved
     ======================================================================== */

  /** "about-me.html" → "About me" (used when a file has no name in it). */
  function nameFromFile(file) {
    if (file === CONFIG.homeFile) return 'Home';
    const base = String(file).replace(/\.html?$/i, '').replace(/[-_]+/g, ' ').trim();
    return base ? base[0].toUpperCase() + base.slice(1) : 'Page';
  }

  /** Reading order: top-to-bottom, then left-to-right. */
  function sortBlocks(blocks) {
    return blocks.slice().sort((a, b) => (a.y - b.y) || (a.x - b.x));
  }

  /**
   * One block → static HTML.
   *
   * The EXACT grid position is written twice:
   *   data-gs-*  → the "database" the editor reads back
   *   style      → native CSS Grid lines. Because the row line is explicit
   *                (grid-row: 10 / span 3), any empty rows above or between
   *                blocks are created by the browser, so free-form
   *                whitespace from the editor survives on the live site.
   */
  function renderBlock(b) {
    const { tag, inner, className } = WIDGETS[b.type].renderStatic(b.data);
    const classes = ['block', `block--${b.type}`, className].filter(Boolean).join(' ');
    const attrs = [
      `class="${classes}"`,
      `data-widget-type="${escapeAttr(b.type)}"`,
      `data-gs-x="${b.x}"`,
      `data-gs-y="${b.y}"`,
      `data-gs-w="${b.w}"`,
      `data-gs-h="${b.h}"`,
      `style="grid-column:${b.x + 1} / span ${b.w};grid-row:${b.y + 1} / span ${b.h}"`,
    ].join(' ');
    return `    <${tag} ${attrs}>\n      ${inner}\n    </${tag}>`;
  }

  /**
   * Page model + site context → complete standalone HTML document.
   *
   * @param {object} page   { file, name, blocks }
   * @param {object} site   { siteName, pages: [{ file, name }] }
   * @param {object} [opts]
   * @param {string} [opts.stylesheetHref='site.css']
   * @param {string} [opts.inlineCss]  embed the theme instead of linking it (preview)
   */
  function pageModelToHtml(page, site, opts = {}) {
    const stylesheet = opts.inlineCss != null
      ? `<style>\n${String(opts.inlineCss).replace(/<\/style/gi, '<\\/style')}\n  </style>`
      : `<link rel="stylesheet" href="${escapeAttr(opts.stylesheetHref || CONFIG.themeFile)}">`;

    const navLinks = site.pages.map((p) =>
      `      <a href="${escapeAttr(p.file)}"${p.file === page.file ? ' aria-current="page"' : ''}>${escapeHtml(p.name)}</a>`
    ).join('\n');

    const blocksHtml = sortBlocks(page.blocks).map(renderBlock).join('\n\n');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="generator" content="Pebble">
  <title>${escapeHtml(page.name)} – ${escapeHtml(site.siteName)}</title>
  ${stylesheet}
</head>
<body>
  <!--
    Made with Pebble. This is plain HTML: no database, no JavaScript.
    The data-widget-type and data-gs-* attributes let the editor re-open it.
  -->
  <header class="site-header">
    <a class="site-name" href="${CONFIG.homeFile}">${escapeHtml(site.siteName)}</a>
    <nav class="site-nav" aria-label="Pages">
${navLinks}
    </nav>
  </header>

  <main class="site-grid" data-pebble-grid data-columns="${CONFIG.columns}" data-page-name="${escapeAttr(page.name)}">
${blocksHtml}
  </main>
</body>
</html>
`;
  }

  /**
   * Raw HTML → page model (+ what the header says about the site).
   * Parsed in an inert DOMParser document: scripts never run, and all
   * content is re-sanitized by the widgets.
   *
   * @returns {{file, name, blocks, siteName: string|null, nav: string[]}}
   */
  function htmlToPageModel(html, file) {
    const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
    const root = doc.querySelector('[data-pebble-grid]') || doc.body;
    let elements = Array.from(root.querySelectorAll(':scope > [data-widget-type]'));
    if (!elements.length) elements = Array.from(root.querySelectorAll('[data-widget-type]'));

    const cols = CONFIG.columns;
    const blocks = [];
    let bottom = 0; // lowest row used so far — where position-less blocks go

    for (const el of elements) {
      const type = el.getAttribute('data-widget-type');
      const widget = WIDGETS[type];
      if (!widget) { console.warn(`Pebble: unknown block type "${type}" skipped`); continue; }

      // Clamp so a hand-edited file can't break the grid. y is kept exactly
      // as written: with free-form layout, whitespace above a block is intended.
      const w = Math.min(cols, Math.max(widget.minSize.w, toInt(el.getAttribute('data-gs-w'), widget.defaultSize.w)));
      const h = Math.max(widget.minSize.h, toInt(el.getAttribute('data-gs-h'), widget.defaultSize.h));
      const x = Math.min(cols - w, Math.max(0, toInt(el.getAttribute('data-gs-x'), 0)));
      const y = Math.max(0, toInt(el.getAttribute('data-gs-y'), bottom));

      blocks.push({ type, x, y, w, h, data: widget.parseStatic(el) });
      bottom = Math.max(bottom, y + h);
    }

    const titleName = (doc.title || '').split(' – ')[0].trim();
    const siteNameEl = doc.querySelector('.site-name');
    return {
      file,
      name: (root.getAttribute('data-page-name') || titleName || nameFromFile(file)).trim(),
      blocks,
      siteName: siteNameEl ? siteNameEl.textContent.trim() : null,
      nav: Array.from(doc.querySelectorAll('.site-nav a[href]')).map((a) => a.getAttribute('href')),
    };
  }

  /** Content fingerprint used to tell "did she actually change this page?" */
  function contentKey(model) {
    return JSON.stringify({ name: model.name, blocks: sortBlocks(model.blocks) });
  }

  /* ========================================================================
     5. EDITOR CANVAS
     ======================================================================== */

  let grid = null;         // the GridStack instance
  let isLoading = false;   // true while (re)building the canvas → no autosave

  const $ = (sel) => document.querySelector(sel);
  const canvasEl = () => $('#canvas');

  /**
   * DOM for one block, the way Gridstack expects it:
   *   <div class="grid-stack-item" gs-x gs-y gs-w gs-h data-widget-type>
   *     <div class="grid-stack-item-content block-shell">
   *       <div class="block-bar"> ✥ Move | 🗑 Remove </div>
   *       <div class="block-body"> …widget editor… </div>
   */
  function createBlockElement(type, data, pos) {
    const widget = WIDGETS[type];
    const item = document.createElement('div');
    item.className = 'grid-stack-item';
    item.dataset.widgetType = type;

    const size = { ...widget.defaultSize, ...pos };
    item.setAttribute('gs-x', size.x);
    item.setAttribute('gs-y', size.y);
    item.setAttribute('gs-w', size.w);
    item.setAttribute('gs-h', size.h);
    item.setAttribute('gs-min-w', widget.minSize.w);
    item.setAttribute('gs-min-h', widget.minSize.h);

    const shell = document.createElement('div');
    shell.className = 'grid-stack-item-content block-shell';

    const bar = document.createElement('div');
    bar.className = 'block-bar';
    bar.innerHTML =
      '<span class="block-handle" title="Hold and drag to move this box">✥ Move</span>' +
      '<button type="button" class="block-delete" title="Remove this box">🗑 Remove</button>';

    const body = document.createElement('div');
    body.className = 'block-body';
    body.appendChild(widget.createEditor({ ...widget.defaultData(), ...data }));

    shell.append(bar, body);
    item.appendChild(shell);
    return item;
  }

  /**
   * Add a block. Without a position it goes right under the lowest block
   * (not under the empty rows at the bottom of the canvas).
   */
  function addBlock(type, data, pos, opts = {}) {
    if (!WIDGETS[type]) { console.warn(`Pebble: unknown block type "${type}" skipped`); return null; }
    if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) {
      pos = { ...pos, x: 0, y: grid.engine.getRow() };
    }
    const el = createBlockElement(type, data, pos);
    canvasEl().appendChild(el);
    grid.makeWidget(el);

    if (opts.focus) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const editable = el.querySelector('.text-editor');
      if (editable) setTimeout(() => editable.focus(), 250);
    }
    refreshEmptyState();
    return el;
  }

  /** Remove a block, with "Undo" — it comes back at exactly the same spot. */
  function removeBlock(item) {
    const snapshot = readBlock(item);
    grid.removeWidget(item);
    refreshEmptyState();
    showToast('Box removed.', 'Undo', () => {
      addBlock(snapshot.type, snapshot.data, { x: snapshot.x, y: snapshot.y, w: snapshot.w, h: snapshot.h });
      markDirty();
    });
  }

  function refreshEmptyState() {
    const count = grid ? grid.getGridItems().length : 0;
    $('#paper').classList.toggle('is-empty', count === 0);
  }

  function readBlock(item) {
    const node = item.gridstackNode;
    const type = item.dataset.widgetType;
    return { type, x: node.x, y: node.y, w: node.w, h: node.h, data: WIDGETS[type].readData(item.querySelector('.block-body')) };
  }

  /** The page currently on the canvas, as a page model. */
  function getPageModel() {
    const blocks = grid.getGridItems()
      .filter((el) => el.gridstackNode && WIDGETS[el.dataset.widgetType] && el.querySelector('.block-body'))
      .map(readBlock);
    return { file: store.current, name: currentPageName(), blocks: sortBlocks(blocks) };
  }

  /** Clear the canvas and build the given page model on it. */
  function loadPageModel(model) {
    isLoading = true;
    try {
      // Clear OUTSIDE batchUpdate(): inside a batch Gridstack drops its nodes
      // but defers removing the DOM, so old blocks would linger. Then sweep
      // anything left over, so switching pages always starts from blank.
      grid.removeAll(true, false);
      canvasEl().querySelectorAll(':scope > .grid-stack-item').forEach((el) => el.remove());

      grid.batchUpdate();
      for (const b of model.blocks) addBlock(b.type, b.data, { x: b.x, y: b.y, w: b.w, h: b.h });
      grid.batchUpdate(false);
      $('#page-title').value = model.name || '';
    } finally {
      isLoading = false;
      refreshEmptyState();
    }
  }

  /* ========================================================================
     6. SITE STORE — which pages exist, what's published, what's a draft
     ------------------------------------------------------------------------
     Each page entry:
       { file:   "about.html",
         remote: { html, sha } | null   ← version in the repo's draft branch
                                          (or live branch, before any draft exists)
         draft:  "<html…>"     | null   ← local edits not saved to the repo yet
         live:   true | false }         ← does the page exist on the live site?

     remote === null  → new page, never saved.   live === false → "New" badge.
     Local edits are kept in localStorage in the same HTML format as the repo.
     ======================================================================== */

  let service = null; // GitHubService (or MockGitHubService in the demo)

  const store = {
    siteName: 'My website', // as saved in the repo (read from index.html's header)
    siteNameDraft: null,    // local, unsaved rename of the site
    pages: [],              // page entries, in menu order
    current: null,          // file open in the editor
    theme: '',              // site.css from the repo
    hasDraftBranch: false,  // the draft branch exists in the repo
    draftAhead: false,      // the saved draft has things that aren't live yet
  };

  /** Branch the editor reads from: the draft once it exists, else live. */
  const readRef = () => (store.hasDraftBranch ? service.draftBranch : service.liveBranch);

  const getEntry = (file) => store.pages.find((p) => p.file === file);
  const entryHtml = (e) => e.draft ?? (e.remote ? e.remote.html : '');

  // Parsing is cheap but not free; cache by exact HTML.
  const modelCache = new Map();
  function parseCached(html, file) {
    const key = file + '\u0000' + html;
    if (!modelCache.has(key)) {
      if (modelCache.size > 60) modelCache.clear();
      modelCache.set(key, htmlToPageModel(html, file));
    }
    return modelCache.get(key);
  }

  /** Model of any page — the open one is read live from the canvas. */
  function entryModel(e) {
    if (e.file === store.current && !isLoading) return getPageModel();
    return parseCached(entryHtml(e), e.file);
  }

  function currentPageName() {
    return $('#page-title').value.trim() || nameFromFile(store.current || '');
  }

  function currentSiteName() {
    return (store.siteNameDraft ?? store.siteName) || 'My website';
  }

  /** The header + menu shared by every page. */
  function siteContext() {
    return {
      siteName: currentSiteName(),
      pages: store.pages.map((e) => ({ file: e.file, name: entryModel(e).name })),
    };
  }

  /** Every page whose HTML would change if we published right now. */
  function pendingChanges() {
    const site = siteContext();
    return store.pages
      .map((e) => ({ entry: e, html: pageModelToHtml(entryModel(e), site) }))
      .filter(({ entry, html }) => !entry.remote || html !== entry.remote.html);
  }

  const draftKey = () => `pebble:drafts:${service.fullName}`;
  const lastPageKey = () => `pebble:last-page:${service.fullName}`;

  function loadDrafts() {
    try { return JSON.parse(localStorage.getItem(draftKey()) || 'null') || {}; } catch { return {}; }
  }

  /** Write all drafts to localStorage. Returns false if it didn't fit. */
  function persistDrafts() {
    const pages = {};
    for (const e of store.pages) if (e.draft != null) pages[e.file] = e.draft;
    try {
      localStorage.setItem(draftKey(), JSON.stringify({ siteName: store.siteNameDraft, pages }));
      return true;
    } catch (err) {
      console.warn('Pebble: drafts not saved', err);
      return false;
    }
  }

  /** Copy the canvas into the current page's draft. */
  function saveCurrentPage() {
    const e = getEntry(store.current);
    if (!e) return true;
    const model = getPageModel();
    const unchanged = e.remote && contentKey(model) === contentKey(parseCached(e.remote.html, e.file));
    e.draft = unchanged ? null : pageModelToHtml(model, siteContext());
    return persistDrafts();
  }

  /** Menu order: Home first, then the order of index.html's menu, then A–Z. */
  function sortPages(navOrder) {
    const rank = (f) => (f === CONFIG.homeFile ? -1 : navOrder.includes(f) ? navOrder.indexOf(f) : 1e6);
    store.pages.sort((a, b) => (rank(a.file) - rank(b.file)) || a.file.localeCompare(b.file));
  }

  /* ========================================================================
     7. PAGES — open / switch / add
     ======================================================================== */

  let isSwitching = false;

  /**
   * Show a page in the editor:
   *   1. keep the current page's edits as a draft,
   *   2. fetch the latest copy of the page from the repo (unless she has a
   *      draft of it — her unpublished work wins),
   *   3. clear the canvas and deserialize the page onto it.
   */
  async function openPage(file, { fetch = true } = {}) {
    const entry = getEntry(file);
    if (!entry || isSwitching) return;
    isSwitching = true;
    if (store.current) flushSave();
    showLoading('Opening your page…');
    try {
      if (fetch && entry.remote && entry.draft == null) {
        try {
          const fresh = await service.fetchPage(file, readRef());
          entry.remote = { html: fresh.content, sha: fresh.sha };
        } catch (err) {
          console.warn('Pebble: using cached copy of', file, err);
        }
      }
      store.current = file;
      loadPageModel(parseCached(entryHtml(entry), file));
      try { localStorage.setItem(lastPageKey(), file); } catch { /* ignore */ }
    } finally {
      hideLoading();
      isSwitching = false;
      renderPageList();
      renderPaperHeader();
      updateSaveStatus();
      $('.canvas-area').scrollTop = 0;
    }
  }

  /** "My Recipes!" → "my-recipes" */
  function slugify(name) {
    return String(name)
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/, '') || 'page';
  }

  /** A file name for a new page that isn't taken yet. */
  function fileNameFor(name) {
    const base = slugify(name);
    let file = `${base}.html`;
    for (let i = 2; file === CONFIG.homeFile || getEntry(file); i++) file = `${base}-${i}.html`;
    return file;
  }

  /** Add a new, blank, unpublished page and open it. */
  async function createPage(name) {
    name = name.trim();
    if (!name) return;
    const file = fileNameFor(name);
    const entry = { file, remote: null, draft: null, live: false };
    store.pages.push(entry);
    entry.draft = pageModelToHtml({ file, name, blocks: [] }, siteContext());
    persistDrafts();
    await openPage(file, { fetch: false });
    showToast(`Your new page “${name}” is ready. Drag boxes onto it!`);
  }

  /* ========================================================================
     8. PUBLIC API — serialize / deserialize the open page
     ======================================================================== */

  /**
   * serializeToStaticHTML()
   * Turn the editor into a complete standalone HTML page. Everything that
   * only exists for editing (Gridstack classes, gs-* attributes, resize
   * handles, Move/Remove bars, contenteditable, inputs) is left out; each
   * block becomes one semantic element with data-* attributes + CSS Grid
   * placement. See renderBlock() and pageModelToHtml().
   */
  function serializeToStaticHTML(opts = {}) {
    return pageModelToHtml(getPageModel(), siteContext(), opts);
  }

  /**
   * deserializeToEditor(htmlString)
   * Read raw HTML (e.g. fetched from the repo), find every [data-widget-type]
   * element, read its data-gs-* position and content, and rebuild the
   * Gridstack canvas — whitespace and all.
   */
  function deserializeToEditor(htmlString) {
    const model = htmlToPageModel(htmlString, store.current);
    loadPageModel(model);
    renderPaperHeader();
    return model;
  }

  /* ========================================================================
     9. AUTOSAVE — drafts in this browser, so nothing is ever lost
     ======================================================================== */

  let saveTimer = null;

  function markDirty() {
    if (isLoading) return;
    $('#save-status').textContent = 'Saving…';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, CONFIG.autosaveDelay);
  }

  function flushSave() {
    clearTimeout(saveTimer);
    saveTimer = null;
    const ok = saveCurrentPage();
    renderPageList();
    updateSaveStatus(ok);
  }

  /**
   * One short sentence about where her work stands. No jargon:
   *   unsaved local edits      → "Changes not saved yet"
   *   saved draft, not live    → "Draft saved · not live yet"
   *   everything live          → "Your website is up to date"
   */
  function updateSaveStatus(ok = true) {
    const el = $('#save-status');
    el.classList.toggle('is-error', !ok);
    if (!ok) { el.textContent = "⚠ Couldn't keep your changes on this computer (storage is full)"; return; }
    const unsaved = pendingChanges().length > 0;
    el.textContent = unsaved ? '● Changes not saved yet'
      : store.draftAhead ? '✓ Draft saved · not live yet'
      : '✓ Your website is up to date';
    el.classList.toggle('is-unsaved', unsaved);
  }

  /* ========================================================================
     10. SAVE DRAFT & PUBLISH LIVE
     ------------------------------------------------------------------------
     Save draft:   re-render every page with the current site context and
                   commit each one whose HTML changed to the draft branch
                   (created from live on first use).
     Publish live: save the draft first, then merge draft → live. GitHub
                   Pages rebuilds the public site from live.
     The words "branch", "commit" and "merge" never reach the screen.
     ======================================================================== */

  let isBusy = false;

  /** Disable both buttons and show a spinner in the one that was clicked. */
  function setBusy(which, label) {
    isBusy = !!which;
    const buttons = { save: $('#btn-save'), publish: $('#btn-publish') };
    for (const [key, btn] of Object.entries(buttons)) {
      btn.disabled = isBusy;
      if (!btn.dataset.label) btn.dataset.label = btn.innerHTML;
      btn.innerHTML = key === which
        ? `<span class="spinner spinner--small${key === 'save' ? ' spinner--dark' : ''}" aria-hidden="true"></span> ${label}`
        : btn.dataset.label;
    }
  }

  /** Friendly words for anything that went wrong while talking to GitHub. */
  function friendlyError(err, action) {
    console.error(`Pebble: ${action} failed`, err);
    if (err && err.status === 409) return 'Your website was changed somewhere else (maybe on another computer). Please reload the page, then try again — your changes on this computer are kept.';
    if (err && (err.status === 401 || err.status === 403)) return 'Pebble lost its connection to your website. Please sign in again.';
    if (err instanceof TypeError) return "You seem to be offline. Your changes are kept on this computer — try again when you're connected.";
    return `Sorry, ${action} didn't work. Your changes are kept on this computer. Please try again in a moment.`;
  }

  /**
   * Commit every changed page to the draft branch.
   * @returns {Promise<Array<{name, file, isNew}>>} the pages that were saved
   */
  async function commitChangesToDraft() {
    flushSave();
    const changes = pendingChanges();
    const saved = [];
    for (const { entry, html } of changes) {
      const name = entryModel(entry).name;
      const isNew = !entry.remote;
      const result = await service.commitPage(entry.file, html, {
        message: isNew ? `Add page “${name}”` : `Update page “${name}”`,
        sha: entry.remote ? entry.remote.sha : undefined,
      });
      entry.remote = { html, sha: result.sha };
      entry.draft = null;
      saved.push({ name, file: entry.file, isNew });
      persistDrafts(); // keep local state in step, even if a later page fails
    }
    if (changes.length) {
      store.siteName = currentSiteName();
      store.siteNameDraft = null;
      store.hasDraftBranch = true;
      store.draftAhead = true;
      persistDrafts();
    }
    return saved;
  }

  /** "Save draft" button. */
  async function saveDraft() {
    if (isBusy) return;
    flushSave();
    if (!pendingChanges().length) {
      showToast(store.draftAhead ? 'Your draft is already saved. Press “Publish live” when you’re ready.' : 'Nothing new to save — your website is up to date.');
      return;
    }
    setBusy('save', 'Saving…');
    try {
      await commitChangesToDraft();
      showToast('Draft saved. Only you can see it until you press “Publish live”.');
    } catch (err) {
      showToast(friendlyError(err, 'saving'));
    } finally {
      setBusy(null);
      renderPageList();
      updateSaveStatus();
    }
  }

  /** "Publish live" button: save the draft, then make it live. */
  async function publishLive() {
    if (isBusy) return;
    setBusy('publish', 'Publishing…');
    try {
      await commitChangesToDraft();

      // What's in the draft that isn't live yet? (also catches photos and
      // drafts saved earlier, perhaps on another computer)
      const diff = await service.compareDraftToLive();
      if (!diff.ahead) {
        store.draftAhead = false;
        showToast('Your website is already up to date. 👍');
        return;
      }

      let result;
      try {
        result = await service.publishDraft('Publish website');
      } catch (err) {
        if (err.status !== 409) throw err;
        // The live site was changed elsewhere and clashes with her draft.
        // Ask, in plain words, whether her version should win.
        setBusy(null);
        if (!(await askToReplaceOtherChanges())) {
          showToast('Nothing was changed on your website. Your draft is still saved.');
          return;
        }
        setBusy('publish', 'Publishing…');
        result = await service.forcePublishDraft('Publish website');
        await refreshSavedPages();
      }
      store.draftAhead = false;

      const changedPages = diff.files.filter((f) => /\.html$/.test(f.path) && f.status !== 'removed');
      const newPhotos = diff.files.filter((f) => f.path.startsWith(service.imageDir + '/') && f.status === 'added').length;
      const items = changedPages.map((f) => {
        const entry = getEntry(f.path);
        const item = { name: entry ? entryModel(entry).name : nameFromFile(f.path), isNew: entry ? !entry.live : f.status === 'added' };
        if (entry) entry.live = true;
        return item;
      });
      console.info('Pebble ▸ published', result, diff.files);
      showPublishDone(items, newPhotos);
    } catch (err) {
      showToast(friendlyError(err, 'publishing'));
    } finally {
      setBusy(null);
      renderPageList();
      updateSaveStatus();
    }
  }

  /** "Publish your version anyway?" → Promise<boolean> */
  function askToReplaceOtherChanges() {
    return new Promise((resolve) => {
      const dialog = $('#conflict-dialog');
      const form = dialog.querySelector('form');
      const onSubmit = (e) => {
        e.preventDefault();
        form.removeEventListener('submit', onSubmit);
        dialog.removeEventListener('cancel', onCancel);
        dialog.close();
        resolve(!!(e.submitter && e.submitter.value === 'replace'));
      };
      const onCancel = () => {
        form.removeEventListener('submit', onSubmit);
        dialog.removeEventListener('cancel', onCancel);
        resolve(false);
      };
      form.addEventListener('submit', onSubmit);
      dialog.addEventListener('cancel', onCancel); // Esc key
      dialog.showModal();
    });
  }

  /**
   * After the draft was rebuilt from live (forced publish), refresh the
   * saved copy of every page so the next save uses the latest versions.
   * Her local, unsaved edits are kept.
   */
  async function refreshSavedPages() {
    await Promise.all(store.pages.filter((e) => e.remote).map(async (e) => {
      try {
        const fresh = await service.fetchPage(e.file, readRef());
        e.remote = { html: fresh.content, sha: fresh.sha };
      } catch (err) {
        if (err.status === 404) e.remote = null; else throw err;
      }
    }));
    modelCache.clear();
  }

  function showPublishDone(pages, newPhotos) {
    const rows = pages.map((p) => `<li>${escapeHtml(p.name)}${p.isNew ? ' <span class="tag">new</span>' : ''}</li>`);
    if (newPhotos) rows.push(`<li>${newPhotos} new photo${newPhotos > 1 ? 's' : ''}</li>`);
    if (!rows.length) rows.push('<li>Your latest changes</li>');
    $('#publish-list').innerHTML = rows.join('');
    const link = $('#publish-url');
    link.href = service.siteUrl;
    link.textContent = service.siteUrl.replace(/^https:\/\//, '').replace(/\/$/, '');
    $('#publish-demo-note').hidden = !service.isDemo;
    $('#publish-dialog').showModal();
  }

  /* ========================================================================
     11. PHOTOS — upload to the repo + media library
     ------------------------------------------------------------------------
     Uploads go straight to assets/images/ in the draft (so they're safe
     right away and appear in the library), and the block stores the
     relative path, e.g. "assets/images/20261109-153012-roses.jpg", which
     works as-is on GitHub Pages because pages live in the repo root.
     ======================================================================== */

  /**
   * Shrink and upload a photo file. Returns its repo path.
   * Throws with a friendly .code for files that aren't usable photos.
   */
  async function uploadPhoto(file) {
    const blob = await resizeImage(file, CONFIG.maxImageSide);
    const { path } = await service.uploadImage(blob, { name: file.name });
    store.hasDraftBranch = true;
    store.draftAhead = true;
    updateSaveStatus();
    return path;
  }

  function reportPhotoError(err) {
    if (err && err.code === 'not-photo') showToast('That file isn’t a photo. Please choose a JPG or PNG picture.');
    else if (err && err.code === 'unreadable') showToast('Sorry, this photo can’t be opened here. Try saving it as a JPG first.');
    else showToast(friendlyError(err, 'adding the photo'));
  }

  const mediaState = { onPick: null, current: '' };

  /**
   * Open the photo library.
   * @param {object} opts
   * @param {string} [opts.current]  path of the photo the block shows now
   * @param {function(string)} opts.onPick  called with the chosen photo's path
   */
  function openMediaLibrary({ current = '', onPick }) {
    mediaState.onPick = onPick;
    mediaState.current = current;
    $('#media-dialog').showModal();
    loadMediaLibrary();
  }

  /** Fetch /assets/images/ from the repo and draw the thumbnail grid. */
  async function loadMediaLibrary() {
    const grid = $('#media-grid');
    const status = $('#media-status');
    grid.innerHTML = '';
    status.hidden = false;
    status.innerHTML = '<span class="spinner" aria-hidden="true"></span> Finding your photos…';
    try {
      const images = await service.fetchImageLibrary(readRef());
      renderMediaGrid(images);
      status.hidden = images.length > 0;
      if (!images.length) status.textContent = 'No photos yet. Add your first one above!';
    } catch (err) {
      console.error('Pebble: photo library failed', err);
      status.innerHTML = 'Sorry, your photos could not be loaded. <button type="button" class="link-btn link-btn--inline" id="media-retry">Try again</button>';
      $('#media-retry').addEventListener('click', loadMediaLibrary);
    }
  }

  function renderMediaGrid(images) {
    const grid = $('#media-grid');
    grid.innerHTML = '';
    for (const image of images) grid.appendChild(createMediaThumb(image));
  }

  function createMediaThumb({ path, name }) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'media-thumb' + (path === mediaState.current ? ' is-current' : '');
    btn.dataset.path = path;
    btn.title = 'Use this photo';

    const img = document.createElement('img');
    img.alt = '';
    showImage(img, path);

    const label = document.createElement('span');
    label.className = 'media-thumb__label';
    label.textContent = path === mediaState.current ? '✓ In use here' : prettyPhotoName(name);

    btn.append(img, label);
    return btn;
  }

  /** "20261109-153012-my-roses.jpg" → "my roses" */
  function prettyPhotoName(name) {
    return name.replace(/^\d{8}-\d{6}-/, '').replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ');
  }

  function pickFromLibrary(path) {
    $('#media-dialog').close();
    const cb = mediaState.onPick;
    mediaState.onPick = null;
    if (cb) cb(path);
  }

  /** Upload from inside the library: show a placeholder tile, then use it. */
  async function uploadFromLibrary(file) {
    if (!file) return;
    const grid = $('#media-grid');
    const tile = document.createElement('div');
    tile.className = 'media-thumb media-thumb--uploading';
    tile.innerHTML = '<span class="spinner" aria-hidden="true"></span><span class="media-thumb__label">Adding your photo…</span>';
    grid.prepend(tile);
    $('#media-status').hidden = true;
    try {
      const path = await uploadPhoto(file);
      tile.remove();
      pickFromLibrary(path);
      showToast('Photo added. ✓');
    } catch (err) {
      tile.remove();
      if (!grid.children.length) loadMediaLibrary();
      reportPhotoError(err);
    }
  }

  function wireMediaLibrary() {
    const dialog = $('#media-dialog');
    const input = $('#file-image');
    const drop = $('#media-upload');

    $('#media-upload-btn').addEventListener('click', () => { input.value = ''; input.click(); });
    input.addEventListener('change', () => uploadFromLibrary(input.files[0]));

    $('#media-grid').addEventListener('click', (e) => {
      const thumb = e.target.closest('.media-thumb[data-path]');
      if (thumb) pickFromLibrary(thumb.dataset.path);
    });

    // Drag a file from the desktop onto the upload area.
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('is-dragover'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('is-dragover'));
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      drop.classList.remove('is-dragover');
      uploadFromLibrary(e.dataTransfer && e.dataTransfer.files[0]);
    });

    dialog.addEventListener('close', () => { mediaState.onPick = null; });
  }

  /* ========================================================================
     12. UI WIRING
     ======================================================================== */

  /* ---------- Small helpers: toast, loading ---------- */

  let toastTimer = null;
  function showToast(message, actionLabel, onAction) {
    const toast = $('#toast');
    const action = toast.querySelector('.toast__action');
    toast.querySelector('.toast__msg').textContent = message;
    action.hidden = !actionLabel;
    action.textContent = actionLabel || '';
    action.onclick = () => { toast.hidden = true; onAction && onAction(); };
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.hidden = true; }, actionLabel ? 7000 : Math.max(4000, message.length * 60));
  }

  function showLoading(message) {
    $('#loading .loading__msg').textContent = message;
    $('#loading').hidden = false;
  }
  function hideLoading() { $('#loading').hidden = true; }

  /** Put the repo's site.css into the editor so the canvas looks like the site. */
  function applyTheme(css) {
    store.theme = css || '';
    $('#site-theme').textContent = store.theme;
  }

  /* ---------- Page list (sidebar) & site header (on the paper) ---------- */

  function renderPageList() {
    const list = $('#page-list');
    const site = siteContext();
    list.innerHTML = '';
    site.pages.forEach((p) => {
      const entry = getEntry(p.file);
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'page-item' + (p.file === store.current ? ' is-current' : '');
      btn.dataset.file = p.file;
      if (p.file === store.current) btn.setAttribute('aria-current', 'page');

      const icon = document.createElement('span');
      icon.className = 'page-item__icon';
      icon.setAttribute('aria-hidden', 'true');
      icon.textContent = p.file === CONFIG.homeFile ? '🏠' : '📄';

      const label = document.createElement('span');
      label.className = 'page-item__name';
      label.textContent = p.name;

      btn.append(icon, label);
      if (entry.draft != null) {
        btn.insertAdjacentHTML('beforeend', '<span class="page-item__dot" title="Changes not saved yet"></span>');
      }
      if (!entry.live) {
        btn.insertAdjacentHTML('beforeend', '<span class="page-item__badge" title="This page is not on your website yet">New</span>');
      }
      li.appendChild(btn);
      list.appendChild(li);
    });
  }

  /** The site's header (name + menu) shown on top of the paper, editable in place. */
  function renderPaperHeader() {
    const site = siteContext();
    const nameInput = $('#site-name');
    if (document.activeElement !== nameInput) nameInput.value = site.siteName;
    $('#paper-nav').innerHTML = site.pages.map((p) =>
      `<a href="${escapeAttr(p.file)}" data-file="${escapeAttr(p.file)}"${p.file === store.current ? ' aria-current="page"' : ''}>${escapeHtml(p.name)}</a>`
    ).join('');
  }

  /* ---------- Text style bar ---------- */

  function activeTextEditor() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    const node = sel.anchorNode;
    const el = node && (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement);
    return el ? el.closest('.text-editor') : null;
  }

  const FORMAT_COMMANDS = {
    title:    () => document.execCommand('formatBlock', false, 'h2'),
    subtitle: () => document.execCommand('formatBlock', false, 'h3'),
    normal:   () => document.execCommand('formatBlock', false, 'p'),
    bold:     () => document.execCommand('bold'),
    italic:   () => document.execCommand('italic'),
    list:     () => document.execCommand('insertUnorderedList'),
    link:     () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) {
        showToast('First select (highlight) the words you want to turn into a link.');
        return;
      }
      const range = sel.getRangeAt(0);
      let url = window.prompt('Paste the website address for this link:', 'https://');
      if (!url || url === 'https://') return;
      url = url.trim();
      if (!/^(https?:|mailto:|#|\/)/i.test(url) && !/^[a-z0-9-]+\.html$/i.test(url)) url = 'https://' + url;
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand('createLink', false, safeUrl(url, 'link'));
    },
  };

  function updateFormatBar() {
    const bar = $('#formatbar');
    const editor = activeTextEditor();
    bar.classList.toggle('is-active', !!editor);
    const states = { bold: 'bold', italic: 'italic', list: 'insertUnorderedList' };
    let block = '';
    try { block = editor ? String(document.queryCommandValue('formatBlock')).toLowerCase() : ''; } catch { /* ignore */ }
    bar.querySelectorAll('button[data-cmd]').forEach((btn) => {
      const cmd = btn.dataset.cmd;
      let on = false;
      if (editor && states[cmd]) { try { on = document.queryCommandState(states[cmd]); } catch { /* ignore */ } }
      if (editor && cmd === 'title') on = block === 'h2';
      if (editor && cmd === 'subtitle') on = block === 'h3';
      btn.classList.toggle('is-on', on);
    });
  }

  function wireFormatBar() {
    const bar = $('#formatbar');
    bar.addEventListener('mousedown', (e) => { if (e.target.closest('button[data-cmd]')) e.preventDefault(); });
    bar.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-cmd]');
      if (!btn) return;
      const editor = activeTextEditor();
      if (!editor) { showToast('First click inside a text box, then choose a style.'); return; }
      FORMAT_COMMANDS[btn.dataset.cmd]();
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      updateFormatBar();
    });
    document.addEventListener('selectionchange', updateFormatBar);
    try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch { /* ignore */ }
  }

  /* ---------- Sidebar: pages + add boxes ---------- */

  function wireSidebar() {
    // Switch page from the sidebar list, or from the menu on the paper.
    $('#page-list').addEventListener('click', (e) => {
      const btn = e.target.closest('.page-item');
      if (btn && btn.dataset.file !== store.current) openPage(btn.dataset.file);
    });
    $('#paper-nav').addEventListener('click', (e) => {
      const a = e.target.closest('a[data-file]');
      if (!a) return;
      e.preventDefault();
      if (a.dataset.file !== store.current) openPage(a.dataset.file);
    });

    // "Add a new page" dialog. The web address is shown as she types.
    const dialog = $('#newpage-dialog');
    const nameInput = $('#newpage-name');
    $('#btn-add-page').addEventListener('click', () => {
      nameInput.value = '';
      $('#newpage-file').textContent = '…';
      dialog.showModal();
      nameInput.focus();
    });
    nameInput.addEventListener('input', () => {
      $('#newpage-file').textContent = nameInput.value.trim() ? fileNameFor(nameInput.value) : '…';
    });
    // Handle the form's submit (more dependable than the dialog's 'close'
    // event, which some browsers deliver late or not at all).
    dialog.querySelector('form').addEventListener('submit', (e) => {
      const create = e.submitter && e.submitter.value === 'create';
      e.preventDefault();
      dialog.close();
      if (create) createPage(nameInput.value);
    });

    // Drag a tile onto the canvas. Gridstack drops a *copy* of the tile;
    // swap it for a real block at exactly the spot she dropped it.
    GridStack.setupDragIn('.sidebar .add-tile', { appendTo: 'body', helper: 'clone' });
    grid.on('dropped', (_event, _previousNode, newNode) => {
      if (!newNode || !newNode.el) return;
      const { el, x, y } = newNode;
      const type = el.dataset.widgetType;
      grid.removeWidget(el, true, false);
      if (addBlock(type, null, { x, y }, { focus: true })) markDirty();
    });

    // Or just click a tile: it's added under the lowest box.
    document.querySelectorAll('.sidebar .add-tile').forEach((tile) => {
      const add = () => { addBlock(tile.dataset.widgetType, null, null, { focus: true }); markDirty(); };
      tile.addEventListener('click', add);
      tile.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); add(); }
      });
    });
  }

  /* ---------- Preview: the real HTML, menu links work between pages ---------- */

  function wirePreview() {
    const dialog = $('#preview-dialog');
    const frame = $('#preview-frame');

    // The preview has no address of its own, so relative photo paths
    // ("assets/images/…") are swapped for URLs the browser can load.
    const showInFrame = async (file) => {
      flushSave();
      const entry = getEntry(file);
      if (!entry) return;
      const model = entryModel(entry);
      const blocks = await Promise.all(model.blocks.map(async (b) => {
        if (b.type !== 'image' || !isRepoPath(b.data.src)) return b;
        const src = await resolveImageUrl(b.data.src).catch(() => b.data.src);
        return { ...b, data: { ...b.data, src } };
      }));
      frame.srcdoc = pageModelToHtml({ ...model, blocks }, siteContext(), { inlineCss: store.theme });
    };

    // srcdoc has no real address, so catch menu clicks and render that page.
    frame.addEventListener('load', () => {
      const doc = frame.contentDocument;
      if (!doc) return;
      doc.addEventListener('click', (e) => {
        const a = e.target.closest('a[href]');
        if (!a) return;
        e.preventDefault();
        const href = a.getAttribute('href');
        if (getEntry(href)) showInFrame(href);
        else if (/^https?:/i.test(href)) window.open(href, '_blank', 'noopener');
      });
    });

    $('#btn-preview').addEventListener('click', () => {
      showInFrame(store.current);
      dialog.showModal();
    });

    dialog.querySelectorAll('[data-device]').forEach((btn) => {
      btn.addEventListener('click', () => {
        dialog.querySelectorAll('[data-device]').forEach((b) => b.classList.toggle('is-active', b === btn));
        frame.classList.toggle('is-phone', btn.dataset.device === 'phone');
      });
    });
  }

  /* ---------- More options ---------- */

  function wireAdvanced() {
    const fileInput = $('#file-page');
    $('#btn-open-file').addEventListener('click', () => { fileInput.value = ''; fileInput.click(); });
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files[0];
      if (!file) return;
      deserializeToEditor(await file.text());
      flushSave();
      showToast(`Opened “${file.name}” into this page.`);
    });

    $('#btn-download').addEventListener('click', () => {
      const blob = new Blob([serializeToStaticHTML()], { type: 'text/html' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = store.current || 'index.html';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });

    $('#btn-reset-demo').hidden = !service.isDemo;
    $('#btn-reset-demo').addEventListener('click', () => {
      if (!window.confirm('Reset the demo? This throws away all drafts and everything published in this demo.')) return;
      service.resetDemo();
      try {
        localStorage.removeItem(draftKey());
        localStorage.removeItem(lastPageKey());
      } catch { /* ignore */ }
      location.reload();
    });
  }

  /* ---------- Everything else ---------- */

  function wireUi() {
    wireFormatBar();
    wireSidebar();
    wirePreview();
    wireAdvanced();
    wireMediaLibrary();

    $('#btn-save').addEventListener('click', saveDraft);
    $('#btn-publish').addEventListener('click', publishLive);

    document.querySelectorAll('dialog').forEach((d) => {
      d.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => d.close()));
    });

    canvasEl().addEventListener('click', (e) => {
      const del = e.target.closest('.block-delete');
      if (del) removeBlock(del.closest('.grid-stack-item'));
    });

    canvasEl().addEventListener('input', markDirty);

    // Page name: updates the sidebar and menu as she types.
    $('#page-title').addEventListener('input', () => {
      markDirty();
      renderPageList();
      renderPaperHeader();
    });

    // Site name: shared by every page, so it's a site-level draft.
    $('#site-name').addEventListener('input', (e) => {
      const value = e.target.value.trim();
      store.siteNameDraft = value && value !== store.siteName ? value : null;
      markDirty();
    });

    grid.on('change added removed', () => { markDirty(); refreshEmptyState(); });

    // Show the grid lines while moving/resizing, so free placement is obvious.
    const paper = $('#paper');
    grid.on('dragstart resizestart', () => paper.classList.add('is-arranging'));
    grid.on('dragstop resizestop', () => paper.classList.remove('is-arranging'));

    window.addEventListener('beforeunload', () => { if (saveTimer) flushSave(); });
  }

  /* ========================================================================
     13. BOOT
     ======================================================================== */

  async function boot() {
    grid = GridStack.init({
      column: CONFIG.columns,
      cellHeight: CONFIG.cellHeight,
      margin: CONFIG.margin,
      // FREE-FORM LAYOUT: blocks stay exactly where they are dropped instead
      // of floating up to the top. Empty space above/between them is kept.
      float: true,
      minRow: CONFIG.minRows,          // always some empty rows to drop into
      handle: '.block-handle',         // only "✥ Move" drags, text stays clickable
      acceptWidgets: '.add-tile',      // tiles dragged in from the sidebar
      resizable: { handles: 'se' },    // one obvious corner to pull
      animate: true,
      columnOpts: { breakpoints: [] }, // never switch to 1 column while editing
    }, canvasEl());

    service = createService();
    wireUi();
    showLoading('Opening your website…');

    try {
      $('#repo-name').textContent = service.fullName + (service.isDemo ? ' (demo)' : '');

      // 1. Is there a saved draft? Then that's what she edits; otherwise live.
      store.hasDraftBranch = await service.hasDraft();
      const ref = readRef();

      // 2. What's in the repo — in the draft, and on the live site?
      const files = await service.fetchSiteFiles(ref);
      const liveFiles = store.hasDraftBranch ? await service.fetchSiteFiles(service.liveBranch) : files;
      const livePaths = new Set(liveFiles.map((f) => f.path));
      const pageFiles = files.map((f) => f.path).filter((p) => /^[a-z0-9][a-z0-9-]*\.html$/.test(p));

      // 3. Theme + every page (small sites: we need all pages for the menu),
      //    and whether the saved draft has anything that isn't live yet.
      const [theme, diff, ...pages] = await Promise.all([
        files.some((f) => f.path === CONFIG.themeFile)
          ? service.fetchFile(CONFIG.themeFile, ref).then((f) => f.content).catch(() => '')
          : '',
        service.compareDraftToLive(),
        ...pageFiles.map((f) => service.fetchPage(f, ref)),
      ]);
      applyTheme(theme);
      store.draftAhead = diff.ahead;
      store.pages = pages.map((p) => ({
        file: p.path, remote: { html: p.content, sha: p.sha }, draft: null, live: livePaths.has(p.path),
      }));

      // 4. The site name and menu order come from the homepage.
      const home = getEntry(CONFIG.homeFile);
      const homeModel = home ? parseCached(home.remote.html, CONFIG.homeFile) : null;
      store.siteName = (homeModel && homeModel.siteName) || 'My website';
      sortPages(homeModel ? homeModel.nav : []);

      // 5. Put back changes kept on this computer (including brand-new pages).
      const drafts = loadDrafts();
      store.siteNameDraft = drafts.siteName ?? null;
      for (const [file, html] of Object.entries(drafts.pages || {})) {
        let entry = getEntry(file);
        if (!entry) { entry = { file, remote: null, draft: null, live: false }; store.pages.push(entry); }
        entry.draft = html;
      }

      // An empty repo gets a blank homepage.
      if (!store.pages.length) {
        store.pages.push({ file: CONFIG.homeFile, remote: null, draft: '', live: false });
      }

      // 6. Reopen the page she was last working on.
      let start = null;
      try { start = localStorage.getItem(lastPageKey()); } catch { /* ignore */ }
      if (!getEntry(start)) start = getEntry(CONFIG.homeFile) ? CONFIG.homeFile : store.pages[0].file;
      hideLoading();
      await openPage(start, { fetch: false });
    } catch (err) {
      console.error('Pebble: could not open the website', err);
      showLoading(err && (err.status === 401 || err.status === 403)
        ? 'Pebble could not get into your website. Please sign in again.'
        : "Sorry, we couldn't open your website. Please reload the page.");
    }
  }

  // Public API (console, tests, and future modules).
  window.Pebble = {
    serializeToStaticHTML,
    deserializeToEditor,
    getPageModel,
    pageModelToHtml,
    htmlToPageModel,
    pendingChanges,
    openPage,
    createPage,
    saveDraft,
    publishLive,
    openMediaLibrary,
    sanitizeRichText,
    /** Developer hook: edit a real repository (token kept for this tab only). */
    useGitHub(cfg) { sessionStorage.setItem('pebble:github', JSON.stringify(cfg)); location.reload(); },
    /** Back to the in-browser demo repository. */
    useDemo() { sessionStorage.removeItem('pebble:github'); location.reload(); },
    get service() { return service; },
    store,
    WIDGETS,
    CONFIG,
  };
  window.serializeToStaticHTML = serializeToStaticHTML;
  window.deserializeToEditor = deserializeToEditor;

  boot();
})();
