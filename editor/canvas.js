/* ==========================================================================
   The canvas — drawn from the JSON tree, with the website's own classes and
   CSS, so it looks like the published page.

   doc → sections → columns → blocks. Layout is plain CSS Grid / Flexbox:
   no positions to compute. Drag-and-drop is the browser's own (HTML5):
   dropping a block calls moveBlock(), which changes its place in the tree;
   Preact repaints.

   Hover "+": between sections (adds a section at that index) and at the
   bottom of every column (adds a block).
   ========================================================================== */

import { html, useRef, useState, C, D, S, cx, Icon, IconButton } from './lib.js';
import { store, setUi, select, deleteNode, duplicateNode, moveBlock, moveSection, moveSectionBy, addBlock, resizeBlock, openDoc, currentDoc, currentKind } from './store.js';
import { EDITORS } from './blocks.js';
import { Img, RenderedHtml } from './fields.js';

/* ---------------- drag & drop ----------------
   What's being dragged lives here (not in the tree); store.ui.drop says
   where it would land, so the drop line can be drawn. */

let drag = null;   // { kind: 'block', id } | { kind: 'new-block', type } | { kind: 'section', id }

export function startDrag(e, what) {
  drag = what;
  e.dataTransfer.effectAllowed = what.kind === 'new-block' ? 'copy' : 'move';
  e.dataTransfer.setData('text/plain', 'pebble');   // Firefox needs some data
  // Paint the drag state after the browser has taken its drag picture.
  requestAnimationFrame(() => setUi({ drag: what, library: what.kind === 'new-block' ? store.ui.library : null }));
}

export function endDrag() {
  drag = null;
  document.querySelectorAll('.block-shell[draggable="true"], .page-section[draggable="true"]').forEach((n) => n.setAttribute('draggable', 'false'));
  if (store.ui.drag || store.ui.drop) setUi({ drag: null, drop: null });
}

function setDrop(drop) {
  const cur = store.ui.drop;
  if (cur && drop && cur.columnId === drop.columnId && cur.index === drop.index && cur.gap === drop.gap) return;
  if (!cur && !drop) return;
  setUi({ drop });
}

/**
 * Where in a column a block would land. Blocks fill rows left to right, so:
 * before the first block that is below the mouse, or in the mouse's row and
 * to the right of it (past its middle).
 */
function indexInColumn(colEl, clientX, clientY) {
  const shells = Array.from(colEl.querySelectorAll(':scope > .col-blocks > .block-shell'));
  for (let i = 0; i < shells.length; i++) {
    const r = shells[i].getBoundingClientRect();
    if (clientY < r.top) return i;
    if (clientY <= r.bottom && (r.width > colEl.clientWidth * 0.9 ? clientY < r.top + r.height / 2 : clientX < r.left + r.width / 2)) return i;
  }
  return shells.length;
}

const columnDnd = (column) => ({
  onDragOver(e) {
    if (!drag || (drag.kind !== 'block' && drag.kind !== 'new-block')) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = drag.kind === 'new-block' ? 'copy' : 'move';
    setDrop({ columnId: column.id, index: indexInColumn(e.currentTarget, e.clientX, e.clientY) });
  },
  onDrop(e) {
    if (!drag || (drag.kind !== 'block' && drag.kind !== 'new-block')) return;
    e.preventDefault();
    e.stopPropagation();
    const index = indexInColumn(e.currentTarget, e.clientX, e.clientY);
    const what = drag;
    endDrag();
    if (what.kind === 'block') moveBlock(what.id, column.id, index);
    else addBlock(column.id, what.type, index);
  },
});

/** Section drags: the drop line goes in the gap nearest to the mouse. */
function gapIndexAt(canvasEl, clientY) {
  const sections = Array.from(canvasEl.querySelectorAll(':scope > .page-section'));
  for (let i = 0; i < sections.length; i++) {
    const r = sections[i].getBoundingClientRect();
    if (clientY < r.top + r.height / 2) return i;
  }
  return sections.length;
}

const canvasDnd = {
  onDragOver(e) {
    if (!drag || drag.kind !== 'section') return;
    e.preventDefault();
    setDrop({ gap: gapIndexAt(e.currentTarget, e.clientY) });
  },
  onDrop(e) {
    if (!drag || drag.kind !== 'section') return;
    e.preventDefault();
    const gap = gapIndexAt(e.currentTarget, e.clientY);
    const id = drag.id;
    endDrag();
    moveSection(id, gap);
  },
};

/* ---------------- the hover "+" ---------------- */

function openLibrary(e, target) {
  e.stopPropagation();
  const r = e.currentTarget.getBoundingClientRect();
  setUi({ library: { ...target, anchor: { left: r.left, top: r.top, bottom: r.bottom, width: r.width } } });
}

function AddGap({ index, last }) {
  const drop = store.ui.drop;
  const showDrop = drop && drop.gap === index;
  return html`<div class=${cx('ed-gap', { 'ed-gap--last': last, 'is-drop': showDrop })}>
    <button type="button" class="ed-gap__add" title="Add a section here" aria-label="Add a section here"
      onClick=${(e) => openLibrary(e, { mode: 'section', index })}><${Icon} name="plus" /></button>
  </div>`;
}

/* ---------------- resizing: the block's width in the 12-column grid ----------------
   Dragging the bar on a block's right edge works out how many of the
   column's 12 grid columns the block now covers, and snaps to the sizes
   that make sense to her (1/4, 1/3, 1/2, 2/3, 3/4, full). Only when she
   drags well away from those does it stop at any other whole column. */

export const SNAPS = [3, 4, 6, 8, 9, 12];
const SIZE_NAMES = { 3: 'A quarter', 4: 'A third', 6: 'Half', 8: 'Two thirds', 9: 'Three quarters', 12: 'Full width' };
export const sizeName = (span) => SIZE_NAMES[span] || `${Math.round((span / 12) * 100)}%`;

/** The span for a right edge at clientX, for a block whose left edge is at `left`. */
export function spanAt(grid, left, clientX) {
  const r = grid.getBoundingClientRect();
  const gap = parseFloat(getComputedStyle(grid).columnGap) || 0;
  const unit = (r.width + gap) / 12;                 // one grid column + one gap
  const covered = (clientX - left + gap) / unit;     // how many columns the block would cover
  let span = SNAPS.reduce((a, b) => (Math.abs(b - covered) < Math.abs(a - covered) ? b : a));
  if (Math.abs(span - covered) > 0.75) span = Math.round(covered);  // far from every logical size
  return D.clamp(span, 2, 12);
}

function ResizeHandle({ block, shellRef }) {
  const [live, setLive] = useState(null);   // the span shown while dragging
  const drag = useRef(null);
  const finish = (e) => {
    if (!drag.current) return;
    const { grid } = drag.current;
    drag.current = null;
    grid.classList.remove('is-resizing');
    shellRef.current && shellRef.current.classList.remove('is-resizing');
    document.body.classList.remove('is-resizing');
    if (e && e.currentTarget.hasPointerCapture && e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    setLive(null);
  };
  return html`<div class="block-resize" role="separator" aria-orientation="vertical" title="Drag to make this block wider or narrower"
      onMouseDown=${(e) => e.stopPropagation()}
      onPointerDown=${(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        select(block.id);
        const grid = shellRef.current.parentElement;          // the column's .col-blocks grid
        drag.current = { grid };
        e.currentTarget.setPointerCapture(e.pointerId);         // keep getting moves outside the handle
        grid.classList.add('is-resizing');
        shellRef.current.classList.add('is-resizing');
        document.body.classList.add('is-resizing');
        setLive(block.colSpan);
      }}
      onPointerMove=${(e) => {
        if (!drag.current) return;
        const left = shellRef.current.getBoundingClientRect().left;   // re-read: the block may wrap to a new row
        const span = spanAt(drag.current.grid, left, e.clientX);
        if (span !== live) setLive(span);
        resizeBlock(block.id, span);                                   // the tree changes; Preact repaints the width
      }}
      onPointerUp=${finish} onPointerCancel=${finish} onLostPointerCapture=${finish}>
    ${live != null ? html`<span class="block-resize__label">${sizeName(live)}</span>` : null}
  </div>`;
}

/* ---------------- blocks ---------------- */

function BlockView({ block, column, dropBefore }) {
  const ed = EDITORS[block.type];
  const ref = useRef(null);
  if (!ed) return null;
  const selected = store.ui.selected === block.id;
  const dragging = store.ui.drag && store.ui.drag.kind === 'block' && store.ui.drag.id === block.id;
  const View = ed.View;
  const span = block.colSpan || 12;
  return html`<div ref=${ref} class=${cx('block-shell', { 'is-selected': selected, 'is-dragging': dragging, 'drop-before': dropBefore })} draggable="false"
      style=${`grid-column:span ${span}`}
      onMouseDown=${(e) => { e.stopPropagation(); select(block.id); }}
      onFocusIn=${() => select(block.id)}
      onDragStart=${(e) => { if (e.target !== ref.current) return; startDrag(e, { kind: 'block', id: block.id, from: column.id }); }}
      onDragEnd=${endDrag}>
    <div class="block-bar" onMouseDown=${(e) => e.stopPropagation()}>
      <span class="block-bar__handle" title="Hold and drag to move this block"
        onMouseDown=${() => { ref.current.setAttribute('draggable', 'true'); select(block.id); }}
        onMouseUp=${() => ref.current.setAttribute('draggable', 'false')}><${Icon} name="grip-vertical" /><span>${ed.label}</span></span>
      <${IconButton} icon="copy" label="Duplicate" cls="block-bar__btn" onClick=${() => duplicateNode(block.id)} />
      <${IconButton} icon="trash-2" label="Remove this block" cls="block-bar__btn" onClick=${() => deleteNode(block.id)} />
    </div>
    <${View} block=${block} />
    <${ResizeHandle} block=${block} shellRef=${ref} />
  </div>`;
}

function DropLine() { return html`<div class="drop-line" aria-hidden="true"></div>`; }

/* ---------------- columns ---------------- */

function ColumnView({ column, section }) {
  const drop = store.ui.drop;
  const dropHere = drop && drop.columnId === column.id;
  const blocks = column.blocks;
  const filled = D.isHex(column.style.bgColor);
  const items = [];
  blocks.forEach((b, i) => {
    // Dropping before a full-width block: a line above it. Before a narrower
    // block (which may share a row): a bar on its left edge.
    const here = dropHere && drop.index === i;
    if (here && (b.colSpan || 12) === 12) items.push(html`<${DropLine} key=${`drop-${i}`} />`);
    items.push(html`<${BlockView} key=${b.id} block=${b} column=${column} dropBefore=${here && (b.colSpan || 12) < 12} />`);
  });
  if (dropHere && drop.index === blocks.length) items.push(html`<${DropLine} key="drop-end" />`);
  return html`<div class=${cx('section-column ed-column', { 'section-column--filled': filled, 'is-empty': !blocks.length, 'is-drop': dropHere })}
      style=${filled ? `--column-bg:${column.style.bgColor}` : ''} ...${columnDnd(column)}>
    <div class="col-blocks">${items}</div>
    <button type="button" class="ed-column__add" title="Add a block" onMouseDown=${(e) => e.stopPropagation()}
      onClick=${(e) => openLibrary(e, { mode: 'block', columnId: column.id, index: blocks.length })}>
      <${Icon} name="plus" /><span>${blocks.length ? '' : 'Add a block'}</span>
    </button>
  </div>`;
}

/* ---------------- sections ---------------- */

function SectionView({ section, index, count }) {
  const ref = useRef(null);
  const st = section.style;
  const selected = store.ui.selected === section.id;
  const dragging = store.ui.drag && store.ui.drag.kind === 'section' && store.ui.drag.id === section.id;
  const isRegion = currentKind() === 'header' || currentKind() === 'footer';
  const template = section.columns.length > 1 ? `--columns:${section.columns.map((c) => `${c.width}fr`).join(' ')}` : '';
  return html`<section ref=${ref} draggable="false"
      class=${cx('page-section ed-section', { 'page-section--filled': st.bgColor || st.bgImage, 'page-section--light': st.tone === 'light', 'is-selected': selected, 'is-dragging': dragging })}
      style=${st.bgColor ? `--section-bg:${st.bgColor}` : ''}
      onMouseDown=${() => select(section.id)}
      onDragStart=${(e) => { if (e.target !== ref.current) return; startDrag(e, { kind: 'section', id: section.id }); }}
      onDragEnd=${endDrag}>
    ${st.bgImage ? html`<div class="page-section__bg"><${Img} src=${st.bgImage} /></div>` : null}
    ${st.bgImage && st.overlayOpacity > 0 ? html`<div class="page-section__overlay" style=${`background:${st.overlayColor};opacity:${(st.overlayOpacity / 100).toFixed(2)}`}></div>` : null}
    <div class="ed-section__bar" onMouseDown=${(e) => e.stopPropagation()}>
      ${isRegion ? html`<span class="ed-section__tag"><${Icon} name="rows-3" /><span>Section</span></span>` : html`<span class="ed-section__tag ed-section__handle" title="Hold and drag to move this section"
        onMouseDown=${() => { ref.current.setAttribute('draggable', 'true'); select(section.id); }}
        onMouseUp=${() => ref.current.setAttribute('draggable', 'false')}><${Icon} name="grip-vertical" /><span>Section</span></span>`}
      <${IconButton} icon="sliders-horizontal" label="Section settings" cls="ed-section__btn" onClick=${() => select(section.id)} />
      ${isRegion ? null : html`
        <${IconButton} icon="arrow-up" label="Move up" cls="ed-section__btn" disabled=${index === 0} onClick=${() => moveSectionBy(section.id, -1)} />
        <${IconButton} icon="arrow-down" label="Move down" cls="ed-section__btn" disabled=${index === count - 1} onClick=${() => moveSectionBy(section.id, +1)} />
        <${IconButton} icon="copy" label="Duplicate section" cls="ed-section__btn" onClick=${() => duplicateNode(section.id)} />
        <${IconButton} icon="trash-2" label="Remove this section" cls="ed-section__btn" onClick=${() => deleteNode(section.id)} />`}
    </div>
    <div class=${cx('section-columns', st.valign !== 'top' && `section-columns--${st.valign}`)} style=${template}>
      ${section.columns.map((c) => html`<${ColumnView} key=${c.id} column=${c} section=${section} />`)}
    </div>
  </section>`;
}

/* ---------------- header / footer previews around a page ---------------- */

function RegionPreview({ kind }) {
  const ctx = { site: store.site, file: store.ui.current, root: '', n: 0, indent: '' };
  const markup = C.renderRegion(kind, store.site, ctx);
  return html`<div class=${cx('region-preview', `region-preview--${kind}`)} title=${`Click to change the ${kind === 'header' ? 'Header (the top' : 'Footer (the bottom'} of every page)`}
      onClick=${() => openDoc(kind)}>
    <span class="region-preview__label"><${Icon} name="pencil" /><span>${kind === 'header' ? 'Header' : 'Footer'} — click to change it</span></span>
    <${RenderedHtml} cls="region-preview__content" html=${markup} />
  </div>`;
}

function PostHeader({ post }) {
  return html`<header class="post-header">
    <p class="post-header__date"><time>${D.formatDate(post.date)}</time></p>
    <h1 class="post-header__title">${post.title}</h1>
    ${post.thumbnail ? html`<figure class="post-header__cover"><${Img} src=${post.thumbnail} /></figure>` : null}
  </header>`;
}

/** The hero photo while editing the Header. */
function HeroPreview() {
  const hero = D.normalizeHero(store.site.settings.hero);
  if (!hero.enabled) return null;
  if (hero.position === 'behind') return html`<div class="site-hero__bg"><${Img} src=${hero.src} /></div>`;
  return html`<div class=${`site-hero site-hero--${hero.size}`}><${Img} src=${hero.src} /></div>`;
}

export function Canvas() {
  const doc = currentDoc();
  const kind = currentKind();
  if (!doc) return null;
  const sections = doc.sections;
  const isPage = kind === 'page' || kind === 'post';
  const hero = D.normalizeHero(store.site.settings.hero);
  const body = [];
  sections.forEach((s, i) => {
    if (isPage) body.push(html`<${AddGap} key=${`gap-${i}`} index=${i} />`);
    body.push(html`<${SectionView} key=${s.id} section=${s} index=${i} count=${sections.length} />`);
  });
  if (isPage) body.push(html`<${AddGap} key="gap-end" index=${sections.length} last=${true} />`);

  const canvas = html`<div class="canvas" ...${isPage ? canvasDnd : {}}>${body}</div>`;
  return html`<div class=${cx('paper', `paper--${kind}`, { 'is-dragging': !!store.ui.drag })} id="paper"
      onMouseDown=${(e) => { if (e.target === e.currentTarget) select(null); }}>
    ${isPage ? html`<${RegionPreview} kind="header" />` : null}
    ${kind === 'header'
      ? html`<header class=${cx('site-header', hero.enabled && hero.position === 'behind' && `site-header--hero site-header--hero-${hero.size}`)}>
          ${hero.enabled && hero.position === 'behind' ? html`<${HeroPreview} />` : null}${canvas}${hero.enabled && hero.position === 'below' ? html`<${HeroPreview} />` : null}
        </header>`
      : kind === 'footer'
        ? html`<footer class="site-footer">${canvas}</footer>`
        : html`<main class="site-main">${kind === 'post' ? html`<${PostHeader} post=${doc} />` : null}${canvas}</main>`}
    ${isPage ? html`<${RegionPreview} kind="footer" />` : null}
  </div>`;
}

export { S };
