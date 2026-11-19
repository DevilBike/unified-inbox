// Starter rules, built from what's actually in your 5 mailboxes.
import { normalizeRules } from './rules.js';

export const DEFAULT_RULES = normalizeRules([
  {
    id: 'r_receipts', name: 'Receipts',
    match: { any: [
      { from: ['auto-confirm@amazon.com', 'shipment-tracking@amazon.com', 'order-update@amazon.com', 'digital-no-reply@amazon.com', 'googleplay-noreply@google.com', 'service@paypal.com', 'torbox.app', 'aliexpress.com'] },
      { subject: ['receipt', 'invoice', 'order confirmation', 'your order', 'thanks for your order', 'purchase complete', 'payment confirmed', 'has shipped', 'subscription renewed'] },
    ] },
    actions: { moveTo: 'receipts', skipInbox: true },
  },
  {
    id: 'r_finance', name: 'Finance',
    match: { any: [
      { from: ['no.reply.alerts@chase.com', 'noreply@service.paypal.com', 'gexaemail.com', 'paperlessemployee.com'] },
      { subject: ['statement is available', 'statement is now available', 'pay statement', 'bill is ready'] },
    ] },
    actions: { moveTo: 'finance', skipInbox: true },
  },
  {
    id: 'r_jobs', name: 'Jobs',
    match: { any: [{ from: ['ziprecruiter.com', 'ihire.com', 'indeed.com', 'jobs-noreply@linkedin.com', 'jobalerts-noreply@linkedin.com'] }] },
    actions: { moveTo: 'jobs', skipInbox: true },
  },
  {
    id: 'r_news', name: 'News',
    match: { any: [{ from: ['nytimes.com', 'redditmail.com', 'service.tiktok.com', 'mailer.last.fm', 'facebookmail.com'] }] },
    actions: { moveTo: 'news', skipInbox: true },
  },
  {
    id: 'r_promotions', name: 'Promotions',
    match: { any: [{ bulk: true }] },
    actions: { moveTo: 'promotions', skipInbox: true },
  },
]);
