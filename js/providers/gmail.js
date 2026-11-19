// Gmail + Google Calendar + Google Contacts adapter.
import { apiFetch, pool } from './http.js';
import { TARGET_FOLDERS, folderName } from '../core/folders.js';
import { getHeader, parseAddress, parseAddressList, extractGmailParts, buildRawMessage, textToBase64Url, base64UrlDecodeText, parseIcsInvite } from '../core/mime.js';
import { toGmailFilter } from '../core/compile.js';
import { gmailApiFiltersToEntries, gmailEntriesToRules } from '../core/importers.js';
import { SNOOZE_ROOT, snoozeLabelName, parseSnoozeLabel } from '../core/snooze.js';

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const CAL = 'https://www.googleapis.com/calendar/v3';
const PEOPLE = 'https://people.googleapis.com/v1';
const META_HEADERS = ['From', 'To', 'Cc', 'Subject', 'Date', 'List-Unsubscribe', 'Message-ID', 'References', 'In-Reply-To'];

const SYSTEM_VIEWS = { inbox: 'INBOX', flagged: 'STARRED', drafts: 'DRAFT', sent: 'SENT', junk: 'SPAM', trash: 'TRASH' };

export class GmailAdapter {
  constructor(account, ctx) {
    this.account = account;
    this.ctx = { ...ctx, account };
    this.labels = null; // name -> id
  }

  api(path, opts) { return apiFetch(this.ctx, path.startsWith('http') ? path : `${API}${path}`, opts); }

  static async profile(ctx) {
    return apiFetch(ctx, `${API}/profile`);
  }

  // ----- labels / folders -----
  async loadLabels(force = false) {
    if (this.labels && !force) return this.labels;
    const data = await this.api('/labels');
    this.labels = {};
    this.labelNames = {};
    for (const l of data.labels || []) { this.labels[l.name.toLowerCase()] = l.id; this.labelNames[l.id] = l.name; }
    return this.labels;
  }

  async labelId(name, create = true) {
    await this.loadLabels();
    const id = this.labels[name.toLowerCase()];
    if (id || !create) return id || null;
    const l = await this.api('/labels', { method: 'POST', body: { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' } });
    this.labels[name.toLowerCase()] = l.id;
    this.labelNames[l.id] = l.name;
    return l.id;
  }

  async folderLabelId(folderKey) { return this.labelId(folderName(folderKey)); }

  async ensureFolders() {
    for (const f of TARGET_FOLDERS) await this.labelId(f.name);
    await this.labelId(SNOOZE_ROOT);
  }

  async folderLabelIds() {
    const ids = [];
    for (const f of TARGET_FOLDERS) { const id = await this.labelId(f.name, false); if (id) ids.push(id); }
    return ids;
  }

  // ----- messages -----
  normalize(m, view) {
    const headers = m.payload?.headers || [];
    const labelIds = m.labelIds || [];
    return {
      key: `${this.account.id}:${m.id}`,
      accountId: this.account.id,
      provider: 'google',
      id: m.id,
      threadId: m.threadId,
      view,
      from: parseAddress(getHeader(headers, 'From')),
      to: parseAddressList(getHeader(headers, 'To')),
      cc: parseAddressList(getHeader(headers, 'Cc')),
      subject: getHeader(headers, 'Subject') || '(no subject)',
      snippet: decodeEntities(m.snippet || ''),
      date: Number(m.internalDate) || Date.parse(getHeader(headers, 'Date')) || Date.now(),
      unread: labelIds.includes('UNREAD'),
      flagged: labelIds.includes('STARRED'),
      bulk: labelIds.includes('CATEGORY_PROMOTIONS') || labelIds.includes('CATEGORY_SOCIAL'),
      hasAttachments: /multipart\/mixed/i.test(m.payload?.mimeType || ''),
      labelIds,
      messageId: getHeader(headers, 'Message-ID'),
      references: getHeader(headers, 'References'),
    };
  }

  async getMeta(id, view) {
    const q = new URLSearchParams({ format: 'metadata' });
    META_HEADERS.forEach((h) => q.append('metadataHeaders', h));
    const m = await this.api(`/messages/${id}?${q}`);
    return this.normalize(m, view);
  }

  async listIds({ labelIds = [], q = '', pageToken, max = 30, includeSpamTrash = false }) {
    const p = new URLSearchParams({ maxResults: String(max) });
    labelIds.forEach((l) => p.append('labelIds', l));
    if (q) p.set('q', q);
    if (pageToken) p.set('pageToken', pageToken);
    if (includeSpamTrash) p.set('includeSpamTrash', 'true');
    const data = await this.api(`/messages?${p}`);
    return { ids: (data.messages || []).map((m) => m.id), nextPageToken: data.nextPageToken || null };
  }

  async viewQuery(view) {
    if (SYSTEM_VIEWS[view]) return { labelIds: [SYSTEM_VIEWS[view]], includeSpamTrash: view === 'junk' || view === 'trash' };
    if (view === 'snoozed') { const id = await this.labelId(SNOOZE_ROOT); return { labelIds: [id] }; }
    const id = await this.folderLabelId(view);
    return { labelIds: [id] };
  }

  async list(view, { pageToken, max = 30 } = {}) {
    const query = await this.viewQuery(view);
    const { ids, nextPageToken } = await this.listIds({ ...query, pageToken, max });
    const messages = await pool(ids, 8, (id) => this.getMeta(id, view));
    return { messages, nextPageToken };
  }

  async search(q, { max = 30 } = {}) {
    const { ids } = await this.listIds({ q, max });
    return pool(ids, 8, (id) => this.getMeta(id, 'search'));
  }

  // Every inbox message received since `since` (ms), for cleanup.
  async listInboxSince(since, onProgress) {
    const ids = [];
    let pageToken;
    const q = since ? `after:${Math.floor(since / 1000)}` : '';
    do {
      const page = await this.listIds({ labelIds: ['INBOX'], q, pageToken, max: 500 });
      ids.push(...page.ids);
      pageToken = page.nextPageToken;
      onProgress?.({ found: ids.length, loaded: 0 });
    } while (pageToken);
    let loaded = 0;
    return pool(ids, 10, async (id) => {
      const m = await this.getMeta(id, 'inbox');
      loaded += 1;
      if (loaded % 25 === 0 || loaded === ids.length) onProgress?.({ found: ids.length, loaded });
      return m;
    });
  }

  async getFull(msg) {
    const m = await this.api(`/messages/${msg.id}?format=full`);
    const parts = extractGmailParts(m.payload);
    let invite = null;
    if (parts.calendar) {
      let ics = parts.calendar;
      if (typeof ics === 'object' && ics.attachmentId) {
        const a = await this.api(`/messages/${msg.id}/attachments/${ics.attachmentId}`);
        ics = base64UrlDecodeText(a.data);
      }
      invite = parseIcsInvite(ics);
      if (!invite.uid || invite.method !== 'REQUEST') invite = null;
    }
    return { ...this.normalize(m, msg.view), html: parts.html, text: parts.text, attachments: parts.attachments, invite };
  }

  async getAttachment(msg, att) {
    const a = await this.api(`/messages/${msg.id}/attachments/${att.id}`);
    const b64 = a.data.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: att.mimeType || 'application/octet-stream' });
  }

  modify(ids, add = [], remove = []) {
    if (!ids.length) return null;
    if (ids.length === 1) return this.api(`/messages/${ids[0]}/modify`, { method: 'POST', body: { addLabelIds: add, removeLabelIds: remove } });
    return this.api('/messages/batchModify', { method: 'POST', body: { ids, addLabelIds: add, removeLabelIds: remove } });
  }

  async markRead(msg, read = true) { await this.modify([msg.id], read ? [] : ['UNREAD'], read ? ['UNREAD'] : []); return msg.id; }
  async setFlag(msg, flagged) { await this.modify([msg.id], flagged ? ['STARRED'] : [], flagged ? [] : ['STARRED']); return msg.id; }
  async archive(msg) { await this.modify([msg.id], [], ['INBOX']); return msg.id; }
  async trash(msg) { await this.api(`/messages/${msg.id}/trash`, { method: 'POST' }); return msg.id; }
  async markSpam(msg) { await this.modify([msg.id], ['SPAM'], ['INBOX']); return msg.id; }
  async notSpam(msg) { await this.modify([msg.id], ['INBOX'], ['SPAM']); return msg.id; }

  async moveTo(msg, folderKey) {
    const all = await this.folderLabelIds();
    if (folderKey === 'inbox') { await this.modify([msg.id], ['INBOX'], all); return msg.id; }
    const id = await this.folderLabelId(folderKey);
    await this.modify([msg.id], [id], ['INBOX', ...all.filter((x) => x !== id)]);
    return msg.id;
  }

  async moveMany(msgs, folderKey) {
    const id = await this.folderLabelId(folderKey);
    const ids = msgs.map((m) => m.id);
    for (let i = 0; i < ids.length; i += 1000) await this.modify(ids.slice(i, i + 1000), [id], ['INBOX']);
    return ids.map((x) => ({ id: x, newId: x }));
  }

  async trashMany(msgs) {
    await pool(msgs, 8, (m) => this.api(`/messages/${m.id}/trash`, { method: 'POST' }));
    return msgs.map((m) => ({ id: m.id, newId: m.id }));
  }

  // Undo for cleanup: put messages back in the Inbox.
  async restoreMany(ids, from) {
    if (from === 'trash') {
      await pool(ids, 8, (id) => this.api(`/messages/${id}/untrash`, { method: 'POST' }));
      await this.modify(ids, ['INBOX'], []);
      return;
    }
    const label = await this.folderLabelId(from);
    for (let i = 0; i < ids.length; i += 1000) await this.modify(ids.slice(i, i + 1000), ['INBOX'], [label]);
  }

  // ----- compose -----
  // draft: { to, cc, bcc, subject, text, html, attachments:[{name,mimeType,base64}], mode: 'new'|'reply'|'replyAll'|'forward', original, draftId }
  buildRaw(draft) {
    const o = draft.original;
    return buildRawMessage({
      from: { name: this.account.name || '', address: this.account.email },
      to: draft.to, cc: draft.cc, bcc: draft.bcc, subject: draft.subject, text: draft.text, html: draft.html,
      inReplyTo: o && draft.mode !== 'forward' ? o.messageId : '',
      references: o && draft.mode !== 'forward' ? [o.references, o.messageId].filter(Boolean).join(' ') : '',
      attachments: draft.attachments || [],
    });
  }

  async send(draft) {
    const raw = textToBase64Url(this.buildRaw(draft));
    const threadId = draft.original && draft.mode !== 'forward' ? draft.original.threadId : undefined;
    if (draft.draftId) return this.api('/drafts/send', { method: 'POST', body: { id: draft.draftId, message: { raw, threadId } } });
    return this.api('/messages/send', { method: 'POST', body: { raw, threadId } });
  }

  async saveDraft(draft) {
    const raw = textToBase64Url(this.buildRaw(draft));
    const threadId = draft.original && draft.mode !== 'forward' ? draft.original.threadId : undefined;
    const body = { message: { raw, threadId } };
    const d = draft.draftId
      ? await this.api(`/drafts/${draft.draftId}`, { method: 'PUT', body: { id: draft.draftId, ...body } })
      : await this.api('/drafts', { method: 'POST', body });
    return d.id;
  }

  async draftIdForMessage(messageId) {
    let pageToken;
    do {
      const p = new URLSearchParams({ maxResults: '100' });
      if (pageToken) p.set('pageToken', pageToken);
      const data = await this.api(`/drafts?${p}`);
      const hit = (data.drafts || []).find((d) => d.message?.id === messageId);
      if (hit) return hit.id;
      pageToken = data.nextPageToken;
    } while (pageToken);
    return null;
  }

  async deleteDraft(draftId) { await this.api(`/drafts/${draftId}`, { method: 'DELETE' }); }

  // ----- snooze -----
  async snooze(msg, at) {
    const root = await this.labelId(SNOOZE_ROOT);
    const child = await this.labelId(snoozeLabelName(at));
    await this.modify([msg.id], [root, child], ['INBOX']);
    return msg.id;
  }

  async unsnooze(msg) {
    await this.loadLabels(true);
    const snoozeIds = Object.entries(this.labelNames).filter(([, n]) => n === SNOOZE_ROOT || n.startsWith(`${SNOOZE_ROOT}/`)).map(([id]) => id);
    const cur = (msg.labelIds || []).filter((id) => snoozeIds.includes(id));
    await this.modify([msg.id], ['INBOX'], cur.length ? cur : snoozeIds.slice(0, 1));
    return msg.id;
  }

  snoozeUntil(msg) {
    for (const id of msg.labelIds || []) { const t = parseSnoozeLabel(this.labelNames?.[id]); if (t) return t; }
    return null;
  }

  // Bring back everything whose snooze time has passed. Returns count.
  async processSnoozes(now = Date.now()) {
    await this.loadLabels(true);
    const root = this.labels[SNOOZE_ROOT.toLowerCase()];
    let count = 0;
    for (const [id, name] of Object.entries(this.labelNames)) {
      const t = parseSnoozeLabel(name);
      if (!t || t > now) continue;
      const { ids } = await this.listIds({ labelIds: [id], max: 500 });
      if (ids.length) await this.modify(ids, ['INBOX'], [id, root].filter(Boolean));
      count += ids.length;
      await this.api(`/labels/${id}`, { method: 'DELETE' }).catch(() => {});
    }
    return count;
  }

  // ----- rules on the provider -----
  async readProviderRules() {
    await this.loadLabels(true);
    const data = await this.api('/settings/filters');
    return gmailEntriesToRules(gmailApiFiltersToEntries(data.filter || [], this.labelNames));
  }

  // Replace the filters this app created before with fresh ones.
  async pushRules(rules) {
    const previous = this.account.pushedFilterIds || [];
    for (const id of previous) await this.api(`/settings/filters/${id}`, { method: 'DELETE' }).catch(() => {});
    const created = [];
    const skipped = [];
    for (const rule of rules) {
      if (!rule.enabled || !rule.actions.moveTo) continue;
      const labelId = await this.folderLabelId(rule.actions.moveTo);
      const filter = toGmailFilter(rule, labelId);
      if (!filter) { skipped.push(`${rule.name}: nothing Gmail can match on`); continue; }
      try {
        const f = await this.api('/settings/filters', { method: 'POST', body: filter });
        created.push(f.id);
      } catch (e) {
        skipped.push(`${rule.name}: ${e.message}`);
      }
    }
    this.account.pushedFilterIds = created;
    await this.ctx.saveAccount?.(this.account);
    return { created: created.length, skipped };
  }

  // ----- calendar -----
  normalizeEvent(e) {
    const allDay = !!e.start?.date;
    const me = (e.attendees || []).find((a) => a.self);
    return {
      key: `${this.account.id}:${e.id}`, accountId: this.account.id, provider: 'google', id: e.id,
      title: e.summary || '(no title)', location: e.location || '', link: e.htmlLink || '',
      start: Date.parse(e.start?.dateTime || `${e.start?.date}T00:00:00`), end: Date.parse(e.end?.dateTime || `${e.end?.date}T00:00:00`), allDay,
      response: me?.responseStatus || (e.organizer?.self ? 'organizer' : 'none'),
      status: e.status,
    };
  }

  async listEvents(timeMin, timeMax) {
    const p = new URLSearchParams({ singleEvents: 'true', orderBy: 'startTime', timeMin: new Date(timeMin).toISOString(), timeMax: new Date(timeMax).toISOString(), maxResults: '250' });
    const data = await apiFetch(this.ctx, `${CAL}/calendars/primary/events?${p}`);
    return (data.items || []).filter((e) => e.status !== 'cancelled').map((e) => this.normalizeEvent(e));
  }

  // response: 'accepted' | 'tentative' | 'declined'
  async respondToInvite(invite, response) {
    const p = new URLSearchParams({ iCalUID: invite.uid });
    const data = await apiFetch(this.ctx, `${CAL}/calendars/primary/events?${p}`);
    const ev = (data.items || [])[0];
    if (!ev) throw new Error('This invite isn’t on your Google Calendar yet. Open it in Google Calendar to respond.');
    const attendees = (ev.attendees || []).map((a) => (a.self || a.email?.toLowerCase() === this.account.email ? { ...a, responseStatus: response } : a));
    await apiFetch(this.ctx, `${CAL}/calendars/primary/events/${ev.id}?sendUpdates=all`, { method: 'PATCH', body: { attendees } });
  }

  async createEvent({ title, start, end, location, description }) {
    const body = { summary: title, location, description, start: { dateTime: new Date(start).toISOString() }, end: { dateTime: new Date(end).toISOString() } };
    const e = await apiFetch(this.ctx, `${CAL}/calendars/primary/events`, { method: 'POST', body });
    return this.normalizeEvent(e);
  }

  // ----- contacts -----
  async listContacts() {
    const out = [];
    const grab = async (url, key) => {
      let pageToken;
      do {
        const data = await apiFetch(this.ctx, `${url}${pageToken ? `&pageToken=${pageToken}` : ''}`);
        for (const p of data[key] || []) {
          const name = p.names?.[0]?.displayName || '';
          for (const e of p.emailAddresses || []) if (e.value) out.push({ name, email: e.value.toLowerCase(), source: this.account.email });
        }
        pageToken = data.nextPageToken;
      } while (pageToken && out.length < 5000);
    };
    await grab(`${PEOPLE}/people/me/connections?personFields=names,emailAddresses&pageSize=1000`, 'connections').catch(() => {});
    await grab(`${PEOPLE}/otherContacts?readMask=names,emailAddresses&pageSize=1000`, 'otherContacts').catch(() => {});
    return out;
  }
}

function decodeEntities(s) {
  return s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
