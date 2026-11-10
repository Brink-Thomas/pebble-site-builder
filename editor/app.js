/* ==========================================================================
   Pebble editor — the root. Renders the whole UI from the store with
   Preact, and repaints whenever the store says something changed.

     lib/site-state.js   the JSON tree and its actions
     lib/compiler.js     JSON → static HTML/CSS
     editor/store.js     the in-memory tree, undo/redo, action handlers
     editor/sync.js      GitHub: open, Save draft, Publish, photos
     editor/canvas.js    sections / columns / blocks, drag & drop, hover "+"
     editor/blocks.js    each block type's canvas view and Inspector fields
     editor/panels.js    top bar, sidebar, Inspector, Library, toast
     editor/dialogs.js   Site Settings, photos, preview, publish, new page
     editor/toolbar.js   the floating text toolbar
   ========================================================================== */

import { html, render, useState, useEffect, D, S } from './lib.js';
import { store, subscribe, undo, redo, deleteSelected, select, flushNow, setUi } from './store.js';
import { boot } from './sync.js';
import { Canvas } from './canvas.js';
import { TopBar, Sidebar, Inspector, Library, Toast } from './panels.js';
import { Dialogs, Loading } from './dialogs.js';
import { initToolbar, hideToolbar, positionToolbar } from './toolbar.js';

/** The website's own CSS on the canvas (global.css + theme.css), rebuilt only when it changes. */
let lastCss = '';
function applySiteCss() {
  if (!store.site) return;
  const s = store.site.settings;
  const css = D.globalCss(s.theme, store.baseCss, s.typography);
  const custom = s.customCss || '';
  if (css + custom === lastCss) return;
  lastCss = css + custom;
  document.getElementById('site-theme').textContent = css;
  document.getElementById('site-custom').textContent = custom;
}

const isTyping = (el) => !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

function App() {
  const [, setVersion] = useState(0);
  useEffect(() => subscribe(setVersion), []);
  useEffect(() => { applySiteCss(); positionToolbar(); });

  useEffect(() => {
    const onKey = (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (store.ui.dialog || store.ui.media) return;
      if (mod && e.key.toLowerCase() === 'z' && !isTyping(document.activeElement)) { e.preventDefault(); (e.shiftKey ? redo : undo)(); return; }
      if (mod && e.key.toLowerCase() === 'y' && !isTyping(document.activeElement)) { e.preventDefault(); redo(); return; }
      if ((e.key === 'Delete' || e.key === 'Backspace') && store.ui.selected && !isTyping(document.activeElement)) { e.preventDefault(); deleteSelected(); return; }
      if (e.key === 'Escape' && store.ui.selected && !store.ui.library) { select(null); }
    };
    const onUnload = () => flushNow();
    document.addEventListener('keydown', onKey);
    window.addEventListener('beforeunload', onUnload);
    return () => { document.removeEventListener('keydown', onKey); window.removeEventListener('beforeunload', onUnload); };
  }, []);

  if (!store.site) return html`<${Loading} />`;
  return html`
    <${TopBar} />
    <div class="workspace">
      <${Sidebar} />
      <main class="canvas-area" onMouseDown=${(e) => { if (e.target === e.currentTarget) select(null); }}>
        <${Canvas} />
      </main>
      <${Inspector} />
    </div>
    <${Library} />
    <${Dialogs} />
    <${Toast} />
    <${Loading} />`;
}

initToolbar();
render(html`<${App} />`, document.getElementById('app'));
boot();

// For the browser console (and tests): the tree and the action handlers.
window.Pebble = {
  get store() { return store; },
  get site() { return store.site; },
  compile: () => window.PebbleCompiler.compileSite(store.site, { baseCss: store.baseCss }),
  compileToStaticHTML: (key = store.ui.current) => window.PebbleCompiler.compileToStaticHTML(store.site, key),
  actions: import('./store.js'),
  S,
};
