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
  const totals = {};
  for (const a of accounts) for (const [k, list] of Object.entries(a.buckets)) totals[k] = (totals[k] || 0) + list.length;
  return { runId, createdAt: Date.now(), opts: { ...opts }, accounts, totals };
}

// Drop messages the user unticked in the preview.
export function excludeFromPlan(plan, excludedKeys) {
  const ex = new Set(excludedKeys);
  const accounts = plan.accounts.map((a) => {
    const buckets = {};
    for (const [k, list] of Object.entries(a.buckets)) {
      const keep = list.filter((m) => !ex.has(m.key));
      const moved = list.filter((m) => ex.has(m.key));
      if (keep.length) (buckets[k] ||= []).push(...keep);
      if (moved.length) (buckets[BUCKET_STAY] ||= []).push(...moved);
    }
    return { ...a, buckets };
  });
  const totals = {};
  for (const a of accounts) for (const [k, list] of Object.entries(a.buckets)) totals[k] = (totals[k] || 0) + list.length;
  return { ...plan, accounts, totals };
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
