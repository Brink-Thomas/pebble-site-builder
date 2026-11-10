/* ==========================================================================
   Pebble configuration — the only file to edit when deploying Pebble.

   1. Create a GitHub OAuth App (github.com → Settings → Developer settings →
      OAuth Apps → New OAuth App):
        Homepage URL:               https://<where Pebble is hosted>/
        Authorization callback URL: https://<where Pebble is hosted>/
      (the callback is Pebble's start page, i.e. this site's root)
   2. Deploy the token exchange in /worker (see README) with the app's
      client ID and client secret.
   3. Fill in the two values below. Neither is secret: the client SECRET
      lives only in the worker.
   ========================================================================== */

window.PEBBLE_CONFIG = {
  /** "Client ID" of your GitHub OAuth App, e.g. "Ov23liAbCdEf12345678". */
  githubClientId: 'Ov23liM1SZpS5lCcI97P',

  /** URL of the deployed token exchange, e.g. "https://pebble-oauth.you.workers.dev/api/token". */
  tokenEndpoint: 'https://pebble-oauth.thomasbrink.workers.dev/api/token',

  /**
   * What Pebble asks permission for. GitHub's Pages endpoints (reading where
   * a site is published, switching Pages on for a new website) require the
   * full "repo" scope for OAuth Apps — "public_repo" is not enough for them.
   */
  oauthScope: 'repo',

  /** Where GitHub sends people back after login. Must equal the OAuth App's callback URL. */
  redirectUri: 'https://pebble.thomasbrink.be/',
};

// Local development only: override any of the values above from the console,
//   localStorage.setItem('pebble:dev-config', JSON.stringify({ tokenEndpoint: 'http://localhost:8787/api/token' }))
// Ignored on any host other than localhost, so it can't be abused in production.
(function () {
  if (!/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) return;
  try {
    Object.assign(window.PEBBLE_CONFIG, JSON.parse(localStorage.getItem('pebble:dev-config') || '{}'));
  } catch { /* ignore */ }
})();
