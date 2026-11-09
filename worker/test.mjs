// Tests for the token exchange, with GitHub's endpoint stubbed.
// Run: node worker/test.mjs
import worker from './src/index.js';

const env = {
  GITHUB_CLIENT_ID: 'Ov23liTEST',
  GITHUB_CLIENT_SECRET: 'test-secret',
  ALLOWED_ORIGINS: 'https://thomasbrink.be, http://localhost:8080',
  ALLOWED_REDIRECT_URIS: 'https://thomasbrink.be/pebble-site-builder/,http://localhost:8080/',
};

let ghCalls = [];
let ghReply = { status: 200, body: { access_token: 'gho_fake', token_type: 'bearer', scope: 'public_repo' } };
globalThis.fetch = async (url, init) => {
  ghCalls.push({ url, init, body: JSON.parse(init.body) });
  return new Response(JSON.stringify(ghReply.body), { status: ghReply.status, headers: { 'Content-Type': 'application/json' } });
};

const call = (method, path, { origin = 'https://thomasbrink.be', body } = {}) =>
  worker.fetch(new Request('https://pebble-oauth.example.workers.dev' + path, {
    method,
    headers: { ...(origin ? { Origin: origin } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  }), env);

let passed = 0, failed = 0;
async function test(name, fn) {
  ghCalls = [];
  ghReply = { status: 200, body: { access_token: 'gho_fake', token_type: 'bearer', scope: 'public_repo' } };
  try { await fn(); passed++; console.log('PASS ', name); }
  catch (e) { failed++; console.log('FAIL ', name, '—', e.message); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };

await test('preflight from allowed origin → 204 + CORS', async () => {
  const r = await call('OPTIONS', '/api/token');
  assert(r.status === 204, r.status);
  assert(r.headers.get('Access-Control-Allow-Origin') === 'https://thomasbrink.be', 'ACAO');
});
await test('preflight from other origin → 403, no CORS', async () => {
  const r = await call('OPTIONS', '/api/token', { origin: 'https://evil.example' });
  assert(r.status === 403 && !r.headers.get('Access-Control-Allow-Origin'), r.status);
});
await test('successful exchange returns only token fields, no-store', async () => {
  const r = await call('POST', '/api/token', { body: { code: 'abc123', redirect_uri: 'https://thomasbrink.be/pebble-site-builder/' } });
  const j = await r.json();
  assert(r.status === 200, r.status);
  assert(j.access_token === 'gho_fake' && j.scope === 'public_repo' && Object.keys(j).length === 3, JSON.stringify(j));
  assert(r.headers.get('Cache-Control') === 'no-store', 'cache header');
  assert(r.headers.get('Access-Control-Allow-Origin') === 'https://thomasbrink.be', 'ACAO');
  const sent = ghCalls[0];
  assert(sent.url === 'https://github.com/login/oauth/access_token', sent.url);
  assert(sent.body.client_secret === 'test-secret' && sent.body.client_id === 'Ov23liTEST' && sent.body.code === 'abc123', JSON.stringify(sent.body));
  assert(sent.init.headers.Accept === 'application/json', 'accept json');
});
await test('redirect_uri defaults to the first allowed one', async () => {
  await call('POST', '/api/token', { body: { code: 'abc' } });
  assert(ghCalls[0].body.redirect_uri === 'https://thomasbrink.be/pebble-site-builder/', ghCalls[0].body.redirect_uri);
});
await test('redirect_uri not on the list → 400, GitHub not called', async () => {
  const r = await call('POST', '/api/token', { body: { code: 'abc', redirect_uri: 'https://evil.example/' } });
  assert(r.status === 400 && ghCalls.length === 0, r.status);
});
await test('POST from other origin → 403, GitHub not called', async () => {
  const r = await call('POST', '/api/token', { origin: 'https://evil.example', body: { code: 'abc' } });
  assert(r.status === 403 && ghCalls.length === 0, r.status);
});
await test('POST without Origin header → 403', async () => {
  const r = await call('POST', '/api/token', { origin: null, body: { code: 'abc' } });
  assert(r.status === 403, r.status);
});
await test('missing / malformed code → 400', async () => {
  for (const body of [{}, { code: '' }, { code: 'a b' }, { code: 'x'.repeat(200) }, { code: 42 }]) {
    const r = await call('POST', '/api/token', { body });
    assert(r.status === 400, JSON.stringify(body) + ' → ' + r.status);
  }
  assert(ghCalls.length === 0, 'github called');
});
await test('invalid JSON → 400', async () => {
  const r = await call('POST', '/api/token', { body: '{not json' });
  assert(r.status === 400, r.status);
});
await test('GitHub error (200 + error field) → 400 with reason', async () => {
  ghReply = { status: 200, body: { error: 'bad_verification_code', error_description: 'The code passed is incorrect or expired.' } };
  const r = await call('POST', '/api/token', { body: { code: 'expired' } });
  const j = await r.json();
  assert(r.status === 400 && j.error === 'bad_verification_code' && !j.access_token, JSON.stringify(j));
});
await test('GET → 405, unknown path → 404', async () => {
  assert((await call('GET', '/api/token')).status === 405, 'GET');
  assert((await call('POST', '/other', { body: { code: 'x' } })).status === 404, 'path');
});
await test('missing secret → 500 (misconfigured), GitHub not called', async () => {
  const r = await worker.fetch(new Request('https://w.dev/api/token', { method: 'POST', headers: { Origin: 'https://thomasbrink.be', 'Content-Type': 'application/json' }, body: '{"code":"abc"}' }), { ...env, GITHUB_CLIENT_SECRET: '' });
  assert(r.status === 500 && ghCalls.length === 0, r.status);
});

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
