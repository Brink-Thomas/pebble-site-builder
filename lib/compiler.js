/* ==========================================================================
   PebbleCompiler — site.json in, static website out.

     compileToStaticHTML(site, key)   one page or post → a complete HTML file
     compileSite(site, { baseCss })   every file of the website:
                                        site.json   the state, for the editor
                                        global.css  design variables + base styles
                                        theme.css   (only if a helper wrote CSS)
                                        *.html, blog/*.html

   The output is plain, readable HTML: no data attributes, no ids, no
   JavaScript. Visitors (and search engines) get exactly what's on screen.
   The same site always compiles to the same text, so only files that really
   changed are committed.
   ========================================================================== */

(function () {
  'use strict';

  const D = window.PebbleDesign;
  const S = window.PebbleState;
  const esc = D.escapeHtml;
  const attr = D.escapeAttr;

  /** Rich text as it goes into a page: cleaned, links adjusted for blog/ pages. */
  const rich = (html, ctx) => D.rewriteUrls(D.sanitizeRichText(html), (u) => D.toPageUrl(u, ctx.root));
  const url = (u, ctx) => attr(D.toPageUrl(u, ctx.root));

  /* ========================================================================
     BLOCKS → HTML
       Each renderer returns { tag?, cls?, style?, inner }.
       ctx = { site, file, root, n }  (root = "" or "../"; n counts menus)
     ======================================================================== */

  const RENDER = {
    text: (d, ctx) => ({ tag: 'section', inner: `<div class="block-text__content rich-text">${rich(d.html, ctx)}</div>` }),

    image(d, ctx) {
      const src = D.safeUrl(d.src, 'image');
      const style = [];
      if (d.radius !== '' && d.radius != null) style.push(`--block-radius:${d.radius}px`);
      if (d.ratio && d.ratio !== 'auto') style.push(`--ratio:${d.ratio}`);
      if (!src) return { tag: 'figure', cls: ['block-image--empty'], style, inner: '<div class="block-image__media"></div>' };
      const caption = String(d.caption || '').trim();
      let img = `<img src="${url(src, ctx)}" alt="${attr(String(d.alt || '').trim() || caption || 'Photo')}" loading="lazy">`;
      const href = D.safeUrl(d.href, 'link');
      if (href) img = `<a class="block-image__link" href="${url(href, ctx)}">${img}</a>`;
      return {
        tag: 'figure',
        cls: d.ratio && d.ratio !== 'auto' ? ['block-image--cropped'] : [],
        style,
        inner: `<div class="block-image__media">${img}</div>` + (caption ? `<figcaption class="block-image__caption">${esc(caption)}</figcaption>` : ''),
      };
    },

    card(d, ctx) {
      const src = D.safeUrl(d.src, 'image');
      const href = D.safeUrl(d.href, 'link');
      const style = [];
      if (D.isHex(d.bg)) style.push(`--card-bg:${d.bg}`);
      if (D.isHex(d.textColor)) style.push(`--card-text:${d.textColor}`);
      return {
        tag: 'article',
        cls: d.border && d.border !== 'accent' ? [`block-card--${d.border}`] : [],
        style,
        inner: (src ? `<div class="block-card__media"><img src="${url(src, ctx)}" alt="" loading="lazy"></div>` : '') +
          `<div class="block-card__body"><h3 class="block-card__title">${esc(d.title || '')}</h3>` +
          `<div class="block-card__text rich-text">${rich(d.html, ctx)}</div>` +
          (href ? `<a class="block-card__link" href="${url(href, ctx)}">${esc(d.linkLabel || 'Read more')}</a>` : '') + '</div>',
      };
    },

    button(d, ctx) {
      const href = D.safeUrl(d.href, 'link') || '#';
      return {
        cls: [`block-button--${d.align || 'left'}`],
        inner: `<a class="block-button__link block-button__link--${d.style || 'primary'}" href="${url(href, ctx)}">${esc(d.label || 'Click here')}</a>`,
      };
    },

    'blog-feed'(d, ctx) {
      const posts = S.sortedPosts(ctx.site).slice(0, d.limit || undefined);
      if (!posts.length) return { tag: 'section', inner: '<p class="blog-feed__empty">No blog posts yet.</p>' };
      const cards = posts.map((p) => {
        const thumb = D.safeUrl(p.thumbnail, 'image');
        return `<a class="blog-card" href="${url(p.file, ctx)}">` +
          (thumb ? `<div class="blog-card__media"><img src="${url(thumb, ctx)}" alt="" loading="lazy"></div>` : '') +
          `<div class="blog-card__body"><time class="blog-card__date" datetime="${p.date}">${esc(D.formatDate(p.date))}</time>` +
          `<h3 class="blog-card__title">${esc(p.title)}</h3>` +
          (p.excerpt ? `<p class="blog-card__excerpt">${esc(p.excerpt)}</p>` : '') + '</div></a>';
      });
      return { tag: 'section', inner: `<div class="blog-feed">\n${cards.map((c) => `${ctx.indent}    ${c}`).join('\n')}\n${ctx.indent}  </div>` };
    },

    // Raw HTML for website helpers (a map, a video, a form). Copied as-is.
    embed: (d) => ({ inner: String(d.code || '') }),

    'site-title'(d, ctx) {
      const s = ctx.site.settings;
      const b = s.branding;
      const logo = b.logo ? `<img class="site-title__logo" src="${url(b.logo, ctx)}" alt="${b.logoMode === 'logo' ? attr(s.siteName) : ''}" style="height:${b.logoHeight}px">` : '';
      const name = !b.logo || b.logoMode === 'logo-name' ? `<span class="site-title__name">${esc(s.siteName)}</span>` : '';
      return { inner: `<a class="site-title" href="${ctx.root}index.html">${logo}${name}</a>` };
    },

    menu(d, ctx) {
      const items = ctx.site.pages.filter((p) => p.showInNavbar).map((p) =>
        `<li><a href="${url(p.file, ctx)}"${p.file === ctx.file ? ' aria-current="page"' : ''}>${esc(p.title)}</a></li>`);
      // Phones: the list folds behind a menu button. No JavaScript — a
      // hidden checkbox and its <label> open and close it.
      const id = `site-menu-${++ctx.n}`;
      return {
        tag: 'nav',
        cls: [`block-menu--${d.align || 'right'}`],
        attrs: ' aria-label="Site menu"',
        inner: `<input class="site-menu__toggle" type="checkbox" id="${id}" aria-label="Open the menu">` +
          `<label class="site-menu__burger" for="${id}" aria-hidden="true"><span></span><span></span><span></span></label>` +
          `<ul class="site-menu">${items.join('')}</ul>`,
      };
    },
  };

  function renderBlock(block, ctx) {
    const render = RENDER[block.type];
    if (!render) return '';
    const data = S.normalizeBlockData(block.type, block.data);
    const r = render(data, ctx);
    const tag = r.tag || 'div';
    const cls = ['block', `block-${block.type}`, ...(r.cls || [])].join(' ');
    // Width inside the column's 12-column grid (full width needs no rule).
    const span = Math.min(12, Math.max(1, parseInt(block.colSpan, 10) || 12));
    const styles = [...(span < 12 ? [`grid-column:span ${span}`] : []), ...(r.style || [])];
    const style = styles.length ? ` style="${attr(styles.join(';'))}"` : '';
    return `${ctx.indent}<${tag} class="${cls}"${r.attrs || ''}${style}>\n${ctx.indent}  ${r.inner}\n${ctx.indent}</${tag}>`;
  }

  /* ========================================================================
     SECTIONS → HTML
     ======================================================================== */

  function renderSection(section, ctx, indent) {
    const st = S.normalizeSectionStyle(section.style);
    const cls = ['page-section'];
    if (st.bgColor || st.bgImage) cls.push('page-section--filled');
    if (st.tone === 'light') cls.push('page-section--light');
    const style = st.bgColor ? ` style="--section-bg:${st.bgColor}"` : '';
    const layers = [];
    if (st.bgImage) layers.push(`${indent}  <div class="page-section__bg"><img src="${url(st.bgImage, ctx)}" alt=""></div>`);
    if (st.bgImage && st.overlayOpacity > 0) {
      layers.push(`${indent}  <div class="page-section__overlay" style="background:${st.overlayColor};opacity:${(st.overlayOpacity / 100).toFixed(2)}"></div>`);
    }
    const colsCls = ['section-columns'];
    if (st.valign !== 'top') colsCls.push(`section-columns--${st.valign}`);
    const template = section.columns.length > 1 ? ` style="--columns:${section.columns.map((c) => `${c.width}fr`).join(' ')}"` : '';
    const columns = section.columns.map((col) => {
      const filled = D.isHex(col.style && col.style.bgColor);
      const colStyle = filled ? ` style="--column-bg:${col.style.bgColor}"` : '';
      const blockCtx = { ...ctx, indent: `${indent}      ` };
      const blocks = col.blocks.map((b) => { const html = renderBlock(b, blockCtx); ctx.n = blockCtx.n; return html; }).filter(Boolean);
      return `${indent}    <div class="section-column${filled ? ' section-column--filled' : ''}"${colStyle}>` +
        (blocks.length ? `\n${blocks.join('\n')}\n${indent}    ` : '') + '</div>';
    });
    return `${indent}<section class="${cls.join(' ')}"${style}>\n` +
      (layers.length ? layers.join('\n') + '\n' : '') +
      `${indent}  <div class="${colsCls.join(' ')}"${template}>\n${columns.join('\n')}\n${indent}  </div>\n` +
      `${indent}</section>`;
  }

  const renderSections = (sections, ctx, indent) => sections.map((s) => renderSection(s, ctx, indent)).join('\n');

  /** The header (with the optional hero photo) or the footer. */
  function renderRegion(kind, site, ctx) {
    const sections = renderSections(site[kind].sections, ctx, '    ');
    if (kind === 'footer') return `  <footer class="site-footer">\n${sections}\n  </footer>`;
    const hero = D.normalizeHero(site.settings.hero);
    if (!hero.enabled) return `  <header class="site-header">\n${sections}\n  </header>`;
    const img = `<img src="${url(hero.src, ctx)}" alt="">`;
    if (hero.position === 'behind') {
      return `  <header class="site-header site-header--hero site-header--hero-${hero.size}">\n    <div class="site-hero__bg">${img}</div>\n${sections}\n  </header>`;
    }
    return `  <header class="site-header">\n${sections}\n    <div class="site-hero site-hero--${hero.size}">${img}</div>\n  </header>`;
  }

  /* ========================================================================
     ONE PAGE
     ======================================================================== */

  /**
   * @param {object} site  a normalized site
   * @param {string} key   "index.html", "blog/my-post.html" …
   * @param {object} [opts] { inlineCss } → embed the CSS (for the preview)
   */
  function compileToStaticHTML(site, key, opts = {}) {
    const doc = S.getDoc(site, key);
    const kind = S.docKind(site, key);
    if (!doc || (kind !== 'page' && kind !== 'post')) throw new Error(`Not a page or post: ${key}`);
    const s = site.settings;
    const ctx = { site, file: key, root: D.docRoot(key), n: 0, indent: '' };
    const isPost = kind === 'post';

    const styles = opts.inlineCss != null
      ? `<style>\n${String(opts.inlineCss).replace(/<\/style/gi, '<\\/style')}\n  </style>`
      : `<link rel="stylesheet" href="${ctx.root}global.css">` + (s.customCss.trim() ? `\n  <link rel="stylesheet" href="${ctx.root}theme.css">` : '');
    const description = isPost && doc.excerpt ? `\n  <meta name="description" content="${attr(doc.excerpt)}">` : '';
    const favicon = s.branding.favicon ? `\n  <link rel="icon" href="${url(s.branding.favicon, ctx)}">` : '';

    let postHeader = '';
    if (isPost) {
      const cover = D.safeUrl(doc.thumbnail, 'image');
      postHeader = `    <header class="post-header">
      <p class="post-header__date"><time datetime="${doc.date}">${esc(D.formatDate(doc.date))}</time></p>
      <h1 class="post-header__title">${esc(doc.title)}</h1>` +
        (cover ? `\n      <figure class="post-header__cover"><img src="${url(cover, ctx)}" alt=""></figure>` : '') +
        '\n    </header>\n';
    }

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="generator" content="Pebble">
  <title>${esc(doc.title)} – ${esc(s.siteName)}</title>${description}${favicon}
  ${styles}
</head>
<body class="${isPost ? 'is-post' : 'is-page'}">
  <!-- Made with Pebble. Pebble edits site.json and rewrites this file from it. -->
${renderRegion('header', site, ctx)}

  <main class="site-main" id="main">
${postHeader}${renderSections(doc.sections, ctx, '    ')}
  </main>

${renderRegion('footer', site, ctx)}
</body>
</html>
`;
  }

  /* ========================================================================
     THE WHOLE SITE
     ======================================================================== */

  /** A summary from the first words of a post's text. */
  function excerptFrom(doc, max = 160) {
    const tpl = document.createElement('template');
    for (const b of S.blocksOf(doc)) {
      if (b.type !== 'text' && b.type !== 'card') continue;
      tpl.innerHTML = b.data.html || '';
      tpl.content.querySelectorAll('h1, h2, h3').forEach((h) => h.remove());
      tpl.content.querySelectorAll('p, li, br').forEach((el) => el.after(' '));
      const text = tpl.content.textContent.replace(/\s+/g, ' ').trim();
      if (!text) continue;
      return text.length <= max ? text : text.slice(0, max).replace(/\s+\S*$/, '') + '…';
    }
    return '';
  }

  /** Fill in the automatic summaries of blog posts (they're part of the state). */
  function withExcerpts(site) {
    for (const p of site.posts) if (p.excerptAuto) p.excerpt = excerptFrom(p);
    return site;
  }

  /**
   * Every file of the website. The caller commits only the ones whose text
   * differs from the repository.
   * @returns {Object<string,string>} path → content
   */
  function compileSite(rawSite, { baseCss }) {
    const site = withExcerpts(S.normalizeSite(JSON.parse(JSON.stringify(rawSite))));
    const s = site.settings;
    const files = {
      'site.json': JSON.stringify(site, null, 2) + '\n',
      'global.css': D.globalCss(s.theme, baseCss, s.typography),
    };
    if (s.customCss.trim()) files['theme.css'] = s.customCss.endsWith('\n') ? s.customCss : s.customCss + '\n';
    for (const p of site.pages) files[p.file] = compileToStaticHTML(site, p.file);
    for (const p of site.posts) files[p.file] = compileToStaticHTML(site, p.file);
    return files;
  }

  /** Is this text a page compiled by Pebble (any version)? */
  const isPebblePage = (html) => /<meta name="generator" content="Pebble">|\bdata-pebble-grid\b/.test(String(html || ''));

  window.PebbleCompiler = { compileToStaticHTML, compileSite, renderBlock, renderSection, renderRegion, excerptFrom, withExcerpts, isPebblePage };
})();
