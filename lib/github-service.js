/* ==========================================================================
   GitHubService — the editor's only connection to the user's website.

   The user's repository holds nothing but the published website:

       index.html  about.html  …  site.css  assets/images/*.jpg

   It has two branches, which the UI never mentions by name:

       dev   "draft"  — Save draft writes here. Only the owner sees it.
       main  "live"   — GitHub Pages serves this. Publish live merges dev → main.

   Everything below talks to the real GitHub REST API (v2022-11-28) with
   fetch(). The app is assumed to hold a valid OAuth token (repo scope).

   Classes:
     GitHubClient       authenticated fetch (token read fresh on every call)
     GitHubAccount      the signed-in person and their websites (dashboard)
     GitHubService      one website: read, save draft, publish, photos (editor)

   For the "Try it out" demo, MockGitHubService / MockGitHubAccount swap
   ONLY the transport (_request) for a tiny in-browser fake of the same REST
   endpoints. Every other line — branches, base64, SHAs, merges — is the
   real code path, exercised by the demo.
   ========================================================================== */

(function () {
  'use strict';

  const API_BASE = 'https://api.github.com';
  const API_VERSION = '2022-11-28';
  const IMAGE_DIR = 'assets/images';
  const IMAGE_EXT_RE = /\.(jpe?g|png|gif|webp|avif|svg)$/i;
  const PAGE_NAME_RE = /^(?:blog\/)?[a-z0-9][a-z0-9-]{0,60}\.html$/;
  const SITE_FILE_RE = /^(?:(?:blog\/)?[a-z0-9][a-z0-9-]{0,60}\.html|site\.json|site-config\.json|global\.css|theme\.css|\.nojekyll)$/;

  /** An API failure with its HTTP status (404, 409, 422 …). */
  class GitHubError extends Error {
    constructor(status, message) {
      super(message || `GitHub error ${status}`);
      this.name = 'GitHubError';
      this.status = status;
    }
  }

  /**
   * GitHubClient — one authenticated request to the GitHub REST API.
   * Shared by GitHubAccount (who is she, which websites does she have) and
   * GitHubService (one website).
   */
  class GitHubClient {
    /**
     * @param {object} cfg
     * @param {string|function(): string} cfg.token  OAuth token, or a function returning
     *        the current one (Pebble passes () => PebbleAuth.getToken())
     * @param {function(GitHubError)} [cfg.onUnauthorized]  called on 401 (token revoked/expired)
     * @param {string} [cfg.apiBase]  for GitHub Enterprise
     */
    constructor({ token, onUnauthorized = null, apiBase = API_BASE } = {}) {
      this.token = token;
      this.onUnauthorized = onUnauthorized;
      this.apiBase = apiBase;
    }

    /* ======================================================================
       LOW LEVEL — one authenticated request
       ====================================================================== */

    /**
     * @param {string} method  GET | POST | PUT | PATCH | DELETE
     * @param {string} path    API path, e.g. "/repos/o/r/git/ref/heads/main"
     * @param {object} [opts]
     * @param {object} [opts.body]   JSON body
     * @param {object} [opts.query]  query-string params
     * @param {'json'|'text'|'blob'} [opts.as='json']  'text'/'blob' ask GitHub for raw file bytes
     * @returns {Promise<any>} parsed JSON, text, Blob, or null for 204 No Content
     */
    async _request(method, path, { body, query, as = 'json' } = {}) {
      const url = new URL(this.apiBase + path);
      for (const [k, v] of Object.entries(query || {})) if (v != null) url.searchParams.set(k, v);

      const res = await fetch(url, {
        method,
        cache: 'no-store', // never show her a stale copy right after saving
        headers: {
          Accept: as === 'json' ? 'application/vnd.github+json' : 'application/vnd.github.raw+json',
          Authorization: `Bearer ${typeof this.token === 'function' ? this.token() : this.token}`,
          'X-GitHub-Api-Version': API_VERSION,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });

      if (res.status === 204) return null;
      if (!res.ok) {
        let message = res.statusText;
        try { message = (await res.json()).message || message; } catch { /* not JSON */ }
        const err = new GitHubError(res.status, message);
        if (res.status === 401 && this.onUnauthorized) this.onUnauthorized(err);
        throw err;
      }
      if (as === 'blob') return res.blob();
      if (as === 'text') return res.text();
      return res.json();
    }

  }

  class GitHubService extends GitHubClient {
    /**
     * @param {object} cfg
     * @param {string} cfg.owner                GitHub account, e.g. "jane-gardens"
     * @param {string} cfg.repo                 repository, e.g. "my-garden-blog"
     * @param {string|function} cfg.token     OAuth token (or a function returning it)
     * @param {string} [cfg.liveBranch='main']  what GitHub Pages serves
     * @param {string} [cfg.draftBranch='dev']  where drafts are saved
     * @param {function} [cfg.onUnauthorized]   called on 401
     * @param {string} [cfg.apiBase]            for GitHub Enterprise
     */
    constructor({ owner, repo, token, liveBranch = 'main', draftBranch = 'dev', onUnauthorized = null, apiBase = API_BASE }) {
      super({ token, onUnauthorized, apiBase });
      this.owner = owner;
      this.repo = repo;
      this.liveBranch = liveBranch;
      this.draftBranch = draftBranch;
      this.imageDir = IMAGE_DIR;
      this.publishedUrl = null;       // real address from the Pages settings, if known

      this._repoInfo = null;          // cached GET /repos/{owner}/{repo}
      this._draftReady = false;       // dev branch known to exist
      this._writes = Promise.resolve(); // write queue (see _queue)
      this._imageUrls = new Map();    // "ref:path" → displayable URL
    }

    get fullName() { return `${this.owner}/${this.repo}`; }
    get isDemo() { return false; }

    /** Where GitHub Pages serves the live site (custom domain once known). */
    get siteUrl() {
      if (this.publishedUrl) return this.publishedUrl;
      return this.repo.toLowerCase() === `${this.owner.toLowerCase()}.github.io`
        ? `https://${this.repo}/`
        : `https://${this.owner}.github.io/${this.repo}/`;
    }

    _repoPath(suffix = '') {
      return `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}${suffix}`;
    }

    _contentsPath(path) {
      const clean = String(path || '').replace(/^\/+|\/+$/g, '');
      return this._repoPath('/contents' + (clean ? '/' + clean.split('/').map(encodeURIComponent).join('/') : ''));
    }

    /**
     * Writes to one branch must happen one after another: two commits racing
     * for the same branch make GitHub reject one of them. Every write goes
     * through this queue.
     */
    _queue(task) {
      const run = this._writes.then(task, task);
      this._writes = run.catch(() => {});
      return run;
    }

    /* ======================================================================
       REPOSITORY & BRANCHES
       ====================================================================== */

    /** GET /repos/{owner}/{repo} → { private, defaultBranch } (cached) */
    async getRepoInfo() {
      if (!this._repoInfo) {
        const r = await this._request('GET', this._repoPath());
        this._repoInfo = { private: !!r.private, defaultBranch: r.default_branch };
      }
      return this._repoInfo;
    }

    /**
     * How GitHub Pages publishes this website, or null if Pages is off.
     * GET /repos/{owner}/{repo}/pages
     * @returns {Promise<{url, branch, path, buildType}|null>}
     *   branch/path: which branch and folder Pages serves ("main", "/")
     */
    async getPublishingInfo() {
      try {
        const p = await this._request('GET', this._repoPath('/pages'));
        const url = p.html_url && p.https_enforced ? p.html_url.replace(/^http:/, 'https:') : p.html_url;
        return {
          url: url || null,
          branch: (p.source && p.source.branch) || null,
          path: (p.source && p.source.path) || '/',
          buildType: p.build_type || 'legacy',
        };
      } catch (err) {
        if (err.status === 404) return null;
        throw err;
      }
    }

    /**
     * Latest commit SHA of a branch, or null if the branch doesn't exist.
     * GET /repos/{owner}/{repo}/git/ref/heads/{branch}
     */
    async getBranchSha(branch) {
      try {
        const ref = await this._request('GET', this._repoPath(`/git/ref/heads/${encodeURIComponent(branch)}`));
        return ref.object.sha;
      } catch (err) {
        if (err.status === 404) return null;
        throw err;
      }
    }

    /** Does the draft branch exist yet? */
    async hasDraft() {
      const exists = !!(await this.getBranchSha(this.draftBranch));
      if (exists) this._draftReady = true;
      return exists;
    }

    /**
     * Make sure the draft branch exists; create it from live if it doesn't.
     * POST /repos/{owner}/{repo}/git/refs  { ref: "refs/heads/dev", sha: <main head> }
     */
    async ensureDraftBranch() {
      if (this._draftReady) return;
      if (!(await this.getBranchSha(this.draftBranch))) {
        const liveSha = await this.getBranchSha(this.liveBranch);
        if (!liveSha) throw new GitHubError(404, `Branch ${this.liveBranch} not found`);
        try {
          await this._request('POST', this._repoPath('/git/refs'), {
            body: { ref: `refs/heads/${this.draftBranch}`, sha: liveSha },
          });
        } catch (err) {
          if (err.status !== 422) throw err; // 422 = someone created it just now: fine
        }
      }
      this._draftReady = true;
    }

    /**
     * What's in the draft that isn't live yet?
     * GET /repos/{owner}/{repo}/compare/{live}...{draft}
     * @returns {Promise<{ahead: boolean, files: Array<{path: string, status: string}>}>}
     */
    async compareDraftToLive() {
      if (!(await this.hasDraft())) return { ahead: false, files: [] };
      const c = await this._request('GET', this._repoPath(
        `/compare/${encodeURIComponent(this.liveBranch)}...${encodeURIComponent(this.draftBranch)}`));
      return {
        ahead: c.ahead_by > 0 && (c.files || []).length > 0,
        files: (c.files || []).map((f) => ({ path: f.filename, status: f.status })),
      };
    }

    /* ======================================================================
       READING
       ====================================================================== */

    /**
     * Items in a folder on a branch ([] if the folder doesn't exist).
     * GET /repos/{owner}/{repo}/contents/{path}?ref={branch}
     */
    async listDirectory(path, ref) {
      try {
        const items = await this._request('GET', this._contentsPath(path), { query: { ref } });
        return Array.isArray(items) ? items : [];
      } catch (err) {
        if (err.status === 404) return [];
        throw err;
      }
    }

    /** Files in the site's root folder. */
    async fetchSiteFiles(ref = this.liveBranch) {
      const items = await this.listDirectory('', ref);
      return items
        .filter((i) => i.type === 'file')
        .map((i) => ({ name: i.name, path: i.path, sha: i.sha, size: i.size, type: 'file' }));
    }

    /**
     * Read a text file as a string, plus its SHA (needed to update it later).
     * GET /repos/{owner}/{repo}/contents/{path}?ref={branch}
     * Files over 1 MB come back without inline content; then the raw bytes
     * are fetched with the "raw" media type instead.
     */
    async fetchFile(path, ref = this.liveBranch) {
      const data = await this._request('GET', this._contentsPath(path), { query: { ref } });
      if (Array.isArray(data) || data.type !== 'file') throw new GitHubError(422, `${path} is not a file`);
      const content = data.encoding === 'base64' && data.content
        ? GitHubService.fromBase64(data.content)
        : await this._request('GET', this._contentsPath(path), { query: { ref }, as: 'text' });
      return { path: data.path, sha: data.sha, content };
    }

    /** Read one page (same as fetchFile, but only accepts page names). */
    async fetchPage(filename, ref = this.liveBranch) {
      GitHubService.assertPageName(filename);
      return this.fetchFile(filename, ref);
    }

    /**
     * All photos in /assets/images/, newest uploads first.
     * GET /repos/{owner}/{repo}/contents/assets/images?ref={branch}
     * @returns {Promise<Array<{name, path, sha, size}>>}
     */
    async fetchImageLibrary(ref = this.draftBranch) {
      const items = await this.listDirectory(this.imageDir, ref);
      const isStamped = (n) => /^\d{8}-\d{6}-/.test(n); // our upload names start with a timestamp
      return items
        .filter((i) => i.type === 'file' && IMAGE_EXT_RE.test(i.name))
        .map((i) => ({ name: i.name, path: i.path, sha: i.sha, size: i.size }))
        .sort((a, b) => (isStamped(b.name) - isStamped(a.name)) || (isStamped(a.name) ? b.name.localeCompare(a.name) : a.name.localeCompare(b.name)));
    }

    /**
     * A URL the editor can show for a repo image (e.g. "assets/images/x.jpg").
     *  - public repo  → raw.githubusercontent.com URL for that branch
     *  - private repo → authenticated raw download, turned into a blob: URL
     * Cached, so the library grid and the canvas share downloads.
     */
    async getImageUrl(path, ref = this.draftBranch) {
      const key = `${ref}:${path}`;
      if (this._imageUrls.has(key)) return this._imageUrls.get(key);
      const info = await this.getRepoInfo();
      let url;
      if (!info.private) {
        url = `https://raw.githubusercontent.com/${this.owner}/${this.repo}/${encodeURIComponent(ref)}/${path.split('/').map(encodeURIComponent).join('/')}`;
      } else {
        const blob = await this._request('GET', this._contentsPath(path), { query: { ref }, as: 'blob' });
        url = URL.createObjectURL(blob);
      }
      this._imageUrls.set(key, url);
      return url;
    }

    /* ======================================================================
       WRITING — always to the draft branch, one write at a time
       ====================================================================== */

    /**
     * Create or update one file on the draft branch (creating the branch
     * from live first if needed).
     * PUT /repos/{owner}/{repo}/contents/{path}
     *     { message, content: <base64>, branch: "dev", sha? }
     * `sha` is required when the file exists; GitHub answers 409 if it is no
     * longer the latest (the file was changed somewhere else).
     *
     * @param {string} path
     * @param {string} base64Content
     * @param {object} opts  { message, sha }
     * @returns {Promise<{path, sha, commitSha}>}
     */
    putFile(path, base64Content, { message, sha } = {}) {
      return this._queue(async () => {
        await this.ensureDraftBranch();
        const res = await this._request('PUT', this._contentsPath(path), {
          body: {
            message: message || `Update ${path}`,
            content: base64Content,
            branch: this.draftBranch,
            ...(sha ? { sha } : {}),
          },
        });
        return { path: res.content.path, sha: res.content.sha, commitSha: res.commit.sha };
      });
    }

    /**
     * Delete one website file on the draft branch (e.g. a file an older
     * Pebble wrote that the current format no longer uses).
     * DELETE /repos/{owner}/{repo}/contents/{path}  { message, sha, branch: "dev" }
     */
    deleteFile(path, { message, sha } = {}) {
      GitHubService.assertSiteFile(path);
      return this._queue(async () => {
        await this.ensureDraftBranch();
        const res = await this._request('DELETE', this._contentsPath(path), {
          body: { message: message || `Remove ${path}`, sha, branch: this.draftBranch },
        });
        return { path, commitSha: res && res.commit ? res.commit.sha : undefined };
      });
    }

    /**
     * Save one website file to the draft (pages, blog posts, site.json,
     * global.css, theme.css — nothing else).
     */
    commitFile(path, text, { message, sha } = {}) {
      GitHubService.assertSiteFile(path);
      return this.putFile(path, GitHubService.toBase64(text), { message: message || `Update ${path}`, sha });
    }

    /** Save one page to the draft. */
    commitPage(filename, htmlContent, { message, sha } = {}) {
      GitHubService.assertPageName(filename);
      return this.putFile(filename, GitHubService.toBase64(htmlContent), { message: message || `Update ${filename}`, sha });
    }

    /**
     * Upload a photo to /assets/images/ on the draft branch.
     * The name gets a timestamp so uploads never overwrite each other.
     *
     * @param {Blob} blob            image data (already resized by the editor)
     * @param {object} [opts]
     * @param {string} [opts.name]   original file name, used for a readable slug
     * @returns {Promise<{path: string, sha: string}>}  path is relative to the site root
     */
    async uploadImage(blob, { name = 'photo' } = {}) {
      const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' }[blob.type];
      if (!ext) throw new GitHubError(415, `Unsupported image type ${blob.type}`);
      const slug = String(name).replace(/\.[^.]+$/, '')
        .normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'photo';
      const path = `${this.imageDir}/${timestamp()}-${slug}.${ext}`;

      const base64 = await GitHubService.blobToBase64(blob);
      const result = await this.putFile(path, base64, { message: `Add photo ${path.split('/').pop()}` });

      // Show it straight away, before GitHub's CDN has it.
      this._imageUrls.set(`${this.draftBranch}:${result.path}`, URL.createObjectURL(blob));
      return { path: result.path, sha: result.sha };
    }

    /* ======================================================================
       PUBLISHING
       ====================================================================== */

    /**
     * Make the draft live: merge dev → main.
     * POST /repos/{owner}/{repo}/merges  { base: "main", head: "dev", commit_message }
     *   201 → merged (GitHub Pages rebuilds),  204 → nothing to merge,
     *   409 → conflict (main changed in a way that clashes with the draft).
     *
     * Afterwards the draft branch is fast-forwarded to the new live commit
     *   PATCH /repos/{owner}/{repo}/git/refs/heads/dev  { sha, force: false }
     * so draft and live are identical again and the next compare is clean.
     *
     * @returns {Promise<{published: boolean, commitSha?: string}>}
     */
    publishDraft(message = 'Publish website') {
      return this._queue(async () => {
        if (!(await this.getBranchSha(this.draftBranch))) return { published: false };
        const merge = await this._request('POST', this._repoPath('/merges'), {
          body: { base: this.liveBranch, head: this.draftBranch, commit_message: message },
        });
        const liveSha = await this.getBranchSha(this.liveBranch);
        try {
          await this._request('PATCH', this._repoPath(`/git/refs/heads/${encodeURIComponent(this.draftBranch)}`), {
            body: { sha: liveSha, force: false },
          });
        } catch (err) {
          console.warn('GitHubService: draft not fast-forwarded (harmless)', err);
        }
        return { published: !!merge, commitSha: merge ? merge.sha : undefined };
      });
    }

    /**
     * Publish when a normal merge is refused with 409 because the live site
     * was edited elsewhere in a way that clashes with the draft. "What she
     * sees wins": every file the draft changed is written onto live as-is
     * (other changes made on live are kept), then the draft branch is reset
     * to the new live commit.
     *
     *   for each file in compare(live...dev):
     *     PUT /repos/{owner}/{repo}/contents/{path}  { branch: "main", content, sha: <live sha> }
     *   PATCH /repos/{owner}/{repo}/git/refs/heads/dev  { sha: <live head>, force: true }
     *
     * Only call this after the user agreed to replace the other changes.
     */
    forcePublishDraft(message = 'Publish website') {
      return this._queue(async () => {
        const diff = await this.compareDraftToLive();
        for (const f of diff.files) {
          if (f.status === 'removed') {
            // Removed in the draft (an old file): remove it on live too.
            try {
              const live = await this._request('GET', this._contentsPath(f.path), { query: { ref: this.liveBranch } });
              await this._request('DELETE', this._contentsPath(f.path), { body: { message: `${message} (remove ${f.path})`, sha: live.sha, branch: this.liveBranch } });
            } catch (err) {
              if (err.status !== 404) throw err;
            }
            continue;
          }
          const draftFile = await this._request('GET', this._contentsPath(f.path), { query: { ref: this.draftBranch } });
          const content = draftFile.encoding === 'base64' && draftFile.content
            ? draftFile.content.replace(/\s/g, '')
            : await GitHubService.blobToBase64(await this._request('GET', this._contentsPath(f.path), { query: { ref: this.draftBranch }, as: 'blob' }));

          let liveSha = null;
          try {
            liveSha = (await this._request('GET', this._contentsPath(f.path), { query: { ref: this.liveBranch } })).sha;
          } catch (err) {
            if (err.status !== 404) throw err;
          }
          if (liveSha === draftFile.sha) continue;

          await this._request('PUT', this._contentsPath(f.path), {
            body: { message: `${message} (${f.path})`, content, branch: this.liveBranch, ...(liveSha ? { sha: liveSha } : {}) },
          });
        }
        const liveSha = await this.getBranchSha(this.liveBranch);
        await this._request('PATCH', this._repoPath(`/git/refs/heads/${encodeURIComponent(this.draftBranch)}`), {
          body: { sha: liveSha, force: true }, // safe: every draft change is on live now
        });
        return { published: true, commitSha: liveSha };
      });
    }

    /* ======================================================================
       HELPERS
       ====================================================================== */

    static assertPageName(name) {
      if (!PAGE_NAME_RE.test(name)) throw new GitHubError(422, `Not a valid page name: ${name}`);
    }

    /** The only files Pebble writes as text. */
    static assertSiteFile(path) {
      if (!SITE_FILE_RE.test(path)) throw new GitHubError(422, `Pebble does not write ${path}`);
    }

    /** UTF-8 text → base64 (what the contents API expects). */
    static toBase64(text) {
      return bytesToBase64(new TextEncoder().encode(text));
    }

    /** base64 (possibly with line breaks, as GitHub returns it) → UTF-8 text. */
    static fromBase64(b64) {
      return new TextDecoder().decode(base64ToBytes(b64));
    }

    /** Blob/File → base64 without the "data:…;base64," prefix. */
    static blobToBase64(blob) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      });
    }
  }

  /* ==========================================================================
     GitHubAccount — the signed-in person and their websites.
     ========================================================================== */

  class GitHubAccount extends GitHubClient {
    get isDemo() { return false; }

    /** GET /user → { login, name, avatarUrl } */
    async getUser() {
      const u = await this._request('GET', '/user');
      return { login: u.login, name: u.name || u.login, avatarUrl: u.avatar_url };
    }

    /**
     * Every repository she can change (her own, her organisations', and ones
     * she was invited to), most recently updated first.
     * GET /user/repos?affiliation=owner,collaborator,organization_member&sort=pushed
     * (100 per page; stops after 10 pages = 1000 repositories)
     */
    async listRepos() {
      const all = [];
      for (let page = 1; page <= 10; page++) {
        const batch = await this._request('GET', '/user/repos', {
          query: { per_page: 100, page, sort: 'pushed', affiliation: 'owner,collaborator,organization_member' },
        });
        all.push(...batch);
        if (batch.length < 100) break;
      }
      return all.filter((r) => r.permissions && r.permissions.push && !r.archived && !r.disabled);
    }

    /**
     * Her websites: repositories that GitHub Pages publishes.
     * For each, find out where it's published and whether Pebble made it (its
     * homepage carries the data-pebble-grid marker). Pebble only opens sites
     * it made, so it can never overwrite a website built some other way.
     *
     * @returns {Promise<Array<{
     *   owner, repo, fullName, title, url, updatedAt, liveBranch,
     *   status: 'ready' | 'not-pebble' | 'unsupported', private }>>}
     */
    async listWebsites() {
      const repos = (await this.listRepos()).filter((r) => r.has_pages);
      const sites = await Promise.all(repos.map((r) => this._describeWebsite(r)));
      const order = { ready: 0, 'not-pebble': 1, unsupported: 2 };
      return sites.sort((a, b) => (order[a.status] - order[b.status]) || String(b.updatedAt).localeCompare(String(a.updatedAt)));
    }

    /**
     * Create a brand-new public website and switch on GitHub Pages:
     *   1. POST /user/repos  { name, auto_init: true }      → repository with a main branch
     *   2. PUT  /repos/{o}/{r}/contents/{path}              → starter files (one commit each)
     *   3. POST /repos/{o}/{r}/pages  { source: { branch, path: "/" } }
     * The first Pages build takes a minute or two before the address works.
     *
     * @param {object} opts
     * @param {string} opts.name   repository name, e.g. "my-garden-diary"
     * @param {string} opts.title  the website's name, e.g. "My Garden Diary"
     * @param {Object<string,string>} opts.files  path → text content (index.html first)
     * @param {function(string)} [opts.onStep]  progress callback: 'repo' | 'files' | 'pages'
     * @returns {Promise<object>} a website entry like listWebsites() returns
     * @throws {GitHubError} 422 with .code = 'name-taken' if the name is in use
     */
    async createWebsite({ name, title, files, onStep = () => {} }) {
      onStep('repo');
      let repo;
      try {
        repo = await this._request('POST', '/user/repos', {
          body: {
            name,
            description: `${title} — made with Pebble`,
            private: false,       // free GitHub Pages needs a public repository
            auto_init: true,      // gives us a main branch to work on
            has_issues: false,
            has_projects: false,
            has_wiki: false,
          },
        });
      } catch (err) {
        if (err.status === 422 && /already exists/i.test(err.message)) err.code = 'name-taken';
        throw err;
      }

      const branch = repo.default_branch || 'main';
      const site = new GitHubService({ owner: repo.owner.login, repo: repo.name, token: this.token, apiBase: this.apiBase, liveBranch: branch });

      // The first commit from auto_init can take a moment to appear.
      for (let i = 0; i < 15 && !(await site.getBranchSha(branch)); i++) await sleep(800);

      onStep('files');
      for (const [path, text] of Object.entries(files)) {
        await site._request('PUT', site._contentsPath(path), {
          body: {
            message: path === 'index.html' ? `Create “${title}” with Pebble` : `Add ${path}`,
            content: GitHubService.toBase64(text),
            branch,
          },
        });
      }

      onStep('pages');
      try {
        await site._request('POST', site._repoPath('/pages'), { body: { source: { branch, path: '/' } } });
      } catch (err) {
        if (err.status !== 409) throw err; // 409: Pages is already on
      }
      const pages = await site.getPublishingInfo().catch(() => null);

      return {
        owner: repo.owner.login,
        repo: repo.name,
        fullName: repo.full_name,
        title,
        url: (pages && pages.url) || site.siteUrl,
        updatedAt: new Date().toISOString(),
        liveBranch: branch,
        private: false,
        status: 'ready',
      };
    }

    async _describeWebsite(r) {
      const site = new GitHubService({ owner: r.owner.login, repo: r.name, token: this.token, apiBase: this.apiBase });
      const pages = await site.getPublishingInfo().catch(() => null);
      const liveBranch = (pages && pages.branch) || r.default_branch;
      const info = {
        owner: r.owner.login,
        repo: r.name,
        fullName: r.full_name,
        title: prettyRepoName(r.name),
        url: (pages && pages.url) || site.siteUrl,
        updatedAt: r.pushed_at,
        liveBranch,
        private: !!r.private,
        status: 'not-pebble',
      };
      // Pebble keeps pages in the root folder of the published branch.
      if (pages && pages.path && pages.path !== '/') { info.status = 'unsupported'; return info; }

      for (const ref of [site.draftBranch, liveBranch]) {
        try {
          const html = await site._request('GET', site._contentsPath('index.html'), { query: { ref }, as: 'text' });
          if (isPebbleHtml(html)) {
            info.status = 'ready';
            info.title = siteNameFromHtml(html) || info.title;
          }
          break; // found an index.html on this branch: decided
        } catch (err) {
          if (err.status !== 404) break; // e.g. no draft branch → try live
        }
      }
      return info;
    }
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /** A page made by Pebble: v5 (generator tag) or v2–v4 (data-pebble-grid). */
  const isPebbleHtml = (html) => /<meta name="generator" content="Pebble">|\bdata-pebble-grid\b/.test(String(html || ''));

  /** The website's name, read from a page: the name in the header, else the <title> ("Home – My Garden Diary"). */
  function siteNameFromHtml(html) {
    const m = html.match(/<span class="site-title__name">([^<]*)<\/span>/) || html.match(/<a class="site-(?:name|title)"[^>]*>([^<]*)<\/a>/);
    if (m && m[1].trim()) return decodeEntities(m[1].trim());
    const t = html.match(/<title>[^<]*? – ([^<]*)<\/title>/);
    return t ? decodeEntities(t[1].trim()) : '';
  }

  /** "my-hobby-blog" → "My Hobby Blog";  "jane.github.io" → "Jane" */
  function prettyRepoName(name) {
    const base = String(name).replace(/\.github\.io$/i, '').replace(/[-_.]+/g, ' ').trim();
    return base.replace(/\b\w/g, (c) => c.toUpperCase()) || name;
  }

  function decodeEntities(text) {
    const el = document.createElement('textarea');
    el.innerHTML = text;
    return el.value;
  }

  function bytesToBase64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
  }

  function base64ToBytes(b64) {
    const binary = atob(String(b64).replace(/\s/g, ''));
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  }

  /** "20261109-153012" (local time) */
  function timestamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  }

  /** The SHA git would give this content: sha1("blob <size>\0" + bytes). */
  async function gitBlobSha(content) {
    const body = typeof content === 'string' ? new TextEncoder().encode(content) : content;
    const header = new TextEncoder().encode(`blob ${body.length}\0`);
    const data = new Uint8Array(header.length + body.length);
    data.set(header);
    data.set(body, header.length);
    const hash = await crypto.subtle.digest('SHA-1', data);
    return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  /* ==========================================================================
     MockGitHubService — demo mode, no GitHub account needed.

     Inherits ALL of GitHubService and replaces only _request() with a small
     fake of the GitHub REST endpoints it uses:

       GET   /repos/{o}/{r}
       GET   /repos/{o}/{r}/git/ref/heads/{branch}
       POST  /repos/{o}/{r}/git/refs
       PATCH /repos/{o}/{r}/git/refs/heads/{branch}
       GET   /repos/{o}/{r}/contents/{path}?ref=     (JSON, or raw bytes)
       PUT   /repos/{o}/{r}/contents/{path}
       DELETE /repos/{o}/{r}/contents/{path}
       POST  /repos/{o}/{r}/merges
       GET   /repos/{o}/{r}/compare/{base}...{head}

     The fake keeps real git-like data (blobs with git SHAs, commits with
     parents, branch refs, three-way merges) in localStorage, seeded from
     ../example-site/. Status codes match GitHub's (404, 409, 422, 204).
     ========================================================================== */

  // <root>/lib/github-service.js → <root>/example-site/ (works from any page)
  const SEED_BASE_URL = new URL('../example-site/', document.currentScript.src).href;
  const SEED_FILES = [
    'site.json', 'global.css',
    'index.html', 'about.html', 'blog.html', 'contact.html',
    'blog/starting-from-seed.html', 'blog/roses-in-november.html',
    'assets/images/garden-sunset.svg', 'assets/images/tomatoes.svg', 'assets/images/roses.svg',
  ];
  const MIME = { html: 'text/html', css: 'text/css', svg: 'image/svg+xml', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };

  class MockGitHubService extends GitHubService {
    constructor({ owner = 'demo-user', repo = 'my-garden-blog', latency = 220, ...rest } = {}) {
      super({ owner, repo, token: 'demo', ...rest });
      this.latency = latency;
      this._storageKey = `pebble:mock-github:v5:${owner}/${repo}`; // bump when the example website changes
      this._db = null; // { blobs: {sha: base64}, commits: {sha: {tree, parents, message, date}}, refs: {branch: sha} }
    }

    get isDemo() { return true; }

    /** Throw away the fake repository; it re-seeds on next use. */
    resetDemo() {
      this._db = null;
      try { localStorage.removeItem(this._storageKey); } catch { /* ignore */ }
    }

    /* ---------------- the fake API server ---------------- */

    async _request(method, path, { body, query = {}, as = 'json' } = {}) {
      const db = await this._open();
      await new Promise((r) => setTimeout(r, this.latency * (0.6 + Math.random() * 0.8)));

      const prefix = this._repoPath();
      if (!path.startsWith(prefix)) throw new GitHubError(404, 'Not Found');
      const route = path.slice(prefix.length);
      let m;

      // GET /repos/{o}/{r}
      if (route === '' && method === 'GET') {
        // Reported as private so images take the authenticated-download path.
        return { full_name: this.fullName, private: true, default_branch: this.liveBranch };
      }

      // GET /repos/{o}/{r}/pages
      if (route === '/pages' && method === 'GET') {
        return { html_url: `https://${this.owner}.github.io/${this.repo}/`, build_type: 'legacy', source: { branch: this.liveBranch, path: '/' } };
      }

      // GET /git/ref/heads/{branch}
      if ((m = route.match(/^\/git\/ref\/heads\/(.+)$/)) && method === 'GET') {
        const branch = decodeURIComponent(m[1]);
        if (!db.refs[branch]) throw new GitHubError(404, 'Not Found');
        return { ref: `refs/heads/${branch}`, object: { sha: db.refs[branch], type: 'commit' } };
      }

      // POST /git/refs
      if (route === '/git/refs' && method === 'POST') {
        const branch = String(body.ref).replace(/^refs\/heads\//, '');
        if (db.refs[branch]) throw new GitHubError(422, 'Reference already exists');
        if (!db.commits[body.sha]) throw new GitHubError(422, 'Object does not exist');
        db.refs[branch] = body.sha;
        this._save();
        return { ref: body.ref, object: { sha: body.sha, type: 'commit' } };
      }

      // PATCH /git/refs/heads/{branch}
      if ((m = route.match(/^\/git\/refs\/heads\/(.+)$/)) && method === 'PATCH') {
        const branch = decodeURIComponent(m[1]);
        if (!db.refs[branch]) throw new GitHubError(422, 'Reference does not exist');
        if (!body.force && !this._isAncestor(db.refs[branch], body.sha)) throw new GitHubError(422, 'Update is not a fast forward');
        db.refs[branch] = body.sha;
        this._save();
        return { ref: `refs/heads/${branch}`, object: { sha: body.sha, type: 'commit' } };
      }

      // GET/PUT /contents/{path}
      if ((m = route.match(/^\/contents(?:\/(.*))?$/))) {
        const filePath = (m[1] || '').split('/').map(decodeURIComponent).join('/');
        if (method === 'GET') return this._getContents(filePath, query.ref || this.liveBranch, as);
        if (method === 'PUT') return this._putContents(filePath, body);
        if (method === 'DELETE') return this._deleteContents(filePath, body);
      }

      // POST /merges
      if (route === '/merges' && method === 'POST') return this._merge(body.base, body.head, body.commit_message);

      // GET /compare/{base}...{head}
      if ((m = route.match(/^\/compare\/(.+)\.\.\.(.+)$/)) && method === 'GET') {
        return this._compare(decodeURIComponent(m[1]), decodeURIComponent(m[2]));
      }

      throw new GitHubError(404, `Mock: ${method} ${route} not implemented`);
    }

    _getContents(filePath, ref, as) {
      const db = this._db;
      const commit = db.commits[db.refs[ref]];
      if (!commit) throw new GitHubError(404, `No commit found for the ref ${ref}`);
      const tree = commit.tree;

      if (filePath && tree[filePath]) {
        const sha = tree[filePath];
        const b64 = db.blobs[sha];
        if (as !== 'json') {
          const bytes = base64ToBytes(b64);
          return as === 'text' ? new TextDecoder().decode(bytes) : new Blob([bytes], { type: MIME[filePath.split('.').pop()] || 'application/octet-stream' });
        }
        return {
          type: 'file', encoding: 'base64', name: filePath.split('/').pop(), path: filePath, sha,
          size: Math.floor(b64.length * 3 / 4),
          content: b64.replace(/.{1,60}/g, '$&\n'), // GitHub wraps base64 at 60 chars
        };
      }

      // A folder: list its direct children.
      const dir = filePath ? filePath + '/' : '';
      const seen = new Map();
      for (const p of Object.keys(tree)) {
        if (!p.startsWith(dir)) continue;
        const rest = p.slice(dir.length);
        const name = rest.split('/')[0];
        if (seen.has(name)) continue;
        seen.set(name, rest.includes('/')
          ? { type: 'dir', name, path: dir + name, sha: '', size: 0 }
          : { type: 'file', name, path: p, sha: tree[p], size: Math.floor(db.blobs[tree[p]].length * 3 / 4) });
      }
      if (!seen.size) throw new GitHubError(404, 'Not Found');
      return Array.from(seen.values()).sort((a, b) => a.name.localeCompare(b.name));
    }

    async _putContents(filePath, body) {
      const db = this._db;
      const branch = body.branch || this.liveBranch;
      const headSha = db.refs[branch];
      if (!headSha) throw new GitHubError(404, `Branch ${branch} not found`);
      const tree = { ...db.commits[headSha].tree };
      const existing = tree[filePath];
      if (existing && !body.sha) throw new GitHubError(422, 'Invalid request. "sha" wasn\'t supplied.');
      if (existing && body.sha !== existing) throw new GitHubError(409, `${filePath} does not match ${body.sha}`);

      const b64 = String(body.content).replace(/\s/g, '');
      const blobSha = await gitBlobSha(base64ToBytes(b64));
      db.blobs[blobSha] = b64;
      tree[filePath] = blobSha;
      const commitSha = await this._commit(tree, [headSha], body.message);
      db.refs[branch] = commitSha;
      this._save();
      return { content: { path: filePath, sha: blobSha }, commit: { sha: commitSha, message: body.message } };
    }

    async _deleteContents(filePath, body) {
      const db = this._db;
      const branch = body.branch || this.liveBranch;
      const headSha = db.refs[branch];
      if (!headSha) throw new GitHubError(404, `Branch ${branch} not found`);
      const tree = { ...db.commits[headSha].tree };
      if (!tree[filePath]) throw new GitHubError(404, 'Not Found');
      if (body.sha !== tree[filePath]) throw new GitHubError(409, `${filePath} does not match ${body.sha}`);
      delete tree[filePath];
      const commitSha = await this._commit(tree, [headSha], body.message);
      db.refs[branch] = commitSha;
      this._save();
      return { content: null, commit: { sha: commitSha, message: body.message } };
    }

    async _merge(base, head, message) {
      const db = this._db;
      const baseSha = db.refs[base], headSha = db.refs[head];
      if (!baseSha || !headSha) throw new GitHubError(404, 'Base or head does not exist');
      if (this._isAncestor(headSha, baseSha)) return null; // 204: already merged

      const mb = this._mergeBase(baseSha, headSha);
      const B = db.commits[baseSha].tree, H = db.commits[headSha].tree, M = mb ? db.commits[mb].tree : {};
      const out = {};
      for (const p of new Set([...Object.keys(B), ...Object.keys(H), ...Object.keys(M)])) {
        const b = B[p], h = H[p], o = M[p];
        let v;
        if (b === h) v = b;
        else if (b === o) v = h;
        else if (h === o) v = b;
        else throw new GitHubError(409, `Merge conflict in ${p}`);
        if (v) out[p] = v;
      }
      const sha = await this._commit(out, [baseSha, headSha], message || `Merge ${head} into ${base}`);
      db.refs[base] = sha;
      this._save();
      return { sha, commit: { message } };
    }

    _compare(base, head) {
      const db = this._db;
      const baseSha = db.refs[base], headSha = db.refs[head];
      if (!baseSha || !headSha) throw new GitHubError(404, 'Not Found');
      const a = this._ancestors(baseSha), b = this._ancestors(headSha);
      const ahead = [...b].filter((s) => !a.has(s)).length;
      const behind = [...a].filter((s) => !b.has(s)).length;
      const mb = this._mergeBase(baseSha, headSha);
      const from = mb ? db.commits[mb].tree : {}, to = db.commits[headSha].tree;
      const files = [];
      for (const p of new Set([...Object.keys(from), ...Object.keys(to)])) {
        if (from[p] === to[p]) continue;
        files.push({ filename: p, status: !from[p] ? 'added' : !to[p] ? 'removed' : 'modified' });
      }
      return {
        status: ahead && behind ? 'diverged' : ahead ? 'ahead' : behind ? 'behind' : 'identical',
        ahead_by: ahead, behind_by: behind, files,
      };
    }

    /* ---------------- git-ish helpers ---------------- */

    async _commit(tree, parents, message) {
      const sha = await gitBlobSha(JSON.stringify({ tree, parents, message, t: Date.now(), r: Math.random() }));
      this._db.commits[sha] = { tree, parents, message, date: new Date().toISOString() };
      return sha;
    }

    _ancestors(sha) {
      const seen = new Set();
      const stack = [sha];
      while (stack.length) {
        const s = stack.pop();
        if (!s || seen.has(s)) continue;
        seen.add(s);
        stack.push(...(this._db.commits[s] ? this._db.commits[s].parents : []));
      }
      return seen;
    }

    /** Is `a` reachable from `b` (or equal)? */
    _isAncestor(a, b) { return this._ancestors(b).has(a); }

    _mergeBase(a, b) {
      const ofA = this._ancestors(a);
      const queue = [b];
      const seen = new Set();
      while (queue.length) {
        const s = queue.shift();
        if (!s || seen.has(s)) continue;
        if (ofA.has(s)) return s;
        seen.add(s);
        queue.push(...this._db.commits[s].parents);
      }
      return null;
    }

    /** Commit messages of a branch, newest first (debugging only). */
    async listCommits(branch = this.liveBranch) {
      const db = await this._open();
      const out = [];
      const seen = new Set();
      const queue = [db.refs[branch]];
      while (queue.length) {
        const s = queue.shift();
        if (!s || seen.has(s)) continue;
        seen.add(s);
        out.push(db.commits[s].message);
        queue.push(...db.commits[s].parents);
      }
      return out;
    }

    /* ---------------- storage ---------------- */

    async _open() {
      if (this._db) return this._db;
      try {
        const saved = JSON.parse(localStorage.getItem(this._storageKey) || 'null');
        if (saved && saved.refs) return (this._db = saved);
      } catch { /* re-seed */ }

      // First visit: the example website becomes the live branch.
      const db = { blobs: {}, commits: {}, refs: {} };
      const tree = {};
      for (const path of SEED_FILES) {
        try {
          const res = await fetch(SEED_BASE_URL + path, { cache: 'no-store' });
          if (!res.ok) continue;
          const bytes = new Uint8Array(await res.arrayBuffer());
          const sha = await gitBlobSha(bytes);
          db.blobs[sha] = bytesToBase64(bytes);
          tree[path] = sha;
        } catch { /* offline / file:// */ }
      }
      this._db = db;
      db.refs[this.liveBranch] = await this._commit(tree, [], 'Initial website');
      this._save();
      return db;
    }

    _save() {
      try {
        localStorage.setItem(this._storageKey, JSON.stringify(this._db));
      } catch (err) {
        console.warn('MockGitHubService: demo repository kept in memory only (storage full)', err);
      }
    }
  }

  /** Demo account: one practice website, stored in this browser. */
  class MockGitHubAccount extends GitHubAccount {
    constructor() { super({ token: 'demo' }); }
    get isDemo() { return true; }
    async getUser() { return { login: 'demo-user', name: 'Guest', avatarUrl: null }; }
    async listWebsites() {
      const site = new MockGitHubService({ owner: 'demo-user', repo: 'my-garden-blog', latency: 0 });
      let title = 'My Garden Diary';
      try {
        const ref = (await site.hasDraft()) ? site.draftBranch : site.liveBranch;
        const html = (await site.fetchPage('index.html', ref)).content;
        title = siteNameFromHtml(html) || title;
      } catch { /* not seeded yet */ }
      return [{
        owner: 'demo-user', repo: 'my-garden-blog', fullName: 'demo-user/my-garden-blog', title,
        url: null, updatedAt: null, liveBranch: 'main', private: false, status: 'ready', demo: true,
      }];
    }
  }

  window.GitHubClient = GitHubClient;
  window.GitHubService = GitHubService;
  window.GitHubAccount = GitHubAccount;
  window.MockGitHubService = MockGitHubService;
  window.MockGitHubAccount = MockGitHubAccount;
  window.GitHubError = GitHubError;
})();
