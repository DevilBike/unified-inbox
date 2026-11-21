import { $, $$, esc, toast, showError, icon, dialogOpen } from './ui/dom.js';
import * as svc from './service.js';
import { MAIL_VIEWS, mail, showMail, refresh, handleMailKey, shortName } from './ui/mail.js';
import { showRules, showCleanup, showSettings } from './ui/pages.js';
import { showNotes } from './ui/notes.js';
import { signInFlow } from './ui/signin.js';
import { checkForUpdate, installUpdate } from './update.js';
import { api } from './api.js';

const app = $('#app');

// ---------- navigation ----------
function route() {
  const hash = location.hash.replace(/^#\/?/, '') || 'cleanup';
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
  const item = (href, name, active, ic, extra = '') => `<a class="item ${active ? 'active' : ''}" href="${href}" ${active ? 'aria-current="page"' : ''}>${icon(ic)}<span>${esc(name)}</span>${extra}</a>`;
  $('#nav').innerHTML = `
    <div><h2>Clean up</h2>
      ${item('#/cleanup', 'Clean up inboxes', r.section === 'cleanup', 'cleanup')}
      ${item('#/rules', 'Rules & import', r.section === 'rules', 'rules')}</div>
    <div><h2>Read and sort</h2>${MAIL_VIEWS.map((v) => item(link(v.key), v.name, isMail && r.sub === v.key, v.key)).join('')}</div>
    <div><h2>Mailboxes</h2>
      <a class="item ${acct === 'all' ? 'active' : ''}" href="#/mail/${isMail ? r.sub : 'inbox'}"><span class="dot" style="background:#E7E9EE"></span><span>All mailboxes</span></a>
      ${svc.state.accounts.map((a) => `<a class="item ${acct === a.id ? 'active' : ''}" href="#/mail/${isMail ? r.sub : 'inbox'}?acct=${encodeURIComponent(a.id)}" title="${esc(a.email)}"><span class="dot" style="background:${esc(a.color)}"></span><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(shortName(a))}</span>${a.status !== 'ok' ? '<span class="count" style="color:var(--warn)">!</span>' : ''}</a>`).join('')}
    </div>
    <div><h2>More</h2>
      ${item('#/notes', 'Notes for Claude', r.section === 'notes', 'drafts')}
      ${item('#/settings', 'Settings', r.section === 'settings', 'settings')}
    </div>
    <div class="shortcuts"><div><b>J / K</b> next · prev</div><div><b>V</b> move · <b>A</b> always file sender</div><div><b>E</b> archive · <b>#</b> delete · <b>!</b> junk</div><div><b>/</b> search</div></div>`;
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
    } else if (r.section === 'rules') showRules();
    else if (r.section === 'cleanup') await showCleanup();
    else if (r.section === 'settings') await showSettings(r.params);
    else if (r.section === 'notes') await showNotes(r.params);
    else location.hash = '#/cleanup';
  } catch (e) { showError(e); }
}

// ---------- sign-in chip ----------
function updateReconnect() {
  const need = svc.accountsNeedingSignIn();
  const btn = $('#reconnectBtn');
  btn.hidden = !need.length;
  btn.textContent = need.length === 1 ? `Sign in to ${shortName(need[0])}` : `${need.length} mailboxes need sign-in`;
}
$('#reconnectBtn').onclick = () => {
  const need = svc.accountsNeedingSignIn();
  if (need.length === 1) signInFlow(need[0].provider, need[0].email).then((ok) => ok && render()); else location.hash = '#/settings';
};

// ---------- global UI ----------
$('#menuBtn').onclick = () => app.classList.toggle('nav-open');
document.addEventListener('click', (e) => {
  if (e.target.closest('#nav a')) app.classList.remove('nav-open');
  else if (app.classList.contains('nav-open') && !e.target.closest('#nav') && !e.target.closest('#menuBtn')) app.classList.remove('nav-open');
});
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
  const r = route();
  if ((r.section === 'mail' || r.section === 'search') && handleMailKey(e)) e.preventDefault();
});

svc.subscribe((event) => { if (event === 'accounts') { updateReconnect(); renderNav(); } });
window.addEventListener('hashchange', render);

// ---------- app updates ----------
async function refreshUpdateChip() {
  const u = await checkForUpdate();
  const btn = $('#updateBtn');
  btn.hidden = !u.available;
  if (u.available) btn.textContent = `Update to ${u.latest}`;
}
$('#updateBtn').onclick = async () => {
  $('#updateBtn').disabled = true;
  $('#updateBtn').textContent = 'Updating…';
  try { await installUpdate(); } catch (e) { showError(e); $('#updateBtn').disabled = false; refreshUpdateChip(); }
};

// ---------- is the app still running? ----------
async function checkAlive() {
  try { await api('ping'); $('#offline').hidden = true; } catch { $('#offline').hidden = false; }
}

// Refresh the open folder every couple of minutes.
async function tick() {
  if (document.hidden || !svc.state.accounts.length) return;
  const r = route();
  if (r.section === 'mail' && !dialogOpen() && !mail.selected) refresh();
}

(async function start() {
  try { await svc.init(); } catch (e) { $('#offline').hidden = false; showError(e); return; }
  if (!svc.state.accounts.length && !location.hash.startsWith('#/settings')) location.hash = '#/settings';
  updateReconnect();
  await render();
  setInterval(tick, 120000);
  setInterval(checkAlive, 15000);
  refreshUpdateChip();
  setInterval(refreshUpdateChip, 60 * 60000);
})();
