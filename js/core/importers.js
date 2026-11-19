// Turn rules from other places (Gmail filter export, Outlook rules, our own
// JSON file) into this app's rule format, and merge them into an existing list.

import { folderKeyFromName } from './folders.js';
import { normalizeRule, normalizeRules, RULES_VERSION, newId } from './rules.js';

function decodeXml(s) {
  return String(s)
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&');
}

// Parse Gmail's mailFilters.xml into [{ from, hasTheWord, label, ... }].
export function parseGmailFiltersXml(xml) {
  const entries = [];
  const entryRe = /<entry\b[^>]*>([\s\S]*?)<\/entry>/g;
  const propRe = /<apps:property\b([^>]*?)\/?>/g;
  const attrRe = /(\w+)\s*=\s*(?:'([^']*)'|"([^"]*)")/g;
  let m;
  while ((m = entryRe.exec(xml))) {
    const props = {};
    let p;
    propRe.lastIndex = 0;
    while ((p = propRe.exec(m[1]))) {
      const attrs = {};
      let a;
      attrRe.lastIndex = 0;
      while ((a = attrRe.exec(p[1]))) attrs[a[1]] = decodeXml(a[2] ?? a[3] ?? '');
      if (attrs.name) props[attrs.name] = attrs.value ?? '';
    }
    if (Object.keys(props).length) entries.push(props);
  }
  return entries;
}

// Split on a top-level " OR " (outside parentheses and quotes).
function splitTopLevel(s, sep = 'OR') {
  const parts = [];
  let depth = 0, quote = false, cur = '';
  const tokens = s.split(/(\s+)/);
  for (const t of tokens) {
    for (const ch of t) {
      if (ch === '"') quote = !quote;
      else if (!quote && ch === '(') depth += 1;
      else if (!quote && ch === ')') depth -= 1;
    }
    if (!quote && depth === 0 && t === sep) { parts.push(cur.trim()); cur = ''; }
    else cur += t;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

function stripParens(s) {
  let t = s.trim();
  while (t.startsWith('(') && t.endsWith(')')) {
    // only strip if the parens wrap the whole thing
    let depth = 0, wraps = true;
    for (let i = 0; i < t.length; i += 1) {
      if (t[i] === '(') depth += 1;
      else if (t[i] === ')') depth -= 1;
      if (depth === 0 && i < t.length - 1) { wraps = false; break; }
    }
    if (!wraps) break;
    t = t.slice(1, -1).trim();
  }
  return t;
}

function listValues(v) {
  return splitTopLevel(stripParens(v))
    .map((x) => stripParens(x).replace(/^"|"$/g, '').trim())
    .filter(Boolean);
}

// Convert a Gmail search query into conditions. Understands from:/to:/subject:
// with OR lists and category:promotions|social. Anything else is kept as a raw
// Gmail query (pushed to Gmail as-is, not checked by the app).
export function gmailQueryToConditions(query) {
  const q = String(query || '').trim();
  if (!q) return [];
  const parts = splitTopLevel(stripParens(q));
  const conds = [];
  for (const part of parts) {
    const m = /^(from|to|subject|category):(.*)$/i.exec(stripParens(part));
    if (!m) return [{ gmailQuery: q }];
    const key = m[1].toLowerCase();
    const vals = listValues(m[2]);
    if (!vals.length) return [{ gmailQuery: q }];
    if (key === 'category') {
      if (vals.every((v) => /^(promotions|social)$/i.test(v))) conds.push({ bulk: true });
      else return [{ gmailQuery: q }];
    } else {
      const existing = conds.find((c) => Object.keys(c).length === 1 && c[key]);
      if (existing) existing[key].push(...vals);
      else conds.push({ [key]: vals });
    }
  }
  return conds;
}

// Gmail filters XML -> { rules, skipped }
export function gmailXmlToRules(xml) {
  return gmailEntriesToRules(parseGmailFiltersXml(xml));
}

// Filters read live from the Gmail API -> same shape as XML entries.
// labelNames maps label id -> label name.
export function gmailApiFiltersToEntries(filters, labelNames = {}) {
  return (filters || []).map((f) => {
    const c = f.criteria || {};
    const a = f.action || {};
    const labelId = (a.addLabelIds || []).find((id) => labelNames[id]);
    const e = {};
    if (c.from) e.from = c.from;
    if (c.to) e.to = c.to;
    if (c.subject) e.subject = c.subject;
    if (c.query) e.hasTheWord = c.query;
    if (labelId) e.label = labelNames[labelId];
    if ((a.removeLabelIds || []).includes('INBOX')) e.shouldArchive = 'true';
    if ((a.removeLabelIds || []).includes('UNREAD')) e.shouldMarkAsRead = 'true';
    return e;
  });
}

export function gmailEntriesToRules(entries) {
  const byFolder = new Map();
  const skipped = [];
  for (const e of entries) {
    const folder = folderKeyFromName(e.label);
    if (!folder) {
      skipped.push({ reason: e.label ? `Label “${e.label}” isn't one of your folders` : 'Filter has no label', detail: e.from || e.hasTheWord || e.subject || '' });
      continue;
    }
    const base = {};
    if (e.from) base.from = listValues(e.from);
    if (e.to) base.to = listValues(e.to);
    if (e.subject) base.subject = listValues(e.subject);
    let conds = [];
    if (e.hasTheWord) {
      const fromQuery = gmailQueryToConditions(e.hasTheWord);
      conds = Object.keys(base).length ? fromQuery.map((c) => ({ ...base, ...c })) : fromQuery;
    } else if (Object.keys(base).length) conds = [base];
    if (!conds.length) { skipped.push({ reason: 'Filter has no conditions', detail: e.label }); continue; }
    const cur = byFolder.get(folder) || { name: e.label, conds: [], skipInbox: false, markRead: false };
    cur.conds.push(...conds);
    cur.skipInbox = cur.skipInbox || e.shouldArchive === 'true';
    cur.markRead = cur.markRead || e.shouldMarkAsRead === 'true';
    byFolder.set(folder, cur);
  }
  const rules = [...byFolder.entries()].map(([folder, v]) => normalizeRule({
    name: v.name,
    match: { any: v.conds },
    actions: { moveTo: folder, skipInbox: v.skipInbox, markRead: v.markRead },
  }));
  return { rules, skipped };
}

// Outlook (Graph messageRule[]) -> { rules, skipped }. folderNames maps folder id -> display name.
export function outlookRulesToRules(outlookRules, folderNames = {}) {
  const rules = [];
  const skipped = [];
  for (const r of outlookRules || []) {
    const name = String(r.displayName || '').replace(/^\[Unified Inbox\]\s*/, '').replace(/\s*\(\d+\)$/, '');
    const folderId = r.actions?.moveToFolder;
    const folder = folderKeyFromName(folderNames[folderId]) || folderKeyFromName(name);
    if (!folder) { skipped.push({ reason: `Rule “${r.displayName}” doesn't move mail into one of your folders`, detail: '' }); continue; }
    const c = r.conditions || {};
    const cond = {};
    const from = [...(c.senderContains || []), ...((c.fromAddresses || []).map((a) => a.emailAddress?.address).filter(Boolean))];
    if (from.length) cond.from = from;
    if (c.subjectContains?.length) cond.subject = c.subjectContains;
    if (c.recipientContains?.length) cond.to = c.recipientContains;
    if ((c.headerContains || []).some((h) => /list-unsubscribe/i.test(h))) cond.bulk = true;
    const unsupported = Object.keys(c).filter((k) => !['senderContains', 'fromAddresses', 'subjectContains', 'recipientContains', 'headerContains'].includes(k));
    if (unsupported.length) skipped.push({ reason: `Rule “${r.displayName}”: some conditions aren't supported and were left out`, detail: unsupported.join(', ') });
    if (!Object.keys(cond).length) { skipped.push({ reason: `Rule “${r.displayName}” has no conditions the app understands`, detail: '' }); continue; }
    const existing = rules.find((x) => x.actions.moveTo === folder);
    if (existing) existing.match.any.push(cond);
    else rules.push(normalizeRule({
      name: name || folder,
      enabled: r.isEnabled !== false,
      match: { any: [cond] },
      actions: { moveTo: folder, skipInbox: true, markRead: !!r.actions?.markAsRead },
    }));
  }
  return { rules: rules.map(normalizeRule), skipped };
}

export function parseRulesJson(text) {
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('That file is not valid JSON.'); }
  const list = Array.isArray(data) ? data : data?.rules;
  if (!Array.isArray(list)) throw new Error('No "rules" list found in that file.');
  return { rules: normalizeRules(list), skipped: [] };
}

export function exportRulesJson(rules) {
  return JSON.stringify({ version: RULES_VERSION, exportedAt: new Date().toISOString(), rules }, null, 2);
}

function condSignature(c) {
  return Object.keys(c).sort().filter((k) => k !== 'from' && k !== 'to' && k !== 'subject').map((k) => `${k}=${c[k]}`).join('&')
    + '|' + ['from', 'to', 'subject'].filter((k) => c[k]).join(',');
}

// Merge incoming rules into existing by name (case-insensitive).
// Returns { rules, report: [{ name, status: 'new' | 'merged' }] }.
export function mergeRules(existing, incoming) {
  const out = existing.map((r) => structuredClone(r));
  const report = [];
  for (const inc of incoming) {
    const target = out.find((r) => r.name.toLowerCase() === inc.name.toLowerCase());
    if (!target) {
      out.push({ ...structuredClone(inc), id: inc.id || newId() });
      report.push({ name: inc.name, status: 'new' });
      continue;
    }
    const tConds = target.match.any || target.match.all;
    for (const c of inc.match.any || inc.match.all || []) {
      const sig = condSignature(c);
      const same = tConds.find((t) => condSignature(t) === sig && Object.keys(c).filter((k) => ['from', 'to', 'subject'].includes(k)).length === 1);
      if (same) {
        for (const k of ['from', 'to', 'subject']) if (c[k]) {
          same[k] = [...(same[k] || [])];
          for (const v of c[k]) if (!same[k].some((x) => x.toLowerCase() === v.toLowerCase())) same[k].push(v);
        }
      } else if (!tConds.some((t) => JSON.stringify(t) === JSON.stringify(c))) tConds.push(structuredClone(c));
    }
    report.push({ name: inc.name, status: 'merged' });
  }
  return { rules: out, report };
}
