/* ==========================================================================
   GitHub sync: open a website, Save draft, Publish, photos.

   Opening:  site.json → the tree.  (A website from Pebble v2–v4 has no
             site.json: its pages are imported once, see PebbleState.importLegacy.)
   Saving:   compile the tree → commit every file whose text changed
             (site.json, global.css, pages…) to the draft branch, and delete
             files Pebble no longer uses.
   Publish:  save, then merge draft → live (GitHub Pages serves live).
   ========================================================================== */

import { S, C, D, isRepoPath } from './lib.js';
import {
  store, emit, setUi, toast, computePending, persistLocal, loadLocal, updateStatus, flushNow, resetHistory, lastDocKey, openDoc,
} from './store.js';

const CONFIG = {
  demoRepo: { owner: 'demo-user', repo: 'my-garden-blog' },
  maxImageSide: 1600,
  baseCssUrl: new URL('../lib/site-base.css', import.meta.url).href,
};

export const dashboardUrl = () => PebbleAuth.appRoot + (store.service && store.service.isDemo ? '?demo=1' : '');

function createService() {
  const site = new URLSearchParams(location.search).get('site') || '';
  if (site === 'demo') return new MockGitHubService(CONFIG.demoRepo);
  const m = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/.exec(site);
  if (!m || !PebbleAuth.getSession()) return null;
  return new GitHubService({
    owner: m[1],
    repo: m[2],
    token: () => PebbleAuth.getToken(),
    onUnauthorized: () => PebbleAuth.handleExpired(),
  });
}

const readRef = () => (store.hasDraftBranch ? store.service.draftBranch : store.service.liveBranch);

/** Text files Pebble reads: site.json, the CSS, pages and posts (and v2–v4 files, for importing). */
const isSiteFile = (path) => /^(?:blog\/)?[a-z0-9][a-z0-9-]{0,60}\.html$/.test(path) ||
  ['site.json', 'site-config.json', 'global.css', 'theme.css'].includes(path);

async function loadRemoteFiles(ref) {
  const svc = store.service;
  const [root, blog] = await Promise.all([svc.listDirectory('', ref), svc.listDirectory('blog', ref)]);
  const paths = [...root, ...blog].filter((i) => i.type === 'file' && isSiteFile(i.path)).map((i) => i.path);
  const files = await Promise.all(paths.map((p) => svc.fetchFile(p, ref)));
  store.remote = new Map(files.map((f) => [f.path, { content: f.content, sha: f.sha }]));
}

const prettyName = (repo) => repo.replace(/\.github\.io$/i, '').replace(/[-_.]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/** The tree from the repository: site.json, else an older Pebble site, else a new one. */
function siteFromRemote() {
  const json = store.remote.get('site.json');
  if (json) {
    try { return { site: S.normalizeSite(JSON.parse(json.content)), upgraded: false }; } catch (err) { console.warn('Pebble: site.json unreadable', err); }
  }
  const texts = Object.fromEntries(Array.from(store.remote, ([p, f]) => [p, f.content]));
  const imported = S.importLegacy(texts);
  if (imported) return { site: imported, upgraded: true };
  return { site: S.createSite(prettyName(store.service.repo)), upgraded: false, fresh: true };
}

export async function boot() {
  const svc = createService();
  if (!svc) { location.replace(PebbleAuth.appRoot); return; }
  store.service = svc;
  setUi({ loading: 'Opening your website…' });
  try {
    store.baseCss = await fetch(CONFIG.baseCssUrl, { cache: 'no-cache' }).then((r) => r.text());
    const publishing = await svc.getPublishingInfo().catch((err) => { if (err.status === 401) throw err; return null; });
    if (publishing && publishing.path && publishing.path !== '/') { setUi({ blocked: 'This website is set up in a way Pebble can’t edit yet.' }); return; }
    if (publishing && publishing.branch) svc.liveBranch = publishing.branch;
    else svc.liveBranch = (await svc.getRepoInfo()).defaultBranch || svc.liveBranch;
    if (publishing && publishing.url) svc.publishedUrl = publishing.url;
    if (svc.draftBranch === svc.liveBranch) svc.draftBranch = 'pebble-draft';

    store.hasDraftBranch = await svc.hasDraft();
    const [diff] = await Promise.all([svc.compareDraftToLive(), loadRemoteFiles(readRef())]);
    store.draftAhead = diff.ahead;
    if (store.hasDraftBranch) {
      const [a, b] = await Promise.all([svc.listDirectory('', svc.liveBranch), svc.listDirectory('blog', svc.liveBranch)]);
      store.livePaths = new Set([...a, ...b].map((i) => i.path));
    } else {
      store.livePaths = new Set(store.remote.keys());
    }

    const home = store.remote.get('index.html');
    if (home && !store.remote.get('site.json') && !C.isPebblePage(home.content)) {
      setUi({ blocked: 'This website wasn’t made with Pebble, so Pebble won’t change it.' });
      return;
    }

    const { site, upgraded } = siteFromRemote();
    const local = loadLocal();
    store.site = local ? S.normalizeSite(local) : site;
    resetHistory();

    let start = null;
    try { start = localStorage.getItem(lastDocKey()); } catch { /* ignore */ }
    if (!S.getDoc(store.site, start)) start = 'index.html';
    store.ui.loading = null;
    openDoc(start);
    flushNow();
    emit();
    if (!upgraded && !store.remote.get('index.html')) toast('Your website is ready. Press “Publish” to put it online.');
    if (upgraded) toast('Pebble has been rebuilt to be faster. Your website was moved over — press “Publish” once to update it.');
  } catch (err) {
    console.error('Pebble: could not open the website', err);
    if (err && err.status === 401) return;
    setUi({
      blocked: err && (err.status === 403 || err.status === 404)
        ? 'Pebble can’t open this website with your hosting account. Please pick one from your list.'
        : "Sorry, we couldn't open your website. Please check your internet connection and try again.",
    });
  }
}

/* ========================================================================
   SAVE DRAFT & PUBLISH
   ======================================================================== */

function friendlyError(err, action) {
  console.error(`Pebble: ${action} failed`, err);
  if (err && err.status === 409) return 'Your website was changed somewhere else (maybe on another computer). Please reload the page, then try again — your changes on this computer are kept.';
  if (err && (err.status === 401 || err.status === 403)) return 'Pebble lost its connection to your hosting account. Please connect it again.';
  if (err instanceof TypeError) return "You seem to be offline. Your changes are kept on this computer — try again when you're connected.";
  return `Sorry, ${action} didn't work. Your changes are kept on this computer. Please try again in a moment.`;
}

function commitMessage(ch) {
  if (ch.remove) return `Remove ${ch.path}`;
  const meta = S.pageOf(store.site, ch.path) || S.postOf(store.site, ch.path);
  if (meta) return `${ch.remote ? 'Update' : 'Add'} ${S.postOf(store.site, ch.path) ? 'blog post' : 'page'} “${meta.title}”`;
  return { 'site.json': 'Update the website (site.json)', 'global.css': 'Update site design', 'theme.css': 'Update custom styles' }[ch.path] || `Update ${ch.path}`;
}

async function commitChangesToDraft() {
  flushNow();
  const changes = computePending();
  // site.json last: if anything fails halfway, the next save redoes the pages.
  changes.sort((a, b) => (a.path === 'site.json') - (b.path === 'site.json'));
  for (const ch of changes) {
    if (ch.remove) {
      await store.service.deleteFile(ch.path, { message: commitMessage(ch), sha: ch.remote.sha });
      store.remote.delete(ch.path);
    } else {
      const res = await store.service.commitFile(ch.path, ch.content, { message: commitMessage(ch), sha: ch.remote ? ch.remote.sha : undefined });
      store.remote.set(ch.path, { content: ch.content, sha: res.sha });
    }
  }
  if (changes.length) { store.hasDraftBranch = true; store.draftAhead = true; }
  store.pending = computePending();
  persistLocal();
  return changes;
}

export async function saveDraft() {
  if (store.ui.busy) return;
  flushNow();
  if (!store.pending.length) {
    toast(store.draftAhead ? 'Your draft is already saved. Press “Publish” when you’re ready.' : 'Nothing new to save — your website is up to date.');
    return;
  }
  setUi({ busy: 'save' });
  try {
    await commitChangesToDraft();
    toast('Draft saved. Only you can see it until you press “Publish”.');
  } catch (err) {
    toast(friendlyError(err, 'saving'));
  } finally {
    updateStatus();
    setUi({ busy: null });
  }
}

export async function publishLive() {
  if (store.ui.busy) return;
  setUi({ busy: 'publish' });
  const svc = store.service;
  try {
    await commitChangesToDraft();
    const diff = await svc.compareDraftToLive();
    if (!diff.ahead) { store.draftAhead = false; toast('Your website is already up to date.'); return; }
    try {
      await svc.publishDraft('Publish website');
    } catch (err) {
      if (err.status !== 409) throw err;
      setUi({ busy: null });
      if (!(await askToReplace())) { toast('Nothing was changed on your website. Your draft is still saved.'); return; }
      setUi({ busy: 'publish' });
      await svc.forcePublishDraft('Publish website');
      await refreshRemoteFiles();
    }
    store.draftAhead = false;
    diff.files.forEach((f) => { if (f.status === 'removed') store.livePaths.delete(f.path); else store.livePaths.add(f.path); });
    setUi({ dialog: 'published', dialogData: { files: diff.files } });
  } catch (err) {
    toast(friendlyError(err, 'publishing'));
  } finally {
    updateStatus();
    setUi({ busy: null });
  }
}

/** The "changed somewhere else" question. Resolves true for "Publish my version". */
function askToReplace() {
  return new Promise((resolve) => setUi({ dialog: 'conflict', dialogData: { resolve } }));
}

async function refreshRemoteFiles() {
  await Promise.all(Array.from(store.remote.keys()).map(async (path) => {
    try {
      const f = await store.service.fetchFile(path, readRef());
      store.remote.set(path, { content: f.content, sha: f.sha });
    } catch (err) {
      if (err.status === 404) store.remote.delete(path); else throw err;
    }
  }));
}

/* ========================================================================
   PHOTOS
   ======================================================================== */

/** A displayable URL for a photo path in the repository (cached by the service). */
export function resolveImageUrl(src) {
  if (!isRepoPath(src)) return Promise.resolve(src);
  return store.service.getImageUrl(src.replace(/^\.?\//, ''), readRef());
}

export function fetchImageLibrary() { return store.service.fetchImageLibrary(readRef()); }

function resizeImage(file, maxSide) {
  return new Promise((resolve, reject) => {
    if (!file || !/^image\/(jpeg|png|gif|webp|heic|heif|avif|bmp)$/i.test(file.type)) return reject(Object.assign(new Error('Not a photo'), { code: 'not-photo' }));
    if (file.type === 'image/gif' && file.size < 5e6) return resolve(file);
    const src = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(src);
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not convert photo'))), file.type === 'image/png' ? 'image/png' : 'image/jpeg', 0.85);
    };
    img.onerror = () => { URL.revokeObjectURL(src); reject(Object.assign(new Error('Could not read photo'), { code: 'unreadable' })); };
    img.src = src;
  });
}

export async function uploadPhoto(file) {
  const blob = await resizeImage(file, CONFIG.maxImageSide);
  const { path } = await store.service.uploadImage(blob, { name: file.name });
  store.hasDraftBranch = true;
  store.draftAhead = true;
  updateStatus();
  emit();
  return path;
}

export function reportPhotoError(err) {
  if (err && err.code === 'not-photo') toast('That file isn’t a photo. Please choose a JPG or PNG picture.');
  else if (err && err.code === 'unreadable') toast('Sorry, this photo can’t be opened here. Try saving it as a JPG first.');
  else toast(friendlyError(err, 'adding the photo'));
}

export function resetDemo() {
  store.service.resetDemo();
  try {
    Object.keys(localStorage).filter((k) => k.startsWith('pebble:') && k.includes(store.service.fullName)).forEach((k) => localStorage.removeItem(k));
  } catch { /* ignore */ }
  location.reload();
}

export { D };
