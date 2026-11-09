/* ==========================================================================
   Pebble start page: sign in → "Your websites" → open one in the editor.

   Screens:  welcome (signed out) · busy (connecting/loading) · sites
   Words:    "hosting account" and "websites" — never "repository".
   ========================================================================== */

(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const params = new URLSearchParams(location.search);

  function show(screen) {
    for (const id of ['welcome', 'busy', 'sites']) $(`#screen-${id}`).hidden = id !== screen;
  }

  function busy(message) {
    $('#busy-message').textContent = message;
    show('busy');
  }

  /* ---------------- friendly words for auth problems ---------------- */

  const AUTH_MESSAGES = {
    denied: 'No problem — your hosting account was not connected. You can try again whenever you like.',
    state: 'That sign-in took too long or was started somewhere else. Please press the button again.',
    exchange: "We couldn't connect your hosting account just now. Please try again in a moment.",
    network: "We couldn't reach your hosting account. Please check your internet connection and try again.",
    expired: 'For your safety, please connect your hosting account again.',
    'not-configured': "Signing in isn't set up on this copy of Pebble yet.",
  };

  /* ---------------- welcome ---------------- */

  function showWelcome(message) {
    $('#account').hidden = true;
    const notice = $('#welcome-notice');
    notice.hidden = !message;
    notice.textContent = message || '';
    const configured = PebbleAuth.isConfigured();
    $('#btn-connect').disabled = !configured;
    $('#not-configured').hidden = configured;
    show('welcome');
  }

  $('#btn-connect').addEventListener('click', () => {
    try {
      PebbleAuth.login();
    } catch (err) {
      showWelcome(AUTH_MESSAGES[err.code] || AUTH_MESSAGES.exchange);
    }
  });

  $('#btn-signout').addEventListener('click', () => {
    PebbleAuth.logout();
    location.assign('./');
  });

  /* ---------------- your websites ---------------- */

  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  function updatedAgo(iso) {
    if (!iso) return '';
    const seconds = (new Date(iso).getTime() - Date.now()) / 1000;
    const units = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];
    for (const [unit, size] of units) {
      if (Math.abs(seconds) >= size) return 'Updated ' + rtf.format(Math.round(seconds / size), unit);
    }
    return 'Updated just now';
  }

  /** A stable, friendly colour per website. */
  function hueFor(text) {
    let h = 0;
    for (const ch of text) h = (h * 31 + ch.codePointAt(0)) % 360;
    return h;
  }

  function displayUrl(url) {
    return url ? url.replace(/^https?:\/\//, '').replace(/\/$/, '') : '';
  }

  function siteCard(site) {
    const ready = site.status === 'ready';
    const card = document.createElement(ready ? 'a' : 'div');
    card.className = 'site-card' + (ready ? '' : ' site-card--muted');
    if (ready) {
      // The editor gets the chosen website from the address — never the token.
      card.href = site.demo ? 'editor/?site=demo' : `editor/?site=${encodeURIComponent(site.fullName)}`;
    }
    card.style.setProperty('--hue', hueFor(site.fullName));

    const preview = document.createElement('div');
    preview.className = 'site-card__preview';
    preview.setAttribute('aria-hidden', 'true');
    preview.textContent = (site.title || '?').trim().charAt(0).toUpperCase();

    const body = document.createElement('div');
    body.className = 'site-card__body';
    const h3 = document.createElement('h3');
    h3.textContent = site.title;
    body.appendChild(h3);
    const address = document.createElement('p');
    address.className = 'site-card__url';
    address.textContent = site.demo ? 'Practice website' : displayUrl(site.url);
    body.appendChild(address);
    const meta = document.createElement('p');
    meta.className = 'site-card__meta';
    meta.textContent = ready
      ? (updatedAgo(site.updatedAt) || 'Ready to edit')
      : site.status === 'unsupported'
        ? 'Set up in a way Pebble can’t edit'
        : 'Made with another tool';
    body.appendChild(meta);

    card.append(preview, body);
    if (ready) {
      const cta = document.createElement('span');
      cta.className = 'site-card__cta';
      cta.textContent = 'Edit website →';
      card.appendChild(cta);
    }
    return card;
  }

  async function showSites(account, person) {
    show('sites');
    const isDemo = account.isDemo;
    $('#practice-banner').hidden = !isDemo;
    $('#hello').textContent = isDemo ? 'Welcome! 👋' : `Hello, ${String(person.name).split(' ')[0]}! 👋`;

    if (!isDemo) {
      $('#account').hidden = false;
      $('#account-name').textContent = person.name;
      const avatar = $('#account-avatar');
      if (person.avatarUrl) avatar.src = person.avatarUrl; else avatar.hidden = true;
    }

    const status = $('#sites-status');
    const grid = $('#site-grid');
    grid.innerHTML = '';
    $('#sites-empty').hidden = true;
    $('#other-sites').hidden = true;
    status.hidden = false;
    status.innerHTML = '<span class="spinner spinner--small" aria-hidden="true"></span> Finding your websites…';

    let sites;
    try {
      sites = await account.listWebsites();
    } catch (err) {
      console.error('Pebble: could not list websites', err);
      if (err.status === 401) return; // onUnauthorized already sends her to sign in again
      status.innerHTML = '';
      status.append("Sorry, we couldn't load your websites. ");
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'link-btn';
      retry.textContent = 'Try again';
      retry.addEventListener('click', () => showSites(account, person));
      status.appendChild(retry);
      return;
    }

    status.hidden = true;
    const ready = sites.filter((s) => s.status === 'ready');
    const others = sites.filter((s) => s.status !== 'ready');
    ready.forEach((s) => grid.appendChild(siteCard(s)));
    $('#sites-empty').hidden = ready.length > 0;

    $('#other-sites').hidden = others.length === 0;
    $('#other-count').textContent = others.length;
    const otherGrid = $('#other-grid');
    otherGrid.innerHTML = '';
    others.forEach((s) => otherGrid.appendChild(siteCard(s)));
  }

  /* ---------------- start ---------------- */

  async function start() {
    // 1. Coming back from GitHub? Finish signing in.
    if (PebbleAuth.isCallback()) {
      busy('Connecting your hosting account…');
      try {
        const { returnTo } = await PebbleAuth.handleCallback();
        if (returnTo) { location.assign(returnTo); return; }
      } catch (err) {
        console.warn('Pebble: sign-in failed', err);
        showWelcome(AUTH_MESSAGES[err.code] || AUTH_MESSAGES.exchange);
        return;
      }
    }

    // 2. Practice mode: a website stored in this browser, no account needed.
    if (params.get('demo') === '1') {
      showSites(new MockGitHubAccount(), { name: 'Guest' });
      return;
    }

    // 3. Signed in → her websites. Otherwise → welcome.
    const session = PebbleAuth.getSession();
    if (!session) {
      showWelcome(params.get('signin') === 'expired' ? AUTH_MESSAGES.expired : null);
      return;
    }
    const account = new GitHubAccount({
      token: () => PebbleAuth.getToken(),        // always the current token
      onUnauthorized: () => PebbleAuth.handleExpired(),
    });
    showSites(account, session);
  }

  start();
})();
