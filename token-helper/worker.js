// Unified Inbox token helper (Cloudflare Worker).
//
// Its only job: swap sign-in codes for long-lived refresh tokens and renew
// access tokens, using your apps' client secrets (which can't live in a public
// web page). It stores nothing; tokens pass through and go straight back to
// your browser.
//
// Settings (Cloudflare dashboard → your worker → Settings → Variables and Secrets):
//   GOOGLE_CLIENT_ID       (text)    your Google client ID
//   GOOGLE_CLIENT_SECRET   (secret)  your Google client secret
//   MS_CLIENT_ID           (text)    your Microsoft application (client) ID
//   MS_CLIENT_SECRET       (secret)  your Microsoft client secret value
//   ALLOWED_ORIGINS        (text)    https://devilbike.github.io,http://localhost:8080

const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const MS_TOKEN = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token';
const MS_SCOPES = 'offline_access User.Read Mail.ReadWrite Mail.Send MailboxSettings.ReadWrite Calendars.ReadWrite Contacts.Read People.Read';

function cors(origin, env) {
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!allowed.includes(origin)) return null;
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function reply(status, data, headers) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });
}

// Only allow sign-in return pages on the allowed sites.
function redirectAllowed(uri, env) {
  try {
    const u = new URL(uri);
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim());
    return allowed.includes(u.origin) && u.pathname.endsWith('/auth.html');
  } catch { return false; }
}

async function post(url, params) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

function shape(data) {
  return { access_token: data.access_token, refresh_token: data.refresh_token, expires_in: data.expires_in, scope: data.scope };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const headers = cors(origin, env);
    if (!headers) return reply(403, { error: 'origin_not_allowed' }, {});
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (request.method !== 'POST') return reply(405, { error: 'method_not_allowed' }, headers);

    const path = new URL(request.url).pathname.replace(/\/+$/, '');
    let body;
    try { body = await request.json(); } catch { return reply(400, { error: 'bad_json' }, headers); }

    let r;
    if (path === '/google/token') {
      if (!body.code || !redirectAllowed(body.redirect_uri, env)) return reply(400, { error: 'bad_request' }, headers);
      r = await post(GOOGLE_TOKEN, { grant_type: 'authorization_code', code: body.code, redirect_uri: body.redirect_uri, code_verifier: body.code_verifier || '', client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET });
    } else if (path === '/google/refresh') {
      if (!body.refresh_token) return reply(400, { error: 'bad_request' }, headers);
      r = await post(GOOGLE_TOKEN, { grant_type: 'refresh_token', refresh_token: body.refresh_token, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET });
    } else if (path === '/microsoft/token') {
      if (!body.code || !redirectAllowed(body.redirect_uri, env)) return reply(400, { error: 'bad_request' }, headers);
      r = await post(MS_TOKEN, { grant_type: 'authorization_code', code: body.code, redirect_uri: body.redirect_uri, code_verifier: body.code_verifier || '', client_id: env.MS_CLIENT_ID, client_secret: env.MS_CLIENT_SECRET, scope: MS_SCOPES });
    } else if (path === '/microsoft/refresh') {
      if (!body.refresh_token) return reply(400, { error: 'bad_request' }, headers);
      r = await post(MS_TOKEN, { grant_type: 'refresh_token', refresh_token: body.refresh_token, client_id: env.MS_CLIENT_ID, client_secret: env.MS_CLIENT_SECRET, scope: MS_SCOPES });
    } else if (path === '/health') {
      return reply(200, { ok: true, google: !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET), microsoft: !!(env.MS_CLIENT_ID && env.MS_CLIENT_SECRET) }, headers);
    } else {
      return reply(404, { error: 'not_found' }, headers);
    }
    if (!r.ok) return reply(r.status === 400 || r.status === 401 ? 400 : 502, { error: r.data.error || 'token_error', error_description: r.data.error_description || '' }, headers);
    return reply(200, shape(r.data), headers);
  },
};
