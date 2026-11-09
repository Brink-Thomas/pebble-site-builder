/* ==========================================================================
   GitHubService — the editor's only connection to the user's website.

   The Pebble editor is a central web app. The user's own repository holds
   nothing but the published files (index.html, about.html, …, site.css).
   This class is the single place that talks to that repository:

       fetchSiteFiles()                      → what files are in the site?
       fetchPage(filename) / fetchFile(path) → read one file
       commitPage(filename, html, {sha})     → save one file as a commit

   ─── PROTOTYPE: THIS IS A MOCK ──────────────────────────────────────────
   No network calls are made to GitHub. A fake repository lives in this
   browser's localStorage, seeded on first use from ../example-site/.
   Each method documents the exact GitHub REST call it stands in for, and
   returns data shaped the same way, so the real version can be swapped in
   without touching the editor.

   The mock does reproduce the parts of GitHub's behaviour the editor relies
   on:
     • every file has a git blob SHA, computed the way git does it;
     • updating a file requires the SHA you last read, otherwise you get a
       409 Conflict (this is how GitHub stops two tabs overwriting each other);
     • a small network delay, so loading states get exercised.
   ========================================================================== */

(function () {
  'use strict';

  /** Files copied into the fake repository the first time it is opened. */
  const SEED_BASE_URL = '../example-site/';
  const SEED_FILES = ['index.html', 'about.html', 'contact.html', 'site.css'];

  /** Pages must be simple, safe file names in the repo root. */
  const PAGE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,60}\.html$/;

  /** An error carrying an HTTP-like status, like a GitHub API failure. */
  class GitHubError extends Error {
    constructor(status, message) {
      super(message);
      this.name = 'GitHubError';
      this.status = status;
    }
  }

  class GitHubService {
    /**
     * @param {object}  cfg
     * @param {string}  cfg.owner          GitHub account, e.g. "jane-gardens"
     * @param {string}  cfg.repo           repository, e.g. "my-garden-blog"
     * @param {string}  [cfg.branch=main]  branch GitHub Pages publishes from
     * @param {string}  [cfg.token]        OAuth token (real app only)
     * @param {number}  [cfg.latency=250]  fake network delay in ms (mock only)
     */
    constructor({ owner, repo, branch = 'main', token = null, latency = 250 }) {
      this.owner = owner;
      this.repo = repo;
      this.branch = branch;
      this.token = token;
      this.latency = latency;
      this._storageKey = `pebble:mock-repo:${owner}/${repo}`;
      this._db = null; // { files: { path: { content, sha } }, commits: [...] }
    }

    /** "owner/repo" */
    get fullName() { return `${this.owner}/${this.repo}`; }

    /** Where GitHub Pages serves the site. */
    get siteUrl() { return `https://${this.owner}.github.io/${this.repo}/`; }

    /**
     * List the files in the site (repository root).
     *
     * REAL: GET https://api.github.com/repos/{owner}/{repo}/contents/?ref={branch}
     *       Authorization: Bearer {token}
     *       → [{ name, path, sha, size, type: "file" | "dir", … }]
     *
     * @returns {Promise<Array<{name: string, path: string, sha: string, size: number, type: 'file'}>>}
     */
    async fetchSiteFiles() {
      const db = await this._open();
      await this._wait();
      return Object.keys(db.files).sort().map((path) => ({
        name: path.split('/').pop(),
        path,
        sha: db.files[path].sha,
        size: db.files[path].content.length,
        type: 'file',
      }));
    }

    /**
     * Read any text file (e.g. the theme "site.css").
     *
     * REAL: GET https://api.github.com/repos/{owner}/{repo}/contents/{path}?ref={branch}
     *       → { path, sha, encoding: "base64", content: "<base64>" }
     *       Decode with GitHubService.fromBase64(content).
     *
     * @param {string} path
     * @returns {Promise<{path: string, sha: string, content: string}>}
     */
    async fetchFile(path) {
      const db = await this._open();
      await this._wait();
      const file = db.files[path];
      if (!file) throw new GitHubError(404, `File not found: ${path}`);
      return { path, sha: file.sha, content: file.content };
    }

    /**
     * Read one HTML page of the site.
     * Same API call as fetchFile(); only checks that it is a page.
     *
     * @param {string} filename e.g. "about.html"
     * @returns {Promise<{path: string, sha: string, content: string}>}
     */
    async fetchPage(filename) {
      GitHubService.assertPageName(filename);
      return this.fetchFile(filename);
    }

    /**
     * Create or update one page as a commit on the publishing branch.
     * GitHub Pages rebuilds the site automatically after the commit.
     *
     * REAL: PUT https://api.github.com/repos/{owner}/{repo}/contents/{filename}
     *       body: { message, branch,
     *               content: GitHubService.toBase64(htmlContent),
     *               sha }          ← required when the file already exists
     *       → { content: { path, sha }, commit: { sha, html_url, message } }
     *       409 Conflict if `sha` is no longer the latest version.
     *
     * (Publishing several pages at once could use the Git Data API instead —
     *  one tree + one commit — so the site never shows a half-updated menu.)
     *
     * @param {string} filename     e.g. "contact.html"
     * @param {string} htmlContent  the complete page
     * @param {object} [opts]
     * @param {string} [opts.message] commit message
     * @param {string} [opts.sha]     SHA of the version being replaced
     * @returns {Promise<{path: string, sha: string, commitSha: string, message: string}>}
     */
    async commitPage(filename, htmlContent, { message, sha } = {}) {
      GitHubService.assertPageName(filename);
      const db = await this._open();
      await this._wait();

      const existing = db.files[filename];
      if (existing && sha !== existing.sha) {
        throw new GitHubError(409, `${filename} was changed somewhere else (expected ${sha || 'no sha'}, latest is ${existing.sha})`);
      }
      if (!existing && sha) {
        throw new GitHubError(404, `${filename} no longer exists`);
      }

      const newSha = await gitBlobSha(htmlContent);
      const commitMessage = message || `Update ${filename}`;
      const commitSha = await gitBlobSha(`${commitMessage}\n${newSha}\n${Date.now()}`);

      db.files[filename] = { content: htmlContent, sha: newSha };
      db.commits.unshift({ sha: commitSha, message: commitMessage, path: filename, date: new Date().toISOString() });
      this._save();

      return { path: filename, sha: newSha, commitSha, message: commitMessage };
    }

    /** Commit history of the fake repo (mock only — handy for debugging). */
    async listCommits() {
      const db = await this._open();
      return db.commits.slice();
    }

    /** Throw away the fake repository; the next call re-seeds it (mock only). */
    resetDemo() {
      this._db = null;
      try { localStorage.removeItem(this._storageKey); } catch { /* ignore */ }
    }

    /** Throws unless `name` is a safe page file name like "my-recipes.html". */
    static assertPageName(name) {
      if (!PAGE_NAME_RE.test(name)) throw new GitHubError(422, `Not a valid page name: ${name}`);
    }

    /** UTF-8 safe base64, as the GitHub contents API expects. */
    static toBase64(text) {
      const bytes = new TextEncoder().encode(text);
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      }
      return btoa(binary);
    }

    static fromBase64(b64) {
      const binary = atob(String(b64).replace(/\s/g, ''));
      return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
    }

    /* ------------------------------ mock internals ------------------------------ */

    async _open() {
      if (this._db) return this._db;
      try {
        const saved = JSON.parse(localStorage.getItem(this._storageKey) || 'null');
        if (saved && saved.files) return (this._db = saved);
      } catch { /* corrupted or unavailable → re-seed */ }

      // First visit: copy the example website into the fake repo.
      const files = {};
      for (const path of SEED_FILES) {
        try {
          const res = await fetch(SEED_BASE_URL + path, { cache: 'no-store' });
          if (!res.ok) continue;
          const content = await res.text();
          files[path] = { content, sha: await gitBlobSha(content) };
        } catch { /* offline / file:// — start with an empty site */ }
      }
      this._db = { files, commits: [] };
      this._save();
      return this._db;
    }

    _save() {
      try {
        localStorage.setItem(this._storageKey, JSON.stringify(this._db));
      } catch (err) {
        // Too many photos for localStorage: keep working in memory.
        console.warn('GitHubService (mock): repo kept in memory only', err);
      }
    }

    _wait() {
      const jitter = this.latency * (0.6 + Math.random() * 0.8);
      return new Promise((resolve) => setTimeout(resolve, jitter));
    }
  }

  /**
   * The SHA git itself would give this file: sha1("blob <bytes>\0<content>").
   * (crypto.subtle needs https or localhost.)
   */
  async function gitBlobSha(text) {
    const body = new TextEncoder().encode(text);
    const header = new TextEncoder().encode(`blob ${body.length}\0`);
    const data = new Uint8Array(header.length + body.length);
    data.set(header);
    data.set(body, header.length);
    const hash = await crypto.subtle.digest('SHA-1', data);
    return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  window.GitHubService = GitHubService;
  window.GitHubError = GitHubError;
})();
