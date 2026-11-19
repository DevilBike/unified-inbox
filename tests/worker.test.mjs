import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../token-helper/worker.js';

const env = { GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: 'gsecret', MS_CLIENT_ID: 'mid', MS_CLIENT_SECRET: 'msecret', ALLOWED_ORIGINS: 'https://devilbike.github.io,http://localhost:8080' };
const ORIGIN = 'https://devilbike.github.io';

function call(path, body, origin = ORIGIN, method = 'POST') {
  return worker.fetch(new Request(`https://helper.example${path}`, { method, headers: { Origin: origin, 'Content-Type': 'application/json' }, body: method === 'POST' ? JSON.stringify(body) : undefined }), env);
}

function mockUpstream(fn) {
  const real = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => { const p = Object.fromEntries(new URLSearchParams(init.body)); seen.push({ url, p }); return new Response(JSON.stringify(fn(url, p)), { status: 200 }); };
  return { seen, restore: () => { globalThis.fetch = real; } };
}

test('rejects other websites', async () => {
  const r = await call('/google/refresh', { refresh_token: 'x' }, 'https://evil.example');
  assert.equal(r.status, 403);
});

test('preflight works for the app', async () => {
  const r = await call('/google/token', null, ORIGIN, 'OPTIONS');
  assert.equal(r.status, 204);
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), ORIGIN);
});

test('google code exchange adds the secret and returns tokens', async () => {
  const m = mockUpstream(() => ({ access_token: 'AT', refresh_token: 'RT', expires_in: 3599, scope: 's', id_token: 'should-not-leak' }));
  const r = await call('/google/token', { code: 'C', code_verifier: 'V', redirect_uri: 'https://devilbike.github.io/unified-inbox/auth.html' });
  m.restore();
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { access_token: 'AT', refresh_token: 'RT', expires_in: 3599, scope: 's' });
  assert.equal(m.seen[0].url, 'https://oauth2.googleapis.com/token');
  assert.equal(m.seen[0].p.client_secret, 'gsecret');
  assert.equal(m.seen[0].p.code_verifier, 'V');
});

test('refuses sign-in return pages on other sites', async () => {
  const r = await call('/google/token', { code: 'C', redirect_uri: 'https://evil.example/auth.html' });
  assert.equal(r.status, 400);
});

test('microsoft refresh uses the confidential client', async () => {
  const m = mockUpstream(() => ({ access_token: 'AT2', refresh_token: 'RT2', expires_in: 3600 }));
  const r = await call('/microsoft/refresh', { refresh_token: 'RT1' });
  m.restore();
  assert.equal((await r.json()).refresh_token, 'RT2');
  assert.match(m.seen[0].url, /consumers\/oauth2\/v2.0\/token$/);
  assert.equal(m.seen[0].p.client_secret, 'msecret');
  assert.match(m.seen[0].p.scope, /offline_access/);
});

test('passes along provider errors without secrets', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }), { status: 400 });
  const r = await call('/google/refresh', { refresh_token: 'old' });
  globalThis.fetch = real;
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, 'invalid_grant');
});
