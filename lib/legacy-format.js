/* ==========================================================================
   PebbleLegacy — the website format of Pebble v2–v4, kept ONLY to open
   websites made by those versions (one time) and turn them into site.json.

   Those versions stored each page as stitched HTML with data-pebble-* and
   data-gs-* attributes, plus site-config.json, header.html and footer.html.
   lib/site-state.js (importLegacy) reads them with parsePage() /
   partialFromHtml() below. Nothing here writes files any more: the current
   format is site.json + compiled HTML (lib/site-state.js, lib/compiler.js).

   Frozen code: don't extend it.
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
    H1: 'h1', H2: 'h2', H3: 'h3', H4: 'h3', UL: 'ul', OL: 'ol', LI: 'li',
    A: 'a', BLOCKQUOTE: 'blockquote', DIV: 'p', MARK: 'mark',
  };
  const DROP_TAGS = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'TEMPLATE', 'NOSCRIPT',
    'SVG', 'MATH', 'FORM', 'INPUT', 'BUTTON', 'SELECT', 'TEXTAREA', 'LINK', 'META', 'HEAD', 'TITLE']);

  /** Highlight colours (text background). Only these classes are kept. */
  const HIGHLIGHTS = {
    yellow: { label: 'Yellow', color: '#fff1a8' },
    green:  { label: 'Green',  color: '#c8f2c2' },
    blue:   { label: 'Blue',   color: '#cfe4ff' },
    pink:   { label: 'Pink',   color: '#ffd1e1' },
    orange: { label: 'Orange', color: '#ffdcb5' },
  };
  const ALIGNS = ['left', 'center', 'right', 'justify'];
  const BLOCK_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'li', 'blockquote']);

  /** "rgb(255, 241, 168)" / "#fff1a8" → nearest highlight name, or '' for none/transparent. */
  function highlightFor(color) {
    const c = String(color || '').trim().toLowerCase();
    if (!c || c === 'transparent' || /rgba\([^)]*,\s*0\s*\)/.test(c) || c === 'initial' || c === 'inherit') return '';
    let rgb = null;
    const m = c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (m) rgb = [+m[1], +m[2], +m[3]];
    else if (/^#[0-9a-f]{6}$/.test(c)) rgb = [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
    if (!rgb) return '';
    let best = '', bestD = Infinity;
    for (const [name, h] of Object.entries(HIGHLIGHTS)) {
      const t = [1, 3, 5].map((i) => parseInt(h.color.slice(i, i + 2), 16));
      const d = t.reduce((s, v, i) => s + (v - rgb[i]) ** 2, 0);
      if (d < bestD) { bestD = d; best = name; }
    }
    return best;
  }

  /**
   * Keep only simple semantic tags; links keep a safe href only. The few
   * formatting choices the text toolbar offers survive as classes:
   *   align-center/right/justify (from text-align), text-small ("Small text"),
   *   hl-yellow … (highlight, from a background colour).
   */
  function sanitizeRichText(dirtyHtml) {
    const tpl = document.createElement('template');
    tpl.innerHTML = String(dirtyHtml ?? '');
    const out = document.createElement('div');

    const alignOf = (node) => {
      const fromStyle = node.style && node.style.textAlign;
      const fromAttr = node.getAttribute('align');
      const fromClass = (node.className && String(node.className).match(/\balign-(left|center|right|justify)\b/)) || null;
      let a = String(fromStyle || fromAttr || (fromClass && fromClass[1]) || '').toLowerCase();
      if (a === 'start') a = 'left';
      if (a === 'end') a = 'right';
      return ALIGNS.includes(a) && a !== 'left' ? a : '';
    };

    (function copy(from, to, inheritedAlign) {
      for (const node of Array.from(from.childNodes)) {
        if (node.nodeType === Node.TEXT_NODE) { to.appendChild(document.createTextNode(node.nodeValue)); continue; }
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        const tag = node.tagName.toUpperCase();
        if (DROP_TAGS.has(tag)) continue;

        // A highlight made by the browser: <span style="background-color: …">
        let clean = RICH_TEXT_TAGS[tag];
        let hl = '';
        if (tag === 'MARK' || tag === 'SPAN' || tag === 'FONT') {
          const cls = node.className && String(node.className).match(/\bhl-(yellow|green|blue|pink|orange)\b/);
          hl = cls ? cls[1] : highlightFor(node.style && node.style.backgroundColor);
          clean = hl ? 'mark' : null;
        }
        if (!clean) { copy(node, to, inheritedAlign); continue; }

        // A <div> wrapper (browsers add these when aligning) gives its alignment to its children.
        if (tag === 'DIV' && node.querySelector('p, h1, h2, h3, ul, ol, blockquote')) {
          copy(node, to, alignOf(node) || inheritedAlign);
          continue;
        }

        const el = document.createElement(clean);
        if (clean === 'a') {
          const href = safeUrl(node.getAttribute('href'), 'link');
          if (!href) { copy(node, to, inheritedAlign); continue; }
          el.setAttribute('href', href);
          if (/^https?:/i.test(href)) el.setAttribute('rel', 'noopener');
        }
        const classes = [];
        if (BLOCK_TAGS.has(clean)) {
          const a = alignOf(node) || inheritedAlign;
          if (a) classes.push(`align-${a}`);
          if (clean === 'p' && node.classList && node.classList.contains('text-small')) classes.push('text-small');
        }
        if (clean === 'mark') classes.push(`hl-${hl || 'yellow'}`);
        if (classes.length) el.className = classes.join(' ');
        // Browsers sometimes put the highlight colour straight on <b>/<u>/<i>/<a>.
        const inlineHl = ['strong', 'em', 'u', 'a'].includes(clean) && highlightFor(node.style && node.style.backgroundColor);
        if (inlineHl) {
          const mark = document.createElement('mark');
          mark.className = `hl-${inlineHl}`;
          copy(node, mark, '');
          el.appendChild(mark);
        } else {
          copy(node, el, '');
        }
        to.appendChild(el);
      }
    })(tpl.content, out, '');

    // Empty highlights and paragraphs browsers leave behind.
    out.querySelectorAll('mark').forEach((m) => { if (!m.textContent) m.remove(); });
    out.querySelectorAll('p, h1, h2, h3, li').forEach((el) => {
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

  /**
   * Font choices, by friendly name. Only these stacks (and a validated
   * custom Google Font) can reach the CSS. `google` = the Google Fonts
   * "family" parameter to load.
   */
  const FONTS = {
    classic:    { label: 'Georgia',             stack: 'Georgia, "Iowan Old Style", "Times New Roman", serif' },
    modern:     { label: 'System Sans',         stack: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif' },
    playfair:   { label: 'Playfair Display',    stack: '"Playfair Display", Georgia, serif', google: 'Playfair+Display:wght@400;600;700;800' },
    merriweather: { label: 'Merriweather',      stack: 'Merriweather, Georgia, serif', google: 'Merriweather:wght@300;400;700;900' },
    lora:       { label: 'Lora',                stack: 'Lora, Georgia, serif', google: 'Lora:wght@400;600;700' },
    roboto:     { label: 'Roboto',              stack: 'Roboto, "Helvetica Neue", Arial, sans-serif', google: 'Roboto:wght@300;400;600;700;800' },
    opensans:   { label: 'Open Sans',           stack: '"Open Sans", "Helvetica Neue", Arial, sans-serif', google: 'Open+Sans:wght@300;400;600;700;800' },
    lato:       { label: 'Lato',                stack: 'Lato, "Helvetica Neue", Arial, sans-serif', google: 'Lato:wght@300;400;700;900' },
    montserrat: { label: 'Montserrat',          stack: 'Montserrat, "Helvetica Neue", Arial, sans-serif', google: 'Montserrat:wght@300;400;600;700;800' },
    nunito:     { label: 'Nunito',              stack: 'Nunito, "Segoe UI", sans-serif', google: 'Nunito:wght@300;400;600;700;800' },
    // Older choices, still supported for existing websites:
    elegant:    { label: 'Palatino',            stack: '"Palatino Linotype", Palatino, "Book Antiqua", Georgia, serif' },
    friendly:   { label: 'Trebuchet MS',        stack: '"Trebuchet MS", "Segoe UI", Tahoma, sans-serif' },
    rounded:    { label: 'System Rounded',      stack: 'ui-rounded, "SF Pro Rounded", "Arial Rounded MT Bold", "Segoe UI", sans-serif' },
    typewriter: { label: 'Courier New',         stack: '"Courier New", Courier, monospace' },
  };

  const DEFAULT_THEME = { primaryColor: '#b85c38', secondaryColor: '#6b8b4f', fontFamily: 'classic', borderRadius: 14, blockSpacing: 16 };

  /**
   * The text styles of the text toolbar's dropdown. Each one maps to an HTML
   * tag (+ class) and has a size / line height / weight set in Site Settings,
   * published as CSS variables (--text-title-size …).
   */
  const TEXT_STYLES = {
    title:      { tag: 'h1', name: 'Main Heading', size: 48, lineHeight: 1.15, weight: 700 },
    heading:    { tag: 'h2', name: 'Heading',      size: 36, lineHeight: 1.2,  weight: 600 },
    subheading: { tag: 'h3', name: 'Subheading',   size: 24, lineHeight: 1.3,  weight: 600 },
    paragraph:  { tag: 'p',  name: 'Paragraph',    size: 18, lineHeight: 1.65, weight: 400 },
    small:      { tag: 'p', className: 'text-small', name: 'Small text', size: 14, lineHeight: 1.5, weight: 400 },
  };
  const WEIGHTS = [300, 400, 500, 600, 700, 800, 900];

  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
  const isHex = (c) => /^#[0-9a-f]{6}$/i.test(String(c || ''));
  const toNum = (v, fallback) => { const n = parseFloat(v); return Number.isFinite(n) ? n : fallback; };

  /** Validate design settings, so nothing but known values reaches the CSS. */
  function normalizeTheme(t = {}) {
    return {
      primaryColor: isHex(t.primaryColor) ? t.primaryColor.toLowerCase() : DEFAULT_THEME.primaryColor,
      secondaryColor: isHex(t.secondaryColor) ? t.secondaryColor.toLowerCase() : DEFAULT_THEME.secondaryColor,
      fontFamily: FONTS[t.fontFamily] || t.fontFamily === 'custom' ? t.fontFamily : DEFAULT_THEME.fontFamily,
      borderRadius: clamp(toInt(t.borderRadius, DEFAULT_THEME.borderRadius), 0, 40),
      blockSpacing: clamp(toInt(t.blockSpacing, DEFAULT_THEME.blockSpacing), 4, 48),
    };
  }

  const FONT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ]{0,59}$/;

  /**
   * The font escape hatch: understand whatever she pastes —
   *   a font name                       "Dancing Script"
   *   a Google Fonts link               https://fonts.googleapis.com/css2?family=Dancing+Script&display=swap
   *   an @import line                   @import url('https://fonts.googleapis.com/css2?family=…');
   *   a <link> tag copied from Google   <link href="https://fonts.googleapis.com/css2?family=…" rel="stylesheet">
   * Only fonts.googleapis.com is accepted, and the URL is rebuilt from the
   * parsed family names, so nothing else can be injected into the CSS.
   * @returns {{name: string, url: string} | null}
   */
  function parseCustomFont(input) {
    const text = String(input || '').trim();
    if (!text) return null;
    const urlMatch = text.match(/https:\/\/fonts\.googleapis\.com\/css2?\?[^\s"')<>]+/i);
    let families = [];
    if (urlMatch) {
      let url;
      try { url = new URL(urlMatch[0].replace(/&amp;/g, '&')); } catch { return null; }
      families = url.searchParams.getAll('family').map((f) => f.split(':')[0].replace(/\+/g, ' ').trim());
      if (!families.length) return null;
    } else if (/[<>:;(){}"'\\/]/.test(text)) {
      return null; // looks like code, but not a Google Fonts link
    } else {
      families = [text.replace(/\s+/g, ' ')];
    }
    families = families.filter((f) => FONT_NAME_RE.test(f)).slice(0, 3);
    if (!families.length) return null;
    const query = families.map((f) => `family=${f.replace(/ /g, '+')}:wght@300;400;600;700`).join('&');
    return { name: families[0], url: `https://fonts.googleapis.com/css2?${query}&display=swap` };
  }

  function normalizeTypography(t = {}) {
    const styles = {};
    for (const [key, def] of Object.entries(TEXT_STYLES)) {
      const s = (t.styles && t.styles[key]) || {};
      const weight = toInt(s.weight, def.weight);
      styles[key] = {
        name: String(s.name || def.name).trim().slice(0, 30) || def.name,
        // '' = the website's font; otherwise a FONTS key or 'custom'
        font: FONTS[s.font] || s.font === 'custom' ? s.font : '',
        size: clamp(toInt(s.size, def.size), 10, 120),
        lineHeight: Math.round(clamp(toNum(s.lineHeight, def.lineHeight), 0.9, 2.6) * 100) / 100,
        weight: WEIGHTS.includes(weight) ? weight : def.weight,
      };
    }
    const custom = t.customFont && parseCustomFont(t.customFont.url || t.customFont.name);
    return { styles, customFont: custom };
  }

  /** CSS stack + Google Fonts family for a font key ('custom' = her own Google font). */
  function fontInfo(key, ty) {
    if (key === 'custom' && ty.customFont) {
      return { stack: `"${ty.customFont.name}", ${FONTS.modern.stack}`, families: ty.customFont.url.match(/family=[^&]+/g).map((f) => f.slice(7)) };
    }
    const f = FONTS[key] || FONTS[DEFAULT_THEME.fontFamily];
    return { stack: f.stack, families: f.google ? [f.google] : [] };
  }

  /** The website font, plus one Google Fonts URL loading every font in use. */
  function fontOf(theme, typography) {
    const t = normalizeTheme(theme);
    const ty = normalizeTypography(typography);
    const site = fontInfo(t.fontFamily === 'custom' && !ty.customFont ? DEFAULT_THEME.fontFamily : t.fontFamily, ty);
    const families = new Set(site.families);
    for (const s of Object.values(ty.styles)) if (s.font) fontInfo(s.font, ty).families.forEach((f) => families.add(f));
    const url = families.size ? `https://fonts.googleapis.com/css2?${[...families].map((f) => `family=${f}`).join('&')}&display=swap` : '';
    return { stack: site.stack, url };
  }

  /** The site-wide design variables. */
  function themeVariables(theme, typography) {
    const t = normalizeTheme(theme);
    const ty = normalizeTypography(typography);
    const vars = {
      '--primary-color': t.primaryColor,
      '--secondary-color': t.secondaryColor,
      '--border-radius': `${t.borderRadius}px`,
      '--font-family': fontOf(theme, typography).stack,
      '--block-spacing': `${t.blockSpacing}px`,
    };
    for (const [key, s] of Object.entries(ty.styles)) {
      vars[`--text-${key}-font`] = s.font ? fontInfo(s.font, ty).stack : 'var(--font-family)';
      vars[`--text-${key}-size`] = `${s.size}px`;
      vars[`--text-${key}-line-height`] = String(s.lineHeight);
      vars[`--text-${key}-weight`] = String(s.weight);
    }
    return vars;
  }

  /** global.css = font @import + the variables + Pebble's base stylesheet (lib/site-base.css). */
  function globalCss(theme, baseCss, typography) {
    const font = fontOf(theme, typography);
    const vars = Object.entries(themeVariables(theme, typography)).map(([k, v]) => `  ${k}: ${v};`).join('\n');
    const imports = font.url && /^https:\/\/fonts\.googleapis\.com\/css2\?[A-Za-z0-9+:;@=&.%_-]+$/.test(font.url)
      ? `@import url("${font.url}");\n` : '';
    return `${imports}/* Made by Pebble from your Site Settings. Pebble rewrites this file:
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

  const DEFAULT_HERO = { enabled: false, src: '', position: 'below', size: 'medium' };

  function normalizeHero(h = {}) {
    return {
      enabled: !!h.enabled && !!safeUrl(h.src, 'image'),
      src: safeUrl(h.src, 'image'),
      position: h.position === 'behind' ? 'behind' : 'below',
      size: ['small', 'medium', 'large'].includes(h.size) ? h.size : 'medium',
    };
  }

  /** Logo (in the header) and favicon (the little icon in the browser tab). */
  function normalizeBranding(b = {}) {
    return {
      logo: safeUrl(b.logo, 'image'),
      logoHeight: clamp(toInt(b.logoHeight, 44), 16, 140),
      logoMode: b.logoMode === 'logo' ? 'logo' : 'logo-name', // logo only, or logo + website name
      favicon: safeUrl(b.favicon, 'image'),
    };
  }

  function defaultConfig(siteName) {
    return {
      generator: 'Pebble',
      version: VERSION,
      siteName: siteName || 'My website',
      pages: [{ file: 'index.html', title: 'Home', showInNavbar: true }],
      posts: [],
      blogPage: '',
      header: { hero: { ...DEFAULT_HERO } },
      branding: normalizeBranding(),
      theme: { ...DEFAULT_THEME },
      typography: normalizeTypography(),
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
      blogPage: pages.some((p) => p.file === c.blogPage) ? c.blogPage : '',
      header: { hero: normalizeHero(c.header && c.header.hero) },
      branding: normalizeBranding(c.branding),
      theme: normalizeTheme(c.theme),
      typography: normalizeTypography(c.typography),
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
      defaults: () => ({ src: '', caption: '', alt: '', href: '', radius: '' }),
      render(d, ctx) {
        const src = safeUrl(d.src, 'image');
        const caption = String(d.caption || '').trim();
        const radius = radiusOf(d.radius);
        const attrs = radius !== '' ? { 'data-radius': String(radius) } : {};
        const style = radius !== '' ? `--block-radius:${radius}px` : '';
        if (!src) return { classes: ['block-image--empty'], attrs, style, inner: '<div class="block-image__media"></div>' };
        // alt text: her description, else the caption, else "Photo"
        let img = `<img src="${escapeAttr(toPageUrl(src, ctx.root))}" alt="${escapeAttr(String(d.alt || '').trim() || caption || 'Photo')}" loading="lazy">`;
        const href = safeUrl(d.href, 'link');
        if (href) img = `<a class="block-image__link" href="${escapeAttr(toPageUrl(href, ctx.root))}">${img}</a>`;
        return {
          attrs,
          style,
          inner: `<div class="block-image__media">${img}</div>` +
            (caption ? `\n        <figcaption class="block-image__caption">${escapeHtml(caption)}</figcaption>` : ''),
        };
      },
      parse(el, ctx) {
        const img = el.querySelector('img');
        const cap = el.querySelector('figcaption');
        const link = el.querySelector('.block-image__link');
        const caption = cap ? cap.textContent.trim() : '';
        const alt = img ? (img.getAttribute('alt') || '').trim() : '';
        return {
          src: img ? safeUrl(fromPageUrl(img.getAttribute('src'), ctx.root), 'image') : '',
          caption,
          alt: alt === caption || alt === 'Photo' ? '' : alt,
          href: link ? safeUrl(fromPageUrl(link.getAttribute('href'), ctx.root), 'link') : '',
          radius: el.hasAttribute('data-radius') ? radiusOf(el.getAttribute('data-radius')) : '',
        };
      },
    },

    card: {
      tag: 'article',
      defaults: () => ({ src: '', title: '', html: '', href: '', linkLabel: 'Read more', bg: '', textColor: '', border: 'accent' }),
      render(d, ctx) {
        const src = safeUrl(d.src, 'image');
        const href = safeUrl(d.href, 'link');
        const border = CARD_BORDERS.includes(d.border) ? d.border : 'accent';
        const attrs = {};
        const style = [];
        if (isHex(d.bg)) { attrs['data-bg'] = d.bg.toLowerCase(); style.push(`--card-bg:${d.bg.toLowerCase()}`); }
        if (isHex(d.textColor)) { attrs['data-text-color'] = d.textColor.toLowerCase(); style.push(`--card-text:${d.textColor.toLowerCase()}`); }
        if (border !== 'accent') attrs['data-border'] = border;
        const media = src ? `<div class="block-card__media"><img src="${escapeAttr(toPageUrl(src, ctx.root))}" alt="" loading="lazy"></div>` : '';
        const link = href ? `<a class="block-card__link" href="${escapeAttr(toPageUrl(href, ctx.root))}">${escapeHtml(d.linkLabel || 'Read more')}</a>` : '';
        return {
          classes: border !== 'accent' ? [`block-card--${border}`] : [],
          attrs,
          style: style.join(';'),
          inner: `${media}<div class="block-card__body"><h3 class="block-card__title">${escapeHtml(d.title || '')}</h3>` +
            `<div class="block-card__text rich-text">${richOut(d.html, ctx)}</div>${link}</div>`,
        };
      },
      parse(el, ctx) {
        const img = el.querySelector('.block-card__media img');
        const a = el.querySelector('.block-card__link');
        const bg = el.getAttribute('data-bg');
        const tc = el.getAttribute('data-text-color');
        const border = el.getAttribute('data-border');
        return {
          src: img ? safeUrl(fromPageUrl(img.getAttribute('src'), ctx.root), 'image') : '',
          title: (el.querySelector('.block-card__title') || { textContent: '' }).textContent.trim(),
          html: richIn((el.querySelector('.block-card__text') || { innerHTML: '' }).innerHTML, ctx),
          href: a ? safeUrl(fromPageUrl(a.getAttribute('href'), ctx.root), 'link') : '',
          linkLabel: a ? a.textContent.trim() : 'Read more',
          bg: isHex(bg) ? bg.toLowerCase() : '',
          textColor: isHex(tc) ? tc.toLowerCase() : '',
          border: CARD_BORDERS.includes(border) ? border : 'accent',
        };
      },
    },

    button: {
      tag: 'div',
      defaults: () => ({ label: 'Click here', href: '', style: 'primary', align: 'left' }),
      render(d, ctx) {
        // primary = main color, accent = second color, secondary = outline
        const style = ['secondary', 'accent'].includes(d.style) ? d.style : 'primary';
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
          style: a && a.classList.contains('block-button__link--secondary') ? 'secondary'
            : a && a.classList.contains('block-button__link--accent') ? 'accent' : 'primary',
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
      render(d, ctx) {
        const b = normalizeBranding(ctx.config.branding);
        const logo = b.logo ? `<img class="site-title__logo" src="${escapeAttr(toPageUrl(b.logo, ctx.root))}" alt="${b.logoMode === 'logo' ? escapeAttr(ctx.config.siteName) : ''}" style="height:${b.logoHeight}px">` : '';
        const name = !b.logo || b.logoMode === 'logo-name' ? `<span class="site-title__name">${escapeHtml(ctx.config.siteName)}</span>` : '';
        return { inner: `<a class="site-title" href="${ctx.root}index.html">${logo}${name}</a>` };
      },
      parse: () => ({}),
    },

    menu: {
      tag: 'nav',
      defaults: () => ({ align: 'right' }),
      render(d, ctx) {
        const align = ['left', 'center', 'right'].includes(d.align) ? d.align : 'right';
        const items = ctx.config.pages.filter((p) => p.showInNavbar).map((p) =>
          `<li><a href="${escapeAttr(toPageUrl(p.file, ctx.root))}"${p.file === ctx.file ? ' aria-current="page"' : ''}>${escapeHtml(p.title)}</a></li>`);
        // Phones: the list folds behind a hamburger button. No JavaScript —
        // a hidden checkbox and its <label> open and close it.
        const id = `site-menu-${ctx.blockKey || '0'}`;
        return {
          classes: [`block-menu--${align}`],
          attrs: { 'aria-label': 'Site menu' },
          inner: `<input class="site-menu__toggle" type="checkbox" id="${id}" aria-label="Open the menu">` +
            `<label class="site-menu__burger" for="${id}" aria-hidden="true"><span></span><span></span><span></span></label>` +
            `<ul class="site-menu">${items.join('')}</ul>`,
        };
      },
      parse: (el) => ({ align: ['left', 'center'].find((x) => el.classList.contains(`block-menu--${x}`)) || 'right' }),
    },
  };

  const CARD_BORDERS = ['accent', 'outline', 'shadow', 'none'];
  /** '' (= the site's roundness) or a number of pixels 0–40. */
  function radiusOf(v) {
    if (v === '' || v == null) return '';
    const n = toInt(v, NaN);
    return Number.isFinite(n) ? clamp(n, 0, 40) : '';
  }

  /** Where each block may be used (the editor's Add menu follows this). */
  const REGION_ONLY = { 'site-title': ['header', 'footer'], menu: ['header', 'footer'] };

  function sortBlocks(blocks) {
    return blocks.slice().sort((a, b) => (a.y - b.y) || (a.x - b.x));
  }

  /** One block → HTML. Position is written as data (for Pebble) and as CSS Grid lines (for visitors). */
  function renderBlock(b, ctx, indent = '      ') {
    const def = BLOCKS[b.type];
    ctx.blockKey = `${b.x}-${b.y}`;
    const r = def.render({ ...def.defaults(), ...b.data }, ctx);
    const classes = ['editor-block', `block-${b.type}`, ...(r.classes || [])].join(' ');
    const extra = Object.entries(r.attrs || {}).map(([k, v]) => ` ${k}="${escapeAttr(v)}"`).join('');
    const tag = r.tag || def.tag;
    const style = `grid-column:${b.x + 1} / span ${b.w};grid-row:${b.y + 1} / span ${b.h}` + (r.style ? `;${r.style}` : '');
    return `${indent}<${tag} class="${classes}" data-widget-type="${b.type}" data-gs-x="${b.x}" data-gs-y="${b.y}" data-gs-w="${b.w}" data-gs-h="${b.h}"${extra} ` +
      `style="${escapeAttr(style)}">\n${indent}  ${r.inner}\n${indent}</${tag}>`;
  }

  function renderBlocks(blocks, ctx, indent = '      ') {
    return sortBlocks(blocks.filter((b) => BLOCKS[b.type])).map((b) => renderBlock(b, ctx, indent)).join('\n\n');
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

  /**
   * The header or footer. The header may carry a hero image (Header settings):
   *   behind → a large photo behind the website name and menu
   *   below  → a wide banner photo under the menu
   */
  function renderRegion(kind, blocks, ctx) {
    const tag = kind === 'header' ? 'header' : 'footer';
    const hero = kind === 'header' ? normalizeHero(ctx.config.header && ctx.config.header.hero) : { enabled: false };
    const grid = `    <div class="region-grid" data-columns="${COLUMNS}">\n${renderBlocks(blocks, ctx)}\n    </div>`;
    if (!hero.enabled) return `  <${tag} class="site-${kind}" data-pebble-region="${kind}">\n${grid}\n  </${tag}>`;
    const img = `<img src="${escapeAttr(toPageUrl(hero.src, ctx.root))}" alt="">`;
    if (hero.position === 'behind') {
      return `  <header class="site-header site-header--hero site-header--hero-${hero.size}" data-pebble-region="header">\n` +
        `    <div class="site-hero__bg">${img}</div>\n${grid}\n  </header>`;
    }
    return `  <header class="site-header" data-pebble-region="header">\n${grid}\n` +
      `    <div class="site-hero site-hero--${hero.size}">${img}</div>\n  </header>`;
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
     SECTIONS — a page is a list of ROWS; a row holds 1–3 SECTIONS side by
     side (e.g. 70% + 30%); each section has its own background and its own
     12-column grid of blocks.

       row:     { sections: [section, …] }
       section: { width: 70, style: {bgColor, bgImage, overlayColor, overlayOpacity, tone}, blocks: [...] }

     Published as:
       <div class="section-row section-row--full|--split" data-pebble-row style="--row-columns:70fr 30fr">
         <section class="page-section" data-pebble-section data-width="70" data-bg-…>
           <div class="page-section__bg"><img …></div>        (background photo)
           <div class="page-section__overlay" style="…"></div> (colour over the photo)
           <div class="region-grid section-grid" data-pebble-grid data-columns="12"> blocks </div>
         </section>
       </div>
     ======================================================================== */

  /** Row layouts she can choose (widths in %). */
  const ROW_LAYOUTS = {
    one:   { label: 'One section',             widths: [100] },
    half:  { label: 'Two equal sections',      widths: [50, 50] },
    main:  { label: 'Wide + narrow',           widths: [70, 30] },
    side:  { label: 'Narrow + wide',           widths: [30, 70] },
    three: { label: 'Three equal sections',    widths: [33, 34, 33] },
  };

  function normalizeSectionStyle(st = {}) {
    const bgImage = safeUrl(st.bgImage, 'image');
    return {
      bgColor: isHex(st.bgColor) ? st.bgColor.toLowerCase() : '',
      bgImage,
      overlayColor: isHex(st.overlayColor) ? st.overlayColor.toLowerCase() : '#000000',
      overlayOpacity: clamp(toInt(st.overlayOpacity, bgImage ? 30 : 0), 0, 90),
      tone: st.tone === 'light' ? 'light' : 'dark',   // light = white text (for dark backgrounds)
    };
  }

  function newSection(width = 100, blocks = []) {
    return { width, style: normalizeSectionStyle(), blocks };
  }

  /** Clean up rows read from anywhere (files, local copies, older formats). */
  function normalizeRows(rows) {
    const out = [];
    for (const r of Array.isArray(rows) ? rows : []) {
      let sections = (Array.isArray(r && r.sections) ? r.sections : []).slice(0, 3).map((s) => ({
        width: clamp(toInt(s.width, 100), 15, 100),
        style: normalizeSectionStyle(s.style),
        blocks: Array.isArray(s.blocks) ? s.blocks.filter((b) => b && BLOCKS[b.type]) : [],
      }));
      if (!sections.length) continue;
      const total = sections.reduce((t, s) => t + s.width, 0);
      if (total !== 100) {
        const each = Math.floor(100 / sections.length);
        sections = sections.map((s, i) => ({ ...s, width: i === sections.length - 1 ? 100 - each * (sections.length - 1) : each }));
      }
      out.push({ sections });
    }
    return out.length ? out : [{ sections: [newSection(100, [])] }];
  }

  /** Older pages (one grid of blocks) become one full-width section. */
  const rowsFromBlocks = (blocks) => [{ sections: [newSection(100, blocks || [])] }];
  const blocksOfRows = (rows) => (rows || []).flatMap((r) => r.sections.flatMap((s) => s.blocks));

  function renderRows(rows, ctx) {
    return normalizeRows(rows).map((row) => {
      const full = row.sections.length === 1;
      const cols = row.sections.map((s) => `${s.width}fr`).join(' ');
      const sections = row.sections.map((s) => {
        const st = s.style;
        const attrs = [`data-width="${s.width}"`];
        const css = [];
        if (st.bgColor) { attrs.push(`data-bg-color="${st.bgColor}"`); css.push(`--section-bg:${st.bgColor}`); }
        if (st.bgImage) attrs.push(`data-bg-image="${escapeAttr(st.bgImage)}"`);
        if (st.overlayOpacity > 0) attrs.push(`data-overlay-color="${st.overlayColor}" data-overlay-opacity="${st.overlayOpacity}"`);
        if (st.tone === 'light') attrs.push('data-tone="light"');
        const layers = [];
        if (st.bgImage) layers.push(`        <div class="page-section__bg"><img src="${escapeAttr(toPageUrl(st.bgImage, ctx.root))}" alt=""></div>`);
        if (st.overlayOpacity > 0) layers.push(`        <div class="page-section__overlay" style="background:${st.overlayColor};opacity:${(st.overlayOpacity / 100).toFixed(2)}"></div>`);
        const cls = ['page-section', st.tone === 'light' ? 'page-section--light' : '', st.bgColor || st.bgImage ? 'page-section--filled' : ''].filter(Boolean).join(' ');
        return `      <section class="${cls}" data-pebble-section ${attrs.join(' ')}${css.length ? ` style="${css.join(';')}"` : ''}>\n` +
          (layers.length ? layers.join('\n') + '\n' : '') +
          `        <div class="region-grid section-grid" data-pebble-grid data-columns="${COLUMNS}">\n` +
          `${renderBlocks(s.blocks, ctx, '          ')}\n        </div>\n      </section>`;
      }).join('\n');
      return `    <div class="section-row section-row--${full ? 'full' : 'split'}" data-pebble-row${full ? '' : ` style="--row-columns:${cols}"`}>\n${sections}\n    </div>`;
    }).join('\n\n');
  }

  function parseRows(main, ctx) {
    const rowEls = Array.from(main.querySelectorAll(':scope > [data-pebble-row]'));
    if (!rowEls.length) {
      // An older page: a single grid of blocks.
      const grid = main.querySelector('[data-pebble-grid]');
      return rowsFromBlocks(parseBlocks(grid || main, ctx));
    }
    return normalizeRows(rowEls.map((row) => ({
      sections: Array.from(row.querySelectorAll(':scope > [data-pebble-section]')).map((sec) => ({
        width: toInt(sec.getAttribute('data-width'), 100),
        style: {
          bgColor: sec.getAttribute('data-bg-color') || '',
          bgImage: fromPageUrl(sec.getAttribute('data-bg-image') || '', ctx.root),
          overlayColor: sec.getAttribute('data-overlay-color') || '#000000',
          overlayOpacity: toInt(sec.getAttribute('data-overlay-opacity'), 0),
          tone: sec.getAttribute('data-tone') === 'light' ? 'light' : 'dark',
        },
        blocks: parseBlocks(sec.querySelector(':scope > [data-pebble-grid]'), ctx),
      })),
    })));
  }

  /* ========================================================================
     STITCHING — one complete, standalone page
     ======================================================================== */

  /**
   * @param {{file, kind: 'page'|'post', rows}} doc
   * @param {{config, header: block[], footer: block[]}} site
   * @param {object} [opts] { inlineCss: string } → embed CSS instead of linking (preview)
   */
  function stitchPage(doc, site, opts = {}) {
    const config = site.config;
    const ctx = makeCtx(config, doc.file);
    const isPost = doc.kind === 'post';
    const meta = (isPost ? config.posts : config.pages).find((p) => p.file === doc.file) || { title: nameFromFile(doc.file) };
    const branding = normalizeBranding(config.branding);

    const styles = opts.inlineCss != null
      ? `<style>\n${String(opts.inlineCss).replace(/<\/style/gi, '<\\/style')}\n  </style>`
      : `<link rel="stylesheet" href="${ctx.root}global.css">` + (config.customCss ? `\n  <link rel="stylesheet" href="${ctx.root}theme.css">` : '');
    const description = isPost && meta.excerpt ? `\n  <meta name="description" content="${escapeAttr(meta.excerpt)}">` : '';
    const favicon = branding.favicon ? `\n  <link rel="icon" href="${escapeAttr(toPageUrl(branding.favicon, ctx.root))}">` : '';

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
  <title>${escapeHtml(meta.title)} – ${escapeHtml(config.siteName)}</title>${description}${favicon}
  ${styles}
</head>
<body class="${isPost ? 'is-post' : 'is-page'}">
  <!--
    Made with Pebble: plain HTML, no database, no JavaScript.
    The header and footer come from header.html / footer.html, menu and blog
    posts from site-config.json. data-pebble-* / data-gs-* let Pebble re-open it.
  -->
${renderRegion('header', site.header, ctx)}

  <main class="site-main" id="main" data-pebble-page data-page-name="${escapeAttr(meta.title)}"${isPost ? ' data-post' : ''}>
${postHeader}${renderRows(doc.rows, ctx)}
  </main>

${renderRegion('footer', site.footer, ctx)}
</body>
</html>
`;
  }

  /**
   * Read a page back (rows of sections). Also works for pages from older
   * Pebble versions, and reports what their header said for upgrading.
   */
  function parsePage(html, file) {
    const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
    const main = doc.querySelector('[data-pebble-page]') || doc.querySelector('main') || doc.body;
    const grid = doc.querySelector('[data-pebble-grid]');
    const titleName = (doc.title || '').split(' – ')[0].trim();
    const siteNameEl = doc.querySelector('.site-title__name, .site-title, .site-name');
    const ctx = makeCtx(defaultConfig(), file);
    const rows = parseRows(main, ctx);
    return {
      rows,
      blocks: blocksOfRows(rows),
      name: ((main.getAttribute && main.getAttribute('data-page-name')) || (grid && grid.getAttribute('data-page-name')) || titleName || nameFromFile(file)).trim(),
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

  /** Pages/posts may still be in the old shape ({blocks}); give them rows. */
  const rowsOf = (doc) => (doc.rows ? doc.rows : rowsFromBlocks(doc.blocks));

  /**
   * Every file of the website, rendered from data. The caller commits only
   * the ones whose text differs from what's in the repository.
   * @returns {Object<string, string>} path → file content
   */
  function buildSiteFiles(site, { baseCss }) {
    const config = normalizeConfig(site.config);
    const customCss = String(site.customCss || '');
    config.customCss = customCss.trim().length > 0;

    for (const post of config.posts) {
      const doc = site.docs[post.file];
      if (doc && (post.excerptAuto || !post.excerpt)) {
        post.excerpt = excerptFrom(blocksOfRows(rowsOf(doc)));
        post.excerptAuto = true;
      }
    }

    const header = (site.docs['header.html'] || { blocks: [] }).blocks;
    const footer = (site.docs['footer.html'] || { blocks: [] }).blocks;
    const files = {
      'site-config.json': JSON.stringify(config, null, 2) + '\n',
      'global.css': globalCss(config.theme, baseCss, config.typography),
      'header.html': partialToHtml('header', header, config),
      'footer.html': partialToHtml('footer', footer, config),
    };
    if (config.customCss) files['theme.css'] = customCss.endsWith('\n') ? customCss : customCss + '\n';

    for (const p of config.pages) {
      const doc = site.docs[p.file];
      if (doc) files[p.file] = stitchPage({ file: p.file, kind: 'page', rows: rowsOf(doc) }, { config, header, footer });
    }
    for (const p of config.posts) {
      const doc = site.docs[p.file];
      if (doc) files[p.file] = stitchPage({ file: p.file, kind: 'post', rows: rowsOf(doc) }, { config, header, footer });
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
          rows: rowsFromBlocks([{ type: 'text', x: 0, y: 0, w: 12, h: 3, data: { html: `<h2>${escapeHtml(title)}</h2><p>Welcome! This website is brand new — come back soon.</p>` } }]),
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
    for (const f of files) docs[f] = { kind: 'page', rows: parsed[f].rows };
    return { config: normalizeConfig(config), customCss: '', docs };
  }

  window.PebbleLegacy = {
    COLUMNS, VERSION, FONTS, DEFAULT_THEME, BLOCKS, REGION_ONLY, TEXT_STYLES, WEIGHTS, HIGHLIGHTS, CARD_BORDERS, ROW_LAYOUTS,
    escapeHtml, escapeAttr, safeUrl, sanitizeRichText,
    docRoot, toPageUrl, fromPageUrl,
    normalizeTheme, normalizeTypography, normalizeHero, normalizeBranding, parseCustomFont, themeVariables, globalCss,
    defaultConfig, normalizeConfig, formatDate, todayIso, sortedPosts, nameFromFile, slugify, excerptFrom,
    sortBlocks, renderBlock, renderBlocks, parseBlocks, makeCtx,
    normalizeSectionStyle, normalizeRows, newSection, rowsFromBlocks, blocksOfRows, renderRows, parseRows,
    renderRegion, partialToHtml, partialFromHtml, defaultHeaderBlocks, defaultFooterBlocks,
    stitchPage, parsePage, isPebblePage,
    buildSiteFiles, starterSite, upgradeLegacySite,
    PAGE_FILE_RE, POST_FILE_RE,
  };
})();
