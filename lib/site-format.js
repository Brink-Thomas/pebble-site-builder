/* ==========================================================================
   PebbleFormat — what a Pebble website IS, as files. Shared by the editor
   and the start page (which uses it to create new websites).

   A website (in the user's GitHub repository):

     site-config.json   site name, pages (+ "show in menu"), blog posts
                        (title, date, photo, summary), design settings
     global.css         :root { --primary-color … } + Pebble's base styles
     theme.css          optional extra CSS from a helper (Site Settings → Advanced)
     header.html        the top of every page    (a "partial": blocks only)
     footer.html        the bottom of every page (a "partial": blocks only)
     index.html …       pages            ┐ each one is STITCHED:
     blog/*.html        blog posts       ┘ <head> + header + page blocks + footer
     assets/images/*    photos

   "Client-side static generation": there is no server. Whenever the editor
   saves, buildSiteFiles() renders every file from plain data and only the
   files whose text changed are committed. So editing the footer, renaming a
   page, hiding it from the menu or writing a new blog post automatically
   updates every page that shows it.

   The data ("site"):
     { config:    { siteName, pages: [{file, title, showInNavbar}],
                    posts: [{file, title, date, thumbnail, excerpt, excerptAuto}],
                    theme: {primaryColor, secondaryColor, fontFamily, borderRadius, blockSpacing},
                    customCss },
       docs:      { "index.html": {kind: "page", blocks: [...]},
                    "blog/x.html": {kind: "post", blocks}, "header.html": {kind: "header", blocks}, … },
       customCss: "…theme.css text…" }

   A block: { type, x, y, w, h, data }  (grid position in a 12-column grid).
   ========================================================================== */

(function () {
  'use strict';

  const COLUMNS = 12;
  const VERSION = 2;

  /* ========================================================================
     SAFETY: escaping, URL checks, rich-text allow-list
     ======================================================================== */

  function escapeHtml(str) {
    return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function escapeAttr(str) {
    return String(str ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /**
   * The URL if safe, else ''.
   *  'link'  → http(s), mailto, tel, #anchor, relative path
   *  'image' → http(s), relative path, data:image/…, blob: (previews only)
   */
  function safeUrl(url, kind) {
    const u = String(url ?? '').trim();
    if (!u) return '';
    if (kind === 'image' && /^data:image\/(png|jpe?g|gif|webp|avif|svg\+xml)[;,]/i.test(u)) return u;
    if (kind === 'image' && /^blob:/i.test(u)) return u;
    if (/^https?:\/\//i.test(u)) return u;
    if (kind === 'link' && /^(mailto:|tel:|#)/i.test(u)) return u;
    if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) return u;
    return '';
  }

  const RICH_TEXT_TAGS = {
    P: 'p', BR: 'br', STRONG: 'strong', B: 'strong', EM: 'em', I: 'em', U: 'u',
    H1: 'h2', H2: 'h2', H3: 'h3', H4: 'h3', UL: 'ul', OL: 'ol', LI: 'li',
    A: 'a', BLOCKQUOTE: 'blockquote', DIV: 'p',
  };
  const DROP_TAGS = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'TEMPLATE', 'NOSCRIPT',
    'SVG', 'MATH', 'FORM', 'INPUT', 'BUTTON', 'SELECT', 'TEXTAREA', 'LINK', 'META', 'HEAD', 'TITLE']);

  /** Keep only simple semantic tags; links keep a safe href only. */
  function sanitizeRichText(dirtyHtml) {
    const tpl = document.createElement('template');
    tpl.innerHTML = String(dirtyHtml ?? '');
    const out = document.createElement('div');
    (function copy(from, to) {
      for (const node of Array.from(from.childNodes)) {
        if (node.nodeType === Node.TEXT_NODE) { to.appendChild(document.createTextNode(node.nodeValue)); continue; }
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        const tag = node.tagName.toUpperCase();
        if (DROP_TAGS.has(tag)) continue;
        const clean = RICH_TEXT_TAGS[tag];
        if (!clean) { copy(node, to); continue; }
        const el = document.createElement(clean);
        if (clean === 'a') {
          const href = safeUrl(node.getAttribute('href'), 'link');
          if (!href) { copy(node, to); continue; }
          el.setAttribute('href', href);
          if (/^https?:/i.test(href)) el.setAttribute('rel', 'noopener');
        }
        copy(node, el);
        to.appendChild(el);
      }
    })(tpl.content, out);
    out.querySelectorAll('p, h2, h3, li').forEach((el) => {
      if (!el.textContent.trim() && !el.querySelector('br')) el.remove();
    });
    return out.innerHTML.trim();
  }

  const toInt = (v, fallback) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : fallback; };

  // UTF-8 safe base64 (used to keep custom code byte-exact)
  const b64encode = (s) => btoa(unescape(encodeURIComponent(String(s))));
  const b64decode = (s) => { try { return decodeURIComponent(escape(atob(String(s)))); } catch { return ''; } };

  /* ========================================================================
     LINKS: every path is stored relative to the site root ("about.html",
     "assets/images/x.jpg", "blog/my-post.html"). A page in /blog/ needs
     "../" in front, so links are adjusted when a page is rendered — and
     undone when it's read back.
     ======================================================================== */

  /** "blog/x.html" → "../";  "index.html" → "" */
  function docRoot(file) {
    return '../'.repeat(String(file).split('/').length - 1);
  }
  const isRelativeUrl = (u) => !!u && !/^([a-z][a-z0-9+.-]*:|\/|#)/i.test(u);
  function toPageUrl(path, root) { return root && isRelativeUrl(path) ? root + path : path; }
  function fromPageUrl(href, root) { return root && href && href.startsWith(root) ? href.slice(root.length) : href; }

  /** Apply fn to every a[href] and img[src] inside an HTML fragment. */
  function rewriteUrls(html, fn) {
    if (!/\b(href|src)=/.test(html)) return html;
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    tpl.content.querySelectorAll('a[href]').forEach((a) => a.setAttribute('href', fn(a.getAttribute('href'))));
    tpl.content.querySelectorAll('img[src]').forEach((i) => i.setAttribute('src', fn(i.getAttribute('src'))));
    return tpl.innerHTML;
  }

  /** Rich text as it goes into a page / comes out of a page. */
  const richOut = (html, ctx) => rewriteUrls(sanitizeRichText(html), (u) => toPageUrl(u, ctx.root));
  const richIn = (html, ctx) => sanitizeRichText(rewriteUrls(html, (u) => fromPageUrl(u, ctx.root)));

  /* ========================================================================
     DESIGN SETTINGS → global.css
     ======================================================================== */

  /** Font choices, by friendly name. Only these stacks can reach the CSS. */
  const FONTS = {
    classic:    { label: 'Classic',    stack: 'Georgia, "Iowan Old Style", "Times New Roman", serif' },
    modern:     { label: 'Modern',     stack: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif' },
    elegant:    { label: 'Elegant',    stack: '"Palatino Linotype", Palatino, "Book Antiqua", Georgia, serif' },
    friendly:   { label: 'Friendly',   stack: '"Trebuchet MS", "Segoe UI", Tahoma, sans-serif' },
    rounded:    { label: 'Rounded',    stack: 'ui-rounded, "SF Pro Rounded", "Arial Rounded MT Bold", "Segoe UI", sans-serif' },
    typewriter: { label: 'Typewriter', stack: '"Courier New", Courier, monospace' },
  };

  const DEFAULT_THEME = { primaryColor: '#b85c38', secondaryColor: '#6b8b4f', fontFamily: 'classic', borderRadius: 14, blockSpacing: 16 };

  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
  const isHex = (c) => /^#[0-9a-f]{6}$/i.test(String(c || ''));

  /** Validate design settings, so nothing but known values reaches the CSS. */
  function normalizeTheme(t = {}) {
    return {
      primaryColor: isHex(t.primaryColor) ? t.primaryColor.toLowerCase() : DEFAULT_THEME.primaryColor,
      secondaryColor: isHex(t.secondaryColor) ? t.secondaryColor.toLowerCase() : DEFAULT_THEME.secondaryColor,
      fontFamily: FONTS[t.fontFamily] ? t.fontFamily : DEFAULT_THEME.fontFamily,
      borderRadius: clamp(toInt(t.borderRadius, DEFAULT_THEME.borderRadius), 0, 40),
      blockSpacing: clamp(toInt(t.blockSpacing, DEFAULT_THEME.blockSpacing), 4, 48),
    };
  }

  /** The five site-wide design variables. */
  function themeVariables(theme) {
    const t = normalizeTheme(theme);
    return {
      '--primary-color': t.primaryColor,
      '--secondary-color': t.secondaryColor,
      '--border-radius': `${t.borderRadius}px`,
      '--font-family': FONTS[t.fontFamily].stack,
      '--block-spacing': `${t.blockSpacing}px`,
    };
  }

  /** global.css = the variables + Pebble's base stylesheet (lib/site-base.css). */
  function globalCss(theme, baseCss) {
    const vars = Object.entries(themeVariables(theme)).map(([k, v]) => `  ${k}: ${v};`).join('\n');
    return `/* Made by Pebble from your Site Settings. Pebble rewrites this file:
   put your own CSS in theme.css instead (Site Settings → Advanced). */
:root {
${vars}
}

${String(baseCss || '').trim()}
`;
  }

  /* ========================================================================
     site-config.json
     ======================================================================== */

  function defaultConfig(siteName) {
    return {
      generator: 'Pebble',
      version: VERSION,
      siteName: siteName || 'My website',
      pages: [{ file: 'index.html', title: 'Home', showInNavbar: true }],
      posts: [],
      theme: { ...DEFAULT_THEME },
      customCss: false,
    };
  }

  const PAGE_FILE_RE = /^[a-z0-9][a-z0-9-]{0,60}\.html$/;
  const POST_FILE_RE = /^blog\/[a-z0-9][a-z0-9-]{0,60}\.html$/;
  const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));

  /** Accept a config read from a file, dropping anything malformed. */
  function normalizeConfig(c = {}) {
    const seen = new Set();
    const pages = (Array.isArray(c.pages) ? c.pages : [])
      .filter((p) => p && PAGE_FILE_RE.test(p.file) && !['header.html', 'footer.html'].includes(p.file) && !seen.has(p.file) && seen.add(p.file))
      .map((p) => ({ file: p.file, title: String(p.title || nameFromFile(p.file)).slice(0, 80), showInNavbar: p.showInNavbar !== false }));
    if (!pages.some((p) => p.file === 'index.html')) pages.unshift({ file: 'index.html', title: 'Home', showInNavbar: true });
    const posts = (Array.isArray(c.posts) ? c.posts : [])
      .filter((p) => p && POST_FILE_RE.test(p.file) && !seen.has(p.file) && seen.add(p.file))
      .map((p) => ({
        file: p.file,
        title: String(p.title || nameFromFile(p.file)).slice(0, 140),
        date: isDate(p.date) ? p.date : todayIso(),
        thumbnail: safeUrl(p.thumbnail, 'image'),
        excerpt: String(p.excerpt || '').slice(0, 400),
        excerptAuto: p.excerptAuto !== false && !p.excerpt ? true : !!p.excerptAuto,
      }));
    return {
      generator: 'Pebble',
      version: VERSION,
      siteName: String(c.siteName || 'My website').slice(0, 80),
      pages,
      posts,
      theme: normalizeTheme(c.theme),
      customCss: !!c.customCss,
    };
  }

  function todayIso() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  /** "2026-11-09" → "9 November 2026" (fixed format, so output is stable) */
  function formatDate(iso) {
    if (!isDate(iso)) return '';
    return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
      .format(new Date(`${iso}T00:00:00Z`));
  }

  /** Posts newest first. */
  const sortedPosts = (config) => config.posts.slice().sort((a, b) => b.date.localeCompare(a.date) || a.title.localeCompare(b.title));

  function nameFromFile(file) {
    const base = String(file).split('/').pop();
    if (base === 'index.html') return 'Home';
    const words = base.replace(/\.html?$/i, '').replace(/[-_]+/g, ' ').trim();
    return words ? words[0].toUpperCase() + words.slice(1) : 'Page';
  }

  function slugify(name, fallback = 'page') {
    return String(name).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50).replace(/-+$/, '') || fallback;
  }

  /** A summary from the first words of a post's text. */
  function excerptFrom(blocks, max = 160) {
    const tpl = document.createElement('template');
    for (const b of blocks.slice().sort((a, c) => (a.y - c.y) || (a.x - c.x))) {
      if (b.type !== 'text' && b.type !== 'card') continue;
      tpl.innerHTML = b.type === 'card' ? (b.data.html || '') : (b.data.html || '');
      tpl.content.querySelectorAll('h2, h3').forEach((h) => h.remove());
      tpl.content.querySelectorAll('p, li, br').forEach((el) => el.after(' '));
      const text = tpl.content.textContent.replace(/\s+/g, ' ').trim();
      if (!text) continue;
      if (text.length <= max) return text;
      return text.slice(0, max).replace(/\s+\S*$/, '') + '…';
    }
    return '';
  }

  /* ========================================================================
     BLOCKS — the static side (how each block looks on the published site,
     and how it's read back). The editor adds its own editing UI on top.

       render(data, ctx) → { inner, classes?, attrs?, tag? }
       parse(el, ctx)    → data
     ctx = { config, file, root }  (root = "" or "../" for the page being made)
     ======================================================================== */

  const BLOCKS = {
    text: {
      tag: 'section',
      defaults: () => ({ html: '' }),
      render: (d, ctx) => ({ inner: `<div class="block-text__content rich-text">${richOut(d.html, ctx)}</div>` }),
      parse: (el, ctx) => ({ html: richIn((el.querySelector('.rich-text, .block__content') || el).innerHTML, ctx) }),
    },

    image: {
      tag: 'figure',
      defaults: () => ({ src: '', caption: '' }),
      render(d, ctx) {
        const src = safeUrl(d.src, 'image');
        const caption = String(d.caption || '').trim();
        if (!src) return { classes: ['block-image--empty'], inner: '<div class="block-image__media"></div>' };
        return {
          inner: `<div class="block-image__media"><img src="${escapeAttr(toPageUrl(src, ctx.root))}" alt="${escapeAttr(caption || 'Photo')}" loading="lazy"></div>` +
            (caption ? `\n        <figcaption class="block-image__caption">${escapeHtml(caption)}</figcaption>` : ''),
        };
      },
      parse(el, ctx) {
        const img = el.querySelector('img');
        const cap = el.querySelector('figcaption');
        return { src: img ? safeUrl(fromPageUrl(img.getAttribute('src'), ctx.root), 'image') : '', caption: cap ? cap.textContent.trim() : '' };
      },
    },

    card: {
      tag: 'article',
      defaults: () => ({ src: '', title: '', html: '', href: '', linkLabel: 'Read more' }),
      render(d, ctx) {
        const src = safeUrl(d.src, 'image');
        const href = safeUrl(d.href, 'link');
        const media = src ? `<div class="block-card__media"><img src="${escapeAttr(toPageUrl(src, ctx.root))}" alt="" loading="lazy"></div>` : '';
        const link = href ? `<a class="block-card__link" href="${escapeAttr(toPageUrl(href, ctx.root))}">${escapeHtml(d.linkLabel || 'Read more')}</a>` : '';
        return {
          inner: `${media}<div class="block-card__body"><h3 class="block-card__title">${escapeHtml(d.title || '')}</h3>` +
            `<div class="block-card__text rich-text">${richOut(d.html, ctx)}</div>${link}</div>`,
        };
      },
      parse(el, ctx) {
        const img = el.querySelector('.block-card__media img');
        const a = el.querySelector('.block-card__link');
        return {
          src: img ? safeUrl(fromPageUrl(img.getAttribute('src'), ctx.root), 'image') : '',
          title: (el.querySelector('.block-card__title') || { textContent: '' }).textContent.trim(),
          html: richIn((el.querySelector('.block-card__text') || { innerHTML: '' }).innerHTML, ctx),
          href: a ? safeUrl(fromPageUrl(a.getAttribute('href'), ctx.root), 'link') : '',
          linkLabel: a ? a.textContent.trim() : 'Read more',
        };
      },
    },

    button: {
      tag: 'div',
      defaults: () => ({ label: 'Click here', href: '', style: 'primary', align: 'left' }),
      render(d, ctx) {
        const style = d.style === 'secondary' ? 'secondary' : 'primary';
        const align = ['left', 'center', 'right'].includes(d.align) ? d.align : 'left';
        const href = safeUrl(d.href, 'link') || '#';
        return {
          classes: [`block-button--${align}`],
          inner: `<a class="block-button__link block-button__link--${style}" href="${escapeAttr(toPageUrl(href, ctx.root))}">${escapeHtml(d.label || 'Click here')}</a>`,
        };
      },
      parse(el, ctx) {
        const a = el.querySelector('a');
        const href = a ? fromPageUrl(a.getAttribute('href'), ctx.root) : '';
        return {
          label: a ? a.textContent.trim() : '',
          href: href === '#' ? '' : safeUrl(href, 'link'),
          style: a && a.classList.contains('block-button__link--secondary') ? 'secondary' : 'primary',
          align: ['center', 'right'].find((x) => el.classList.contains(`block-button--${x}`)) || 'left',
        };
      },
    },

    'blog-feed': {
      tag: 'section',
      defaults: () => ({ limit: 6 }),
      render(d, ctx) {
        const limit = [3, 6, 12, 0].includes(toInt(d.limit, 6)) ? toInt(d.limit, 6) : 6;
        const posts = sortedPosts(ctx.config).slice(0, limit || undefined);
        const cards = posts.map((p) => {
          const thumb = safeUrl(p.thumbnail, 'image');
          return `<a class="blog-card" href="${escapeAttr(toPageUrl(p.file, ctx.root))}">` +
            (thumb ? `<div class="blog-card__media"><img src="${escapeAttr(toPageUrl(thumb, ctx.root))}" alt="" loading="lazy"></div>` : '') +
            `<div class="blog-card__body"><time class="blog-card__date" datetime="${p.date}">${escapeHtml(formatDate(p.date))}</time>` +
            `<h3 class="blog-card__title">${escapeHtml(p.title)}</h3>` +
            (p.excerpt ? `<p class="blog-card__excerpt">${escapeHtml(p.excerpt)}</p>` : '') +
            '</div></a>';
        });
        return {
          attrs: { 'data-limit': String(limit) },
          inner: cards.length
            ? `<div class="blog-feed">\n          ${cards.join('\n          ')}\n        </div>`
            : '<p class="blog-feed__empty">No blog posts yet.</p>',
        };
      },
      parse: (el) => ({ limit: toInt(el.getAttribute('data-limit'), 6) }),
    },

    embed: {
      tag: 'div',
      defaults: () => ({ code: '' }),
      // The code is copied into the page as-is (that's the point: a helper
      // can paste a map, a video or a form). A base64 copy keeps it
      // byte-exact for the editor.
      render: (d) => ({ attrs: { 'data-code': b64encode(d.code || '') }, inner: String(d.code || '') }),
      parse: (el) => ({ code: el.hasAttribute('data-code') ? b64decode(el.getAttribute('data-code')) : el.innerHTML.trim() }),
    },

    'site-title': {
      tag: 'div',
      defaults: () => ({}),
      render: (d, ctx) => ({ inner: `<a class="site-title" href="${ctx.root}index.html">${escapeHtml(ctx.config.siteName)}</a>` }),
      parse: () => ({}),
    },

    menu: {
      tag: 'nav',
      defaults: () => ({ align: 'right' }),
      render(d, ctx) {
        const align = ['left', 'center', 'right'].includes(d.align) ? d.align : 'right';
        const items = ctx.config.pages.filter((p) => p.showInNavbar).map((p) =>
          `<li><a href="${escapeAttr(toPageUrl(p.file, ctx.root))}"${p.file === ctx.file ? ' aria-current="page"' : ''}>${escapeHtml(p.title)}</a></li>`);
        return { classes: [`block-menu--${align}`], attrs: { 'aria-label': 'Site menu' }, inner: `<ul class="site-menu">${items.join('')}</ul>` };
      },
      parse: (el) => ({ align: ['left', 'center'].find((x) => el.classList.contains(`block-menu--${x}`)) || 'right' }),
    },
  };

  /** Where each block may be used (the editor's Add menu follows this). */
  const REGION_ONLY = { 'site-title': ['header', 'footer'], menu: ['header', 'footer'] };

  function sortBlocks(blocks) {
    return blocks.slice().sort((a, b) => (a.y - b.y) || (a.x - b.x));
  }

  /** One block → HTML. Position is written as data (for Pebble) and as CSS Grid lines (for visitors). */
  function renderBlock(b, ctx, indent = '      ') {
    const def = BLOCKS[b.type];
    const r = def.render({ ...def.defaults(), ...b.data }, ctx);
    const classes = ['editor-block', `block-${b.type}`, ...(r.classes || [])].join(' ');
    const extra = Object.entries(r.attrs || {}).map(([k, v]) => ` ${k}="${escapeAttr(v)}"`).join('');
    const tag = r.tag || def.tag;
    return `${indent}<${tag} class="${classes}" data-widget-type="${b.type}" data-gs-x="${b.x}" data-gs-y="${b.y}" data-gs-w="${b.w}" data-gs-h="${b.h}"${extra} ` +
      `style="grid-column:${b.x + 1} / span ${b.w};grid-row:${b.y + 1} / span ${b.h}">\n${indent}  ${r.inner}\n${indent}</${tag}>`;
  }

  function renderBlocks(blocks, ctx) {
    return sortBlocks(blocks.filter((b) => BLOCKS[b.type])).map((b) => renderBlock(b, ctx)).join('\n\n');
  }

  /** Read blocks back from a grid element (clamping positions). */
  function parseBlocks(container, ctx) {
    if (!container) return [];
    let els = Array.from(container.querySelectorAll(':scope > [data-widget-type]'));
    if (!els.length) els = Array.from(container.querySelectorAll('[data-widget-type]'));
    const blocks = [];
    let bottom = 0;
    for (const el of els) {
      const type = el.getAttribute('data-widget-type');
      const def = BLOCKS[type];
      if (!def) continue;
      const w = clamp(toInt(el.getAttribute('data-gs-w'), 6), 1, COLUMNS);
      const h = Math.max(1, toInt(el.getAttribute('data-gs-h'), 2));
      const x = clamp(toInt(el.getAttribute('data-gs-x'), 0), 0, COLUMNS - w);
      const y = Math.max(0, toInt(el.getAttribute('data-gs-y'), bottom));
      blocks.push({ type, x, y, w, h, data: { ...def.defaults(), ...def.parse(el, ctx) } });
      bottom = Math.max(bottom, y + h);
    }
    return blocks;
  }

  const makeCtx = (config, file) => ({ config, file, root: docRoot(file) });

  /* ========================================================================
     HEADER & FOOTER (partials)
     ======================================================================== */

  function renderRegion(kind, blocks, ctx) {
    const tag = kind === 'header' ? 'header' : 'footer';
    return `  <${tag} class="site-${kind}" data-pebble-region="${kind}">\n    <div class="region-grid" data-columns="${COLUMNS}">\n` +
      `${renderBlocks(blocks, ctx)}\n    </div>\n  </${tag}>`;
  }

  /** header.html / footer.html as stored in the repository. */
  function partialToHtml(kind, blocks, config) {
    const where = kind === 'header' ? 'top' : 'bottom';
    return `<!--
  Pebble: the ${where} of every page. Edit it in Pebble;
  it is copied into every page each time you save.
-->
${renderRegion(kind, blocks, makeCtx(config, `${kind}.html`))}
`;
  }

  function partialFromHtml(html, kind) {
    const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
    const region = doc.querySelector(`[data-pebble-region="${kind}"] .region-grid`) || doc.querySelector('.region-grid');
    return parseBlocks(region, makeCtx(defaultConfig(), `${kind}.html`));
  }

  function defaultHeaderBlocks() {
    return [
      { type: 'site-title', x: 0, y: 0, w: 5, h: 1, data: {} },
      { type: 'menu', x: 5, y: 0, w: 7, h: 1, data: { align: 'right' } },
    ];
  }

  function defaultFooterBlocks(siteName) {
    return [{ type: 'text', x: 0, y: 0, w: 12, h: 1, data: { html: `<p>© ${new Date().getFullYear()} ${escapeHtml(siteName)}</p>` } }];
  }

  /* ========================================================================
     STITCHING — one complete, standalone page
     ======================================================================== */

  /**
   * @param {{file, kind: 'page'|'post', blocks}} doc
   * @param {{config, header: block[], footer: block[]}} site
   * @param {object} [opts] { inlineCss: string } → embed CSS instead of linking (preview)
   */
  function stitchPage(doc, site, opts = {}) {
    const config = site.config;
    const ctx = makeCtx(config, doc.file);
    const isPost = doc.kind === 'post';
    const meta = (isPost ? config.posts : config.pages).find((p) => p.file === doc.file) || { title: nameFromFile(doc.file) };

    const styles = opts.inlineCss != null
      ? `<style>\n${String(opts.inlineCss).replace(/<\/style/gi, '<\\/style')}\n  </style>`
      : `<link rel="stylesheet" href="${ctx.root}global.css">` + (config.customCss ? `\n  <link rel="stylesheet" href="${ctx.root}theme.css">` : '');
    const description = isPost && meta.excerpt ? `\n  <meta name="description" content="${escapeAttr(meta.excerpt)}">` : '';

    let postHeader = '';
    if (isPost) {
      const cover = safeUrl(meta.thumbnail, 'image');
      postHeader = `    <header class="post-header">
      <p class="post-header__date"><time datetime="${meta.date}">${escapeHtml(formatDate(meta.date))}</time></p>
      <h1 class="post-header__title">${escapeHtml(meta.title)}</h1>` +
        (cover ? `\n      <figure class="post-header__cover"><img src="${escapeAttr(toPageUrl(cover, ctx.root))}" alt=""></figure>` : '') +
        '\n    </header>\n';
    }

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="generator" content="Pebble">
  <title>${escapeHtml(meta.title)} – ${escapeHtml(config.siteName)}</title>${description}
  ${styles}
</head>
<body class="${isPost ? 'is-post' : 'is-page'}">
  <!--
    Made with Pebble: plain HTML, no database, no JavaScript.
    The header and footer come from header.html / footer.html, menu and blog
    posts from site-config.json. data-widget-type / data-gs-* let Pebble re-open it.
  -->
${renderRegion('header', site.header, ctx)}

  <main class="site-main" id="main">
${postHeader}    <div class="region-grid page-grid" data-pebble-grid data-columns="${COLUMNS}" data-page-name="${escapeAttr(meta.title)}"${isPost ? ' data-post' : ''}>
${renderBlocks(doc.blocks, ctx)}
    </div>
  </main>

${renderRegion('footer', site.footer, ctx)}
</body>
</html>
`;
  }

  /**
   * Read a page back. Also works for pages from older Pebble versions, and
   * reports what their header said (site name, menu order) for upgrading.
   */
  function parsePage(html, file) {
    const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
    const grid = doc.querySelector('[data-pebble-grid]');
    const titleName = (doc.title || '').split(' – ')[0].trim();
    const siteNameEl = doc.querySelector('.site-title, .site-name');
    return {
      blocks: parseBlocks(grid || doc.body, makeCtx(defaultConfig(), file)),
      name: ((grid && grid.getAttribute('data-page-name')) || titleName || nameFromFile(file)).trim(),
      isPebble: !!grid,
      legacy: {
        siteName: siteNameEl ? siteNameEl.textContent.trim() : null,
        nav: Array.from(doc.querySelectorAll('.site-nav a[href], .site-menu a[href]')).map((a) => fromPageUrl(a.getAttribute('href'), docRoot(file))),
      },
    };
  }

  const isPebblePage = (html) => /\bdata-pebble-grid\b/.test(String(html || ''));

  /* ========================================================================
     THE WHOLE SITE → FILES
     ======================================================================== */

  /**
   * Every file of the website, rendered from data. The caller commits only
   * the ones whose text differs from what's in the repository.
   * @returns {Object<string, string>} path → file content
   */
  function buildSiteFiles(site, { baseCss }) {
    const config = normalizeConfig(site.config);
    const customCss = String(site.customCss || '');
    config.customCss = customCss.trim().length > 0;

    // Summaries left empty come from the first words of the post.
    for (const post of config.posts) {
      const doc = site.docs[post.file];
      if (doc && (post.excerptAuto || !post.excerpt)) {
        post.excerpt = excerptFrom(doc.blocks);
        post.excerptAuto = true;
      }
    }

    const header = (site.docs['header.html'] || { blocks: [] }).blocks;
    const footer = (site.docs['footer.html'] || { blocks: [] }).blocks;
    const files = {
      'site-config.json': JSON.stringify(config, null, 2) + '\n',
      'global.css': globalCss(config.theme, baseCss),
      'header.html': partialToHtml('header', header, config),
      'footer.html': partialToHtml('footer', footer, config),
    };
    if (config.customCss) files['theme.css'] = customCss.endsWith('\n') ? customCss : customCss + '\n';

    for (const p of config.pages) {
      const doc = site.docs[p.file];
      if (doc) files[p.file] = stitchPage({ file: p.file, kind: 'page', blocks: doc.blocks }, { config, header, footer });
    }
    for (const p of config.posts) {
      const doc = site.docs[p.file];
      if (doc) files[p.file] = stitchPage({ file: p.file, kind: 'post', blocks: doc.blocks }, { config, header, footer });
    }
    return files;
  }

  /** A brand-new website: one welcoming homepage, header, footer. */
  function starterSite(title) {
    const config = defaultConfig(title);
    return {
      config,
      customCss: '',
      docs: {
        'index.html': {
          kind: 'page',
          blocks: [{ type: 'text', x: 0, y: 0, w: 12, h: 3, data: { html: `<h2>${escapeHtml(title)}</h2><p>Welcome! This website is brand new — come back soon.</p>` } }],
        },
        'header.html': { kind: 'header', blocks: defaultHeaderBlocks() },
        'footer.html': { kind: 'footer', blocks: defaultFooterBlocks(title) },
      },
    };
  }

  /**
   * Upgrade a website made by an older Pebble (pages with their own header,
   * site.css, no site-config.json) to this format.
   * @param {Object<string,string>} pagesHtml  file → html
   */
  function upgradeLegacySite(pagesHtml) {
    const parsed = Object.fromEntries(Object.entries(pagesHtml).map(([f, h]) => [f, parsePage(h, f)]));
    const home = parsed['index.html'];
    const siteName = (home && home.legacy.siteName) || 'My website';
    const navOrder = home ? home.legacy.nav : [];
    const files = Object.keys(parsed).filter((f) => PAGE_FILE_RE.test(f) && parsed[f].isPebble);
    const rank = (f) => (f === 'index.html' ? -1 : navOrder.includes(f) ? navOrder.indexOf(f) : 1e6);
    files.sort((a, b) => (rank(a) - rank(b)) || a.localeCompare(b));

    const config = defaultConfig(siteName);
    config.pages = files.map((f) => ({ file: f, title: parsed[f].name, showInNavbar: true }));
    if (!config.pages.length) config.pages = defaultConfig(siteName).pages;
    const docs = {
      'header.html': { kind: 'header', blocks: defaultHeaderBlocks() },
      'footer.html': { kind: 'footer', blocks: defaultFooterBlocks(siteName) },
    };
    for (const f of files) docs[f] = { kind: 'page', blocks: parsed[f].blocks };
    return { config: normalizeConfig(config), customCss: '', docs };
  }

  window.PebbleFormat = {
    COLUMNS, VERSION, FONTS, DEFAULT_THEME, BLOCKS, REGION_ONLY,
    escapeHtml, escapeAttr, safeUrl, sanitizeRichText,
    docRoot, toPageUrl, fromPageUrl,
    normalizeTheme, themeVariables, globalCss,
    defaultConfig, normalizeConfig, formatDate, todayIso, sortedPosts, nameFromFile, slugify, excerptFrom,
    sortBlocks, renderBlock, renderBlocks, parseBlocks, makeCtx,
    renderRegion, partialToHtml, partialFromHtml, defaultHeaderBlocks, defaultFooterBlocks,
    stitchPage, parsePage, isPebblePage,
    buildSiteFiles, starterSite, upgradeLegacySite,
    PAGE_FILE_RE, POST_FILE_RE,
  };
})();
