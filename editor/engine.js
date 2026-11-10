/* ==========================================================================
   Pebble — editor engine
   --------------------------------------------------------------------------
   The user's website lives in THEIR GitHub repository as plain files (see
   lib/site-format.js). This editor reads them into plain data (the "site"),
   lets her edit one doc at a time, and on Save draft / Publish live
   re-renders every file and commits the ones that changed.

   Pages and posts are made of ROWS of SECTIONS (1–3 side by side). Every
   section is its own Gridstack instance; the Header and Footer are a single
   grid each. Blocks can be dragged between sections.

   Sections:
      1. Setup, helpers, icons (Lucide)
      2. Block editors (canvas UI + Inspector fields)
      3. Canvas: rows, sections, one Gridstack per section, selection
      4. Site store: remote files, local changes, what needs saving
      5. Docs: open / create pages & posts
      6. Header/Footer previews, hero
      7. Sidebar: Main Menu / Other Pages, rename, blog sub-sidebar
      8. Floating text toolbar
      9. Inspector (block / section / page settings)
     10. Site Settings: colours, branding, fonts, text styles, roundness, spacing
     11. Library: the hover "+" menu for sections and blocks
     12. Save draft & Publish live
     13. Photos: upload + library
     14. Preview
     15. UI wiring
     16. Boot
   ========================================================================== */

(function () {
  'use strict';

  /* ========================================================================
     1. SETUP, HELPERS, ICONS
     ======================================================================== */

  const F = window.PebbleFormat;

  const CONFIG = {
    cellHeight: 70,        // px per grid row (site-base.css: --row-height)
    minRows: { section: 2, header: 1, footer: 2 },
    demoRepo: { owner: 'demo-user', repo: 'my-garden-blog' },
    maxImageSide: 1600,
    autosaveDelay: 700,
    baseCssUrl: new URL('../lib/site-base.css', location.href).href,
  };

  const $ = (sel) => document.querySelector(sel);

  function el(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text != null) e.textContent = text;
    return e;
  }

  /** A Lucide icon placeholder (turned into an SVG automatically). */
  const icon = (name, cls = '') => `<i data-lucide="${name}" class="icon ${cls}" aria-hidden="true"></i>`;
  function iconEl(name, cls) {
    const span = el('span');
    span.innerHTML = icon(name, cls);
    return span.firstElementChild;
  }
  /** A button with an icon and (optionally) a label. */
  function iconButton(name, label, cls = '', showLabel = false) {
    const b = el('button', `ibtn ${cls}`);
    b.type = 'button';
    b.title = label;
    b.setAttribute('aria-label', label);
    b.innerHTML = icon(name) + (showLabel ? `<span class="ibtn__label">${F.escapeHtml(label)}</span>` : '');
    return b;
  }
  /** Turn every new [data-lucide] placeholder into an SVG (debounced). */
  let iconQueued = false;
  function renderIcons() {
    if (iconQueued || !window.lucide) return;
    iconQueued = true;
    requestAnimationFrame(() => {
      iconQueued = false;
      try { window.lucide.createIcons({ attrs: { 'stroke-width': 1.75 } }); } catch { /* icons are decoration */ }
    });
  }

  const isBlankText = (node) => !node.textContent.replace(/​/g, '').trim();

  function plainPaste(e) {
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData).getData('text/plain');
    document.execCommand('insertText', false, text);
  }

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

  let service = null;
  let isLoading = false;

  const dashboardUrl = () => PebbleAuth.appRoot + (service && service.isDemo ? '?demo=1' : '');

  /* ========================================================================
     2. BLOCK EDITORS
     ======================================================================== */

  const previewCtx = () => ({ config: store.config, file: store.current, root: '' });

  /** Put rendered website HTML into the editor, pointing its photos at the
      repository. Parsed in a <template> first, so the browser never asks for
      a photo at the wrong address. */
  function setRenderedHtml(node, html) {
    const t = document.createElement('template');
    t.innerHTML = html;
    t.content.querySelectorAll('img').forEach((img) => {
      const src = img.getAttribute('src');
      if (src && isRepoPath(src)) { img.removeAttribute('src'); showImage(img, src); }
    });
    node.replaceChildren(t.content);
  }

  const LINK_FIELD = (key, label, allowNone) => ({ key, label, type: 'link', allowNone });

  function changePhotoButton(onClick) {
    const b = el('button', 'image-change');
    b.type = 'button';
    b.innerHTML = `${icon('refresh-cw')}<span>Change photo</span>`;
    b.addEventListener('click', onClick);
    return b;
  }

  const EDITORS = {
    text: {
      label: 'Text', icon: 'type', hint: 'Stories, titles, lists', size: { w: 6, h: 3 }, min: { w: 2, h: 1 },
      create(data) { return makeRichEditable(el('div'), data.html, 'Click here and start typing…'); },
      read: (node) => ({ html: isBlankText(node) ? '' : F.sanitizeRichText(node.innerHTML) }),
      inspector: [
        { type: 'note', text: 'Click into the text to type. A toolbar appears with text styles, bold, underline, highlight and alignment.' },
        { type: 'note', text: 'How each text style looks is set for the whole website in Site Settings → Text styles.' },
      ],
    },

    image: {
      label: 'Photo', icon: 'image', hint: 'A picture', size: { w: 6, h: 5 }, min: { w: 2, h: 2 },
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
            media.append(img, changePhotoButton(() => openMediaLibrary({ current: d.src, onPick: use })));
            if (d.href) { const badge = el('span', 'image-linkbadge'); badge.innerHTML = `${icon('link')}<span>Linked</span>`; media.appendChild(badge); }
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
      label: 'Card', icon: 'layout-panel-top', hint: 'Photo, title and text', size: { w: 4, h: 6 }, min: { w: 2, h: 3 },
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
            media.append(img, changePhotoButton(() => openMediaLibrary({ current: d.src, onPick: use })));
          } else {
            media.classList.add('card-editor__nomedia');
            const add = el('button', 'card-editor__addphoto');
            add.type = 'button';
            add.innerHTML = `${icon('image-plus')}<span>Add a photo</span>`;
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
      label: 'Button', icon: 'mouse-pointer-click', hint: 'A link to a page', size: { w: 4, h: 1 }, min: { w: 2, h: 1 },
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
          if (!d.href) wrap.appendChild(el('span', 'button-editor__hint', 'Choose where it goes in the panel on the right'));
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
      label: 'Blog posts', icon: 'newspaper', hint: 'Your latest posts', size: { w: 12, h: 7 }, min: { w: 4, h: 3 },
      create(data) {
        const wrap = el('div', 'block-blog-feed feed-editor');
        wrap._data = { ...F.BLOCKS['blog-feed'].defaults(), ...data };
        wrap._render = () => {
          if (!store.config.posts.length) {
            wrap.innerHTML = `<div class="feed-editor__empty">${icon('newspaper', 'icon--lg')}<strong>Your blog posts will appear here</strong><small>Write one from the Blog page in the list on the left.</small></div>`;
            return;
          }
          setRenderedHtml(wrap, F.BLOCKS['blog-feed'].render(wrap._data, previewCtx()).inner);
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
      label: 'Embed code', icon: 'code', hint: 'For website helpers', size: { w: 6, h: 4 }, min: { w: 2, h: 1 }, advanced: true,
      create(data) {
        const wrap = el('div', 'embed-editor');
        wrap._data = { code: data.code || '' };
        wrap._render = () => {
          wrap.innerHTML = '';
          const title = el('strong', 'embed-editor__title');
          title.innerHTML = `${icon('code')}<span>Custom code</span>`;
          wrap.append(title, el('span', 'embed-editor__note', 'It runs on your published website, not here. Change it in the panel on the right.'));
          if (wrap._data.code) wrap.appendChild(el('code', 'embed-editor__code', wrap._data.code.slice(0, 160)));
          // Never put the code into the editor's own page: it could read her login.
        };
        wrap._render();
        return wrap;
      },
      read: (wrap) => ({ ...wrap._data }),
      inspector: [{
        key: 'code', type: 'code', label: 'Code to add to the page',
        warning: 'For website helpers only. Code copied from the internet can break your website or make it unsafe. If someone sent you this, make sure you trust them.',
      }],
    },

    'site-title': {
      label: 'Website name & logo', icon: 'badge', hint: 'Linked to your homepage', size: { w: 5, h: 1 }, min: { w: 2, h: 1 }, regionOnly: true,
      create() {
        const wrap = el('div', 'block-site-title');
        wrap._data = {};
        wrap._render = () => {
          wrap.innerHTML = '';
          const b = F.normalizeBranding(store.config.branding);
          const line = el('div', 'site-title');
          if (b.logo) {
            const img = el('img', 'site-title__logo');
            img.alt = '';
            img.style.height = `${b.logoHeight}px`;
            showImage(img, b.logo);
            line.appendChild(img);
          }
          if (!b.logo || b.logoMode === 'logo-name') {
            const input = el('input', 'site-title__name site-title-input');
            input.type = 'text';
            input.maxLength = 80;
            input.setAttribute('aria-label', 'Website name');
            input.title = 'Click to change your website’s name';
            input.value = store.config.siteName;
            input.addEventListener('input', () => { store.config.siteName = input.value.trim() || 'My website'; markDirty(); });
            line.appendChild(input);
          }
          wrap.appendChild(line);
        };
        wrap._render();
        return wrap;
      },
      read: () => ({}),
      inspector: [{ type: 'note', text: 'Your website’s name (and logo), linked to your homepage. Click the name to change it. Add a logo in Site Settings → Branding.' }],
    },

    menu: {
      label: 'Site menu', icon: 'menu', hint: 'Links to your pages', size: { w: 7, h: 1 }, min: { w: 2, h: 1 }, regionOnly: true,
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
        { type: 'note', text: 'The menu shows the pages under “Main Menu” in the list on the left. On phones it folds into a menu button.' },
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
    btn.innerHTML = `${icon('image-plus', 'icon--lg')}<strong>Add a photo</strong><small>Click to pick one of your photos or add a new one</small>`;
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
     3. CANVAS — rows of sections, one Gridstack per section
     ======================================================================== */

  const grids = new Map();        // section id → GridStack
  const sectionInfo = new Map();  // section id → { width, style }
  let regionGrid = null;          // the single grid of the Header / Footer
  let sectionSeq = 0;

  const canvasEl = () => $('#canvas');
  const isRegion = () => ['header', 'footer'].includes(currentKind());
  const allGrids = () => (regionGrid ? [regionGrid] : Array.from(grids.values()));

  function gridOptions(minRow) {
    return {
      column: F.COLUMNS,
      cellHeight: CONFIG.cellHeight,
      margin: F.normalizeTheme(store.config.theme).blockSpacing / 2,
      float: true,                     // free-form: blocks stay where they're dropped
      minRow,
      handle: '.block-handle',
      // Library tiles, and blocks dragged in from another section
      acceptWidgets: (n) => n.classList.contains('lib-tile') || n.classList.contains('grid-stack-item'),
      resizable: { handles: 'se' },
      animate: true,
      columnOpts: { breakpoints: [] },
    };
  }

  function createGrid(container, minRow) {
    const g = GridStack.init(gridOptions(minRow), container);
    g.on('change added removed', () => { markDirty(); refreshEmptyStates(); });
    g.on('dropped', (_e, _prev, node) => {
      if (!node || !node.el || node.el.querySelector('.block-body')) return; // a block moved from another section
      const { el: dropped, x, y } = node;
      const type = dropped.dataset.widgetType;
      g.removeWidget(dropped, true, false);
      const item = addBlock(type, null, { x, y }, { grid: g, focus: true });
      if (item) afterAdd(item);
    });
    g.on('dragstart resizestart', () => { $('#paper').classList.add('is-arranging'); hideToolbar(); closeLibrary(); });
    g.on('dragstop resizestop', () => $('#paper').classList.remove('is-arranging'));
    return g;
  }

  function destroyGrids() {
    for (const g of allGrids()) { try { g.destroy(false); } catch { /* ignore */ } }
    grids.clear();
    sectionInfo.clear();
    regionGrid = null;
  }

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
    bar.innerHTML = `<span class="block-handle" title="Hold and drag to move this block">${icon('grip-vertical')}<span>Move</span></span>` +
      `<button type="button" class="block-delete" title="Remove this block" aria-label="Remove this block">${icon('trash-2')}</button>`;
    const body = el('div', 'block-body');
    body.appendChild(ed.create({ ...F.BLOCKS[type].defaults(), ...data }));
    shell.append(bar, body);
    item.appendChild(shell);
    return item;
  }

  /** The grid new blocks go into: the selected section, else the first one. */
  function targetGrid() {
    if (regionGrid) return regionGrid;
    if (selectedSection && grids.has(selectedSection)) return grids.get(selectedSection);
    if (selected && selected.gridstackNode) return selected.gridstackNode.grid;
    return grids.values().next().value;
  }

  function addBlock(type, data, pos, opts = {}) {
    if (!EDITORS[type]) return null;
    const g = opts.grid || targetGrid();
    if (!g) return null;
    if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) pos = { ...pos, x: 0, y: g.engine.getRow() };
    // In a narrow section a new block fills the width.
    const secId = g.el.dataset.section;
    if (!pos.w && secId && sectionInfo.has(secId) && sectionInfo.get(secId).width <= 50) pos = { ...pos, w: F.COLUMNS };
    const item = createBlockElement(type, data, pos);
    g.el.appendChild(item);
    g.makeWidget(item);
    if (opts.focus) {
      item.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const editable = item.querySelector('[contenteditable="true"]');
      if (editable) setTimeout(() => editable.focus(), 250);
    }
    refreshEmptyStates();
    renderIcons();
    return item;
  }

  function removeBlock(item) {
    const snap = readBlock(item);
    const g = item.gridstackNode && item.gridstackNode.grid;
    if (selected === item) selectBlock(null);
    if (g) g.removeWidget(item);
    refreshEmptyStates();
    showToast('Block removed.', 'Undo', () => {
      addBlock(snap.type, snap.data, { x: snap.x, y: snap.y, w: snap.w, h: snap.h }, { grid: g && g.el.isConnected ? g : undefined });
      markDirty();
    });
  }

  const editorOf = (item) => item.querySelector('.block-body').firstElementChild;

  function readBlock(item) {
    const n = item.gridstackNode;
    const type = item.dataset.widgetType;
    return { type, x: n.x, y: n.y, w: n.w, h: n.h, data: EDITORS[type].read(editorOf(item)) };
  }

  function readGrid(g) {
    return F.sortBlocks(g.getGridItems()
      .filter((it) => it.gridstackNode && EDITORS[it.dataset.widgetType] && it.querySelector('.block-body'))
      .map(readBlock));
  }

  /** The doc on the canvas as data: rows (pages/posts) or blocks (Header/Footer). */
  function readCanvas() {
    if (regionGrid) return { blocks: readGrid(regionGrid) };
    const rows = Array.from(canvasEl().querySelectorAll(':scope > .ed-row')).map((rowEl) => ({
      sections: Array.from(rowEl.querySelectorAll(':scope > .ed-section')).map((secEl) => {
        const id = secEl.dataset.section;
        const info = sectionInfo.get(id);
        return { width: info.width, style: { ...info.style }, blocks: readGrid(grids.get(id)) };
      }),
    }));
    return { rows };
  }

  function refreshEmptyStates() {
    canvasEl().querySelectorAll('.ed-section, .ed-region').forEach((s) => {
      const g = s.querySelector('.grid-stack');
      s.classList.toggle('is-empty', !g || !g.querySelector('.grid-stack-item'));
    });
  }

  /** Draw a section's background (colour, photo, overlay) and text tone. */
  function paintSection(secEl, info) {
    const st = F.normalizeSectionStyle(info.style);
    secEl.className = ['ed-section', 'page-section', st.tone === 'light' ? 'page-section--light' : '', st.bgColor || st.bgImage ? 'page-section--filled' : '',
      secEl.dataset.section === selectedSection ? 'is-selected' : ''].filter(Boolean).join(' ');
    if (st.bgColor) secEl.style.setProperty('--section-bg', st.bgColor); else secEl.style.removeProperty('--section-bg');
    secEl.querySelectorAll(':scope > .page-section__bg, :scope > .page-section__overlay').forEach((n) => n.remove());
    const first = secEl.firstChild;
    if (st.bgImage) {
      const bg = el('div', 'page-section__bg');
      const img = el('img');
      img.alt = '';
      showImage(img, st.bgImage);
      bg.appendChild(img);
      secEl.insertBefore(bg, first);
    }
    if (st.overlayOpacity > 0) {
      const ov = el('div', 'page-section__overlay');
      ov.style.background = st.overlayColor;
      ov.style.opacity = (st.overlayOpacity / 100).toFixed(2);
      secEl.insertBefore(ov, secEl.querySelector('.ed-section__bar'));
    }
  }

  function gapEl(index) {
    const gap = el('div', 'ed-gap');
    gap.dataset.gap = index;
    const btn = iconButton('plus', 'Add a section here', 'ed-gap__add');
    btn.dataset.gap = index;
    gap.appendChild(btn);
    return gap;
  }

  function sectionEl(section) {
    const id = `s${++sectionSeq}`;
    sectionInfo.set(id, { width: section.width, style: F.normalizeSectionStyle(section.style) });
    const sec = el('div', 'ed-section page-section');
    sec.dataset.section = id;
    const bar = el('div', 'ed-section__bar');
    bar.innerHTML = `<span class="ed-section__tag">${icon('rows-3')}<span>Section</span></span>`;
    const actions = [
      ['sliders-horizontal', 'Section settings', 'settings'],
      ['columns-2', 'Put a section next to this one', 'beside'],
      ['arrow-up', 'Move this row up', 'up'],
      ['arrow-down', 'Move this row down', 'down'],
      ['trash-2', 'Remove this section', 'delete'],
    ];
    for (const [ic, label, act] of actions) {
      const b = iconButton(ic, label, 'ed-section__btn');
      b.dataset.sectionAction = act;
      bar.appendChild(b);
    }
    const wrap = el('div', 'ed-grid-wrap');
    const gridDiv = el('div', 'grid-stack');
    gridDiv.dataset.section = id;
    wrap.appendChild(gridDiv);
    const empty = el('div', 'ed-section__empty');
    empty.innerHTML = `${icon('plus')}<span>Empty section — add a block</span>`;
    empty.dataset.addBlock = id;
    const add = iconButton('plus', 'Add a block', 'ed-section__add', true);
    add.title = 'Add a block to this section';
    add.dataset.addBlock = id;
    sec.append(bar, wrap, empty, add);
    paintSection(sec, sectionInfo.get(id));
    return { id, sec, gridDiv, blocks: section.blocks };
  }

  /** Build the canvas for a doc. */
  function loadCanvas(doc) {
    isLoading = true;
    const scroll = $('.canvas-area').scrollTop;
    try {
      hideToolbar();
      selectBlock(null, { silent: true });
      selectedSection = null;
      destroyGrids();
      const canvas = canvasEl();
      canvas.innerHTML = '';
      canvas.dataset.kind = doc.kind;

      if (doc.kind === 'header' || doc.kind === 'footer') {
        const region = el('div', 'ed-region');
        const wrap = el('div', 'ed-grid-wrap');
        const gridDiv = el('div', 'grid-stack');
        wrap.appendChild(gridDiv);
        const add = iconButton('plus', `Add a block to the ${doc.kind === 'header' ? 'Header' : 'Footer'}`, 'ed-section__add ed-region__add', true);
        add.dataset.addBlock = 'region';
        region.append(wrap, add);
        canvas.appendChild(region);
        regionGrid = createGrid(gridDiv, CONFIG.minRows[doc.kind]);
        regionGrid.batchUpdate();
        for (const b of doc.blocks || []) if (EDITORS[b.type]) addBlock(b.type, b.data, { x: b.x, y: b.y, w: b.w, h: b.h }, { grid: regionGrid });
        regionGrid.batchUpdate(false);
      } else {
        const rows = F.normalizeRows(doc.rows);
        canvas.appendChild(gapEl(0));
        rows.forEach((row, i) => {
          const rowEl = el('div', `ed-row section-row section-row--${row.sections.length === 1 ? 'full' : 'split'}`);
          if (row.sections.length > 1) rowEl.style.setProperty('--row-columns', row.sections.map((s) => `${s.width}fr`).join(' '));
          const built = row.sections.map(sectionEl);
          built.forEach((b) => rowEl.appendChild(b.sec));
          canvas.appendChild(rowEl);
          canvas.appendChild(gapEl(i + 1));
          for (const b of built) {
            const g = createGrid(b.gridDiv, CONFIG.minRows.section);
            grids.set(b.id, g);
            g.batchUpdate();
            for (const blk of b.blocks) if (EDITORS[blk.type]) addBlock(blk.type, blk.data, { x: blk.x, y: blk.y, w: blk.w, h: blk.h }, { grid: g });
            g.batchUpdate(false);
          }
        });
      }
    } finally {
      isLoading = false;
      refreshEmptyStates();
      renderIcons();
      $('.canvas-area').scrollTop = scroll;
    }
  }

  /** Change the rows of the open page/post, then redraw. */
  function editRows(fn, { selectAt } = {}) {
    flushCanvas();
    const doc = store.docs[store.current];
    doc.rows = F.normalizeRows(doc.rows);
    fn(doc.rows);
    doc.rows = F.normalizeRows(doc.rows);
    loadCanvas(doc);
    if (selectAt) {
      const rowEl = canvasEl().querySelectorAll(':scope > .ed-row')[selectAt[0]];
      const secEl = rowEl && rowEl.querySelectorAll(':scope > .ed-section')[selectAt[1] || 0];
      if (secEl) selectSection(secEl.dataset.section);
    } else {
      renderInspector();
    }
    markDirty();
  }

  /** Where a section is: [row index, section index]. */
  function sectionPos(id) {
    const rows = Array.from(canvasEl().querySelectorAll(':scope > .ed-row'));
    for (let r = 0; r < rows.length; r++) {
      const secs = Array.from(rows[r].querySelectorAll(':scope > .ed-section'));
      const s = secs.findIndex((n) => n.dataset.section === id);
      if (s >= 0) return [r, s, secs.length];
    }
    return null;
  }

  function addRow(index, layoutKey = 'one', firstBlock = null) {
    const widths = (F.ROW_LAYOUTS[layoutKey] || F.ROW_LAYOUTS.one).widths;
    editRows((rows) => {
      const sections = widths.map((w) => F.newSection(w));
      if (firstBlock) {
        const ed = EDITORS[firstBlock];
        sections[0].blocks.push({ type: firstBlock, x: 0, y: 0, w: Math.min(ed.size.w, 12), h: ed.size.h, data: F.BLOCKS[firstBlock].defaults() });
      }
      rows.splice(index, 0, { sections });
    }, { selectAt: [index, 0] });
    if (firstBlock) {
      const sec = canvasEl().querySelectorAll(':scope > .ed-row')[index].querySelector('.ed-section');
      const item = sec && sec.querySelector('.grid-stack-item');
      if (item) { selectBlock(item); const ed = item.querySelector('[contenteditable="true"]'); if (ed) setTimeout(() => ed.focus(), 150); }
    }
  }

  /** Change how many sections a row has (and their widths). Blocks are never lost. */
  function setRowLayout(rowIndex, layoutKey) {
    const widths = F.ROW_LAYOUTS[layoutKey].widths;
    editRows((rows) => {
      const row = rows[rowIndex];
      const secs = row.sections;
      while (secs.length > widths.length) {
        // Merge the extra section's blocks into the last one that stays, underneath.
        const gone = secs.pop();
        const keep = secs[secs.length - 1];
        const bottom = keep.blocks.reduce((m, b) => Math.max(m, b.y + b.h), 0);
        gone.blocks.forEach((b) => keep.blocks.push({ ...b, y: b.y + bottom }));
      }
      while (secs.length < widths.length) secs.push(F.newSection());
      secs.forEach((s, i) => { s.width = widths[i]; });
    }, { selectAt: [rowIndex, 0] });
  }

  function moveRow(rowIndex, dir) {
    const to = rowIndex + dir;
    editRows((rows) => {
      if (to < 0 || to >= rows.length) return;
      const [r] = rows.splice(rowIndex, 1);
      rows.splice(to, 0, r);
    }, { selectAt: [Math.max(0, Math.min(to, store.docs[store.current].rows.length - 1)), 0] });
  }

  function removeSection(id) {
    const pos = sectionPos(id);
    if (!pos) return;
    flushCanvas();
    const before = JSON.parse(JSON.stringify(store.docs[store.current].rows));
    editRows((rows) => {
      const row = rows[pos[0]];
      if (row.sections.length === 1) rows.splice(pos[0], 1);
      else {
        row.sections.splice(pos[1], 1);
        const each = Math.floor(100 / row.sections.length);
        row.sections.forEach((s, i) => { s.width = i === row.sections.length - 1 ? 100 - each * (row.sections.length - 1) : each; });
      }
    });
    showToast('Section removed.', 'Undo', () => editRows((rows) => { rows.splice(0, rows.length, ...before); }));
  }

  function sectionAction(id, action) {
    const pos = sectionPos(id);
    if (!pos) return;
    if (action === 'settings') selectSection(id);
    else if (action === 'up') moveRow(pos[0], -1);
    else if (action === 'down') moveRow(pos[0], +1);
    else if (action === 'delete') removeSection(id);
    else if (action === 'beside') {
      if (pos[2] >= 3) { showToast('A row can hold up to three sections.'); return; }
      setRowLayout(pos[0], pos[2] === 1 ? 'main' : 'three');
    }
  }

  function refreshLiveBlocks() {
    for (const g of allGrids()) {
      g.getGridItems().forEach((it) => {
        if (['menu', 'blog-feed', 'site-title'].includes(it.dataset.widgetType)) editorOf(it)._render();
      });
    }
    renderIcons();
  }

  /* ---------------- selection: one block, or one section ---------------- */

  let selected = null;          // a block (grid item)
  let selectedSection = null;   // a section id

  function selectBlock(item, { silent = false } = {}) {
    if (item && !item.isConnected) item = null;
    if (item) setSelectedSection(null);
    if (selected === item) { if (!silent && item) renderInspector(); return; }
    if (selected) selected.classList.remove('is-selected');
    selected = item;
    if (item) item.classList.add('is-selected');
    if (!silent) renderInspector();
  }

  function setSelectedSection(id) {
    if (selectedSection === id) return;
    const old = selectedSection && canvasEl().querySelector(`.ed-section[data-section="${selectedSection}"]`);
    if (old) old.classList.remove('is-selected');
    selectedSection = id;
    const now = id && canvasEl().querySelector(`.ed-section[data-section="${id}"]`);
    if (now) now.classList.add('is-selected');
  }

  function selectSection(id) {
    if (selected) { selected.classList.remove('is-selected'); selected = null; }
    setSelectedSection(id);
    renderInspector();
  }

  /* ========================================================================
     4. SITE STORE
     ======================================================================== */

  const store = {
    remote: new Map(),
    livePaths: new Set(),
    config: F.defaultConfig(),
    docs: {},              // file → { kind, rows } (pages/posts) or { kind, blocks } (header/footer)
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
  const docBlocks = (doc) => (doc ? (doc.rows ? F.blocksOfRows(doc.rows) : doc.blocks || []) : []);

  function blogPageFile() {
    if (store.config.blogPage && store.docs[store.config.blogPage]) return store.config.blogPage;
    const feeds = store.config.pages.filter((p) => docBlocks(store.docs[p.file]).some((b) => b.type === 'blog-feed'));
    const best = feeds.find((p) => /^blog/.test(p.file))
      || feeds.find((p) => docBlocks(store.docs[p.file]).some((b) => b.type === 'blog-feed' && !b.data.limit))
      || feeds[0];
    return best ? best.file : '';
  }

  function flushCanvas() {
    if (isLoading || !store.current || !store.docs[store.current]) return;
    const data = readCanvas();
    if (data.rows) store.docs[store.current].rows = data.rows;
    if (data.blocks) store.docs[store.current].blocks = data.blocks;
  }

  function siteState() {
    flushCanvas();
    return { config: store.config, docs: store.docs, customCss: store.customCss };
  }

  function buildFiles() { return F.buildSiteFiles(siteState(), { baseCss: store.baseCss }); }

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
    setStatus('Saving…');
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

  function setStatus(text, state = '') {
    const s = $('#save-status');
    s.dataset.state = state;
    s.querySelector('.save-status__text').textContent = text;
    s.title = text;
  }

  function updateSaveStatus(ok = true) {
    if (!ok) { setStatus('Couldn’t keep your changes on this computer (storage is full)', 'error'); return; }
    const unsaved = lastPending.length > 0;
    if (unsaved) setStatus('Changes not saved yet', 'unsaved');
    else if (store.draftAhead) setStatus('Draft saved · not live yet', 'draft');
    else setStatus('Your website is up to date', 'ok');
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
      loadCanvas(doc);
      try { localStorage.setItem(lastDocKey(), file); } catch { /* ignore */ }
    } finally {
      isSwitching = false;
    }
    sidebarPane = doc.kind === 'post' || file === blogPageFile() ? 'blog' : 'pages';
    renderDocChrome();
    renderSidebar();
    renderInspector();
    $('.canvas-area').scrollTop = 0;
  }

  function renderDocChrome() {
    const kind = currentKind();
    $('#paper').dataset.kind = kind;
    const meta = docMeta(store.current);
    const names = { header: 'Header', footer: 'Footer' };
    $('#doc-crumb').textContent = names[kind] || (meta ? meta.title : F.nameFromFile(store.current));
    renderRegionPreviews();
  }

  function uniqueFile(base, folder = '') {
    let file = `${folder}${base}.html`;
    const taken = (f) => store.docs[f] || store.remote.has(f) || ['header.html', 'footer.html', 'index.html'].includes(f);
    for (let i = 2; taken(file); i++) file = `${folder}${base}-${i}.html`;
    return file;
  }

  function createPage(name, inMenu = true) {
    name = name.trim();
    if (!name) return;
    const file = uniqueFile(F.slugify(name, 'page'));
    insertPage({ file, title: name.slice(0, 80), showInNavbar: inMenu });
    store.docs[file] = { kind: 'page', rows: F.rowsFromBlocks([]) };
    sidebarPane = 'pages';
    openDoc(file);
    markDirty();
    showToast(`Your new page “${name}” is ready${inMenu ? ' and has a link in your menu' : ''}. Hover over the page and press + to add things.`);
  }

  function insertPage(meta) {
    const pages = store.config.pages;
    const lastOfList = pages.map((p) => p.showInNavbar === meta.showInNavbar).lastIndexOf(true);
    pages.splice(lastOfList + 1, 0, meta);
  }

  function ensureBlogPage() {
    const existing = blogPageFile();
    if (existing) { store.config.blogPage = existing; return existing; }
    const file = uniqueFile('blog');
    insertPage({ file, title: 'Blog', showInNavbar: true });
    store.docs[file] = {
      kind: 'page',
      rows: F.rowsFromBlocks([
        { type: 'text', x: 0, y: 0, w: 12, h: 2, data: { html: '<h2>Blog</h2><p>My latest stories.</p>' } },
        { type: 'blog-feed', x: 0, y: 2, w: 12, h: 7, data: { limit: 0 } },
      ]),
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
    store.docs[file] = { kind: 'post', rows: F.rowsFromBlocks([{ type: 'text', x: 0, y: 0, w: 12, h: 4, data: { html: '' } }]) };
    sidebarPane = 'blog';
    openDoc(file);
    markDirty();
    showToast(hadBlog ? 'Your new post is ready. Write away!' : 'Your blog has started. Pebble made a “Blog” page that lists your posts.');
  }

  /** Rename a page or post (from the sidebar). */
  function renameDoc(file, title) {
    const meta = docMeta(file);
    title = String(title || '').trim();
    if (!meta || !title || title === meta.title) return;
    meta.title = title.slice(0, postMeta(file) ? 140 : 80);
    refreshLiveBlocks();
    renderDocChrome();
    renderSidebar();
    markDirty();
  }

  /* ========================================================================
     6. HEADER / FOOTER PREVIEWS & HERO
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

    const ctx = previewCtx();
    setRenderedHtml(top.querySelector('.region-preview__content'), F.renderRegion('header', store.docs['header.html'].blocks, ctx));
    setRenderedHtml(bottom.querySelector('.region-preview__content'), F.renderRegion('footer', store.docs['footer.html'].blocks, ctx));

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
     7. SIDEBAR — Main Menu / Other Pages, rename, blog sub-sidebar
     ======================================================================== */

  let sidebarPane = 'pages';   // 'pages' | 'blog'

  function docItem(file, iconName, label, sub, { renamable = false } = {}) {
    const pending = new Set(lastPending.map((p) => p.path));
    const row = el('div', 'nav-item' + (file === store.current ? ' is-current' : ''));
    row.dataset.file = file;
    const btn = el('button', 'nav-item__main');
    btn.type = 'button';
    btn.dataset.open = file;
    if (file === store.current) btn.setAttribute('aria-current', 'page');
    btn.innerHTML = icon(iconName, 'nav-item__icon');
    const name = el('span', 'nav-item__name', label);
    if (sub) name.appendChild(el('small', 'nav-item__sub', sub));
    btn.appendChild(name);
    if (pending.has(file)) btn.appendChild(el('span', 'nav-item__dot'));
    if (!store.livePaths.has(file)) btn.appendChild(el('span', 'nav-item__badge', 'New'));
    row.appendChild(btn);
    if (renamable) {
      const r = iconButton('pencil', 'Rename', 'nav-item__act');
      r.dataset.rename = file;
      row.appendChild(r);
    }
    return row;
  }

  function renderSidebar() {
    const blogFile = blogPageFile();
    $('#sidebar').dataset.pane = blogFile && sidebarPane === 'blog' ? 'blog' : 'pages';

    // Main pane: Main Menu / Other Pages
    for (const [id, inMenu] of [['#menu-pages', true], ['#other-pages', false]]) {
      const ul = $(id);
      ul.innerHTML = '';
      const list = store.config.pages.filter((p) => p.showInNavbar === inMenu);
      for (const p of list) {
        const li = el('li', 'page-entry');
        li.dataset.file = p.file;
        li.draggable = true;
        const grip = el('span', 'page-grip');
        grip.innerHTML = icon('grip-vertical');
        li.appendChild(grip);
        const isBlog = p.file === blogFile;
        const item = docItem(p.file, p.file === 'index.html' ? 'house' : isBlog ? 'newspaper' : 'file', p.title, isBlog ? `${store.config.posts.length} post${store.config.posts.length === 1 ? '' : 's'}` : '', { renamable: true });
        if (isBlog) {
          item.querySelector('.nav-item__main').dataset.openBlog = '1';
          const go = el('span', 'nav-item__chev');
          go.innerHTML = icon('chevron-right');
          item.querySelector('.nav-item__main').appendChild(go);
        }
        const move = iconButton(p.showInNavbar ? 'arrow-down-to-line' : 'arrow-up-to-line', p.showInNavbar ? 'Move to Other Pages (no menu link)' : 'Move to the Main Menu', 'nav-item__act');
        move.dataset.move = p.file;
        item.appendChild(move);
        li.appendChild(item);
        ul.appendChild(li);
      }
      if (!list.length) ul.appendChild(el('li', 'page-list__empty', inMenu ? 'Drag a page here to give it a menu link.' : 'Drag a page here to take it out of the menu. It stays on your website.'));
    }
    $('#btn-start-blog').hidden = !!blogFile;

    const regions = $('#region-list');
    regions.innerHTML = '';
    for (const [file, ic, label] of [['header.html', 'panel-top', 'Header'], ['footer.html', 'panel-bottom', 'Footer']]) {
      const li = el('li');
      li.appendChild(docItem(file, ic, label));
      regions.appendChild(li);
    }

    // Blog pane
    if (blogFile) {
      const meta = pageMeta(blogFile);
      $('#blog-pane-title').textContent = meta ? meta.title : 'Blog';
      const bp = $('#blog-page-item');
      bp.innerHTML = '';
      bp.appendChild(docItem(blogFile, 'layout-list', 'Blog page', 'The page that lists your posts', { renamable: false }));
      const ul = $('#post-list');
      ul.innerHTML = '';
      const posts = F.sortedPosts(store.config);
      for (const p of posts) {
        const li = el('li');
        li.appendChild(docItem(p.file, 'file-text', p.title, F.formatDate(p.date), { renamable: true }));
        ul.appendChild(li);
      }
      $('#posts-empty').hidden = posts.length > 0;
    }
    renderIcons();
  }

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

  /** Rename in place: the name turns into a text field. */
  function startRename(file) {
    const item = $(`#sidebar .nav-item[data-file="${CSS.escape(file)}"]`) || document.querySelector(`#sidebar [data-file="${CSS.escape(file)}"] .nav-item`);
    const meta = docMeta(file);
    if (!item || !meta) return;
    const nameEl = item.querySelector('.nav-item__name');
    const input = el('input', 'nav-item__input');
    input.type = 'text';
    input.value = meta.title;
    input.maxLength = postMeta(file) ? 140 : 80;
    input.setAttribute('aria-label', 'New name');
    item.classList.add('is-renaming');
    nameEl.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      if (save) renameDoc(file, input.value);
      renderSidebar();
      if (save && file === store.current) renderInspector();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('click', (e) => e.stopPropagation());
  }

  let lastClick = { file: '', time: 0 };

  function wireSidebar() {
    const side = $('#sidebar');
    side.addEventListener('click', (e) => {
      if (e.target.closest('.nav-item__input')) return;
      const move = e.target.closest('[data-move]');
      if (move) { const p = pageMeta(move.dataset.move); movePage(p.file, !p.showInNavbar); return; }
      const ren = e.target.closest('[data-rename]');
      if (ren) { startRename(ren.dataset.rename); return; }
      if (e.target.closest('#btn-blog-back')) { sidebarPane = 'pages'; renderSidebar(); return; }
      if (e.target.closest('#btn-new-post')) { openNewDocDialog('post'); return; }
      const open = e.target.closest('[data-open]');
      if (open) {
        // Double-click to rename. (The list is redrawn after the first click,
        // so the browser's own dblclick doesn't always arrive.)
        const now = Date.now();
        const file = open.dataset.open;
        if (lastClick.file === file && now - lastClick.time < 450 && docMeta(file) && e.target.closest('.nav-item__name')) {
          lastClick = { file: '', time: 0 };
          startRename(file);
          return;
        }
        lastClick = { file, time: now };
        if (open.dataset.openBlog) sidebarPane = 'blog';
        if (open.dataset.open !== store.current) openDoc(open.dataset.open);
        else renderSidebar();
      }
    });
    side.addEventListener('dblclick', (e) => {
      const name = e.target.closest('.nav-item__name');
      const item = name && name.closest('.nav-item');
      if (item && docMeta(item.dataset.file)) startRename(item.dataset.file);
    });

    // Drag & drop between "Main Menu" and "Other Pages".
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
     ======================================================================== */

  let toolbarEditor = null;
  let savedRange = null;
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

  function blocksInSelection(editor) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return [];
    const range = sel.getRangeAt(0);
    const all = Array.from(editor.querySelectorAll('p, h1, h2, h3, li, blockquote')).filter((b) => !b.querySelector('p, h1, h2, h3, li'));
    let hit = all.filter((b) => range.intersectsNode(b));
    if (!hit.length) {
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
    document.execCommand('formatBlock', false, F.TEXT_STYLES[key].tag);
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
    if (top < topLimit) top = topLimit;
    const left = Math.max(8, Math.min(box.left, window.innerWidth - tb.offsetWidth - 8));
    tb.style.top = `${top}px`;
    tb.style.left = `${left}px`;
  }

  function showToolbar(editor) {
    toolbarEditor = editor;
    toolbar().hidden = false;
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
    const palette = $('#tt-palette');
    for (const [name, h] of Object.entries(F.HIGHLIGHTS)) {
      const b = el('button', 'tt-swatch');
      b.type = 'button';
      b.dataset.highlight = name;
      b.style.background = h.color;
      b.title = `${h.label} highlight`;
      b.setAttribute('aria-label', `${h.label} highlight`);
      palette.insertBefore(b, palette.lastElementChild);
    }
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
     9. INSPECTOR
     ======================================================================== */

  function linkOptions(allowNone) {
    const opts = [['', allowNone || 'Choose a page…']];
    for (const p of store.config.pages) opts.push([p.file, `Page: ${p.title}`]);
    for (const p of F.sortedPosts(store.config)) opts.push([p.file, `Blog post: ${p.title}`]);
    opts.push(['__external__', 'Another website…']);
    return opts;
  }

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
        ['#ffffff', 'White'], ['#f7f3ec', 'Cream'], ['#eef3f8', 'Light blue'], ['#2d2a26', 'Dark'], ['#000000', 'Black']];
      const draw = (current) => {
        box.innerHTML = '';
        for (const [c, name] of choices) {
          const b = el('button', 'insp-swatch' + (c === '' ? ' insp-swatch--default' : '') + ((current || '') === c ? ' is-on' : ''));
          b.type = 'button';
          b.title = name;
          b.setAttribute('aria-label', name);
          if (c) b.style.background = c; else b.innerHTML = icon('ban');
          b.addEventListener('click', () => { onChange(c); draw(c); });
          box.appendChild(b);
        }
        const custom = el('label', 'insp-swatch insp-swatch--custom');
        custom.title = 'Pick any color';
        custom.innerHTML = icon('pipette');
        const pick = el('input');
        pick.type = 'color';
        pick.value = current || '#ffffff';
        pick.setAttribute('aria-label', 'Pick any color');
        pick.addEventListener('input', () => { onChange(pick.value); box.querySelectorAll('.is-on').forEach((n) => n.classList.remove('is-on')); });
        custom.appendChild(pick);
        box.appendChild(custom);
        renderIcons();
      };
      draw(value);
      row.appendChild(box);
    } else if (f.type === 'radius') {
      const useSite = el('label', 'insp-check');
      const cb = el('input');
      cb.type = 'checkbox';
      cb.checked = value === '' || value == null;
      useSite.append(cb, document.createTextNode(' Same as the rest of the website'));
      const rangeRow = el('div', 'insp-rangerow');
      const range = el('input', 'insp-range');
      range.type = 'range';
      range.min = 0;
      range.max = 40;
      range.value = value === '' || value == null ? F.normalizeTheme(store.config.theme).borderRadius : value;
      const out = el('output', 'insp-out', `${range.value} px`);
      rangeRow.append(range, out);
      rangeRow.hidden = cb.checked;
      cb.addEventListener('change', () => { rangeRow.hidden = cb.checked; onChange(cb.checked ? '' : parseInt(range.value, 10)); });
      range.addEventListener('input', () => { out.textContent = `${range.value} px`; onChange(parseInt(range.value, 10)); });
      row.append(useSite, rangeRow);
    } else if (f.type === 'range') {
      const rangeRow = el('div', 'insp-rangerow');
      const range = el('input', 'insp-range');
      range.type = 'range';
      range.min = f.min; range.max = f.max; range.step = f.step || 1;
      range.value = value;
      range.id = id;
      const out = el('output', 'insp-out', `${value}${f.unit || ''}`);
      range.addEventListener('input', () => { out.textContent = `${range.value}${f.unit || ''}`; onChange(parseInt(range.value, 10)); });
      rangeRow.append(range, out);
      row.appendChild(rangeRow);
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
      const pick = el('button', 'btn btn--secondary btn--small');
      pick.type = 'button';
      pick.innerHTML = `${icon(value ? 'refresh-cw' : 'image-plus')}<span>${value ? 'Replace photo' : 'Choose a photo'}</span>`;
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
        warn.innerHTML = `<strong>${icon('triangle-alert')}<span>Careful</span></strong>`;
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

  function syncInspectorField(key, value) {
    const input = document.querySelector(`#inspector [data-key="${key}"]`);
    if (input && document.activeElement !== input) input.value = value;
  }

  function inspectorHead(iconName, title, onClose) {
    const head = el('div', 'insp-head');
    head.innerHTML = icon(iconName, 'insp-head__icon');
    head.appendChild(el('h2', 'insp-head__title', title));
    if (onClose) {
      const close = iconButton('x', 'Done', 'insp-head__close');
      close.addEventListener('click', onClose);
      head.appendChild(close);
    }
    return head;
  }

  function renderInspector() {
    const body = $('#inspector-body');
    body.innerHTML = '';
    if (selected && selected.isConnected) renderBlockInspector(body, selected);
    else if (selectedSection && sectionInfo.has(selectedSection)) renderSectionInspector(body, selectedSection);
    else renderDocInspector(body);
    renderIcons();
  }

  function renderBlockInspector(body, item) {
    const type = item.dataset.widgetType;
    const ed = EDITORS[type];
    const node = editorOf(item);
    body.appendChild(inspectorHead(ed.icon, ed.label, () => selectBlock(null)));
    const data = ed.read(node);
    for (const f of ed.inspector || []) {
      body.appendChild(inspectorField(f, data[f.key], (value) => {
        const current = ed.read(node);
        current[f.key] = value;
        node._data = { ...node._data, ...current };
        node._render();
        renderIcons();
        markDirty();
      }));
    }
    const remove = el('button', 'insp-remove');
    remove.type = 'button';
    remove.innerHTML = `${icon('trash-2')}<span>Remove this block</span>`;
    remove.addEventListener('click', () => removeBlock(item));
    body.appendChild(remove);
  }

  /** Settings of one section: background, overlay, text colour, row layout. */
  function renderSectionInspector(body, id) {
    const info = sectionInfo.get(id);
    const pos = sectionPos(id);
    body.appendChild(inspectorHead('rows-3', 'Section', () => selectSection(null)));
    const secEl = canvasEl().querySelector(`.ed-section[data-section="${id}"]`);
    const update = (patch) => {
      info.style = F.normalizeSectionStyle({ ...info.style, ...patch });
      paintSection(secEl, info);
      markDirty();
    };

    // Row layout (side by side)
    const layout = el('div', 'insp-field');
    layout.appendChild(el('span', 'insp-label', 'Layout of this row'));
    const tiles = el('div', 'layout-tiles');
    const current = canvasEl().querySelectorAll(':scope > .ed-row')[pos[0]].querySelectorAll(':scope > .ed-section');
    const currentWidths = Array.from(current).map((n) => sectionInfo.get(n.dataset.section).width).join('-');
    for (const [key, l] of Object.entries(F.ROW_LAYOUTS)) {
      const b = el('button', 'layout-tile' + (l.widths.join('-') === currentWidths ? ' is-on' : ''));
      b.type = 'button';
      b.title = l.label;
      b.setAttribute('aria-label', l.label);
      b.innerHTML = `<span class="layout-tile__cols" style="grid-template-columns:${l.widths.map((w) => `${w}fr`).join(' ')}">${l.widths.map(() => '<span></span>').join('')}</span>`;
      b.addEventListener('click', () => setRowLayout(pos[0], key));
      tiles.appendChild(b);
    }
    layout.appendChild(tiles);
    layout.appendChild(el('p', 'insp-help', 'Put sections side by side, like a wide main part with a narrow column next to it. Blocks are never lost when you change this.'));
    body.appendChild(layout);

    const st = F.normalizeSectionStyle(info.style);
    body.appendChild(inspectorField({ key: 'bgColor', type: 'color', label: 'Background color', defaultLabel: 'None' }, st.bgColor, (v) => update({ bgColor: v })));
    body.appendChild(inspectorField({ key: 'bgImage', type: 'photo', label: 'Background photo', removable: true }, st.bgImage, (v) => { update({ bgImage: v, overlayOpacity: v && !st.overlayOpacity ? 30 : info.style.overlayOpacity }); }));
    body.appendChild(inspectorField({ key: 'overlayColor', type: 'color', label: 'Color over the photo', defaultLabel: 'None' }, st.overlayOpacity ? st.overlayColor : '', (v) => update(v ? { overlayColor: v, overlayOpacity: info.style.overlayOpacity || 40 } : { overlayOpacity: 0 })));
    body.appendChild(inspectorField({ key: 'overlayOpacity', type: 'range', label: 'Strength of the color', min: 0, max: 90, step: 5, unit: ' %' }, st.overlayOpacity, (v) => update({ overlayOpacity: v })));
    body.appendChild(inspectorField({ key: 'tone', type: 'select', label: 'Text color', options: [['dark', 'Dark text (for light backgrounds)'], ['light', 'Light text (for dark backgrounds or photos)']] }, st.tone, (v) => update({ tone: v })));

    const actions = el('div', 'insp-actions');
    const mk = (ic, label, fn) => { const b = el('button', 'btn btn--secondary btn--small'); b.type = 'button'; b.innerHTML = `${icon(ic)}<span>${label}</span>`; b.addEventListener('click', fn); actions.appendChild(b); };
    mk('arrow-up', 'Move up', () => moveRow(pos[0], -1));
    mk('arrow-down', 'Move down', () => moveRow(pos[0], +1));
    body.appendChild(actions);
    const remove = el('button', 'insp-remove');
    remove.type = 'button';
    remove.innerHTML = `${icon('trash-2')}<span>Remove this section</span>`;
    remove.addEventListener('click', () => removeSection(id));
    body.appendChild(remove);
  }

  function renderDocInspector(body) {
    const kind = currentKind();
    const file = store.current;
    const icons = { page: 'file', post: 'file-text', header: 'panel-top', footer: 'panel-bottom' };
    const titles = { page: 'Page settings', post: 'Blog post', header: 'Header', footer: 'Footer' };
    body.appendChild(inspectorHead(icons[kind], titles[kind]));

    if (kind === 'page') {
      const meta = pageMeta(file);
      body.appendChild(inspectorField({ key: 'title', type: 'text', label: 'Page name' }, meta.title, (v) => { if (v.trim()) renameDoc(file, v); }));
      body.appendChild(el('p', 'insp-note', `Web address ends in ${file}`));
      const where = el('div', 'insp-field');
      where.appendChild(el('span', 'insp-label', 'Where this page is listed'));
      where.appendChild(el('p', 'insp-value', meta.showInNavbar ? 'In the Main Menu (it has a link in your website menu)' : 'In Other Pages (no link in the menu)'));
      const move = el('button', 'btn btn--secondary btn--small', meta.showInNavbar ? 'Move to Other Pages' : 'Add to the Main Menu');
      move.type = 'button';
      move.addEventListener('click', () => movePage(file, !meta.showInNavbar));
      where.appendChild(move);
      body.appendChild(where);
      if (file === blogPageFile()) body.appendChild(el('p', 'insp-note', 'This is your blog page. Your posts are listed under it in the sidebar.'));
    } else if (kind === 'post') {
      const meta = postMeta(file);
      const update = (patch) => { Object.assign(meta, patch); renderRegionPreviews(); markDirty(); };
      body.appendChild(inspectorField({ key: 'title', type: 'text', label: 'Post title' }, meta.title, (v) => { if (v.trim()) { renameDoc(file, v); renderRegionPreviews(); } }));
      body.appendChild(inspectorField({ key: 'date', type: 'date', label: 'Date' }, meta.date, (v) => { if (/^\d{4}-\d{2}-\d{2}$/.test(v)) update({ date: v }); }));
      body.appendChild(inspectorField({ key: 'thumbnail', type: 'photo', label: 'Cover photo', removable: true }, meta.thumbnail, (v) => update({ thumbnail: v })));
      body.appendChild(inspectorField({ key: 'excerpt', type: 'textarea', label: 'Short summary', placeholder: 'Leave empty and Pebble uses the first words of your post', help: 'Shown under the post on your blog page.' },
        meta.excerptAuto ? '' : meta.excerpt, (v) => update({ excerpt: v.trim(), excerptAuto: !v.trim() })));
    } else if (kind === 'header') {
      body.appendChild(el('p', 'insp-note', 'The Header is the top of every page: your website name or logo, the menu, and anything else you add here. On phones the menu folds into a menu button.'));
      const hero = F.normalizeHero(store.config.header && store.config.header.hero);
      const section = el('div', 'insp-section');
      section.appendChild(el('h3', 'insp-section__title', 'Hero image'));
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
    const tip = el('p', 'insp-tip');
    tip.innerHTML = `${icon('mouse-pointer-2')}<span>${kind === 'page' || kind === 'post' ? 'Click a block or a section to change its settings here. Hover over the page and press + to add sections and blocks.' : 'Click a block to change its settings here.'}</span>`;
    body.appendChild(tip);
  }

  /* ========================================================================
     10. SITE SETTINGS
     ======================================================================== */

  function applyTheme() {
    $('#site-theme').textContent = F.globalCss(store.config.theme, store.baseCss, store.config.typography);
    $('#site-custom').textContent = store.customCss || '';
    const spacing = F.normalizeTheme(store.config.theme).blockSpacing;
    for (const g of allGrids()) if (g.getMargin() !== spacing / 2) g.margin(spacing / 2);
  }

  const COLOR_SWATCHES = {
    primary: ['#b85c38', '#2f6fdf', '#1f8a4c', '#8e44ad', '#c0392b', '#1d3557', '#d4a017', '#2d2a26'],
    secondary: ['#6b8b4f', '#e9a03b', '#3aa8a0', '#d76a85', '#7a8ca3', '#a0522d', '#5c6bc0', '#b5838d'],
  };
  const WEIGHT_NAMES = { 300: 'Light', 400: 'Normal', 500: 'Medium', 600: 'Semi-bold', 700: 'Bold', 800: 'Extra bold', 900: 'Black' };

  /** Font <option>s: the list, plus her own font when she added one. */
  function fontOptions(select, { inherit } = {}) {
    select.innerHTML = '';
    const ty = F.normalizeTypography(store.config.typography);
    if (inherit) {
      const site = F.normalizeTheme(store.config.theme).fontFamily;
      const siteLabel = site === 'custom' && ty.customFont ? ty.customFont.name : (F.FONTS[site] || F.FONTS.classic).label;
      const o = el('option', '', `Website font (${siteLabel})`);
      o.value = '';
      select.appendChild(o);
    }
    for (const [key, f] of Object.entries(F.FONTS)) {
      const o = el('option', '', f.label);
      o.value = key;
      select.appendChild(o);
    }
    if (ty.customFont) {
      const o = el('option', '', `${ty.customFont.name} (your own font)`);
      o.value = 'custom';
      select.appendChild(o);
    }
  }

  function renderSettings() {
    const t = F.normalizeTheme(store.config.theme);
    const ty = F.normalizeTypography(store.config.typography);
    $('#set-site-name').value = store.config.siteName;
    for (const which of ['primary', 'secondary']) {
      const value = t[`${which}Color`];
      $(`#set-${which}`).value = value;
      document.querySelectorAll(`[data-swatch="${which}"]`).forEach((b) => b.classList.toggle('is-on', b.dataset.color === value));
    }
    fontOptions($('#set-font'));
    $('#set-font').value = t.fontFamily === 'custom' && !ty.customFont ? 'classic' : t.fontFamily;
    const status = $('#custom-font-status');
    status.textContent = ty.customFont ? `Using “${ty.customFont.name}”` : '';
    status.className = 'custom-font__status' + (ty.customFont ? ' is-ok' : '');
    $('#btn-custom-font-clear').hidden = !ty.customFont;
    $('#set-radius').value = t.borderRadius;
    $('#out-radius').textContent = `${t.borderRadius} px`;
    $('#set-spacing').value = t.blockSpacing;
    $('#out-spacing').textContent = `${t.blockSpacing} px`;
    $('#set-custom-css').value = store.customCss || '';
    renderBranding();
    renderTextStyleSettings();
    renderIcons();
  }

  /** Branding: logo (in the header, also in the photo library) and favicon. */
  function renderBranding() {
    const b = F.normalizeBranding(store.config.branding);
    const box = $('#branding');
    box.innerHTML = '';
    const set = (patch) => {
      store.config.branding = F.normalizeBranding({ ...store.config.branding, ...patch });
      refreshLiveBlocks();
      renderRegionPreviews();
      markDirty();
      renderBranding();
    };
    const picker = (label, value, help, onPick, cls) => {
      const row = el('div', 'brand-pick');
      row.appendChild(el('span', 'settings-sublabel', label));
      const prev = el('div', `brand-pick__preview ${cls}`);
      if (value) { const img = el('img'); img.alt = ''; showImage(img, value); prev.appendChild(img); }
      else prev.innerHTML = icon('image');
      const actions = el('div', 'brand-pick__actions');
      const choose = el('button', 'btn btn--secondary btn--small');
      choose.type = 'button';
      choose.innerHTML = `${icon('upload')}<span>${value ? 'Replace' : 'Upload or choose'}</span>`;
      choose.addEventListener('click', () => openMediaLibrary({ current: value, onPick }));
      actions.appendChild(choose);
      if (value) {
        const rm = el('button', 'link-btn link-btn--inline', 'Remove');
        rm.type = 'button';
        rm.addEventListener('click', () => onPick(''));
        actions.appendChild(rm);
      }
      row.append(prev, actions);
      if (help) row.appendChild(el('p', 'settings-help', help));
      return row;
    };
    box.appendChild(picker('Logo', b.logo, 'Shown in your Header. It’s also kept in your photo library.', (p) => set({ logo: p }), 'brand-pick__preview--logo'));
    if (b.logo) {
      const mode = el('select', 'settings-input');
      mode.setAttribute('aria-label', 'How to show the logo');
      for (const [v, t] of [['logo-name', 'Logo and website name'], ['logo', 'Logo only']]) { const o = el('option', '', t); o.value = v; mode.appendChild(o); }
      mode.value = b.logoMode;
      mode.addEventListener('change', () => set({ logoMode: mode.value }));
      box.appendChild(mode);
      const rr = el('div', 'settings-rangerow');
      const range = el('input', 'settings-range');
      range.type = 'range'; range.min = 16; range.max = 140; range.value = b.logoHeight;
      range.setAttribute('aria-label', 'Logo size');
      const out = el('output', 'settings-out', `${b.logoHeight} px`);
      range.addEventListener('input', () => {
        out.textContent = `${range.value} px`;
        store.config.branding = F.normalizeBranding({ ...store.config.branding, logoHeight: range.value });
        refreshLiveBlocks();
        renderRegionPreviews();
        markDirty();
      });
      const lab = el('span', 'settings-sublabel', 'Logo size');
      rr.append(range, out);
      box.append(lab, rr);
    }
    box.appendChild(picker('Favicon', b.favicon, 'The little picture in the browser tab. A small square image works best.', (p) => set({ favicon: p }), 'brand-pick__preview--favicon'));
    renderIcons();
  }

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
      sample.style.fontSize = `${Math.min(s.size, 28)}px`;
      sample.style.fontWeight = s.weight;
      sample.style.fontFamily = `var(--text-${key}-font)`;
      sum.append(sample, el('span', 'text-style__meta', `${s.size}px · ${WEIGHT_NAMES[s.weight] || s.weight}`));
      d.appendChild(sum);

      const rows = el('div', 'text-style__fields');
      const field = (label, input) => { const r = el('label', 'text-style__field'); r.append(el('span', '', label), input); return r; };

      const name = el('input', 'settings-input');
      name.type = 'text';
      name.maxLength = 30;
      name.value = s.name;
      name.addEventListener('input', () => updateTextStyle(key, { name: name.value || def.name }));
      rows.appendChild(field('Name', name));

      const font = el('select', 'settings-input');
      fontOptions(font, { inherit: true });
      font.value = s.font || '';
      font.addEventListener('change', () => updateTextStyle(key, { font: font.value }));
      rows.appendChild(field('Font', font));

      const range = (min, max, step, val, unit, onIn) => {
        const r = el('input', 'settings-range');
        r.type = 'range'; r.min = min; r.max = max; r.step = step; r.value = val;
        const out = el('output', 'settings-out', `${val}${unit}`);
        r.addEventListener('input', () => { out.textContent = `${r.value}${unit}`; onIn(r.value); });
        const wrap = el('div', 'settings-rangerow');
        wrap.append(r, out);
        return wrap;
      };
      rows.appendChild(field('Size', range(10, 96, 1, s.size, ' px', (v) => updateTextStyle(key, { size: v }))));
      rows.appendChild(field('Line spacing', range(0.9, 2.4, 0.05, s.lineHeight, '', (v) => updateTextStyle(key, { lineHeight: v }))));

      const weight = el('select', 'settings-input');
      for (const w of F.WEIGHTS) { const o = el('option', '', WEIGHT_NAMES[w]); o.value = w; weight.appendChild(o); }
      weight.value = s.weight;
      weight.addEventListener('change', () => updateTextStyle(key, { weight: weight.value }));
      rows.appendChild(field('Boldness', weight));

      d.appendChild(rows);
      box.appendChild(d);
    }
  }

  function updateTextStyle(key, patch) {
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
      sample.style.fontSize = `${Math.min(s.size, 28)}px`;
      sample.style.fontWeight = s.weight;
      d.querySelector('.text-style__meta').textContent = `${s.size}px · ${WEIGHT_NAMES[s.weight] || s.weight}`;
    }
    renderStyleOptions();
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

    $('#set-font').addEventListener('change', (e) => { updateTheme({ fontFamily: e.target.value }); renderTextStyleSettings(); });

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
      const ty = F.normalizeTypography(store.config.typography);
      for (const s of Object.values(ty.styles)) if (s.font === 'custom') s.font = '';
      store.config.typography = F.normalizeTypography({ ...ty, customFont: null });
      if (store.config.theme.fontFamily === 'custom') store.config.theme = F.normalizeTheme({ ...store.config.theme, fontFamily: 'classic' });
      applyTheme();
      markDirty();
      renderSettings();
    });

    $('#set-radius').addEventListener('input', (e) => { $('#out-radius').textContent = `${e.target.value} px`; updateTheme({ borderRadius: e.target.value }); });
    $('#set-spacing').addEventListener('input', (e) => { $('#out-spacing').textContent = `${e.target.value} px`; updateTheme({ blockSpacing: e.target.value }); });
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
     11. LIBRARY — the hover "+" menu
       between rows   → Sections (layouts) and Blocks (a new section with it)
       inside a section, Header or Footer → Blocks for that place
     Tiles can also be dragged straight onto any section.
     ======================================================================== */

  let libraryTarget = null;   // { mode: 'gap', index } | { mode: 'section', id } | { mode: 'region' }

  function buildLibrary() {
    const sections = $('#lib-sections');
    for (const [key, l] of Object.entries(F.ROW_LAYOUTS)) {
      const b = el('button', 'lib-layout');
      b.type = 'button';
      b.dataset.layout = key;
      b.innerHTML = `<span class="layout-tile__cols" style="grid-template-columns:${l.widths.map((w) => `${w}fr`).join(' ')}">${l.widths.map(() => '<span></span>').join('')}</span><span class="lib-layout__label">${F.escapeHtml(l.label)}</span>`;
      sections.appendChild(b);
    }
    const groups = [
      ['Basics', ['text', 'image', 'card', 'button']],
      ['Blog', ['blog-feed']],
      ['Website parts', ['site-title', 'menu']],
      ['For website helpers', ['embed']],
    ];
    const blocks = $('#lib-blocks');
    for (const [title, types] of groups) {
      const group = el('section', 'lib-group' + (title === 'For website helpers' ? ' lib-group--advanced' : ''));
      group.appendChild(el('h3', 'lib-group__title', title));
      const list = el('div', 'lib-grid');
      for (const type of types) {
        const ed = EDITORS[type];
        const tile = el('div', 'lib-tile');
        tile.dataset.widgetType = type;
        tile.setAttribute('gs-w', ed.size.w);
        tile.setAttribute('gs-h', ed.size.h);
        tile.tabIndex = 0;
        tile.setAttribute('role', 'button');
        tile.innerHTML = `${icon(ed.icon, 'lib-tile__icon')}<span class="lib-tile__text"><strong></strong><small></small></span>`;
        tile.querySelector('strong').textContent = ed.label;
        tile.querySelector('small').textContent = ed.hint;
        list.appendChild(tile);
      }
      group.appendChild(list);
      blocks.appendChild(group);
    }
    renderIcons();
  }

  function setLibraryTab(tab) {
    $('#library').dataset.tab = tab;
    document.querySelectorAll('#library [data-lib-tab]').forEach((b) => { b.classList.toggle('is-active', b.dataset.libTab === tab); b.setAttribute('aria-selected', b.dataset.libTab === tab); });
  }

  function openLibrary(target, anchor) {
    libraryTarget = target;
    const lib = $('#library');
    lib.dataset.mode = target.mode;
    lib.querySelectorAll('.lib-tile').forEach((t) => { t.hidden = !allowedHere(t.dataset.widgetType); });
    lib.querySelectorAll('.lib-group').forEach((g) => { g.hidden = !g.querySelector('.lib-tile:not([hidden])'); });
    setLibraryTab(target.mode === 'gap' ? 'sections' : 'blocks');
    $('#lib-title').textContent = target.mode === 'gap' ? 'Add a section' : 'Add a block';
    lib.hidden = false;
    // Place it next to the + button, inside the window.
    const r = anchor.getBoundingClientRect();
    const w = lib.offsetWidth;
    const h = lib.offsetHeight;
    let top = r.bottom + 8;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 8);
    const left = Math.max(8, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - 8));
    lib.style.top = `${top}px`;
    lib.style.left = `${left}px`;
  }

  function closeLibrary() { $('#library').hidden = true; libraryTarget = null; }

  function afterAdd(item) {
    markDirty();
    closeLibrary();
    selectBlock(item);
  }

  function addFromLibrary(type) {
    const t = libraryTarget;
    if (!t) return;
    if (t.mode === 'gap') { closeLibrary(); addRow(t.index, 'one', type); markDirty(); return; }
    const g = t.mode === 'region' ? regionGrid : grids.get(t.id);
    const item = addBlock(type, null, null, { grid: g, focus: true });
    if (item) afterAdd(item);
  }

  function wireLibrary() {
    buildLibrary();
    const lib = $('#library');
    lib.addEventListener('click', (e) => {
      const tab = e.target.closest('[data-lib-tab]');
      if (tab) { setLibraryTab(tab.dataset.libTab); return; }
      if (e.target.closest('#lib-close')) { closeLibrary(); return; }
      const layout = e.target.closest('[data-layout]');
      if (layout && libraryTarget) { const idx = libraryTarget.index; closeLibrary(); addRow(idx, layout.dataset.layout); return; }
      const tile = e.target.closest('.lib-tile');
      if (tile) addFromLibrary(tile.dataset.widgetType);
    });
    lib.addEventListener('keydown', (e) => {
      const tile = e.target.closest('.lib-tile');
      if (tile && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); addFromLibrary(tile.dataset.widgetType); }
    });
    document.addEventListener('mousedown', (e) => {
      if (!lib.hidden && !e.target.closest('#library') && !e.target.closest('.ed-gap__add, .ed-section__add, .ed-section__empty')) closeLibrary();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !lib.hidden) closeLibrary(); });

    // The + buttons on the canvas
    canvasEl().addEventListener('click', (e) => {
      const gap = e.target.closest('.ed-gap__add');
      if (gap) { openLibrary({ mode: 'gap', index: parseInt(gap.dataset.gap, 10) }, gap); return; }
      const add = e.target.closest('[data-add-block]');
      if (add) {
        const id = add.dataset.addBlock;
        if (id !== 'region') setSelectedSection(id);
        openLibrary(id === 'region' ? { mode: 'region' } : { mode: 'section', id }, add);
      }
    });

    // Dragging a tile straight onto a section: the library steps aside.
    GridStack.setupDragIn('#library .lib-tile', { appendTo: 'body', helper: 'clone' });
    lib.addEventListener('mousedown', (e) => { if (e.target.closest('.lib-tile')) setTimeout(() => lib.classList.add('is-dragging'), 120); });
    // A block dragged into another section never gets "dragstop" from its old grid: tidy up on mouse-up.
    document.addEventListener('mouseup', () => {
      lib.classList.remove('is-dragging');
      setTimeout(() => { if (!document.querySelector('.ui-draggable-dragging, .ui-resizable-resizing')) $('#paper').classList.remove('is-arranging'); }, 50);
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
        ? `<span class="spinner spinner--small${key === 'save' ? ' spinner--dark' : ''}" aria-hidden="true"></span><span class="btn__label">${label}</span>`
        : btn.dataset.label;
    }
    renderIcons();
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
      showToast(store.draftAhead ? 'Your draft is already saved. Press “Publish” when you’re ready.' : 'Nothing new to save — your website is up to date.');
      return;
    }
    setBusy('save', 'Saving…');
    try {
      await commitChangesToDraft();
      showToast('Draft saved. Only you can see it until you press “Publish”.');
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
        showToast('Your website is already up to date.');
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
      if (meta) rows.push(`${icon(postMeta(path) ? 'file-text' : 'file')}<span>${F.escapeHtml(meta.title)}</span>${added.has(path) ? '<span class="tag">new</span>' : ''}`);
    }
    if (paths.some((p) => p === 'header.html' || p === 'footer.html')) rows.push(`${icon('panel-top')}<span>Header and footer</span>`);
    if (paths.some((p) => p === 'global.css' || p === 'theme.css')) rows.push(`${icon('palette')}<span>Your website’s look</span>`);
    const photos = files.filter((f) => f.path.startsWith(service.imageDir + '/') && f.status === 'added').length;
    if (photos) rows.push(`${icon('image')}<span>${photos} new photo${photos > 1 ? 's' : ''}</span>`);
    if (!rows.length) rows.push(`${icon('check')}<span>Your latest changes</span>`);
    $('#publish-list').innerHTML = rows.map((r) => `<li>${r}</li>`).join('');
    const link = $('#publish-url');
    link.href = service.siteUrl;
    link.textContent = service.siteUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
    $('#publish-demo-note').hidden = !service.isDemo;
    $('#publish-dialog').showModal();
    renderIcons();
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
      if (!images.length) status.textContent = 'No photos yet. Add your first one above.';
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
    btn.append(img, el('span', 'media-thumb__label', path === mediaState.current ? 'In use here' : name.replace(/^\d{8}-\d{6}-/, '').replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ')));
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
      showToast('Photo added.');
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
     14. PREVIEW — the real stitched page, sandboxed (no scripts)
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
      frame.srcdoc = F.stitchPage({ file, kind: doc.kind, rows: doc.rows || F.rowsFromBlocks(doc.blocks) },
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

  function wireMoreMenu() {
    const menu = $('#more-menu');
    $('#btn-more').addEventListener('click', (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; });
    document.addEventListener('click', (e) => { if (!e.target.closest('#more-menu') && !e.target.closest('#btn-more')) menu.hidden = true; });
    $('#btn-download').addEventListener('click', () => {
      menu.hidden = true;
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
      menu.hidden = true;
      if (!window.confirm('Reset the demo? This throws away everything you changed in this demo.')) return;
      service.resetDemo();
      try { localStorage.removeItem(draftKey()); localStorage.removeItem(lastDocKey()); } catch { /* ignore */ }
      location.reload();
    });
  }

  function wireUi() {
    wireToolbar();
    wireLibrary();
    wireSidebar();
    wireSettings();
    wirePreview();
    wireMediaLibrary();
    wireNewDocDialog();
    wireMoreMenu();

    $('#btn-save').addEventListener('click', saveDraft);
    $('#btn-publish').addEventListener('click', publishLive);
    document.querySelectorAll('dialog').forEach((d) => {
      d.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => d.close()));
    });

    // Selection: a block (click on it), a section (click its empty area or bar), or nothing.
    const canvas = canvasEl();
    canvas.addEventListener('mousedown', (e) => {
      if (e.target.closest('.ed-gap')) return;
      const item = e.target.closest('.grid-stack-item');
      if (item) { selectBlock(item); return; }
      const action = e.target.closest('[data-section-action]');
      const sec = e.target.closest('.ed-section');
      if (sec && !action && !e.target.closest('[data-add-block]')) selectSection(sec.dataset.section);
    }, true);
    canvas.addEventListener('focusin', (e) => {
      const item = e.target.closest('.grid-stack-item');
      if (item) selectBlock(item);
    });
    canvas.addEventListener('click', (e) => {
      const del = e.target.closest('.block-delete');
      if (del) { removeBlock(del.closest('.grid-stack-item')); return; }
      const act = e.target.closest('[data-section-action]');
      if (act) sectionAction(act.closest('.ed-section').dataset.section, act.dataset.sectionAction);
    });
    canvas.addEventListener('input', markDirty);
    $('#paper').addEventListener('mousedown', (e) => {
      if (!e.target.closest('#canvas') && !e.target.closest('.region-preview')) { selectBlock(null); selectSection(null); }
    });

    $('#preview-header').addEventListener('click', () => openDoc('header.html'));
    $('#preview-footer').addEventListener('click', () => openDoc('footer.html'));

    // Lucide: turn any new icon placeholders into SVGs.
    new MutationObserver((records) => {
      if (records.some((r) => Array.from(r.addedNodes).some((n) => n.nodeType === 1 && (n.matches('[data-lucide]') || n.querySelector('[data-lucide]'))))) renderIcons();
    }).observe(document.body, { childList: true, subtree: true });
    renderIcons();

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

  /** Local copies made by an older Pebble kept pages as {blocks}: give them rows. */
  function upgradeDocs(docs) {
    for (const d of Object.values(docs)) {
      if ((d.kind === 'page' || d.kind === 'post') && !d.rows) { d.rows = F.rowsFromBlocks(d.blocks || []); delete d.blocks; }
    }
    return docs;
  }

  async function boot() {
    service = createService();
    if (!service) { location.replace(PebbleAuth.appRoot); return; }
    wireUi();
    $('#btn-back').href = dashboardUrl();
    $('#more-back').href = dashboardUrl();
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
      store.docs = upgradeDocs(site.docs);
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
        showToast('Pebble has new features! Your website was updated to use them — press “Publish” once to put it online.');
      } else if (!hadLocal && lastPending.length && store.remote.has('site-config.json')) {
        // Only Pebble's own way of writing files changed: this site was made by an earlier Pebble.
        showToast('Pebble has been updated (sections, a menu button for phones, logo and more). Press “Publish” once to update your website.');
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
        docs[p.file] = { kind: 'page', rows: f && F.isPebblePage(f.content) ? F.parsePage(f.content, p.file).rows : F.rowsFromBlocks([]) };
      }
      for (const p of config.posts) {
        const f = store.remote.get(p.file);
        docs[p.file] = { kind: 'post', rows: f && F.isPebblePage(f.content) ? F.parsePage(f.content, p.file).rows : F.rowsFromBlocks([]) };
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
    get selectedSection() { return selectedSection; },
    grids,
    buildFiles,
    pendingChanges,
    openDoc,
    createPage,
    createPost,
    renameDoc,
    movePage,
    selectBlock,
    selectSection,
    addRow,
    setRowLayout,
    saveDraft,
    publishLive,
    readCanvas,
    serializeToStaticHTML() { const files = buildFiles(); return files[store.current] || files[`${currentKind()}.html`]; },
    EDITORS,
    CONFIG,
  };

  boot();
})();
