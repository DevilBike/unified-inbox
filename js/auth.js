// Signing in happens in the local app (server.mjs): it sends you to Google or Microsoft
// and keeps the long-lived sign-in on this PC. The screens only ever get short-lived
// access tokens, which the app renews by itself.
import { api } from './api.js';

export class NeedsSignIn extends Error {
  constructor(account, message) {
    super(message || `${account?.email || 'This mailbox'} needs you to sign in again.`);
    this.name = 'NeedsSignIn';
    this.account = account;
  }
}

export function signInUrl(provider, hint = '') {
  return `/auth/start?${new URLSearchParams({ provider, ...(hint ? { hint } : {}) })}`;
}

export async function accessToken(account, fresh = false) {
  try {
    return await api('token', { method: 'POST', body: { id: account.id, fresh } });
  } catch (e) {
    if (e.needsSignIn) throw new NeedsSignIn(account, e.message);
    throw e;
  }
}
