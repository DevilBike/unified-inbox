// Talks to the local app (server.mjs) running on this PC.
export class AppOffline extends Error {
  constructor() { super('The app has stopped. Start it again with “Start Unified Inbox”.'); this.name = 'AppOffline'; }
}

export async function api(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(`/api/${path}`, { method, headers: { 'X-Inbox': '1', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch { throw new AppOffline(); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || `Request failed (${res.status})`); e.status = res.status; e.needsSignIn = !!data.needsSignIn; throw e; }
  return data;
}
