// Outlook.com (Microsoft Graph) adapter: mail, calendar, contacts.
import { apiFetch, pool } from './http.js';
import { TARGET_FOLDERS, folderName } from '../core/folders.js';
import { toOutlookRules, isAppOutlookRule } from '../core/compile.js';
import { outlookRulesToRules } from '../core/importers.js';
import { SNOOZE_ROOT, snoozeCategory, parseSnoozeCategory, isSnoozeCategory } from '../core/snooze.js';
import { escapeHtml } from '../core/mime.js';

const API = 'https://graph.microsoft.com/v1.0';
const SELECT = 'id,conversationId,subject,bodyPreview,from,toRecipients,ccRecipients,receivedDateTime,isRead,flag,hasAttachments,inferenceClassification,categories,internetMessageId,internetMessageHeaders,isDraft';
const WELL_KNOWN = { inbox: 'inbox', drafts: 'drafts', sent: 'sentitems', junk: 'junkemail', trash: 'deleteditems', archive: 'archive' };

const addr = (r) => ({ name: r?.emailAddress?.name || '', address: (r?.emailAddress?.address || '').toLowerCase() });
const recips = (list) => (list || []).map((a) => ({ emailAddress: { address: a.address, name: a.name || undefined } }));

export class GraphAdapter {
  constructor(account, ctx) {
    this.account = account;
    this.ctx = { ...ctx, account };
    this.folders = null; // displayName(lower) -> id
  }

  api(path, opts) { return apiFetch(this.ctx, path.startsWith('http') ? path : `${API}${path}`, opts); }

  static async profile(ctx) { return apiFetch(ctx, `${API}/me?$select=displayName,mail,userPrincipalName`); }

  // ----- folders -----
  async loadFolders(force = false) {
    if (this.folders && !force) return this.folders;
    this.folders = {};
    this.folderNames = {};
    let url = `${API}/me/mailFolders?$top=100&$select=id,displayName`;
    while (url) {
      const data = await this.api(url);
      for (const f of data.value || []) { this.folders[f.displayName.toLowerCase()] = f.id; this.folderNames[f.id] = f.displayName; }
      url = data['@odata.nextLink'];
    }
    return this.folders;
  }

  async folderId(name, create = true) {
    await this.loadFolders();
    const id = this.folders[name.toLowerCase()];
    if (id || !create) return id || null;
    const f = await this.api('/me/mailFolders', { method: 'POST', body: { displayName: name } });
    this.folders[name.toLowerCase()] = f.id;
    this.folderNames[f.id] = f.displayName;
    return f.id;
  }

  async destinationFor(view) {
    if (WELL_KNOWN[view]) return WELL_KNOWN[view];
    if (view === 'snoozed') return this.folderId(SNOOZE_ROOT);
    return this.folderId(folderName(view));
  }

  async ensureFolders() {
    for (const f of TARGET_FOLDERS) await this.folderId(f.name);
    await this.folderId(SNOOZE_ROOT);
  }

  // ----- messages -----
  normalize(m, view) {
    const headers = m.internetMessageHeaders || [];
    const hasUnsub = headers.some((h) => /^list-unsubscribe$/i.test(h.name));
    return {
      key: `${this.account.id}:${m.id}`,
      accountId: this.account.id,
      provider: 'microsoft',
      id: m.id,
      threadId: m.conversationId,
      view,
      from: addr(m.from),
      to: (m.toRecipients || []).map(addr),
      cc: (m.ccRecipients || []).map(addr),
      subject: m.subject || '(no subject)',
      snippet: m.bodyPreview || '',
      date: Date.parse(m.receivedDateTime) || Date.now(),
      unread: !m.isRead,
      flagged: m.flag?.flagStatus === 'flagged',
      bulk: hasUnsub && m.inferenceClassification === 'other',
      hasAttachments: !!m.hasAttachments,
      isInvite: /eventMessageRequest/i.test(m['@odata.type'] || ''),
      categories: m.categories || [],
      messageId: m.internetMessageId,
      isDraft: !!m.isDraft,
    };
  }

  async listUrl(view, max) {
    if (view === 'flagged') return `${API}/me/messages?$filter=flag/flagStatus eq 'flagged'&$top=${max}&$select=${SELECT}`;
    const id = await this.destinationFor(view);
    return `${API}/me/mailFolders/${id}/messages?$top=${max}&$orderby=receivedDateTime desc&$select=${SELECT}`;
  }

  async list(view, { pageToken, max = 30 } = {}) {
    const url = pageToken || await this.listUrl(view, max);
    const data = await this.api(url);
    return { messages: (data.value || []).map((m) => this.normalize(m, view)), nextPageToken: data['@odata.nextLink'] || null };
  }

  async search(q, { max = 30 } = {}) {
    const data = await this.api(`/me/messages?$search="${encodeURIComponent(q.replace(/"/g, ''))}"&$top=${max}&$select=${SELECT}`);
    return (data.value || []).map((m) => this.normalize(m, 'search'));
  }

  async listInboxSince(since, onProgress) {
    const out = [];
    const filter = since ? `&$filter=receivedDateTime ge ${new Date(since).toISOString()}` : '';
    let url = `${API}/me/mailFolders/inbox/messages?$top=100&$select=${SELECT}${filter}`;
    while (url) {
      const data = await this.api(url);
      out.push(...(data.value || []).map((m) => this.normalize(m, 'inbox')));
      onProgress?.({ found: out.length, loaded: out.length });
      url = data['@odata.nextLink'];
    }
    return out;
  }

  async getFull(msg) {
    const m = await this.api(`/me/messages/${msg.id}?$select=${SELECT},body&$expand=attachments($select=id,name,contentType,size,isInline)`, { headers: { Prefer: 'outlook.body-content-type="html"' } });
    const full = this.normalize(m, msg.view);
    let invite = null;
    if (full.isInvite || msg.isInvite) {
      try {
        const em = await this.api(`/me/messages/${msg.id}?$expand=microsoft.graph.eventMessage/event($select=id,subject,start,end,location,responseStatus)`);
        if (em.event) invite = { eventId: em.event.id, summary: em.event.subject, response: em.event.responseStatus?.response };
      } catch { /* not an invite after all */ }
    }
    return {
      ...full,
      html: m.body?.contentType === 'html' ? m.body.content : '',
      text: m.body?.contentType === 'text' ? m.body.content : '',
      attachments: (m.attachments || []).map((a) => ({ id: a.id, name: a.name, mimeType: a.contentType, size: a.size, inline: a.isInline })),
      invite,
    };
  }

  async getAttachment(msg, att) {
    const a = await this.api(`/me/messages/${msg.id}/attachments/${att.id}`);
    const bin = atob(a.contentBytes || '');
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: att.mimeType || 'application/octet-stream' });
  }

  async move(id, destinationId) {
    const m = await this.api(`/me/messages/${id}/move`, { method: 'POST', body: { destinationId } });
    return m.id;
  }

  async markRead(msg, read = true) { await this.api(`/me/messages/${msg.id}`, { method: 'PATCH', body: { isRead: read } }); return msg.id; }
  async setFlag(msg, flagged) { await this.api(`/me/messages/${msg.id}`, { method: 'PATCH', body: { flag: { flagStatus: flagged ? 'flagged' : 'notFlagged' } } }); return msg.id; }
  archive(msg) { return this.move(msg.id, 'archive'); }
  trash(msg) { return this.move(msg.id, 'deleteditems'); }
  markSpam(msg) { return this.move(msg.id, 'junkemail'); }
  notSpam(msg) { return this.move(msg.id, 'inbox'); }
  async moveTo(msg, folderKey) { return this.move(msg.id, await this.destinationFor(folderKey)); }

  // Up to 20 moves per Graph $batch call. Returns [{ id, newId }].
  async batchMove(ids, destinationId) {
    const out = [];
    for (let i = 0; i < ids.length; i += 20) {
      const part = ids.slice(i, i + 20);
      const requests = part.map((id, n) => ({ id: String(n), method: 'POST', url: `/me/messages/${id}/move`, headers: { 'Content-Type': 'application/json' }, body: { destinationId } }));
      const data = await this.api('/$batch', { method: 'POST', body: { requests } });
      const failed = [];
      for (const r of data.responses || []) {
        const id = part[Number(r.id)];
        if (r.status >= 200 && r.status < 300) out.push({ id, newId: r.body?.id || id });
        else failed.push({ id, status: r.status, message: r.body?.error?.message });
      }
      // Retry throttled ones one at a time.
      for (const f of failed) {
        if (f.status === 429 || f.status >= 500) out.push({ id: f.id, newId: await this.move(f.id, destinationId) });
        else throw new Error(f.message || `Move failed (${f.status})`);
      }
    }
    return out;
  }

  async moveMany(msgs, folderKey) { return this.batchMove(msgs.map((m) => m.id), await this.destinationFor(folderKey)); }
  async trashMany(msgs) { return this.batchMove(msgs.map((m) => m.id), 'deleteditems'); }
  async restoreMany(ids) { await this.batchMove(ids, 'inbox'); }

  // ----- compose -----
  bodyHtml(draft) {
    return draft.html || `<div style="white-space:pre-wrap">${escapeHtml(draft.text || '')}</div>`;
  }

  async attach(messageId, attachments = []) {
    for (const a of attachments) {
      await this.api(`/me/messages/${messageId}/attachments`, { method: 'POST', body: { '@odata.type': '#microsoft.graph.fileAttachment', name: a.name, contentType: a.mimeType, contentBytes: a.base64 } });
    }
  }

  // Creates or updates a draft and returns its id.
  async saveDraft(draft) {
    const fields = { subject: draft.subject, toRecipients: recips(draft.to), ccRecipients: recips(draft.cc), bccRecipients: recips(draft.bcc) };
    if (draft.draftId) {
      await this.api(`/me/messages/${draft.draftId}`, { method: 'PATCH', body: { ...fields, body: { contentType: 'HTML', content: this.bodyHtml(draft) } } });
      await this.attach(draft.draftId, draft.newAttachments ?? draft.attachments);
      return draft.draftId;
    }
    let id;
    if (draft.original && draft.mode !== 'new') {
      const action = { reply: 'createReply', replyAll: 'createReplyAll', forward: 'createForward' }[draft.mode];
      const d = await this.api(`/me/messages/${draft.original.id}/${action}`, { method: 'POST', body: {} });
      id = d.id;
      // Keep Outlook's quoted original under what the user wrote.
      const full = await this.api(`/me/messages/${id}?$select=body`, { headers: { Prefer: 'outlook.body-content-type="html"' } });
      const quoted = full.body?.content || '';
      await this.api(`/me/messages/${id}`, { method: 'PATCH', body: { ...fields, body: { contentType: 'HTML', content: `${this.bodyHtml(draft)}<br>${quoted}` } } });
    } else {
      const d = await this.api('/me/messages', { method: 'POST', body: { ...fields, body: { contentType: 'HTML', content: this.bodyHtml(draft) } } });
      id = d.id;
    }
    await this.attach(id, draft.attachments);
    return id;
  }

  async send(draft) {
    const id = await this.saveDraft(draft);
    await this.api(`/me/messages/${id}/send`, { method: 'POST' });
  }

  async deleteDraft(draftId) { await this.api(`/me/messages/${draftId}`, { method: 'DELETE' }); }

  // ----- snooze -----
  async snooze(msg, at) {
    const cats = (msg.categories || []).filter((c) => !isSnoozeCategory(c));
    await this.api(`/me/messages/${msg.id}`, { method: 'PATCH', body: { categories: [...cats, snoozeCategory(at)] } });
    return this.move(msg.id, await this.folderId(SNOOZE_ROOT));
  }

  async unsnooze(msg) {
    const newId = await this.move(msg.id, 'inbox');
    const cats = (msg.categories || []).filter((c) => !isSnoozeCategory(c));
    await this.api(`/me/messages/${newId}`, { method: 'PATCH', body: { categories: cats } });
    return newId;
  }

  snoozeUntil(msg) {
    for (const c of msg.categories || []) { const t = parseSnoozeCategory(c); if (t) return t; }
    return null;
  }

  async processSnoozes(now = Date.now()) {
    const folder = await this.folderId(SNOOZE_ROOT, false);
    if (!folder) return 0;
    const data = await this.api(`/me/mailFolders/${folder}/messages?$top=200&$select=id,categories`);
    const due = (data.value || []).filter((m) => { const t = (m.categories || []).map(parseSnoozeCategory).find(Boolean); return !t || t <= now; });
    await pool(due, 4, (m) => this.unsnooze(m));
    return due.length;
  }

  // ----- rules on the provider -----
  async readProviderRules() {
    await this.loadFolders(true);
    const data = await this.api('/me/mailFolders/inbox/messageRules');
    return outlookRulesToRules((data.value || []).filter((r) => !isAppOutlookRule(r)), this.folderNames);
  }

  async pushRules(rules) {
    const data = await this.api('/me/mailFolders/inbox/messageRules');
    const existing = data.value || [];
    for (const r of existing.filter(isAppOutlookRule)) await this.api(`/me/mailFolders/inbox/messageRules/${r.id}`, { method: 'DELETE' }).catch(() => {});
    let seq = Math.max(0, ...existing.filter((r) => !isAppOutlookRule(r)).map((r) => r.sequence || 0)) + 1;
    let created = 0;
    const skipped = [];
    for (const rule of rules) {
      if (!rule.enabled || !rule.actions.moveTo) continue;
      const folder = await this.destinationFor(rule.actions.moveTo);
      const out = toOutlookRules(rule, folder, seq);
      skipped.push(...out.skipped);
      for (const r of out.rules) {
        try { await this.api('/me/mailFolders/inbox/messageRules', { method: 'POST', body: r }); created += 1; } catch (e) { skipped.push(`${r.displayName}: ${e.message}`); }
      }
      seq += out.rules.length;
    }
    return { created, skipped };
  }

  // ----- calendar -----
  normalizeEvent(e) {
    const utc = (s) => Date.parse(/Z$|[+-]\d\d:\d\d$/.test(s) ? s : `${s}Z`);
    return {
      key: `${this.account.id}:${e.id}`, accountId: this.account.id, provider: 'microsoft', id: e.id,
      title: e.subject || '(no title)', location: e.location?.displayName || '', link: e.webLink || '',
      start: utc(e.start?.dateTime), end: utc(e.end?.dateTime), allDay: !!e.isAllDay,
      response: e.isOrganizer ? 'organizer' : ({ accepted: 'accepted', tentativelyAccepted: 'tentative', declined: 'declined' }[e.responseStatus?.response] || 'needsAction'),
    };
  }

  async listEvents(timeMin, timeMax) {
    const p = new URLSearchParams({ startDateTime: new Date(timeMin).toISOString(), endDateTime: new Date(timeMax).toISOString(), $top: '200', $orderby: 'start/dateTime', $select: 'id,subject,start,end,location,isAllDay,webLink,responseStatus,isOrganizer,isCancelled' });
    const data = await this.api(`/me/calendarView?${p}`, { headers: { Prefer: 'outlook.timezone="UTC"' } });
    return (data.value || []).filter((e) => !e.isCancelled).map((e) => this.normalizeEvent(e));
  }

  async respondToInvite(invite, response) {
    const action = { accepted: 'accept', tentative: 'tentativelyAccept', declined: 'decline' }[response];
    await this.api(`/me/events/${invite.eventId}/${action}`, { method: 'POST', body: { sendResponse: true } });
  }

  async createEvent({ title, start, end, location, description }) {
    const iso = (t) => new Date(t).toISOString().replace('Z', '');
    const e = await this.api('/me/events', { method: 'POST', headers: { Prefer: 'outlook.timezone="UTC"' }, body: { subject: title, start: { dateTime: iso(start), timeZone: 'UTC' }, end: { dateTime: iso(end), timeZone: 'UTC' }, location: { displayName: location || '' }, body: { contentType: 'Text', content: description || '' } } });
    return this.normalizeEvent(e);
  }

  // ----- contacts -----
  async listContacts() {
    const out = [];
    let url = `${API}/me/contacts?$top=500&$select=displayName,emailAddresses`;
    while (url && out.length < 5000) {
      const data = await this.api(url).catch(() => ({}));
      for (const c of data.value || []) for (const e of c.emailAddresses || []) if (e.address) out.push({ name: c.displayName || e.name || '', email: e.address.toLowerCase(), source: this.account.email });
      url = data['@odata.nextLink'];
    }
    const people = await this.api('/me/people?$top=200&$select=displayName,scoredEmailAddresses').catch(() => ({}));
    for (const p of people.value || []) for (const e of p.scoredEmailAddresses || []) if (e.address) out.push({ name: p.displayName || '', email: e.address.toLowerCase(), source: this.account.email });
    return out;
  }
}
