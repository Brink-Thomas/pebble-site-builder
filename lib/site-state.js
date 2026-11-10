/* ==========================================================================
   PebbleState — the website as ONE JSON tree (the single source of truth).

   The editor keeps this object in memory and renders everything from it.
   It is saved in the user's repository as site.json; lib/compiler.js turns
   it into the static HTML and CSS that visitors get.

   site.json
   {
     generator: "Pebble", version: 5,
     settings: { siteName, theme, typography, branding, hero, customCss },
     blogPage: "blog.html",                       // the page listing the posts ('' = none)
     pages:  [{ id, file, title, showInNavbar, sections: [...] }],
     posts:  [{ id, file, title, date, thumbnail, excerpt, excerptAuto, sections: [...] }],
     header: { sections: [...] },                 // the top of every page
     footer: { sections: [...] },                 // the bottom of every page
   }

   section = { id, style: { bgColor, bgImage, overlayColor, overlayOpacity, tone, valign },
               columns: [column, …] }             // 1–4 columns side by side
   column  = { id, width, style: { bgColor }, blocks: [block, …] }   // widths add up to 100
   block   = { id, type, data }                   // blocks stack top to bottom

   A "doc" is a page, a post, the header or the footer, addressed by a key:
   the file name ("about.html", "blog/x.html") or "header" / "footer".

   The ACTIONS below change a site in place (the editor's store takes a
   snapshot first, for undo). They know nothing about the DOM.
   ========================================================================== */

(function () {
  'use strict';

  const D = window.PebbleDesign;
  const VERSION = 5;

  const PAGE_FILE_RE = /^[a-z0-9][a-z0-9-]{0,60}\.html$/;
  const POST_FILE_RE = /^blog\/[a-z0-9][a-z0-9-]{0,60}\.html$/;
  const RESERVED_FILES = ['header.html', 'footer.html'];

  /** Short unique ids, e.g. "b_k3x9q2". Only used inside site.json and the editor. */
  function uid(prefix) {
    const rnd = (crypto.getRandomValues ? crypto.getRandomValues(new Uint32Array(2)) : [Math.random() * 2 ** 32, Date.now()]);
    return `${prefix}_${Array.from(rnd, (n) => (n >>> 0).toString(36)).join('').slice(0, 8)}`;
  }

  /* ========================================================================
     BLOCK TYPES — their data and defaults. How they look is in compiler.js;
     how they're edited is in editor/blocks.js.
     ======================================================================== */

  const CARD_BORDERS = ['accent', 'outline', 'shadow', 'none'];
  /** Photo shapes: 'auto' = the photo's own shape; otherwise it's cropped to fit. */
  const RATIOS = ['auto', '16/9', '4/3', '1/1', '3/4'];

  const BLOCK_TYPES = {
    text:        { label: 'Text',          defaults: () => ({ html: '' }) },
    image:       { label: 'Photo',         defaults: () => ({ src: '', caption: '', alt: '', href: '', radius: '', ratio: 'auto' }) },
    card:        { label: 'Card',          defaults: () => ({ src: '', title: '', html: '', href: '', linkLabel: 'Read more', bg: '', textColor: '', border: 'accent' }) },
    button:      { label: 'Button',        defaults: () => ({ label: 'Click here', href: '', style: 'primary', align: 'left' }) },
    'blog-feed': { label: 'Blog posts',    defaults: () => ({ limit: 6 }) },
    embed:       { label: 'Embed code',    defaults: () => ({ code: '' }) },
    'site-title':{ label: 'Website name',  defaults: () => ({}), regions: ['header', 'footer'] },
    menu:        { label: 'Site menu',     defaults: () => ({ align: 'right' }), regions: ['header', 'footer'] },
  };

  const radiusOf = (v) => {
    if (v === '' || v == null) return '';
    const n = D.toInt(v, NaN);
    return Number.isFinite(n) ? D.clamp(n, 0, 40) : '';
  };
  const oneOf = (v, list, fallback) => (list.includes(v) ? v : fallback);
  const str = (v, max) => String(v ?? '').slice(0, max);

  /** Clean one block's data, so only known, safe values are kept. */
  function normalizeBlockData(type, data = {}) {
    const d = { ...BLOCK_TYPES[type].defaults(), ...data };
    switch (type) {
      case 'text': return { html: D.sanitizeRichText(d.html) };
      case 'image': return { src: D.safeUrl(d.src, 'image'), caption: str(d.caption, 200).trim(), alt: str(d.alt, 300).trim(), href: D.safeUrl(d.href, 'link'), radius: radiusOf(d.radius), ratio: oneOf(d.ratio, RATIOS, 'auto') };
      case 'card': return {
        src: D.safeUrl(d.src, 'image'), title: str(d.title, 140), html: D.sanitizeRichText(d.html), href: D.safeUrl(d.href, 'link'),
        linkLabel: str(d.linkLabel, 60) || 'Read more', bg: D.isHex(d.bg) ? d.bg.toLowerCase() : '',
        textColor: D.isHex(d.textColor) ? d.textColor.toLowerCase() : '', border: oneOf(d.border, CARD_BORDERS, 'accent'),
      };
      case 'button': return { label: str(d.label, 80), href: D.safeUrl(d.href, 'link'), style: oneOf(d.style, ['primary', 'accent', 'secondary'], 'primary'), align: oneOf(d.align, ['left', 'center', 'right'], 'left') };
      case 'blog-feed': { const n = D.toInt(d.limit, 6); return { limit: [3, 6, 12, 0].includes(n) ? n : 6 }; }
      case 'embed': return { code: str(d.code, 20000) };
      case 'site-title': return {};
      case 'menu': return { align: oneOf(d.align, ['left', 'center', 'right'], 'right') };
      default: return {};
    }
  }

  function newBlock(type, data) {
    return { id: uid('b'), type, data: normalizeBlockData(type, data) };
  }

  /* ========================================================================
     SECTIONS & COLUMNS
     ======================================================================== */

  /** Column layouts she can pick (widths in %). */
  const LAYOUTS = {
    one:   { label: 'One column',            widths: [100] },
    half:  { label: 'Two equal columns',     widths: [50, 50] },
    main:  { label: 'Wide + narrow',         widths: [70, 30] },
    side:  { label: 'Narrow + wide',         widths: [30, 70] },
    three: { label: 'Three equal columns',   widths: [33, 34, 33] },
  };
  const MAX_COLUMNS = 4;

  function normalizeSectionStyle(st = {}) {
    const bgImage = D.safeUrl(st.bgImage, 'image');
    return {
      bgColor: D.isHex(st.bgColor) ? st.bgColor.toLowerCase() : '',
      bgImage,
      overlayColor: D.isHex(st.overlayColor) ? st.overlayColor.toLowerCase() : '#000000',
      overlayOpacity: D.clamp(D.toInt(st.overlayOpacity, bgImage ? 30 : 0), 0, 90),
      tone: st.tone === 'light' ? 'light' : 'dark',          // light = white text, for dark backgrounds
      valign: oneOf(st.valign, ['top', 'center', 'bottom'], 'top'),
    };
  }

  function newColumn(width = 100, blocks = []) {
    return { id: uid('c'), width, style: { bgColor: '' }, blocks };
  }

  function newSection(layoutKey = 'one', style = {}) {
    const widths = (LAYOUTS[layoutKey] || LAYOUTS.one).widths;
    return { id: uid('s'), style: normalizeSectionStyle(style), columns: widths.map((w) => newColumn(w)) };
  }

  /** Widths that are whole numbers from 10 to 100 and add up to exactly 100. */
  function fixWidths(columns) {
    if (!columns.length) return columns;
    let ws = columns.map((c) => Math.max(1, D.toNum(c.width, 100 / columns.length)));
    const total = ws.reduce((a, b) => a + b, 0);
    ws = ws.map((w) => Math.max(10, Math.round((w / total) * 100)));
    ws[ws.length - 1] += 100 - ws.reduce((a, b) => a + b, 0);
    columns.forEach((c, i) => { c.width = ws[i]; });
    return columns;
  }

  function normalizeSections(sections, docKind) {
    const out = [];
    for (const s of Array.isArray(sections) ? sections : []) {
      if (!s) continue;
      const columns = (Array.isArray(s.columns) ? s.columns : []).slice(0, MAX_COLUMNS).map((c) => ({
        id: typeof c.id === 'string' && c.id ? c.id : uid('c'),
        width: c.width,
        style: { bgColor: D.isHex(c.style && c.style.bgColor) ? c.style.bgColor.toLowerCase() : '' },
        blocks: (Array.isArray(c.blocks) ? c.blocks : [])
          .filter((b) => b && BLOCK_TYPES[b.type] && (!BLOCK_TYPES[b.type].regions || BLOCK_TYPES[b.type].regions.includes(docKind)))
          .map((b) => ({ id: typeof b.id === 'string' && b.id ? b.id : uid('b'), type: b.type, data: normalizeBlockData(b.type, b.data) })),
      }));
      if (!columns.length) columns.push(newColumn());
      out.push({ id: typeof s.id === 'string' && s.id ? s.id : uid('s'), style: normalizeSectionStyle(s.style), columns: fixWidths(columns) });
    }
    return out;
  }

  /* ========================================================================
     THE WHOLE SITE
     ======================================================================== */

  function normalizeSettings(s = {}) {
    return {
      siteName: str(s.siteName || 'My website', 80).trim() || 'My website',
      theme: D.normalizeTheme(s.theme),
      typography: D.normalizeTypography(s.typography),
      branding: D.normalizeBranding(s.branding),
      hero: D.normalizeHero(s.hero),
      customCss: str(s.customCss, 200000),
    };
  }

  /**
   * Accept a site read from anywhere (site.json, a copy kept in the browser,
   * an import), dropping anything malformed. Key order is fixed, so the same
   * site always gives the same site.json text.
   */
  function normalizeSite(raw = {}) {
    const seen = new Set();
    const pages = (Array.isArray(raw.pages) ? raw.pages : [])
      .filter((p) => p && PAGE_FILE_RE.test(p.file) && !RESERVED_FILES.includes(p.file) && !seen.has(p.file) && seen.add(p.file))
      .map((p) => ({
        id: typeof p.id === 'string' && p.id ? p.id : uid('p'),
        file: p.file,
        title: str(p.title || D.nameFromFile(p.file), 80),
        showInNavbar: p.showInNavbar !== false,
        sections: normalizeSections(p.sections, 'page'),
      }));
    if (!pages.some((p) => p.file === 'index.html')) {
      pages.unshift({ id: uid('p'), file: 'index.html', title: 'Home', showInNavbar: true, sections: [newSection()] });
    }
    const posts = (Array.isArray(raw.posts) ? raw.posts : [])
      .filter((p) => p && POST_FILE_RE.test(p.file) && !seen.has(p.file) && seen.add(p.file))
      .map((p) => ({
        id: typeof p.id === 'string' && p.id ? p.id : uid('p'),
        file: p.file,
        title: str(p.title || D.nameFromFile(p.file), 140),
        date: D.isDate(p.date) ? p.date : D.todayIso(),
        thumbnail: D.safeUrl(p.thumbnail, 'image'),
        excerpt: str(p.excerpt, 400),
        excerptAuto: p.excerptAuto !== false,
        sections: normalizeSections(p.sections, 'post'),
      }));
    const region = (r, kind, fallback) => {
      const sections = normalizeSections(r && r.sections, kind);
      return { sections: sections.length ? sections : fallback() };
    };
    const settings = normalizeSettings(raw.settings);
    return {
      generator: 'Pebble',
      version: VERSION,
      settings,
      blogPage: pages.some((p) => p.file === raw.blogPage) ? raw.blogPage : '',
      pages,
      posts,
      header: region(raw.header, 'header', defaultHeader),
      footer: region(raw.footer, 'footer', () => defaultFooter(settings.siteName)),
    };
  }

  function defaultHeader() {
    const s = newSection('main', { valign: 'center' });
    s.columns[0].width = 40;
    s.columns[1].width = 60;
    s.columns[0].blocks.push(newBlock('site-title'));
    s.columns[1].blocks.push(newBlock('menu', { align: 'right' }));
    return [s];
  }

  function defaultFooter(siteName) {
    const s = newSection();
    s.columns[0].blocks.push(newBlock('text', { html: `<p>© ${new Date().getFullYear()} ${D.escapeHtml(siteName)}</p>` }));
    return [s];
  }

  /** A brand-new website: a welcoming homepage, header and footer. */
  function createSite(siteName) {
    const name = String(siteName || 'My website').trim() || 'My website';
    const home = newSection();
    home.columns[0].blocks.push(newBlock('text', { html: `<h2>${D.escapeHtml(name)}</h2><p>Welcome! This website is brand new — come back soon.</p>` }));
    return normalizeSite({
      settings: { siteName: name },
      pages: [{ file: 'index.html', title: 'Home', showInNavbar: true, sections: [home] }],
    });
  }

  /* ========================================================================
     LOOKUPS
     ======================================================================== */

  const pageOf = (site, file) => site.pages.find((p) => p.file === file) || null;
  const postOf = (site, file) => site.posts.find((p) => p.file === file) || null;

  /** The doc for a key: a page, a post, or the header / footer region. */
  function getDoc(site, key) {
    if (key === 'header') return site.header;
    if (key === 'footer') return site.footer;
    return pageOf(site, key) || postOf(site, key);
  }
  function docKind(site, key) {
    if (key === 'header' || key === 'footer') return key;
    return pageOf(site, key) ? 'page' : postOf(site, key) ? 'post' : null;
  }

  /**
   * Find a section, column or block by id inside a doc.
   * @returns {{kind, node, list, index, section, column}|null}
   */
  function find(site, key, id) {
    const doc = getDoc(site, key);
    if (!doc || !id) return null;
    for (let si = 0; si < doc.sections.length; si++) {
      const section = doc.sections[si];
      if (section.id === id) return { kind: 'section', node: section, list: doc.sections, index: si, section };
      for (let ci = 0; ci < section.columns.length; ci++) {
        const column = section.columns[ci];
        if (column.id === id) return { kind: 'column', node: column, list: section.columns, index: ci, section, column };
        const bi = column.blocks.findIndex((b) => b.id === id);
        if (bi >= 0) return { kind: 'block', node: column.blocks[bi], list: column.blocks, index: bi, section, column };
      }
    }
    return null;
  }

  /** Every block of a doc, in reading order. */
  function blocksOf(doc) {
    const out = [];
    for (const s of doc.sections) for (const c of s.columns) out.push(...c.blocks);
    return out;
  }

  /** The page that lists the posts: the chosen one, else a page with a Blog posts block. */
  function blogPageFile(site) {
    if (site.blogPage && pageOf(site, site.blogPage)) return site.blogPage;
    const feeds = site.pages.filter((p) => blocksOf(p).some((b) => b.type === 'blog-feed'));
    const best = feeds.find((p) => /^blog/.test(p.file)) || feeds.find((p) => blocksOf(p).some((b) => b.type === 'blog-feed' && !b.data.limit)) || feeds[0];
    return best ? best.file : '';
  }

  const sortedPosts = (site) => site.posts.slice().sort((a, b) => b.date.localeCompare(a.date) || a.title.localeCompare(b.title));

  /** A free file name for a new page or post. */
  function uniqueFile(site, base, folder = '') {
    const taken = (f) => pageOf(site, f) || postOf(site, f) || RESERVED_FILES.includes(f) || f === 'index.html';
    let file = `${folder}${base}.html`;
    for (let i = 2; taken(file); i++) file = `${folder}${base}-${i}.html`;
    return file;
  }

  /* ========================================================================
     ACTIONS — each one changes the site in place and returns something
     useful (the new node, or null when nothing changed).
     ======================================================================== */

  /** Insert a new section at `index` (0 = top). Optionally with a first block. */
  function addSection(site, key, index, layoutKey = 'one', firstBlockType = null) {
    const doc = getDoc(site, key);
    if (!doc) return null;
    const section = newSection(layoutKey);
    if (firstBlockType && BLOCK_TYPES[firstBlockType]) section.columns[0].blocks.push(newBlock(firstBlockType));
    const at = D.clamp(D.toInt(index, doc.sections.length), 0, doc.sections.length);
    doc.sections.splice(at, 0, section);
    return section;
  }

  /** Add a block to a column at `index` (default: the end). */
  function addBlock(site, key, columnId, type, index, data) {
    const hit = find(site, key, columnId);
    if (!hit || hit.kind !== 'column' || !BLOCK_TYPES[type]) return null;
    const block = newBlock(type, data);
    const list = hit.node.blocks;
    list.splice(D.clamp(D.toInt(index, list.length), 0, list.length), 0, block);
    return block;
  }

  /**
   * Remove a block or section. A section that's removed takes its blocks
   * with it; the last section of a doc is replaced by an empty one, so
   * there's always somewhere to add things.
   */
  function deleteNode(site, key, id) {
    const hit = find(site, key, id);
    if (!hit) return null;
    if (hit.kind === 'column') return removeColumn(site, key, id);
    hit.list.splice(hit.index, 1);
    const doc = getDoc(site, key);
    if (hit.kind === 'section' && !doc.sections.length) doc.sections.push(newSection());
    return hit;
  }

  /** Move a section up or down, or to an index. */
  function moveSection(site, key, id, toIndex) {
    const doc = getDoc(site, key);
    const from = doc ? doc.sections.findIndex((s) => s.id === id) : -1;
    if (from < 0) return null;
    const [s] = doc.sections.splice(from, 1);
    const at = D.clamp(toIndex > from ? toIndex - 1 : toIndex, 0, doc.sections.length);
    doc.sections.splice(at, 0, s);
    return at === from ? null : s;
  }

  /**
   * Move a block into a column, before position `toIndex` of that column
   * (as it was before the move). Works within a column and across columns
   * and sections.
   */
  function moveBlock(site, key, blockId, toColumnId, toIndex) {
    const hit = find(site, key, blockId);
    const target = find(site, key, toColumnId);
    if (!hit || hit.kind !== 'block' || !target || target.kind !== 'column') return null;
    let at = D.clamp(D.toInt(toIndex, target.node.blocks.length), 0, target.node.blocks.length);
    if (hit.list === target.node.blocks) {
      if (at === hit.index || at === hit.index + 1) return null;  // dropped where it already is
      if (at > hit.index) at -= 1;
    }
    const [block] = hit.list.splice(hit.index, 1);
    target.node.blocks.splice(at, 0, block);
    return block;
  }

  /**
   * Give a section a column layout. Blocks are never lost: when there are
   * fewer columns than before, the extra columns' blocks move into the last
   * column that stays.
   */
  function setLayout(site, key, sectionId, layoutKey) {
    const hit = find(site, key, sectionId);
    const layout = LAYOUTS[layoutKey];
    if (!hit || hit.kind !== 'section' || !layout) return null;
    const cols = hit.node.columns;
    while (cols.length > layout.widths.length) {
      const gone = cols.pop();
      cols[cols.length - 1].blocks.push(...gone.blocks);
    }
    while (cols.length < layout.widths.length) cols.push(newColumn());
    cols.forEach((c, i) => { c.width = layout.widths[i]; });
    return hit.node;
  }

  /** Add a column to the right of a section (up to four), sharing the width evenly. */
  function addColumn(site, key, sectionId) {
    const hit = find(site, key, sectionId);
    if (!hit || hit.kind !== 'section' || hit.node.columns.length >= MAX_COLUMNS) return null;
    const cols = hit.node.columns;
    const col = newColumn();
    cols.push(col);
    cols.forEach((c) => { c.width = 100 / cols.length; });
    fixWidths(cols);
    return col;
  }

  function removeColumn(site, key, columnId) {
    const hit = find(site, key, columnId);
    if (!hit || hit.kind !== 'column') return null;
    const cols = hit.section.columns;
    if (cols.length === 1) return null;
    const [gone] = cols.splice(hit.index, 1);
    cols[Math.max(0, hit.index - 1)].blocks.push(...gone.blocks);
    fixWidths(cols);
    return hit;
  }

  /** Make a copy of a block or section right after it (with new ids). */
  function duplicate(site, key, id) {
    const hit = find(site, key, id);
    if (!hit || hit.kind === 'column') return null;
    const copy = JSON.parse(JSON.stringify(hit.node));
    const reId = (n) => {
      if (n.columns) { n.id = uid('s'); n.columns.forEach((c) => { c.id = uid('c'); c.blocks.forEach((b) => { b.id = uid('b'); }); }); }
      else n.id = uid('b');
    };
    reId(copy);
    hit.list.splice(hit.index + 1, 0, copy);
    return copy;
  }

  function updateBlock(site, key, id, patch) {
    const hit = find(site, key, id);
    if (!hit || hit.kind !== 'block') return null;
    hit.node.data = normalizeBlockData(hit.node.type, { ...hit.node.data, ...patch });
    return hit.node;
  }

  function updateSectionStyle(site, key, id, patch) {
    const hit = find(site, key, id);
    if (!hit || hit.kind !== 'section') return null;
    hit.node.style = normalizeSectionStyle({ ...hit.node.style, ...patch });
    return hit.node;
  }

  /* ---------------- pages & posts ---------------- */

  function addPage(site, title, inMenu = true) {
    const name = String(title || '').trim().slice(0, 80);
    if (!name) return null;
    const page = { id: uid('p'), file: uniqueFile(site, D.slugify(name, 'page')), title: name, showInNavbar: !!inMenu, sections: [newSection()] };
    // Put it at the end of its list (Main Menu or Other Pages).
    const last = site.pages.map((p) => p.showInNavbar === page.showInNavbar).lastIndexOf(true);
    site.pages.splice(last + 1, 0, page);
    return page;
  }

  /** The blog page, made if there's none yet. */
  function ensureBlogPage(site) {
    const existing = blogPageFile(site);
    if (existing) { site.blogPage = existing; return pageOf(site, existing); }
    const page = { id: uid('p'), file: uniqueFile(site, 'blog'), title: 'Blog', showInNavbar: true, sections: [newSection()] };
    page.sections[0].columns[0].blocks.push(newBlock('text', { html: '<h2>Blog</h2><p>My latest stories.</p>' }), newBlock('blog-feed', { limit: 0 }));
    const last = site.pages.map((p) => p.showInNavbar).lastIndexOf(true);
    site.pages.splice(last + 1, 0, page);
    site.blogPage = page.file;
    return page;
  }

  function addPost(site, title) {
    const name = String(title || '').trim().slice(0, 140);
    if (!name) return null;
    ensureBlogPage(site);
    const section = newSection();
    section.columns[0].blocks.push(newBlock('text'));
    const post = { id: uid('p'), file: uniqueFile(site, D.slugify(name, 'post'), 'blog/'), title: name, date: D.todayIso(), thumbnail: '', excerpt: '', excerptAuto: true, sections: [section] };
    site.posts.push(post);
    return post;
  }

  function renameDoc(site, file, title) {
    const meta = pageOf(site, file) || postOf(site, file);
    const name = String(title || '').trim();
    if (!meta || !name || name === meta.title) return null;
    meta.title = name.slice(0, postOf(site, file) ? 140 : 80);
    return meta;
  }

  /** Move a page into the Main Menu or Other Pages, before another page (or at the end). */
  function movePage(site, file, inMenu, beforeFile) {
    const idx = site.pages.findIndex((p) => p.file === file);
    if (idx < 0) return null;
    const [p] = site.pages.splice(idx, 1);
    p.showInNavbar = !!inMenu;
    let at = beforeFile && beforeFile !== file ? site.pages.findIndex((q) => q.file === beforeFile) : -1;
    if (at < 0) at = site.pages.map((q) => q.showInNavbar === p.showInNavbar).lastIndexOf(true) + 1;
    site.pages.splice(at, 0, p);
    return p;
  }

  /* ========================================================================
     IMPORT — websites made by Pebble v2–v4 (stitched HTML + site-config.json)
     become a site.json tree. Old blocks had grid positions (x, y, w, h);
     blocks that sat side by side become columns, the rest stack in order.
     ======================================================================== */

  /** One old grid of positioned blocks → sections with columns. */
  function sectionsFromGrid(blocks, style, kind) {
    const usable = blocks.filter((b) => BLOCK_TYPES[b.type] && (!BLOCK_TYPES[b.type].regions || BLOCK_TYPES[b.type].regions.includes(kind)));
    const sorted = usable.slice().sort((a, b) => (a.y - b.y) || (a.x - b.x));
    // Horizontal bands: blocks whose rows overlap.
    const bands = [];
    for (const b of sorted) {
      const band = bands[bands.length - 1];
      if (band && b.y < band.bottom) { band.items.push(b); band.bottom = Math.max(band.bottom, b.y + b.h); }
      else bands.push({ items: [b], bottom: b.y + b.h });
    }
    const sections = [];
    let stack = null;   // consecutive one-column bands share a section
    for (const band of bands) {
      // Columns inside a band: blocks whose x ranges overlap.
      const cols = [];
      for (const b of band.items.slice().sort((a, c) => a.x - c.x || a.y - c.y)) {
        const col = cols.find((c) => b.x < c.right && b.x + b.w > c.left);
        if (col) { col.items.push(b); col.left = Math.min(col.left, b.x); col.right = Math.max(col.right, b.x + b.w); }
        else cols.push({ items: [b], left: b.x, right: b.x + b.w });
      }
      const toBlocks = (items) => items.slice().sort((a, c) => a.y - c.y || a.x - c.x).map((b) => newBlock(b.type, b.data));
      if (cols.length === 1) {
        if (!stack) { stack = { id: uid('s'), style: normalizeSectionStyle(style), columns: [newColumn(100)] }; sections.push(stack); }
        stack.columns[0].blocks.push(...toBlocks(cols[0].items));
      } else {
        stack = null;
        const section = { id: uid('s'), style: normalizeSectionStyle({ ...style, valign: kind === 'header' || kind === 'footer' ? 'center' : 'top' }), columns: [] };
        cols.sort((a, c) => a.left - c.left).slice(0, MAX_COLUMNS).forEach((c) => section.columns.push(newColumn(c.right - c.left, toBlocks(c.items))));
        fixWidths(section.columns);
        sections.push(section);
      }
    }
    if (!sections.length) sections.push({ id: uid('s'), style: normalizeSectionStyle(style), columns: [newColumn()] });
    return sections;
  }

  /** Old rows (1–3 side-by-side sections, each a grid) → new sections. */
  function sectionsFromRows(rows, kind) {
    const out = [];
    for (const row of rows || []) {
      if (row.sections.length === 1) {
        out.push(...sectionsFromGrid(row.sections[0].blocks, row.sections[0].style, kind));
        continue;
      }
      // Side-by-side sections become the columns of one section.
      const section = { id: uid('s'), style: normalizeSectionStyle({}), columns: [] };
      for (const old of row.sections.slice(0, MAX_COLUMNS)) {
        const col = newColumn(old.width, sectionsFromGrid(old.blocks, {}, kind).flatMap((s) => s.columns.flatMap((c) => c.blocks)));
        col.style.bgColor = D.isHex(old.style && old.style.bgColor) ? old.style.bgColor.toLowerCase() : '';
        section.columns.push(col);
      }
      fixWidths(section.columns);
      out.push(section);
    }
    return out.length ? out : [newSection()];
  }

  /**
   * @param {Object<string,string>} files  path → text, as read from the repository
   * @returns {object|null} a normalized site, or null if these aren't Pebble files
   */
  function importLegacy(files) {
    const L = window.PebbleLegacy;
    if (!L) return null;
    let config;
    let header = null;
    let footer = null;
    if (files['site-config.json']) {
      try { config = L.normalizeConfig(JSON.parse(files['site-config.json'])); } catch { config = L.normalizeConfig({}); }
      if (files['header.html']) header = L.partialFromHtml(files['header.html'], 'header');
      if (files['footer.html']) footer = L.partialFromHtml(files['footer.html'], 'footer');
    } else {
      // v1: pages only, each with its own header.
      const pages = {};
      for (const [path, text] of Object.entries(files)) if (PAGE_FILE_RE.test(path) && L.isPebblePage(text)) pages[path] = text;
      if (!Object.keys(pages).length) return null;
      config = L.upgradeLegacySite(pages).config;
    }
    const readRows = (file) => (files[file] && L.isPebblePage(files[file]) ? L.parsePage(files[file], file).rows : []);
    return normalizeSite({
      settings: {
        siteName: config.siteName,
        theme: config.theme,
        typography: config.typography,
        branding: config.branding,
        hero: config.header && config.header.hero,
        customCss: config.customCss ? files['theme.css'] || '' : '',
      },
      blogPage: config.blogPage,
      pages: config.pages.map((p) => ({ ...p, sections: sectionsFromRows(readRows(p.file), 'page') })),
      posts: config.posts.map((p) => ({ ...p, sections: sectionsFromRows(readRows(p.file), 'post') })),
      header: header ? { sections: sectionsFromGrid(header, {}, 'header') } : null,
      footer: footer ? { sections: sectionsFromGrid(footer, {}, 'footer') } : null,
    });
  }

  /**
   * Unsaved changes an older Pebble (v4) kept in the browser:
   * { config, docs: { file: { rows } | { blocks } }, customCss } → a site.
   */
  function importLegacyDraft(d) {
    const L = window.PebbleLegacy;
    if (!L || !d || !d.config || !d.docs) return null;
    const config = L.normalizeConfig(d.config);
    const rowsOf = (doc) => (doc && doc.rows ? doc.rows : L.rowsFromBlocks((doc && doc.blocks) || []));
    const docs = d.docs;
    return normalizeSite({
      settings: {
        siteName: config.siteName, theme: config.theme, typography: config.typography, branding: config.branding,
        hero: config.header && config.header.hero, customCss: String(d.customCss || ''),
      },
      blogPage: config.blogPage,
      pages: config.pages.map((p) => ({ ...p, sections: sectionsFromRows(rowsOf(docs[p.file]), 'page') })),
      posts: config.posts.map((p) => ({ ...p, sections: sectionsFromRows(rowsOf(docs[p.file]), 'post') })),
      header: docs['header.html'] ? { sections: sectionsFromGrid(docs['header.html'].blocks || [], {}, 'header') } : null,
      footer: docs['footer.html'] ? { sections: sectionsFromGrid(docs['footer.html'].blocks || [], {}, 'footer') } : null,
    });
  }

  window.PebbleState = {
    VERSION, BLOCK_TYPES, LAYOUTS, MAX_COLUMNS, CARD_BORDERS, RATIOS, PAGE_FILE_RE, POST_FILE_RE,
    uid, newBlock, newSection, newColumn, normalizeBlockData, normalizeSettings, normalizeSectionStyle, normalizeSections, normalizeSite, fixWidths,
    createSite, defaultHeader, defaultFooter,
    getDoc, docKind, find, blocksOf, pageOf, postOf, blogPageFile, sortedPosts, uniqueFile,
    addSection, addBlock, deleteNode, moveSection, moveBlock, setLayout, addColumn, removeColumn, duplicate,
    updateBlock, updateSectionStyle, addPage, addPost, ensureBlogPage, renameDoc, movePage,
    importLegacy, importLegacyDraft,
  };
})();
