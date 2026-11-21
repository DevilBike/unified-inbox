#!/usr/bin/env node
// Unified Inbox: the local app. Runs only on your PC at http://localhost:8765.
// It serves the app's screens, handles signing in to Gmail and Outlook, keeps your
// sign-ins and cleanup history in your user folder, and installs updates.
// No dependencies: plain Node 18+.
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const DEFAULT_PORT = 8765;
export const RESTART_CODE = 75;
export const REPO_RAW = 'https://raw.githubusercontent.com/DevilBike/unified-inbox/main';
const APP_DIR = path.dirname(fileURLToPath(import.meta.url));

export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.settings.basic',
];
export const MICROSOFT_SCOPES = ['offline_access', 'User.Read', 'Mail.ReadWrite', 'MailboxSettings.ReadWrite'];

const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const MS_AUTHORITY = 'https://login.microsoftonline.com/consumers/oauth2/v2.0';
const COLORS = ['#7AA2FF', '#F0A35E', '#4FC3B0', '#B794F6', '#E6E08A', '#F08FB2', '#8FD3F0'];

export function defaultDataDir() {
  if (process.env.UNIFIED_INBOX_DATA) return process.env.UNIFIED_INBOX_DATA;
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'UnifiedInbox');
  return path.join(os.homedir(), '.unified-inbox');
}

// A path inside the app folder that updates are allowed to write.
export function safeAppPath(p) {
  return typeof p === 'string' && /^[\w][\w./ -]*$/.test(p) && p.length < 200
    && !p.split('/').some((s) => s === '' || s === '..' || s.startsWith('.'));
}

export function newer(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
}

const rand = (n = 24) => crypto.randomBytes(n).toString('base64url');
function pkce() {
  const verifier = rand(48);
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
}

class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; Object.assign(this, extra); }
}

// ---------- files in your user folder ----------
function makeStore(dir) {
  let chain = Promise.resolve();
  const file = (name) => path.join(dir, name);
  async function readJson(name, fallback) {
    try { return JSON.parse(await fsp.readFile(file(name), 'utf8')); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
  }
  async function writeNow(name, value) {
    const f = file(name);
    await fsp.mkdir(path.dirname(f), { recursive: true });
    const tmp = `${f}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(value, null, 2));
    try { await fsp.rename(tmp, f); } catch { await fsp.writeFile(f, JSON.stringify(value, null, 2)); await fsp.rm(tmp, { force: true }); }
  }
  // Writes happen one at a time so two quick changes can't overwrite each other.
  function locked(fn) { const run = chain.then(fn, fn); chain = run.catch(() => {}); return run; }
  return {
    dir, file, readJson,
    writeJson: (name, value) => locked(() => writeNow(name, value)),
    update: (name, fallback, fn) => locked(async () => { const v = await readJson(name, fallback); const out = await fn(v); await writeNow(name, v); return out; }),
    appendLines: (name, lines) => locked(async () => { const f = file(name); await fsp.mkdir(path.dirname(f), { recursive: true }); await fsp.appendFile(f, lines.map((l) => `${JSON.stringify(l)}\n`).join('')); }),
    async readLines(name) { try { return (await fsp.readFile(file(name), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (e) { if (e.code === 'ENOENT') return []; throw e; } },
    remove: (name) => locked(() => fsp.rm(file(name), { force: true })),
  };
}

const publicAccount = ({ refreshToken, ...a }) => ({ ...a, signedIn: !!refreshToken && a.status !== 'needs-signin' });

// ---------- the app server ----------
export function createApp({ port = DEFAULT_PORT, appDir = APP_DIR, dataDir = defaultDataDir(), fetchImpl = fetch, onRestart = null, repoRaw = REPO_RAW } = {}) {
  const store = makeStore(dataDir);
  const origin = `http://localhost:${port}`;
  const redirectUri = `${origin}/auth/callback`;
  const pending = new Map(); // sign-in state -> { provider, verifier, hint, at }
  const tokens = new Map(); // account id -> { accessToken, expiresAt }
  const inflight = new Map();

  const loadSettings = () => store.readJson('settings.json', {});
  const loadAccounts = () => store.readJson('accounts.json', []);

  async function tokenRequest(url, params) {
    let res;
    try {
      res = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString() });
    } catch { throw new HttpError(502, 'Couldn’t reach the sign-in server. Check your internet connection.'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const permanent = data.error === 'invalid_grant' || data.error === 'interaction_required' || res.status === 400 || res.status === 401;
      throw new HttpError(permanent ? 401 : 502, data.error_description || data.error || `Sign-in failed (${res.status})`, { permanent });
    }
    return data;
  }

  async function getJson(url, accessToken) {
    const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) throw new HttpError(502, `Couldn’t read the mailbox address (${res.status})`);
    return res.json();
  }

  function requireSetup(settings, provider) {
    if (provider === 'google' && !(settings.googleClientId && settings.googleClientSecret)) throw new HttpError(400, 'Add your Google client ID and secret in Settings first.');
    if (provider === 'microsoft' && !settings.microsoftClientId) throw new HttpError(400, 'Add your Microsoft application ID in Settings first.');
  }

  async function signInUrl(provider, hint) {
    if (provider !== 'google' && provider !== 'microsoft') throw new HttpError(400, 'Unknown provider');
    const settings = await loadSettings();
    requireSetup(settings, provider);
    for (const [k, v] of pending) if (Date.now() - v.at > 15 * 60000) pending.delete(k);
    const state = rand(16);
    const { verifier, challenge } = pkce();
    pending.set(state, { provider, verifier, hint: (hint || '').toLowerCase(), at: Date.now() });
    const common = { redirect_uri: redirectUri, response_type: 'code', state, code_challenge: challenge, code_challenge_method: 'S256' };
    if (provider === 'google') {
      const p = new URLSearchParams({ ...common, client_id: settings.googleClientId, scope: GOOGLE_SCOPES.join(' '), access_type: 'offline', prompt: 'consent select_account', include_granted_scopes: 'true' });
      if (hint) p.set('login_hint', hint);
      return `${GOOGLE_AUTH}?${p}`;
    }
    const p = new URLSearchParams({ ...common, client_id: settings.microsoftClientId, scope: MICROSOFT_SCOPES.join(' '), response_mode: 'query', prompt: 'select_account' });
    if (hint) p.set('login_hint', hint);
    return `${MS_AUTHORITY}/authorize?${p}`;
  }

  async function finishSignIn(query) {
    const state = query.get('state') || '';
    const p = pending.get(state);
    pending.delete(state);
    const err = query.get('error');
    if (err) throw new HttpError(400, err === 'access_denied' ? 'Sign-in was cancelled.' : (query.get('error_description') || err));
    if (!p) throw new HttpError(400, 'That sign-in took too long or was already used. Try again.');
    const settings = await loadSettings();
    requireSetup(settings, p.provider);
    const code = query.get('code');
    let data, email, name = '';
    if (p.provider === 'google') {
      data = await tokenRequest(GOOGLE_TOKEN, { code, client_id: settings.googleClientId, client_secret: settings.googleClientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code', code_verifier: p.verifier });
      const granted = String(data.scope || '').split(' ');
      if (!GOOGLE_SCOPES.every((s) => granted.includes(s))) throw new HttpError(400, 'Google didn’t give every permission. Sign in again and tick all the boxes on the permission screen.');
      email = (await getJson('https://gmail.googleapis.com/gmail/v1/users/me/profile', data.access_token)).emailAddress;
    } else {
      data = await tokenRequest(`${MS_AUTHORITY}/token`, { client_id: settings.microsoftClientId, grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: p.verifier, scope: MICROSOFT_SCOPES.join(' ') });
      const me = await getJson('https://graph.microsoft.com/v1.0/me?$select=displayName,mail,userPrincipalName', data.access_token);
      email = me.mail || me.userPrincipalName;
      name = me.displayName || '';
    }
    email = String(email || '').toLowerCase();
    if (!email) throw new HttpError(502, 'Couldn’t tell which mailbox you signed in to.');
    if (p.hint && email !== p.hint) throw new HttpError(400, `You signed in as ${email}, but this was for ${p.hint}. Try again and pick ${p.hint}.`);
    const id = `${p.provider}:${email}`;
    await store.update('accounts.json', [], (list) => {
      let a = list.find((x) => x.id === id);
      if (!a) {
        a = { id, provider: p.provider, email, name, addedAt: Date.now(), color: COLORS[list.length % COLORS.length], order: list.length };
        list.push(a);
      }
      a.refreshToken = data.refresh_token || a.refreshToken;
      a.status = 'ok';
      if (name) a.name = name;
    });
    tokens.set(id, { accessToken: data.access_token, expiresAt: Date.now() + (Number(data.expires_in || 3600) - 60) * 1000 });
    return email;
  }

  async function accessToken(id, { fresh = false } = {}) {
    const cached = tokens.get(id);
    if (!fresh && cached && cached.expiresAt > Date.now() + 30000) return cached;
    if (inflight.has(id)) return inflight.get(id);
    const run = (async () => {
      const a = (await loadAccounts()).find((x) => x.id === id);
      if (!a) throw new HttpError(404, 'Unknown mailbox');
      if (!a.refreshToken || a.status === 'needs-signin') throw new HttpError(401, `${a.email} needs you to sign in again.`, { needsSignIn: true });
      const settings = await loadSettings();
      requireSetup(settings, a.provider);
      let data;
      try {
        data = a.provider === 'google'
          ? await tokenRequest(GOOGLE_TOKEN, { client_id: settings.googleClientId, client_secret: settings.googleClientSecret, refresh_token: a.refreshToken, grant_type: 'refresh_token' })
          : await tokenRequest(`${MS_AUTHORITY}/token`, { client_id: settings.microsoftClientId, refresh_token: a.refreshToken, grant_type: 'refresh_token', scope: MICROSOFT_SCOPES.join(' ') });
      } catch (e) {
        if (e.permanent) {
          await store.update('accounts.json', [], (list) => { const x = list.find((y) => y.id === id); if (x) x.status = 'needs-signin'; });
          throw new HttpError(401, `${a.email} needs you to sign in again.`, { needsSignIn: true });
        }
        throw e;
      }
      if (data.refresh_token && data.refresh_token !== a.refreshToken) {
        await store.update('accounts.json', [], (list) => { const x = list.find((y) => y.id === id); if (x) x.refreshToken = data.refresh_token; });
      }
      const t = { accessToken: data.access_token, expiresAt: Date.now() + (Number(data.expires_in || 3600) - 60) * 1000 };
      tokens.set(id, t);
      return t;
    })();
    inflight.set(id, run);
    try { return await run; } finally { inflight.delete(id); }
  }

  async function localVersion() {
    try { return JSON.parse(await fsp.readFile(path.join(appDir, 'version.json'), 'utf8')); } catch { return { version: '0.0.0' }; }
  }

  async function fetchRemote(rel) {
    let res;
    try { res = await fetchImpl(`${repoRaw}/${rel}?t=${Date.now()}`, { headers: { 'Cache-Control': 'no-cache' } }); } catch { throw new HttpError(502, 'Couldn’t reach GitHub. Are you online?'); }
    if (!res.ok) throw new HttpError(502, `GitHub answered ${res.status} for ${rel}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async function checkUpdate() {
    const local = await localVersion();
    const remote = JSON.parse((await fetchRemote('version.json')).toString('utf8'));
    return { current: local.version, latest: remote.version, date: remote.date, changes: remote.changes || [], available: newer(remote.version, local.version) };
  }

  // Downloads every file of the newest version first, then swaps them in.
  async function applyUpdate() {
    const list = JSON.parse((await fetchRemote('files.json')).toString('utf8'));
    if (!Array.isArray(list) || !list.includes('server.mjs') || !list.includes('index.html') || !list.every(safeAppPath)) throw new HttpError(502, 'The update’s file list looks wrong, so nothing was changed.');
    const files = new Map();
    for (const rel of list) files.set(rel, await fetchRemote(rel));
    let old = [];
    try { old = JSON.parse(await fsp.readFile(path.join(appDir, 'files.json'), 'utf8')); } catch { /* first update */ }
    for (const [rel, buf] of files) {
      const dest = path.join(appDir, ...rel.split('/'));
      // Leave unchanged files alone (the launcher is running while this happens).
      try { if ((await fsp.readFile(dest)).equals(buf)) continue; } catch { /* new file */ }
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.writeFile(`${dest}.new`, buf);
      await fsp.rename(`${dest}.new`, dest);
    }
    for (const rel of Array.isArray(old) ? old : []) {
      if (safeAppPath(rel) && !files.has(rel)) await fsp.rm(path.join(appDir, ...rel.split('/')), { force: true }).catch(() => {});
    }
    return { installed: files.size };
  }

  // ---------- request handling ----------
  const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
  const PUBLIC = /^\/(index\.html|version\.json|css\/[\w.-]+\.css|js\/[\w/.-]+\.js|icons\/[\w.-]+\.(svg|png|ico))$/;
  const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https: http:; font-src 'self' data: https:; connect-src 'self' https://gmail.googleapis.com https://graph.microsoft.com; frame-src 'self' about:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
  const BASE_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' };

  function send(res, status, body, type = 'application/json; charset=utf-8', headers = {}) {
    const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    res.writeHead(status, { ...BASE_HEADERS, 'Content-Type': type, ...headers });
    res.end(payload);
  }
  const redirect = (res, to) => { res.writeHead(302, { ...BASE_HEADERS, Location: to }); res.end(); };

  async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const c of req) { size += c.length; if (size > 5 * 1024 * 1024) throw new HttpError(413, 'Too much data'); chunks.push(c); }
    if (!size) return {};
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'Bad JSON'); }
  }

  const okHost = (req) => [`localhost:${port}`, `127.0.0.1:${port}`].includes(String(req.headers.host || '').toLowerCase());
  const okApiCaller = (req) => req.headers['x-inbox'] === '1' && (!req.headers.origin || [origin, `http://127.0.0.1:${port}`].includes(req.headers.origin));

  async function api(req, res, url) {
    const parts = url.pathname.split('/').filter(Boolean).slice(1); // after "api"
    const [what, arg] = parts;
    const m = req.method;
    if (what === 'ping') return { app: 'unified-inbox' };
    if (what === 'status' && m === 'GET') {
      const s = await loadSettings();
      return { version: (await localVersion()).version, dataDir, setup: { google: !!(s.googleClientId && s.googleClientSecret), microsoft: !!s.microsoftClientId }, accounts: (await loadAccounts()).map(publicAccount), restartable: !!onRestart };
    }
    if (what === 'settings') {
      if (m === 'GET') { const s = await loadSettings(); return { googleClientId: s.googleClientId || '', hasGoogleSecret: !!s.googleClientSecret, microsoftClientId: s.microsoftClientId || '', redirectUri }; }
      if (m === 'POST') {
        const b = await readBody(req);
        await store.update('settings.json', {}, (s) => {
          for (const k of ['googleClientId', 'microsoftClientId']) if (typeof b[k] === 'string') s[k] = b[k].trim();
          if (typeof b.googleClientSecret === 'string' && b.googleClientSecret.trim()) s.googleClientSecret = b.googleClientSecret.trim();
        });
        tokens.clear();
        return { ok: true };
      }
    }
    if (what === 'accounts' && arg) {
      const id = decodeURIComponent(arg);
      if (m === 'PATCH') {
        const b = await readBody(req);
        let out;
        await store.update('accounts.json', [], (list) => {
          const a = list.find((x) => x.id === id);
          if (!a) throw new HttpError(404, 'Unknown mailbox');
          if (typeof b.color === 'string' && /^#[0-9a-f]{6}$/i.test(b.color)) a.color = b.color;
          if (Number.isInteger(b.order)) a.order = b.order;
          if (Array.isArray(b.pushedFilterIds)) a.pushedFilterIds = b.pushedFilterIds.map(String).slice(0, 500);
          out = publicAccount(a);
        });
        return out;
      }
      if (m === 'DELETE') {
        await store.update('accounts.json', [], (list) => { const i = list.findIndex((x) => x.id === id); if (i >= 0) list.splice(i, 1); });
        tokens.delete(id);
        return { ok: true };
      }
    }
    if (what === 'token' && m === 'POST') {
      const b = await readBody(req);
      return accessToken(String(b.id || ''), { fresh: b.fresh === true });
    }
    if (what === 'kv' && arg && /^[\w-]{1,64}$/.test(arg)) {
      if (m === 'GET') return { value: await store.readJson(`kv/${arg}.json`, null) };
      if (m === 'PUT') { const b = await readBody(req); await store.writeJson(`kv/${arg}.json`, b.value ?? null); return { ok: true }; }
    }
    if (what === 'log' && arg && /^[\w-]{1,64}$/.test(arg)) {
      const name = `cleanup-logs/${arg}.jsonl`;
      if (m === 'GET') return { entries: await store.readLines(name) };
      if (m === 'POST') { const b = await readBody(req); if (!Array.isArray(b.entries)) throw new HttpError(400, 'entries missing'); await store.appendLines(name, b.entries); return { ok: true }; }
      if (m === 'DELETE') { await store.remove(name); return { ok: true }; }
    }
    if (what === 'update') {
      if (m === 'GET') return checkUpdate();
      if (m === 'POST') {
        const r = await applyUpdate();
        if (onRestart) setTimeout(onRestart, 300);
        return { ...r, restarting: !!onRestart };
      }
    }
    throw new HttpError(404, 'Not found');
  }

  async function handle(req, res) {
    if (!okHost(req)) return send(res, 403, 'Open the app at http://localhost:' + port, 'text/plain; charset=utf-8');
    const url = new URL(req.url, origin);
    try {
      if (url.pathname.startsWith('/api/')) {
        if (!okApiCaller(req)) return send(res, 403, { error: 'Not allowed' });
        return send(res, 200, await api(req, res, url));
      }
      if (url.pathname === '/auth/start' && req.method === 'GET') {
        try { return redirect(res, await signInUrl(url.searchParams.get('provider'), url.searchParams.get('hint'))); } catch (e) { return redirect(res, `/#/settings?signin_error=${encodeURIComponent(e.message)}`); }
      }
      if (url.pathname === '/auth/callback' && req.method === 'GET') {
        try { const email = await finishSignIn(url.searchParams); return redirect(res, `/#/settings?added=${encodeURIComponent(email)}`); } catch (e) { return redirect(res, `/#/settings?signin_error=${encodeURIComponent(e.message)}`); }
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed', 'text/plain; charset=utf-8');
      const rel = url.pathname === '/' ? '/index.html' : url.pathname;
      if (!PUBLIC.test(rel) || rel.includes('..')) return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
      const file = path.join(appDir, ...rel.slice(1).split('/'));
      let buf;
      try { buf = await fsp.readFile(file); } catch { return send(res, 404, 'Not found', 'text/plain; charset=utf-8'); }
      const type = TYPES[path.extname(file)] || 'application/octet-stream';
      return send(res, 200, buf, type, type.startsWith('text/html') ? { 'Content-Security-Policy': CSP, 'X-Frame-Options': 'DENY' } : {});
    } catch (e) {
      const status = e.status || 500;
      if (status >= 500 && !e.status) console.error(e);
      return send(res, status, { error: e.message, needsSignIn: !!e.needsSignIn });
    }
  }

  const handler = (req, res) => { handle(req, res).catch((e) => { console.error(e); try { send(res, 500, { error: 'Something went wrong' }); } catch { /* already sent */ } }); };
  const server = http.createServer(handler);
  return { server, handler, store, origin, redirectUri, signInUrl, finishSignIn, accessToken, pending, tokens };
}

// ---------- starting from the launcher ----------
function openBrowser(url) {
  if (process.platform === 'win32') {
    const edge = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles].filter(Boolean).map((p) => path.join(p, 'Microsoft', 'Edge', 'Application', 'msedge.exe')).find((p) => fs.existsSync(p));
    if (edge) spawn(edge, [`--app=${url}`], { detached: true, stdio: 'ignore' }).unref();
    else spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
}

async function main() {
  const port = Number(process.env.UNIFIED_INBOX_PORT) || DEFAULT_PORT;
  const open = process.argv.includes('--open');
  const fromLauncher = process.env.UNIFIED_INBOX_LAUNCHER === '1';
  const { server, handler, origin } = createApp({ port, onRestart: fromLauncher ? () => process.exit(RESTART_CODE) : null });
  server.on('error', async (e) => {
    if (e.code !== 'EADDRINUSE') { console.error(e); process.exit(1); }
    // Already running: just bring up the window.
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/ping`, { headers: { 'X-Inbox': '1' } });
      if ((await r.json()).app === 'unified-inbox') { console.log('Unified Inbox is already running.'); if (open) openBrowser(origin); process.exit(0); }
    } catch { /* something else has the port */ }
    console.error(`Port ${port} is taken by another program. Close it, or set UNIFIED_INBOX_PORT.`);
    process.exit(1);
  });
  // Only this PC can connect: listen on the loopback addresses, never the network.
  const v6 = http.createServer(handler);
  v6.on('error', () => {}); // no IPv6 here; 127.0.0.1 is enough
  server.listen(port, '127.0.0.1', () => {
    v6.listen(port, '::1');
    console.log(`Unified Inbox is running at ${origin}`);
    console.log(`Your sign-ins and cleanup history are kept in ${defaultDataDir()}`);
    console.log('Leave this window open while you use the app. Close it to stop the app.');
    if (open) openBrowser(origin);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
