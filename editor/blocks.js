/* ==========================================================================
   Block editors: how each block type looks and is edited on the canvas
   (using the website's own classes, so the canvas looks like the site),
   and its fields in the Inspector.

   EDITORS[type] = {
     label, icon, hint,               // the Library tile
     View({ block }),                 // the canvas
     fields: [...],                   // the Inspector (see fields.js)
     regions?: ['header', 'footer'],  // where it may be used
   }
   ========================================================================== */

import { html, C, D, S, cx, Icon } from './lib.js';
import { store, updateBlock, updateSettings } from './store.js';
import { TextEditor, PlainEditor, Img, RenderedHtml, openMedia } from './fields.js';
import { uploadPhoto, reportPhotoError } from './sync.js';

const LINK_FIELD = (key, label, allowNone) => ({ key, label, type: 'link', allowNone });

/** Typing: written into the tree without a repaint, one undo step per burst. */
const typing = (block, field) => (v) => updateBlock(block.id, { [field]: v }, { silent: true, coalesce: `type:${block.id}:${field}` });

/** A photo file dropped from the computer straight onto a photo block. */
function photoDrop(onPath) {
  return {
    onDragOver: (e) => { if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) { e.preventDefault(); e.stopPropagation(); } },
    onDrop: async (e) => {
      const file = e.dataTransfer && e.dataTransfer.files[0];
      if (!file) return;
      e.preventDefault();
      e.stopPropagation();
      try { onPath(await uploadPhoto(file)); } catch (err) { reportPhotoError(err); }
    },
  };
}

function ChangePhoto({ current, onPick }) {
  return html`<button type="button" class="image-change" onClick=${() => openMedia(current, onPick)}><${Icon} name="refresh-cw" /><span>Change photo</span></button>`;
}

/** Website HTML made by the compiler for this block (menu, blog feed). */
const compiled = (block) => C.renderBlock(block, { site: store.site, file: store.ui.current, root: '', n: 0, indent: '' });

export const EDITORS = {
  text: {
    label: 'Text', icon: 'type', hint: 'Stories, titles, lists',
    View: ({ block }) => html`<section class="block block-text">
      <${TextEditor} id=${block.id} value=${block.data.html} onChange=${typing(block, 'html')} cls="block-text__content rich-text" placeholder="Click here and start typing…" />
    </section>`,
    fields: [
      { type: 'note', text: 'Click into the text to type. A toolbar appears with text styles, bold, underline, highlight and alignment.' },
      { type: 'note', text: 'How each text style looks is set for the whole website in Site Settings → Text styles.' },
    ],
  },

  image: {
    label: 'Photo', icon: 'image', hint: 'A picture',
    View({ block }) {
      const d = block.data;
      const set = (patch) => updateBlock(block.id, patch);
      const pick = (src) => set({ src });
      const cropped = d.ratio && d.ratio !== 'auto';
      const style = [d.radius !== '' && d.radius != null ? `--block-radius:${d.radius}px` : '', cropped ? `--ratio:${d.ratio}` : ''].filter(Boolean).join(';');
      if (!d.src) {
        return html`<figure class="block block-image image-editor" ...${photoDrop(pick)}>
          <button type="button" class="image-empty" onClick=${() => openMedia('', pick)}>
            <${Icon} name="image-plus" cls="icon--lg" /><strong>Add a photo</strong><small>Click to pick one of your photos or add a new one</small>
          </button></figure>`;
      }
      return html`<figure class=${cx('block block-image image-editor', { 'block-image--cropped': cropped })} style=${style} ...${photoDrop(pick)}>
        <div class="block-image__media">
          <${Img} src=${d.src} alt=${d.alt || d.caption || 'Photo'} />
          <${ChangePhoto} current=${d.src} onPick=${pick} />
          ${d.href ? html`<span class="image-linkbadge"><${Icon} name="link" /><span>Linked</span></span>` : null}
        </div>
        <${PlainEditor} id=${block.id} tag="figcaption" value=${d.caption} onChange=${typing(block, 'caption')} cls="block-image__caption image-caption" placeholder="Write a caption (optional)" />
      </figure>`;
    },
    fields: [
      { type: 'photo', key: 'src', label: 'Photo' },
      { key: 'ratio', type: 'select', label: 'Shape', options: [['auto', 'The photo’s own shape'], ['16/9', 'Wide (16:9)'], ['4/3', 'Classic (4:3)'], ['1/1', 'Square'], ['3/4', 'Tall (3:4)']] },
      { key: 'alt', type: 'text', label: 'Describe the photo', placeholder: 'e.g. Pink roses along a wooden fence', help: 'Read aloud to people who can’t see the photo, and used by search engines. If empty, the caption is used.' },
      LINK_FIELD('href', 'When someone clicks the photo, go to', 'Nowhere (no link)'),
      { key: 'radius', type: 'radius', label: 'Corner roundness' },
    ],
  },

  card: {
    label: 'Card', icon: 'layout-panel-top', hint: 'Photo, title and text',
    View({ block }) {
      const d = block.data;
      const pick = (src) => updateBlock(block.id, { src });
      const style = [d.bg ? `--card-bg:${d.bg}` : '', d.textColor ? `--card-text:${d.textColor}` : ''].filter(Boolean).join(';');
      return html`<article class=${cx('block block-card card-editor', d.border !== 'accent' && `block-card--${d.border}`)} style=${style} ...${photoDrop(pick)}>
        ${d.src
          ? html`<div class="block-card__media"><${Img} src=${d.src} /><${ChangePhoto} current=${d.src} onPick=${pick} /></div>`
          : html`<div class="block-card__media card-editor__nomedia"><button type="button" class="card-editor__addphoto" onClick=${() => openMedia('', pick)}><${Icon} name="image-plus" /><span>Add a photo</span></button></div>`}
        <div class="block-card__body">
          <${PlainEditor} id=${block.id} tag="h3" value=${d.title} onChange=${typing(block, 'title')} cls="block-card__title" placeholder="Card title" />
          <${TextEditor} id=${block.id} value=${d.html} onChange=${typing(block, 'html')} cls="block-card__text rich-text" placeholder="A few words…" />
          ${d.href ? html`<span class="block-card__link">${d.linkLabel || 'Read more'}</span>` : null}
        </div>
      </article>`;
    },
    fields: [
      { type: 'photo', key: 'src', label: 'Photo', removable: true },
      { key: 'bg', type: 'color', label: 'Background color', defaultLabel: 'White' },
      { key: 'textColor', type: 'color', label: 'Text color', defaultLabel: 'Normal' },
      { key: 'border', type: 'select', label: 'Border', options: [['accent', 'A colored line on top'], ['outline', 'A thin outline'], ['shadow', 'A soft shadow'], ['none', 'No border']] },
      LINK_FIELD('href', 'The card’s link goes to', 'No link'),
      { key: 'linkLabel', type: 'text', label: 'Link text', placeholder: 'Read more' },
    ],
  },

  button: {
    label: 'Button', icon: 'mouse-pointer-click', hint: 'A link to a page',
    View({ block }) {
      const d = block.data;
      return html`<div class=${`block block-button block-button--${d.align} button-editor`}>
        <${PlainEditor} id=${block.id} value=${d.label} onChange=${typing(block, 'label')} cls=${`block-button__link block-button__link--${d.style}`} placeholder="Button text" />
        ${d.href ? null : html`<span class="button-editor__hint">Choose where it goes in the panel on the right</span>`}
      </div>`;
    },
    fields: [
      { key: 'label', type: 'text', label: 'Button text' },
      LINK_FIELD('href', 'Goes to'),
      { key: 'style', type: 'select', label: 'Look', options: [['primary', 'Filled with the main color'], ['accent', 'Filled with the second color'], ['secondary', 'Outline only']] },
      { key: 'align', type: 'segmented', label: 'Position', options: [['left', 'Left', 'align-left'], ['center', 'Middle', 'align-center'], ['right', 'Right', 'align-right']] },
    ],
  },

  'blog-feed': {
    label: 'Blog posts', icon: 'newspaper', hint: 'Your latest posts',
    View({ block }) {
      if (!store.site.posts.length) {
        return html`<section class="block block-blog-feed"><div class="feed-editor__empty"><${Icon} name="newspaper" cls="icon--lg" />
          <strong>Your blog posts will appear here</strong><small>Write one from the Blog page in the list on the left.</small></div></section>`;
      }
      return html`<${RenderedHtml} cls="block-static feed-editor" html=${compiled(block)} />`;
    },
    fields: [
      { key: 'limit', type: 'select', label: 'How many posts to show', number: true, options: [['3', 'The newest 3'], ['6', 'The newest 6'], ['12', 'The newest 12'], ['0', 'All of them']] },
      { type: 'note', text: 'Posts appear here automatically, newest first, with their cover photo and summary.' },
    ],
  },

  embed: {
    label: 'Embed code', icon: 'code', hint: 'For website helpers', advanced: true,
    // Never put the code into the editor's own page: it could read her login.
    View: ({ block }) => html`<div class="block block-embed embed-editor">
      <strong class="embed-editor__title"><${Icon} name="code" /><span>Custom code</span></strong>
      <span class="embed-editor__note">It runs on your published website, not here. Change it in the panel on the right.</span>
      ${block.data.code ? html`<code class="embed-editor__code">${block.data.code.slice(0, 160)}</code>` : null}
    </div>`,
    fields: [{
      key: 'code', type: 'code', label: 'Code to add to the page',
      warning: 'For website helpers only. Code copied from the internet can break your website or make it unsafe. If someone sent you this, make sure you trust them.',
    }],
  },

  'site-title': {
    label: 'Website name & logo', icon: 'badge', hint: 'Linked to your homepage', regions: ['header', 'footer'],
    View() {
      const s = store.site.settings;
      const b = s.branding;
      const rename = (v) => updateSettings((st) => { st.siteName = v || 'My website'; }, { silent: true, coalesce: 'site-name' });
      return html`<div class="block block-site-title"><div class="site-title">
        ${b.logo ? html`<${Img} cls="site-title__logo" src=${b.logo} style=${`height:${b.logoHeight}px`} />` : null}
        ${!b.logo || b.logoMode === 'logo-name' ? html`<${PlainEditor} id="site-name" value=${s.siteName} onChange=${rename} cls="site-title__name site-title-input" placeholder="Website name" />` : null}
      </div></div>`;
    },
    fields: [{ type: 'note', text: 'Your website’s name (and logo), linked to your homepage. Click the name to change it. Add a logo in Site Settings → Branding.' }],
  },

  menu: {
    label: 'Site menu', icon: 'menu', hint: 'Links to your pages', regions: ['header', 'footer'],
    View: ({ block }) => html`<${RenderedHtml} cls="block-static menu-editor" html=${compiled(block)} />`,
    fields: [
      { key: 'align', type: 'segmented', label: 'Position', options: [['left', 'Left', 'align-left'], ['center', 'Middle', 'align-center'], ['right', 'Right', 'align-right']] },
      { type: 'note', text: 'The menu shows the pages under “Main Menu” in the list on the left. On phones it folds into a menu button.' },
    ],
  },
};

/** May this block be added to the doc on the canvas? */
export function allowedHere(type) {
  const kind = S.docKind(store.site, store.ui.current);
  const regions = EDITORS[type].regions;
  if (regions) return regions.includes(kind);
  if (type === 'blog-feed') return kind === 'page' || kind === 'post';
  return true;
}

export const LIBRARY_GROUPS = [
  ['Basics', ['text', 'image', 'card', 'button']],
  ['Blog', ['blog-feed']],
  ['Website parts', ['site-title', 'menu']],
  ['For website helpers', ['embed']],
];

export { D };
