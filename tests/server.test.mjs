import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp, safeAppPath, newer, GOOGLE_SCOPES } from '../server.mjs';

const PORT = 18000 + Math.floor(Math.random() * 2000);
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
let dataDir, app, calls;
const remote = new Map(); // fake GitHub raw files

function json(body, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }); }

async function fakeFetch(url, opts = {}) {
  const u = String(url);
  calls.push({ url: u, body: opts.body ? String(opts.body) : '' });
  if (u.startsWith('https://oauth2.googleapis.com/token')) {
    const p = new URLSearchParams(opts.body);
    if (p.get('grant_type') === 'refresh_token') {
      if (p.get('refresh_token') === 'revoked') return json({ error: 'invalid_grant' }, 400);
      return json({ access_token: 'g-access-2', expires_in: 3600 });
    }
    return json({ access_token: 'g-access-1', refresh_token: 'g-refresh', expires_in: 3600, scope: GOOGLE_SCOPES.join(' ') });
  }
  if (u.startsWith('https://gmail.googleapis.com/gmail/v1/users/me/profile')) return json({ emailAddress: 'Person.One@example.com' });
  if (u.startsWith('https://login.microsoftonline.com/consumers/oauth2/v2.0/token')) return json({ access_token: 'm-access', refresh_token: 'm-refresh-2', expires_in: 3600 });
  if (u.startsWith('https://graph.microsoft.com/v1.0/me')) return json({ displayName: 'Person Two', mail: 'person.two@example.net' });
  if (u.startsWith('https://raw.example/')) {
    const rel = u.slice('https://raw.example/'.length).split('?')[0];
    return remote.has(rel) ? new Response(remote.get(rel)) : new Response('nope', { status: 404 });
  }
  throw new Error(`unexpected fetch ${u}`);
}

function raw(pathname, { headers = {}, method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: pathname, method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const call = async (p, { method = 'GET', body } = {}) => {
  const r = await fetch(`${BASE}/api/${p}`, { method, headers: { 'X-Inbox': '1', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json() };
};

let appDir;
before(async () => {
  dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ui-data-'));
  appDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ui-app-'));
  for (const f of ['index.html', 'version.json']) await fsp.copyFile(path.join(ROOT, f), path.join(appDir, f));
  await fsp.writeFile(path.join(appDir, 'server.mjs'), '// secret-ish server code');
  calls = [];
  app = createApp({ port: PORT, appDir, dataDir, fetchImpl: fakeFetch, repoRaw: 'https://raw.example' });
  await new Promise((r) => app.server.listen(PORT, '127.0.0.1', r));
});
after(() => new Promise((r) => app.server.close(r)));

test('only answers on localhost, and the API only to the app itself', async () => {
  assert.equal((await raw('/', { headers: { Host: 'evil.example' } })).status, 403);
  assert.equal((await raw('/api/status', { headers: { Host: `localhost:${PORT}` } })).status, 403, 'needs the X-Inbox header');
  assert.equal((await raw('/api/status', { headers: { Host: `localhost:${PORT}`, 'X-Inbox': '1', Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await raw('/api/status', { headers: { Host: `localhost:${PORT}`, 'X-Inbox': '1', Origin: `http://localhost:${PORT}` } })).status, 200);
});

test('serves the app screens but nothing else', async () => {
  const home = await raw('/', { headers: { Host: `localhost:${PORT}` } });
  assert.equal(home.status, 200);
  assert.match(home.headers['content-security-policy'], /connect-src 'self' https:\/\/gmail\.googleapis\.com https:\/\/graph\.microsoft\.com/);
  for (const p of ['/server.mjs', '/js/../server.mjs', '/%2e%2e/server.mjs', '/package.json']) {
    assert.equal((await raw(p, { headers: { Host: `localhost:${PORT}` } })).status, 404, p);
  }
});

test('settings keep the client secret on this PC and never send it back', async () => {
  await call('settings', { method: 'POST', body: { googleClientId: ' gid.apps.googleusercontent.com ', googleClientSecret: 'shh', microsoftClientId: 'mid' } });
  const { data } = await call('settings');
  assert.equal(data.googleClientId, 'gid.apps.googleusercontent.com');
  assert.equal(data.hasGoogleSecret, true);
  assert.ok(!JSON.stringify(data).includes('shh'));
  await call('settings', { method: 'POST', body: { googleClientId: 'gid.apps.googleusercontent.com', googleClientSecret: '', microsoftClientId: 'mid' } });
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8')).googleClientSecret, 'shh', 'blank keeps the old secret');
  assert.equal((await call('status')).data.setup.google, true);
});

test('Google sign-in: start, come back, stay signed in', async () => {
  const start = await raw('/auth/start?provider=google', { headers: { Host: `localhost:${PORT}` } });
  assert.equal(start.status, 302);
  const to = new URL(start.headers.location);
  assert.equal(to.origin, 'https://accounts.google.com');
  assert.equal(to.searchParams.get('redirect_uri'), `http://localhost:${PORT}/auth/callback`);
  assert.equal(to.searchParams.get('access_type'), 'offline');
  assert.equal(to.searchParams.get('code_challenge_method'), 'S256');
  const state = to.searchParams.get('state');

  const back = await raw(`/auth/callback?state=${state}&code=abc`, { headers: { Host: `localhost:${PORT}` } });
  assert.equal(back.status, 302);
  assert.equal(back.headers.location, '/#/settings?added=person.one%40example.com');
  const exchange = calls.find((c) => c.url.startsWith('https://oauth2.googleapis.com/token'));
  const p = new URLSearchParams(exchange.body);
  assert.equal(p.get('client_secret'), 'shh');
  assert.ok(p.get('code_verifier'));

  const { data } = await call('status');
  assert.equal(data.accounts.length, 1);
  assert.equal(data.accounts[0].email, 'person.one@example.com');
  assert.equal(data.accounts[0].signedIn, true);
  assert.ok(!JSON.stringify(data).includes('g-refresh'), 'refresh token never leaves the server');

  // A used sign-in link can't be replayed.
  const again = await raw(`/auth/callback?state=${state}&code=abc`, { headers: { Host: `localhost:${PORT}` } });
  assert.match(decodeURIComponent(again.headers.location), /signin_error=That sign-in took too long/);
});

test('access tokens: cached, refreshed on request, and a revoked sign-in is flagged', async () => {
  const id = 'google:person.one@example.com';
  assert.equal((await call('token', { method: 'POST', body: { id } })).data.accessToken, 'g-access-1');
  assert.equal((await call('token', { method: 'POST', body: { id, fresh: true } })).data.accessToken, 'g-access-2');
  const accounts = JSON.parse(fs.readFileSync(path.join(dataDir, 'accounts.json'), 'utf8'));
  accounts[0].refreshToken = 'revoked';
  fs.writeFileSync(path.join(dataDir, 'accounts.json'), JSON.stringify(accounts));
  const r = await call('token', { method: 'POST', body: { id, fresh: true } });
  assert.equal(r.status, 401);
  assert.equal(r.data.needsSignIn, true);
  assert.equal((await call('status')).data.accounts[0].signedIn, false);
});

test('signing in to the wrong mailbox is refused', async () => {
  const start = await raw('/auth/start?provider=microsoft&hint=someone.else@example.net', { headers: { Host: `localhost:${PORT}` } });
  const to = new URL(start.headers.location);
  assert.equal(to.origin + to.pathname, 'https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize');
  assert.match(to.searchParams.get('scope'), /offline_access/);
  const back = await raw(`/auth/callback?state=${to.searchParams.get('state')}&code=x`, { headers: { Host: `localhost:${PORT}` } });
  assert.match(decodeURIComponent(back.headers.location), /You signed in as person\.two@example\.net/);
  assert.equal((await call('status')).data.accounts.length, 1);
});

test('sign-in from the app window: opens your browser, then reports back', async () => {
  const opened = [];
  const port2 = PORT + 1;
  const app2 = createApp({ port: port2, appDir, dataDir, fetchImpl: fakeFetch, openUrl: async (u) => { opened.push(u); } });
  await new Promise((r) => app2.server.listen(port2, '127.0.0.1', r));
  try {
    const api2 = async (p, opts = {}) => (await fetch(`http://127.0.0.1:${port2}/api/${p}`, { method: opts.method || 'GET', headers: { 'X-Inbox': '1', 'Content-Type': 'application/json' }, body: opts.body ? JSON.stringify(opts.body) : undefined })).json();
    const start = await api2('signin', { method: 'POST', body: { provider: 'microsoft' } });
    assert.equal(start.opened, true);
    assert.equal(opened[0], start.url);
    assert.deepEqual(await api2(`signin/${start.state}`), { done: false, email: null, error: null });
    const back = await new Promise((resolve) => http.get({ host: '127.0.0.1', port: port2, path: `/auth/callback?state=${start.state}&code=x`, headers: { Host: `localhost:${port2}` } }, (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, body: d })); }));
    assert.equal(back.status, 200, 'shows a page in the browser instead of redirecting');
    assert.match(back.body, /Signed in to person\.two@example\.net/);
    assert.deepEqual(await api2(`signin/${start.state}`), { done: true, email: 'person.two@example.net', error: null });
  } finally { await new Promise((r) => app2.server.close(r)); }
});

test('remove a mailbox and change its color', async () => {
  const id = encodeURIComponent('google:person.one@example.com');
  assert.equal((await call(`accounts/${id}`, { method: 'PATCH', body: { color: '#123456', refreshToken: 'nope' } })).data.color, '#123456');
  assert.notEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'accounts.json'), 'utf8'))[0].refreshToken, 'nope');
  await call(`accounts/${id}`, { method: 'DELETE' });
  await call(`accounts/${encodeURIComponent('microsoft:person.two@example.net')}`, { method: 'DELETE' });
  assert.equal((await call('status')).data.accounts.length, 0);
});

test('stored values and the cleanup log', async () => {
  await call('kv/rules', { method: 'PUT', body: { value: [{ name: 'x' }] } });
  assert.deepEqual((await call('kv/rules')).data.value, [{ name: 'x' }]);
  assert.equal((await call('kv/missing')).data.value, null);
  assert.equal((await call('kv/..%2Fsettings')).status, 404);
  await call('log/run_1', { method: 'POST', body: { entries: [{ msgId: 'a' }, { msgId: 'b' }] } });
  await call('log/run_1', { method: 'POST', body: { entries: [{ msgId: 'c' }] } });
  assert.deepEqual((await call('log/run_1')).data.entries.map((e) => e.msgId), ['a', 'b', 'c']);
  await call('log/run_1', { method: 'DELETE' });
  assert.deepEqual((await call('log/run_1')).data.entries, []);
});

test('updates: check, then swap in the new files', async () => {
  remote.set('version.json', JSON.stringify({ version: '99.0.0', changes: ['Better'] }));
  const check = (await call('update')).data;
  assert.equal(check.available, true);
  assert.deepEqual(check.changes, ['Better']);

  remote.set('files.json', JSON.stringify(['../evil.js', 'server.mjs', 'index.html']));
  assert.equal((await call('update', { method: 'POST' })).status, 502, 'refuses a file list that escapes the folder');

  await fsp.writeFile(path.join(appDir, 'files.json'), JSON.stringify(['index.html', 'server.mjs', 'old.js']));
  await fsp.writeFile(path.join(appDir, 'old.js'), 'old');
  remote.set('files.json', JSON.stringify(['index.html', 'server.mjs', 'js/new.js', 'version.json', 'files.json']));
  remote.set('index.html', '<!doctype html>new');
  remote.set('server.mjs', '// new server');
  remote.set('js/new.js', 'export {}');
  const r = await call('update', { method: 'POST' });
  assert.equal(r.status, 200);
  assert.equal(fs.readFileSync(path.join(appDir, 'js', 'new.js'), 'utf8'), 'export {}');
  assert.equal(fs.readFileSync(path.join(appDir, 'index.html'), 'utf8'), '<!doctype html>new');
  assert.equal(fs.existsSync(path.join(appDir, 'old.js')), false, 'files dropped from the app are removed');
});

test('path and version helpers', () => {
  for (const ok of ['index.html', 'js/ui/mail.js', 'Start Unified Inbox.bat']) assert.ok(safeAppPath(ok), ok);
  for (const bad of ['../x', '/etc/passwd', 'js//x.js', '.git/config', 'js/.hidden', 'C:\\x', '']) assert.ok(!safeAppPath(bad), bad);
  assert.ok(newer('0.10.0', '0.9.9'));
  assert.ok(!newer('0.4.0', '0.4.0'));
});

test('files.json lists every file the app needs', () => {
  const list = JSON.parse(fs.readFileSync(path.join(ROOT, 'files.json'), 'utf8'));
  for (const f of list) assert.ok(fs.existsSync(path.join(ROOT, f)), `${f} is listed but missing`);
  const walk = (dir) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`]));
  for (const f of [...walk('js'), ...walk('css'), ...walk('icons'), 'server.mjs', 'index.html', 'version.json']) assert.ok(list.includes(f), `${f} missing from files.json (run npm run files)`);
});
