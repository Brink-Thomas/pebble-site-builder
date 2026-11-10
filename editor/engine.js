/* ==========================================================================
   Pebble — editor engine
   --------------------------------------------------------------------------
   The user's website lives in THEIR GitHub repository as plain files (see
   lib/site-format.js for the exact format). This editor:

     1. reads every file of the website (GitHubService),
     2. turns them into plain data — the "site":
          config (site-config.json), docs (pages, blog posts, Header,
          Footer: lists of blocks), customCss (theme.css)
     3. lets her edit one doc at a time on a Gridstack canvas,
     4. on Save draft / Publish live, re-renders ALL files from the data
        (PebbleFormat.buildSiteFiles — the stitching engine) and commits the
        ones whose text changed: to the draft branch (dev), then merges
        into live (main) for GitHub Pages.

   Sections:
      1. Setup & small helpers
      2. Block editors (canvas UI + Inspector fields of each block type)
      3. Canvas: Gridstack + blocks + selection
      4. Site store: remote files, local changes, what needs saving
      5. Docs: open / create pages & posts
      6. Header/Footer previews around the page, hero image
      7. Sidebar: Main Menu / Other Pages (drag & drop), nested blog posts
      8. Floating text toolbar
      9. Inspector (right-hand settings panel)
     10. Site Settings: colours, fonts, text styles, roundness, spacing
     11. Add drawer
     12. Save draft & Publish live
     13. Photos: upload + library
     14. Preview
     15. UI wiring
     16. Boot
   ========================================================================== */

(function () {
  'use strict';

  /* ========================================================================
     1. SETUP & SMALL HELPERS
     ======================================================================== */

  const F = window.PebbleFormat;

  const CONFIG = {
    cellHeight: 70,        // px per grid row (site-base.css: --row-height)
    minRows: { page: 9, post: 9, header: 1, footer: 2 },
    demoRepo: { owner: 'demo-user', repo: 'my-garden-blog' },
    maxImageSide: 1600,
    autosaveDelay: 700,
    baseCssUrl: new URL('../lib/site-base.css', location.href).href,
  };

  const $ = (sel) => document.querySelector(sel);
  const canvasEl = () => $('#canvas');

  function el(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text != null) e.textContent = text;
    return e;
  }

  const isBlankText = (node) => !node.textContent.replace(/​/g, '').trim();

  function plainPaste(e) {
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData).getData('text/plain');
    document.execCommand('insertText', false, text);
  }

  /** A one-line editable field (titles, button text): no Enter, plain paste. */
  function makePlainEditable(node, placeholder, onInput) {
    node.contentEditable = 'true';
    node.spellcheck = true;
    node.classList.add('plain-editor');
    node.dataset.placeholder = placeholder;
    const refresh = () => node.classList.toggle('is-empty', isBlankText(node));
    refresh();
    node.addEventListener('keydown', (e) => { if (e.key === 'Enter') e.preventDefault(); });
    node.addEventListener('paste', plainPaste);
    node.addEventListener('input', () => { refresh(); onInput && onInput(node.textContent.trim()); });
  }

  /** A rich text area (text blocks, card text) — the floating toolbar works on these. */
  function makeRichEditable(node, html, placeholder) {
    node.classList.add('rich-text', 'text-editor');
    node.contentEditable = 'true';
    node.spellcheck = true;
    node.dataset.placeholder = placeholder;
    node.innerHTML = F.sanitizeRichText(html);
    const refresh = () => node.classList.toggle('is-empty', isBlankText(node));
    refresh();
    node.addEventListener('input', refresh);
    node.addEventListener('paste', plainPaste);
    return node;
  }

  let service = null;   // GitHubService / MockGitHubService
  let grid = null;      // GridStack instance
  let isLoading = false;

  const dashboardUrl = () => PebbleAuth.appRoot + (service && service.isDemo ? '?demo=1' : '');

  /* ========================================================================
     2. BLOCK EDITORS
       create(data) → element (element._data holds the data, element._render() redraws)
       read(element) → data
       inspector    → fields for the right-hand settings panel
     Most editors reuse the published CSS classes, so the canvas looks like
     the website; Inspector changes redraw the block immediately.
     ======================================================================== */

  const previewCtx = () => ({ config: store.config, file: store.current, root: '' });

  function resolveImagesIn(root) {
    root.querySelectorAll('img').forEach((img) => {
      const src = img.getAttribute('src');
      if (src && isRepoPath(src)) showImage(img, src);
    });
  }

  const LINK_FIELD = (key, label, allowNone) => ({ key, label, type: 'link', allowNone });

  const EDITORS = {
    text: {
      label: 'Text', icon: '✍️', hint: 'Stories, titles, lists', size: { w: 6, h: 3 }, min: { w: 2, h: 1 },
      create(data) { return makeRichEditable(el('div'), data.html, 'Click here and start typing…'); },
      read: (node) => ({ html: isBlankText(node) ? '' : F.sanitizeRichText(node.innerHTML) }),
      inspector: [
        { type: 'note', text: 'Click into the text to type. A toolbar appears with text styles, bold, underline, highlight and alignment.' },
        { type: 'note', text: 'Change how each text style looks for the whole website in 🎨 Site Settings → Text styles.' },
      ],
    },

    image: {
      label: 'Photo', icon: '🖼️', hint: 'A picture', size: { w: 6, h: 5 }, min: { w: 2, h: 2 },
      create(data) {
        const wrap = el('div', 'block-image image-editor');
        wrap._data = { ...F.BLOCKS.image.defaults(), ...data, src: F.safeUrl(data.src, 'image') };
        const use = (path) => { wrap._data.src = path; wrap._render(); markDirty(); renderInspector(); };
        wrap._render = () => {
          const d = wrap._data;
          wrap.innerHTML = '';
          if (d.radius !== '' && d.radius != null) wrap.style.setProperty('--block-radius', `${d.radius}px`);
          else wrap.style.removeProperty('--block-radius');
          if (d.src) {
            const media = el('div', 'block-image__media');
            const img = el('img');
            img.alt = d.alt || d.caption || 'Photo';
            img.draggable = false;
            showImage(img, d.src);
            const change = el('button', 'image-change', '🔄 Change photo');
            change.type = 'button';
            change.addEventListener('click', () => openMediaLibrary({ current: d.src, onPick: use }));
            media.append(img, change);
            if (d.href) media.appendChild(el('span', 'image-linkbadge', '🔗 Linked'));
            const caption = el('input', 'image-caption');
            caption.type = 'text';
            caption.placeholder = 'Write a caption (optional)';
            caption.maxLength = 200;
            caption.value = d.caption;
            caption.addEventListener('input', () => { d.caption = caption.value; });
            wrap.append(media, caption);
          } else {
            wrap.appendChild(emptyPhotoButton(() => openMediaLibrary({ current: '', onPick: use })));
          }
        };
        enablePhotoDrop(wrap, use);
        wrap._render();
        return wrap;
      },
      read: (wrap) => ({ ...wrap._data, caption: String(wrap._data.caption || '').trim() }),
      inspector: [
        { type: 'photo', key: 'src', label: 'Photo' },
        { key: 'alt', type: 'text', label: 'Describe the photo', placeholder: 'e.g. Pink roses along a wooden fence', help: 'Read aloud to people who can’t see the photo, and used by search engines. If empty, the caption is used.' },
        LINK_FIELD('href', 'When someone clicks the photo, go to', 'Nowhere (no link)'),
        { key: 'radius', type: 'radius', label: 'Corner roundness' },
      ],
    },

    card: {
      label: 'Card', icon: '🗂️', hint: 'Photo, title and text', size: { w: 4, h: 6 }, min: { w: 2, h: 3 },
      create(data) {
        const wrap = el('div', 'block-card card-editor');
        wrap._data = { ...F.BLOCKS.card.defaults(), ...data };
        const use = (path) => { syncCard(wrap); wrap._data.src = path; wrap._render(); markDirty(); renderInspector(); };
        wrap._render = () => {
          const d = wrap._data;
          wrap.className = `block-card card-editor${d.border && d.border !== 'accent' ? ` block-card--${d.border}` : ''}`;
          if (d.bg) wrap.style.setProperty('--card-bg', d.bg); else wrap.style.removeProperty('--card-bg');
          if (d.textColor) wrap.style.setProperty('--card-text', d.textColor); else wrap.style.removeProperty('--card-text');
          wrap.innerHTML = '';
          const media = el('div', 'block-card__media');
          if (d.src) {
            const img = el('img');
            img.alt = '';
            showImage(img, d.src);
            const change = el('button', 'image-change', '🔄 Change photo');
            change.type = 'button';
            change.addEventListener('click', () => openMediaLibrary({ current: d.src, onPick: use }));
            media.append(img, change);
          } else {
            media.classList.add('card-editor__nomedia');
            const add = el('button', 'card-editor__addphoto', '📷 Add a photo');
            add.type = 'button';
            add.addEventListener('click', () => openMediaLibrary({ current: '', onPick: use }));
            media.appendChild(add);
          }
          const body = el('div', 'block-card__body');
          const title = el('h3', 'block-card__title', d.title);
          makePlainEditable(title, 'Card title');
          const text = makeRichEditable(el('div', 'block-card__text'), d.html, 'A few words…');
          body.append(title, text);
          if (d.href) body.appendChild(el('span', 'block-card__link', d.linkLabel || 'Read more'));
          wrap.append(media, body);
        };
        enablePhotoDrop(wrap, use);
        wrap._render();
        return wrap;
      },
      read: (wrap) => syncCard(wrap),
      inspector: [
        { type: 'photo', key: 'src', label: 'Photo', removable: true },
        { key: 'bg', type: 'color', label: 'Background color', defaultLabel: 'White' },
        { key: 'textColor', type: 'color', label: 'Text color', defaultLabel: 'Normal' },
        { key: 'border', type: 'select', label: 'Border', options: [['accent', 'A colored line on top'], ['outline', 'A thin outline'], ['shadow', 'A soft shadow'], ['none', 'No border']] },
        LINK_FIELD('href', 'The card’s link goes to', 'No link'),
        { key: 'linkLabel', type: 'text', label: 'Link text', placeholder: 'Read more' },
      ],
    },

    button: {
      label: 'Button', icon: '🔘', hint: 'A link to a page', size: { w: 4, h: 1 }, min: { w: 2, h: 1 },
      create(data) {
        const wrap = el('div', 'block-button button-editor');
        wrap._data = { ...F.BLOCKS.button.defaults(), ...data };
        wrap._render = () => {
          const d = wrap._data;
          wrap.className = `block-button button-editor block-button--${d.align}`;
          wrap.innerHTML = '';
          const label = el('span', `block-button__link block-button__link--${d.style}`, d.label);
          makePlainEditable(label, 'Button text', (v) => { wrap._data.label = v; syncInspectorField('label', v); });
          wrap.appendChild(label);
          if (!d.href) wrap.appendChild(el('span', 'button-editor__hint', '← choose where it goes, on the right'));
        };
        wrap._render();
        return wrap;
      },
      read: (wrap) => ({ ...wrap._data }),
      inspector: [
        { key: 'label', type: 'text', label: 'Button text' },
        LINK_FIELD('href', 'Goes to'),
        { key: 'style', type: 'select', label: 'Look', options: [['primary', 'Filled with the main color'], ['accent', 'Filled with the second color'], ['secondary', 'Outline only']] },
        { key: 'align', type: 'select', label: 'Position in its box', options: [['left', 'Left'], ['center', 'Middle'], ['right', 'Right']] },
      ],
    },

    'blog-feed': {
      label: 'Blog posts', icon: '📰', hint: 'Your latest posts', size: { w: 12, h: 7 }, min: { w: 4, h: 3 },
      create(data) {
        const wrap = el('div', 'block-blog-feed feed-editor');
        wrap._data = { ...F.BLOCKS['blog-feed'].defaults(), ...data };
        wrap._render = () => {
          if (!store.config.posts.length) {
            wrap.innerHTML = '<div class="feed-editor__empty"><span aria-hidden="true">📰</span><strong>Your blog posts will appear here</strong><small>Write one from the Blog page in the list on the left.</small></div>';
            return;
          }
          wrap.innerHTML = F.BLOCKS['blog-feed'].render(wrap._data, previewCtx()).inner;
          resolveImagesIn(wrap);
        };
        wrap._render();
        return wrap;
      },
      read: (wrap) => ({ ...wrap._data }),
      inspector: [
        { key: 'limit', type: 'select', label: 'How many posts to show', number: true, options: [['3', 'The newest 3'], ['6', 'The newest 6'], ['12', 'The newest 12'], ['0', 'All of them']] },
        { type: 'note', text: 'Posts appear here automatically, newest first, with their cover photo and summary.' },
      ],
    },

    embed: {
      label: 'Embed code', icon: '🧩', hint: 'For website helpers', size: { w: 6, h: 4 }, min: { w: 2, h: 1 }, advanced: true,
      create(data) {
        const wrap = el('div', 'embed-editor');
        wrap._data = { code: data.code || '' };
        wrap._render = () => {
          wrap.innerHTML = '';
          wrap.append(
            el('strong', 'embed-editor__title', '🧩 Custom code'),
            el('span', 'embed-editor__note', 'It runs on your published website, not here. Change it on the right.'),
          );
          if (wrap._data.code) wrap.appendChild(el('code', 'embed-editor__code', wrap._data.code.slice(0, 160)));
          // Never put the code into the editor's own page: it could read her login.
        };
        wrap._render();
        return wrap;
      },
      read: (wrap) => ({ ...wrap._data }),
      inspector: [
        {
          key: 'code', type: 'code', label: 'Code to add to the page',
          warning: 'For website helpers only. Code copied from the internet can break your website or make it unsafe. If someone sent you this, make sure you trust them.',
        },
      ],
    },

    'site-title': {
      label: 'Website name', icon: '🏷️', hint: 'Linked to your homepage', size: { w: 5, h: 1 }, min: { w: 2, h: 1 }, regionOnly: true,
      create() {
        const wrap = el('div', 'block-site-title');
        const input = el('input', 'site-title site-title-input');
        input.type = 'text';
        input.maxLength = 80;
        input.setAttribute('aria-label', 'Website name');
        input.title = 'Click to change your website’s name';
        input.value = store.config.siteName;
        input.addEventListener('input', () => { store.config.siteName = input.value.trim() || 'My website'; markDirty(); });
        wrap.appendChild(input);
        wrap._data = {};
        wrap._render = () => { if (document.activeElement !== input) input.value = store.config.siteName; };
        return wrap;
      },
      read: () => ({}),
      inspector: [{ type: 'note', text: 'Your website’s name, linked to your homepage. Click it to change it (or use 🎨 Site Settings).' }],
    },

    menu: {
      label: 'Site menu', icon: '🧭', hint: 'Links to your pages', size: { w: 7, h: 1 }, min: { w: 2, h: 1 }, regionOnly: true,
      create(data) {
        const wrap = el('nav', 'block-menu menu-editor');
        wrap._data = { ...F.BLOCKS.menu.defaults(), ...data };
        wrap._render = () => {
          const r = F.BLOCKS.menu.render(wrap._data, previewCtx());
          wrap.className = `block-menu menu-editor ${(r.classes || []).join(' ')}`;
          wrap.innerHTML = r.inner;
        };
        wrap._render();
        return wrap;
      },
      read: (wrap) => ({ ...wrap._data }),
      inspector: [
        { key: 'align', type: 'select', label: 'Position', options: [['left', 'Left'], ['center', 'Middle'], ['right', 'Right']] },
        { type: 'note', text: 'The menu shows the pages under “Main Menu” in the list on the left. Drag pages there (or to “Other Pages”) to change it.' },
      ],
    },
  };

  function syncCard(wrap) {
    const title = wrap.querySelector('.block-card__title');
    const text = wrap.querySelector('.block-card__text');
    if (title) wrap._data.title = title.textContent.trim();
    if (text) wrap._data.html = isBlankText(text) ? '' : F.sanitizeRichText(text.innerHTML);
    return { ...wrap._data };
  }

  function emptyPhotoButton(onClick) {
    const btn = el('button', 'image-empty');
    btn.type = 'button';
    btn.innerHTML = '<span class="image-empty__icon" aria-hidden="true">📷</span><strong>Add a photo</strong><small>Click to pick one of your photos or add a new one</small>';
    btn.addEventListener('click', onClick);
    return btn;
  }

  function enablePhotoDrop(wrap, use) {
    wrap.addEventListener('dragover', (e) => {
      if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) { e.preventDefault(); wrap.classList.add('is-dragover'); }
    });
    wrap.addEventListener('dragleave', () => wrap.classList.remove('is-dragover'));
    wrap.addEventListener('drop', async (e) => {
      wrap.classList.remove('is-dragover');
      const file = e.dataTransfer && e.dataTransfer.files[0];
      if (!file) return;
      e.preventDefault();
      try { use(await uploadPhoto(file)); } catch (err) { reportPhotoError(err); }
    });
  }

  function allowedHere(type) {
    const kind = currentKind();
    if (EDITORS[type].regionOnly) return kind === 'header' || kind === 'footer';
    if (type === 'blog-feed') return kind === 'page' || kind === 'post';
    return true;
  }

  /* ========================================================================
     3. CANVAS + SELECTION
     ======================================================================== */

  function createBlockElement(type, data, pos) {
    const ed = EDITORS[type];
    const item = el('div', 'grid-stack-item');
    item.dataset.widgetType = type;
    const size = { ...ed.size, ...pos };
    item.setAttribute('gs-x', size.x);
    item.setAttribute('gs-y', size.y);
    item.setAttribute('gs-w', size.w);
    item.setAttribute('gs-h', size.h);
    item.setAttribute('gs-min-w', ed.min.w);
    item.setAttribute('gs-min-h', ed.min.h);
    const shell = el('div', 'grid-stack-item-content block-shell');
    const bar = el('div', 'block-bar');
    bar.innerHTML = '<span class="block-handle" title="Hold and drag to move this box">✥ Move</span>' +
      '<button type="button" class="block-delete" title="Remove this box">🗑 Remove</button>';
    const body = el('div', 'block-body');
    body.appendChild(ed.create({ ...F.BLOCKS[type].defaults(), ...data }));
    shell.append(bar, body);
    item.appendChild(shell);
    return item;
  }

  function addBlock(type, data, pos, opts = {}) {
    if (!EDITORS[type]) return null;
    if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) pos = { ...pos, x: 0, y: grid.engine.getRow() };
    const item = createBlockElement(type, data, pos);
    canvasEl().appendChild(item);
    grid.makeWidget(item);
    if (opts.focus) {
      item.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const editable = item.querySelector('[contenteditable="true"]');
      if (editable) setTimeout(() => editable.focus(), 250);
    }
    refreshEmptyState();
    return item;
  }

  function removeBlock(item) {
    const snap = readBlock(item);
    if (selected === item) selectBlock(null);
    grid.removeWidget(item);
    refreshEmptyState();
    showToast('Box removed.', 'Undo', () => {
      addBlock(snap.type, snap.data, { x: snap.x, y: snap.y, w: snap.w, h: snap.h });
      markDirty();
    });
  }

  function refreshEmptyState() {
    $('#paper').classList.toggle('is-empty', !grid || grid.getGridItems().length === 0);
  }

  const editorOf = (item) => item.querySelector('.block-body').firstElementChild;

  function readBlock(item) {
    const n = item.gridstackNode;
    const type = item.dataset.widgetType;
    return { type, x: n.x, y: n.y, w: n.w, h: n.h, data: EDITORS[type].read(editorOf(item)) };
  }

  function readCanvas() {
    return F.sortBlocks(grid.getGridItems()
      .filter((it) => it.gridstackNode && EDITORS[it.dataset.widgetType] && it.querySelector('.block-body'))
      .map(readBlock));
  }

  function loadCanvas(blocks, kind) {
    isLoading = true;
    try {
      selectBlock(null, { silent: true });
      grid.removeAll(true, false);
      canvasEl().querySelectorAll(':scope > .grid-stack-item').forEach((n) => n.remove());
      grid.opts.minRow = CONFIG.minRows[kind] || 2;
      grid.batchUpdate();
      for (const b of blocks) if (EDITORS[b.type]) addBlock(b.type, b.data, { x: b.x, y: b.y, w: b.w, h: b.h });
      grid.batchUpdate(false);
      if (grid._updateContainerHeight) grid._updateContainerHeight();
    } finally {
      isLoading = false;
      refreshEmptyState();
    }
  }

  function refreshLiveBlocks() {
    grid.getGridItems().forEach((it) => {
      if (['menu', 'blog-feed', 'site-title'].includes(it.dataset.widgetType)) editorOf(it)._render();
    });
  }

  /** The box whose settings show in the Inspector. */
  let selected = null;

  function selectBlock(item, { silent = false } = {}) {
    if (item && !item.isConnected) item = null;
    if (selected === item) return;
    if (selected) selected.classList.remove('is-selected');
    selected = item;
    if (item) item.classList.add('is-selected');
    if (!silent) renderInspector();
  }

  /* ========================================================================
     4. SITE STORE
     ======================================================================== */

  const store = {
    remote: new Map(),     // path → { content, sha } (draft branch, else live)
    livePaths: new Set(),  // files on the live site ("New" badges)
    config: F.defaultConfig(),
    docs: {},              // file → { kind, blocks }
    customCss: '',
    baseCss: '',
    current: null,
    hasDraftBranch: false,
    draftAhead: false,
    upgraded: false,
  };

  const readRef = () => (store.hasDraftBranch ? service.draftBranch : service.liveBranch);
  const currentKind = () => (store.docs[store.current] || { kind: 'page' }).kind;
  const pageMeta = (file) => store.config.pages.find((p) => p.file === file);
  const postMeta = (file) => store.config.posts.find((p) => p.file === file);
  const docMeta = (file) => pageMeta(file) || postMeta(file);

  /** The page that lists the blog posts (its posts nest under it in the sidebar). */
  function blogPageFile() {
    if (store.config.blogPage && store.docs[store.config.blogPage]) return store.config.blogPage;
    // Not recorded (older websites): the best guess is a page called "blog…",
    // then a page listing ALL posts, then any page with a Blog posts box.
    const feeds = store.config.pages.filter((p) => (store.docs[p.file] || { blocks: [] }).blocks.some((b) => b.type === 'blog-feed'));
    const best = feeds.find((p) => /^blog/.test(p.file))
      || feeds.find((p) => store.docs[p.file].blocks.some((b) => b.type === 'blog-feed' && !b.data.limit))
      || feeds[0];
    return best ? best.file : '';
  }

  function flushCanvas() {
    if (isLoading || !store.current || !store.docs[store.current]) return;
    store.docs[store.current].blocks = readCanvas();
  }

  function siteState() {
    flushCanvas();
    return { config: store.config, docs: store.docs, customCss: store.customCss };
  }

  function buildFiles() {
    return F.buildSiteFiles(siteState(), { baseCss: store.baseCss });
  }

  function pendingChanges() {
    const files = buildFiles();
    return Object.entries(files)
      .filter(([path, content]) => !store.remote.has(path) || store.remote.get(path).content !== content)
      .map(([path, content]) => ({ path, content, remote: store.remote.get(path) || null }));
  }

  const draftKey = () => `pebble:site-draft:v2:${service.fullName}`;
  const lastDocKey = () => `pebble:last-doc:v2:${service.fullName}`;

  function persistLocal(pending) {
    try {
      if (pending.length) localStorage.setItem(draftKey(), JSON.stringify({ config: store.config, docs: store.docs, customCss: store.customCss }));
      else localStorage.removeItem(draftKey());
      return true;
    } catch (err) {
      console.warn('Pebble: local copy not saved', err);
      return false;
    }
  }

  function loadLocal() {
    try { return JSON.parse(localStorage.getItem(draftKey()) || 'null'); } catch { return null; }
  }

  let saveTimer = null;
  let lastPending = [];

  function markDirty() {
    if (isLoading) return;
    $('#save-status').textContent = 'Saving…';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, CONFIG.autosaveDelay);
  }

  function flushSave() {
    clearTimeout(saveTimer);
    saveTimer = null;
    lastPending = pendingChanges();
    const ok = persistLocal(lastPending);
    renderSidebar();
    updateSaveStatus(ok);
  }

  function updateSaveStatus(ok = true) {
    const s = $('#save-status');
    s.classList.toggle('is-error', !ok);
    if (!ok) { s.textContent = "⚠ Couldn't keep your changes on this computer (storage is full)"; return; }
    const unsaved = lastPending.length > 0;
    s.textContent = unsaved ? '● Changes not saved yet' : store.draftAhead ? '✓ Draft saved · not live yet' : '✓ Your website is up to date';
    s.classList.toggle('is-unsaved', unsaved);
  }

  /* ========================================================================
     5. DOCS
     ======================================================================== */

  let isSwitching = false;

  function openDoc(file) {
    const doc = store.docs[file];
    if (!doc || isSwitching) return;
    isSwitching = true;
    try {
      if (store.current) flushSave();
      store.current = file;
      loadCanvas(doc.blocks, doc.kind);
      try { localStorage.setItem(lastDocKey(), file); } catch { /* ignore */ }
    } finally {
      isSwitching = false;
    }
    if (doc.kind === 'post') blogExpanded = true;
    renderDocChrome();
    renderSidebar();
    renderInspector();
    $('.canvas-area').scrollTop = 0;
  }

  function renderDocChrome() {
    const kind = currentKind();
    const meta = docMeta(store.current);
    const title = $('#page-title');
    const label = $('#page-title-label');
    if (kind === 'header' || kind === 'footer') {
      title.value = kind === 'header' ? 'Header' : 'Footer';
      title.disabled = true;
      label.textContent = 'Editing the';
    } else {
      title.value = meta ? meta.title : F.nameFromFile(store.current);
      title.disabled = false;
      label.textContent = kind === 'post' ? 'Post title' : 'Page name';
    }
    $('#paper').dataset.kind = kind;
    document.querySelectorAll('#add-drawer .add-tile').forEach((t) => { t.hidden = !allowedHere(t.dataset.widgetType); });
    document.querySelectorAll('#add-drawer .add-group').forEach((g) => { g.hidden = !g.querySelector('.add-tile:not([hidden])'); });
    renderRegionPreviews();
  }

  function uniqueFile(base, folder = '') {
    let file = `${folder}${base}.html`;
    const taken = (f) => store.docs[f] || store.remote.has(f) || ['header.html', 'footer.html', 'index.html'].includes(f);
    for (let i = 2; taken(file); i++) file = `${folder}${base}-${i}.html`;
    return file;
  }

  /** A new page; it goes into the Main Menu (or Other Pages). */
  function createPage(name, inMenu = true) {
    name = name.trim();
    if (!name) return;
    const file = uniqueFile(F.slugify(name, 'page'));
    insertPage({ file, title: name.slice(0, 80), showInNavbar: inMenu });
    store.docs[file] = { kind: 'page', blocks: [] };
    openDoc(file);
    markDirty();
    showToast(`Your new page “${name}” is ready${inMenu ? ' and has a link in your menu' : ''}. Add boxes with “＋ Add”.`);
  }

  /** Put a page at the end of its list (Main Menu or Other Pages). */
  function insertPage(meta) {
    const pages = store.config.pages;
    const lastOfList = pages.map((p) => p.showInNavbar === meta.showInNavbar).lastIndexOf(true);
    pages.splice(lastOfList + 1, 0, meta);
  }

  /** Make sure there's a Blog page; returns its file. */
  function ensureBlogPage() {
    const existing = blogPageFile();
    if (existing) { store.config.blogPage = existing; return existing; }
    const file = uniqueFile('blog');
    insertPage({ file, title: 'Blog', showInNavbar: true });
    store.docs[file] = {
      kind: 'page',
      blocks: [
        { type: 'text', x: 0, y: 0, w: 12, h: 2, data: { html: '<h2>Blog</h2><p>My latest stories.</p>' } },
        { type: 'blog-feed', x: 0, y: 2, w: 12, h: 7, data: { limit: 0 } },
      ],
    };
    store.config.blogPage = file;
    return file;
  }

  function createPost(title) {
    title = title.trim();
    if (!title) return;
    const hadBlog = !!blogPageFile();
    ensureBlogPage();
    const file = uniqueFile(F.slugify(title, 'post'), 'blog/');
    store.config.posts.push({ file, title: title.slice(0, 140), date: F.todayIso(), thumbnail: '', excerpt: '', excerptAuto: true });
    store.docs[file] = { kind: 'post', blocks: [{ type: 'text', x: 0, y: 0, w: 12, h: 4, data: { html: '' } }] };
    blogExpanded = true;
    openDoc(file);
    markDirty();
    showToast(hadBlog ? 'Your new post is ready. Write away!' : 'Your blog has started! Pebble made a “Blog” page that lists your posts — your new post is under it on the left.');
  }

  /* ========================================================================
     6. HEADER / FOOTER PREVIEWS & HERO IMAGE
     ======================================================================== */

  function renderRegionPreviews() {
    const kind = currentKind();
    const showRegions = kind === 'page' || kind === 'post';
    const top = $('#preview-header');
    const bottom = $('#preview-footer');
    const postHead = $('#preview-post-header');
    top.hidden = bottom.hidden = !showRegions;
    postHead.hidden = kind !== 'post';
    renderHeroOnCanvas();
    if (!showRegions) return;

    flushCanvas();
    const ctx = previewCtx();
    top.querySelector('.region-preview__content').innerHTML = F.renderRegion('header', store.docs['header.html'].blocks, ctx);
    bottom.querySelector('.region-preview__content').innerHTML = F.renderRegion('footer', store.docs['footer.html'].blocks, ctx);
    resolveImagesIn(top);
    resolveImagesIn(bottom);

    if (kind === 'post') {
      const meta = postMeta(store.current);
      postHead.innerHTML = '';
      const head = el('header', 'post-header');
      const date = el('p', 'post-header__date');
      date.appendChild(el('time', '', F.formatDate(meta.date)));
      head.append(date, el('h1', 'post-header__title', meta.title));
      if (meta.thumbnail) {
        const fig = el('figure', 'post-header__cover');
        const img = el('img');
        img.alt = '';
        showImage(img, meta.thumbnail);
        fig.appendChild(img);
        head.appendChild(fig);
      }
      postHead.appendChild(head);
    }
  }

  /** While editing the Header: show its hero image on the canvas too. */
  function renderHeroOnCanvas() {
    const paper = $('#paper');
    const box = $('#header-hero');
    const hero = F.normalizeHero(store.config.header && store.config.header.hero);
    const on = currentKind() === 'header' && hero.enabled;
    paper.classList.toggle('has-hero-behind', on && hero.position === 'behind');
    box.hidden = !on;
    box.className = `header-hero header-hero--${hero.position} header-hero--${hero.size}`;
    box.innerHTML = '';
    if (!on) return;
    const img = el('img');
    img.alt = '';
    showImage(img, hero.src);
    box.appendChild(img);
  }

  function updateHero(patch) {
    store.config.header = store.config.header || {};
    store.config.header.hero = F.normalizeHero({ ...(store.config.header.hero || {}), ...patch });
    renderRegionPreviews();
    markDirty();
  }

  /* ========================================================================
     7. SIDEBAR — Main Menu / Other Pages (drag & drop), nested blog posts
     ======================================================================== */

  let blogExpanded = (() => { try { return sessionStorage.getItem('pebble:blog-open') === '1'; } catch { return false; } })();

  function renderSidebar() {
    const pending = new Set(lastPending.map((p) => p.path));
    const blogFile = blogPageFile();

    const itemButton = (file, icon, label, sub) => {
      const btn = el('button', 'page-item' + (file === store.current ? ' is-current' : ''));
      btn.type = 'button';
      btn.dataset.file = file;
      if (file === store.current) btn.setAttribute('aria-current', 'page');
      btn.appendChild(el('span', 'page-item__icon', icon));
      const name = el('span', 'page-item__name', label);
      if (sub) name.appendChild(el('small', 'page-item__date', sub));
      btn.appendChild(name);
      if (pending.has(file)) btn.insertAdjacentHTML('beforeend', '<span class="page-item__dot" title="Changes not saved yet"></span>');
      if (!store.livePaths.has(file)) btn.insertAdjacentHTML('beforeend', '<span class="page-item__badge" title="Not on your website yet">New</span>');
      return btn;
    };

    const pageEntry = (p) => {
      const li = el('li', 'page-entry');
      li.dataset.file = p.file;
      li.draggable = true;
      const row = el('div', 'page-row');
      row.appendChild(el('span', 'page-grip', '⋮⋮'));
      row.appendChild(itemButton(p.file, p.file === 'index.html' ? '🏠' : p.file === blogFile ? '📰' : '📄', p.title));
      const move = el('button', 'page-move', p.showInNavbar ? '↓' : '↑');
      move.type = 'button';
      move.dataset.move = p.file;
      move.title = p.showInNavbar ? 'Move to Other Pages (no menu link)' : 'Move to the Main Menu';
      move.setAttribute('aria-label', move.title);
      row.appendChild(move);
      li.appendChild(row);

      if (p.file === blogFile) {
        const toggle = el('button', 'page-expand', `${blogExpanded ? '▾' : '▸'} ${store.config.posts.length} blog post${store.config.posts.length === 1 ? '' : 's'}`);
        toggle.type = 'button';
        toggle.dataset.toggleBlog = '1';
        toggle.setAttribute('aria-expanded', String(blogExpanded));
        li.appendChild(toggle);
        if (blogExpanded) {
          const ul = el('ul', 'post-list');
          for (const post of F.sortedPosts(store.config)) {
            const pli = el('li');
            pli.appendChild(itemButton(post.file, '✏️', post.title, F.formatDate(post.date)));
            ul.appendChild(pli);
          }
          const add = el('button', 'add-page add-page--post', '＋ Write a blog post');
          add.type = 'button';
          add.dataset.newPost = '1';
          const ali = el('li');
          ali.appendChild(add);
          ul.appendChild(ali);
          li.appendChild(ul);
        }
      }
      return li;
    };

    for (const [id, inMenu] of [['#menu-pages', true], ['#other-pages', false]]) {
      const ul = $(id);
      ul.innerHTML = '';
      const list = store.config.pages.filter((p) => p.showInNavbar === inMenu);
      list.forEach((p) => ul.appendChild(pageEntry(p)));
      if (!list.length) {
        const empty = el('li', 'page-list__empty', inMenu ? 'Drag a page here to give it a menu link.' : 'Drag a page here to take it out of the menu. It stays on your website.');
        ul.appendChild(empty);
      }
    }
    $('#btn-start-blog').hidden = !!blogFile;

    const regions = $('#region-list');
    regions.innerHTML = '';
    for (const [file, icon, label] of [['header.html', '⬆️', 'Header'], ['footer.html', '⬇️', 'Footer']]) {
      const li = el('li');
      li.appendChild(itemButton(file, icon, label));
      regions.appendChild(li);
    }
  }

  /** Move a page to the Main Menu or Other Pages, before another page (or at the end). */
  function movePage(file, inMenu, beforeFile) {
    const pages = store.config.pages;
    const idx = pages.findIndex((p) => p.file === file);
    if (idx < 0) return;
    const [p] = pages.splice(idx, 1);
    const changedList = p.showInNavbar !== inMenu;
    p.showInNavbar = inMenu;
    let at = beforeFile && beforeFile !== file ? pages.findIndex((q) => q.file === beforeFile) : -1;
    if (at < 0) at = pages.map((q) => q.showInNavbar === inMenu).lastIndexOf(true) + 1;
    pages.splice(at, 0, p);
    refreshLiveBlocks();
    renderRegionPreviews();
    renderSidebar();
    renderInspector();
    markDirty();
    if (changedList) showToast(inMenu ? `“${p.title}” now has a link in your website menu.` : `“${p.title}” is no longer in the menu. It’s still on your website.`);
  }

  function wireSidebar() {
    const side = document.querySelector('.sidebar');
    side.addEventListener('click', (e) => {
      const move = e.target.closest('[data-move]');
      if (move) { const p = pageMeta(move.dataset.move); movePage(p.file, !p.showInNavbar); return; }
      if (e.target.closest('[data-toggle-blog]')) {
        blogExpanded = !blogExpanded;
        try { sessionStorage.setItem('pebble:blog-open', blogExpanded ? '1' : '0'); } catch { /* ignore */ }
        renderSidebar();
        return;
      }
      if (e.target.closest('[data-new-post]')) { openNewDocDialog('post'); return; }
      const btn = e.target.closest('.page-item');
      if (btn && btn.dataset.file !== store.current) openDoc(btn.dataset.file);
    });

    // Drag & drop between "Main Menu" and "Other Pages" (and to reorder the menu).
    let dragging = null;
    const clearMarks = () => side.querySelectorAll('.drop-before, .drop-end').forEach((n) => n.classList.remove('drop-before', 'drop-end'));
    side.addEventListener('dragstart', (e) => {
      const li = e.target.closest('.page-entry');
      if (!li) return;
      dragging = li.dataset.file;
      li.classList.add('is-dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', dragging);
    });
    side.addEventListener('dragend', (e) => {
      const li = e.target.closest('.page-entry');
      if (li) li.classList.remove('is-dragging');
      dragging = null;
      clearMarks();
    });
    side.addEventListener('dragover', (e) => {
      if (!dragging) return;
      const list = e.target.closest('.page-list--pages');
      if (!list) return;
      e.preventDefault();
      clearMarks();
      const li = e.target.closest('.page-entry');
      if (li && li.dataset.file !== dragging) li.classList.add('drop-before');
      else if (!li) list.classList.add('drop-end');
    });
    side.addEventListener('drop', (e) => {
      if (!dragging) return;
      const list = e.target.closest('.page-list--pages');
      if (!list) return;
      e.preventDefault();
      const li = e.target.closest('.page-entry');
      movePage(dragging, list.dataset.list === 'menu', li ? li.dataset.file : null);
      clearMarks();
      dragging = null;
    });

    $('#btn-add-page').addEventListener('click', () => openNewDocDialog('page'));
    $('#btn-start-blog').addEventListener('click', () => openNewDocDialog('post'));
  }

  /* ========================================================================
     8. FLOATING TEXT TOOLBAR
     Appears above the text box she's typing in (or pinned under the top
     bar when there's no room), and disappears when she leaves the text.
     ======================================================================== */

  let toolbarEditor = null;   // the text area the toolbar works on
  let savedRange = null;      // her selection, kept while she uses the dropdown

  const toolbar = () => $('#text-toolbar');

  function activeTextEditor() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    const node = sel.anchorNode;
    const e = node && (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement);
    return e ? e.closest('.text-editor') : null;
  }

  function restoreRange() {
    if (!toolbarEditor) return;
    toolbarEditor.focus({ preventScroll: true });
    if (savedRange) {
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(savedRange);
    }
  }

  /** The paragraph/heading elements the selection touches. */
  function blocksInSelection(editor) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return [];
    const range = sel.getRangeAt(0);
    const all = Array.from(editor.querySelectorAll('p, h1, h2, h3, li, blockquote')).filter((b) => !b.querySelector('p, h1, h2, h3, li'));
    let hit = all.filter((b) => range.intersectsNode(b));
    if (!hit.length) {
      // Loose text directly in the box: wrap it in a paragraph first.
      document.execCommand('formatBlock', false, 'p');
      hit = Array.from(editor.querySelectorAll('p, h1, h2, h3, li, blockquote')).filter((b) => window.getSelection().getRangeAt(0).intersectsNode(b));
    }
    return hit;
  }

  function currentBlock(editor) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    let n = sel.anchorNode;
    n = n && (n.nodeType === Node.ELEMENT_NODE ? n : n.parentElement);
    const b = n && n.closest('p, h1, h2, h3, li, blockquote');
    return b && editor.contains(b) ? b : null;
  }

  function styleKeyOf(block) {
    if (!block) return 'paragraph';
    const tag = block.tagName.toLowerCase();
    if (tag === 'h1') return 'title';
    if (tag === 'h2') return 'heading';
    if (tag === 'h3') return 'subheading';
    if (tag === 'p' && block.classList.contains('text-small')) return 'small';
    return 'paragraph';
  }

  function alignOf(block) {
    if (!block) return 'left';
    const m = block.className.match(/\balign-(center|right|justify)\b/);
    if (m) return m[1];
    const s = block.style.textAlign;
    return ['center', 'right', 'justify'].includes(s) ? s : 'left';
  }

  const TOOLBAR_COMMANDS = {
    bold: () => document.execCommand('bold'),
    italic: () => document.execCommand('italic'),
    underline: () => document.execCommand('underline'),
    list: () => document.execCommand('insertUnorderedList'),
    link: () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) { showToast('First select (highlight) the words you want to turn into a link.'); return; }
      const range = sel.getRangeAt(0);
      let url = window.prompt('Paste the website address for this link (or a page, like about.html):', 'https://');
      if (!url || url === 'https://') return;
      url = url.trim();
      if (!/^(https?:|mailto:|#|\/)/i.test(url) && !/^(blog\/)?[a-z0-9-]+\.html$/i.test(url)) url = 'https://' + url;
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand('createLink', false, F.safeUrl(url, 'link'));
    },
  };

  function applyTextStyle(key) {
    restoreRange();
    const def = F.TEXT_STYLES[key];
    document.execCommand('formatBlock', false, def.tag);
    blocksInSelection(toolbarEditor).forEach((b) => b.classList.toggle('text-small', key === 'small'));
  }

  function applyAlign(align) {
    blocksInSelection(toolbarEditor).forEach((b) => {
      b.classList.remove('align-center', 'align-right', 'align-justify', 'align-left');
      b.style.removeProperty('text-align');
      if (align !== 'left') b.classList.add(`align-${align}`);
    });
  }

  function applyHighlight(name) {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) { showToast('First select (highlight) the words you want to color.'); return; }
    const range = sel.getRangeAt(0);
    // Remove existing highlights in the selection first.
    toolbarEditor.querySelectorAll('mark, span[style*="background"]').forEach((m) => {
      if (range.intersectsNode(m)) m.replaceWith(...m.childNodes);
    });
    if (name) {
      document.execCommand('styleWithCSS', false, true);
      document.execCommand('hiliteColor', false, F.HIGHLIGHTS[name].color);
      document.execCommand('styleWithCSS', false, false);
    }
  }

  function afterToolbarChange() {
    if (!toolbarEditor) return;
    toolbarEditor.dispatchEvent(new Event('input', { bubbles: true }));
    updateToolbarState();
  }

  function positionToolbar() {
    const tb = toolbar();
    if (!toolbarEditor || tb.hidden) return;
    const box = (toolbarEditor.closest('.block-body') || toolbarEditor).getBoundingClientRect();
    const topLimit = $('.topbar').getBoundingClientRect().bottom + 8;
    const h = tb.offsetHeight;
    let top = box.top - h - 10;
    tb.classList.toggle('is-pinned', top < topLimit);
    if (top < topLimit) top = topLimit; // no room above: pin it under the top bar
    const left = Math.max(8, Math.min(box.left, window.innerWidth - tb.offsetWidth - 8));
    tb.style.top = `${top}px`;
    tb.style.left = `${left}px`;
  }

  function showToolbar(editor) {
    toolbarEditor = editor;
    const tb = toolbar();
    tb.hidden = false;
    renderStyleOptions();
    updateToolbarState();
    positionToolbar();
  }

  function hideToolbar() {
    toolbar().hidden = true;
    $('#tt-palette').hidden = true;
    toolbarEditor = null;
    savedRange = null;
  }

  function renderStyleOptions() {
    const select = $('#tt-style');
    const styles = F.normalizeTypography(store.config.typography).styles;
    const current = select.value;
    select.innerHTML = '';
    for (const key of Object.keys(F.TEXT_STYLES)) {
      const o = el('option', '', styles[key].name);
      o.value = key;
      select.appendChild(o);
    }
    select.value = current || 'paragraph';
  }

  function updateToolbarState() {
    if (!toolbarEditor) return;
    const block = currentBlock(toolbarEditor);
    $('#tt-style').value = styleKeyOf(block);
    const align = alignOf(block);
    toolbar().querySelectorAll('[data-align]').forEach((b) => b.classList.toggle('is-on', b.dataset.align === align));
    for (const cmd of ['bold', 'italic', 'underline']) {
      let on = false;
      try { on = document.queryCommandState(cmd); } catch { /* ignore */ }
      const b = toolbar().querySelector(`[data-cmd="${cmd}"]`);
      if (b) b.classList.toggle('is-on', on);
    }
  }

  function wireToolbar() {
    const tb = toolbar();

    // Highlight palette
    const palette = $('#tt-palette');
    for (const [name, h] of Object.entries(F.HIGHLIGHTS)) {
      const b = el('button', 'tt-swatch');
      b.type = 'button';
      b.dataset.highlight = name;
      b.style.background = h.color;
      b.title = h.label;
      b.setAttribute('aria-label', `${h.label} highlight`);
      palette.insertBefore(b, palette.lastElementChild);
    }

    // Keep the text selection when clicking toolbar buttons.
    tb.addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
    tb.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn || !toolbarEditor) return;
      if (btn.dataset.cmd === 'highlight') { palette.hidden = !palette.hidden; return; }
      if (btn.dataset.highlight != null) { applyHighlight(btn.dataset.highlight); palette.hidden = true; afterToolbarChange(); return; }
      if (btn.dataset.align) { applyAlign(btn.dataset.align); afterToolbarChange(); return; }
      if (btn.dataset.cmd && TOOLBAR_COMMANDS[btn.dataset.cmd]) { TOOLBAR_COMMANDS[btn.dataset.cmd](); afterToolbarChange(); }
    });
    $('#tt-style').addEventListener('change', (e) => { applyTextStyle(e.target.value); afterToolbarChange(); });

    // Show when a text box is focused; hide when she leaves it.
    document.addEventListener('focusin', (e) => {
      const ed = e.target.closest && e.target.closest('.text-editor');
      if (ed) showToolbar(ed);
    });
    document.addEventListener('focusout', () => {
      setTimeout(() => {
        const a = document.activeElement;
        if (a && (a.closest('#text-toolbar') || a.closest('.text-editor'))) return;
        hideToolbar();
      }, 0);
    });
    // Also follow the text cursor itself (doesn't depend on focus events).
    document.addEventListener('selectionchange', () => {
      const ed = activeTextEditor();
      if (ed && ed !== toolbarEditor && ed.isContentEditable) showToolbar(ed);
      if (ed && ed === toolbarEditor) {
        const sel = window.getSelection();
        if (sel.rangeCount) savedRange = sel.getRangeAt(0).cloneRange();
        updateToolbarState();
      }
    });
    $('.canvas-area').addEventListener('scroll', positionToolbar, { passive: true });
    window.addEventListener('resize', positionToolbar);
    try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch { /* ignore */ }
  }

  /* ========================================================================
     9. INSPECTOR — the right-hand settings panel
     Shows the clicked box's settings; with nothing selected, the settings
     of the page / post / Header / Footer being edited.
     ======================================================================== */

  function linkOptions(allowNone) {
    const opts = [['', allowNone || '— Choose a page —']];
    for (const p of store.config.pages) opts.push([p.file, `📄 ${p.title}`]);
    for (const p of F.sortedPosts(store.config)) opts.push([p.file, `📰 ${p.title}`]);
    opts.push(['__external__', '🌐 Another website…']);
    return opts;
  }

  /** Build one Inspector field. onChange(value) applies it. */
  function inspectorField(f, value, onChange) {
    if (f.type === 'note') return el('p', 'insp-note', f.text);
    const row = el('div', 'insp-field');
    const id = `insp-${f.key}`;
    const label = el('label', 'insp-label', f.label);
    label.htmlFor = id;
    row.appendChild(label);

    if (f.type === 'text') {
      const input = el('input', 'insp-input');
      input.id = id;
      input.type = 'text';
      input.value = value || '';
      input.dataset.key = f.key;
      if (f.placeholder) input.placeholder = f.placeholder;
      input.addEventListener('input', () => onChange(input.value));
      row.appendChild(input);
    } else if (f.type === 'textarea') {
      const ta = el('textarea', 'insp-input');
      ta.id = id;
      ta.rows = 3;
      ta.value = value || '';
      if (f.placeholder) ta.placeholder = f.placeholder;
      ta.addEventListener('input', () => onChange(ta.value));
      row.appendChild(ta);
    } else if (f.type === 'select') {
      const sel = el('select', 'insp-input');
      sel.id = id;
      for (const [v, t] of f.options) { const o = el('option', '', t); o.value = v; sel.appendChild(o); }
      sel.value = value == null ? '' : String(value);
      sel.addEventListener('change', () => onChange(f.number ? parseInt(sel.value, 10) : sel.value));
      row.appendChild(sel);
    } else if (f.type === 'link') {
      const sel = el('select', 'insp-input');
      sel.id = id;
      for (const [v, t] of linkOptions(f.allowNone)) { const o = el('option', '', t); o.value = v; sel.appendChild(o); }
      const internal = !value || store.docs[value];
      sel.value = internal ? (value || '') : '__external__';
      const ext = el('input', 'insp-input insp-input--external');
      ext.type = 'url';
      ext.placeholder = 'https://www.example.com';
      ext.value = internal ? '' : value;
      ext.hidden = internal;
      const applyExt = () => {
        let v = ext.value.trim();
        if (v && !/^(https?:|mailto:|tel:)/i.test(v)) v = 'https://' + v;
        onChange(F.safeUrl(v, 'link'));
      };
      sel.addEventListener('change', () => {
        ext.hidden = sel.value !== '__external__';
        if (ext.hidden) onChange(sel.value); else { ext.focus(); applyExt(); }
      });
      ext.addEventListener('input', applyExt);
      row.append(sel, ext);
    } else if (f.type === 'color') {
      const box = el('div', 'insp-colors');
      const t = F.normalizeTheme(store.config.theme);
      const choices = [['', f.defaultLabel || 'Default'], [t.primaryColor, 'Main color'], [t.secondaryColor, 'Second color'],
        ['#ffffff', 'White'], ['#f7f3ec', 'Cream'], ['#eef3f8', 'Light blue'], ['#2d2a26', 'Dark']];
      const draw = (current) => {
        box.innerHTML = '';
        for (const [c, name] of choices) {
          const b = el('button', 'insp-swatch' + (c === '' ? ' insp-swatch--default' : '') + ((current || '') === c ? ' is-on' : ''));
          b.type = 'button';
          b.title = name;
          b.setAttribute('aria-label', name);
          if (c) b.style.background = c; else b.textContent = '∅';
          b.addEventListener('click', () => { onChange(c); draw(c); });
          box.appendChild(b);
        }
        const custom = el('label', 'insp-swatch insp-swatch--custom', '＋');
        custom.title = 'Pick any color';
        const pick = el('input');
        pick.type = 'color';
        pick.value = current || '#ffffff';
        pick.setAttribute('aria-label', 'Pick any color');
        pick.addEventListener('input', () => { onChange(pick.value); box.querySelectorAll('.is-on').forEach((n) => n.classList.remove('is-on')); });
        custom.appendChild(pick);
        box.appendChild(custom);
      };
      draw(value);
      row.appendChild(box);
    } else if (f.type === 'radius') {
      const useSite = el('label', 'insp-check');
      const cb = el('input');
      cb.type = 'checkbox';
      cb.checked = value === '' || value == null;
      useSite.append(cb, document.createTextNode(' Same as the rest of the website'));
      const range = el('input', 'insp-range');
      range.type = 'range';
      range.min = 0;
      range.max = 40;
      range.value = value === '' || value == null ? F.normalizeTheme(store.config.theme).borderRadius : value;
      range.hidden = cb.checked;
      const labels = el('div', 'range-labels');
      labels.innerHTML = '<span>Square</span><span>Round</span>';
      labels.hidden = cb.checked;
      cb.addEventListener('change', () => {
        range.hidden = labels.hidden = cb.checked;
        onChange(cb.checked ? '' : parseInt(range.value, 10));
      });
      range.addEventListener('input', () => onChange(parseInt(range.value, 10)));
      row.append(useSite, range, labels);
    } else if (f.type === 'photo') {
      const box = el('div', 'insp-photo');
      if (value) {
        const img = el('img');
        img.alt = '';
        showImage(img, value);
        box.appendChild(img);
      } else {
        box.appendChild(el('span', 'insp-photo__none', 'No photo yet'));
      }
      const actions = el('div', 'insp-photo__actions');
      const pick = el('button', 'btn btn--secondary btn--small', value ? '🔄 Replace photo' : '📷 Choose a photo');
      pick.type = 'button';
      pick.addEventListener('click', () => openMediaLibrary({ current: value, onPick: (p) => { onChange(p); renderInspector(); } }));
      actions.appendChild(pick);
      if (f.removable && value) {
        const rm = el('button', 'link-btn link-btn--inline', 'Remove');
        rm.type = 'button';
        rm.addEventListener('click', () => { onChange(''); renderInspector(); });
        actions.appendChild(rm);
      }
      row.append(box, actions);
    } else if (f.type === 'code') {
      if (f.warning) {
        const warn = el('div', 'settings-warning');
        warn.appendChild(el('strong', '', '⚠️ Careful'));
        warn.appendChild(el('span', '', f.warning));
        row.insertBefore(warn, label);
      }
      const ta = el('textarea', 'insp-input insp-code');
      ta.id = id;
      ta.rows = 10;
      ta.spellcheck = false;
      ta.value = value || '';
      ta.placeholder = '<iframe src="…"></iframe>';
      ta.addEventListener('input', () => onChange(ta.value));
      row.appendChild(ta);
    } else if (f.type === 'date') {
      const input = el('input', 'insp-input');
      input.id = id;
      input.type = 'date';
      input.value = value || '';
      input.addEventListener('change', () => onChange(input.value));
      row.appendChild(input);
    } else if (f.type === 'toggle') {
      const lab = el('label', 'toggle');
      const cb = el('input');
      cb.type = 'checkbox';
      cb.id = id;
      cb.checked = !!value;
      lab.append(cb, el('span', 'toggle__switch'), document.createTextNode(` ${f.text || ''}`));
      cb.addEventListener('change', () => onChange(cb.checked));
      label.remove();
      row.appendChild(lab);
    }
    if (f.help) row.appendChild(el('p', 'insp-help', f.help));
    return row;
  }

  /** Keep an Inspector input in step when the same value is edited on the canvas. */
  function syncInspectorField(key, value) {
    const input = document.querySelector(`#inspector [data-key="${key}"]`);
    if (input && document.activeElement !== input) input.value = value;
  }

  function renderInspector() {
    const body = $('#inspector-body');
    body.innerHTML = '';
    if (selected && selected.isConnected) renderBlockInspector(body, selected);
    else renderDocInspector(body);
  }

  function renderBlockInspector(body, item) {
    const type = item.dataset.widgetType;
    const ed = EDITORS[type];
    const node = editorOf(item);
    const head = el('div', 'insp-head');
    head.append(el('span', 'insp-head__icon', ed.icon), el('h2', 'insp-head__title', ed.label));
    const close = el('button', 'insp-head__close', '✕');
    close.type = 'button';
    close.title = 'Done with this box';
    close.addEventListener('click', () => selectBlock(null));
    head.appendChild(close);
    body.appendChild(head);

    const data = ed.read(node);
    for (const f of ed.inspector || []) {
      body.appendChild(inspectorField(f, data[f.key], (value) => {
        const current = ed.read(node);       // pick up what she typed on the canvas
        current[f.key] = value;
        node._data = { ...node._data, ...current };
        node._render();
        markDirty();
      }));
    }

    const remove = el('button', 'insp-remove', '🗑 Remove this box');
    remove.type = 'button';
    remove.addEventListener('click', () => removeBlock(item));
    body.appendChild(remove);
  }

  function renderDocInspector(body) {
    const kind = currentKind();
    const file = store.current;
    const head = el('div', 'insp-head');
    const icons = { page: '📄', post: '✏️', header: '⬆️', footer: '⬇️' };
    const titles = { page: 'Page settings', post: 'Blog post', header: 'Header', footer: 'Footer' };
    head.append(el('span', 'insp-head__icon', icons[kind]), el('h2', 'insp-head__title', titles[kind]));
    body.appendChild(head);

    if (kind === 'page') {
      const meta = pageMeta(file);
      body.appendChild(el('p', 'insp-note', `Web address ends in ${file}`));
      const where = el('div', 'insp-field');
      where.appendChild(el('span', 'insp-label', 'Where this page is listed'));
      where.appendChild(el('p', 'insp-value', meta.showInNavbar ? '✓ In the Main Menu (it has a link in your website menu)' : 'In Other Pages (no link in the menu)'));
      const move = el('button', 'btn btn--secondary btn--small', meta.showInNavbar ? 'Move to Other Pages' : 'Add to the Main Menu');
      move.type = 'button';
      move.addEventListener('click', () => movePage(file, !meta.showInNavbar));
      where.appendChild(move);
      body.appendChild(where);
      if (file === blogPageFile()) body.appendChild(el('p', 'insp-note', '📰 This is your blog page. Your posts are listed under it on the left.'));
    } else if (kind === 'post') {
      const meta = postMeta(file);
      const update = (patch) => { Object.assign(meta, patch); renderRegionPreviews(); markDirty(); };
      body.appendChild(inspectorField({ key: 'date', type: 'date', label: 'Date' }, meta.date, (v) => { if (/^\d{4}-\d{2}-\d{2}$/.test(v)) update({ date: v }); }));
      body.appendChild(inspectorField({ key: 'thumbnail', type: 'photo', label: 'Cover photo', removable: true }, meta.thumbnail, (v) => update({ thumbnail: v })));
      body.appendChild(inspectorField({ key: 'excerpt', type: 'textarea', label: 'Short summary', placeholder: 'Leave empty and Pebble uses the first words of your post', help: 'Shown under the post on your blog page.' },
        meta.excerptAuto ? '' : meta.excerpt, (v) => update({ excerpt: v.trim(), excerptAuto: !v.trim() })));
    } else if (kind === 'header') {
      body.appendChild(el('p', 'insp-note', 'The Header is the top of every page: your website name, the menu, and anything else you add here appears on all pages and blog posts.'));
      const hero = F.normalizeHero(store.config.header && store.config.header.hero);
      const section = el('div', 'insp-section');
      section.appendChild(el('h3', 'insp-section__title', '🌄 Hero image'));
      section.appendChild(el('p', 'insp-help', 'A big photo at the top of every page.'));
      section.appendChild(inspectorField({ key: 'heroSrc', type: 'photo', label: 'Photo' }, hero.src, (v) => updateHero({ src: v, enabled: !!v })));
      if (hero.src) {
        section.appendChild(inspectorField({ key: 'heroOn', type: 'toggle', text: 'Show the hero image' }, hero.enabled, (v) => updateHero({ enabled: v })));
        section.appendChild(inspectorField({ key: 'heroPos', type: 'select', label: 'Where', options: [['behind', 'Behind the website name and menu'], ['below', 'Below the menu, as a wide banner']] }, hero.position, (v) => updateHero({ position: v })));
        section.appendChild(inspectorField({ key: 'heroSize', type: 'select', label: 'Height', options: [['small', 'Small'], ['medium', 'Medium'], ['large', 'Large']] }, hero.size, (v) => updateHero({ size: v })));
      }
      body.appendChild(section);
    } else if (kind === 'footer') {
      body.appendChild(el('p', 'insp-note', 'The Footer is the bottom of every page. Good places for: a copyright line, your email address, or links to other pages.'));
    }
    body.appendChild(el('p', 'insp-tip', '💡 Click a box on the page to change its settings here.'));
  }

  /* ========================================================================
     10. SITE SETTINGS — colours, fonts, text styles, roundness, spacing
     ======================================================================== */

  function applyTheme() {
    $('#site-theme').textContent = F.globalCss(store.config.theme, store.baseCss, store.config.typography);
    $('#site-custom').textContent = store.customCss || '';
    const spacing = F.normalizeTheme(store.config.theme).blockSpacing;
    if (grid && grid.getMargin() !== spacing / 2) grid.margin(spacing / 2);
  }

  const COLOR_SWATCHES = {
    primary: ['#b85c38', '#2f6fdf', '#1f8a4c', '#8e44ad', '#c0392b', '#1d3557', '#d4a017', '#2d2a26'],
    secondary: ['#6b8b4f', '#e9a03b', '#3aa8a0', '#d76a85', '#7a8ca3', '#a0522d', '#5c6bc0', '#b5838d'],
  };

  const WEIGHT_NAMES = { 300: 'Light', 400: 'Normal', 500: 'Medium', 600: 'Semi-bold', 700: 'Bold', 800: 'Extra bold', 900: 'Black' };

  function renderSettings() {
    const t = F.normalizeTheme(store.config.theme);
    const ty = F.normalizeTypography(store.config.typography);
    $('#set-site-name').value = store.config.siteName;
    for (const which of ['primary', 'secondary']) {
      const value = t[`${which}Color`];
      $(`#set-${which}`).value = value;
      document.querySelectorAll(`[data-swatch="${which}"]`).forEach((b) => b.classList.toggle('is-on', b.dataset.color === value));
    }
    // Fonts: the list, plus the custom font if there is one
    const font = $('#set-font');
    const customOpt = font.querySelector('option[value="custom"]');
    if (ty.customFont) { customOpt.hidden = false; customOpt.textContent = `${ty.customFont.name} (your own font)`; } else customOpt.hidden = true;
    font.value = t.fontFamily === 'custom' && !ty.customFont ? 'classic' : t.fontFamily;
    $('#custom-font-status').textContent = ty.customFont ? `✓ Using “${ty.customFont.name}”` : '';
    $('#custom-font-status').className = 'custom-font__status' + (ty.customFont ? ' is-ok' : '');
    $('#btn-custom-font-clear').hidden = !ty.customFont;

    $('#set-radius').value = t.borderRadius;
    $('#set-spacing').value = t.blockSpacing;
    $('#set-custom-css').value = store.customCss || '';
    renderTextStyleSettings();
  }

  /** The five text styles, each with name / size / line spacing / boldness. */
  function renderTextStyleSettings() {
    const box = $('#text-styles');
    const ty = F.normalizeTypography(store.config.typography);
    const openKey = box.querySelector('details[open]') && box.querySelector('details[open]').dataset.key;
    box.innerHTML = '';
    for (const [key, def] of Object.entries(F.TEXT_STYLES)) {
      const s = ty.styles[key];
      const d = el('details', 'text-style');
      d.dataset.key = key;
      if (key === openKey) d.open = true;
      const sum = el('summary', 'text-style__summary');
      const sample = el('span', 'text-style__sample', s.name);
      sample.style.fontSize = `${Math.min(s.size, 30)}px`;
      sample.style.fontWeight = s.weight;
      sample.style.fontFamily = 'var(--font-family)';
      sum.append(sample, el('span', 'text-style__meta', `${s.size}px · ${WEIGHT_NAMES[s.weight] || s.weight}`));
      d.appendChild(sum);

      const rows = el('div', 'text-style__fields');
      const field = (label, input) => { const r = el('label', 'text-style__field'); r.append(el('span', '', label), input); return r; };

      const name = el('input', 'settings-input');
      name.type = 'text';
      name.maxLength = 30;
      name.value = s.name;
      name.addEventListener('input', () => updateTextStyle(key, { name: name.value || def.name }, false));
      rows.appendChild(field('Name', name));

      const size = el('input', 'settings-range');
      size.type = 'range'; size.min = 10; size.max = 96; size.value = s.size;
      const sizeOut = el('output', 'text-style__out', `${s.size}px`);
      size.addEventListener('input', () => { sizeOut.textContent = `${size.value}px`; updateTextStyle(key, { size: size.value }); });
      const sizeWrap = el('div', 'text-style__range'); sizeWrap.append(size, sizeOut);
      rows.appendChild(field('Size', sizeWrap));

      const lh = el('input', 'settings-range');
      lh.type = 'range'; lh.min = 0.9; lh.max = 2.4; lh.step = 0.05; lh.value = s.lineHeight;
      const lhOut = el('output', 'text-style__out', String(s.lineHeight));
      lh.addEventListener('input', () => { lhOut.textContent = lh.value; updateTextStyle(key, { lineHeight: lh.value }); });
      const lhWrap = el('div', 'text-style__range'); lhWrap.append(lh, lhOut);
      rows.appendChild(field('Line spacing', lhWrap));

      const weight = el('select', 'settings-input');
      for (const w of F.WEIGHTS) { const o = el('option', '', WEIGHT_NAMES[w]); o.value = w; weight.appendChild(o); }
      weight.value = s.weight;
      weight.addEventListener('change', () => updateTextStyle(key, { weight: weight.value }));
      rows.appendChild(field('Boldness', weight));

      d.appendChild(rows);
      box.appendChild(d);
    }
  }

  function updateTextStyle(key, patch, redraw = true) {
    const ty = F.normalizeTypography(store.config.typography);
    ty.styles[key] = { ...ty.styles[key], ...patch };
    store.config.typography = F.normalizeTypography(ty);
    applyTheme();
    markDirty();
    const d = document.querySelector(`#text-styles details[data-key="${key}"]`);
    if (d) {
      const s = store.config.typography.styles[key];
      const sample = d.querySelector('.text-style__sample');
      sample.textContent = s.name;
      sample.style.fontSize = `${Math.min(s.size, 30)}px`;
      sample.style.fontWeight = s.weight;
      d.querySelector('.text-style__meta').textContent = `${s.size}px · ${WEIGHT_NAMES[s.weight] || s.weight}`;
    }
    if (!redraw) renderStyleOptions();
  }

  function updateTheme(patch) {
    store.config.theme = F.normalizeTheme({ ...store.config.theme, ...patch });
    applyTheme();
    markDirty();
  }

  function wireSettings() {
    const dialog = $('#settings-dialog');
    $('#btn-settings').addEventListener('click', () => { renderSettings(); dialog.showModal(); });

    for (const which of ['primary', 'secondary']) {
      const row = $(`#swatches-${which}`);
      COLOR_SWATCHES[which].forEach((color) => {
        const b = el('button', 'swatch');
        b.type = 'button';
        b.dataset.swatch = which;
        b.dataset.color = color;
        b.style.background = color;
        b.title = color;
        b.setAttribute('aria-label', `Use color ${color}`);
        b.addEventListener('click', () => { updateTheme({ [`${which}Color`]: color }); renderSettings(); });
        row.insertBefore(b, row.lastElementChild);
      });
      $(`#set-${which}`).addEventListener('input', (e) => { updateTheme({ [`${which}Color`]: e.target.value }); renderSettings(); });
    }

    // Font list: popular fonts first, older choices after.
    const font = $('#set-font');
    const popular = el('optgroup');
    popular.label = 'Popular fonts';
    const older = el('optgroup');
    older.label = 'More';
    for (const [key, f] of Object.entries(F.FONTS)) {
      const opt = el('option', '', f.label);
      opt.value = key;
      (['elegant', 'friendly', 'rounded', 'typewriter'].includes(key) ? older : popular).appendChild(opt);
    }
    const customOpt = el('option', '', 'Your own font');
    customOpt.value = 'custom';
    customOpt.hidden = true;
    font.append(popular, older, customOpt);
    font.addEventListener('change', () => updateTheme({ fontFamily: font.value }));

    // The font escape hatch
    const customInput = $('#set-custom-font');
    const useCustom = () => {
      const parsed = F.parseCustomFont(customInput.value);
      const status = $('#custom-font-status');
      if (!parsed) {
        status.className = 'custom-font__status is-error';
        status.textContent = 'Pebble couldn’t find a Google font in that. Paste a font name (like “Dancing Script”) or the link from fonts.google.com.';
        return;
      }
      store.config.typography = F.normalizeTypography({ ...store.config.typography, customFont: parsed });
      store.config.theme = F.normalizeTheme({ ...store.config.theme, fontFamily: 'custom' });
      applyTheme();
      markDirty();
      customInput.value = '';
      renderSettings();
    };
    $('#btn-custom-font').addEventListener('click', useCustom);
    customInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); useCustom(); } });
    $('#btn-custom-font-clear').addEventListener('click', () => {
      store.config.typography = F.normalizeTypography({ ...store.config.typography, customFont: null });
      if (store.config.theme.fontFamily === 'custom') store.config.theme = F.normalizeTheme({ ...store.config.theme, fontFamily: 'classic' });
      applyTheme();
      markDirty();
      renderSettings();
    });

    $('#set-radius').addEventListener('input', (e) => updateTheme({ borderRadius: e.target.value }));
    $('#set-spacing').addEventListener('input', (e) => updateTheme({ blockSpacing: e.target.value }));
    $('#set-site-name').addEventListener('input', (e) => {
      store.config.siteName = e.target.value.trim() || 'My website';
      refreshLiveBlocks();
      renderRegionPreviews();
      markDirty();
    });

    const css = $('#set-custom-css');
    css.addEventListener('input', () => { store.customCss = css.value; applyTheme(); markDirty(); });
    const upload = $('#file-css');
    $('#btn-upload-css').addEventListener('click', () => { upload.value = ''; upload.click(); });
    upload.addEventListener('change', async () => {
      const file = upload.files[0];
      if (!file) return;
      if (file.size > 200 * 1024) { showToast('That file is too big for a style file.'); return; }
      store.customCss = await file.text();
      css.value = store.customCss;
      applyTheme();
      markDirty();
      showToast(`Added “${file.name}”.`);
    });
    dialog.addEventListener('close', () => { refreshLiveBlocks(); renderInspector(); });
  }

  /* ========================================================================
     11. ADD DRAWER
     ======================================================================== */

  function buildDrawer() {
    const groups = [
      ['Basics', ['text', 'image', 'card', 'button']],
      ['Blog', ['blog-feed']],
      ['Website parts', ['site-title', 'menu']],
      ['For website helpers', ['embed']],
    ];
    const list = $('#add-groups');
    for (const [title, types] of groups) {
      const group = el('section', 'add-group' + (title === 'For website helpers' ? ' add-group--advanced' : ''));
      group.appendChild(el('h3', 'add-group__title', title));
      for (const type of types) {
        const ed = EDITORS[type];
        const tile = el('div', 'add-tile');
        tile.dataset.widgetType = type;
        tile.setAttribute('gs-w', ed.size.w);
        tile.setAttribute('gs-h', ed.size.h);
        tile.tabIndex = 0;
        tile.setAttribute('role', 'button');
        tile.innerHTML = `<span class="add-tile__icon" aria-hidden="true">${ed.icon}</span><span class="add-tile__text"><strong></strong><small></small></span>`;
        tile.querySelector('strong').textContent = ed.label;
        tile.querySelector('small').textContent = ed.hint;
        group.appendChild(tile);
      }
      list.appendChild(group);
    }
  }

  function openDrawer() { $('#add-drawer').hidden = false; $('#btn-add').setAttribute('aria-expanded', 'true'); }
  function closeDrawer() { $('#add-drawer').hidden = true; $('#btn-add').setAttribute('aria-expanded', 'false'); }

  function afterAdd(item) {
    markDirty();
    closeDrawer();
    selectBlock(item);   // its settings show on the right straight away
  }

  function wireDrawer() {
    buildDrawer();
    $('#btn-add').addEventListener('click', () => ($('#add-drawer').hidden ? openDrawer() : closeDrawer()));
    $('#add-close').addEventListener('click', closeDrawer);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#add-drawer').hidden) closeDrawer(); });

    GridStack.setupDragIn('#add-drawer .add-tile', { appendTo: 'body', helper: 'clone' });
    grid.on('dropped', (_e, _prev, node) => {
      if (!node || !node.el) return;
      const { el: dropped, x, y } = node;
      const type = dropped.dataset.widgetType;
      grid.removeWidget(dropped, true, false);
      const item = addBlock(type, null, { x, y }, { focus: true });
      if (item) afterAdd(item);
    });
    $('#add-groups').addEventListener('click', (e) => {
      const tile = e.target.closest('.add-tile');
      if (!tile) return;
      const item = addBlock(tile.dataset.widgetType, null, null, { focus: true });
      if (item) afterAdd(item);
    });
    $('#add-groups').addEventListener('keydown', (e) => {
      const tile = e.target.closest('.add-tile');
      if (tile && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); tile.click(); }
    });
  }

  /* ========================================================================
     12. SAVE DRAFT & PUBLISH LIVE
     ======================================================================== */

  let isBusy = false;

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

  function friendlyError(err, action) {
    console.error(`Pebble: ${action} failed`, err);
    if (err && err.status === 409) return 'Your website was changed somewhere else (maybe on another computer). Please reload the page, then try again — your changes on this computer are kept.';
    if (err && (err.status === 401 || err.status === 403)) return 'Pebble lost its connection to your hosting account. Please connect it again.';
    if (err instanceof TypeError) return "You seem to be offline. Your changes are kept on this computer — try again when you're connected.";
    return `Sorry, ${action} didn't work. Your changes are kept on this computer. Please try again in a moment.`;
  }

  function commitMessage(path, isNew) {
    const meta = docMeta(path);
    if (meta) return `${isNew ? 'Add' : 'Update'} ${postMeta(path) ? 'blog post' : 'page'} “${meta.title}”`;
    return {
      'site-config.json': 'Update site settings',
      'global.css': 'Update site design',
      'theme.css': 'Update custom styles',
      'header.html': 'Update the header',
      'footer.html': 'Update the footer',
    }[path] || `Update ${path}`;
  }

  async function commitChangesToDraft() {
    flushCanvas();
    const changes = pendingChanges();
    for (const ch of changes) {
      const result = await service.commitFile(ch.path, ch.content, { message: commitMessage(ch.path, !ch.remote), sha: ch.remote ? ch.remote.sha : undefined });
      store.remote.set(ch.path, { content: ch.content, sha: result.sha });
    }
    if (changes.length) {
      store.hasDraftBranch = true;
      store.draftAhead = true;
      store.upgraded = false;
    }
    lastPending = pendingChanges();
    persistLocal(lastPending);
    return changes;
  }

  async function saveDraft() {
    if (isBusy) return;
    flushSave();
    if (!lastPending.length) {
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
      renderSidebar();
      updateSaveStatus();
    }
  }

  async function publishLive() {
    if (isBusy) return;
    setBusy('publish', 'Publishing…');
    try {
      await commitChangesToDraft();
      const diff = await service.compareDraftToLive();
      if (!diff.ahead) {
        store.draftAhead = false;
        showToast('Your website is already up to date. 👍');
        return;
      }
      try {
        await service.publishDraft('Publish website');
      } catch (err) {
        if (err.status !== 409) throw err;
        setBusy(null);
        if (!(await askToReplaceOtherChanges())) {
          showToast('Nothing was changed on your website. Your draft is still saved.');
          return;
        }
        setBusy('publish', 'Publishing…');
        await service.forcePublishDraft('Publish website');
        await refreshRemoteFiles();
      }
      store.draftAhead = false;
      diff.files.forEach((f) => store.livePaths.add(f.path));
      showPublishDone(diff.files);
    } catch (err) {
      showToast(friendlyError(err, 'publishing'));
    } finally {
      setBusy(null);
      renderSidebar();
      updateSaveStatus();
    }
  }

  function askToReplaceOtherChanges() {
    return new Promise((resolve) => {
      const dialog = $('#conflict-dialog');
      const form = dialog.querySelector('form');
      const done = (answer) => { form.removeEventListener('submit', onSubmit); dialog.removeEventListener('cancel', onCancel); resolve(answer); };
      const onSubmit = (e) => { e.preventDefault(); dialog.close(); done(!!(e.submitter && e.submitter.value === 'replace')); };
      const onCancel = () => done(false);
      form.addEventListener('submit', onSubmit);
      dialog.addEventListener('cancel', onCancel);
      dialog.showModal();
    });
  }

  async function refreshRemoteFiles() {
    const paths = Array.from(store.remote.keys());
    await Promise.all(paths.map(async (path) => {
      try {
        const f = await service.fetchFile(path, readRef());
        store.remote.set(path, { content: f.content, sha: f.sha });
      } catch (err) {
        if (err.status === 404) store.remote.delete(path); else throw err;
      }
    }));
  }

  function showPublishDone(files) {
    const rows = [];
    const added = new Set(files.filter((f) => f.status === 'added').map((f) => f.path));
    const paths = files.filter((f) => f.status !== 'removed').map((f) => f.path);
    for (const path of paths) {
      const meta = docMeta(path);
      if (meta) rows.push(`${postMeta(path) ? '📰' : '📄'} ${F.escapeHtml(meta.title)}${added.has(path) ? ' <span class="tag">new</span>' : ''}`);
    }
    if (paths.some((p) => p === 'header.html' || p === 'footer.html')) rows.push('⬆⬇ Header and footer');
    if (paths.some((p) => p === 'global.css' || p === 'theme.css')) rows.push('🎨 Your website’s look');
    const photos = files.filter((f) => f.path.startsWith(service.imageDir + '/') && f.status === 'added').length;
    if (photos) rows.push(`🖼️ ${photos} new photo${photos > 1 ? 's' : ''}`);
    if (!rows.length) rows.push('Your latest changes');
    $('#publish-list').innerHTML = rows.map((r) => `<li>${r}</li>`).join('');
    const link = $('#publish-url');
    link.href = service.siteUrl;
    link.textContent = service.siteUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
    $('#publish-demo-note').hidden = !service.isDemo;
    $('#publish-dialog').showModal();
  }

  /* ========================================================================
     13. PHOTOS
     ======================================================================== */

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
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not convert photo'))), file.type === 'image/png' ? 'image/png' : 'image/jpeg', 0.85);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(Object.assign(new Error('Could not read photo'), { code: 'unreadable' })); };
      img.src = url;
    });
  }

  const isRepoPath = (src) => !!src && !/^(data:|blob:|https?:)/i.test(src);

  function resolveImageUrl(src) {
    if (!isRepoPath(src)) return Promise.resolve(src);
    return service.getImageUrl(src.replace(/^\.?\//, ''), readRef());
  }

  function showImage(img, src) {
    if (!isRepoPath(src)) { img.src = src; return; }
    img.classList.add('is-loading');
    resolveImageUrl(src)
      .then((url) => { img.src = url; })
      .catch((err) => { console.warn('Pebble: photo not found', src, err); img.classList.add('is-broken'); })
      .finally(() => img.classList.remove('is-loading'));
  }

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

  function openMediaLibrary({ current = '', onPick }) {
    mediaState.onPick = onPick;
    mediaState.current = current;
    $('#media-dialog').showModal();
    loadMediaLibrary();
  }

  async function loadMediaLibrary() {
    const list = $('#media-grid');
    const status = $('#media-status');
    list.innerHTML = '';
    status.hidden = false;
    status.innerHTML = '<span class="spinner" aria-hidden="true"></span> Finding your photos…';
    try {
      const images = await service.fetchImageLibrary(readRef());
      images.forEach((im) => list.appendChild(mediaThumb(im)));
      status.hidden = images.length > 0;
      if (!images.length) status.textContent = 'No photos yet. Add your first one above!';
    } catch (err) {
      console.error('Pebble: photo library failed', err);
      status.innerHTML = 'Sorry, your photos could not be loaded. <button type="button" class="link-btn link-btn--inline" id="media-retry">Try again</button>';
      $('#media-retry').addEventListener('click', loadMediaLibrary);
    }
  }

  function mediaThumb({ path, name }) {
    const btn = el('button', 'media-thumb' + (path === mediaState.current ? ' is-current' : ''));
    btn.type = 'button';
    btn.dataset.path = path;
    btn.title = 'Use this photo';
    const img = el('img');
    img.alt = '';
    showImage(img, path);
    btn.append(img, el('span', 'media-thumb__label', path === mediaState.current ? '✓ In use here' : name.replace(/^\d{8}-\d{6}-/, '').replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ')));
    return btn;
  }

  function pickFromLibrary(path) {
    $('#media-dialog').close();
    const cb = mediaState.onPick;
    mediaState.onPick = null;
    if (cb) cb(path);
  }

  async function uploadFromLibrary(file) {
    if (!file) return;
    const list = $('#media-grid');
    const tile = el('div', 'media-thumb media-thumb--uploading');
    tile.innerHTML = '<span class="spinner" aria-hidden="true"></span><span class="media-thumb__label">Adding your photo…</span>';
    list.prepend(tile);
    $('#media-status').hidden = true;
    try {
      const path = await uploadPhoto(file);
      tile.remove();
      pickFromLibrary(path);
      showToast('Photo added. ✓');
    } catch (err) {
      tile.remove();
      if (!list.children.length) loadMediaLibrary();
      reportPhotoError(err);
    }
  }

  function wireMediaLibrary() {
    const input = $('#file-image');
    const drop = $('#media-upload');
    $('#media-upload-btn').addEventListener('click', () => { input.value = ''; input.click(); });
    input.addEventListener('change', () => uploadFromLibrary(input.files[0]));
    $('#media-grid').addEventListener('click', (e) => {
      const t = e.target.closest('.media-thumb[data-path]');
      if (t) pickFromLibrary(t.dataset.path);
    });
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('is-dragover'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('is-dragover'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('is-dragover'); uploadFromLibrary(e.dataTransfer && e.dataTransfer.files[0]); });
    $('#media-dialog').addEventListener('close', () => { mediaState.onPick = null; });
  }

  /* ========================================================================
     14. PREVIEW — the real stitched page in a sandboxed frame (no scripts)
     ======================================================================== */

  function wirePreview() {
    const dialog = $('#preview-dialog');
    const frame = $('#preview-frame');
    let previewFile = null;

    const show = (file) => {
      const files = buildFiles();
      if (!files[file]) file = 'index.html';
      previewFile = file;
      const doc = store.docs[file];
      const css = F.globalCss(store.config.theme, store.baseCss, store.config.typography) + '\n' + (store.customCss || '');
      const config = JSON.parse(files['site-config.json']);
      frame.srcdoc = F.stitchPage({ file, kind: doc.kind, blocks: doc.blocks },
        { config, header: store.docs['header.html'].blocks, footer: store.docs['footer.html'].blocks }, { inlineCss: css });
    };

    frame.addEventListener('load', () => {
      const doc = frame.contentDocument;
      if (!doc || !previewFile) return;
      const base = `https://site.invalid/${previewFile}`;
      const toPath = (href) => new URL(href, base).pathname.slice(1);
      doc.querySelectorAll('img[src]').forEach((img) => {
        const src = img.getAttribute('src');
        if (isRepoPath(src)) resolveImageUrl(toPath(src)).then((u) => { img.src = u; }).catch(() => {});
      });
      doc.addEventListener('click', (e) => {
        const a = e.target.closest('a[href]');
        if (!a) return;
        e.preventDefault();
        const href = a.getAttribute('href');
        if (/^https?:/i.test(href)) { window.open(href, '_blank', 'noopener'); return; }
        const path = toPath(href);
        if (store.docs[path] && (store.docs[path].kind === 'page' || store.docs[path].kind === 'post')) show(path);
      });
    });

    $('#btn-preview').addEventListener('click', () => {
      flushSave();
      const kind = currentKind();
      show(kind === 'page' || kind === 'post' ? store.current : 'index.html');
      dialog.showModal();
    });
    dialog.querySelectorAll('[data-device]').forEach((btn) => {
      btn.addEventListener('click', () => {
        dialog.querySelectorAll('[data-device]').forEach((b) => b.classList.toggle('is-active', b === btn));
        frame.classList.toggle('is-phone', btn.dataset.device === 'phone');
      });
    });
  }

  /* ========================================================================
     15. UI WIRING
     ======================================================================== */

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
    $('#loading .spinner').hidden = false;
    $('#loading-back').hidden = true;
    $('#loading').hidden = false;
  }
  function hideLoading() { $('#loading').hidden = true; }
  function showBlocked(message) {
    showLoading(message);
    $('#loading .spinner').hidden = true;
    const back = $('#loading-back');
    back.href = dashboardUrl();
    back.hidden = false;
  }

  /* ---------------- new page / new post dialog ---------------- */

  function openNewDocDialog(mode) {
    const dialog = $('#newpage-dialog');
    const input = $('#newpage-name');
    dialog.dataset.mode = mode;
    $('#newpage-heading').textContent = mode === 'post' ? 'Write a new blog post' : 'Add a new page';
    $('#newpage-label').textContent = mode === 'post' ? 'What is your post called?' : 'What should the page be called?';
    input.placeholder = mode === 'post' ? 'For example: My first tomatoes' : 'For example: My recipes';
    $('#newpage-create').textContent = mode === 'post' ? 'Start writing' : 'Create page';
    $('#newpage-where').hidden = mode === 'post';
    $('#newpage-in-menu').checked = true;
    input.value = '';
    $('#newpage-file').textContent = '…';
    dialog.showModal();
    input.focus();
  }

  function wireNewDocDialog() {
    const dialog = $('#newpage-dialog');
    const input = $('#newpage-name');
    input.addEventListener('input', () => {
      const post = dialog.dataset.mode === 'post';
      $('#newpage-file').textContent = input.value.trim() ? uniqueFile(F.slugify(input.value, post ? 'post' : 'page'), post ? 'blog/' : '') : '…';
    });
    dialog.querySelector('form').addEventListener('submit', (e) => {
      e.preventDefault();
      const create = e.submitter && e.submitter.value === 'create';
      dialog.close();
      if (!create) return;
      if (dialog.dataset.mode === 'post') createPost(input.value);
      else createPage(input.value, $('#newpage-in-menu').checked);
    });
  }

  function wireAdvanced() {
    $('#btn-download').addEventListener('click', () => {
      const files = buildFiles();
      const kind = currentKind();
      const file = kind === 'page' || kind === 'post' ? store.current : `${kind}.html`;
      const blob = new Blob([files[file]], { type: 'text/html' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = file.split('/').pop();
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
    $('#btn-reset-demo').hidden = !service.isDemo;
    $('#btn-reset-demo').addEventListener('click', () => {
      if (!window.confirm('Reset the demo? This throws away everything you changed in this demo.')) return;
      service.resetDemo();
      try { localStorage.removeItem(draftKey()); localStorage.removeItem(lastDocKey()); } catch { /* ignore */ }
      location.reload();
    });
  }

  function wireUi() {
    wireToolbar();
    wireDrawer();
    wireSidebar();
    wireSettings();
    wirePreview();
    wireMediaLibrary();
    wireNewDocDialog();
    wireAdvanced();

    $('#btn-save').addEventListener('click', saveDraft);
    $('#btn-publish').addEventListener('click', publishLive);
    document.querySelectorAll('dialog').forEach((d) => {
      d.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => d.close()));
    });

    $('#page-title').addEventListener('input', (e) => {
      const meta = docMeta(store.current);
      if (!meta) return;
      meta.title = e.target.value.trim() || F.nameFromFile(store.current);
      refreshLiveBlocks();
      renderRegionPreviews();
      markDirty();
    });
    $('#page-title').addEventListener('change', renderSidebar);

    // Selecting a box: click anywhere on it. Clicking the empty page: nothing selected.
    canvasEl().addEventListener('mousedown', (e) => {
      const item = e.target.closest('.grid-stack-item');
      if (item) selectBlock(item);
    }, true);
    canvasEl().addEventListener('focusin', (e) => {
      const item = e.target.closest('.grid-stack-item');
      if (item) selectBlock(item);
    });
    $('#paper').addEventListener('mousedown', (e) => {
      if (!e.target.closest('.grid-stack-item') && !e.target.closest('.region-preview')) selectBlock(null);
    });
    canvasEl().addEventListener('click', (e) => {
      const del = e.target.closest('.block-delete');
      if (del) removeBlock(del.closest('.grid-stack-item'));
    });
    canvasEl().addEventListener('input', markDirty);

    $('#preview-header').addEventListener('click', () => openDoc('header.html'));
    $('#preview-footer').addEventListener('click', () => openDoc('footer.html'));

    grid.on('change added removed', () => { markDirty(); refreshEmptyState(); });
    const paper = $('#paper');
    grid.on('dragstart resizestart', () => { paper.classList.add('is-arranging'); hideToolbar(); });
    grid.on('dragstop resizestop', () => paper.classList.remove('is-arranging'));

    window.addEventListener('beforeunload', () => { if (saveTimer) flushSave(); });
  }

  /* ========================================================================
     16. BOOT
     ======================================================================== */

  function createService() {
    const site = new URLSearchParams(location.search).get('site') || '';
    if (site === 'demo') return new MockGitHubService(CONFIG.demoRepo);
    const m = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/.exec(site);
    if (!m || !PebbleAuth.getSession()) return null;
    return new GitHubService({
      owner: m[1],
      repo: m[2],
      token: () => PebbleAuth.getToken(),
      onUnauthorized: () => PebbleAuth.handleExpired(),
    });
  }

  const isSiteFile = (path) => F.PAGE_FILE_RE.test(path) || F.POST_FILE_RE.test(path) ||
    ['site-config.json', 'global.css', 'theme.css'].includes(path);

  async function loadRemoteFiles(ref) {
    const [root, blog] = await Promise.all([service.listDirectory('', ref), service.listDirectory('blog', ref)]);
    const paths = [...root, ...blog].filter((i) => i.type === 'file' && isSiteFile(i.path)).map((i) => i.path);
    const files = await Promise.all(paths.map((p) => service.fetchFile(p, ref)));
    store.remote = new Map(files.map((f) => [f.path, { content: f.content, sha: f.sha }]));
  }

  async function boot() {
    grid = GridStack.init({
      column: F.COLUMNS,
      cellHeight: CONFIG.cellHeight,
      margin: F.DEFAULT_THEME.blockSpacing / 2,
      float: true,
      minRow: CONFIG.minRows.page,
      handle: '.block-handle',
      acceptWidgets: '.add-tile',
      resizable: { handles: 'se' },
      animate: true,
      columnOpts: { breakpoints: [] },
    }, canvasEl());

    service = createService();
    if (!service) { location.replace(PebbleAuth.appRoot); return; }
    wireUi();
    $('#btn-back').href = dashboardUrl();
    showLoading('Opening your website…');

    try {
      $('#repo-name').textContent = service.fullName + (service.isDemo ? ' (practice)' : '');
      store.baseCss = await fetch(CONFIG.baseCssUrl, { cache: 'no-cache' }).then((r) => r.text());

      const publishing = await service.getPublishingInfo().catch((err) => { if (err.status === 401) throw err; return null; });
      if (publishing && publishing.path && publishing.path !== '/') {
        showBlocked('This website is set up in a way Pebble can’t edit yet.');
        return;
      }
      if (publishing && publishing.branch) service.liveBranch = publishing.branch;
      else service.liveBranch = (await service.getRepoInfo()).defaultBranch || service.liveBranch;
      if (publishing && publishing.url) service.publishedUrl = publishing.url;
      if (service.draftBranch === service.liveBranch) service.draftBranch = 'pebble-draft';

      store.hasDraftBranch = await service.hasDraft();
      const [diff] = await Promise.all([service.compareDraftToLive(), loadRemoteFiles(readRef())]);
      store.draftAhead = diff.ahead;
      if (store.hasDraftBranch) {
        const [liveRoot, liveBlog] = await Promise.all([service.listDirectory('', service.liveBranch), service.listDirectory('blog', service.liveBranch)]);
        store.livePaths = new Set([...liveRoot, ...liveBlog].map((i) => i.path));
      } else {
        store.livePaths = new Set(store.remote.keys());
      }

      const home = store.remote.get('index.html');
      if (home && !F.isPebblePage(home.content)) {
        showBlocked('This website wasn’t made with Pebble, so Pebble won’t change it.');
        return;
      }

      const site = buildSiteFromRemote();
      const local = loadLocal();
      const hadLocal = !!(local && local.config && local.docs);
      if (hadLocal) {
        site.config = F.normalizeConfig(local.config);
        site.docs = local.docs;
        site.customCss = local.customCss || '';
      }
      store.config = site.config;
      store.docs = site.docs;
      store.customCss = site.customCss;
      for (const f of ['header.html', 'footer.html']) {
        if (!store.docs[f]) store.docs[f] = { kind: f.slice(0, -5), blocks: f === 'header.html' ? F.defaultHeaderBlocks() : F.defaultFooterBlocks(store.config.siteName) };
      }

      applyTheme();
      let start = null;
      try { start = localStorage.getItem(lastDocKey()); } catch { /* ignore */ }
      if (!store.docs[start]) start = 'index.html';
      hideLoading();
      openDoc(start);
      flushSave();
      if (store.upgraded) {
        showToast('Pebble has new features! Your website was updated to use them — press “Publish live” once to put it online.');
      } else if (!hadLocal && lastPending.length && lastPending.every((p) => ['global.css', 'site-config.json'].includes(p.path))) {
        // Only Pebble's own files differ: this website was made by an earlier Pebble.
        showToast('Pebble has new design options (text styles, fonts). Press “Publish live” once to update your website.');
      }
    } catch (err) {
      console.error('Pebble: could not open the website', err);
      if (err && err.status === 401) return;
      showBlocked(err && (err.status === 403 || err.status === 404)
        ? 'Pebble can’t open this website with your hosting account. Please pick one from your list.'
        : "Sorry, we couldn't open your website. Please check your internet connection and try again.");
    }
  }

  function buildSiteFromRemote() {
    const cfgFile = store.remote.get('site-config.json');
    if (cfgFile) {
      let raw = {};
      try { raw = JSON.parse(cfgFile.content); } catch { /* broken file → defaults */ }
      const config = F.normalizeConfig(raw);
      const docs = {};
      const header = store.remote.get('header.html');
      const footer = store.remote.get('footer.html');
      docs['header.html'] = { kind: 'header', blocks: header ? F.partialFromHtml(header.content, 'header') : F.defaultHeaderBlocks() };
      docs['footer.html'] = { kind: 'footer', blocks: footer ? F.partialFromHtml(footer.content, 'footer') : F.defaultFooterBlocks(config.siteName) };
      for (const p of config.pages) {
        const f = store.remote.get(p.file);
        docs[p.file] = { kind: 'page', blocks: f && F.isPebblePage(f.content) ? F.parsePage(f.content, p.file).blocks : [] };
      }
      for (const p of config.posts) {
        const f = store.remote.get(p.file);
        docs[p.file] = { kind: 'post', blocks: f && F.isPebblePage(f.content) ? F.parsePage(f.content, p.file).blocks : [] };
      }
      const theme = store.remote.get('theme.css');
      return { config, docs, customCss: config.customCss && theme ? theme.content : '' };
    }
    const pages = {};
    for (const [path, f] of store.remote) {
      if (F.PAGE_FILE_RE.test(path) && !['header.html', 'footer.html'].includes(path) && F.isPebblePage(f.content)) pages[path] = f.content;
    }
    if (!Object.keys(pages).length) return F.starterSite(service.repo.replace(/[-_.]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()));
    store.upgraded = true;
    return F.upgradeLegacySite(pages);
  }

  window.Pebble = {
    get store() { return store; },
    get service() { return service; },
    get selected() { return selected; },
    buildFiles,
    pendingChanges,
    openDoc,
    createPage,
    createPost,
    movePage,
    selectBlock,
    saveDraft,
    publishLive,
    readCanvas,
    serializeToStaticHTML() { const files = buildFiles(); return files[store.current] || files[`${currentKind()}.html`]; },
    deserializeToEditor(html) {
      const blocks = F.parsePage(html, store.current).blocks;
      loadCanvas(blocks, currentKind());
      flushSave();
      return blocks;
    },
    EDITORS,
    CONFIG,
  };

  boot();
})();
