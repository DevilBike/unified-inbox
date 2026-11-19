// App state and everything that talks to the mailboxes. The UI only calls this.
import * as store from './store.js';
import { CONFIG } from './config.js';
import { buildStep, runSteps, googleTokenFromParams, microsoftExchangeCode, microsoftRefresh, helperExchange, helperRefresh, NeedsSignIn } from './auth.js';
import { GmailAdapter } from './providers/gmail.js';
import { GraphAdapter } from './providers/graph.js';
import { pool } from './providers/http.js';
import { DEFAULT_RULES } from './core/default-rules.js';
import { normalizeRules, evaluate } from './core/rules.js';
import { planCleanup, runCleanup, undoCleanup, excludeFromPlan, sinceForRange } from './core/cleanup.js';
import { quoteForReply, htmlToText } from './core/mime.js';

const ACCOUNT_COLORS = ['#7AA2FF', '#F0A35E', '#4FC3B0', '#B794F6', '#E6E08A', '#F08FB2', '#8FD3F0'];

const listeners = new Set();
export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit(event, data) { for (const fn of listeners) { try { fn(event, data); } catch (e) { console.error(e); } } }

export const state = {
  settings: { googleClientId: '', microsoftClientId: '', tokenHelperUrl: '', sweep: true, remoteImages: false, autoReconnect: true, theme: 'dark' },
  accounts: [],
  rules: [],
};

const adapters = new Map();
const refreshing = new Map();

// ---------- startup ----------
export async function init() {
  const saved = (await store.kv.get('settings')) || {};
  state.settings = { ...state.settings, googleClientId: CONFIG.googleClientId, microsoftClientId: CONFIG.microsoftClientId, tokenHelperUrl: CONFIG.tokenHelperUrl || '', ...dropEmpty(saved) };
  state.accounts = (await store.accounts.all()).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const rules = await store.kv.get('rules');
  state.rules = rules ? normalizeRules(rules) : DEFAULT_RULES;
  emit('accounts');
}

function dropEmpty(o) { return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== '' && v != null)); }

export async function saveSettings(patch) {
  state.settings = { ...state.settings, ...patch };
  await store.kv.set('settings', state.settings);
  emit('settings');
}

// ---------- accounts and sign-in ----------
function ctxFor(account) {
  return {
    account,
    getToken: () => tokenFor(account),
    onUnauthorized: () => markNeedsSignIn(account),
    saveAccount: (a) => store.accounts.put(a),
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

async function markNeedsSignIn(account) {
  if (account.status === 'needs-signin') return;
  account.status = 'needs-signin';
  await store.accounts.put(account);
  emit('accounts');
}

export function helperUrl() { return (state.settings.tokenHelperUrl || '').trim(); }

async function tokenFor(account) {
  const t = account.token;
  if (t?.accessToken && t.expiresAt > Date.now()) return t.accessToken;
  const canRefresh = t?.refreshToken && (t.viaHelper ? helperUrl() : account.provider === 'microsoft');
  if (canRefresh) {
    if (!refreshing.has(account.id)) {
      const renew = t.viaHelper ? helperRefresh(helperUrl(), account.provider, t.refreshToken) : microsoftRefresh(state.settings.microsoftClientId, t.refreshToken);
      refreshing.set(account.id, renew
        .then(async (nt) => { account.token = nt; account.status = 'ok'; await store.accounts.put(account); emit('accounts'); return nt.accessToken; })
        .finally(() => refreshing.delete(account.id)));
    }
    try { return await refreshing.get(account.id); } catch { /* fall through */ }
  }
  await markNeedsSignIn(account);
  throw new NeedsSignIn(account);
}

// True when this mailbox renews its own sign-in in the background.
function selfRenewing(a) {
  return !!(a.token?.refreshToken && (a.token.viaHelper ? helperUrl() : a.provider === 'microsoft'));
}

export function accountsNeedingSignIn() {
  return state.accounts.filter((a) => a.status === 'needs-signin' || a.status === 'needs-password' || !a.token?.accessToken || (!selfRenewing(a) && a.provider === 'google' && a.token.expiresAt <= Date.now() + 60000));
}

// With a token helper set up, mailboxes that still need one more sign-in to stay signed in.
export function accountsToUpgrade() {
  if (!helperUrl()) return [];
  return state.accounts.filter((a) => !a.token?.viaHelper || !a.token?.refreshToken);
}

// Mailboxes that can be refreshed quietly on your next tap: expired or expiring within
// 5 minutes. Ones where a quiet refresh already failed wait for you to sign in.
export function autoReconnectCandidates() {
  const soon = Date.now() + 5 * 60000;
  return state.accounts.filter((a) => a.status !== 'needs-password' && (a.status === 'needs-signin' || !a.token?.accessToken
    || (!selfRenewing(a) && a.token.expiresAt <= soon)));
}

function requireClientId(kind) {
  const id = kind === 'google' ? state.settings.googleClientId : state.settings.microsoftClientId;
  if (!id) throw new Error(`Add your ${kind === 'google' ? 'Google' : 'Microsoft'} client ID in Settings first (see SETUP.md).`);
  return id;
}

async function finishStep(kind, step, params) {
  const clientId = requireClientId(kind);
  const token = step.helper ? await helperExchange(helperUrl(), kind, step, params)
    : kind === 'google' ? googleTokenFromParams(params) : await microsoftExchangeCode(clientId, step, params);
  const temp = { provider: kind, token, email: '' };
  const ctx = { account: temp, getToken: async () => token.accessToken };
  let email, name = '';
  if (kind === 'google') { const p = await GmailAdapter.profile(ctx); email = p.emailAddress.toLowerCase(); } else {
    const p = await GraphAdapter.profile(ctx); email = (p.mail || p.userPrincipalName || '').toLowerCase(); name = p.displayName || '';
  }
  return { email, name, token };
}

// Call from a click. Adds a new mailbox.
export async function addAccount(kind) {
  const clientId = requireClientId(kind);
  const step = await buildStep(kind, { clientId, silent: false, helper: helperUrl() });
  const [res] = await runSteps([step]);
  if (res.error) throw new Error(res.error);
  const { email, name, token } = await finishStep(kind, step, res.params);
  const id = `${kind}:${email}`;
  let account = state.accounts.find((a) => a.id === id);
  if (account) Object.assign(account, { token, status: 'ok', name: name || account.name });
  else {
    account = { id, provider: kind, email, name, token, status: 'ok', addedAt: Date.now(), color: ACCOUNT_COLORS[state.accounts.length % ACCOUNT_COLORS.length], signature: '', order: state.accounts.length };
    state.accounts.push(account);
  }
  await store.accounts.put(account);
  adapters.delete(id);
  emit('accounts');
  adapterFor(account).ensureFolders().catch((e) => console.warn('ensureFolders', e));
  return account;
}

// Call from a click. Reconnects every mailbox that needs it in one window.
// Silent first; any that need a password or consent are retried with the full screen.
export async function reconnect(list = accountsNeedingSignIn(), { interactive = false } = {}) {
  if (!list.length) return { ok: [], failed: [] };
  const steps = [];
  for (const a of list) {
    const clientId = requireClientId(a.provider);
    const s = await buildStep(a.provider, { clientId, loginHint: a.email, silent: !interactive, helper: helperUrl() });
    s.accountId = a.id;
    steps.push(s);
  }
  const results = await runSteps(steps);
  const ok = [], failed = [];
  for (const r of results) {
    const account = state.accounts.find((a) => a.id === r.step.accountId);
    if (r.error) {
      failed.push({ account, error: r.error });
      if (!interactive) { account.status = 'needs-password'; await store.accounts.put(account); }
      continue;
    }
    try {
      const { email, token } = await finishStep(account.provider, r.step, r.params);
      if (email !== account.email) { failed.push({ account, error: `Signed in as ${email} instead of ${account.email}.` }); continue; }
      if (!token.refreshToken && account.token?.refreshToken && account.token.viaHelper === token.viaHelper) token.refreshToken = account.token.refreshToken;
      account.token = token; account.status = 'ok';
      await store.accounts.put(account);
      ok.push(account);
    } catch (e) { failed.push({ account, error: e.message }); }
  }
  emit('accounts');
  return { ok, failed };
}

export async function removeAccount(id) {
  state.accounts = state.accounts.filter((a) => a.id !== id);
  adapters.delete(id);
  await store.accounts.remove(id);
  emit('accounts');
}

export async function updateAccount(id, patch) {
  const a = state.accounts.find((x) => x.id === id);
  Object.assign(a, patch);
  await store.accounts.put(a);
  emit('accounts');
}

// ---------- rules ----------
export async function saveRules(rules) {
  state.rules = normalizeRules(rules);
  await store.kv.set('rules', state.rules);
  emit('rules');
}

export async function pushRulesEverywhere(onProgress) {
  const report = [];
  for (const a of activeAccounts()) {
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

export async function readRulesFrom(accountId) {
  return adapterFor(accountId).readProviderRules();
}

// ---------- mail ----------
function activeAccounts(filter = 'all') {
  return state.accounts.filter((a) => filter === 'all' || a.id === filter);
}

// Load a view across mailboxes. Returns { messages, errors, cursors }.
export async function loadView(view, accountFilter = 'all', { cached = false } = {}) {
  const list = activeAccounts(accountFilter);
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
      let kept = messages;
      if (view === 'inbox' && state.settings.sweep) kept = await sweep(a, messages);
      await store.messages.clearView(a.id, view);
      await store.messages.putMany(kept);
      learnContacts(kept);
      return kept;
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

// Messages you put back in the Inbox yourself; the sweep leaves them alone.
async function pinned() { return new Set((await store.kv.get('pinnedInInbox')) || []); }
async function pin(msg) {
  const set = await pinned();
  set.add(msg.messageId || msg.id);
  await store.kv.set('pinnedInInbox', [...set].slice(-2000));
}

// Files new inbox mail that the provider's own rules didn't catch.
// Only touches mail that arrived after the mailbox was added (Cleanup handles older mail).
async function sweep(account, messages) {
  const keep = [];
  const moves = new Map();
  const skip = await pinned();
  const since = account.addedAt || 0;
  for (const m of messages) {
    const hit = m.date >= since && !skip.has(m.messageId || m.id) ? evaluate(m, state.rules, account.email) : null;
    if (hit) { if (!moves.has(hit.folder)) moves.set(hit.folder, []); moves.get(hit.folder).push(m); } else keep.push(m);
  }
  if (!moves.size) return messages;
  const ad = adapterFor(account);
  for (const [folder, list] of moves) {
    try { await ad.moveMany(list, folder); } catch (e) { console.warn('sweep failed', e); keep.push(...list); }
  }
  if (moves.size) emit('swept', { account, count: messages.length - keep.length });
  return keep.sort((a, b) => b.date - a.date);
}

export async function searchAll(q, accountFilter = 'all') {
  const errors = [];
  const parts = await pool(activeAccounts(accountFilter), 5, async (a) => {
    try { return await adapterFor(a).search(q); } catch (e) { errors.push({ account: a, error: e }); return []; }
  });
  return { messages: parts.flat().sort((x, y) => y.date - x.date), errors };
}

export async function openMessage(msg) {
  const ad = adapterFor(msg.accountId);
  const full = await ad.getFull(msg);
  if (full.unread) { ad.markRead(msg, true).catch(() => {}); full.unread = false; }
  if (ad.snoozeUntil) full.snoozedUntil = ad.snoozeUntil(full);
  return full;
}

async function forget(msg) { await store.messages.removeMany([msg.key]); }

export async function act(action, msg, arg) {
  const ad = adapterFor(msg.accountId);
  switch (action) {
    case 'archive': await ad.archive(msg); break;
    case 'trash': await ad.trash(msg); break;
    case 'spam': await ad.markSpam(msg); break;
    case 'notSpam': await pin(msg); await ad.notSpam(msg); break;
    case 'move': if (arg === 'inbox') await pin(msg); await ad.moveTo(msg, arg); break;
    case 'read': await ad.markRead(msg, arg !== false); msg.unread = arg === false; await store.messages.putMany([msg]); return msg;
    case 'flag': await ad.setFlag(msg, !!arg); msg.flagged = !!arg; await store.messages.putMany([msg]); return msg;
    case 'snooze': await ad.ensureFolders(); await ad.snooze(msg, arg); break;
    case 'unsnooze': await pin(msg); await ad.unsnooze(msg); break;
    default: throw new Error(`Unknown action ${action}`);
  }
  await forget(msg);
  return null;
}

export async function processSnoozesEverywhere() {
  let n = 0;
  await pool(activeAccounts(), 5, async (a) => { try { n += await adapterFor(a).processSnoozes(); } catch { /* try next time */ } });
  return n;
}

export async function downloadAttachment(msg, att) {
  const blob = await adapterFor(msg.accountId).getAttachment(msg, att);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = att.name || 'attachment';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

// ---------- compose ----------
// draft: { accountId, mode, original (full message), to, cc, bcc, subject, text, attachments, draftId }
function withSignature(account, text) {
  return account.signature ? `${text}\n\n-- \n${account.signature}` : text;
}

async function prepare(draft) {
  const account = state.accounts.find((a) => a.id === draft.accountId);
  const d = { ...draft, text: withSignature(account, draft.text || '') };
  if (account.provider === 'google' && draft.original && draft.mode !== 'new') {
    const o = draft.original;
    const quoteSource = o.text || htmlToText(o.html);
    if (draft.mode === 'forward') {
      d.text += `\n\n---------- Forwarded message ----------\nFrom: ${o.from?.name || ''} <${o.from?.address}>\nDate: ${new Date(o.date).toLocaleString()}\nSubject: ${o.subject}\n\n${quoteSource}`;
      // Bring the original attachments along (up to 20 MB).
      let total = 0;
      const extra = [];
      for (const att of o.attachments || []) {
        total += att.size || 0;
        if (total > 20 * 1024 * 1024) break;
        const blob = await adapterFor(account).getAttachment(o, att);
        extra.push({ name: att.name, mimeType: att.mimeType, base64: await blobToBase64(blob) });
      }
      d.attachments = [...(d.attachments || []), ...extra];
    } else d.text += quoteForReply(o, quoteSource);
  }
  return { account, d };
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result).split(',')[1] || ''); r.onerror = () => reject(r.error); r.readAsDataURL(blob); });
}

export async function sendDraft(draft) {
  const { account, d } = await prepare(draft);
  await adapterFor(account).send(d);
  learnContacts([{ to: d.to, cc: d.cc }]);
}

export async function saveDraft(draft) {
  const { account, d } = await prepare(draft);
  return adapterFor(account).saveDraft(d);
}

export async function discardDraft(accountId, draftId) {
  if (draftId) await adapterFor(accountId).deleteDraft(draftId);
}

export async function draftIdFor(msg) {
  const ad = adapterFor(msg.accountId);
  return ad.draftIdForMessage ? ad.draftIdForMessage(msg.id) : msg.id;
}

// ---------- contacts ----------
let contactCache = null;
async function learnContacts(messages) {
  const list = [];
  for (const m of messages) for (const p of [m.from, ...(m.to || []), ...(m.cc || [])]) if (p?.address && !/no-?reply|notification|mailer|bounce/i.test(p.address)) list.push({ name: p.name || '', email: p.address, source: 'mail' });
  if (list.length) { await store.contacts.putMany(list); contactCache = null; }
}

export async function refreshContacts(force = false) {
  const last = await store.kv.get('contactsAt');
  if (!force && last && Date.now() - last < 86400000) return;
  await pool(activeAccounts(), 3, async (a) => { try { await store.contacts.putMany(await adapterFor(a).listContacts()); } catch { /* skip */ } });
  await store.kv.set('contactsAt', Date.now());
  contactCache = null;
}

export async function allContacts() {
  if (!contactCache) contactCache = (await store.contacts.all()).sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email));
  return contactCache;
}

export async function suggestContacts(prefix, limit = 6) {
  const q = prefix.trim().toLowerCase();
  if (!q) return [];
  return (await allContacts()).filter((c) => c.email.includes(q) || (c.name || '').toLowerCase().includes(q)).slice(0, limit);
}

// ---------- calendar ----------
export async function loadEvents(days = 14) {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const end = start.getTime() + days * 86400000;
  const errors = [];
  const parts = await pool(activeAccounts(), 5, async (a) => {
    try { return await adapterFor(a).listEvents(start.getTime(), end); } catch (e) { errors.push({ account: a, error: e }); return []; }
  });
  return { events: parts.flat().sort((x, y) => x.start - y.start), errors };
}

export async function respondToInvite(msg, invite, response) {
  await adapterFor(msg.accountId).respondToInvite(invite, response);
}

export async function createEvent(accountId, ev) {
  return adapterFor(accountId).createEvent(ev);
}

// ---------- cleanup ----------
// opts: { accountIds, range, trashPromotions }
export async function previewCleanup(opts, onProgress) {
  const since = sinceForRange(opts.range);
  const inputs = [];
  for (const a of activeAccounts().filter((x) => opts.accountIds.includes(x.id))) {
    onProgress?.({ account: a, found: 0, loaded: 0 });
    const messages = await adapterFor(a).listInboxSince(since, (p) => onProgress?.({ account: a, ...p }));
    inputs.push({ account: a, messages });
  }
  return planCleanup(inputs, state.rules, { trashPromotions: !!opts.trashPromotions, range: opts.range });
}

export { excludeFromPlan };

export async function runCleanupPlan(plan, onProgress, isCancelled) {
  for (const a of plan.accounts) await adapterFor(a.accountId).ensureFolders();
  const res = await runCleanup(plan, { adapterFor: (id) => adapterFor(id), log: (e) => store.cleanupLog.add(e), onProgress, isCancelled });
  const runs = (await store.kv.get('cleanupRuns')) || [];
  const counts = { ...plan.totals }; delete counts.stay;
  runs.unshift({ runId: plan.runId, at: Date.now(), counts, done: res.done, undone: false });
  await store.kv.set('cleanupRuns', runs.slice(0, 20));
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

export async function forgetEverything() {
  await store.wipeEverything();
  location.reload();
}
