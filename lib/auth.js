/* ==========================================================================
   PebbleAuth — "Connect your Hosting Account (GitHub)".

   Standard OAuth web flow, with the client secret kept server-side:

     1. login()            → redirect to github.com/login/oauth/authorize
                              with client_id, scope, redirect_uri and a random
                              `state` (remembered in sessionStorage)
     2. GitHub redirects back to Pebble's start page with ?code=…&state=…
     3. handleCallback()   → checks `state` (stops forged logins), removes the
                              code from the address bar, and POSTs the code to
                              our token exchange (/worker), which adds the
                              client secret and asks GitHub for the token
     4. The token is stored in localStorage (so she stays signed in on her
        own computer) together with her name and picture, and every
        GitHubService call uses it.

   The token never appears in a URL, and is only ever sent to api.github.com.
   ========================================================================== */

(function () {
  'use strict';

  const SESSION_KEY = 'pebble:session';
  const STATE_KEY = 'pebble:oauth-state';
  const STATE_MAX_AGE = 15 * 60 * 1000; // a login attempt is valid for 15 minutes

  // Pebble's start page (site root), derived from where this script lives:
  // <root>/lib/auth.js → <root>/
  const APP_ROOT = new URL('../', document.currentScript.src).href;

  const config = () => window.PEBBLE_CONFIG || {};

  /** An auth problem with a code the UI turns into friendly words. */
  class AuthError extends Error {
    constructor(code, message) {
      super(message || code);
      this.name = 'AuthError';
      this.code = code; // 'denied' | 'state' | 'exchange' | 'network' | 'not-configured' | 'expired'
    }
  }

  function randomState() {
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  const PebbleAuth = {
    appRoot: APP_ROOT,

    /** Is login set up on this copy of Pebble (see lib/config.js)? */
    isConfigured() {
      const c = config();
      return !!(c.githubClientId && c.tokenEndpoint);
    },

    redirectUri() {
      return config().redirectUri || APP_ROOT;
    },

    /** The GitHub authorization URL for a fresh login attempt. */
    buildAuthorizeUrl(state) {
      const c = config();
      const url = new URL('https://github.com/login/oauth/authorize');
      url.searchParams.set('client_id', c.githubClientId);
      url.searchParams.set('redirect_uri', this.redirectUri());
      url.searchParams.set('scope', c.oauthScope || 'public_repo');
      url.searchParams.set('state', state);
      url.searchParams.set('allow_signup', 'true'); // she may not have an account yet
      return url.href;
    },

    /**
     * Step 1: send her to GitHub to approve Pebble.
     * @param {string} [returnTo] page to come back to afterwards (same site only)
     */
    login(returnTo) {
      if (!this.isConfigured()) throw new AuthError('not-configured', 'Login is not configured (lib/config.js)');
      const state = randomState();
      sessionStorage.setItem(STATE_KEY, JSON.stringify({ state, returnTo: returnTo || null, at: Date.now() }));
      location.assign(this.buildAuthorizeUrl(state));
    },

    /** Is the current address a return from GitHub? */
    isCallback() {
      const p = new URLSearchParams(location.search);
      return p.has('state') && (p.has('code') || p.has('error'));
    },

    /**
     * Steps 2–4: finish a login after GitHub sent her back.
     * @returns {Promise<{session: object, returnTo: string|null}>}
     * @throws {AuthError}
     */
    async handleCallback() {
      const params = new URLSearchParams(location.search);
      const code = params.get('code');
      const state = params.get('state');
      const error = params.get('error');

      // Never leave the one-time code in the address bar or browser history.
      const clean = new URL(location.href);
      ['code', 'state', 'error', 'error_description', 'error_uri'].forEach((k) => clean.searchParams.delete(k));
      history.replaceState(null, '', clean.pathname + clean.search + clean.hash);

      let saved = null;
      try { saved = JSON.parse(sessionStorage.getItem(STATE_KEY) || 'null'); } catch { /* ignore */ }
      sessionStorage.removeItem(STATE_KEY);

      if (error) throw new AuthError(error === 'access_denied' ? 'denied' : 'exchange', params.get('error_description') || error);
      if (!saved || !state || saved.state !== state || Date.now() - saved.at > STATE_MAX_AGE) {
        throw new AuthError('state', 'Login state did not match');
      }

      let data;
      try {
        const res = await fetch(config().tokenEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code, redirect_uri: this.redirectUri() }),
        });
        data = await res.json().catch(() => ({}));
        if (!res.ok || !data.access_token) throw new AuthError('exchange', data.error_description || data.error || `HTTP ${res.status}`);
      } catch (err) {
        if (err instanceof AuthError) throw err;
        throw new AuthError('network', err.message);
      }

      const session = await this._createSession(data.access_token, data.scope);
      const returnTo = saved.returnTo && new URL(saved.returnTo, APP_ROOT).origin === location.origin ? saved.returnTo : null;
      return { session, returnTo };
    },

    /** Look up who signed in, and remember the session. */
    async _createSession(token, scope) {
      const res = await fetch('https://api.github.com/user', {
        headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' },
        cache: 'no-store',
      }).catch((err) => { throw new AuthError('network', err.message); });
      if (!res.ok) throw new AuthError(res.status === 401 ? 'expired' : 'exchange', `GET /user → ${res.status}`);
      const user = await res.json();
      const session = {
        token,
        scope: scope || '',
        login: user.login,
        name: user.name || user.login,
        avatarUrl: user.avatar_url,
        createdAt: Date.now(),
      };
      localStorage.setItem(SESSION_KEY, JSON.stringify(session));
      return session;
    },

    /** The signed-in session, or null. */
    getSession() {
      try {
        const s = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
        return s && s.token ? s : null;
      } catch {
        return null;
      }
    },

    getToken() {
      const s = this.getSession();
      return s ? s.token : null;
    },

    /** Forget the token on this computer. */
    logout() {
      localStorage.removeItem(SESSION_KEY);
    },

    /** Called when GitHub answers 401: the token was revoked or expired. */
    handleExpired() {
      this.logout();
      location.assign(APP_ROOT + '?signin=expired');
    },

    AuthError,
  };

  window.PebbleAuth = PebbleAuth;
})();
