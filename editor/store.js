/* ==========================================================================
   The editor's store: ONE JSON tree (store.site) plus some UI state.

   Every change goes through store.change(fn): it snapshots the tree (for
   undo), lets fn edit it (with a PebbleState action), and tells the app to
   repaint. Preact then redraws only what differs — no DOM is read back,
   ever. Typing is the one exception: text is written into the tree without
   a repaint, because the browser is already showing it.

   The action handlers at the bottom (addSection, deleteSelected, moveBlock,
   …) are what the UI calls.
   ========================================================================== */

import { S, C, D, debounce } from './lib.js';

const HISTORY_LIMIT = 80;
const listeners = new Set();

export const store = {
  site: null,               // the JSON tree (see lib/site-state.js)
  ui: {
    current: 'index.html',  // the doc on the canvas: a file, 'header' or 'footer'
    selected: null,         // id of the selected section or block
    pane: 'pages',          // sidebar: 'pages' | 'blog'
    library: null,          // the "+" menu: { mode: 'section', index } | { mode: 'block', columnId, index }, plus anchor
    dialog: null,           // 'settings' | 'media' | 'preview' | 'newdoc' | 'publish' | …
    dialogData: null,
    toast: null,            // { message, actionLabel, onAction }
    status: { text: 'Opening…', state: '' },
    busy: null,             // 'save' | 'publish'
    loading: 'Opening your website…',
    blocked: null,          // a message when the website can't be edited
    renaming: null,         // file being renamed in the sidebar
    drag: null,             // what's being dragged: { kind: 'block'|'new-block'|'section'|'page', … }
    drop: null,             // where it would land
  },
  // GitHub side (filled by sync.js)
  service: null,
  remote: new Map(),        // path → { content, sha } as in the repository
  livePaths: new Set(),     // paths that exist on the live website
  hasDraftBranch: false,
  draftAhead: false,
  pending: [],              // files that differ from the repository
  baseCss: '',
  reloadKey: 0,             // bumped when text editors must re-read the tree (undo, redo)
  version: 0,
};

let undoStack = [];
let redoStack = [];
let lastCoalesce = { key: '', time: 0 };

export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }

let emitQueued = false;
export function emit() {
  store.version++;
  if (emitQueued) return;
  emitQueued = true;
  queueMicrotask(() => { emitQueued = false; listeners.forEach((fn) => fn(store.version)); });
}

export function setUi(patch) {
  Object.assign(store.ui, typeof patch === 'function' ? patch(store.ui) : patch);
  emit();
}

/**
 * Change the site.
 * @param {(site) => any} fn            edits store.site in place
 * @param {object} [o]
 * @param {boolean} [o.silent]          no repaint (typing)
 * @param {string}  [o.coalesce]        one undo step for a burst of changes with this key
 * @param {boolean} [o.history=true]
 */
export function change(fn, o = {}) {
  const { silent = false, coalesce = '', history = true } = o;
  if (history) {
    const now = Date.now();
    const merge = coalesce && lastCoalesce.key === coalesce && now - lastCoalesce.time < 1500;
    if (!merge) {
      undoStack.push(JSON.stringify(store.site));
      if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
      redoStack = [];
    }
    lastCoalesce = { key: coalesce, time: now };
  }
  const result = fn(store.site);
  markDirty();
  if (!silent) emit();
  return result;
}

export const canUndo = () => undoStack.length > 0;
export const canRedo = () => redoStack.length > 0;

function restore(json) {
  store.site = JSON.parse(json);
  store.reloadKey++;
  lastCoalesce = { key: '', time: 0 };
  if (!S.getDoc(store.site, store.ui.current)) store.ui.current = 'index.html';
  if (store.ui.selected && !S.find(store.site, store.ui.current, store.ui.selected)) store.ui.selected = null;
  markDirty();
  emit();
}
export function undo() { if (!undoStack.length) return; redoStack.push(JSON.stringify(store.site)); restore(undoStack.pop()); }
export function redo() { if (!redoStack.length) return; undoStack.push(JSON.stringify(store.site)); restore(redoStack.pop()); }
export function resetHistory() { undoStack = []; redoStack = []; }

/* ---------------- saving on this computer + "what needs saving" ---------------- */

const localKey = () => `pebble:site:v5:${store.service.fullName}`;
export const lastDocKey = () => `pebble:last-doc:v5:${store.service.fullName}`;

/** Files Pebble wrote in older versions and no longer uses. */
const OBSOLETE = ['site-config.json', 'header.html', 'footer.html'];

/** Every file to write or delete so the repository matches the tree. */
export function computePending() {
  const files = C.compileSite(store.site, { baseCss: store.baseCss });
  const out = [];
  for (const [path, content] of Object.entries(files)) {
    const remote = store.remote.get(path);
    if (!remote || remote.content !== content) out.push({ path, content, remote: remote || null });
  }
  for (const [path, remote] of store.remote) {
    if (files[path]) continue;
    const pebbleHtml = /\.html$/.test(path) && C.isPebblePage(remote.content);
    const oldCss = path === 'theme.css';
    if (OBSOLETE.includes(path) || pebbleHtml || oldCss) out.push({ path, content: null, remote, remove: true });
  }
  return out;
}

export function persistLocal() {
  try {
    if (store.pending.length) localStorage.setItem(localKey(), JSON.stringify(store.site));
    else localStorage.removeItem(localKey());
    return true;
  } catch (err) {
    console.warn('Pebble: local copy not saved', err);
    return false;
  }
}

export function loadLocal() {
  try {
    const v5 = JSON.parse(localStorage.getItem(localKey()) || 'null');
    if (v5) return v5;
    // Unsaved changes from the previous Pebble (v4): bring them over once.
    const oldKey = `pebble:site-draft:v2:${store.service.fullName}`;
    const old = JSON.parse(localStorage.getItem(oldKey) || 'null');
    const site = old && S.importLegacyDraft(old);
    if (site) localStorage.removeItem(oldKey);
    return site;
  } catch (err) {
    console.warn('Pebble: local copy unreadable', err);
    return null;
  }
}
export function clearLocal() {
  try { localStorage.removeItem(localKey()); localStorage.removeItem(lastDocKey()); } catch { /* ignore */ }
}

export function updateStatus(ok = true) {
  let status;
  if (!ok) status = { text: 'Couldn’t keep your changes on this computer (storage is full)', state: 'error' };
  else if (store.pending.length) status = { text: 'Changes not saved yet', state: 'unsaved' };
  else if (store.draftAhead) status = { text: 'Draft saved · not live yet', state: 'draft' };
  else status = { text: 'Your website is up to date', state: 'ok' };
  store.ui.status = status;
}

const flush = debounce(() => {
  store.pending = computePending();
  const ok = persistLocal();
  updateStatus(ok);
  emit();
}, 600);

function markDirty() {
  if (!store.service) return;
  if (store.ui.status.state !== 'saving') store.ui.status = { text: 'Saving…', state: 'saving' };
  flush();
}

/** Run the pending local save now (before switching pages, saving, unloading). */
export function flushNow() {
  if (flush.pending()) flush.flush();
  else if (store.service && store.site) { store.pending = computePending(); persistLocal(); updateStatus(); }
}

/* ========================================================================
   ACTION HANDLERS — what the UI calls
   ======================================================================== */

const cur = () => store.ui.current;
export const currentDoc = () => S.getDoc(store.site, cur());
export const currentKind = () => S.docKind(store.site, cur());

export function select(id) {
  if (store.ui.selected === id) return;
  store.ui.selected = id;
  emit();
}

/** Push a new section into the doc at `index` and select it. */
export function addSection(index, layoutKey = 'one', firstBlockType = null) {
  const section = change((site) => S.addSection(site, cur(), index, layoutKey, firstBlockType));
  if (!section) return null;
  const first = section.columns[0].blocks[0];
  setUi({ selected: first ? first.id : section.id, library: null });
  return section;
}

export function addBlock(columnId, type, index) {
  const block = change((site) => S.addBlock(site, cur(), columnId, type, index));
  if (block) setUi({ selected: block.id, library: null });
  return block;
}

/** Remove the selected block or section (with Undo in the toast). */
export function deleteSelected() {
  const id = store.ui.selected;
  const hit = id && S.find(store.site, cur(), id);
  if (!hit || hit.kind === 'column') return;
  change((site) => S.deleteNode(site, cur(), id));
  store.ui.selected = null;
  toast(hit.kind === 'section' ? 'Section removed.' : 'Block removed.', 'Undo', undo);
}

export function deleteNode(id) { store.ui.selected = id; deleteSelected(); }

export function duplicateNode(id) {
  const copy = change((site) => S.duplicate(site, cur(), id));
  if (copy) select(copy.id);
}

export function moveBlock(blockId, columnId, index) {
  const moved = change((site) => S.moveBlock(site, cur(), blockId, columnId, index));
  if (!moved) { undoStack.pop(); return; }
  select(blockId);
}

export function moveSection(id, toIndex) {
  const moved = change((site) => S.moveSection(site, cur(), id, toIndex));
  if (!moved) undoStack.pop();
}

export function moveSectionBy(id, dir) {
  const doc = currentDoc();
  const i = doc.sections.findIndex((s) => s.id === id);
  if (i < 0) return;
  const to = dir < 0 ? i - 1 : i + 2;
  if (to < 0 || to > doc.sections.length) return;
  moveSection(id, to);
}

/** Make a block span `span` of its column's 12 grid columns (one undo step per drag). */
export function resizeBlock(id, span) {
  const hit = S.find(store.site, cur(), id);
  if (!hit || hit.kind !== 'block' || hit.node.colSpan === span) return;
  change((site) => S.setColSpan(site, cur(), id, span), { coalesce: `resize:${id}` });
}

export const setLayout = (sectionId, key) => change((site) => S.setLayout(site, cur(), sectionId, key));
export const addColumn = (sectionId) => change((site) => S.addColumn(site, cur(), sectionId));
export const removeColumn = (columnId) => change((site) => S.removeColumn(site, cur(), columnId));

export function updateBlock(id, patch, o = {}) {
  return change((site) => S.updateBlock(site, cur(), id, patch), o);
}
export function updateSectionStyle(id, patch, o = {}) {
  return change((site) => S.updateSectionStyle(site, cur(), id, patch), o);
}
export function updateColumnStyle(id, patch) {
  return change((site) => {
    const hit = S.find(site, cur(), id);
    if (hit && hit.kind === 'column') hit.node.style = { bgColor: D.isHex(patch.bgColor) ? patch.bgColor.toLowerCase() : '' };
  });
}
export function updateSettings(fn, o = {}) {
  return change((site) => { fn(site.settings); site.settings = S.normalizeSettings(site.settings); }, o);
}

/* ---------------- docs ---------------- */

export function openDoc(key) {
  if (!S.getDoc(store.site, key)) return;
  flushNow();
  const kind = S.docKind(store.site, key);
  store.ui.current = key;
  store.ui.selected = null;
  store.ui.library = null;
  store.ui.pane = kind === 'post' || key === S.blogPageFile(store.site) ? 'blog' : 'pages';
  try { localStorage.setItem(lastDocKey(), key); } catch { /* ignore */ }
  emit();
  const area = document.querySelector('.canvas-area');
  if (area) area.scrollTop = 0;
}

export function createPage(title, inMenu) {
  const page = change((site) => S.addPage(site, title, inMenu));
  if (!page) return;
  openDoc(page.file);
  toast(`Your new page “${page.title}” is ready${inMenu ? ' and has a link in your menu' : ''}. Hover over the page and press + to add things.`);
}

export function createPost(title) {
  const hadBlog = !!S.blogPageFile(store.site);
  const post = change((site) => S.addPost(site, title));
  if (!post) return;
  openDoc(post.file);
  toast(hadBlog ? 'Your new post is ready. Write away!' : 'Your blog has started. Pebble made a “Blog” page that lists your posts.');
}

export function renameDoc(file, title) { change((site) => S.renameDoc(site, file, title), { coalesce: `rename:${file}` }); }

export function movePage(file, inMenu, beforeFile) {
  const p = S.pageOf(store.site, file);
  const wasInMenu = p && p.showInNavbar;
  change((site) => S.movePage(site, file, inMenu, beforeFile));
  if (p && wasInMenu !== !!inMenu) toast(inMenu ? `“${p.title}” now has a link in your website menu.` : `“${p.title}” is no longer in the menu. It’s still on your website.`);
}

/** Delete a page or post (the file is removed from the website on the next save). */
export function deleteDoc(file) {
  const site = store.site;
  const isPost = !!S.postOf(site, file);
  if (file === 'index.html') return;
  const meta = S.pageOf(site, file) || S.postOf(site, file);
  change((s) => {
    if (isPost) s.posts = s.posts.filter((p) => p.file !== file);
    else s.pages = s.pages.filter((p) => p.file !== file);
    if (s.blogPage === file) s.blogPage = '';
  });
  if (cur() === file) openDoc(isPost ? (S.blogPageFile(store.site) || 'index.html') : 'index.html');
  toast(`“${meta.title}” was deleted.`, 'Undo', undo);
}

/* ---------------- toast ---------------- */

let toastTimer = null;
export function toast(message, actionLabel, onAction) {
  clearTimeout(toastTimer);
  setUi({ toast: { message, actionLabel, onAction } });
  toastTimer = setTimeout(() => setUi({ toast: null }), actionLabel ? 7000 : Math.max(4000, message.length * 60));
}
