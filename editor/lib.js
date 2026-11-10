/* ==========================================================================
   Shared bits for the editor's modules: Preact (via htm, no build step),
   Lucide icons, and small helpers.
   ========================================================================== */

export {
  html, render, h, createContext,
  useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback, useContext,
} from 'https://cdn.jsdelivr.net/npm/htm@3.1.1/preact/standalone.module.js';
import { html } from 'https://cdn.jsdelivr.net/npm/htm@3.1.1/preact/standalone.module.js';

export const D = window.PebbleDesign;
export const S = window.PebbleState;
export const C = window.PebbleCompiler;

/** class names from strings / {name: condition} objects */
export function cx(...parts) {
  const out = [];
  for (const p of parts) {
    if (!p) continue;
    if (typeof p === 'string') out.push(p);
    else for (const [k, v] of Object.entries(p)) if (v) out.push(k);
  }
  return out.join(' ');
}

/* ---------------- Lucide icons ----------------
   The one icon set of the editor. An icon is built once as SVG markup and
   cached; components insert the cached string. */

const iconCache = new Map();
const toPascal = (name) => name.replace(/(^|-)([a-z0-9])/g, (_m, _d, c) => c.toUpperCase());

/** SVG markup for a Lucide icon ('' if unknown). */
export function iconSvg(name, cls = '') {
  let svg = iconCache.get(name);
  if (svg == null) {
    const node = window.lucide && window.lucide.icons[toPascal(name)];
    svg = node ? window.lucide.createElement(node).outerHTML
      .replace(/<svg [^>]*?(?=>)/, (m) => m.replace(/\sclass="[^"]*"/, '').replace('stroke-width="2"', 'stroke-width="1.75"') + ' aria-hidden="true" focusable="false"') : '';
    if (!node) console.warn('Pebble: unknown icon', name);
    iconCache.set(name, svg);
  }
  return svg.replace('<svg ', `<svg class="icon ${cls}" `);
}

export function Icon({ name, cls = '' }) {
  return html`<span class=${cx('icon-wrap', cls)} dangerouslySetInnerHTML=${{ __html: iconSvg(name) }}></span>`;
}

/** A square icon button; the label is the tooltip (and visible when `text`). */
export function IconButton({ icon, label, onClick, cls = '', text = false, disabled = false, ...rest }) {
  return html`<button type="button" class=${cx('ibtn', cls)} title=${label} aria-label=${label} onClick=${onClick} disabled=${disabled} ...${rest}>
    <${Icon} name=${icon} />${text ? html`<span class="ibtn__label">${label}</span>` : null}
  </button>`;
}

export const isRepoPath = (src) => !!src && !/^(data:|blob:|https?:)/i.test(src);

export function debounce(fn, ms) {
  let t = null;
  const d = (...args) => { clearTimeout(t); t = setTimeout(() => { t = null; fn(...args); }, ms); };
  d.flush = (...args) => { if (t) { clearTimeout(t); t = null; fn(...args); } };
  d.pending = () => !!t;
  return d;
}
