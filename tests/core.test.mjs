import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluate, normalizeRule, matchesCondition, isCheckableHere } from '../js/core/rules.js';
import { gmailXmlToRules, gmailQueryToConditions, outlookRulesToRules, mergeRules, parseRulesJson, exportRulesJson } from '../js/core/importers.js';
import { toGmailFilter, toOutlookRules, ruleToGmailQuery } from '../js/core/compile.js';
import { planCleanup, runCleanup, undoCleanup, excludeFromPlan } from '../js/core/cleanup.js';
import { buildRawMessage, parseAddress, parseAddressList, extractGmailParts, textToBase64Url, parseIcsInvite } from '../js/core/mime.js';
import { phishingHint } from '../js/core/phish.js';
import { snoozeLabelName, parseSnoozeLabel, snoozeCategory, parseSnoozeCategory } from '../js/core/snooze.js';
import { DEFAULT_RULES } from '../js/core/default-rules.js';

const msg = (o) => ({ key: o.id, id: o.id, from: { name: '', address: '' }, to: [], subject: '', bulk: false, ...o });

test('default rules sort real-looking mail', () => {
  const cases = [
    [msg({ id: 1, from: { name: 'Amazon', address: 'auto-confirm@amazon.com' }, subject: 'Ordered 1 item: Audio' }), 'receipts'],
    [msg({ id: 2, from: { name: 'Chase', address: 'no.reply.alerts@chase.com' }, subject: 'Your latest statement is now available' }), 'finance'],
    [msg({ id: 3, from: { address: 'seekerteam@ziprecruiter.com' }, subject: 'Job', bulk: true }), 'jobs'],
    [msg({ id: 4, from: { address: 'editorpicks@nytimes.com' }, subject: 'News', bulk: true }), 'news'],
    [msg({ id: 5, from: { address: 'newsletter@enews.uniqlo.ca' }, subject: 'Deals', bulk: true }), 'promotions'],
    [msg({ id: 6, from: { name: 'Chipotle', address: 'chipotle@email.chipotle.com' }, subject: 'Thanks for your order, Michael.' }), 'receipts'],
    [msg({ id: 8, from: { name: 'Chipotle', address: 'chipotle@email.chipotle.com' }, subject: 'Free chips & guac? Not bad for day one.', bulk: true }), 'promotions'],
  ];
  for (const [m, folder] of cases) assert.equal(evaluate(m, DEFAULT_RULES, 'me@x.com')?.folder, folder, m.subject);
  const person = msg({ id: 7, from: { name: 'Pat Teacher', address: 'teacher@example.org' }, subject: 'Re: Guitar lessons' });
  assert.equal(evaluate(person, DEFAULT_RULES, 'me@x.com'), null);
});

test('rules respect enabled flag and mailbox scope', () => {
  const r = normalizeRule({ name: 'X', mailboxes: ['a@x.com'], match: { any: [{ from: ['foo'] }] }, actions: { moveTo: 'jobs' } });
  const m = msg({ id: 1, from: { address: 'foo@bar.com' } });
  assert.equal(evaluate(m, [r], 'a@x.com')?.folder, 'jobs');
  assert.equal(evaluate(m, [r], 'b@x.com'), null);
  assert.equal(evaluate(m, [{ ...r, enabled: false }], 'a@x.com'), null);
});

test('AND inside a condition, OR across conditions', () => {
  assert.equal(matchesCondition(msg({ from: { address: 'a@amazon.com' }, subject: 'hello' }), { from: ['amazon'], subject: ['receipt'] }), false);
  assert.equal(matchesCondition(msg({ from: { address: 'a@amazon.com' }, subject: 'Your receipt' }), { from: ['amazon'], subject: ['receipt'] }), true);
  assert.equal(matchesCondition(msg({}), { gmailQuery: 'has:attachment' }), null);
});

test('imports the earlier gmail-filters.xml', () => {
  const xml = readFileSync(new URL('./fixtures/gmail-filters.xml', import.meta.url), 'utf8');
  const { rules, skipped } = gmailXmlToRules(xml);
  assert.equal(skipped.length, 0);
  assert.deepEqual(rules.map((r) => r.actions.moveTo), ['receipts', 'finance', 'jobs', 'news', 'promotions']);
  const receipts = rules[0];
  assert.ok(receipts.match.any.some((c) => c.from?.includes('auto-confirm@amazon.com')));
  assert.ok(receipts.match.any.some((c) => c.subject?.includes('order confirmation')));
  assert.deepEqual(rules[4].match.any, [{ bulk: true }]);
  assert.ok(rules.every((r) => r.actions.skipInbox));
  const m = msg({ from: { address: 'auto-confirm@amazon.com' }, subject: 'Ordered' });
  assert.equal(evaluate(m, rules, 'x')?.folder, 'receipts');
});

test('unknown gmail queries are kept raw, labels outside folders are skipped', () => {
  assert.deepEqual(gmailQueryToConditions('has:attachment larger:5M'), [{ gmailQuery: 'has:attachment larger:5M' }]);
  const xml = `<feed><entry><apps:property name='from' value='a@b.com'/><apps:property name='label' value='Taxes'/></entry>
  <entry><apps:property name='hasTheWord' value='has:attachment'/><apps:property name='label' value='Finance'/></entry></feed>`;
  const { rules, skipped } = gmailXmlToRules(xml);
  assert.equal(skipped.length, 1);
  assert.equal(rules[0].actions.moveTo, 'finance');
  assert.equal(isCheckableHere(rules[0]), false);
});

test('outlook rules import', () => {
  const { rules } = outlookRulesToRules([
    { displayName: 'Shopping', isEnabled: true, conditions: { senderContains: ['uniqlo'] }, actions: { moveToFolder: 'F1' } },
    { displayName: '[Unified Inbox] Promotions (2)', conditions: { headerContains: ['List-Unsubscribe'] }, actions: { moveToFolder: 'F1' } },
  ], { F1: 'Promotions' });
  assert.equal(rules.length, 1);
  assert.equal(rules[0].actions.moveTo, 'promotions');
  assert.equal(rules[0].match.any.length, 2);
});

test('merge by name unions lists', () => {
  const a = [normalizeRule({ name: 'Jobs', match: { any: [{ from: ['ziprecruiter.com'] }] }, actions: { moveTo: 'jobs' } })];
  const b = [normalizeRule({ name: 'jobs', match: { any: [{ from: ['indeed.com', 'ZipRecruiter.com'] }] }, actions: { moveTo: 'jobs' } }),
    normalizeRule({ name: 'News', match: { any: [{ from: ['nytimes.com'] }] }, actions: { moveTo: 'news' } })];
  const { rules, report } = mergeRules(a, b);
  assert.deepEqual(rules[0].match.any[0].from, ['ziprecruiter.com', 'indeed.com']);
  assert.deepEqual(report.map((r) => r.status), ['merged', 'new']);
});

test('json round trip', () => {
  const { rules } = parseRulesJson(exportRulesJson(DEFAULT_RULES));
  assert.deepEqual(rules, DEFAULT_RULES);
  assert.throws(() => parseRulesJson('{oops'));
});

test('compile to gmail filters and outlook rules', () => {
  const f = toGmailFilter(DEFAULT_RULES[0], 'Label_1');
  assert.match(f.criteria.query, /^from:\(auto-confirm@amazon\.com OR /);
  assert.match(f.criteria.query, / OR subject:\(receipt OR invoice OR "order confirmation"/);
  assert.deepEqual(f.action, { addLabelIds: ['Label_1'], removeLabelIds: ['INBOX'] });
  assert.equal(ruleToGmailQuery(DEFAULT_RULES[4]), 'category:promotions');
  const { rules } = toOutlookRules(DEFAULT_RULES[0], 'FOLDER', 10);
  assert.equal(rules.length, 2);
  assert.equal(rules[0].displayName, '[Unified Inbox] Receipts (1)');
  assert.deepEqual(rules[1].conditions.subjectContains.slice(0, 2), ['receipt', 'invoice']);
  assert.equal(rules[1].sequence, 11);
  assert.deepEqual(toOutlookRules(DEFAULT_RULES[4], 'P').rules[0].conditions, { headerContains: ['List-Unsubscribe'] });
});

test('cleanup plan, run, undo', async () => {
  const account = { id: 'acc1', email: 'me@x.com' };
  const messages = [
    msg({ id: 'a', key: 'acc1:a', from: { address: 'auto-confirm@amazon.com' } }),
    msg({ id: 'b', key: 'acc1:b', from: { address: 'x@uniqlo.ca' }, bulk: true }),
    msg({ id: 'c', key: 'acc1:c', from: { address: 'friend@x.com' } }),
    msg({ id: 'd', key: 'acc1:d', from: { address: 'y@gamestop.com' }, bulk: true }),
  ];
  let plan = planCleanup([{ account, messages }], DEFAULT_RULES, { trashPromotions: true });
  assert.deepEqual(plan.totals, { receipts: 1, trash: 2, stay: 1 });
  plan = excludeFromPlan(plan, ['acc1:d']);
  assert.deepEqual(plan.totals, { receipts: 1, trash: 1, stay: 2 });

  const calls = [];
  const log = [];
  const adapter = {
    moveMany: async (ms, folder) => { calls.push(['move', folder, ms.map((m) => m.id)]); return ms.map((m) => ({ id: m.id, newId: `${m.id}2` })); },
    trashMany: async (ms) => { calls.push(['trash', ms.map((m) => m.id)]); return ms.map((m) => ({ id: m.id })); },
    restoreMany: async (ids, from) => { calls.push(['restore', from, ids]); },
  };
  const res = await runCleanup(plan, { adapterFor: () => adapter, log: async (e) => log.push(...e) });
  assert.equal(res.done, 2);
  assert.deepEqual(calls, [['move', 'receipts', ['a']], ['trash', ['b']]]);
  assert.deepEqual(log.map((e) => [e.newId, e.to]), [['a2', 'receipts'], ['b', 'trash']]);
  calls.length = 0;
  await undoCleanup(log, { adapterFor: () => adapter });
  assert.deepEqual(calls, [['restore', 'receipts', ['a2']], ['restore', 'trash', ['b']]]);
});

test('promotions stay as a folder when trash is off', () => {
  const plan = planCleanup([{ account: { id: 'a', email: 'e' }, messages: [msg({ id: 'b', bulk: true })] }], DEFAULT_RULES, { trashPromotions: false });
  assert.deepEqual(plan.totals, { promotions: 1 });
});

test('mime helpers', () => {
  assert.deepEqual(parseAddress('"Pat Teacher" <teacher@example.org>'), { name: 'Pat Teacher', address: 'teacher@example.org' });
  assert.equal(parseAddressList('"Doe, J" <j@x.com>, b@y.com').length, 2);
  const raw = buildRawMessage({ from: { name: 'Me', address: 'me@x.com' }, to: [{ address: 'a@b.com' }], subject: 'Héllo', text: 'hi there' });
  assert.match(raw, /Subject: =\?UTF-8\?B\?/);
  assert.match(raw, /To: a@b.com/);
  const payload = { mimeType: 'multipart/alternative', parts: [
    { mimeType: 'text/plain', headers: [], body: { data: textToBase64Url('plain ✓') } },
    { mimeType: 'text/html', headers: [{ name: 'Content-Type', value: 'text/html; charset="UTF-8"' }], body: { data: textToBase64Url('<b>html ✓</b>') } },
    { mimeType: 'application/pdf', filename: 'invoice.pdf', headers: [], body: { attachmentId: 'ATT', size: 100 } },
  ] };
  const parts = extractGmailParts(payload);
  assert.equal(parts.html, '<b>html ✓</b>');
  assert.equal(parts.text, 'plain ✓');
  assert.equal(parts.attachments[0].name, 'invoice.pdf');
  const inv = parseIcsInvite('BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:abc123@google.com\r\nSUMMARY:Lesson\r\nDTSTART:20261124T233000Z\r\nEND:VEVENT');
  assert.equal(inv.uid, 'abc123@google.com');
  assert.equal(inv.method, 'REQUEST');
});

test('phishing hint', () => {
  assert.match(phishingHint({ name: '', address: 'member@surveymonkeyuser.com' }, 'Address Correction', 'Ｃ𝖠N𝖠D𝖠 ⲢOST Dear me@example.net Address Correction Required'), /Canada Post/);
  assert.equal(phishingHint({ name: 'Amazon', address: 'auto-confirm@amazon.com' }), null);
  assert.equal(phishingHint({ name: 'The New York Times', address: 'editorpicks@nytimes.com' }, 'Microsoft stock rises', 'Microsoft shares rose'), null);
  assert.match(phishingHint({ name: 'PayPal Support', address: 'help@paypa1-secure.net' }), /PayPal/);
});

test('snooze encoding', () => {
  const t = Date.parse('2026-11-20T15:00:00Z');
  assert.equal(snoozeLabelName(t), 'Snoozed/2026-11-20T15:00Z');
  assert.equal(parseSnoozeLabel(snoozeLabelName(t)), t);
  assert.equal(parseSnoozeCategory(snoozeCategory(t)), t);
  assert.equal(parseSnoozeLabel('Snoozed'), null);
});
