/* ==========================================================================
   Pebble — editor engine
   --------------------------------------------------------------------------
   The user's website lives in THEIR GitHub repository as plain files (see
   lib/site-format.js for the exact format). This editor:

     1. reads every file of the website (GitHubService),
     2. turns them into plain data — the "site":
          config (site-config.json), docs (pages, blog posts, header,
          footer: lists of blocks), customCss (theme.css)
     3. lets her edit one doc at a time on a Gridstack canvas,
     4. on Save draft / Publish live, re-renders ALL files from the data
        (PebbleFormat.buildSiteFiles — the stitching engine) and commits the
        ones whose text changed: to the draft branch (dev), then merges
        into live (main) for GitHub Pages.

   Sections:
      1. Setup & small helpers
      2. Block editors (the editing UI of each block type)
      3. Canvas: Gridstack + blocks
      4. Site store: remote files, local changes, what needs saving
      5. Docs: open / create pages & posts, page & post settings
      6. Header/footer previews around the page
      7. Site Settings (design) — live
      8. Add drawer & block settings
      9. Save draft & Publish live
     10. Photos: upload + library
     11. Preview
     12. UI wiring
     13. Boot
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

  /** Paste as plain text (no hidden Word/website formatting). */
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

  let service = null;   // GitHubService / MockGitHubService
  let grid = null;      // GridStack instance
  let isLoading = false;

  /** Website name & where to go back to. */
  const dashboardUrl = () => PebbleAuth.appRoot + (service && service.isDemo ? '?demo=1' : '');

  /* ========================================================================
     2. BLOCK EDITORS
     Each block type: how it looks and is edited on the canvas.
       create(data) → element (element._data holds the data, element._render() redraws)
       read(element) → data
       settings     → fields for the ⚙ Settings dialog (optional)
     The published look comes from PebbleFormat.BLOCKS; most editors reuse the
     same CSS classes, so the canvas looks like the website.
     ======================================================================== */

  /** Context for drawing site-dependent blocks (menu, blog feed) in the editor. */
  const previewCtx = () => ({ config: liveConfig(), file: store.current, root: '' });

  /** Make relative images inside a drawn fragment loadable in the editor. */
  function resolveImagesIn(root) {
    root.querySelectorAll('img').forEach((img) => {
      const src = img.getAttribute('src');
      if (src && isRepoPath(src)) showImage(img, src);
    });
  }

  function photoPicker(wrap, onPick) {
    return () => openMediaLibrary({ current: wrap._data.src, onPick });
  }

  const EDITORS = {
    text: {
      label: 'Text', icon: '✍️', hint: 'Stories, titles, lists', size: { w: 6, h: 3 }, min: { w: 2, h: 1 },
      create(data) {
        const node = el('div', 'rich-text text-editor');
        node.contentEditable = 'true';
        node.spellcheck = true;
        node.dataset.placeholder = 'Click here and start typing…';
        node.innerHTML = F.sanitizeRichText(data.html);
        const refresh = () => node.classList.toggle('is-empty', isBlankText(node));
        refresh();
        node.addEventListener('input', refresh);
        node.addEventListener('paste', plainPaste);
        return node;
      },
      read: (node) => ({ html: isBlankText(node) ? '' : F.sanitizeRichText(node.innerHTML) }),
    },

    image: {
      label: 'Photo', icon: '🖼️', hint: 'A picture', size: { w: 6, h: 5 }, min: { w: 2, h: 2 },
      create(data) {
        const wrap = el('div', 'block-image image-editor');
        wrap._data = { src: F.safeUrl(data.src, 'image'), caption: data.caption || '' };
        const use = (path) => { wrap._data.src = path; wrap._render(); markDirty(); };
        wrap._render = () => {
          wrap.innerHTML = '';
          if (wrap._data.src) {
            const media = el('div', 'block-image__media');
            const img = el('img');
            img.alt = wrap._data.caption || 'Photo';
            img.draggable = false;
            showImage(img, wrap._data.src);
            const change = el('button', 'image-change', '🔄 Change photo');
            change.type = 'button';
            change.addEventListener('click', photoPicker(wrap, use));
            media.append(img, change);
            const caption = el('input', 'image-caption');
            caption.type = 'text';
            caption.placeholder = 'Write a caption (optional)';
            caption.maxLength = 200;
            caption.value = wrap._data.caption;
            caption.addEventListener('input', () => { wrap._data.caption = caption.value; img.alt = caption.value || 'Photo'; });
            wrap.append(media, caption);
          } else {
            wrap.appendChild(emptyPhotoButton(photoPicker(wrap, use)));
          }
        };
        enablePhotoDrop(wrap, use);
        wrap._render();
        return wrap;
      },
      read: (wrap) => ({ src: wrap._data.src, caption: wrap._data.caption.trim() }),
    },

    card: {
      label: 'Card', icon: '🗂️', hint: 'Photo, title and text', size: { w: 4, h: 6 }, min: { w: 2, h: 3 },
      create(data) {
        const wrap = el('div', 'block-card card-editor');
        wrap._data = { ...F.BLOCKS.card.defaults(), ...data };
        const use = (path) => { syncCard(wrap); wrap._data.src = path; wrap._render(); markDirty(); };
        wrap._render = () => {
          wrap.innerHTML = '';
          const media = el('div', 'block-card__media');
          if (wrap._data.src) {
            const img = el('img');
            img.alt = '';
            showImage(img, wrap._data.src);
            const change = el('button', 'image-change', '🔄 Change photo');
            change.type = 'button';
            change.addEventListener('click', photoPicker(wrap, use));
            const remove = el('button', 'image-change image-change--right', '✕ Remove');
            remove.type = 'button';
            remove.addEventListener('click', () => use(''));
            media.append(img, change, remove);
          } else {
            media.classList.add('card-editor__nomedia');
            const add = el('button', 'card-editor__addphoto', '📷 Add a photo');
            add.type = 'button';
            add.addEventListener('click', photoPicker(wrap, use));
            media.appendChild(add);
          }
          const body = el('div', 'block-card__body');
          const title = el('h3', 'block-card__title', wrap._data.title);
          makePlainEditable(title, 'Card title');
          const text = el('div', 'block-card__text rich-text text-editor');
          text.contentEditable = 'true';
          text.dataset.placeholder = 'A few words…';
          text.innerHTML = F.sanitizeRichText(wrap._data.html);
          const refresh = () => text.classList.toggle('is-empty', isBlankText(text));
          refresh();
          text.addEventListener('input', refresh);
          text.addEventListener('paste', plainPaste);
          body.append(title, text);
          if (wrap._data.href) body.appendChild(el('span', 'block-card__link', wrap._data.linkLabel || 'Read more'));
          wrap.append(media, body);
        };
        enablePhotoDrop(wrap, use);
        wrap._render();
        return wrap;
      },
      read: (wrap) => syncCard(wrap),
      settings: [
        { key: 'href', label: 'The card’s link goes to', type: 'link', allowNone: 'No link' },
        { key: 'linkLabel', label: 'Link text', type: 'text', placeholder: 'Read more' },
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
          makePlainEditable(label, 'Button text', (v) => { wrap._data.label = v; });
          wrap.appendChild(label);
          if (!d.href) wrap.appendChild(el('span', 'button-editor__hint', '⚙ Choose where it goes'));
        };
        wrap._render();
        return wrap;
      },
      read: (wrap) => ({ ...wrap._data, label: (wrap.querySelector('.block-button__link') || {}).textContent?.trim() || wrap._data.label }),
      settings: [
        { key: 'label', label: 'Button text', type: 'text' },
        { key: 'href', label: 'Goes to', type: 'link' },
        { key: 'style', label: 'Look', type: 'select', options: [['primary', 'Filled with your main color'], ['secondary', 'Outline only']] },
        { key: 'align', label: 'Position', type: 'select', options: [['left', 'Left'], ['center', 'Middle'], ['right', 'Right']] },
      ],
    },

    'blog-feed': {
      label: 'Blog posts', icon: '📰', hint: 'Your latest posts', size: { w: 12, h: 6 }, min: { w: 4, h: 3 },
      create(data) {
        const wrap = el('div', 'block-blog-feed feed-editor');
        wrap._data = { ...F.BLOCKS['blog-feed'].defaults(), ...data };
        wrap._render = () => {
          if (!liveConfig().posts.length) {
            wrap.innerHTML = '<div class="feed-editor__empty"><span aria-hidden="true">📰</span><strong>Your blog posts will appear here</strong><small>Write one with “＋ Write a blog post” on the left.</small></div>';
            return;
          }
          wrap.innerHTML = F.BLOCKS['blog-feed'].render(wrap._data, previewCtx()).inner;
          resolveImagesIn(wrap);
        };
        wrap._render();
        return wrap;
      },
      read: (wrap) => ({ ...wrap._data }),
      settings: [
        { key: 'limit', label: 'How many posts to show', type: 'select', options: [['3', 'The newest 3'], ['6', 'The newest 6'], ['12', 'The newest 12'], ['0', 'All of them']] },
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
            el('span', 'embed-editor__note', 'It runs on your published website, not here. Use ⚙ Settings to change it.'),
          );
          if (wrap._data.code) wrap.appendChild(el('code', 'embed-editor__code', wrap._data.code.slice(0, 160)));
          // Never put the code into the editor's own page: it could read her login.
        };
        wrap._render();
        return wrap;
      },
      read: (wrap) => ({ ...wrap._data }),
      settings: [
        {
          key: 'code', label: 'Code to add to the page', type: 'code',
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
        input.addEventListener('input', () => {
          store.config.siteName = input.value.trim() || 'My website';
          markDirty();
        });
        wrap.appendChild(input);
        wrap._data = {};
        wrap._render = () => { if (document.activeElement !== input) input.value = store.config.siteName; };
        return wrap;
      },
      read: () => ({}),
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
      settings: [
        { key: 'align', label: 'Position', type: 'select', options: [['left', 'Left'], ['center', 'Middle'], ['right', 'Right']] },
        { type: 'note', text: 'Which pages appear here: open a page and tick or untick “Show link in website menu”.' },
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

  /** Drop a photo file from the desktop onto a block → upload + use it. */
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

  /** Which blocks may be added to the current doc. */
  function allowedHere(type) {
    const kind = currentKind();
    if (EDITORS[type].regionOnly) return kind === 'header' || kind === 'footer';
    if (type === 'blog-feed') return kind === 'page' || kind === 'post';
    return true;
  }

  /* ========================================================================
     3. CANVAS
     ======================================================================== */

  /**
   *   <div class="grid-stack-item" gs-x gs-y gs-w gs-h data-widget-type>
   *     <div class="grid-stack-item-content block-shell">
   *       <div class="block-bar"> ✥ Move | ⚙ Settings | 🗑 Remove </div>
   *       <div class="block-body"> …block editor… </div>
   */
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
      (ed.settings ? '<button type="button" class="block-settings" title="Change this box’s settings">⚙ Settings</button>' : '') +
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

  /** Redraw blocks that show site-wide things (menu, blog feed, website name). */
  function refreshLiveBlocks() {
    grid.getGridItems().forEach((it) => {
      if (['menu', 'blog-feed', 'site-title'].includes(it.dataset.widgetType)) editorOf(it)._render();
    });
  }

  /* ========================================================================
     4. SITE STORE
     ------------------------------------------------------------------------
     remote:  path → { content, sha }   files as they are in the repository
              (the draft branch once it exists, otherwise live)
     livePaths: files that exist on the live site ("New" badges)
     config / docs / customCss: the site being edited (see site-format.js)
     Local changes are kept in localStorage (as data) until saved.
     ======================================================================== */

  const store = {
    remote: new Map(),
    livePaths: new Set(),
    config: F.defaultConfig(),
    docs: {},              // file → { kind, blocks }
    customCss: '',
    baseCss: '',
    current: null,         // file being edited
    hasDraftBranch: false,
    draftAhead: false,
    upgraded: false,       // an older Pebble website, upgraded in memory
  };

  const readRef = () => (store.hasDraftBranch ? service.draftBranch : service.liveBranch);
  const currentKind = () => (store.docs[store.current] || { kind: 'page' }).kind;
  const pageMeta = (file) => store.config.pages.find((p) => p.file === file);
  const postMeta = (file) => store.config.posts.find((p) => p.file === file);
  const docMeta = (file) => pageMeta(file) || postMeta(file);

  /** The config, with the doc on the canvas up to date. */
  function liveConfig() { return store.config; }

  /** Copy the canvas into the store. */
  function flushCanvas() {
    if (isLoading || !store.current || !store.docs[store.current]) return;
    store.docs[store.current].blocks = readCanvas();
  }

  function siteState() {
    flushCanvas();
    return { config: store.config, docs: store.docs, customCss: store.customCss };
  }

  /** Every file as it should be, from the data. */
  function buildFiles() {
    return F.buildSiteFiles(siteState(), { baseCss: store.baseCss });
  }

  /** Files whose text differs from the repository. */
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
      if (pending.length) {
        localStorage.setItem(draftKey(), JSON.stringify({ config: store.config, docs: store.docs, customCss: store.customCss }));
      } else {
        localStorage.removeItem(draftKey());
      }
      return true;
    } catch (err) {
      console.warn('Pebble: local copy not saved', err);
      return false;
    }
  }

  function loadLocal() {
    try { return JSON.parse(localStorage.getItem(draftKey()) || 'null'); } catch { return null; }
  }

  /* ---------------- autosave & status ---------------- */

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
     5. DOCS: open, create, settings
     ======================================================================== */

  let isSwitching = false;

  /** Show a doc (page, post, header, footer) on the canvas. */
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
    renderDocChrome();
    renderSidebar();
    $('.canvas-area').scrollTop = 0;
  }

  /** Everything around the canvas that depends on which doc is open. */
  function renderDocChrome() {
    const kind = currentKind();
    const file = store.current;
    const meta = docMeta(file);
    const title = $('#page-title');
    const label = $('#page-title-label');
    if (kind === 'header' || kind === 'footer') {
      title.value = kind === 'header' ? 'Top of every page' : 'Bottom of every page';
      title.disabled = true;
      label.textContent = 'Editing';
    } else {
      title.value = meta ? meta.title : F.nameFromFile(file);
      title.disabled = false;
      label.textContent = kind === 'post' ? 'Post title' : 'Page name';
    }

    $('#page-panel').hidden = kind !== 'page';
    $('#post-panel').hidden = kind !== 'post';
    $('#region-panel').hidden = !(kind === 'header' || kind === 'footer');
    $('#paper').dataset.kind = kind;

    if (kind === 'page') {
      $('#page-in-menu').checked = !!(meta && meta.showInNavbar);
      $('#page-address').textContent = file;
    }
    if (kind === 'post') {
      $('#post-date').value = meta.date;
      $('#post-excerpt').value = meta.excerptAuto ? '' : meta.excerpt;
      $('#post-excerpt').placeholder = 'Leave empty and Pebble uses the first words of your post';
      renderCoverPicker();
    }
    if (kind === 'header' || kind === 'footer') {
      $('#region-panel-text').textContent = kind === 'header'
        ? 'This is the top of every page. What you put here appears on all your pages and blog posts.'
        : 'This is the bottom of every page. What you put here appears on all your pages and blog posts.';
    }

    // Only offer blocks that fit here.
    document.querySelectorAll('#add-drawer .add-tile').forEach((t) => { t.hidden = !allowedHere(t.dataset.widgetType); });
    document.querySelectorAll('#add-drawer .add-group').forEach((g) => { g.hidden = !g.querySelector('.add-tile:not([hidden])'); });
    renderRegionPreviews();
  }

  function renderCoverPicker() {
    const meta = postMeta(store.current);
    const box = $('#post-cover-preview');
    box.innerHTML = '';
    if (meta && meta.thumbnail) {
      const img = el('img');
      img.alt = '';
      showImage(img, meta.thumbnail);
      box.appendChild(img);
    }
    $('#post-cover-remove').hidden = !(meta && meta.thumbnail);
    $('#post-cover').textContent = meta && meta.thumbnail ? 'Change photo' : 'Choose a photo';
  }

  /* ---------------- creating pages & posts ---------------- */

  function uniqueFile(base, folder = '') {
    let file = `${folder}${base}.html`;
    const taken = (f) => store.docs[f] || store.remote.has(f) || ['header.html', 'footer.html', 'index.html'].includes(f);
    for (let i = 2; taken(file); i++) file = `${folder}${base}-${i}.html`;
    return file;
  }

  function createPage(name) {
    name = name.trim();
    if (!name) return;
    const file = uniqueFile(F.slugify(name, 'page'));
    store.config.pages.push({ file, title: name.slice(0, 80), showInNavbar: true });
    store.docs[file] = { kind: 'page', blocks: [] };
    openDoc(file);
    markDirty();
    showToast(`Your new page “${name}” is ready. Add boxes with “＋ Add”.`);
  }

  function createPost(title) {
    title = title.trim();
    if (!title) return;
    const file = uniqueFile(F.slugify(title, 'post'), 'blog/');
    store.config.posts.push({ file, title: title.slice(0, 140), date: F.todayIso(), thumbnail: '', excerpt: '', excerptAuto: true });
    store.docs[file] = { kind: 'post', blocks: [{ type: 'text', x: 0, y: 0, w: 12, h: 4, data: { html: '' } }] };

    // The first post: make sure there's a page that lists the posts.
    const hasFeed = Object.values(store.docs).some((d) => d.blocks.some((b) => b.type === 'blog-feed'));
    let madeBlogPage = false;
    if (!hasFeed) {
      const blogFile = uniqueFile('blog');
      store.config.pages.push({ file: blogFile, title: 'Blog', showInNavbar: true });
      store.docs[blogFile] = {
        kind: 'page',
        blocks: [
          { type: 'text', x: 0, y: 0, w: 12, h: 2, data: { html: '<h2>Blog</h2><p>My latest stories.</p>' } },
          { type: 'blog-feed', x: 0, y: 2, w: 12, h: 6, data: { limit: 0 } },
        ],
      };
      madeBlogPage = true;
    }
    openDoc(file);
    markDirty();
    showToast(madeBlogPage
      ? 'Your new post is ready! Pebble also made a “Blog” page that lists all your posts.'
      : 'Your new post is ready. Write away!');
  }

  /* ========================================================================
     6. HEADER / FOOTER PREVIEWS AROUND THE PAGE
     ======================================================================== */

  function renderRegionPreviews() {
    const kind = currentKind();
    const showRegions = kind === 'page' || kind === 'post';
    const top = $('#preview-header');
    const bottom = $('#preview-footer');
    const postHead = $('#preview-post-header');
    top.hidden = bottom.hidden = !showRegions;
    postHead.hidden = kind !== 'post';
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

  /* ========================================================================
     7. SITE SETTINGS (design) — applied live
     ======================================================================== */

  /** Put the site's design into the editor: global.css + theme.css. */
  function applyTheme() {
    $('#site-theme').textContent = F.globalCss(store.config.theme, store.baseCss);
    $('#site-custom').textContent = store.customCss || '';
    const spacing = F.normalizeTheme(store.config.theme).blockSpacing;
    if (grid && grid.getMargin() !== spacing / 2) grid.margin(spacing / 2);
  }

  const COLOR_SWATCHES = {
    primary: ['#b85c38', '#2f6fdf', '#1f8a4c', '#8e44ad', '#c0392b', '#1d3557', '#d4a017', '#2d2a26'],
    secondary: ['#6b8b4f', '#e9a03b', '#3aa8a0', '#d76a85', '#7a8ca3', '#a0522d', '#5c6bc0', '#b5838d'],
  };

  function renderSettings() {
    const t = F.normalizeTheme(store.config.theme);
    $('#set-site-name').value = store.config.siteName;
    for (const which of ['primary', 'secondary']) {
      const value = t[`${which}Color`];
      $(`#set-${which}`).value = value;
      document.querySelectorAll(`[data-swatch="${which}"]`).forEach((b) => b.classList.toggle('is-on', b.dataset.color === value));
    }
    $('#set-font').value = t.fontFamily;
    $('#set-radius').value = t.borderRadius;
    $('#set-spacing').value = t.blockSpacing;
    $('#set-custom-css').value = store.customCss || '';
  }

  function updateTheme(patch) {
    store.config.theme = F.normalizeTheme({ ...store.config.theme, ...patch });
    applyTheme();
    markDirty();
  }

  function wireSettings() {
    const dialog = $('#settings-dialog');
    $('#btn-settings').addEventListener('click', () => { renderSettings(); dialog.showModal(); });

    // swatches
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

    const font = $('#set-font');
    for (const [key, f] of Object.entries(F.FONTS)) {
      const opt = el('option', '', f.label);
      opt.value = key;
      opt.style.fontFamily = f.stack;
      font.appendChild(opt);
    }
    font.addEventListener('change', () => updateTheme({ fontFamily: font.value }));
    $('#set-radius').addEventListener('input', (e) => updateTheme({ borderRadius: e.target.value }));
    $('#set-spacing').addEventListener('input', (e) => updateTheme({ blockSpacing: e.target.value }));

    $('#set-site-name').addEventListener('input', (e) => {
      store.config.siteName = e.target.value.trim() || 'My website';
      refreshLiveBlocks();
      renderRegionPreviews();
      markDirty();
    });

    // Advanced: extra CSS (theme.css)
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
  }

  /* ========================================================================
     8. ADD DRAWER & BLOCK SETTINGS
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

  function afterAdd(item, type) {
    markDirty();
    closeDrawer();
    if (type === 'embed') setTimeout(() => openBlockSettings(item), 150); // straight to the warning + code box
    if (type === 'button') setTimeout(() => openBlockSettings(item), 150);
  }

  function wireDrawer() {
    buildDrawer();
    $('#btn-add').addEventListener('click', () => ($('#add-drawer').hidden ? openDrawer() : closeDrawer()));
    $('#add-close').addEventListener('click', closeDrawer);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#add-drawer').hidden) closeDrawer(); });

    // Drag a tile onto the canvas: Gridstack drops a copy; swap it for a real block.
    GridStack.setupDragIn('#add-drawer .add-tile', { appendTo: 'body', helper: 'clone' });
    grid.on('dropped', (_e, _prev, node) => {
      if (!node || !node.el) return;
      const { el: dropped, x, y } = node;
      const type = dropped.dataset.widgetType;
      grid.removeWidget(dropped, true, false);
      const item = addBlock(type, null, { x, y }, { focus: true });
      if (item) afterAdd(item, type);
    });

    // …or click it.
    $('#add-groups').addEventListener('click', (e) => {
      const tile = e.target.closest('.add-tile');
      if (!tile) return;
      const item = addBlock(tile.dataset.widgetType, null, null, { focus: true });
      if (item) afterAdd(item, tile.dataset.widgetType);
    });
    $('#add-groups').addEventListener('keydown', (e) => {
      const tile = e.target.closest('.add-tile');
      if (tile && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); tile.click(); }
    });
  }

  /* ---------------- ⚙ block settings (one dialog for every block type) ---------------- */

  let settingsItem = null;

  function linkOptions(field) {
    const opts = [];
    if (field.allowNone) opts.push(['', field.allowNone]);
    else opts.push(['', '— Choose a page —']);
    for (const p of store.config.pages) opts.push([p.file, `📄 ${p.title}`]);
    for (const p of F.sortedPosts(store.config)) opts.push([p.file, `📰 ${p.title}`]);
    opts.push(['__external__', '🌐 Another website…']);
    return opts;
  }

  function openBlockSettings(item) {
    const type = item.dataset.widgetType;
    const ed = EDITORS[type];
    if (!ed.settings) return;
    settingsItem = item;
    const data = ed.read(editorOf(item));
    $('#block-settings-title').textContent = `${ed.label} settings`;
    const box = $('#block-settings-fields');
    box.innerHTML = '';

    for (const f of ed.settings) {
      if (f.type === 'note') { box.appendChild(el('p', 'settings-note', f.text)); continue; }
      const row = el('div', 'settings-field');
      const id = `bs-${f.key}`;
      const label = el('label', 'settings-field__label', f.label);
      label.htmlFor = id;
      row.appendChild(label);
      const value = data[f.key] == null ? '' : String(data[f.key]);

      if (f.type === 'text') {
        const input = el('input', 'settings-field__input');
        input.id = id; input.type = 'text'; input.value = value; input.dataset.key = f.key;
        if (f.placeholder) input.placeholder = f.placeholder;
        row.appendChild(input);
      } else if (f.type === 'select') {
        const sel = el('select', 'settings-field__input');
        sel.id = id; sel.dataset.key = f.key;
        for (const [v, t] of f.options) { const o = el('option', '', t); o.value = v; sel.appendChild(o); }
        sel.value = value;
        row.appendChild(sel);
      } else if (f.type === 'link') {
        const sel = el('select', 'settings-field__input');
        sel.id = id; sel.dataset.key = f.key; sel.dataset.link = '1';
        for (const [v, t] of linkOptions(f)) { const o = el('option', '', t); o.value = v; sel.appendChild(o); }
        const internal = !value || store.docs[value];
        sel.value = internal ? value : '__external__';
        const ext = el('input', 'settings-field__input settings-field__external');
        ext.type = 'url';
        ext.placeholder = 'https://www.example.com';
        ext.value = internal ? '' : value;
        ext.hidden = internal;
        sel.addEventListener('change', () => { ext.hidden = sel.value !== '__external__'; if (!ext.hidden) ext.focus(); });
        row.append(sel, ext);
      } else if (f.type === 'code') {
        if (f.warning) {
          const warn = el('div', 'settings-warning');
          warn.innerHTML = '<strong>⚠️ Careful</strong>';
          warn.appendChild(el('span', '', f.warning));
          row.insertBefore(warn, label);
        }
        const ta = el('textarea', 'settings-field__input settings-field__code');
        ta.id = id; ta.dataset.key = f.key; ta.value = value; ta.rows = 10; ta.spellcheck = false;
        ta.placeholder = '<iframe src="…"></iframe>';
        row.appendChild(ta);
      }
      box.appendChild(row);
    }
    $('#block-settings').showModal();
    const first = box.querySelector('input, select, textarea');
    if (first) first.focus();
  }

  function applyBlockSettings() {
    const item = settingsItem;
    settingsItem = null;
    if (!item || !item.isConnected) return;
    const ed = EDITORS[item.dataset.widgetType];
    const node = editorOf(item);
    const data = ed.read(node);
    document.querySelectorAll('#block-settings-fields [data-key]').forEach((input) => {
      let v = input.value;
      if (input.dataset.link) {
        if (v === '__external__') {
          v = input.parentElement.querySelector('.settings-field__external').value.trim();
          if (v && !/^(https?:|mailto:|tel:)/i.test(v)) v = 'https://' + v;
          v = F.safeUrl(v, 'link');
        }
      }
      data[input.dataset.key] = input.dataset.key === 'limit' ? parseInt(v, 10) : v;
    });
    node._data = { ...node._data, ...data };
    node._render();
    markDirty();
  }

  function wireBlockSettings() {
    $('#block-settings-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const save = e.submitter && e.submitter.value === 'save';
      $('#block-settings').close();
      if (save) applyBlockSettings(); else settingsItem = null;
    });
  }

  /* ========================================================================
     9. SAVE DRAFT & PUBLISH LIVE
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

  /** A friendly commit message for one file. */
  function commitMessage(path, isNew) {
    const meta = docMeta(path);
    if (meta) {
      const what = postMeta(path) ? 'blog post' : 'page';
      return `${isNew ? 'Add' : 'Update'} ${what} “${meta.title}”`;
    }
    return {
      'site-config.json': 'Update site settings',
      'global.css': 'Update site design',
      'theme.css': 'Update custom styles',
      'header.html': 'Update the top of every page',
      'footer.html': 'Update the bottom of every page',
    }[path] || `Update ${path}`;
  }

  /** Commit every changed file to the draft branch. */
  async function commitChangesToDraft() {
    flushCanvas();
    const changes = pendingChanges();
    for (const ch of changes) {
      const result = await service.commitFile(ch.path, ch.content, {
        message: commitMessage(ch.path, !ch.remote),
        sha: ch.remote ? ch.remote.sha : undefined,
      });
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

  /** After a forced publish, re-read the files' SHAs from the draft branch. */
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
    const paths = files.filter((f) => f.status !== 'removed').map((f) => f.path);
    for (const path of paths) {
      const meta = docMeta(path);
      if (meta) rows.push(`${postMeta(path) ? '📰' : '📄'} ${F.escapeHtml(meta.title)}${store.livePaths.has(path) && !files.find((f) => f.path === path && f.status === 'added') ? '' : ' <span class="tag">new</span>'}`);
    }
    if (paths.some((p) => p === 'header.html' || p === 'footer.html')) rows.push('⬆⬇ Top and bottom of your pages');
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
     10. PHOTOS — upload + library
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
     11. PREVIEW — the real stitched page, in a sandboxed frame
     (no scripts run in it, so custom code can't reach the editor)
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
      const css = F.globalCss(store.config.theme, store.baseCss) + '\n' + (store.customCss || '');
      const config = JSON.parse(files['site-config.json']); // with automatic summaries filled in
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
     12. UI WIRING
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

  /* ---------------- sidebar: the website's structure ---------------- */

  function renderSidebar() {
    const pendingPaths = new Set(lastPending.map((p) => p.path));
    const item = (file, icon, label, extra = '') => {
      const btn = el('button', 'page-item' + (file === store.current ? ' is-current' : ''));
      btn.type = 'button';
      btn.dataset.file = file;
      if (file === store.current) btn.setAttribute('aria-current', 'page');
      btn.appendChild(el('span', 'page-item__icon', icon));
      const name = el('span', 'page-item__name', label);
      btn.appendChild(name);
      if (extra) btn.insertAdjacentHTML('beforeend', extra);
      if (pendingPaths.has(file)) btn.insertAdjacentHTML('beforeend', '<span class="page-item__dot" title="Changes not saved yet"></span>');
      if (!store.livePaths.has(file)) btn.insertAdjacentHTML('beforeend', '<span class="page-item__badge" title="Not on your website yet">New</span>');
      const li = el('li');
      li.appendChild(btn);
      return li;
    };

    const pages = $('#page-list');
    pages.innerHTML = '';
    for (const p of store.config.pages) {
      pages.appendChild(item(p.file, p.file === 'index.html' ? '🏠' : '📄', p.title,
        p.showInNavbar ? '' : '<span class="page-item__hidden" title="Not shown in the website menu">hidden</span>'));
    }

    const posts = $('#post-list');
    posts.innerHTML = '';
    for (const p of F.sortedPosts(store.config)) {
      const li = item(p.file, '📰', p.title);
      li.querySelector('.page-item__name').insertAdjacentHTML('beforeend', `<small class="page-item__date">${F.escapeHtml(F.formatDate(p.date))}</small>`);
      posts.appendChild(li);
    }
    $('#posts-empty').hidden = store.config.posts.length > 0;

    const regions = $('#region-list');
    regions.innerHTML = '';
    regions.appendChild(item('header.html', '⬆️', 'Top of every page'));
    regions.appendChild(item('footer.html', '⬇️', 'Bottom of every page'));
  }

  /* ---------------- text style bar ---------------- */

  function activeTextEditor() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    const node = sel.anchorNode;
    const e = node && (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement);
    return e ? e.closest('.text-editor') : null;
  }

  const FORMAT_COMMANDS = {
    title: () => document.execCommand('formatBlock', false, 'h2'),
    subtitle: () => document.execCommand('formatBlock', false, 'h3'),
    normal: () => document.execCommand('formatBlock', false, 'p'),
    bold: () => document.execCommand('bold'),
    italic: () => document.execCommand('italic'),
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

  function updateFormatBar() {
    const bar = $('#formatbar');
    const editor = activeTextEditor();
    bar.classList.toggle('is-active', !!editor);
    let block = '';
    try { block = editor ? String(document.queryCommandValue('formatBlock')).toLowerCase() : ''; } catch { /* ignore */ }
    const states = { bold: 'bold', italic: 'italic', list: 'insertUnorderedList' };
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

  /* ---------------- new page / new post dialog ---------------- */

  function wireNewDocDialog() {
    const dialog = $('#newpage-dialog');
    const input = $('#newpage-name');
    const open = (mode) => {
      dialog.dataset.mode = mode;
      $('#newpage-heading').textContent = mode === 'post' ? 'Write a new blog post' : 'Add a new page';
      $('#newpage-label').textContent = mode === 'post' ? 'What is your post called?' : 'What should the page be called?';
      input.placeholder = mode === 'post' ? 'For example: My first tomatoes' : 'For example: My recipes';
      $('#newpage-create').textContent = mode === 'post' ? 'Start writing' : 'Create page';
      input.value = '';
      $('#newpage-file').textContent = '…';
      dialog.showModal();
      input.focus();
    };
    $('#btn-add-page').addEventListener('click', () => open('page'));
    $('#btn-add-post').addEventListener('click', () => open('post'));
    input.addEventListener('input', () => {
      const post = dialog.dataset.mode === 'post';
      $('#newpage-file').textContent = input.value.trim() ? uniqueFile(F.slugify(input.value, post ? 'post' : 'page'), post ? 'blog/' : '') : '…';
    });
    dialog.querySelector('form').addEventListener('submit', (e) => {
      e.preventDefault();
      const create = e.submitter && e.submitter.value === 'create';
      dialog.close();
      if (!create) return;
      if (dialog.dataset.mode === 'post') createPost(input.value); else createPage(input.value);
    });
  }

  /* ---------------- page & post settings panels ---------------- */

  function wireDocPanels() {
    $('#page-title').addEventListener('input', (e) => {
      const meta = docMeta(store.current);
      if (!meta) return;
      meta.title = e.target.value.trim() || F.nameFromFile(store.current);
      refreshLiveBlocks();
      renderRegionPreviews();
      markDirty();
    });

    $('#page-in-menu').addEventListener('change', (e) => {
      const meta = pageMeta(store.current);
      if (!meta) return;
      meta.showInNavbar = e.target.checked;
      renderRegionPreviews();
      markDirty();
      showToast(e.target.checked ? 'This page now has a link in your website menu.' : 'This page is hidden from your website menu. It’s still on your website.');
    });

    $('#post-date').addEventListener('change', (e) => {
      const meta = postMeta(store.current);
      if (meta && /^\d{4}-\d{2}-\d{2}$/.test(e.target.value)) { meta.date = e.target.value; renderRegionPreviews(); markDirty(); }
    });
    $('#post-excerpt').addEventListener('input', (e) => {
      const meta = postMeta(store.current);
      if (!meta) return;
      meta.excerpt = e.target.value.trim();
      meta.excerptAuto = !meta.excerpt;
      markDirty();
    });
    $('#post-cover').addEventListener('click', () => {
      const meta = postMeta(store.current);
      openMediaLibrary({ current: meta.thumbnail, onPick: (path) => { meta.thumbnail = path; renderCoverPicker(); renderRegionPreviews(); markDirty(); } });
    });
    $('#post-cover-remove').addEventListener('click', () => {
      const meta = postMeta(store.current);
      meta.thumbnail = '';
      renderCoverPicker();
      renderRegionPreviews();
      markDirty();
    });

    // Clicking the header/footer preview around a page opens it for editing.
    $('#preview-header').addEventListener('click', () => openDoc('header.html'));
    $('#preview-footer').addEventListener('click', () => openDoc('footer.html'));
  }

  /* ---------------- more options ---------------- */

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
    wireFormatBar();
    wireDrawer();
    wireBlockSettings();
    wireSettings();
    wirePreview();
    wireMediaLibrary();
    wireNewDocDialog();
    wireDocPanels();
    wireAdvanced();

    $('#btn-save').addEventListener('click', saveDraft);
    $('#btn-publish').addEventListener('click', publishLive);
    document.querySelectorAll('dialog').forEach((d) => {
      d.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => d.close()));
    });

    document.querySelector('.sidebar').addEventListener('click', (e) => {
      const btn = e.target.closest('.page-item');
      if (btn && btn.dataset.file !== store.current) openDoc(btn.dataset.file);
    });

    canvasEl().addEventListener('click', (e) => {
      const del = e.target.closest('.block-delete');
      if (del) { removeBlock(del.closest('.grid-stack-item')); return; }
      const set = e.target.closest('.block-settings');
      if (set) { openBlockSettings(set.closest('.grid-stack-item')); return; }
      const embed = e.target.closest('.embed-editor');
      if (embed) openBlockSettings(embed.closest('.grid-stack-item'));
    });
    canvasEl().addEventListener('input', markDirty);

    grid.on('change added removed', () => { markDirty(); refreshEmptyState(); });
    const paper = $('#paper');
    grid.on('dragstart resizestart', () => paper.classList.add('is-arranging'));
    grid.on('dragstop resizestop', () => paper.classList.remove('is-arranging'));

    window.addEventListener('beforeunload', () => { if (saveTimer) flushSave(); });
  }

  /* ========================================================================
     13. BOOT
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

  /** Files Pebble reads and writes in the repository. */
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
      float: true,                     // free-form: blocks stay where they're dropped
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

      // Where GitHub Pages publishes from.
      const publishing = await service.getPublishingInfo().catch((err) => { if (err.status === 401) throw err; return null; });
      if (publishing && publishing.path && publishing.path !== '/') {
        showBlocked('This website is set up in a way Pebble can’t edit yet.');
        return;
      }
      if (publishing && publishing.branch) service.liveBranch = publishing.branch;
      else service.liveBranch = (await service.getRepoInfo()).defaultBranch || service.liveBranch;
      if (publishing && publishing.url) service.publishedUrl = publishing.url;
      if (service.draftBranch === service.liveBranch) service.draftBranch = 'pebble-draft';

      // Read the website: draft if there is one, otherwise live.
      store.hasDraftBranch = await service.hasDraft();
      const [diff] = await Promise.all([service.compareDraftToLive(), loadRemoteFiles(readRef())]);
      store.draftAhead = diff.ahead;
      if (store.hasDraftBranch) {
        const [liveRoot, liveBlog] = await Promise.all([service.listDirectory('', service.liveBranch), service.listDirectory('blog', service.liveBranch)]);
        store.livePaths = new Set([...liveRoot, ...liveBlog].map((i) => i.path));
      } else {
        store.livePaths = new Set(store.remote.keys());
      }

      // Safety: only open websites Pebble made.
      const home = store.remote.get('index.html');
      if (home && !F.isPebblePage(home.content)) {
        showBlocked('This website wasn’t made with Pebble, so Pebble won’t change it.');
        return;
      }

      const site = buildSiteFromRemote();
      const local = loadLocal();
      if (local && local.config && local.docs) {
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
      }
    } catch (err) {
      console.error('Pebble: could not open the website', err);
      if (err && err.status === 401) return;
      showBlocked(err && (err.status === 403 || err.status === 404)
        ? 'Pebble can’t open this website with your hosting account. Please pick one from your list.'
        : "Sorry, we couldn't open your website. Please check your internet connection and try again.");
    }
  }

  /** Turn the repository's files into the site data (upgrading older sites). */
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

    // No site-config.json: an empty repository, or a site from an older Pebble.
    const pages = {};
    for (const [path, f] of store.remote) {
      if (F.PAGE_FILE_RE.test(path) && !['header.html', 'footer.html'].includes(path) && F.isPebblePage(f.content)) pages[path] = f.content;
    }
    if (!Object.keys(pages).length) return F.starterSite(service.repo.replace(/[-_.]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()));
    store.upgraded = true;
    return F.upgradeLegacySite(pages);
  }

  // Public API (console, tests, future modules).
  window.Pebble = {
    get store() { return store; },
    get service() { return service; },
    buildFiles,
    pendingChanges,
    openDoc,
    createPage,
    createPost,
    saveDraft,
    publishLive,
    readCanvas,
    /** The open page/post as a complete HTML file. */
    serializeToStaticHTML() { const files = buildFiles(); return files[store.current] || files[`${currentKind()}.html`]; },
    /** Load a Pebble page's blocks into the open doc. */
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
