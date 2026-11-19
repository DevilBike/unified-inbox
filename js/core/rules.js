// Rules engine. A rule looks like:
// {
//   id, name, enabled: true, mailboxes: 'all' | ['me@x.com'],
//   match: { any: [ { from: ['amazon.com'] }, { subject: ['receipt'] }, { bulk: true } ] },
//   actions: { moveTo: 'receipts', skipInbox: true, markRead: false }
// }
// Each condition object is an AND of its keys; `match.any` is an OR of conditions
// (`match.all` is an AND of conditions). The first enabled rule that matches wins.

import { FOLDER_KEYS } from './folders.js';

export const RULES_VERSION = 1;

const LIST_KEYS = ['from', 'to', 'subject'];
export const KNOWN_CONDITION_KEYS = [...LIST_KEYS, 'bulk', 'gmailQuery'];

let idCounter = 0;
export function newId(prefix = 'r') {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${idCounter.toString(36)}`;
}

function cleanList(v) {
  const arr = Array.isArray(v) ? v : v == null ? [] : [v];
  const out = [];
  for (const item of arr) {
    const s = String(item).trim();
    if (s && !out.some((x) => x.toLowerCase() === s.toLowerCase())) out.push(s);
  }
  return out;
}

export function normalizeCondition(c) {
  const out = {};
  for (const k of LIST_KEYS) if (c[k] != null) {
    const list = cleanList(c[k]);
    if (list.length) out[k] = list;
  }
  if (typeof c.bulk === 'boolean') out.bulk = c.bulk;
  if (typeof c.gmailQuery === 'string' && c.gmailQuery.trim()) out.gmailQuery = c.gmailQuery.trim();
  return out;
}

export function normalizeRule(r) {
  const match = r.match || {};
  const anyIn = match.any || (match.all ? null : []);
  const rule = {
    id: r.id || newId(),
    name: String(r.name || 'Untitled rule').trim(),
    enabled: r.enabled !== false,
    mailboxes: Array.isArray(r.mailboxes) ? r.mailboxes.map((m) => String(m).toLowerCase()) : 'all',
    match: anyIn
      ? { any: anyIn.map(normalizeCondition).filter((c) => Object.keys(c).length) }
      : { all: match.all.map(normalizeCondition).filter((c) => Object.keys(c).length) },
    actions: {
      moveTo: FOLDER_KEYS.includes(r.actions?.moveTo) ? r.actions.moveTo : null,
      skipInbox: r.actions?.skipInbox !== false,
      markRead: !!r.actions?.markRead,
    },
  };
  return rule;
}

export function normalizeRules(list) {
  return (list || []).map(normalizeRule);
}

function fromText(msg) {
  const f = msg.from || {};
  return `${f.name || ''} <${f.address || ''}>`.toLowerCase();
}
function toText(msg) {
  return (msg.to || []).map((t) => `${t.name || ''} <${t.address || ''}>`).join(', ').toLowerCase();
}
function anyIncludes(haystack, needles) {
  return needles.some((n) => haystack.includes(String(n).toLowerCase()));
}

// Returns true / false, or null when the condition can't be checked here
// (a raw Gmail query only Gmail itself can evaluate).
export function matchesCondition(msg, cond) {
  const keys = Object.keys(cond);
  if (!keys.length) return false;
  let unknown = false;
  for (const k of keys) {
    let ok;
    if (k === 'from') ok = anyIncludes(fromText(msg), cond.from);
    else if (k === 'to') ok = anyIncludes(toText(msg), cond.to);
    else if (k === 'subject') ok = anyIncludes(String(msg.subject || '').toLowerCase(), cond.subject);
    else if (k === 'bulk') ok = !!msg.bulk === cond.bulk;
    else { unknown = true; continue; }
    if (!ok) return false;
  }
  return unknown ? null : true;
}

export function matchesRule(msg, rule) {
  if (rule.match.any) return rule.match.any.some((c) => matchesCondition(msg, c) === true);
  if (rule.match.all) return rule.match.all.length > 0 && rule.match.all.every((c) => matchesCondition(msg, c) === true);
  return false;
}

export function ruleAppliesTo(rule, accountEmail) {
  if (rule.mailboxes === 'all') return true;
  return rule.mailboxes.includes(String(accountEmail || '').toLowerCase());
}

// First matching enabled rule for this message, or null.
export function evaluate(msg, rules, accountEmail) {
  for (const rule of rules) {
    if (!rule.enabled || !rule.actions.moveTo) continue;
    if (!ruleAppliesTo(rule, accountEmail)) continue;
    if (matchesRule(msg, rule)) return { rule, folder: rule.actions.moveTo };
  }
  return null;
}

// True when a rule has at least one condition this app can check itself.
export function isCheckableHere(rule) {
  const conds = rule.match.any || rule.match.all || [];
  return conds.some((c) => Object.keys(c).some((k) => k !== 'gmailQuery'));
}

export function describeCondition(c) {
  const parts = [];
  if (c.from) parts.push(`from ${c.from.join(', ')}`);
  if (c.to) parts.push(`to ${c.to.join(', ')}`);
  if (c.subject) parts.push(`subject has ${c.subject.map((s) => `“${s}”`).join(', ')}`);
  if (c.bulk === true) parts.push('marketing / newsletter mail');
  if (c.bulk === false) parts.push('not marketing mail');
  if (c.gmailQuery) parts.push(`Gmail search: ${c.gmailQuery}`);
  return parts.join(' and ');
}

export function describeMatch(rule) {
  const conds = rule.match.any || rule.match.all || [];
  return conds.map(describeCondition).join(rule.match.any ? '; or ' : '; and ');
}
