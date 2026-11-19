import { $, $$, esc, toast, showError, openDialog, timeLabel, fullTime, fmtBytes, icon, dialogOpen } from './dom.js';
import * as svc from '../service.js';
import { FOLDERS, TARGET_FOLDERS, folderName } from '../core/folders.js';
import { phishingHint } from '../core/phish.js';
import { snoozePresets } from '../core/snooze.js';
import { openCompose } from './compose.js';
import { NeedsSignIn } from '../auth.js';

export const MAIL_VIEWS = [
  ...FOLDERS.map((f) => ({ key: f.key, name: f.name })),
  { key: 'snoozed', name: 'Snoozed' },
  { key: 'flagged', name: 'Flagged' },
  { key: 'drafts', name: 'Drafts' },
  { key: 'sent', name: 'Sent' },
  { key: 'junk', name: 'Junk' },
  { key: 'trash', name: 'Trash' },
];

export const mail = {
  view: 'inbox', acct: 'all', messages: [], selected: null, full: null, cursors: {}, query: '', loading: false, loadToken: 0,
};

const acctOf = (id) => svc.state.accounts.find((a) => a.id === id);
const viewName = (k) => (k === 'search' ? `Search: ${mail.query}` : MAIL_VIEWS.find((v) => v.key === k)?.name || k);

// ---------- list ----------
export async function showMail(view, acct = 'all', query = '') {
  $('#app').classList.remove('reading');
  mail.view = view; mail.acct = acct; mail.query = query;
  mail.selected = null; mail.full = null;
  renderMailShell();
  const token = ++mail.loadToken;
  if (view !== 'search') {
    const cached = await svc.loadView(view, acct, { cached: true });
    if (token !== mail.loadToken) return;
    if (cached.messages.length) { mail.messages = cached.messages; renderList(); }
  }
  await refresh(token);
}

export async function refresh(token = ++mail.loadToken) {
  if (!svc.state.accounts.length) { mail.messages = []; renderList(); return; }
  mail.loading = true; renderListHead();
  try {
    const res = mail.view === 'search' ? await svc.searchAll(mail.query, mail.acct) : await svc.loadView(mail.view, mail.acct);
    if (token !== mail.loadToken) return;
    mail.messages = res.messages;
    mail.cursors = res.cursors || {};
    reportErrors(res.errors);
  } catch (e) { showError(e); }
  mail.loading = false;
  if (token === mail.loadToken) renderList();
}

function reportErrors(errors = []) {
  const other = errors.filter((e) => !(e.error instanceof NeedsSignIn));
  for (const e of other) toast(`${e.account.email}: ${e.error.message}`, { timeout: 7000 });
}

function renderMailShell() {
  const main = $('#main');
  main.className = 'main';
  main.innerHTML = `<section class="list" aria-label="Messages"><div class="list-head"></div><div class="list-scroll" id="listScroll"></div></section>
    <article class="reader" id="reader" aria-label="Reading pane"><div class="empty" style="margin:auto">Select a message to read it.</div></article>`;
  renderListHead();
}

function renderListHead() {
  const head = $('.list-head');
  if (!head) return;
  const acct = mail.acct === 'all' ? 'all mailboxes' : acctOf(mail.acct)?.email || '';
  head.innerHTML = `<h1>${esc(viewName(mail.view))}</h1><span class="muted" style="font-size:13px">${mail.loading ? 'Updating…' : `${mail.messages.length} · ${esc(acct)}`}</span>`;
}

export function renderList() {
  renderListHead();
  const box = $('#listScroll');
  if (!box) return;
  if (!svc.state.accounts.length) {
    box.innerHTML = '<div class="empty">No mailboxes yet. <a href="#/settings">Add one in Settings</a>.</div>';
    return;
  }
  if (!mail.messages.length) {
    box.innerHTML = `<div class="empty">${mail.loading ? 'Loading…' : mail.view === 'inbox' ? 'Nothing here. All caught up.' : 'Nothing here.'}</div>`;
    return;
  }
  const rows = mail.messages.map((m) => {
    const a = acctOf(m.accountId);
    const who = mail.view === 'sent' || mail.view === 'drafts' ? `To: ${(m.to || []).map((t) => t.name || t.address).join(', ')}` : (m.from?.name || m.from?.address || '');
    return `<button class="row ${m.unread ? 'unread' : ''} ${mail.selected === m.key ? 'sel' : ''}" data-key="${esc(m.key)}">
      <span class="unread-dot">${m.unread ? '<span></span>' : ''}</span>
      <span class="col">
        <span class="top"><span class="who">${esc(who)}</span>${m.flagged ? '<span class="tag" style="color:var(--warn)">Flagged</span>' : ''}${m.hasAttachments ? icon('clip', 'icon') : ''}<span class="time">${esc(timeLabel(m.date))}</span></span>
        <span class="subj">${esc(m.subject)}</span>
        <span class="meta"><span class="tag" style="color:${esc(a?.color || '#C9CDD6')}">${esc(shortName(a))}</span><span class="snip">${esc(m.snippet)}</span></span>
      </span></button>`;
  }).join('');
  const more = Object.values(mail.cursors).some(Boolean) ? '<div style="padding:14px;text-align:center"><button class="btn" id="moreBtn">Load more</button></div>' : '';
  box.innerHTML = rows + more;
  $$('.row', box).forEach((el) => { el.onclick = () => select(el.dataset.key); });
  $('#moreBtn')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    const res = await svc.loadMore(mail.view, mail.cursors);
    mail.cursors = res.cursors;
    const keys = new Set(mail.messages.map((m) => m.key));
    mail.messages = [...mail.messages, ...res.messages.filter((m) => !keys.has(m.key))].sort((a, b) => b.date - a.date);
    renderList();
  });
}

export function shortName(a) {
  if (!a) return '';
  const [user, domain] = a.email.split('@');
  return /gmail\.com$/.test(domain) ? user : domain;
}

// ---------- reader ----------
export async function select(key) {
  const msg = mail.messages.find((m) => m.key === key);
  if (!msg) return;
  if (mail.view === 'drafts') { editDraft(msg); return; }
  mail.selected = key;
  $$('.row').forEach((r) => r.classList.toggle('sel', r.dataset.key === key));
  $('#main').classList.add('reading'); $('#app').classList.add('reading');
  const reader = $('#reader');
  reader.innerHTML = '<div class="empty" style="margin:auto">Loading…</div>';
  try {
    const full = await svc.openMessage(msg);
    if (mail.selected !== key) return;
    msg.unread = false;
    $(`.row[data-key="${CSS.escape(key)}"]`)?.classList.remove('unread');
    $(`.row[data-key="${CSS.escape(key)}"] .unread-dot`)?.replaceChildren();
    mail.full = full;
    renderReader(full);
  } catch (e) {
    reader.innerHTML = `<div class="empty" style="margin:auto">Couldn’t open this message. ${esc(e.message)}</div>`;
  }
}

function frameDoc(full, allowImages) {
  const body = full.html || `<pre style="white-space:pre-wrap;font:14px/1.6 system-ui,sans-serif">${esc(full.text || full.snippet || '')}</pre>`;
  const img = allowImages ? 'img-src https: http: data:;' : 'img-src data:;';
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; ${img} style-src 'unsafe-inline'; font-src data: https:; media-src 'none'"><base target="_blank"><style>body{margin:0;padding:16px;font:14px/1.55 system-ui,sans-serif;color:#1b1d22;background:#fff;word-wrap:break-word}img{max-width:100%;height:auto}table{max-width:100%}</style></head><body>${body}</body></html>`;
}

function hasRemoteImages(html) { return /<img[^>]+src=["']?https?:/i.test(html || '') || /url\(["']?https?:/i.test(html || ''); }

export function renderReader(full, allowImages = svc.state.settings.remoteImages) {
  const reader = $('#reader');
  const a = acctOf(full.accountId);
  const hint = phishingHint(full.from, full.subject, full.snippet);
  const inView = (v) => mail.view === v || full.view === v;
  const moveTargets = FOLDERS.filter((f) => f.key !== full.view);
  reader.innerHTML = `
    <div class="reader-actions">
      <button class="btn small back-btn" data-a="back">${icon('back')} Back</button>
      <button class="btn small" data-a="reply">Reply <span class="kbd">R</span></button>
      <button class="btn small" data-a="replyAll">Reply all <span class="kbd">A</span></button>
      <button class="btn small" data-a="forward">Forward <span class="kbd">F</span></button>
      ${inView('inbox') || inView('snoozed') || inView('flagged') ? '<button class="btn small" data-a="archive">Archive <span class="kbd">E</span></button>' : ''}
      <button class="btn small" data-a="move">Move <span class="kbd">V</span></button>
      ${inView('snoozed') ? '<button class="btn small" data-a="unsnooze">Back to Inbox</button>' : '<button class="btn small" data-a="snooze">Snooze <span class="kbd">H</span></button>'}
      <button class="btn small" data-a="flag">${full.flagged ? 'Unflag' : 'Flag'} <span class="kbd">S</span></button>
      <button class="btn small" data-a="unread">Mark unread <span class="kbd">U</span></button>
      ${inView('junk') ? '<button class="btn small" data-a="notSpam">Not junk</button>' : '<button class="btn small" data-a="spam">Junk <span class="kbd">!</span></button>'}
      ${inView('trash') ? '' : '<button class="btn small danger" data-a="trash">Delete <span class="kbd">#</span></button>'}
    </div>
    <div class="reader-body">
      <h2>${esc(full.subject)}</h2>
      <div class="sender">
        <span class="avatar" style="color:${esc(a?.color || '#E7E9EE')}">${esc((full.from?.name || full.from?.address || '?').charAt(0).toUpperCase())}</span>
        <span style="display:flex;flex-direction:column;gap:2px;min-width:0">
          <span style="font-weight:600">${esc(full.from?.name || full.from?.address)} <span class="muted" style="font-weight:400">${full.from?.name ? `&lt;${esc(full.from.address)}&gt;` : ''}</span></span>
          <span class="muted" style="font-size:12px">to ${esc((full.to || []).map((t) => t.address).join(', ') || a?.email)}${full.cc?.length ? ` · cc ${esc(full.cc.map((t) => t.address).join(', '))}` : ''} · ${esc(fullTime(full.date))} · in ${esc(a?.email || '')}</span>
        </span>
      </div>
      ${full.snoozedUntil ? `<div class="banner info">Snoozed until ${esc(fullTime(full.snoozedUntil))}</div>` : ''}
      ${hint ? `<div class="banner warn" role="alert"><strong>Possible scam.</strong> ${esc(hint)}</div>` : ''}
      ${full.invite ? `<div class="banner info"><span style="flex:1">Invitation${full.invite.summary ? `: ${esc(full.invite.summary)}` : ''}</span>
        <button class="btn small" data-rsvp="accepted">Accept</button><button class="btn small" data-rsvp="tentative">Maybe</button><button class="btn small" data-rsvp="declined">Decline</button></div>` : ''}
      ${!allowImages && hasRemoteImages(full.html) ? '<div class="banner info"><span style="flex:1">Images are hidden to protect your privacy.</span><button class="btn small" data-a="images">Show images</button></div>' : ''}
      ${full.attachments?.filter((x) => !x.inline).length ? `<div class="attachments">${full.attachments.filter((x) => !x.inline).map((x, i) => `<button class="att" data-att="${i}">${icon('clip')} ${esc(x.name)} <span class="muted">${fmtBytes(x.size)}</span></button>`).join('')}</div>` : ''}
      <iframe class="mail-frame" title="Message" sandbox="allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer"></iframe>
      <form class="quick-reply" id="quickReply">
        <label for="qr" class="muted" style="font-size:12px">Quick reply from ${esc(a?.email || '')}</label>
        <textarea id="qr" class="input" rows="3" placeholder="Write a reply…"></textarea>
        <div style="display:flex;justify-content:flex-end;gap:8px"><button type="button" class="btn small" data-a="replyFull">Open full reply</button><button class="btn small primary">Send</button></div>
      </form>
    </div>`;
  reader.querySelector('iframe').srcdoc = frameDoc(full, allowImages);
  reader.querySelectorAll('[data-a]').forEach((b) => { b.onclick = () => doAction(b.dataset.a); });
  reader.querySelectorAll('[data-att]').forEach((b) => {
    const att = full.attachments.filter((x) => !x.inline)[Number(b.dataset.att)];
    b.onclick = () => svc.downloadAttachment(full, att).catch(showError);
  });
  reader.querySelectorAll('[data-rsvp]').forEach((b) => {
    b.onclick = async () => {
      try { await svc.respondToInvite(full, full.invite, b.dataset.rsvp); toast(`Response sent: ${b.textContent}`); } catch (e) { showError(e); }
    };
  });
  $('#quickReply').onsubmit = async (e) => {
    e.preventDefault();
    const text = $('#qr').value.trim();
    if (!text) { toast('Write something first.'); return; }
    try { await svc.sendDraft({ accountId: full.accountId, mode: 'reply', original: full, to: [full.from], cc: [], bcc: [], subject: /^re:/i.test(full.subject) ? full.subject : `Re: ${full.subject}`, text }); $('#qr').value = ''; toast('Reply sent'); } catch (err) { showError(err, 'Not sent: '); }
  };
}

function removeSelected() {
  const idx = mail.messages.findIndex((m) => m.key === mail.selected);
  if (idx < 0) return;
  mail.messages.splice(idx, 1);
  const next = mail.messages[idx] || mail.messages[idx - 1];
  renderList();
  if (next && window.matchMedia('(min-width: 861px)').matches) select(next.key);
  else { mail.selected = null; mail.full = null; $('#main').classList.remove('reading'); $('#app').classList.remove('reading'); $('#reader').innerHTML = '<div class="empty" style="margin:auto">Select a message to read it.</div>'; }
}

export async function doAction(action) {
  const full = mail.full;
  const msg = mail.messages.find((m) => m.key === mail.selected);
  if (!full || !msg) return;
  const target = { ...msg, ...full, view: msg.view };
  try {
    switch (action) {
      case 'back': mail.selected = null; $('#main').classList.remove('reading'); $('#app').classList.remove('reading'); return;
      case 'reply': case 'replyAll': case 'forward': openCompose({ mode: action, original: full }); return;
      case 'replyFull': openCompose({ mode: 'reply', original: full, text: $('#qr')?.value || '' }); return;
      case 'images': renderReader(full, true); return;
      case 'flag': await svc.act('flag', target, !full.flagged); full.flagged = !full.flagged; msg.flagged = full.flagged; renderReader(full); renderList(); return;
      case 'unread': await svc.act('read', target, false); msg.unread = true; renderList(); return;
      case 'move': { const to = await pickFolder(full.view); if (!to) return; await svc.act('move', target, to); toast(`Moved to ${folderName(to)}`); break; }
      case 'snooze': { const at = await pickSnooze(); if (!at) return; await svc.act('snooze', target, at); toast(`Snoozed until ${fullTime(at)}`); break; }
      case 'unsnooze': await svc.act('unsnooze', target); toast('Moved back to Inbox'); break;
      case 'archive': await svc.act('archive', target); toast('Archived'); break;
      case 'trash': await svc.act('trash', target); toast('Moved to Trash'); break;
      case 'spam': await svc.act('spam', target); toast('Moved to Junk'); break;
      case 'notSpam': await svc.act('notSpam', target); toast('Moved to Inbox'); break;
      default: return;
    }
    removeSelected();
  } catch (e) { showError(e); }
}

function pickFolder(current) {
  return openDialog((d, close) => {
    const opts = [...FOLDERS].filter((f) => f.key !== current);
    d.innerHTML = `<div class="dlg"><header><h2>Move to</h2></header><div class="menu-list">${opts.map((f, i) => `<button class="btn" data-k="${f.key}">${icon(f.key)} ${esc(f.name)} <span class="kbd" style="margin-left:auto">${i + 1}</span></button>`).join('')}</div>
      <footer><button class="btn" data-x>Cancel</button></footer></div>`;
    d.querySelectorAll('[data-k]').forEach((b) => { b.onclick = () => close(b.dataset.k); });
    d.querySelector('[data-x]').onclick = () => close(null);
    d.addEventListener('keydown', (e) => { const n = Number(e.key); if (n >= 1 && n <= opts.length) { e.preventDefault(); close(opts[n - 1].key); } });
  });
}

function pickSnooze() {
  return openDialog((d, close) => {
    const presets = snoozePresets();
    const local = new Date(Date.now() + 86400000); local.setMinutes(0, 0, 0);
    const iso = new Date(local - local.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    d.innerHTML = `<div class="dlg"><header><h2>Snooze until</h2></header><div class="menu-list">${presets.map((p, i) => `<button class="btn" data-t="${p.at}">${esc(p.label)} <span class="muted" style="margin-left:auto">${esc(fullTime(p.at))}</span></button>`).join('')}</div>
      <label class="field">Pick a date and time<input class="input" type="datetime-local" value="${iso}" data-custom></label>
      <footer><button class="btn" data-x>Cancel</button><button class="btn primary" data-ok>Snooze</button></footer></div>`;
    d.querySelectorAll('[data-t]').forEach((b) => { b.onclick = () => close(Number(b.dataset.t)); });
    d.querySelector('[data-x]').onclick = () => close(null);
    d.querySelector('[data-ok]').onclick = () => { const t = new Date(d.querySelector('[data-custom]').value).getTime(); if (!t || t < Date.now()) { toast('Pick a time in the future.'); return; } close(t); };
  });
}

async function editDraft(msg) {
  try {
    const full = await svc.openMessage(msg);
    const draftId = await svc.draftIdFor(msg);
    const { htmlToText } = await import('../core/mime.js');
    openCompose({ mode: 'new', accountId: msg.accountId, to: full.to, subject: full.subject, text: full.text || htmlToText(full.html), draftId })
      .then(() => refresh());
  } catch (e) { showError(e); }
}

// ---------- keyboard ----------
export function handleMailKey(e) {
  if (dialogOpen()) return false;
  const k = e.key;
  const idx = mail.messages.findIndex((m) => m.key === mail.selected);
  const map = { e: 'archive', '#': 'trash', Delete: 'trash', r: 'reply', a: 'replyAll', f: 'forward', s: 'flag', h: 'snooze', v: 'move', u: 'unread', '!': 'spam' };
  if (k === 'j' || k === 'ArrowDown') { const n = mail.messages[idx + 1] || mail.messages[0]; if (n) select(n.key); return true; }
  if (k === 'k' || k === 'ArrowUp') { const n = mail.messages[Math.max(0, idx - 1)]; if (n) select(n.key); return true; }
  if (k === 'Escape' && mail.selected) { doAction('back'); return true; }
  if (map[k] && mail.full) { doAction(map[k]); return true; }
  return false;
}

export function moveTargets() { return TARGET_FOLDERS; }
