// Turn app rules into provider-side rules so mail is sorted even when the app
// is closed: Gmail filters and Outlook inbox rules.

export const OUTLOOK_RULE_PREFIX = '[Unified Inbox] ';

function quote(v) {
  return /\s|[()]/.test(v) ? `"${v.replace(/"/g, '')}"` : v;
}

function conditionToGmailQuery(c) {
  const parts = [];
  if (c.from) parts.push(`from:(${c.from.map(quote).join(' OR ')})`);
  if (c.to) parts.push(`to:(${c.to.map(quote).join(' OR ')})`);
  if (c.subject) parts.push(`subject:(${c.subject.map(quote).join(' OR ')})`);
  if (c.bulk === true) parts.push('category:promotions');
  if (c.bulk === false) parts.push('-category:promotions');
  if (c.gmailQuery) parts.push(`(${c.gmailQuery})`);
  if (!parts.length) return null;
  return parts.length > 1 ? `(${parts.join(' ')})` : parts[0];
}

export function ruleToGmailQuery(rule) {
  const conds = rule.match.any || rule.match.all || [];
  const qs = conds.map(conditionToGmailQuery).filter(Boolean);
  if (!qs.length) return null;
  return qs.join(rule.match.any ? ' OR ' : ' ');
}

// -> { criteria: { query }, action: { addLabelIds, removeLabelIds } } or null
export function toGmailFilter(rule, labelId) {
  if (!rule.enabled || !rule.actions.moveTo || !labelId) return null;
  const query = ruleToGmailQuery(rule);
  if (!query) return null;
  const remove = [];
  if (rule.actions.skipInbox) remove.push('INBOX');
  if (rule.actions.markRead) remove.push('UNREAD');
  const action = { addLabelIds: [labelId] };
  if (remove.length) action.removeLabelIds = remove;
  return { criteria: { query }, action };
}

// Outlook rules AND their conditions together, so each OR'd condition becomes
// its own Outlook rule. Raw Gmail queries can't be expressed and are reported.
// -> { rules: messageRule[], skipped: string[] }
export function toOutlookRules(rule, folderId, startSequence = 1) {
  const out = [];
  const skipped = [];
  if (!rule.enabled || !rule.actions.moveTo || !folderId) return { rules: out, skipped };
  const conds = rule.match.all ? [Object.assign({}, ...rule.match.all)] : rule.match.any;
  conds.forEach((c) => {
    if (c.gmailQuery) { skipped.push(`${rule.name}: “${c.gmailQuery}” only works in Gmail`); return; }
    const p = {};
    if (c.from) p.senderContains = c.from;
    if (c.to) p.recipientContains = c.to;
    if (c.subject) p.subjectContains = c.subject;
    if (c.bulk === true) p.headerContains = ['List-Unsubscribe'];
    if (!Object.keys(p).length) return;
    out.push({ conditions: p });
  });
  const rules = out.map((r, i) => ({
    displayName: `${OUTLOOK_RULE_PREFIX}${rule.name}${out.length > 1 ? ` (${i + 1})` : ''}`,
    sequence: startSequence + i,
    isEnabled: true,
    conditions: r.conditions,
    actions: { moveToFolder: folderId, stopProcessingRules: true, ...(rule.actions.markRead ? { markAsRead: true } : {}) },
  }));
  return { rules, skipped };
}

export function isAppOutlookRule(r) {
  return String(r.displayName || '').startsWith(OUTLOOK_RULE_PREFIX);
}
