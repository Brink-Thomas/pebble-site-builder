/* ==========================================================================
   Pebble — core engine
   --------------------------------------------------------------------------
   A tiny, database-free website editor. The published HTML file IS the
   database:

        ┌──────────────┐  serializeToStaticHTML()  ┌───────────────────────┐
        │  Gridstack   │ ────────────────────────▶ │  clean static HTML    │
        │  editor DOM  │                           │  <section data-gs-x…> │
        │ (live state) │ ◀──────────────────────── │  (lives in Git repo)  │
        └──────────────┘ deserializeToEditor(html) └───────────────────────┘

   Both directions go through one small, plain "page model":

        { title: "My blog",
          blocks: [ { type: "text", x: 0, y: 0, w: 12, h: 2,
                      data: { html: "<h2>Hello</h2>" } }, … ] }

   Adding a new kind of block (video, map, button…) only means adding one
   entry to the WIDGETS registry below — serialize/deserialize never change.

   Sections in this file:
     1. Config
     2. Safety helpers (escaping, URL checks, rich-text sanitizer)
     3. Widget registry (Text, Photo)
     4. Editor: creating / adding / removing blocks
     5. Page model  ⇄  editor
     6. serializeToStaticHTML()  &  deserializeToEditor()
     7. Autosave (draft in this browser)
     8. UI wiring (format bar, sidebar, preview, publish, toasts)
     9. Boot
   ========================================================================== */

(function () {
  'use strict';

  /* ========================================================================
     1. CONFIG
     ======================================================================== */

  const CONFIG = {
    columns: 12,          // grid columns (also in site.css)
    cellHeight: 70,       // px per row in the editor  → site.css: --row + --gap
    margin: 8,            // px around each item       → site.css: --gap = 2 × margin
    draftKey: 'pebble:draft:v1',
    stylesheetHref: 'site.css',        // as seen from a published page (repo root)
    starterPageUrl: '../index.html',   // the live homepage, re-opened on first visit
    maxImageSide: 1600,                // photos are shrunk to this many px
    autosaveDelay: 700,                // ms after the last change
  };

  /* ========================================================================
     2. SAFETY HELPERS
     The editor reads HTML from files and from pasting, so everything that
     goes into the page is escaped or run through an allow-list first.
     ======================================================================== */

  /** Escape text for use between HTML tags. */
  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /** Escape text for use inside a double-quoted attribute. */
  function escapeAttr(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /**
   * Return the URL if it is safe, otherwise ''.
   *  kind 'link'  → http(s), mailto, tel, #anchors, relative paths
   *  kind 'image' → http(s), relative paths, data:image/… (embedded photos)
   * Anything like "javascript:" is rejected.
   */
  function safeUrl(url, kind) {
    const u = String(url ?? '').trim();
    if (!u) return '';
    if (kind === 'image' && /^data:image\/(png|jpe?g|gif|webp|avif|svg\+xml)[;,]/i.test(u)) return u;
    if (/^https?:\/\//i.test(u)) return u;
    if (kind === 'link' && /^(mailto:|tel:|#)/i.test(u)) return u;
    // Relative path: no "scheme:" before the first / ? or #
    if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) return u;
    return '';
  }

  // Tags a text block may contain. Anything else is unwrapped (its text is
  // kept) or — for dangerous tags — dropped completely.
  const RICH_TEXT_TAGS = {
    P: 'p', BR: 'br', STRONG: 'strong', B: 'strong', EM: 'em', I: 'em', U: 'u',
    H1: 'h2', H2: 'h2', H3: 'h3', H4: 'h3', UL: 'ul', OL: 'ol', LI: 'li',
    A: 'a', BLOCKQUOTE: 'blockquote', DIV: 'p',
  };
  const DROP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'TEMPLATE', 'NOSCRIPT',
    'SVG', 'MATH', 'FORM', 'INPUT', 'BUTTON', 'SELECT', 'TEXTAREA', 'LINK', 'META', 'HEAD', 'TITLE',
  ]);

  /**
   * Clean up HTML coming from a contenteditable box (or an opened file):
   * keep only simple, semantic tags with no classes/styles; links keep a
   * safe href only. Returns a tidy HTML string.
   */
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
        if (node.nodeType !== Node.ELEMENT_NODE) continue; // comments etc.

        const tag = node.tagName.toUpperCase();
        if (DROP_TAGS.has(tag)) continue;

        const cleanTag = RICH_TEXT_TAGS[tag];
        if (!cleanTag) {               // e.g. <span>, <font>: keep the text only
          copyChildren(node, to);
          continue;
        }

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

    // Remove empty paragraphs that browsers leave behind (<p><br></p>).
    out.querySelectorAll('p, h2, h3, li').forEach((el) => {
      if (!el.textContent.trim() && !el.querySelector('br')) el.remove();
    });

    return out.innerHTML.trim();
  }

  /** True when a text box has no visible text. */
  function isBlankText(el) {
    return !el.textContent.replace(/​/g, '').trim();
  }

  /** Whole number from an attribute, or the fallback. */
  function toInt(value, fallback) {
    const n = parseInt(value, 10);
    return Number.isFinite(n) ? n : fallback;
  }

  /* ========================================================================
     3. WIDGET REGISTRY
     Every block type describes itself with five small functions:

       defaultData()          → data for a brand-new block
       createEditor(data)     → DOM for editing it on the canvas
       readData(bodyEl)       → data, read back out of that DOM
       renderStatic(data)     → { tag, inner, className? } for the live site
       parseStatic(el)        → data, read back out of a published element
     ======================================================================== */

  const WIDGETS = {

    /* ---------------------------- TEXT ---------------------------- */
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

        // Pasting from Word / websites brings lots of hidden junk.
        // Paste as plain text so the page stays clean.
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

    /* ---------------------------- PHOTO --------------------------- */
    image: {
      label: 'Photo',
      defaultSize: { w: 6, h: 5 },
      minSize: { w: 2, h: 2 },

      defaultData: () => ({ src: '', caption: '' }),

      createEditor(data) {
        const wrap = document.createElement('div');
        wrap.className = 'image-editor';
        // The current values live on the element itself.
        wrap._src = safeUrl(data.src, 'image');
        wrap._caption = data.caption || '';

        const setPhoto = async (file) => {
          try {
            wrap._src = await fileToDataUrl(file, CONFIG.maxImageSide);
            render();
            markDirty();
          } catch (err) {
            console.warn(err);
            showToast("Sorry, that file doesn't look like a photo.");
          }
        };

        const render = () => {
          wrap.innerHTML = '';
          if (wrap._src) {
            const media = document.createElement('div');
            media.className = 'block__media';
            const img = document.createElement('img');
            img.src = wrap._src;
            img.alt = wrap._caption || 'Photo';
            img.draggable = false;
            media.appendChild(img);

            const change = document.createElement('button');
            change.type = 'button';
            change.className = 'image-change';
            change.textContent = '🔄 Change photo';
            change.addEventListener('click', () => pickImageFile(setPhoto));
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
              '<small>Click here, or drag a photo from your computer onto this box</small>';
            empty.addEventListener('click', () => pickImageFile(setPhoto));
            wrap.appendChild(empty);
          }
        };

        // Let her drop a photo file from her desktop straight onto the box.
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
          if (file) { e.preventDefault(); setPhoto(file); }
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

  /** Shrink a photo in the browser and return it as a data: URL.
   *  (In the real app, photos would be committed as files next to the page.) */
  function fileToDataUrl(file, maxSide) {
    return new Promise((resolve, reject) => {
      if (!file || !/^image\//.test(file.type)) return reject(new Error('Not an image'));

      // GIF/SVG: keep as-is (animation / vector would be lost on a canvas).
      if (/gif|svg/.test(file.type)) {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        return reader.readAsDataURL(file);
      }

      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.naturalWidth * scale);
        canvas.height = Math.round(img.naturalHeight * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(url);
        const type = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
        resolve(canvas.toDataURL(type, 0.85));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read image')); };
      img.src = url;
    });
  }

  /* ========================================================================
     4. EDITOR — BLOCKS ON THE CANVAS
     ======================================================================== */

  let grid = null;          // the GridStack instance
  let isLoading = false;    // true while (re)building the canvas → no autosave

  const $ = (sel) => document.querySelector(sel);
  const canvasEl = () => $('#canvas');

  /**
   * Build the DOM for one block the way Gridstack expects:
   *
   *   <div class="grid-stack-item" gs-x gs-y gs-w gs-h data-widget-type>
   *     <div class="grid-stack-item-content block-shell">
   *       <div class="block-bar"> ✥ Move | 🗑 Remove </div>
   *       <div class="block-body"> …widget editor… </div>
   *     </div>
   *   </div>
   */
  function createBlockElement(type, data, pos) {
    const widget = WIDGETS[type];
    const item = document.createElement('div');
    item.className = 'grid-stack-item';
    item.dataset.widgetType = type;

    const size = { ...widget.defaultSize, ...pos };
    if (Number.isFinite(size.x) && Number.isFinite(size.y)) {
      item.setAttribute('gs-x', size.x);
      item.setAttribute('gs-y', size.y);
    } else {
      item.setAttribute('gs-auto-position', 'true');
    }
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
   * Add a block to the canvas.
   * @param {string} type  key in WIDGETS
   * @param {object} [data] widget data (defaults used if missing)
   * @param {object} [pos]  {x, y, w, h}; without x/y it goes at the bottom
   * @param {object} [opts] {focus: true} to scroll to it and start typing
   */
  function addBlock(type, data, pos, opts = {}) {
    if (!WIDGETS[type]) { console.warn(`Pebble: unknown block type "${type}" skipped`); return null; }

    // "Click to add" → place it full-width-ish under everything else.
    if (!pos || !Number.isFinite(pos.x)) {
      pos = { ...pos, x: 0, y: grid.getRow() };
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

  /** Remove a block, with an "Undo" button in case it was a mistake. */
  function removeBlock(item) {
    const snapshot = readBlock(item);
    grid.removeWidget(item);
    refreshEmptyState();
    showToast('Box removed.', 'Undo', () => {
      addBlock(snapshot.type, snapshot.data, { x: snapshot.x, y: snapshot.y, w: snapshot.w, h: snapshot.h });
    });
  }

  /** Show the friendly "your page is empty" message when needed. */
  function refreshEmptyState() {
    const count = grid ? grid.getGridItems().length : 0;
    $('#paper').classList.toggle('is-empty', count === 0);
  }

  /* ========================================================================
     5. PAGE MODEL  ⇄  EDITOR
     ======================================================================== */

  /** Read one canvas block into a plain object. */
  function readBlock(item) {
    const node = item.gridstackNode;
    const type = item.dataset.widgetType;
    return {
      type,
      x: node.x, y: node.y, w: node.w, h: node.h,
      data: WIDGETS[type].readData(item.querySelector('.block-body')),
    };
  }

  /**
   * Snapshot of the whole page as plain data.
   * Blocks are sorted top-to-bottom, then left-to-right: that is the order
   * they are written to the HTML file, which is also the reading order
   * on phones (where everything stacks into one column).
   */
  function getPageModel() {
    const blocks = grid.getGridItems()
      .filter((el) => el.gridstackNode && WIDGETS[el.dataset.widgetType] && el.querySelector('.block-body'))
      .map(readBlock)
      .sort((a, b) => (a.y - b.y) || (a.x - b.x));

    return {
      title: $('#page-title').value.trim() || 'My website',
      blocks,
    };
  }

  /** Replace everything on the canvas with the given page model. */
  function loadPageModel(model) {
    isLoading = true;
    try {
      grid.batchUpdate();
      grid.removeAll();
      for (const b of model.blocks) {
        addBlock(b.type, b.data, { x: b.x, y: b.y, w: b.w, h: b.h });
      }
      grid.batchUpdate(false);
      $('#page-title').value = model.title || '';
    } finally {
      isLoading = false;
      refreshEmptyState();
    }
  }

  /* ========================================================================
     6. SERIALIZE & DESERIALIZE  — the heart of the "HTML is the database" idea
     ======================================================================== */

  /**
   * serializeToStaticHTML()
   * -----------------------
   * Turn the live editor into a complete, standalone HTML document.
   *
   * What gets REMOVED: every Gridstack class/attribute (grid-stack-item,
   * gs-x, ui-resizable…), the Move/Remove bar, contenteditable, file inputs,
   * placeholders — anything that only exists for editing.
   *
   * What gets WRITTEN: one semantic element per block:
   *
   *   <section class="block block--text"
   *            data-widget-type="text"
   *            data-gs-x="0" data-gs-y="0" data-gs-w="12" data-gs-h="2"
   *            style="grid-column:1 / span 12;grid-row:1 / span 2">
   *     <div class="block__content"><h2>Hello!</h2></div>
   *   </section>
   *
   *   - data-*  → the "database": exactly what the editor needs to re-open it
   *   - style   → the same position as native CSS Grid, so the live site
   *               needs no JavaScript at all (site.css handles phones)
   *
   * @param {object} [options]
   * @param {string} [options.stylesheetHref] href for site.css in the output
   * @returns {string} full HTML document
   */
  function serializeToStaticHTML(options = {}) {
    const stylesheetHref = options.stylesheetHref || CONFIG.stylesheetHref;
    const model = getPageModel();

    const blocksHtml = model.blocks.map((b) => {
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
    }).join('\n\n');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="generator" content="Pebble">
  <title>${escapeHtml(model.title)}</title>
  <link rel="stylesheet" href="${escapeAttr(stylesheetHref)}">
</head>
<body>
  <!--
    Made with Pebble. This is plain HTML: no database, no JavaScript.
    The data-widget-type and data-gs-* attributes let the editor re-open it.
  -->
  <main class="site-grid" data-pebble-grid data-columns="${CONFIG.columns}">
${blocksHtml}
  </main>
</body>
</html>
`;
  }

  /**
   * deserializeToEditor(htmlString)
   * -------------------------------
   * The reverse: read a raw HTML file (e.g. fetched from the GitHub repo),
   * find every element with data-widget-type, read its data-gs-* position
   * and its content, and rebuild a fully working Gridstack editor.
   *
   * The HTML is parsed with DOMParser in an inert document — scripts in it
   * never run — and all content is re-sanitized on the way in.
   *
   * @param {string} htmlString full HTML document (or just a fragment)
   * @returns {object} the page model that was loaded
   */
  function deserializeToEditor(htmlString) {
    const doc = new DOMParser().parseFromString(String(htmlString || ''), 'text/html');

    // Prefer our grid container; fall back to the whole body for fragments.
    const root = doc.querySelector('[data-pebble-grid]') || doc.body;
    let elements = Array.from(root.querySelectorAll(':scope > [data-widget-type]'));
    if (!elements.length) elements = Array.from(root.querySelectorAll('[data-widget-type]'));

    const cols = CONFIG.columns;
    const blocks = [];

    for (const el of elements) {
      const type = el.getAttribute('data-widget-type');
      const widget = WIDGETS[type];
      if (!widget) { console.warn(`Pebble: unknown block type "${type}" skipped`); continue; }

      // Read & sanity-check the position so a hand-edited file can't break the grid.
      const w = Math.min(cols, Math.max(widget.minSize.w, toInt(el.getAttribute('data-gs-w'), widget.defaultSize.w)));
      const h = Math.max(widget.minSize.h, toInt(el.getAttribute('data-gs-h'), widget.defaultSize.h));
      const x = Math.min(cols - w, Math.max(0, toInt(el.getAttribute('data-gs-x'), 0)));
      const y = Math.max(0, toInt(el.getAttribute('data-gs-y'), 1000)); // missing y → bottom

      blocks.push({ type, x, y, w, h, data: widget.parseStatic(el) });
    }

    const model = { title: (doc.title || '').trim(), blocks };
    loadPageModel(model);
    return model;
  }

  /* ========================================================================
     7. AUTOSAVE — a draft kept in this browser, so nothing is ever lost.
     The draft is stored in exactly the same HTML format as the published
     page, so loading a draft exercises deserializeToEditor() too.
     ======================================================================== */

  let saveTimer = null;

  function setSaveStatus(state) {
    const el = $('#save-status');
    el.classList.toggle('is-error', state === 'error');
    el.textContent = {
      saving: 'Saving…',
      saved: '✓ All changes saved',
      error: "⚠ Couldn't keep a draft (try smaller photos)",
    }[state];
  }

  function markDirty() {
    if (isLoading) return;
    setSaveStatus('saving');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveDraft, CONFIG.autosaveDelay);
  }

  function saveDraft() {
    clearTimeout(saveTimer);
    saveTimer = null;
    try {
      localStorage.setItem(CONFIG.draftKey, serializeToStaticHTML());
      setSaveStatus('saved');
    } catch (err) {
      console.warn('Pebble: draft not saved', err);
      setSaveStatus('error');
    }
  }

  function loadDraft() {
    try { return localStorage.getItem(CONFIG.draftKey); } catch { return null; }
  }

  function clearDraft() {
    try { localStorage.removeItem(CONFIG.draftKey); } catch { /* ignore */ }
  }

  /* ========================================================================
     8. UI WIRING
     ======================================================================== */

  /* ---------- Toast ("Box removed. Undo") ---------- */

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
    toastTimer = setTimeout(() => { toast.hidden = true; }, actionLabel ? 7000 : 3500);
  }

  /* ---------- Image file picker (one hidden <input> shared by all) ---------- */

  let pendingImageCallback = null;
  function pickImageFile(callback) {
    pendingImageCallback = callback;
    const input = $('#file-image');
    input.value = '';
    input.click();
  }

  /* ---------- Text style bar ---------- */

  /** The text box the cursor is currently in, or null. */
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
      const range = sel.getRangeAt(0); // prompt() can lose the selection
      let url = window.prompt('Paste the website address for this link:', 'https://');
      if (!url || url === 'https://') return;
      url = url.trim();
      if (!/^(https?:|mailto:|#|\/)/i.test(url)) url = 'https://' + url;
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand('createLink', false, safeUrl(url, 'link'));
    },
  };

  function updateFormatBar() {
    const bar = $('#formatbar');
    const editor = activeTextEditor();
    bar.classList.toggle('is-active', !!editor);
    // Light up Bold / Italic / List when the cursor is in such text.
    const states = { bold: 'bold', italic: 'italic', list: 'insertUnorderedList' };
    let block = '';
    try { block = editor ? String(document.queryCommandValue('formatBlock')).toLowerCase() : ''; } catch { /* old browsers */ }
    bar.querySelectorAll('button[data-cmd]').forEach((btn) => {
      const cmd = btn.dataset.cmd;
      let on = false;
      if (editor && states[cmd]) {
        try { on = document.queryCommandState(states[cmd]); } catch { /* ignore */ }
      }
      if (editor && cmd === 'title') on = block === 'h2';
      if (editor && cmd === 'subtitle') on = block === 'h3';
      btn.classList.toggle('is-on', on);
    });
  }

  function wireFormatBar() {
    const bar = $('#formatbar');
    // mousedown + preventDefault keeps the text cursor where it was.
    bar.addEventListener('mousedown', (e) => {
      if (e.target.closest('button[data-cmd]')) e.preventDefault();
    });
    bar.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-cmd]');
      if (!btn) return;
      const editor = activeTextEditor();
      if (!editor) { showToast('First click inside a text box, then choose a style.'); return; }
      FORMAT_COMMANDS[btn.dataset.cmd]();
      editor.dispatchEvent(new Event('input', { bubbles: true })); // → autosave
      updateFormatBar();
    });
    document.addEventListener('selectionchange', updateFormatBar);
    // Make Enter create <p> rather than <div>.
    try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch { /* ignore */ }
  }

  /* ---------- Sidebar: drag-in or click to add ---------- */

  function wireSidebar() {
    // Dragging a tile onto the grid. Gridstack drops a *copy* of the tile;
    // we swap that copy for a real block at the same spot.
    GridStack.setupDragIn('.sidebar .add-tile', { appendTo: 'body', helper: 'clone' });

    grid.on('dropped', (_event, _previousNode, newNode) => {
      if (!newNode || !newNode.el) return;
      const { el, x, y } = newNode;
      const type = el.dataset.widgetType;
      grid.removeWidget(el, true, false);
      const block = addBlock(type, null, { x, y }, { focus: true });
      if (block) markDirty();
    });

    // Clicking (or pressing Enter on) a tile adds it at the bottom.
    document.querySelectorAll('.sidebar .add-tile').forEach((tile) => {
      const add = () => { addBlock(tile.dataset.widgetType, null, null, { focus: true }); markDirty(); };
      tile.addEventListener('click', add);
      tile.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); add(); }
      });
    });
  }

  /* ---------- Preview ---------- */

  function wirePreview() {
    const dialog = $('#preview-dialog');
    const frame = $('#preview-frame');

    $('#btn-preview').addEventListener('click', () => {
      // Show the REAL exported HTML. The stylesheet link is made absolute
      // because the iframe isn't at the site root.
      frame.srcdoc = serializeToStaticHTML({
        stylesheetHref: new URL('../' + CONFIG.stylesheetHref, location.href).href,
      });
      dialog.showModal();
    });

    dialog.querySelectorAll('[data-device]').forEach((btn) => {
      btn.addEventListener('click', () => {
        dialog.querySelectorAll('[data-device]').forEach((b) => b.classList.toggle('is-active', b === btn));
        frame.classList.toggle('is-phone', btn.dataset.device === 'phone');
      });
    });
  }

  /* ---------- Publish (prototype: console) ---------- */

  function publish() {
    if (!getPageModel().blocks.length) {
      showToast('Your page is empty — add a Text or Photo box first.');
      return;
    }
    saveDraft();
    const html = serializeToStaticHTML();

    // In the real app this string is committed to the GitHub repo
    // (e.g. PUT /repos/{owner}/{repo}/contents/index.html) and GitHub Pages
    // serves it. For the prototype we just log it.
    console.groupCollapsed('%cPebble ▸ Published HTML (index.html)', 'color:#1f8a4c;font-weight:bold');
    console.log(html);
    console.groupEnd();

    $('#publish-dialog').showModal();
  }

  /* ---------- Advanced: open / download / start over ---------- */

  function wireAdvanced() {
    const fileInput = $('#file-page');
    $('#btn-open-file').addEventListener('click', () => { fileInput.value = ''; fileInput.click(); });
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files[0];
      if (!file) return;
      deserializeToEditor(await file.text());
      saveDraft();
      showToast(`Opened “${file.name}”.`);
    });

    $('#btn-download').addEventListener('click', () => {
      const blob = new Blob([serializeToStaticHTML()], { type: 'text/html' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'index.html';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });

    $('#btn-start-over').addEventListener('click', async () => {
      if (!window.confirm('Start over? This throws away your unpublished changes and shows the example page again.')) return;
      clearDraft();
      deserializeToEditor(await fetchStarterPage());
      saveDraft();
    });
  }

  /* ---------- Everything else ---------- */

  function wireUi() {
    wireFormatBar();
    wireSidebar();
    wirePreview();
    wireAdvanced();

    $('#btn-publish').addEventListener('click', publish);

    // Every <dialog> closes with any [data-close] button (Esc works too).
    document.querySelectorAll('dialog').forEach((d) => {
      d.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => d.close()));
    });

    // Remove buttons on blocks (one listener for all of them).
    canvasEl().addEventListener('click', (e) => {
      const del = e.target.closest('.block-delete');
      if (del) removeBlock(del.closest('.grid-stack-item'));
    });

    // Any typing on the canvas or in the page name → autosave.
    canvasEl().addEventListener('input', markDirty);
    $('#page-title').addEventListener('input', markDirty);

    $('#file-image').addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file && pendingImageCallback) pendingImageCallback(file);
      pendingImageCallback = null;
    });

    // Moving / resizing / adding / removing blocks → autosave.
    grid.on('change added removed', () => { markDirty(); refreshEmptyState(); });

    // Last-second save if she closes the tab.
    window.addEventListener('beforeunload', () => { if (saveTimer) saveDraft(); });
  }

  /* ========================================================================
     9. BOOT
     ======================================================================== */

  // Used only if the real homepage can't be fetched (e.g. opened from disk).
  const FALLBACK_PAGE = `
    <title>My little blog</title>
    <main data-pebble-grid>
      <section data-widget-type="text" data-gs-x="0" data-gs-y="0" data-gs-w="12" data-gs-h="2">
        <div class="block__content"><h2>Welcome to my blog</h2><p>Click on this text to change it.</p></div>
      </section>
      <figure data-widget-type="image" data-gs-x="0" data-gs-y="2" data-gs-w="6" data-gs-h="5"></figure>
      <section data-widget-type="text" data-gs-x="6" data-gs-y="2" data-gs-w="6" data-gs-h="5">
        <div class="block__content"><h3>About me</h3><p>Tell your visitors a little about yourself.</p></div>
      </section>
    </main>`;

  /** Load the published homepage — "reading the database". */
  async function fetchStarterPage() {
    try {
      const res = await fetch(CONFIG.starterPageUrl, { cache: 'no-store' });
      if (res.ok) return await res.text();
    } catch { /* offline or file:// — use the fallback */ }
    return FALLBACK_PAGE;
  }

  async function boot() {
    grid = GridStack.init({
      column: CONFIG.columns,
      cellHeight: CONFIG.cellHeight,
      margin: CONFIG.margin,
      float: false,                    // blocks slide up to fill gaps — tidy by default
      handle: '.block-handle',         // only "✥ Move" drags, so text stays clickable
      acceptWidgets: '.add-tile',      // allow tiles dragged in from the sidebar
      resizable: { handles: 'se' },    // one obvious corner to pull
      animate: true,
      columnOpts: { breakpoints: [] }, // never switch to 1 column while editing
    }, canvasEl());

    wireUi();

    // Prefer her unpublished draft; otherwise open the live page.
    const html = loadDraft() || await fetchStarterPage();
    deserializeToEditor(html);
    setSaveStatus('saved');
  }

  // Public API (handy from the console, and for the future GitHub module).
  window.Pebble = {
    serializeToStaticHTML,
    deserializeToEditor,
    getPageModel,
    sanitizeRichText,
    WIDGETS,
    CONFIG,
  };
  window.serializeToStaticHTML = serializeToStaticHTML;
  window.deserializeToEditor = deserializeToEditor;

  boot();
})();
