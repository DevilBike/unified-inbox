import { $, $$, esc, toast, showError, openDialog, timeLabel, icon, dialogOpen } from './dom.js';
import * as svc from '../service.js';
import { FOLDERS, folderName } from '../core/folders.js';
import { NeedsSignIn } from '../auth.js';
import { renderMessage } from './message.js';

export const MAIL_VIEWS = [
  ...FOLDERS.map((f) => ({ key: f.key, name: f.name })),
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
    const who = m.from?.name || m.from?.address || '';
    return `<button class="row ${m.unread ? 'unread' : ''} ${mail.selected === m.key ? 'sel' : ''}" data-key="${esc(m.key)}">
      <span class="unread-dot">${m.unread ? '<span></span>' : ''}</span>
      <span class="col">
        <span class="top"><span class="who">${esc(who)}</span>${m.hasAttachments ? icon('clip', 'icon') : ''}<span class="time">${esc(timeLabel(m.date))}</span></span>
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

export function renderReader(full) {
  const reader = $('#reader');
  const inView = (v) => mail.view === v || full.view === v;
  reader.innerHTML = `
    <div class="reader-actions">
      <button class="btn small back-btn" data-a="back">${icon('back')} Back</button>
      <button class="btn small" data-a="move">Move <span class="kbd">V</span></button>
      <button class="btn small" data-a="always" title="Make a rule for this sender">Always file sender <span class="kbd">A</span></button>
      ${inView('inbox') ? '<button class="btn small" data-a="archive">Archive <span class="kbd">E</span></button>' : ''}
      <button class="btn small" data-a="unread">Mark unread <span class="kbd">U</span></button>
      ${inView('junk') ? '<button class="btn small" data-a="notSpam">Not junk</button>' : '<button class="btn small" data-a="spam">Junk <span class="kbd">!</span></button>'}
      ${inView('trash') ? '' : '<button class="btn small danger" data-a="trash">Delete <span class="kbd">#</span></button>'}
    </div>
    <div class="reader-body" id="readerBody"></div>`;
  renderMessage($('#readerBody'), full);
  reader.querySelectorAll('[data-a]').forEach((b) => { b.onclick = () => doAction(b.dataset.a); });
}

function removeSelected() {
  const idx = mail.messages.findIndex((m) => m.key === mail.selected);
  if (idx < 0) return;
  mail.messages.splice(idx, 1);
  const next = mail.messages[idx] || mail.messages[idx - 1];
  renderList();
  if (next) select(next.key);
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
      case 'unread': await svc.act('read', target, false); msg.unread = true; renderList(); return;
      case 'move': { const to = await pickFolder(full.view); if (!to) return; await svc.act('move', target, to); toast(`Moved to ${folderName(to)}`); break; }
      case 'always': {
        const addr = full.from?.address;
        if (!addr) { toast('This message has no sender address.'); return; }
        const to = await pickFolder('inbox', `Always put mail from ${addr} in`);
        if (!to) return;
        await svc.fileSenderAlways(addr, to);
        if (to !== full.view) await svc.act('move', target, to);
        toast(`Rule saved: ${addr} → ${folderName(to)}. Use “Apply to Gmail & Outlook” on the Rules page to make it permanent.`, { timeout: 8000 });
        if (to === full.view) return;
        break;
      }
      case 'archive': await svc.act('archive', target); toast('Archived'); break;
      case 'trash': await svc.act('trash', target); toast('Moved to Trash'); break;
      case 'spam': await svc.act('spam', target); toast('Moved to Junk'); break;
      case 'notSpam': await svc.act('notSpam', target); toast('Moved to Inbox'); break;
      default: return;
    }
    removeSelected();
  } catch (e) { showError(e); }
}

export function pickFolder(current, title = 'Move to') {
  return openDialog((d, close) => {
    const opts = FOLDERS.filter((f) => f.key !== current);
    d.innerHTML = `<div class="dlg"><header><h2>${esc(title)}</h2></header><div class="menu-list">${opts.map((f, i) => `<button class="btn" data-k="${f.key}">${icon(f.key)} ${esc(f.name)} <span class="kbd" style="margin-left:auto">${i + 1}</span></button>`).join('')}</div>
      <footer><button class="btn" data-x>Cancel</button></footer></div>`;
    d.querySelectorAll('[data-k]').forEach((b) => { b.onclick = () => close(b.dataset.k); });
    d.querySelector('[data-x]').onclick = () => close(null);
    d.addEventListener('keydown', (e) => { const n = Number(e.key); if (n >= 1 && n <= opts.length) { e.preventDefault(); close(opts[n - 1].key); } });
  });
}

// ---------- keyboard ----------
export function handleMailKey(e) {
  if (dialogOpen()) return false;
  const k = e.key;
  const idx = mail.messages.findIndex((m) => m.key === mail.selected);
  const map = { e: 'archive', '#': 'trash', Delete: 'trash', v: 'move', a: 'always', u: 'unread', '!': 'spam' };
  if (k === 'j' || k === 'ArrowDown') { const n = mail.messages[idx + 1] || mail.messages[0]; if (n) select(n.key); return true; }
  if (k === 'k' || k === 'ArrowUp') { const n = mail.messages[Math.max(0, idx - 1)]; if (n) select(n.key); return true; }
  if (k === 'Escape' && mail.selected) { doAction('back'); return true; }
  if (map[k] && mail.full) { doAction(map[k]); return true; }
  return false;
}
