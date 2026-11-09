// Run the token exchange locally (no Cloudflare account needed).
//
//   GITHUB_CLIENT_ID=… GITHUB_CLIENT_SECRET=… node worker/dev-server.mjs
//   node worker/dev-server.mjs --fake     ← GitHub stubbed: any code returns a fake token
//
// Listens on http://localhost:8787/api/token and allows the Pebble dev server
// (http://localhost:8080) to call it. Then, on http://localhost:8080:
//   localStorage.setItem('pebble:dev-config', JSON.stringify({
//     githubClientId: '<client id>', tokenEndpoint: 'http://localhost:8787/api/token' }))
import http from 'node:http';
import worker from './src/index.js';

const fake = process.argv.includes('--fake');
const env = {
  GITHUB_CLIENT_ID: process.env.GITHUB_CLIENT_ID || (fake ? 'fake-client-id' : ''),
  GITHUB_CLIENT_SECRET: process.env.GITHUB_CLIENT_SECRET || (fake ? 'fake-secret' : ''),
  ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS || 'http://localhost:8080',
  ALLOWED_REDIRECT_URIS: process.env.ALLOWED_REDIRECT_URIS || 'http://localhost:8080/',
};

if (fake) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url) !== 'https://github.com/login/oauth/access_token') return realFetch(url, init);
    const { code } = JSON.parse(init.body);
    const body = code === 'bad' ? { error: 'bad_verification_code', error_description: 'The code passed is incorrect or expired.' }
      : { access_token: 'fake_token_for_local_testing', token_type: 'bearer', scope: 'public_repo' };
    return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
  };
}

http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const request = new Request(`http://localhost:8787${req.url}`, {
    method: req.method,
    headers: req.headers,
    body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
  });
  const response = await worker.fetch(request, env);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(8787, () => console.log(`Token exchange on http://localhost:8787/api/token${fake ? ' (fake GitHub)' : ''}`));
