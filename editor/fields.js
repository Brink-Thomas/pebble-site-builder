/* ==========================================================================
   Small building blocks for the editor UI: editable text, photos from the
   repository, rendered website HTML, and the Inspector's form fields.
   ========================================================================== */

import { html, useRef, useLayoutEffect, useEffect, useState, D, S, cx, Icon, isRepoPath } from './lib.js';
import { store, setUi } from './store.js';
import { resolveImageUrl } from './sync.js';

export const isBlankText = (node) => !node.textContent.replace(/​/g, '').trim() && !node.querySelector('img');

export function plainPaste(e) {
  e.preventDefault();
  const text = (e.clipboardData || window.clipboardData).getData('text/plain');
  document.execCommand('insertText', false, text);
}

/**
 * Rich text, edited in place. The browser owns the DOM while she types:
 * the tree is updated on every keystroke, but the element is only
 * (re)filled when a different block lands here or after undo/redo.
 */
export function TextEditor({ value, onChange, cls, placeholder, id }) {
  const ref = useRef(null);
  const emitted = useRef(null);
  const fill = () => {
    const node = ref.current;
    node.innerHTML = D.sanitizeRichText(value);
    node.toggleAttribute('data-empty', isBlankText(node));
    emitted.current = value;
  };
  useLayoutEffect(fill, [id, store.reloadKey]);
  // Changed somewhere else (not by typing here)? Show it, unless she's typing.
  useLayoutEffect(() => { if (value !== emitted.current && document.activeElement !== ref.current) fill(); }, [value]);
  const onInput = () => {
    const node = ref.current;
    const empty = isBlankText(node);
    node.toggleAttribute('data-empty', empty);
    emitted.current = empty ? '' : D.sanitizeRichText(node.innerHTML);
    onChange(empty ? '' : node.innerHTML);
  };
  return html`<div ref=${ref} class=${cx(cls, 'text-editor')} contentEditable="true" spellcheck="true"
    data-placeholder=${placeholder} onInput=${onInput} onPaste=${plainPaste}></div>`;
}

/** One line of plain text, edited in place (card titles, button labels). */
export function PlainEditor({ value, onChange, cls, placeholder, id, tag = 'span' }) {
  const ref = useRef(null);
  const fill = () => {
    ref.current.textContent = value || '';
    ref.current.toggleAttribute('data-empty', !String(value || '').trim());
  };
  useLayoutEffect(fill, [id, store.reloadKey]);
  useLayoutEffect(() => { if (document.activeElement !== ref.current && ref.current.textContent !== (value || '')) fill(); }, [value]);
  const onInput = () => {
    const t = ref.current.textContent.replace(/\s+/g, ' ').trim();
    ref.current.toggleAttribute('data-empty', !t);
    onChange(t);
  };
  const onKeyDown = (e) => { if (e.key === 'Enter') e.preventDefault(); };
  const Tag = tag;
  return html`<${Tag} ref=${ref} class=${cx(cls, 'plain-editor')} contentEditable="true" spellcheck="true"
    data-placeholder=${placeholder} onInput=${onInput} onKeyDown=${onKeyDown} onPaste=${plainPaste}></${Tag}>`;
}

/** A photo that may live in the repository (resolved to a displayable URL). */
export function Img({ src, alt = '', cls, style }) {
  const [url, setUrl] = useState(isRepoPath(src) ? '' : src);
  const [broken, setBroken] = useState(false);
  useEffect(() => {
    let alive = true;
    setBroken(false);
    if (!isRepoPath(src)) { setUrl(src); return undefined; }
    setUrl('');
    resolveImageUrl(src).then((u) => { if (alive) setUrl(u); }).catch(() => { if (alive) setBroken(true); });
    return () => { alive = false; };
  }, [src]);
  return html`<img src=${url || undefined} alt=${alt} class=${cx(cls, { 'is-loading': !url && !broken, 'is-broken': broken })} style=${style} draggable="false" />`;
}

/**
 * HTML made by the compiler (header/footer previews, the blog feed, the
 * menu), shown as-is. It's parsed in a <template> first so photos load from
 * the repository and never from a wrong address.
 */
export function RenderedHtml({ html: markup, cls }) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const t = document.createElement('template');
    t.innerHTML = markup;
    t.content.querySelectorAll('img').forEach((img) => {
      const src = img.getAttribute('src');
      if (src && isRepoPath(src)) {
        img.removeAttribute('src');
        img.classList.add('is-loading');
        resolveImageUrl(src).then((u) => { img.src = u; img.classList.remove('is-loading'); }).catch(() => img.classList.add('is-broken'));
      }
    });
    ref.current.replaceChildren(t.content);
  }, [markup]);
  return html`<div ref=${ref} class=${cls}></div>`;
}

export function openMedia(current, onPick) { setUi({ media: { current: current || '', onPick } }); }

/* ========================================================================
   INSPECTOR FIELDS
   f = { key, type, label, help, … }; value; onChange(value)
   ======================================================================== */

function linkOptions(allowNone) {
  const opts = [['', allowNone || 'Choose a page…']];
  for (const p of store.site.pages) opts.push([p.file, `Page: ${p.title}`]);
  for (const p of S.sortedPosts(store.site)) opts.push([p.file, `Blog post: ${p.title}`]);
  opts.push(['__external__', 'Another website…']);
  return opts;
}

function ColorField({ value, onChange, defaultLabel }) {
  const t = store.site.settings.theme;
  const choices = [['', defaultLabel || 'Default'], [t.primaryColor, 'Main color'], [t.secondaryColor, 'Second color'],
    ['#ffffff', 'White'], ['#f7f3ec', 'Cream'], ['#efe7db', 'Sand'], ['#eef3f8', 'Light blue'], ['#2d2a26', 'Dark'], ['#000000', 'Black']];
  const current = value || '';
  return html`<div class="insp-colors">
    ${choices.map(([c, name]) => html`<button type="button" class=${cx('insp-swatch', { 'insp-swatch--default': !c, 'is-on': current === c })}
      title=${name} aria-label=${name} style=${c ? `background:${c}` : ''} onClick=${() => onChange(c)}>${c ? null : html`<${Icon} name="ban" />`}</button>`)}
    <label class="insp-swatch insp-swatch--custom" title="Pick any color"><${Icon} name="pipette" />
      <input type="color" value=${current || '#ffffff'} aria-label="Pick any color" onInput=${(e) => onChange(e.target.value)} /></label>
  </div>`;
}

function LinkField({ value, onChange, allowNone }) {
  const internal = !value || !!S.getDoc(store.site, value);
  const [external, setExternal] = useState(!internal);
  const sel = external ? '__external__' : (value || '');
  const applyExt = (v) => {
    let u = v.trim();
    if (u && !/^(https?:|mailto:|tel:)/i.test(u)) u = 'https://' + u;
    onChange(D.safeUrl(u, 'link'));
  };
  return html`<div>
    <select class="insp-input" value=${sel} onChange=${(e) => {
      const v = e.target.value;
      if (v === '__external__') { setExternal(true); onChange(''); } else { setExternal(false); onChange(v); }
    }}>${linkOptions(allowNone).map(([v, t]) => html`<option value=${v}>${t}</option>`)}</select>
    ${external ? html`<input class="insp-input insp-input--external" type="url" placeholder="https://www.example.com"
      value=${internal ? '' : value} onInput=${(e) => applyExt(e.target.value)} />` : null}
  </div>`;
}

function PhotoField({ value, onChange, removable }) {
  return html`<div>
    <div class="insp-photo">${value ? html`<${Img} src=${value} />` : html`<span class="insp-photo__none">No photo yet</span>`}</div>
    <div class="insp-photo__actions">
      <button type="button" class="btn btn--secondary btn--small" onClick=${() => openMedia(value, onChange)}>
        <${Icon} name=${value ? 'refresh-cw' : 'image-plus'} /><span>${value ? 'Replace photo' : 'Choose a photo'}</span></button>
      ${removable && value ? html`<button type="button" class="link-btn link-btn--inline" onClick=${() => onChange('')}>Remove</button>` : null}
    </div>
  </div>`;
}

function RangeField({ value, onChange, min, max, step = 1, unit = '' }) {
  return html`<div class="insp-rangerow">
    <input class="insp-range" type="range" min=${min} max=${max} step=${step} value=${value} onInput=${(e) => onChange(Number(e.target.value))} />
    <output class="insp-out">${value}${unit}</output>
  </div>`;
}

function RadiusField({ value, onChange }) {
  const same = value === '' || value == null;
  const site = store.site.settings.theme.borderRadius;
  return html`<div>
    <label class="insp-check"><input type="checkbox" checked=${same} onChange=${(e) => onChange(e.target.checked ? '' : site)} /> Same as the rest of the website</label>
    ${same ? null : html`<${RangeField} value=${value} min="0" max="40" unit=" px" onChange=${onChange} />`}
  </div>`;
}

export function Field({ f, value, onChange }) {
  if (f.type === 'note') return html`<p class="insp-note">${f.text}</p>`;
  let control;
  switch (f.type) {
    case 'text': control = html`<input class="insp-input" type="text" value=${value || ''} placeholder=${f.placeholder || ''} onInput=${(e) => onChange(e.target.value)} />`; break;
    case 'textarea': control = html`<textarea class="insp-input" rows="3" placeholder=${f.placeholder || ''} value=${value || ''} onInput=${(e) => onChange(e.target.value)}></textarea>`; break;
    case 'select': control = html`<select class="insp-input" value=${value == null ? '' : String(value)} onChange=${(e) => onChange(f.number ? Number(e.target.value) : e.target.value)}>
      ${f.options.map(([v, t]) => html`<option value=${v}>${t}</option>`)}</select>`; break;
    case 'segmented': control = html`<div class="segmented segmented--full">${f.options.map(([v, t, ic]) => html`<button type="button" class=${cx({ 'is-active': value === v })} title=${t} aria-label=${t} onClick=${() => onChange(v)}>${ic ? html`<${Icon} name=${ic} />` : t}</button>`)}</div>`; break;
    case 'link': control = html`<${LinkField} value=${value} onChange=${onChange} allowNone=${f.allowNone} />`; break;
    case 'color': control = html`<${ColorField} value=${value} onChange=${onChange} defaultLabel=${f.defaultLabel} />`; break;
    case 'photo': control = html`<${PhotoField} value=${value} onChange=${onChange} removable=${f.removable} />`; break;
    case 'range': control = html`<${RangeField} value=${value} onChange=${onChange} min=${f.min} max=${f.max} step=${f.step} unit=${f.unit} />`; break;
    case 'radius': control = html`<${RadiusField} value=${value} onChange=${onChange} />`; break;
    case 'date': control = html`<input class="insp-input" type="date" value=${value || ''} onChange=${(e) => onChange(e.target.value)} />`; break;
    case 'toggle': control = html`<label class="toggle"><input type="checkbox" checked=${!!value} onChange=${(e) => onChange(e.target.checked)} /><span class="toggle__switch"></span> ${f.text || ''}</label>`; break;
    case 'code': control = html`<div>
      ${f.warning ? html`<div class="settings-warning"><strong><${Icon} name="triangle-alert" /><span>Careful</span></strong><span>${f.warning}</span></div>` : null}
      <textarea class="insp-input insp-code" rows="10" spellcheck="false" placeholder='<iframe src="…"></iframe>' value=${value || ''} onInput=${(e) => onChange(e.target.value)}></textarea></div>`; break;
    default: control = null;
  }
  return html`<div class="insp-field">
    ${f.label && f.type !== 'toggle' ? html`<span class="insp-label">${f.label}</span>` : null}
    ${control}
    ${f.help ? html`<p class="insp-help">${f.help}</p>` : null}
  </div>`;
}
