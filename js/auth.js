// Sign-in for Google (token flow) and Microsoft (authorization code + PKCE).
// A single popup window walks through every account that needs signing in,
// so one tap reconnects all of them. Results come back on a BroadcastChannel
// (Google's pages cut the popup's link to this window, so postMessage can't be used).

export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.settings.basic',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/contacts.readonly',
  'https://www.googleapis.com/auth/contacts.other.readonly',
];

export const MICROSOFT_SCOPES = [
  'offline_access', 'User.Read', 'Mail.ReadWrite', 'Mail.Send', 'MailboxSettings.ReadWrite',
  'Calendars.ReadWrite', 'Contacts.Read', 'People.Read',
];

const MS_AUTHORITY = 'https://login.microsoftonline.com/consumers/oauth2/v2.0';
const QUEUE_KEY = 'ui-auth-queue';
const CHANNEL = 'ui-oauth';

export class NeedsSignIn extends Error {
  constructor(account, message) {
    super(message || `${account?.email || 'This mailbox'} needs to be reconnected.`);
    this.name = 'NeedsSignIn';
    this.account = account;
  }
}

export function redirectUri() {
  const base = location.href.split('#')[0].split('?')[0].replace(/[^/]*$/, '');
  return `${base}auth.html`;
}

function randomString(len = 32) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function pkcePair() {
  const verifier = randomString(48);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const challenge = btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return { verifier, challenge };
}

// Build one sign-in step. kind: 'google' | 'microsoft'. silent = prompt=none.
// With a token helper, Google uses the code flow so it can hand out a refresh token.
export async function buildStep(kind, { clientId, loginHint, silent, helper }) {
  const state = randomString(16);
  if (kind === 'google' && helper) {
    const { verifier, challenge } = await pkcePair();
    const p = new URLSearchParams({
      client_id: clientId, redirect_uri: redirectUri(), response_type: 'code', scope: GOOGLE_SCOPES.join(' '),
      state, access_type: 'offline', include_granted_scopes: 'true', code_challenge: challenge, code_challenge_method: 'S256',
      prompt: silent ? 'none' : 'consent select_account',
    });
    if (loginHint) p.set('login_hint', loginHint);
    return { kind, state, verifier, helper: true, url: `https://accounts.google.com/o/oauth2/v2/auth?${p}` };
  }
  if (kind === 'google') {
    const p = new URLSearchParams({
      client_id: clientId, redirect_uri: redirectUri(), response_type: 'token', scope: GOOGLE_SCOPES.join(' '),
      state, include_granted_scopes: 'true', prompt: silent ? 'none' : 'consent select_account',
    });
    if (loginHint) p.set('login_hint', loginHint);
    return { kind, state, url: `https://accounts.google.com/o/oauth2/v2/auth?${p}` };
  }
  const { verifier, challenge } = await pkcePair();
  const p = new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri(), response_type: 'code', response_mode: 'query',
    scope: MICROSOFT_SCOPES.join(' '), state, code_challenge: challenge, code_challenge_method: 'S256',
    prompt: silent ? 'none' : 'select_account',
  });
  if (loginHint) p.set('login_hint', loginHint);
  return { kind, state, verifier, helper: !!helper, url: `${MS_AUTHORITY}/authorize?${p}` };
}

// ----- token helper (Cloudflare Worker, see token-helper/) -----
async function helperCall(helperUrl, path, body) {
  let res;
  try {
    res = await fetch(`${helperUrl.replace(/\/+$/, '')}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch { throw new Error('Couldn’t reach the token helper. Check its address in Settings.'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error_description || data.error || `Token helper error (${res.status})`);
  return data;
}

function helperToken(data, previousRefresh) {
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || previousRefresh,
    expiresAt: Date.now() + (Number(data.expires_in || 3600) - 60) * 1000,
    viaHelper: true,
  };
}

export async function helperExchange(helperUrl, kind, step, params) {
  const data = await helperCall(helperUrl, `/${kind}/token`, { code: params.code, code_verifier: step.verifier, redirect_uri: redirectUri() });
  return helperToken(data);
}

export async function helperRefresh(helperUrl, kind, refreshToken) {
  const data = await helperCall(helperUrl, `/${kind}/refresh`, { refresh_token: refreshToken });
  return helperToken(data, refreshToken);
}

export async function helperHealth(helperUrl) {
  const res = await fetch(`${helperUrl.replace(/\/+$/, '')}/health`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  return res.json();
}

// Must be called straight from a click (browsers block popups otherwise).
// steps: from buildStep. Resolves to [{ step, params | error }] in order.
export function runSteps(steps, { timeoutMs = 180000 } = {}) {
  if (!steps.length) return Promise.resolve([]);
  localStorage.setItem(QUEUE_KEY, JSON.stringify(steps.slice(1).map((s) => s.url)));
  const win = window.open(steps[0].url, 'ui-auth', 'width=520,height=700');
  if (!win) {
    localStorage.removeItem(QUEUE_KEY);
    return Promise.reject(new Error('Your browser blocked the sign-in window. Allow pop-ups for this site and try again.'));
  }
  return new Promise((resolve) => {
    const results = new Map();
    const channel = new BroadcastChannel(CHANNEL);
    const finish = () => {
      channel.close();
      window.removeEventListener('storage', onStorage);
      clearTimeout(timer);
      localStorage.removeItem(QUEUE_KEY);
      resolve(steps.map((s) => ({ step: s, ...(results.get(s.state) || { error: 'Sign-in was not completed.' }) })));
    };
    const onResult = (params) => {
      const step = steps.find((s) => s.state === params.state);
      if (!step || results.has(step.state)) return;
      results.set(step.state, params.error ? { error: params.error_description || params.error } : { params });
      if (results.size === steps.length) finish();
    };
    channel.onmessage = (e) => { if (e.data?.type === 'result') onResult(e.data.params); };
    // Fallback for browsers that put the popup in a separate storage partition.
    const onStorage = (e) => { if (e.key === 'ui-auth-result' && e.newValue) { try { onResult(JSON.parse(e.newValue)); } catch { /* ignore */ } } };
    window.addEventListener('storage', onStorage);
    const timer = setTimeout(finish, timeoutMs);
  });
}

// Google: params -> token
export function googleTokenFromParams(params) {
  return { accessToken: params.access_token, expiresAt: Date.now() + (Number(params.expires_in || 3600) - 60) * 1000, scope: params.scope };
}

// Microsoft: exchange the code for tokens.
export async function microsoftExchangeCode(clientId, step, params) {
  const body = new URLSearchParams({
    client_id: clientId, grant_type: 'authorization_code', code: params.code, redirect_uri: redirectUri(),
    code_verifier: step.verifier, scope: MICROSOFT_SCOPES.join(' '),
  });
  return microsoftTokenRequest(body);
}

export async function microsoftRefresh(clientId, refreshToken) {
  const body = new URLSearchParams({ client_id: clientId, grant_type: 'refresh_token', refresh_token: refreshToken, scope: MICROSOFT_SCOPES.join(' ') });
  return microsoftTokenRequest(body);
}

async function microsoftTokenRequest(body) {
  const res = await fetch(`${MS_AUTHORITY}/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error_description || data.error || `Microsoft sign-in failed (${res.status})`);
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + (Number(data.expires_in || 3600) - 60) * 1000,
  };
}
