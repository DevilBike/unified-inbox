import { $, $$, esc, toast, showError, icon, dialogOpen } from './ui/dom.js';
import * as svc from './service.js';
import { MAIL_VIEWS, mail, showMail, refresh, handleMailKey, shortName } from './ui/mail.js';
import { showCalendar, showContacts, showRules, showCleanup, showSettings } from './ui/pages.js';
import { openCompose } from './ui/compose.js';

const app = $('#app');

// ---------- navigation ----------
function route() {
  const hash = location.hash.replace(/^#\/?/, '') || 'mail/inbox';
  const [path, qs] = hash.split('?');
  const params = new URLSearchParams(qs || '');
  const [section, sub] = path.split('/');
  return { section, sub, params };
}

function renderNav() {
  const r = route();
  const isMail = r.section === 'mail';
  const acct = r.params.get('acct') || 'all';
  const link = (view) => `#/mail/${view}${acct !== 'all' ? `?acct=${encodeURIComponent(acct)}` : ''}`;
  const mainViews = MAIL_VIEWS.slice(0, 6);
  const otherViews = MAIL_VIEWS.slice(6);
  const item = (href, name, active, ic, extra = '') => `<a class="item ${active ? 'active' : ''}" href="${href}" ${active ? 'aria-current="page"' : ''}>${icon(ic)}<span>${esc(name)}</span>${extra}</a>`;
  $('#nav').innerHTML = `
    <div><h2>Folders</h2>${mainViews.map((v) => item(link(v.key), v.name, isMail && r.sub === v.key, v.key)).join('')}</div>
    <div>${otherViews.map((v) => item(link(v.key), v.name, isMail && r.sub === v.key, v.key)).join('')}</div>
    <div><h2>Mailboxes</h2>
      <a class="item ${acct === 'all' ? 'active' : ''}" href="#/mail/${isMail ? r.sub : 'inbox'}"><span class="dot" style="background:#E7E9EE"></span><span>All mailboxes</span></a>
      ${svc.state.accounts.map((a) => `<a class="item ${acct === a.id ? 'active' : ''}" href="#/mail/${isMail ? r.sub : 'inbox'}?acct=${encodeURIComponent(a.id)}" title="${esc(a.email)}"><span class="dot" style="background:${esc(a.color)}"></span><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(shortName(a))}</span>${a.status === 'needs-signin' || a.status === 'needs-password' ? '<span class="count" style="color:var(--warn)">!</span>' : ''}</a>`).join('')}
    </div>
    <div><h2>More</h2>
      ${item('#/calendar', 'Calendar', r.section === 'calendar', 'calendar')}
      ${item('#/contacts', 'Contacts', r.section === 'contacts', 'contacts')}
      ${item('#/rules', 'Rules & import', r.section === 'rules', 'rules')}
      ${item('#/cleanup', 'Clean up', r.section === 'cleanup', 'cleanup')}
      ${item('#/settings', 'Settings', r.section === 'settings', 'settings')}
    </div>
    <div class="shortcuts"><div><b>J / K</b> next · prev</div><div><b>E</b> archive · <b>R</b> reply · <b>#</b> delete</div><div><b>V</b> move · <b>H</b> snooze · <b>S</b> flag</div><div><b>C</b> compose · <b>/</b> search</div></div>`;
  $$('#nav a').forEach((a) => a.addEventListener('click', () => app.classList.remove('nav-open')));
}

async function render() {
  const r = route();
  renderNav();
  try {
    if (r.section === 'mail') {
      const view = MAIL_VIEWS.some((v) => v.key === r.sub) ? r.sub : 'inbox';
      await showMail(view, r.params.get('acct') || 'all');
    } else if (r.section === 'search') {
      $('#searchInput').value = r.params.get('q') || '';
      await showMail('search', r.params.get('acct') || 'all', r.params.get('q') || '');
    } else if (r.section === 'calendar') await showCalendar();
    else if (r.section === 'contacts') await showContacts();
    else if (r.section === 'rules') showRules();
    else if (r.section === 'cleanup') await showCleanup();
    else if (r.section === 'settings') showSettings();
    else location.hash = '#/mail/inbox';
  } catch (e) { showError(e); }
}

// ---------- reconnect chip ----------
function updateReconnect() {
  const need = svc.accountsNeedingSignIn();
  const btn = $('#reconnectBtn');
  btn.hidden = !need.length;
  btn.textContent = need.length === 1 ? `Reconnect ${shortName(need[0])}` : `Reconnect ${need.length} mailboxes`;
}

$('#reconnectBtn').onclick = async () => {
  try {
    const { ok, failed } = await svc.reconnect(svc.accountsNeedingSignIn().filter((a) => a.status !== 'needs-password'));
    const pw = svc.state.accounts.filter((a) => a.status === 'needs-password');
    if (pw.length && !ok.length && !failed.length) {
      const r = await svc.reconnect(pw, { interactive: true });
      if (r.failed.length) toast(r.failed[0].error); else render();
      return;
    }
    if (failed.length) {
      toast(`${failed.length} mailbox${failed.length > 1 ? 'es' : ''} need${failed.length > 1 ? '' : 's'} you to sign in`, {
        action: 'Sign in', timeout: 15000,
        onAction: async () => { try { const r = await svc.reconnect(failed.map((f) => f.account), { interactive: true }); if (r.failed.length) toast(r.failed[0].error); else render(); } catch (e) { showError(e); } },
      });
    }
    if (ok.length) { toast(`Reconnected ${ok.length}`); if (route().section === 'mail' || route().section === 'search') refresh(); }
  } catch (e) { showError(e); }
};

// Quietly reconnect on your next tap. Browsers only allow the sign-in window
// right after a tap or click, so this rides along with whatever you tap.
let autoBusy = false;
let lastAuto = 0;
document.addEventListener('pointerdown', (e) => {
  if (!svc.state.settings.autoReconnect || autoBusy || Date.now() - lastAuto < 60000) return;
  if (e.target.closest('#reconnectBtn, dialog')) return;
  const list = svc.autoReconnectCandidates();
  if (!list.length) return;
  autoBusy = true;
  lastAuto = Date.now();
  svc.reconnect(list).then(({ ok, failed }) => {
    if (failed.length) toast(`${failed.length} mailbox${failed.length > 1 ? 'es need' : ' needs'} you to sign in. Tap Reconnect at the top.`, { timeout: 8000 });
    if (ok.length && (route().section === 'mail' || route().section === 'search') && !mail.selected) refresh();
  }).catch(() => {}).finally(() => { autoBusy = false; });
}, true);

// ---------- global UI ----------
$('#menuBtn').onclick = () => app.classList.toggle('nav-open');
document.addEventListener('click', (e) => { if (app.classList.contains('nav-open') && !e.target.closest('#nav') && !e.target.closest('#menuBtn')) app.classList.remove('nav-open'); });
$('#composeBtn').onclick = () => openCompose().then((sent) => sent && mail.view === 'sent' && refresh());
$('#fab').onclick = () => openCompose();
$('#searchForm').onsubmit = (e) => {
  e.preventDefault();
  const q = $('#searchInput').value.trim();
  if (q) location.hash = `#/search?q=${encodeURIComponent(q)}`;
};

document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target;
  if (t.closest('input, textarea, select, [contenteditable]') || dialogOpen()) {
    if (e.key === 'Escape' && t.id === 'searchInput') t.blur();
    return;
  }
  if (e.key === '/') { e.preventDefault(); $('#searchInput').focus(); return; }
  if (e.key === 'c') { e.preventDefault(); openCompose(); return; }
  if (e.key === 'g') { location.hash = '#/mail/inbox'; return; }
  const r = route();
  if ((r.section === 'mail' || r.section === 'search') && handleMailKey(e)) e.preventDefault();
});

svc.subscribe((event, data) => {
  if (event === 'accounts') { updateReconnect(); renderNav(); }
  if (event === 'swept' && data.count) toast(`Filed ${data.count} new message${data.count > 1 ? 's' : ''} from ${shortName(data.account)}`);
});

window.addEventListener('hashchange', render);

// Refresh the open mail view every minute; snoozes and contacts less often.
let lastSnooze = 0;
async function tick() {
  if (document.hidden || !svc.state.accounts.length) return;
  updateReconnect();
  if (Date.now() - lastSnooze > 5 * 60000) {
    lastSnooze = Date.now();
    const n = await svc.processSnoozesEverywhere().catch(() => 0);
    if (n) toast(`${n} snoozed message${n > 1 ? 's are' : ' is'} back in your Inbox`);
  }
  const r = route();
  if (r.section === 'mail' && !dialogOpen() && !mail.selected) refresh();
}

(async function start() {
  await svc.init();
  if (!svc.state.accounts.length && !location.hash) location.hash = '#/settings';
  updateReconnect();
  await render();
  setInterval(tick, 60000);
  setTimeout(tick, 3000);
  svc.refreshContacts().catch(() => {});
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
