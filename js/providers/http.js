import { NeedsSignIn } from '../auth.js';

export class ApiError extends Error {
  constructor(message, status, data) { super(message); this.name = 'ApiError'; this.status = status; this.data = data; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// fetch with the account's token, retries on rate limits and brief outages.
export async function apiFetch(ctx, url, { method = 'GET', body, headers = {}, json = true, retries = 4 } = {}) {
  let attempt = 0;
  for (;;) {
    const token = await ctx.getToken();
    const h = { Authorization: `Bearer ${token}`, ...headers };
    let payload = body;
    if (body && typeof body === 'object' && !(body instanceof Blob) && !(body instanceof FormData) && typeof body !== 'string') {
      h['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch(url, { method, headers: h, body: payload });
    } catch (e) {
      if (attempt < retries) { attempt += 1; await sleep(500 * 2 ** attempt); continue; }
      throw new ApiError('No connection. Check your internet and try again.', 0);
    }
    if (res.status === 401) {
      ctx.onUnauthorized?.();
      throw new NeedsSignIn(ctx.account);
    }
    if ([429, 500, 502, 503, 504].includes(res.status) && attempt < retries) {
      attempt += 1;
      const ra = Number(res.headers.get('Retry-After'));
      await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 600 * 2 ** attempt);
      continue;
    }
    if (!res.ok) {
      let data = null;
      try { data = await res.json(); } catch { /* not json */ }
      const msg = data?.error?.message || data?.error_description || (typeof data?.error === 'string' ? data.error : '') || `Request failed (${res.status})`;
      throw new ApiError(msg, res.status, data);
    }
    if (res.status === 204 || res.status === 202) return null;
    if (!json) return res;
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }
}

// Run fn over items with at most n in flight. Returns results in order.
export async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

export function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}
