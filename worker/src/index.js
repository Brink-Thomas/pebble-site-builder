/* ==========================================================================
   Pebble OAuth token exchange — a Cloudflare Worker.

   The browser can't hold the GitHub client SECRET, so this tiny function
   does the one step that needs it:

     POST /api/token   { "code": "<from GitHub's redirect>", "redirect_uri": "…" }
       → POST https://github.com/login/oauth/access_token
             { client_id, client_secret, code, redirect_uri }
       ← { "access_token": "…", "token_type": "bearer", "scope": "public_repo" }

   Nothing is stored or logged. Only origins listed in ALLOWED_ORIGINS may
   call it, and redirect_uri must be one of ALLOWED_REDIRECT_URIS.

   Configuration (wrangler.toml [vars] + one secret):
     GITHUB_CLIENT_ID        OAuth App client ID              (var)
     GITHUB_CLIENT_SECRET    OAuth App client secret          (wrangler secret put)
     ALLOWED_ORIGINS         e.g. "https://thomasbrink.be"    (var, comma-separated)
     ALLOWED_REDIRECT_URIS   e.g. "https://thomasbrink.be/pebble-site-builder/" (var, comma-separated)

   It uses only Web-standard Request/Response/fetch, so the same handler
   runs on Vercel/Netlify Edge or Deno with a one-line wrapper.
   ========================================================================== */

const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';

const list = (value) => String(value || '').split(',').map((s) => s.trim()).filter(Boolean);

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(body, status, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store', // never cache a token
      ...extraHeaders,
    },
  });
}

export default {
  /**
   * @param {Request} request
   * @param {Record<string, string>} env
   */
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const originAllowed = list(env.ALLOWED_ORIGINS).includes(origin);
    const cors = originAllowed ? corsHeaders(origin) : {};

    if (url.pathname !== '/api/token') return json({ error: 'not_found' }, 404, cors);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return originAllowed ? new Response(null, { status: 204, headers: cors }) : new Response(null, { status: 403 });
    }
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { ...cors, Allow: 'POST, OPTIONS' });
    if (!originAllowed) return json({ error: 'origin_not_allowed' }, 403);

    if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
      return json({ error: 'server_misconfigured', error_description: 'GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET not set' }, 500, cors);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'invalid_request', error_description: 'Body must be JSON' }, 400, cors);
    }

    const code = body && body.code;
    if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(code)) {
      return json({ error: 'invalid_request', error_description: 'Missing or malformed code' }, 400, cors);
    }

    const allowedRedirects = list(env.ALLOWED_REDIRECT_URIS);
    const redirectUri = body.redirect_uri || allowedRedirects[0];
    if (!redirectUri || !allowedRedirects.includes(redirectUri)) {
      return json({ error: 'invalid_request', error_description: 'redirect_uri not allowed' }, 400, cors);
    }

    let gh;
    try {
      gh = await fetch(GITHUB_TOKEN_URL, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': 'pebble-oauth-worker',
        },
        body: JSON.stringify({
          client_id: env.GITHUB_CLIENT_ID,
          client_secret: env.GITHUB_CLIENT_SECRET,
          code,
          redirect_uri: redirectUri,
        }),
      });
    } catch {
      return json({ error: 'github_unreachable' }, 502, cors);
    }

    const data = await gh.json().catch(() => ({}));
    // GitHub reports problems (bad_verification_code, incorrect_client_credentials,
    // redirect_uri_mismatch …) with HTTP 200 and an "error" field.
    if (!gh.ok || data.error || !data.access_token) {
      return json({
        error: data.error || 'exchange_failed',
        error_description: data.error_description || `GitHub answered ${gh.status}`,
      }, 400, cors);
    }

    return json({ access_token: data.access_token, token_type: data.token_type, scope: data.scope }, 200, cors);
  },
};
