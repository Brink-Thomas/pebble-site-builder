/* ==========================================================================
   The editor's panels: top bar, sidebar (pages / blog posts), Inspector,
   the "+" Library and the toast.
   ========================================================================== */

import { html, useState, useRef, useEffect, useLayoutEffect, S, D, cx, Icon, IconButton } from './lib.js';
import {
  store, setUi, select, undo, redo, canUndo, canRedo, openDoc, renameDoc, movePage, deleteDoc,
  addSection, addBlock, deleteNode, setLayout, addColumn, removeColumn, updateBlock, updateSectionStyle, updateColumnStyle,
  updateSettings, change, currentKind, currentDoc, moveSectionBy,
} from './store.js';
import { EDITORS, allowedHere, LIBRARY_GROUPS } from './blocks.js';
import { Field } from './fields.js';
import { saveDraft, publishLive, dashboardUrl, resetDemo } from './sync.js';
import { startDrag, endDrag } from './canvas.js';

/* ========================================================================
   TOP BAR
   ======================================================================== */

export function TopBar() {
  const ui = store.ui;
  const [menu, setMenu] = useState(false);
  const kind = currentKind();
  const doc = currentDoc();
  const crumb = kind === 'header' ? 'Header' : kind === 'footer' ? 'Footer' : doc ? doc.title : '…';
  useEffect(() => {
    if (!menu) return undefined;
    const close = (e) => { if (!e.target.closest('.more')) setMenu(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menu]);
  const busy = (which, label, icon, text) => (ui.busy === which
    ? html`<span class=${cx('spinner spinner--small', which === 'save' && 'spinner--dark')}></span><span class="tbtn__label">${label}</span>`
    : html`<${Icon} name=${icon} /><span class="tbtn__label">${text}</span>`);
  const demo = store.service && store.service.isDemo;
  return html`<header class="topbar">
    <div class="topbar__left">
      <a class="brand" href=${dashboardUrl()} title="Back to your websites"><span class="brand__mark"></span><span class="brand__name">Pebble</span></a>
      <span class="topbar__divider"></span>
      <span class="crumb" title="What you're changing now"><${Icon} name="pencil-line" /><span class="crumb__name">${crumb}</span></span>
    </div>
    <div class="topbar__right">
      <span class="save-status" data-state=${ui.status.state} role="status" aria-live="polite" title=${ui.status.text}>
        <span class="save-status__dot"></span><span class="save-status__text">${ui.status.text}</span>
      </span>
      <${IconButton} icon="undo-2" label="Undo" cls="tbtn tbtn--icon" disabled=${!canUndo()} onClick=${undo} />
      <${IconButton} icon="redo-2" label="Redo" cls="tbtn tbtn--icon" disabled=${!canRedo()} onClick=${redo} />
      <span class="topbar__divider"></span>
      <button type="button" class="tbtn" title="See your page as visitors will" onClick=${() => setUi({ dialog: 'preview' })}><${Icon} name="eye" /><span class="tbtn__label">Preview</span></button>
      <button type="button" class="tbtn" title="Colors, logo, fonts and spacing of your whole website" onClick=${() => setUi({ dialog: 'settings' })}><${Icon} name="palette" /><span class="tbtn__label">Site Settings</span></button>
      <div class="more">
        <${IconButton} icon="ellipsis" label="More options" cls="tbtn tbtn--icon" onClick=${() => setMenu(!menu)} />
        ${menu ? html`<div class="more-menu">
          <a class="more-menu__item" href=${dashboardUrl()}><${Icon} name="layout-grid" /><span>Your websites</span></a>
          <button type="button" class="more-menu__item" onClick=${() => { setMenu(false); downloadPage(); }}><${Icon} name="download" /><span>Download this page</span></button>
          ${demo ? html`<button type="button" class="more-menu__item more-menu__item--danger" onClick=${() => { setMenu(false); if (window.confirm('Reset the demo? This throws away everything you changed in this demo.')) resetDemo(); }}><${Icon} name="rotate-ccw" /><span>Reset the demo website</span></button>` : null}
          <p class="more-menu__repo">Website files: <code>${store.service ? store.service.fullName + (demo ? ' (practice)' : '') : '…'}</code></p>
        </div>` : null}
      </div>
      <span class="topbar__divider"></span>
      <button type="button" class="tbtn tbtn--outline" disabled=${!!ui.busy} title="Keep your changes safe. Only you can see them." onClick=${saveDraft}>${busy('save', 'Saving…', 'save', 'Save draft')}</button>
      <button type="button" class="tbtn tbtn--primary" disabled=${!!ui.busy} title="Put your changes on your website for everyone to see" onClick=${publishLive}>${busy('publish', 'Publishing…', 'send', 'Publish')}</button>
    </div>
  </header>`;
}

function downloadPage() {
  const kind = currentKind();
  const key = kind === 'page' || kind === 'post' ? store.ui.current : 'index.html';
  const blob = new Blob([window.PebbleCompiler.compileToStaticHTML(store.site, key)], { type: 'text/html' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = key.split('/').pop();
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* ========================================================================
   SIDEBAR — Main Menu / Other Pages, and a Blog panel that slides in
   ======================================================================== */

let lastClick = { file: '', time: 0 };

function RenameInput({ file, title }) {
  const ref = useRef(null);
  const done = useRef(false);
  useLayoutEffect(() => { ref.current.focus(); ref.current.select(); }, []);
  const finish = (save) => {
    if (done.current) return;
    done.current = true;
    if (save) renameDoc(file, ref.current.value);
    setUi({ renaming: null });
  };
  return html`<input ref=${ref} class="nav-item__input" type="text" value=${title} maxLength=${file.startsWith('blog/') ? 140 : 80} aria-label="New name"
    onKeyDown=${(e) => { if (e.key === 'Enter') { e.preventDefault(); finish(true); } if (e.key === 'Escape') { e.preventDefault(); finish(false); } }}
    onBlur=${() => finish(true)} onClick=${(e) => e.stopPropagation()} />`;
}

function NavItem({ file, icon, label, sub, renamable, actions, onOpen, chevron }) {
  const ui = store.ui;
  const current = ui.current === file;
  const pending = store.pending.some((p) => p.path === file);
  const isNew = file.endsWith('.html') && !store.livePaths.has(file);
  const renaming = ui.renaming === file;
  const open = (e) => {
    const now = Date.now();
    // Double-click to rename (the list repaints after the first click, so count clicks ourselves).
    if (renamable && lastClick.file === file && now - lastClick.time < 450 && e.target.closest('.nav-item__name')) {
      lastClick = { file: '', time: 0 };
      setUi({ renaming: file });
      return;
    }
    lastClick = { file, time: now };
    onOpen ? onOpen() : openDoc(file);
  };
  return html`<div class=${cx('nav-item', { 'is-current': current, 'is-renaming': renaming })}>
    ${renaming ? html`<span class="nav-item__main"><${Icon} name=${icon} cls="nav-item__icon" /><${RenameInput} file=${file} title=${label} /></span>`
      : html`<button type="button" class="nav-item__main" aria-current=${current ? 'page' : undefined} onClick=${open}>
        <${Icon} name=${icon} cls="nav-item__icon" />
        <span class="nav-item__name">${label}${sub ? html`<small class="nav-item__sub">${sub}</small>` : null}</span>
        ${pending ? html`<span class="nav-item__dot" title="Changes not saved yet"></span>` : null}
        ${isNew ? html`<span class="nav-item__badge">New</span>` : null}
        ${chevron ? html`<${Icon} name="chevron-right" cls="nav-item__chev" />` : null}
      </button>`}
    ${!renaming && renamable ? html`<${IconButton} icon="pencil" label="Rename" cls="nav-item__act" onClick=${() => setUi({ renaming: file })} />` : null}
    ${!renaming ? actions : null}
  </div>`;
}

function PageList({ inMenu }) {
  const site = store.site;
  const blog = S.blogPageFile(site);
  const pages = site.pages.filter((p) => p.showInNavbar === inMenu);
  const drop = store.ui.drop;
  const dragging = store.ui.drag && store.ui.drag.kind === 'page';
  const listDnd = {
    onDragOver(e) {
      if (!dragging) return;
      e.preventDefault();
      const li = e.target.closest('.page-entry');
      const before = li ? li.dataset.file : null;
      if (!drop || drop.list !== inMenu || drop.before !== before) setUi({ drop: { list: inMenu, before } });
    },
    onDrop(e) {
      if (!dragging) return;
      e.preventDefault();
      const li = e.target.closest('.page-entry');
      const file = store.ui.drag.file;
      setUi({ drag: null, drop: null });
      movePage(file, inMenu, li ? li.dataset.file : null);
    },
  };
  return html`<ul class=${cx('page-list page-list--pages', { 'drop-end': dragging && drop && drop.list === inMenu && !drop.before })} ...${listDnd}>
    ${pages.map((p) => {
      const isBlog = p.file === blog;
      return html`<li key=${p.file} data-file=${p.file} draggable="true"
          class=${cx('page-entry', { 'is-dragging': dragging && store.ui.drag.file === p.file, 'drop-before': dragging && drop && drop.before === p.file })}
          onDragStart=${(e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', p.file); requestAnimationFrame(() => setUi({ drag: { kind: 'page', file: p.file } })); }}
          onDragEnd=${() => setUi({ drag: null, drop: null })}>
        <span class="page-grip"><${Icon} name="grip-vertical" /></span>
        <${NavItem} file=${p.file} label=${p.title} renamable=${true} chevron=${isBlog}
          icon=${p.file === 'index.html' ? 'house' : isBlog ? 'newspaper' : 'file'}
          sub=${isBlog ? `${site.posts.length} post${site.posts.length === 1 ? '' : 's'}` : ''}
          actions=${html`<${IconButton} icon=${p.showInNavbar ? 'arrow-down-to-line' : 'arrow-up-to-line'} label=${p.showInNavbar ? 'Move to Other Pages (no menu link)' : 'Move to the Main Menu'} cls="nav-item__act" onClick=${() => movePage(p.file, !p.showInNavbar)} />`} />
      </li>`;
    })}
    ${pages.length ? null : html`<li class="page-list__empty">${inMenu ? 'Drag a page here to give it a menu link.' : 'Drag a page here to take it out of the menu. It stays on your website.'}</li>`}
  </ul>`;
}

export function Sidebar() {
  const site = store.site;
  const blog = S.blogPageFile(site);
  const pane = blog && store.ui.pane === 'blog' ? 'blog' : 'pages';
  const blogMeta = blog && S.pageOf(site, blog);
  return html`<aside class="sidebar" data-pane=${pane}>
    <div class="sidebar__track">
      <div class="sidebar__pane sidebar__pane--pages" aria-label="Pages" inert=${pane !== 'pages' ? true : undefined}>
        <div class="side-head"><h2 class="side-title">Main Menu</h2>
          <${IconButton} icon="plus" label="Add a new page" onClick=${() => setUi({ dialog: 'newdoc', dialogData: { mode: 'page' } })} /></div>
        <p class="side-help">Pages with a link in your menu. Drag to reorder. Double-click a name to rename it.</p>
        <${PageList} inMenu=${true} />
        <div class="side-head side-head--spaced"><h2 class="side-title">Other Pages</h2></div>
        <p class="side-help">On your website, but not in the menu.</p>
        <${PageList} inMenu=${false} />
        ${blog ? null : html`<button type="button" class="side-add" onClick=${() => setUi({ dialog: 'newdoc', dialogData: { mode: 'post' } })}><${Icon} name="newspaper" /><span>Start a blog</span></button>`}
        <div class="side-head side-head--spaced"><h2 class="side-title">On every page</h2></div>
        <ul class="page-list">
          <li><${NavItem} file="header" icon="panel-top" label="Header" /></li>
          <li><${NavItem} file="footer" icon="panel-bottom" label="Footer" /></li>
        </ul>
        <div class="tips"><h3>Good to know</h3><ul>
          <li>Hover over your page and press <b>+</b> to add a section or a block.</li>
          <li>Click a block or a section to change it on the right.</li>
          <li>Hold <b>the dots</b> on a block to drag it, even into another column.</li>
          <li><b>Save draft</b> keeps your work safe. <b>Publish</b> puts it online.</li>
        </ul></div>
      </div>
      <div class="sidebar__pane sidebar__pane--blog" aria-label="Blog posts" inert=${pane !== 'blog' ? true : undefined}>
        <button type="button" class="side-back" onClick=${() => setUi({ pane: 'pages' })}><${Icon} name="chevron-left" /><span>Back to Pages</span></button>
        ${blogMeta ? html`
          <div class="side-head"><h2 class="side-title side-title--big">${blogMeta.title}</h2></div>
          <div class="blog-page-item"><${NavItem} file=${blog} icon="layout-list" label="Blog page" sub="The page that lists your posts" /></div>
          <div class="side-head side-head--spaced"><h2 class="side-title">Posts</h2></div>
          <button type="button" class="side-add side-add--primary" onClick=${() => setUi({ dialog: 'newdoc', dialogData: { mode: 'post' } })}><${Icon} name="square-pen" /><span>Write a new post</span></button>
          <ul class="page-list">${S.sortedPosts(site).map((p) => html`<li key=${p.file}><${NavItem} file=${p.file} icon="file-text" label=${p.title} sub=${D.formatDate(p.date)} renamable=${true} /></li>`)}</ul>
          ${site.posts.length ? null : html`<p class="side-help">No posts yet. Write your first one!</p>`}` : null}
      </div>
    </div>
  </aside>`;
}

/* ========================================================================
   INSPECTOR — the selected block, the selected section, or the page
   ======================================================================== */

function InspHead({ icon, title, onClose }) {
  return html`<div class="insp-head"><${Icon} name=${icon} cls="insp-head__icon" /><h2 class="insp-head__title">${title}</h2>
    ${onClose ? html`<${IconButton} icon="x" label="Done" cls="insp-head__close" onClick=${onClose} />` : null}</div>`;
}

function LayoutTiles({ section }) {
  const current = section.columns.map((c) => c.width).join('-');
  return html`<div class="layout-tiles">${Object.entries(S.LAYOUTS).map(([key, l]) => html`<button type="button"
      class=${cx('layout-tile', { 'is-on': l.widths.join('-') === current })} title=${l.label} aria-label=${l.label} onClick=${() => setLayout(section.id, key)}>
      <span class="layout-tile__cols" style=${`grid-template-columns:${l.widths.map((w) => `${w}fr`).join(' ')}`}>${l.widths.map(() => html`<span></span>`)}</span>
    </button>`)}</div>`;
}

function SectionInspector({ hit }) {
  const section = hit.node;
  const st = section.style;
  const set = (patch, o) => updateSectionStyle(section.id, patch, o);
  const isRegion = currentKind() === 'header' || currentKind() === 'footer';
  const doc = currentDoc();
  const index = doc.sections.indexOf(section);
  return html`<div>
    <${InspHead} icon="rows-3" title="Section" onClose=${() => select(null)} />
    <div class="insp-field"><span class="insp-label">Columns</span>
      <${LayoutTiles} section=${section} />
      <p class="insp-help">Put blocks side by side, like a wide main part with a narrow column next to it. Blocks are never lost when you change this.</p>
      ${section.columns.length < S.MAX_COLUMNS ? html`<button type="button" class="link-btn link-btn--inline" onClick=${() => addColumn(section.id)}>Add another column</button>` : null}
    </div>
    ${section.columns.length > 1 ? html`<div class="insp-field"><span class="insp-label">Column widths</span>
      ${section.columns.map((c, i) => html`<div class="colwidth" key=${c.id}>
        <span class="colwidth__name">Column ${i + 1}</span>
        <input type="range" class="insp-range" min="10" max="90" value=${c.width} onInput=${(e) => change((site) => {
          const s = S.find(site, store.ui.current, section.id).node;
          const v = Number(e.target.value);
          const others = s.columns.filter((x) => x.id !== c.id);
          const rest = others.reduce((a, x) => a + x.width, 0) || 1;
          s.columns.find((x) => x.id === c.id).width = v;
          others.forEach((x) => { x.width = Math.max(10, (x.width / rest) * (100 - v)); });
          S.fixWidths(s.columns);
        }, { coalesce: `widths:${section.id}` })} />
        <output class="insp-out">${c.width} %</output>
        <${IconButton} icon="palette" label=${`Background of column ${i + 1}`} cls=${cx('colwidth__bg', { 'is-on': c.style.bgColor })}
          onClick=${() => updateColumnStyle(c.id, { bgColor: c.style.bgColor ? '' : '#efe7db' })} />
        <${IconButton} icon="x" label=${`Remove column ${i + 1}`} onClick=${() => removeColumn(c.id)} />
      </div>`)}
      <p class="insp-help">The palette button gives a column a soft background, like a box.</p>
    </div>` : null}
    <${Field} f=${{ type: 'segmented', label: 'Line up the columns', options: [['top', 'At the top', 'align-start-horizontal'], ['center', 'In the middle', 'align-center-horizontal'], ['bottom', 'At the bottom', 'align-end-horizontal']] }} value=${st.valign} onChange=${(v) => set({ valign: v })} />
    <${Field} f=${{ type: 'color', label: 'Background color', defaultLabel: 'None' }} value=${st.bgColor} onChange=${(v) => set({ bgColor: v })} />
    <${Field} f=${{ type: 'photo', label: 'Background photo', removable: true }} value=${st.bgImage} onChange=${(v) => set({ bgImage: v, overlayOpacity: v && !st.overlayOpacity ? 30 : st.overlayOpacity, tone: v ? 'light' : st.tone })} />
    ${st.bgImage ? html`
      <${Field} f=${{ type: 'color', label: 'Color over the photo' }} value=${st.overlayColor} onChange=${(v) => set({ overlayColor: v || '#000000' })} />
      <${Field} f=${{ type: 'range', label: 'Strength of the color', min: 0, max: 90, step: 5, unit: ' %' }} value=${st.overlayOpacity} onChange=${(v) => set({ overlayOpacity: v }, { coalesce: `overlay:${section.id}` })} />` : null}
    <${Field} f=${{ type: 'select', label: 'Text color', options: [['dark', 'Dark text (for light backgrounds)'], ['light', 'Light text (for dark backgrounds or photos)']] }} value=${st.tone} onChange=${(v) => set({ tone: v })} />
    ${isRegion ? null : html`<div class="insp-actions">
      <button type="button" class="btn btn--secondary btn--small" disabled=${index === 0} onClick=${() => moveSectionBy(section.id, -1)}><${Icon} name="arrow-up" /><span>Move up</span></button>
      <button type="button" class="btn btn--secondary btn--small" disabled=${index === doc.sections.length - 1} onClick=${() => moveSectionBy(section.id, 1)}><${Icon} name="arrow-down" /><span>Move down</span></button>
    </div>
    <button type="button" class="insp-remove" onClick=${() => deleteNode(section.id)}><${Icon} name="trash-2" /><span>Remove this section</span></button>`}
  </div>`;
}

function BlockInspector({ hit }) {
  const block = hit.node;
  const ed = EDITORS[block.type];
  return html`<div>
    <${InspHead} icon=${ed.icon} title=${ed.label} onClose=${() => select(null)} />
    ${ed.fields.map((f) => html`<${Field} key=${`${block.id}:${f.key || f.text}`} f=${f} value=${f.key ? block.data[f.key] : undefined}
      onChange=${(v) => updateBlock(block.id, { [f.key]: v }, f.type === 'text' || f.type === 'textarea' || f.type === 'code' || f.type === 'range' ? { coalesce: `field:${block.id}:${f.key}` } : {})} />`)}
    <button type="button" class="insp-remove" onClick=${() => deleteNode(block.id)}><${Icon} name="trash-2" /><span>Remove this block</span></button>
  </div>`;
}

function DocInspector() {
  const kind = currentKind();
  const file = store.ui.current;
  const doc = currentDoc();
  const site = store.site;
  const icons = { page: 'file', post: 'file-text', header: 'panel-top', footer: 'panel-bottom' };
  const titles = { page: 'Page settings', post: 'Blog post', header: 'Header', footer: 'Footer' };
  const setPost = (patch, o) => change(() => Object.assign(doc, patch), o);
  const hero = site.settings.hero;
  const setHero = (patch) => updateSettings((s) => { s.hero = { ...s.hero, ...patch }; });
  return html`<div>
    <${InspHead} icon=${icons[kind]} title=${titles[kind]} />
    ${kind === 'page' ? html`
      <${Field} f=${{ type: 'text', label: 'Page name' }} value=${doc.title} onChange=${(v) => v.trim() && renameDoc(file, v)} />
      <p class="insp-note">Web address ends in ${file}</p>
      <div class="insp-field"><span class="insp-label">Where this page is listed</span>
        <p class="insp-value">${doc.showInNavbar ? 'In the Main Menu (it has a link in your website menu)' : 'In Other Pages (no link in the menu)'}</p>
        <button type="button" class="btn btn--secondary btn--small" onClick=${() => movePage(file, !doc.showInNavbar)}>${doc.showInNavbar ? 'Move to Other Pages' : 'Add to the Main Menu'}</button>
      </div>
      ${file === S.blogPageFile(site) ? html`<p class="insp-note">This is your blog page. Its posts are in the Blog panel of the sidebar.</p>` : null}
      ${file !== 'index.html' ? html`<button type="button" class="insp-remove" onClick=${() => { if (window.confirm(`Delete the page “${doc.title}”? It will be removed from your website when you publish.`)) deleteDoc(file); }}><${Icon} name="trash-2" /><span>Delete this page</span></button>` : null}` : null}
    ${kind === 'post' ? html`
      <${Field} f=${{ type: 'text', label: 'Post title' }} value=${doc.title} onChange=${(v) => v.trim() && renameDoc(file, v)} />
      <${Field} f=${{ type: 'date', label: 'Date' }} value=${doc.date} onChange=${(v) => D.isDate(v) && setPost({ date: v })} />
      <${Field} f=${{ type: 'photo', label: 'Cover photo', removable: true }} value=${doc.thumbnail} onChange=${(v) => setPost({ thumbnail: D.safeUrl(v, 'image') })} />
      <${Field} f=${{ type: 'textarea', label: 'Short summary', placeholder: 'Leave empty and Pebble uses the first words of your post', help: 'Shown under the post on your blog page.' }}
        value=${doc.excerptAuto ? '' : doc.excerpt} onChange=${(v) => setPost({ excerpt: v.trim().slice(0, 400), excerptAuto: !v.trim() }, { coalesce: `excerpt:${file}` })} />
      <button type="button" class="insp-remove" onClick=${() => { if (window.confirm(`Delete the post “${doc.title}”? It will be removed from your website when you publish.`)) deleteDoc(file); }}><${Icon} name="trash-2" /><span>Delete this post</span></button>` : null}
    ${kind === 'header' ? html`
      <p class="insp-note">The Header is the top of every page: your website name or logo, the menu, and anything else you add here. On phones the menu folds into a menu button.</p>
      <div class="insp-section"><h3 class="insp-section__title">Hero image</h3><p class="insp-help">A big photo at the top of every page.</p>
        <${Field} f=${{ type: 'photo', label: 'Photo' }} value=${hero.src} onChange=${(v) => setHero({ src: v, enabled: !!v })} />
        ${hero.src ? html`
          <${Field} f=${{ type: 'toggle', text: 'Show the hero image' }} value=${hero.enabled} onChange=${(v) => setHero({ enabled: v })} />
          <${Field} f=${{ type: 'select', label: 'Where', options: [['behind', 'Behind the website name and menu'], ['below', 'Below the menu, as a wide banner']] }} value=${hero.position} onChange=${(v) => setHero({ position: v })} />
          <${Field} f=${{ type: 'select', label: 'Height', options: [['small', 'Small'], ['medium', 'Medium'], ['large', 'Large']] }} value=${hero.size} onChange=${(v) => setHero({ size: v })} />` : null}
      </div>` : null}
    ${kind === 'footer' ? html`<p class="insp-note">The Footer is the bottom of every page. Good places for: a copyright line, your email address, or links to other pages.</p>` : null}
    <p class="insp-tip"><${Icon} name="mouse-pointer-2" /><span>Click a block or a section to change its settings here.${kind === 'page' || kind === 'post' ? ' Hover over the page and press + to add sections and blocks.' : ''}</span></p>
  </div>`;
}

export function Inspector() {
  const id = store.ui.selected;
  const hit = id && S.find(store.site, store.ui.current, id);
  let body;
  if (hit && hit.kind === 'block') body = html`<${BlockInspector} key=${hit.node.id} hit=${hit} />`;
  else if (hit && hit.kind === 'section') body = html`<${SectionInspector} key=${hit.node.id} hit=${hit} />`;
  else body = html`<${DocInspector} key=${store.ui.current} />`;
  return html`<aside class="inspector" aria-label="Settings"><div class="inspector__body">${body}</div></aside>`;
}

/* ========================================================================
   LIBRARY — the "+" menu
     between sections → Sections (column layouts) and Blocks (a new section with it)
     in a column      → Blocks for that place
   Tiles can also be dragged onto any column.
   ======================================================================== */

export function Library() {
  const lib = store.ui.library;
  const ref = useRef(null);
  const [tab, setTab] = useState('sections');
  useEffect(() => { if (lib) setTab(lib.mode === 'section' ? 'sections' : 'blocks'); }, [lib && lib.mode, lib && lib.index, lib && lib.columnId]);
  useLayoutEffect(() => {
    if (!lib || !ref.current) return;
    const el = ref.current;
    const a = lib.anchor;
    const w = el.offsetWidth, h = el.offsetHeight;
    let top = a.bottom + 8;
    if (top + h > window.innerHeight - 8) top = Math.max(8, a.top - h - 8);
    el.style.top = `${top}px`;
    el.style.left = `${Math.max(8, Math.min(a.left + a.width / 2 - w / 2, window.innerWidth - w - 8))}px`;
  });
  useEffect(() => {
    if (!lib) return undefined;
    const close = (e) => { if (!e.target.closest('.library') && !e.target.closest('.ed-gap__add, .ed-column__add')) setUi({ library: null }); };
    const esc = (e) => { if (e.key === 'Escape') setUi({ library: null }); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [!!lib]);
  if (!lib) return null;

  const pick = (type) => {
    if (lib.mode === 'section') addSection(lib.index, 'one', type);
    else addBlock(lib.columnId, type, lib.index);
  };
  const dragging = store.ui.drag && store.ui.drag.kind === 'new-block';
  return html`<div ref=${ref} class=${cx('library', { 'is-dragging': dragging })} role="dialog" aria-label=${lib.mode === 'section' ? 'Add a section' : 'Add a block'}>
    <div class="library__head"><strong>${lib.mode === 'section' ? 'Add a section' : 'Add a block'}</strong>
      <${IconButton} icon="x" label="Close" onClick=${() => setUi({ library: null })} /></div>
    ${lib.mode === 'section' ? html`<div class="library__tabs" role="tablist">
      <button type="button" role="tab" class=${cx({ 'is-active': tab === 'sections' })} onClick=${() => setTab('sections')}><${Icon} name="rows-3" /><span>Sections</span></button>
      <button type="button" role="tab" class=${cx({ 'is-active': tab === 'blocks' })} onClick=${() => setTab('blocks')}><${Icon} name="shapes" /><span>Blocks</span></button>
    </div>` : null}
    ${lib.mode === 'section' && tab === 'sections' ? html`<div class="library__panel">
      <p class="library__help">A new section with one column, or columns side by side.</p>
      <div class="lib-layouts">${Object.entries(S.LAYOUTS).map(([key, l]) => html`<button type="button" class="lib-layout" onClick=${() => addSection(lib.index, key)}>
        <span class="layout-tile__cols" style=${`grid-template-columns:${l.widths.map((w) => `${w}fr`).join(' ')}`}>${l.widths.map(() => html`<span></span>`)}</span>
        <span class="lib-layout__label">${l.label}</span></button>`)}</div>
    </div>` : html`<div class="library__panel">
      <p class="library__help">${lib.mode === 'section' ? 'A new section with this block in it.' : 'Click a block, or drag it onto any column.'}</p>
      ${LIBRARY_GROUPS.map(([title, types]) => {
        const shown = types.filter(allowedHere);
        if (!shown.length) return null;
        return html`<section class=${cx('lib-group', { 'lib-group--advanced': title === 'For website helpers' })}>
          <h3 class="lib-group__title">${title}</h3>
          <div class="lib-grid">${shown.map((type) => {
            const ed = EDITORS[type];
            return html`<button type="button" class="lib-tile" draggable=${lib.mode === 'block' ? 'true' : 'false'} onClick=${() => pick(type)}
                onDragStart=${(e) => startDrag(e, { kind: 'new-block', type })} onDragEnd=${() => { endDrag(); }}>
              <${Icon} name=${ed.icon} cls="lib-tile__icon" />
              <span class="lib-tile__text"><strong>${ed.label}</strong><small>${ed.hint}</small></span>
            </button>`;
          })}</div>
        </section>`;
      })}
    </div>`}
  </div>`;
}

/* ========================================================================
   TOAST
   ======================================================================== */

export function Toast() {
  const t = store.ui.toast;
  if (!t) return null;
  return html`<div class="toast" role="status" aria-live="polite">
    <span class="toast__msg">${t.message}</span>
    ${t.actionLabel ? html`<button type="button" class="toast__action" onClick=${() => { setUi({ toast: null }); t.onAction && t.onAction(); }}>${t.actionLabel}</button>` : null}
  </div>`;
}

export { html };
