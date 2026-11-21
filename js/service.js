// App state and everything that talks to the mailboxes. The UI only calls this.
import * as store from './store.js';
import { api } from './api.js';
import { accessToken, NeedsSignIn } from './auth.js';
import { GmailAdapter } from './providers/gmail.js';
import { GraphAdapter } from './providers/graph.js';
import { pool } from './providers/http.js';
import { DEFAULT_RULES } from './core/default-rules.js';
import { normalizeRules, setSenderFolder } from './core/rules.js';
import { planCleanup, runCleanup, undoCleanup, excludeFromPlan, reassignInPlan, bucketForFolder, keysFromSender, sinceForRange } from './core/cleanup.js';

const listeners = new Set();
export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit(event, data) { for (const fn of listeners) { try { fn(event, data); } catch (e) { console.error(e); } } }

export const state = {
  prefs: { remoteImages: false },
  setup: { google: false, microsoft: false },
  dataDir: '',
  accounts: [],
  rules: [],
};

const adapters = new Map();

// ---------- startup ----------
export async function init() {
  await loadStatus();
  const [prefs, rules] = await Promise.all([store.kv.get('prefs'), store.kv.get('rules')]);
  state.prefs = { ...state.prefs, ...(prefs || {}) };
  state.rules = rules ? normalizeRules(rules) : DEFAULT_RULES;
}

export async function loadStatus() {
  const s = await api('status');
  state.setup = s.setup;
  state.dataDir = s.dataDir;
  state.restartable = s.restartable;
  state.accounts = s.accounts.sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).map((a) => ({ ...a, status: a.signedIn ? 'ok' : 'needs-signin' }));
  for (const id of [...adapters.keys()]) if (!state.accounts.some((a) => a.id === id)) adapters.delete(id);
  emit('accounts');
}

export async function savePrefs(patch) {
  state.prefs = { ...state.prefs, ...patch };
  await store.kv.set('prefs', state.prefs);
}

export const getSignInSettings = () => api('settings');
export const saveSignInSettings = (s) => api('settings', { method: 'POST', body: s }).then(loadStatus);

// ---------- mailboxes ----------
function ctxFor(account) {
  return {
    account,
    getToken: async (fresh) => {
      try { return (await accessToken(account, fresh)).accessToken; } catch (e) { if (e instanceof NeedsSignIn) markNeedsSignIn(account); throw e; }
    },
    onUnauthorized: () => markNeedsSignIn(account),
    saveAccount: (a) => api(`accounts/${encodeURIComponent(a.id)}`, { method: 'PATCH', body: { pushedFilterIds: a.pushedFilterIds || [] } }),
  };
}

export function adapterFor(accountOrId) {
  const account = typeof accountOrId === 'string' ? state.accounts.find((a) => a.id === accountOrId) : accountOrId;
  if (!account) throw new Error('Unknown mailbox');
  if (!adapters.has(account.id)) {
    const Ctor = account.provider === 'google' ? GmailAdapter : GraphAdapter;
    adapters.set(account.id, new Ctor(account, ctxFor(account)));
  }
  return adapters.get(account.id);
}

function markNeedsSignIn(account) {
  if (account.status === 'needs-signin') return;
  account.status = 'needs-signin';
  emit('accounts');
}

export const accountsNeedingSignIn = () => state.accounts.filter((a) => a.status === 'needs-signin');

// Sign-in opens in your normal browser; the app watches for it to finish.
export const startSignIn = (provider, hint = '') => api('signin', { method: 'POST', body: { provider, hint } });
export const signInResult = (state) => api(`signin/${encodeURIComponent(state)}`);

// After coming back from a sign-in: make sure the folders exist.
export async function afterSignIn(email) {
  await loadStatus();
  const a = state.accounts.find((x) => x.email === email);
  if (a) { adapters.delete(a.id); await adapterFor(a).ensureFolders().catch((e) => console.warn('ensureFolders', e)); }
  return a;
}

export async function removeAccount(id) {
  await api(`accounts/${encodeURIComponent(id)}`, { method: 'DELETE' });
  await loadStatus();
}

export async function updateAccount(id, patch) {
  const a = await api(`accounts/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch });
  Object.assign(state.accounts.find((x) => x.id === id) || {}, { color: a.color, order: a.order });
  emit('accounts');
}

// ---------- rules ----------
export async function saveRules(rules) {
  state.rules = normalizeRules(rules);
  await store.kv.set('rules', state.rules);
  emit('rules');
}

// "Always put mail from this sender in <folder>"
export async function fileSenderAlways(address, folderKey) {
  await saveRules(setSenderFolder(state.rules, address, folderKey));
}

export async function pushRulesEverywhere(onProgress) {
  const report = [];
  for (const a of state.accounts) {
    onProgress?.(a);
    try {
      const ad = adapterFor(a);
      await ad.ensureFolders();
      const r = await ad.pushRules(state.rules.filter((x) => x.mailboxes === 'all' || x.mailboxes.includes(a.email)));
      report.push({ account: a, ...r });
    } catch (e) { report.push({ account: a, error: e.message, created: 0, skipped: [] }); }
  }
  return report;
}

export const readRulesFrom = (accountId) => adapterFor(accountId).readProviderRules();

// ---------- mail ----------
const accountsFor = (filter = 'all') => state.accounts.filter((a) => filter === 'all' || a.id === filter);

// Load a folder across mailboxes. Returns { messages, errors, cursors }.
export async function loadView(view, accountFilter = 'all', { cached = false } = {}) {
  const list = accountsFor(accountFilter);
  if (cached) {
    const parts = await Promise.all(list.map((a) => store.messages.forView(a.id, view)));
    return { messages: parts.flat().sort((x, y) => y.date - x.date), errors: [], cursors: {} };
  }
  const errors = [];
  const cursors = {};
  const parts = await pool(list, 5, async (a) => {
    try {
      const { messages, nextPageToken } = await adapterFor(a).list(view);
      cursors[a.id] = nextPageToken;
      await store.messages.clearView(a.id, view);
      await store.messages.putMany(messages);
      return messages;
    } catch (e) {
      errors.push({ account: a, error: e });
      return store.messages.forView(a.id, view);
    }
  });
  return { messages: parts.flat().sort((x, y) => y.date - x.date), errors, cursors };
}

export async function loadMore(view, cursors) {
  const out = [];
  const next = {};
  await pool(Object.entries(cursors).filter(([, c]) => c), 5, async ([accountId, cursor]) => {
    try {
      const { messages, nextPageToken } = await adapterFor(accountId).list(view, { pageToken: cursor });
      next[accountId] = nextPageToken;
      await store.messages.putMany(messages);
      out.push(...messages);
    } catch { next[accountId] = null; }
  });
  return { messages: out.sort((a, b) => b.date - a.date), cursors: next };
}

export async function searchAll(q, accountFilter = 'all') {
  const errors = [];
  const parts = await pool(accountsFor(accountFilter), 5, async (a) => {
    try { return await adapterFor(a).search(q); } catch (e) { errors.push({ account: a, error: e }); return []; }
  });
  return { messages: parts.flat().sort((x, y) => y.date - x.date), errors };
}

// Reading a message doesn't mark it read unless you ask (markRead: true).
export async function openMessage(msg, { markRead = true } = {}) {
  const ad = adapterFor(msg.accountId);
  const full = await ad.getFull(msg);
  if (markRead && full.unread) { ad.markRead(msg, true).catch(() => {}); full.unread = false; }
  return full;
}

export async function act(action, msg, arg) {
  const ad = adapterFor(msg.accountId);
  switch (action) {
    case 'archive': await ad.archive(msg); break;
    case 'trash': await ad.trash(msg); break;
    case 'spam': await ad.markSpam(msg); break;
    case 'notSpam': await ad.notSpam(msg); break;
    case 'move': await ad.moveTo(msg, arg); break;
    case 'read': await ad.markRead(msg, arg !== false); msg.unread = arg === false; await store.messages.putMany([msg]); return msg;
    default: throw new Error(`Unknown action ${action}`);
  }
  await store.messages.removeMany([msg.key]);
  return null;
}

export async function downloadAttachment(msg, att) {
  const blob = await adapterFor(msg.accountId).getAttachment(msg, att);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = att.name || 'attachment';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

// ---------- cleanup ----------
// opts: { accountIds, range, trashPromotions }
export async function previewCleanup(opts, onProgress) {
  const since = sinceForRange(opts.range);
  const inputs = [];
  for (const a of state.accounts.filter((x) => opts.accountIds.includes(x.id))) {
    onProgress?.({ account: a, found: 0, loaded: 0 });
    const messages = await adapterFor(a).listInboxSince(since, (p) => onProgress?.({ account: a, ...p }));
    inputs.push({ account: a, messages });
  }
  return planCleanup(inputs, state.rules, { trashPromotions: !!opts.trashPromotions, range: opts.range });
}

export { excludeFromPlan, reassignInPlan, bucketForFolder, keysFromSender };

export async function runCleanupPlan(plan, onProgress, isCancelled) {
  for (const a of plan.accounts) await adapterFor(a.accountId).ensureFolders();
  const res = await runCleanup(plan, { adapterFor: (id) => adapterFor(id), log: (e) => store.cleanupLog.add(plan.runId, e), onProgress, isCancelled });
  const runs = (await store.kv.get('cleanupRuns')) || [];
  const counts = { ...plan.totals }; delete counts.stay;
  runs.unshift({ runId: plan.runId, at: Date.now(), counts, done: res.done, undone: false });
  await store.kv.set('cleanupRuns', runs.slice(0, 50));
  for (const a of plan.accounts) await store.messages.clearView(a.accountId, 'inbox');
  return res;
}

export async function cleanupRuns() { return (await store.kv.get('cleanupRuns')) || []; }

export async function undoCleanupRun(runId, onProgress) {
  const entries = await store.cleanupLog.forRun(runId);
  const res = await undoCleanup(entries, { adapterFor: (id) => adapterFor(id), onProgress });
  const runs = (await store.kv.get('cleanupRuns')) || [];
  const r = runs.find((x) => x.runId === runId);
  if (r) r.undone = true;
  await store.kv.set('cleanupRuns', runs);
  if (!res.errors.length) await store.cleanupLog.deleteRun(runId);
  return res;
}

export async function clearMailCache() { await store.messages.clearAll(); }
