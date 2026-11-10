/* ==========================================================================
   Dialogs: Site Settings, photo library, preview, "you're live", the
   publish conflict question, new page / post, and the loading screen.
   ========================================================================== */

import { html, useRef, useEffect, useLayoutEffect, useState, useMemo, D, S, C, cx, Icon, IconButton, isRepoPath } from './lib.js';
import { store, setUi, updateSettings, createPage, createPost, flushNow, openDoc, toast } from './store.js';
import { Img, openMedia } from './fields.js';
import { uploadPhoto, reportPhotoError, fetchImageLibrary, resolveImageUrl, dashboardUrl } from './sync.js';

/** A native <dialog>, opened as a modal while `open` is true. */
function Modal({ open, onClose, cls, children, label }) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const d = ref.current;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  useEffect(() => {
    const d = ref.current;
    const onCancel = (e) => { e.preventDefault(); onClose && onClose(); };
    d.addEventListener('cancel', onCancel);
    return () => d.removeEventListener('cancel', onCancel);
  }, [onClose]);
  return html`<dialog ref=${ref} class=${cx('dialog', cls)} aria-label=${label}>${open ? children : null}</dialog>`;
}

const closeDialog = () => setUi({ dialog: null, dialogData: null });

/* ========================================================================
   SITE SETTINGS
   ======================================================================== */

const COLOR_SWATCHES = {
  primary: ['#b85c38', '#2f6fdf', '#1f8a4c', '#8e44ad', '#c0392b', '#1d3557', '#d4a017', '#2d2a26'],
  secondary: ['#6b8b4f', '#e9a03b', '#3aa8a0', '#d76a85', '#7a8ca3', '#a0522d', '#5c6bc0', '#b5838d'],
};
const WEIGHT_NAMES = { 300: 'Light', 400: 'Normal', 500: 'Medium', 600: 'Semi-bold', 700: 'Bold', 800: 'Extra bold', 900: 'Black' };

function FontOptions({ inherit }) {
  const s = store.site.settings;
  const custom = s.typography.customFont;
  const siteLabel = s.theme.fontFamily === 'custom' && custom ? custom.name : (D.FONTS[s.theme.fontFamily] || D.FONTS.classic).label;
  return html`${inherit ? html`<option value="">Website font (${siteLabel})</option>` : null}
    ${Object.entries(D.FONTS).map(([k, f]) => html`<option value=${k}>${f.label}</option>`)}
    ${custom ? html`<option value="custom">${custom.name} (your own font)</option>` : null}`;
}

function Range({ value, min, max, step = 1, unit = '', onInput, label }) {
  return html`<div class="settings-rangerow">
    <input class="settings-range" type="range" min=${min} max=${max} step=${step} value=${value} aria-label=${label} onInput=${(e) => onInput(e.target.value)} />
    <output class="settings-out">${value}${unit}</output></div>`;
}

function BrandPick({ label, value, help, onPick, kind }) {
  return html`<div class="brand-pick">
    <span class="settings-sublabel">${label}</span>
    <div class=${`brand-pick__preview brand-pick__preview--${kind}`}>${value ? html`<${Img} src=${value} />` : html`<${Icon} name="image" />`}</div>
    <div class="brand-pick__actions">
      <button type="button" class="btn btn--secondary btn--small" onClick=${() => openMedia(value, onPick)}><${Icon} name="upload" /><span>${value ? 'Replace' : 'Upload or choose'}</span></button>
      ${value ? html`<button type="button" class="link-btn link-btn--inline" onClick=${() => onPick('')}>Remove</button>` : null}
    </div>
    ${help ? html`<p class="settings-help">${help}</p>` : null}
  </div>`;
}

function SiteSettings() {
  const s = store.site.settings;
  const t = s.theme;
  const ty = s.typography;
  const b = s.branding;
  const [fontInput, setFontInput] = useState('');
  const [fontError, setFontError] = useState('');
  const [open, setOpen] = useState('');
  const set = (fn, key) => updateSettings(fn, key ? { coalesce: `settings:${key}` } : {});
  const setTheme = (patch, key) => set((st) => { st.theme = { ...st.theme, ...patch }; }, key);
  const setBranding = (patch, key) => set((st) => { st.branding = { ...st.branding, ...patch }; }, key);
  const setStyle = (k, patch, key) => set((st) => { st.typography = { ...st.typography, styles: { ...st.typography.styles, [k]: { ...st.typography.styles[k], ...patch } } }; }, key);

  const useCustomFont = () => {
    const parsed = D.parseCustomFont(fontInput);
    if (!parsed) { setFontError('Pebble couldn’t find a Google font in that. Paste a font name (like “Dancing Script”) or the link from fonts.google.com.'); return; }
    setFontError('');
    set((st) => { st.typography = { ...st.typography, customFont: parsed }; st.theme = { ...st.theme, fontFamily: 'custom' }; });
    setFontInput('');
  };
  const clearCustomFont = () => set((st) => {
    const styles = {};
    for (const [k, v] of Object.entries(st.typography.styles)) styles[k] = v.font === 'custom' ? { ...v, font: '' } : v;
    st.typography = { styles, customFont: null };
    if (st.theme.fontFamily === 'custom') st.theme = { ...st.theme, fontFamily: 'classic' };
  });
  const uploadCss = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 200 * 1024) { toast('That file is too big for a style file.'); return; }
    const text = await file.text();
    set((st) => { st.customCss = text; });
    toast(`Added “${file.name}”.`);
  };

  return html`<div class="dialog__bar">
      <strong class="dialog__title"><${Icon} name="palette" /><span>Site Settings</span></strong>
      <button type="button" class="tbtn tbtn--primary" onClick=${closeDialog}><span class="tbtn__label tbtn__label--always">Done</span></button>
    </div>
    <div class="settings-body">
      <p class="settings-intro">Changes show up right away. They go online when you press <b>Publish</b>.</p>

      <section class="settings-section">
        <label class="settings-label" for="set-site-name">Website name</label>
        <input class="settings-input" id="set-site-name" type="text" maxLength="80" value=${s.siteName} onInput=${(e) => set((st) => { st.siteName = e.target.value; }, 'name')} />
      </section>

      <section class="settings-section">
        <span class="settings-label">Branding <small>logo and browser-tab icon</small></span>
        <div class="branding">
          <${BrandPick} label="Logo" kind="logo" value=${b.logo} help="Shown in your Header. It’s also kept in your photo library." onPick=${(p) => setBranding({ logo: p })} />
          ${b.logo ? html`
            <select class="settings-input" aria-label="How to show the logo" value=${b.logoMode} onChange=${(e) => setBranding({ logoMode: e.target.value })}>
              <option value="logo-name">Logo and website name</option><option value="logo">Logo only</option></select>
            <span class="settings-sublabel">Logo size</span>
            <${Range} label="Logo size" value=${b.logoHeight} min="16" max="140" unit=" px" onInput=${(v) => setBranding({ logoHeight: v }, 'logo-size')} />` : null}
          <${BrandPick} label="Favicon" kind="favicon" value=${b.favicon} help="The little picture in the browser tab. A small square image works best." onPick=${(p) => setBranding({ favicon: p })} />
        </div>
      </section>

      ${['primary', 'secondary'].map((which) => html`<section class="settings-section">
        <span class="settings-label">${which === 'primary' ? 'Main color' : 'Second color'} <small>${which === 'primary' ? 'buttons, links, menu' : 'dates, card edges, quotes'}</small></span>
        <div class="swatches">
          ${COLOR_SWATCHES[which].map((c) => html`<button type="button" class=${cx('swatch', { 'is-on': t[`${which}Color`] === c })} style=${`background:${c}`} title=${c} aria-label=${`Use color ${c}`} onClick=${() => setTheme({ [`${which}Color`]: c })}></button>`)}
          <label class="swatch swatch--custom" title="Pick any color"><input type="color" value=${t[`${which}Color`]} aria-label="Pick any color" onInput=${(e) => setTheme({ [`${which}Color`]: e.target.value }, which)} /><${Icon} name="pipette" /></label>
        </div>
      </section>`)}

      <section class="settings-section">
        <label class="settings-label" for="set-font">Website font <small>used by every text style set to “Website font”</small></label>
        <select class="settings-input" id="set-font" value=${t.fontFamily === 'custom' && !ty.customFont ? 'classic' : t.fontFamily} onChange=${(e) => setTheme({ fontFamily: e.target.value })}><${FontOptions} /></select>
        <div class="custom-font">
          <label class="settings-sublabel" for="set-custom-font">Use a custom font</label>
          <p class="settings-help">Found a font on fonts.google.com? Paste its name or link here.</p>
          <div class="custom-font__row">
            <input class="settings-input" id="set-custom-font" type="text" placeholder="e.g. Dancing Script" autocomplete="off" spellcheck="false" value=${fontInput}
              onInput=${(e) => setFontInput(e.target.value)} onKeyDown=${(e) => { if (e.key === 'Enter') { e.preventDefault(); useCustomFont(); } }} />
            <button type="button" class="btn btn--secondary btn--small" onClick=${useCustomFont}>Use this font</button>
          </div>
          <p class=${cx('custom-font__status', { 'is-ok': ty.customFont && !fontError, 'is-error': fontError })} role="status">${fontError || (ty.customFont ? `Using “${ty.customFont.name}”` : '')}</p>
          ${ty.customFont ? html`<button type="button" class="link-btn link-btn--inline" onClick=${clearCustomFont}>Stop using my own font</button>` : null}
        </div>
      </section>

      <section class="settings-section">
        <span class="settings-label">Text styles <small>font, size and boldness of each style</small></span>
        ${Object.keys(D.TEXT_STYLES).map((k) => {
          const st = ty.styles[k];
          return html`<details class="text-style" open=${open === k} onToggle=${(e) => { if (e.target.open) setOpen(k); else if (open === k) setOpen(''); }}>
            <summary class="text-style__summary">
              <span class="text-style__sample" style=${`font-size:${Math.min(st.size, 28)}px;font-weight:${st.weight};font-family:var(--text-${k}-font)`}>${st.name}</span>
              <span class="text-style__meta">${st.size}px · ${WEIGHT_NAMES[st.weight] || st.weight}</span>
            </summary>
            <div class="text-style__fields">
              <label class="text-style__field"><span>Name</span><input class="settings-input" type="text" maxLength="30" value=${st.name} onInput=${(e) => setStyle(k, { name: e.target.value || D.TEXT_STYLES[k].name }, `style-name-${k}`)} /></label>
              <label class="text-style__field"><span>Font</span><select class="settings-input" value=${st.font || ''} onChange=${(e) => setStyle(k, { font: e.target.value })}><${FontOptions} inherit=${true} /></select></label>
              <div class="text-style__field"><span>Size</span><${Range} label="Size" value=${st.size} min="10" max="96" unit=" px" onInput=${(v) => setStyle(k, { size: v }, `size-${k}`)} /></div>
              <div class="text-style__field"><span>Line spacing</span><${Range} label="Line spacing" value=${st.lineHeight} min="0.9" max="2.4" step="0.05" onInput=${(v) => setStyle(k, { lineHeight: v }, `lh-${k}`)} /></div>
              <label class="text-style__field"><span>Boldness</span><select class="settings-input" value=${st.weight} onChange=${(e) => setStyle(k, { weight: e.target.value })}>
                ${D.WEIGHTS.map((w) => html`<option value=${w}>${WEIGHT_NAMES[w]}</option>`)}</select></label>
            </div>
          </details>`;
        })}
      </section>

      <section class="settings-section">
        <div class="settings-labelrow"><span class="settings-label">Roundness</span></div>
        <${Range} label="Roundness" value=${t.borderRadius} min="0" max="32" unit=" px" onInput=${(v) => setTheme({ borderRadius: v }, 'radius')} />
        <div class="range-labels"><span>Square</span><span>Round</span></div>
      </section>
      <section class="settings-section">
        <div class="settings-labelrow"><span class="settings-label">Spacing</span></div>
        <${Range} label="Spacing" value=${t.blockSpacing} min="8" max="40" step="2" unit=" px" onInput=${(v) => setTheme({ blockSpacing: v }, 'spacing')} />
        <div class="range-labels"><span>Snug</span><span>Airy</span></div>
      </section>

      <details class="settings-advanced">
        <summary>Advanced</summary>
        <div class="settings-warning"><strong><${Icon} name="triangle-alert" /><span>For website helpers</span></strong>
          <span>Extra design code (CSS) for your website, saved as <code>theme.css</code>. Mistakes here can make your website look broken. If you’re not sure, leave this empty.</span></div>
        <textarea class="settings-code" rows="10" spellcheck="false" placeholder=".block-card { box-shadow: none; }" value=${s.customCss} onInput=${(e) => set((st) => { st.customCss = e.target.value; }, 'css')}></textarea>
        <label class="btn btn--secondary btn--small">Upload a .css file…<input type="file" accept=".css,text/css" hidden onChange=${uploadCss} /></label>
      </details>
    </div>`;
}

/* ========================================================================
   PHOTO LIBRARY
   ======================================================================== */

function MediaLibrary() {
  const m = store.ui.media;
  const [images, setImages] = useState(null);
  const [error, setError] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [over, setOver] = useState(false);
  const fileRef = useRef(null);
  const load = () => {
    setError(false);
    setImages(null);
    fetchImageLibrary().then(setImages).catch((err) => { console.error('Pebble: photo library failed', err); setError(true); });
  };
  useEffect(load, []);
  const pick = (path) => { const cb = m.onPick; setUi({ media: null }); if (cb) cb(path); };
  const upload = async (file) => {
    if (!file) return;
    setUploading(true);
    try { const path = await uploadPhoto(file); toast('Photo added.'); pick(path); } catch (err) { reportPhotoError(err); } finally { setUploading(false); }
  };
  const nice = (name) => name.replace(/^\d{8}-\d{6}-/, '').replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ');
  return html`<div class="dialog__bar">
      <strong class="dialog__title"><${Icon} name="images" /><span>Choose a photo</span></strong>
      <button type="button" class="btn btn--secondary" onClick=${() => setUi({ media: null })}>Cancel</button>
    </div>
    <div class="media-body">
      <div class=${cx('media-upload', { 'is-dragover': over })}
        onDragOver=${(e) => { e.preventDefault(); setOver(true); }} onDragLeave=${() => setOver(false)}
        onDrop=${(e) => { e.preventDefault(); setOver(false); upload(e.dataTransfer && e.dataTransfer.files[0]); }}>
        <span class="media-upload__icon"><${Icon} name="upload" cls="icon--lg" /></span>
        <div class="media-upload__text"><strong>Add a new photo from your computer</strong><small>or drag a photo here</small></div>
        <button type="button" class="btn btn--publish" disabled=${uploading} onClick=${() => fileRef.current.click()}>${uploading ? 'Adding your photo…' : 'Choose a photo…'}</button>
        <input ref=${fileRef} type="file" accept="image/jpeg,image/png,image/gif,image/webp,image/heic,image/heif" hidden onChange=${(e) => { upload(e.target.files[0]); e.target.value = ''; }} />
      </div>
      <h3 class="media-heading">Your photos</h3>
      ${error ? html`<p class="media-status">Sorry, your photos could not be loaded. <button type="button" class="link-btn link-btn--inline" onClick=${load}>Try again</button></p>`
        : !images ? html`<p class="media-status"><span class="spinner"></span> Finding your photos…</p>`
        : !images.length ? html`<p class="media-status">No photos yet. Add your first one above.</p>`
        : html`<div class="media-grid">${images.map((im) => html`<button type="button" class=${cx('media-thumb', { 'is-current': im.path === m.current })} title="Use this photo" onClick=${() => pick(im.path)}>
            <${Img} src=${im.path} /><span class="media-thumb__label">${im.path === m.current ? 'In use here' : nice(im.name)}</span></button>`)}</div>`}
    </div>`;
}

/* ========================================================================
   PREVIEW — the compiled page, sandboxed (no scripts)
   ======================================================================== */

function Preview() {
  const kind = S.docKind(store.site, store.ui.current);
  const [file, setFile] = useState(kind === 'page' || kind === 'post' ? store.ui.current : 'index.html');
  const [phone, setPhone] = useState(false);
  const frame = useRef(null);
  const srcdoc = useMemo(() => {
    const site = C.withExcerpts(S.normalizeSite(JSON.parse(JSON.stringify(store.site))));
    const css = D.globalCss(site.settings.theme, store.baseCss, site.settings.typography) + '\n' + site.settings.customCss;
    return C.compileToStaticHTML(site, S.getDoc(site, file) ? file : 'index.html', { inlineCss: css });
  }, [file]);
  const onLoad = () => {
    const doc = frame.current && frame.current.contentDocument;
    if (!doc) return;
    const base = `https://site.invalid/${file}`;
    const toPath = (href) => new URL(href, base).pathname.slice(1);
    doc.querySelectorAll('img[src]').forEach((img) => {
      const src = img.getAttribute('src');
      if (isRepoPath(src)) resolveImageUrl(toPath(src)).then((u) => { img.src = u; }).catch(() => {});
    });
    doc.addEventListener('click', (e) => {
      const a = e.target.closest('a[href]');
      if (!a) return;
      e.preventDefault();
      const href = a.getAttribute('href');
      if (/^https?:/i.test(href)) { window.open(href, '_blank', 'noopener'); return; }
      const path = toPath(href);
      const k = S.docKind(store.site, path);
      if (k === 'page' || k === 'post') setFile(path);
    });
  };
  return html`<div class="dialog__bar">
      <strong class="dialog__title"><${Icon} name="eye" /><span>How visitors see your page</span></strong>
      <div class="segmented" role="group" aria-label="Screen size">
        <button type="button" class=${cx({ 'is-active': !phone })} onClick=${() => setPhone(false)}><${Icon} name="monitor" /><span>Computer</span></button>
        <button type="button" class=${cx({ 'is-active': phone })} onClick=${() => setPhone(true)}><${Icon} name="smartphone" /><span>Phone</span></button>
      </div>
      <button type="button" class="btn btn--secondary" onClick=${closeDialog}>Back to editing</button>
    </div>
    <div class="preview-stage">
      <iframe ref=${frame} title="Page preview" class=${cx('preview-frame', { 'is-phone': phone })} sandbox="allow-same-origin allow-popups" srcdoc=${srcdoc} onLoad=${onLoad}></iframe>
    </div>`;
}

/* ========================================================================
   PUBLISHED / CONFLICT / NEW PAGE
   ======================================================================== */

function Published() {
  const files = (store.ui.dialogData && store.ui.dialogData.files) || [];
  const svc = store.service;
  const site = store.site;
  const rows = [];
  const added = new Set(files.filter((f) => f.status === 'added').map((f) => f.path));
  for (const f of files) {
    if (f.status === 'removed') continue;
    const meta = S.pageOf(site, f.path) || S.postOf(site, f.path);
    if (meta) rows.push(html`<li><${Icon} name=${S.postOf(site, f.path) ? 'file-text' : 'file'} /><span>${meta.title}</span>${added.has(f.path) ? html`<span class="tag">new</span>` : null}</li>`);
  }
  if (files.some((f) => f.path === 'global.css' || f.path === 'theme.css')) rows.push(html`<li><${Icon} name="palette" /><span>Your website’s look</span></li>`);
  const photos = files.filter((f) => f.path.startsWith(svc.imageDir + '/') && f.status === 'added').length;
  if (photos) rows.push(html`<li><${Icon} name="image" /><span>${photos} new photo${photos > 1 ? 's' : ''}</span></li>`);
  if (!rows.length) rows.push(html`<li><${Icon} name="check" /><span>Your latest changes</span></li>`);
  return html`<div class="publish-done">
    <div class="publish-done__icon"><${Icon} name="circle-check" cls="icon--xl" /></div>
    <h2>Your website is live!</h2>
    <p>Everyone can now see:</p>
    <ul class="publish-done__list">${rows}</ul>
    <p>Visit it at <a href=${svc.siteUrl} target="_blank" rel="noopener">${svc.siteUrl.replace(/^https?:\/\//, '').replace(/\/$/, '')}</a>. It can take a minute or two to show up.</p>
    ${svc.isDemo ? html`<p class="publish-done__dev">This is a demo, so nothing was really put online.</p>` : null}
    <button type="button" class="btn btn--publish" onClick=${closeDialog}>Wonderful</button>
  </div>`;
}

function Conflict() {
  const answer = (yes) => { const r = store.ui.dialogData && store.ui.dialogData.resolve; closeDialog(); if (r) r(yes); };
  return html`<div class="publish-done">
    <div class="publish-done__icon publish-done__icon--warn"><${Icon} name="git-compare-arrows" cls="icon--xl" /></div>
    <h2>Your website was changed somewhere else</h2>
    <p>Since you started, someone (maybe you, on another computer) changed some of the same pages.</p>
    <p>Do you want to publish what you see here? On the pages you changed, your version will replace theirs.</p>
    <div class="dialog__actions dialog__actions--center">
      <button type="button" class="btn btn--publish" onClick=${() => answer(true)}>Publish my version</button>
      <button type="button" class="btn btn--secondary" onClick=${() => answer(false)}>Not now</button>
    </div>
  </div>`;
}

function NewDoc() {
  const post = store.ui.dialogData && store.ui.dialogData.mode === 'post';
  const [name, setName] = useState('');
  const [inMenu, setInMenu] = useState(true);
  const ref = useRef(null);
  useLayoutEffect(() => { ref.current && ref.current.focus(); }, []);
  const file = name.trim() ? S.uniqueFile(store.site, D.slugify(name, post ? 'post' : 'page'), post ? 'blog/' : '') : '…';
  const submit = (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    closeDialog();
    if (post) createPost(name); else createPage(name, inMenu);
  };
  return html`<form class="newpage-form" onSubmit=${submit}>
    <h2>${post ? 'Write a new blog post' : 'Add a new page'}</h2>
    <label class="newpage-form__label" for="newpage-name">${post ? 'What is your post called?' : 'What should the page be called?'}</label>
    <input ref=${ref} id="newpage-name" class="newpage-form__input" type="text" maxLength="140" required autocomplete="off"
      placeholder=${post ? 'For example: My first tomatoes' : 'For example: My recipes'} value=${name} onInput=${(e) => setName(e.target.value)} />
    <p class="newpage-form__address">Its web address will end in <code>${file}</code></p>
    ${post ? null : html`<label class="newpage-form__check"><input type="checkbox" checked=${inMenu} onChange=${(e) => setInMenu(e.target.checked)} /> Add a link to it in the website menu</label>`}
    <div class="dialog__actions">
      <button type="submit" class="btn btn--publish">${post ? 'Start writing' : 'Create page'}</button>
      <button type="button" class="btn btn--secondary" onClick=${closeDialog}>Cancel</button>
    </div>
  </form>`;
}

export function Dialogs() {
  const d = store.ui.dialog;
  return html`
    <${Modal} open=${d === 'settings'} onClose=${closeDialog} cls="dialog--side" label="Site Settings"><${SiteSettings} /></${Modal}>
    <${Modal} open=${d === 'preview'} onClose=${closeDialog} cls="dialog--preview" label="Preview"><${Preview} /></${Modal}>
    <${Modal} open=${d === 'published'} onClose=${closeDialog} cls="dialog--small" label="Your website is live"><${Published} /></${Modal}>
    <${Modal} open=${d === 'conflict'} onClose=${() => { const r = store.ui.dialogData && store.ui.dialogData.resolve; closeDialog(); if (r) r(false); }} cls="dialog--small" label="Changed somewhere else"><${Conflict} /></${Modal}>
    <${Modal} open=${d === 'newdoc'} onClose=${closeDialog} cls="dialog--small" label="New"><${NewDoc} /></${Modal}>
    <${Modal} open=${!!store.ui.media} onClose=${() => setUi({ media: null })} cls="dialog--media" label="Choose a photo"><${MediaLibrary} /></${Modal}>`;
}

export function Loading() {
  const ui = store.ui;
  if (!ui.loading && !ui.blocked) return null;
  return html`<div class="loading" role="status" aria-live="polite"><div class=${cx('loading__card', { 'loading__card--blocked': ui.blocked })}>
    ${ui.blocked ? null : html`<span class="spinner"></span>`}
    <p class="loading__msg">${ui.blocked || ui.loading}</p>
    ${ui.blocked ? html`<a class="btn btn--secondary" href=${dashboardUrl()}>Back to your websites</a>` : null}
  </div></div>`;
}

export { flushNow, openDoc };
