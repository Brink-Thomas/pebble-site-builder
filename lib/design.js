/* ==========================================================================
   PebbleDesign — shared building blocks for the site model, the compiler and
   the editor:

     - safety: HTML escaping, URL checks, the rich-text allow-list
     - links: paths are stored relative to the site root; pages inside blog/
       get "../" in front when compiled
     - the design system: fonts, text styles, theme → CSS variables → global.css
     - hero image and branding (logo, favicon) settings
     - small helpers: dates, slugs, names

   Everything that reaches HTML or CSS goes through a function in this file.
   ========================================================================== */

(function () {
  'use strict';

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

  /* ========================================================================
     HERO IMAGE & BRANDING
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

  /* ========================================================================
     SMALL HELPERS
     ======================================================================== */

  const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));

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

  window.PebbleDesign = {
    FONTS, DEFAULT_THEME, TEXT_STYLES, WEIGHTS, HIGHLIGHTS, DEFAULT_HERO,
    escapeHtml, escapeAttr, safeUrl, sanitizeRichText, b64encode, b64decode,
    docRoot, toPageUrl, fromPageUrl, rewriteUrls,
    clamp, isHex, isDate, toInt, toNum,
    normalizeTheme, normalizeTypography, normalizeHero, normalizeBranding, parseCustomFont,
    fontInfo, fontOf, themeVariables, globalCss,
    todayIso, formatDate, nameFromFile, slugify,
  };
})();
