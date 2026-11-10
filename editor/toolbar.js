/* ==========================================================================
   Floating text toolbar — appears above a text box while she types in it.
   It works on the browser's selection (execCommand), then fires an "input"
   event so the text editor writes the result into the tree.
   ========================================================================== */

import { D, iconSvg } from './lib.js';
import { store, toast } from './store.js';

let bar = null;
let editor = null;
let savedRange = null;

function btn(attrs, icon, label) {
  return `<button type="button" ${attrs} title="${label}" aria-label="${label}">${iconSvg(icon)}</button>`;
}

function build() {
  bar = document.createElement('div');
  bar.className = 'text-toolbar';
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', 'Text formatting');
  bar.hidden = true;
  bar.innerHTML = `<select class="tt-style" aria-label="Text style" title="Text style"></select>
    <span class="tt-sep"></span>
    ${btn('data-cmd="bold"', 'bold', 'Bold')}${btn('data-cmd="italic"', 'italic', 'Italic')}${btn('data-cmd="underline"', 'underline', 'Underline')}
    <div class="tt-hl">${btn('data-cmd="highlight"', 'highlighter', 'Highlight')}
      <div class="tt-palette" hidden>
        ${Object.entries(D.HIGHLIGHTS).map(([name, h]) => `<button type="button" class="tt-swatch" data-highlight="${name}" style="background:${h.color}" title="${h.label} highlight" aria-label="${h.label} highlight"></button>`).join('')}
        ${btn('class="tt-swatch tt-swatch--none" data-highlight=""', 'ban', 'No highlight')}
      </div></div>
    <span class="tt-sep"></span>
    ${btn('data-align="left"', 'align-left', 'Align left')}${btn('data-align="center"', 'align-center', 'Center')}${btn('data-align="right"', 'align-right', 'Align right')}${btn('data-align="justify"', 'align-justify', 'Justify')}
    <span class="tt-sep"></span>
    ${btn('data-cmd="list"', 'list', 'Bullet list')}${btn('data-cmd="link"', 'link', 'Link to another page or website')}`;
  document.body.appendChild(bar);
}

const palette = () => bar.querySelector('.tt-palette');

function activeEditor() {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  const n = sel.anchorNode;
  const el = n && (n.nodeType === Node.ELEMENT_NODE ? n : n.parentElement);
  return el ? el.closest('.text-editor') : null;
}

function restoreRange() {
  if (!editor) return;
  editor.focus({ preventScroll: true });
  if (savedRange) { const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(savedRange); }
}

function blocksInSelection() {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return [];
  const range = sel.getRangeAt(0);
  const leaf = (b) => !b.querySelector('p, h1, h2, h3, li');
  let hit = Array.from(editor.querySelectorAll('p, h1, h2, h3, li, blockquote')).filter((b) => leaf(b) && range.intersectsNode(b));
  if (!hit.length) {
    document.execCommand('formatBlock', false, 'p');
    hit = Array.from(editor.querySelectorAll('p, h1, h2, h3, li, blockquote')).filter((b) => window.getSelection().getRangeAt(0).intersectsNode(b));
  }
  return hit;
}

function currentBlock() {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  let n = sel.anchorNode;
  n = n && (n.nodeType === Node.ELEMENT_NODE ? n : n.parentElement);
  const b = n && n.closest('p, h1, h2, h3, li, blockquote');
  return b && editor.contains(b) ? b : null;
}

function styleKeyOf(b) {
  if (!b) return 'paragraph';
  const tag = b.tagName.toLowerCase();
  if (tag === 'h1') return 'title';
  if (tag === 'h2') return 'heading';
  if (tag === 'h3') return 'subheading';
  return tag === 'p' && b.classList.contains('text-small') ? 'small' : 'paragraph';
}

function alignOf(b) {
  if (!b) return 'left';
  const m = b.className.match(/\balign-(center|right|justify)\b/);
  return m ? m[1] : 'left';
}

const COMMANDS = {
  bold: () => document.execCommand('bold'),
  italic: () => document.execCommand('italic'),
  underline: () => document.execCommand('underline'),
  list: () => document.execCommand('insertUnorderedList'),
  link: () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) { toast('First select (highlight) the words you want to turn into a link.'); return; }
    const range = sel.getRangeAt(0);
    let url = window.prompt('Paste the website address for this link (or a page, like about.html):', 'https://');
    if (!url || url === 'https://') return;
    url = url.trim();
    if (!/^(https?:|mailto:|#|\/)/i.test(url) && !/^(blog\/)?[a-z0-9-]+\.html$/i.test(url)) url = 'https://' + url;
    sel.removeAllRanges();
    sel.addRange(range);
    document.execCommand('createLink', false, D.safeUrl(url, 'link'));
  },
};

function applyStyle(key) {
  restoreRange();
  document.execCommand('formatBlock', false, D.TEXT_STYLES[key].tag);
  blocksInSelection().forEach((b) => b.classList.toggle('text-small', key === 'small'));
}

function applyAlign(align) {
  blocksInSelection().forEach((b) => {
    b.classList.remove('align-center', 'align-right', 'align-justify', 'align-left');
    b.style.removeProperty('text-align');
    if (align !== 'left') b.classList.add(`align-${align}`);
  });
}

function applyHighlight(name) {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) { toast('First select (highlight) the words you want to color.'); return; }
  const range = sel.getRangeAt(0);
  editor.querySelectorAll('mark, span[style*="background"]').forEach((m) => { if (range.intersectsNode(m)) m.replaceWith(...m.childNodes); });
  if (name) {
    document.execCommand('styleWithCSS', false, true);
    document.execCommand('hiliteColor', false, D.HIGHLIGHTS[name].color);
    document.execCommand('styleWithCSS', false, false);
  }
}

function changed() {
  if (!editor) return;
  editor.dispatchEvent(new Event('input', { bubbles: true }));
  updateState();
}

export function positionToolbar() {
  if (!bar || bar.hidden || !editor) return;
  const box = (editor.closest('.block-shell') || editor).getBoundingClientRect();
  const topLimit = document.querySelector('.topbar').getBoundingClientRect().bottom + 8;
  let top = box.top - bar.offsetHeight - 10;
  bar.classList.toggle('is-pinned', top < topLimit);
  if (top < topLimit) top = topLimit;
  bar.style.top = `${top}px`;
  bar.style.left = `${Math.max(8, Math.min(box.left, window.innerWidth - bar.offsetWidth - 8))}px`;
}

function show(ed) {
  editor = ed;
  bar.hidden = false;
  const select = bar.querySelector('.tt-style');
  const styles = store.site.settings.typography.styles;
  select.innerHTML = Object.keys(D.TEXT_STYLES).map((k) => `<option value="${k}">${D.escapeHtml(styles[k].name)}</option>`).join('');
  updateState();
  positionToolbar();
}

export function hideToolbar() {
  if (!bar) return;
  bar.hidden = true;
  palette().hidden = true;
  editor = null;
  savedRange = null;
}

function updateState() {
  if (!editor) return;
  const b = currentBlock();
  bar.querySelector('.tt-style').value = styleKeyOf(b);
  const align = alignOf(b);
  bar.querySelectorAll('[data-align]').forEach((x) => x.classList.toggle('is-on', x.dataset.align === align));
  for (const cmd of ['bold', 'italic', 'underline']) {
    let on = false;
    try { on = document.queryCommandState(cmd); } catch { /* ignore */ }
    bar.querySelector(`[data-cmd="${cmd}"]`).classList.toggle('is-on', on);
  }
}

export function initToolbar() {
  build();
  bar.addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
  bar.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || !editor) return;
    if (b.dataset.cmd === 'highlight') { palette().hidden = !palette().hidden; return; }
    if (b.dataset.highlight != null) { applyHighlight(b.dataset.highlight); palette().hidden = true; changed(); return; }
    if (b.dataset.align) { applyAlign(b.dataset.align); changed(); return; }
    if (b.dataset.cmd && COMMANDS[b.dataset.cmd]) { COMMANDS[b.dataset.cmd](); changed(); }
  });
  bar.querySelector('.tt-style').addEventListener('change', (e) => { applyStyle(e.target.value); changed(); });

  document.addEventListener('focusin', (e) => {
    const ed = e.target.closest && e.target.closest('.text-editor');
    if (ed) show(ed);
  });
  document.addEventListener('focusout', () => {
    setTimeout(() => {
      const a = document.activeElement;
      if (a && (a.closest('.text-toolbar') || a.closest('.text-editor'))) return;
      hideToolbar();
    }, 0);
  });
  document.addEventListener('selectionchange', () => {
    const ed = activeEditor();
    if (ed && ed !== editor && ed.isContentEditable) show(ed);
    if (ed && ed === editor) {
      const sel = window.getSelection();
      if (sel.rangeCount) savedRange = sel.getRangeAt(0).cloneRange();
      updateState();
    }
    if (editor && !editor.isConnected) hideToolbar();
  });
  window.addEventListener('resize', positionToolbar);
  document.addEventListener('scroll', positionToolbar, { capture: true, passive: true });
  try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch { /* ignore */ }
}
