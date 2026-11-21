// Cleanup: run the rules over mail already sitting in the inbox.
// Three steps: plan (dry run, nothing changes) -> run (moves/trashes, logged)
// -> undo (puts everything from a run back in the Inbox).

import { evaluate } from './rules.js';

export const BUCKET_STAY = 'stay';
export const BUCKET_TRASH = 'trash';

export function sinceForRange(range, now = Date.now()) {
  const day = 86400000;
  if (range === '30d') return now - 30 * day;
  if (range === '90d') return now - 90 * day;
  if (range === '1y') return now - 365 * day;
  return 0; // everything
}

// inputs: [{ account: { id, email }, messages: [...] }]
// opts: { trashPromotions: boolean }
export function planCleanup(inputs, rules, opts = {}) {
  const runId = `run_${Date.now().toString(36)}`;
  const accounts = inputs.map(({ account, messages }) => {
    const buckets = {};
    for (const msg of messages) {
      const hit = evaluate(msg, rules, account.email);
      let key = hit ? hit.folder : BUCKET_STAY;
      if (key === 'promotions' && opts.trashPromotions) key = BUCKET_TRASH;
      (buckets[key] ||= []).push(msg);
    }
    return { accountId: account.id, email: account.email, buckets };
  });
  return withTotals({ runId, createdAt: Date.now(), opts: { ...opts } }, accounts);
}

function withTotals(plan, accounts) {
  const totals = {};
  for (const a of accounts) for (const [k, list] of Object.entries(a.buckets)) if (list.length) totals[k] = (totals[k] || 0) + list.length;
  return { ...plan, accounts, totals };
}

// Where a folder choice lands in this plan (Promotions may go to Trash instead).
export function bucketForFolder(plan, folderKey) {
  if (!folderKey || folderKey === 'inbox') return BUCKET_STAY;
  if (folderKey === 'promotions' && plan.opts?.trashPromotions) return BUCKET_TRASH;
  return folderKey;
}

export function bucketOf(plan, key) {
  for (const a of plan.accounts) for (const [k, list] of Object.entries(a.buckets)) if (list.some((m) => m.key === key)) return k;
  return null;
}

// Send messages to different buckets than the rules picked. overrides: { [messageKey]: bucket }
export function reassignInPlan(plan, overrides) {
  const ov = overrides instanceof Map ? overrides : new Map(Object.entries(overrides || {}));
  const accounts = plan.accounts.map((a) => {
    const buckets = {};
    for (const [k, list] of Object.entries(a.buckets)) {
      for (const m of list) {
        const to = ov.get(m.key) || k;
        (buckets[to] ||= []).push(m);
      }
    }
    for (const list of Object.values(buckets)) list.sort((x, y) => (y.date || 0) - (x.date || 0));
    return { ...a, buckets };
  });
  return withTotals(plan, accounts);
}

// Drop messages the user unticked in the preview (they stay in the Inbox).
export function excludeFromPlan(plan, excludedKeys) {
  return reassignInPlan(plan, Object.fromEntries(excludedKeys.map((k) => [k, BUCKET_STAY])));
}

// Every message in the plan from this sender (exact address), for "always file this sender".
export function keysFromSender(plan, address) {
  const addr = String(address || '').toLowerCase();
  return plan.accounts.flatMap((a) => Object.values(a.buckets).flat()).filter((m) => (m.from?.address || '').toLowerCase() === addr).map((m) => m.key);
}

function chunk(list, n) {
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

// deps: { adapterFor(accountId), log(entries) => Promise, onProgress({ done, total }), isCancelled() }
// adapter: moveMany(msgs, folderKey) / trashMany(msgs) -> [{ id, newId }]
export async function runCleanup(plan, deps) {
  const total = plan.accounts.reduce((n, a) => n + Object.entries(a.buckets).filter(([k]) => k !== BUCKET_STAY).reduce((m, [, l]) => m + l.length, 0), 0);
  let done = 0;
  const errors = [];
  deps.onProgress?.({ done, total });
  for (const acct of plan.accounts) {
    const adapter = deps.adapterFor(acct.accountId);
    for (const [bucket, list] of Object.entries(acct.buckets)) {
      if (bucket === BUCKET_STAY) continue;
      for (const part of chunk(list, 50)) {
        if (deps.isCancelled?.()) return { done, total, errors, cancelled: true };
        try {
          const results = bucket === BUCKET_TRASH ? await adapter.trashMany(part) : await adapter.moveMany(part, bucket);
          await deps.log(results.map((r) => ({ runId: plan.runId, accountId: acct.accountId, msgId: r.id, newId: r.newId || r.id, to: bucket, at: Date.now() })));
        } catch (e) {
          errors.push({ accountId: acct.accountId, bucket, count: part.length, message: e.message });
        }
        done += part.length;
        deps.onProgress?.({ done, total });
      }
    }
  }
  return { done, total, errors, cancelled: false };
}

// entries: log entries for one run. adapter: restoreMany(newIds, fromBucket) -> void
export async function undoCleanup(entries, deps) {
  const groups = new Map();
  for (const e of entries) {
    const k = `${e.accountId}|${e.to}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }
  const total = entries.length;
  let done = 0;
  const errors = [];
  for (const [k, list] of groups) {
    const [accountId, to] = k.split('|');
    const adapter = deps.adapterFor(accountId);
    for (const part of chunk(list, 50)) {
      try { await adapter.restoreMany(part.map((e) => e.newId), to); } catch (e) { errors.push({ accountId, to, count: part.length, message: e.message }); }
      done += part.length;
      deps.onProgress?.({ done, total });
    }
  }
  return { done, total, errors };
}
