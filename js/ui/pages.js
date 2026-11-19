import { $, $$, esc, toast, showError, openDialog, confirmDialog, fullTime, icon } from './dom.js';
import * as svc from '../service.js';
import { TARGET_FOLDERS, folderName } from '../core/folders.js';
import { normalizeRule, describeMatch, isCheckableHere } from '../core/rules.js';
import { gmailXmlToRules, parseRulesJson, exportRulesJson, mergeRules } from '../core/importers.js';
import { BUCKET_STAY, BUCKET_TRASH } from '../core/cleanup.js';
import { openCompose } from './compose.js';
import { shortName } from './mail.js';

const main = () => $('#main');
const acctOf = (id) => svc.state.accounts.find((a) => a.id === id);
function page(title, actions = '') {
  main().className = 'main';
  main().innerHTML = `<div class="page"><div class="page-head"><h1>${esc(title)}</h1><div class="actions">${actions}</div></div><div id="pageBody"></div></div>`;
  return $('#pageBody');
}
const noAccounts = '<div class="card"><p>No mailboxes yet. <a href="#/settings">Add one in Settings</a>.</p></div>';

// ================= Calendar =================
export async function showCalendar() {
  const body = page('Calendar', '<button class="btn primary" id="newEvent">New event</button>');
  $('#newEvent').onclick = () => newEvent().then((ok) => ok && showCalendar());
  if (!svc.state.accounts.length) { body.innerHTML = noAccounts; return; }
  body.innerHTML = '<p class="muted">Loading the next 14 days…</p>';
  const { events, errors } = await svc.loadEvents(14);
  errors.forEach((e) => toast(`${e.account.email}: ${e.error.message}`));
  if (!events.length) { body.innerHTML = '<div class="card"><p>Nothing on your calendars in the next 14 days.</p></div>'; return; }
  const byDay = new Map();
  for (const ev of events) {
    const k = new Date(ev.start).toDateString();
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(ev);
  }
  const resp = { accepted: '', tentative: 'Maybe', declined: 'Declined', needsAction: 'Not answered', none: '', organizer: '' };
  body.innerHTML = [...byDay.entries()].map(([day, list]) => `<div class="day">${esc(new Date(day).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }))}</div>
    ${list.map((ev) => { const a = acctOf(ev.accountId); return `<div class="event"><span class="bar" style="background:${esc(a?.color)}"></span>
      <span class="when">${ev.allDay ? 'All day' : `${esc(new Date(ev.start).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))}–${esc(new Date(ev.end).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))}`}</span>
      <span style="flex:1;min-width:0;display:flex;flex-direction:column;gap:2px"><span style="font-weight:600">${esc(ev.title)}</span>
      <span class="muted" style="font-size:12px">${esc([ev.location, a?.email, resp[ev.response]].filter(Boolean).join(' · '))}</span></span>
      ${ev.link ? `<a class="btn small" href="${esc(ev.link)}" target="_blank" rel="noopener">Open</a>` : ''}</div>`; }).join('')}`).join('');
}

function newEvent() {
  return openDialog((d, close) => {
    const start = new Date(Date.now() + 3600000); start.setMinutes(0, 0, 0);
    const local = (t) => new Date(t - new Date(t).getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    d.innerHTML = `<form class="dlg"><header><h2>New event</h2></header>
      <label class="field">Calendar<select class="input" name="acct">${svc.state.accounts.map((a) => `<option value="${esc(a.id)}">${esc(a.email)}</option>`).join('')}</select></label>
      <label class="field">Title<input class="input" name="title" required autofocus></label>
      <div class="cols" style="gap:12px"><label class="field" style="flex:1">Starts<input class="input" type="datetime-local" name="start" value="${local(start.getTime())}" required></label>
      <label class="field" style="flex:1">Ends<input class="input" type="datetime-local" name="end" value="${local(start.getTime() + 3600000)}" required></label></div>
      <label class="field">Location<input class="input" name="location"></label>
      <label class="field">Notes<textarea class="input" name="notes" rows="3"></textarea></label>
      <footer><button type="button" class="btn" data-x>Cancel</button><button class="btn primary">Save</button></footer></form>`;
    const f = d.querySelector('form');
    d.querySelector('[data-x]').onclick = () => close(false);
    f.onsubmit = async (e) => {
      e.preventDefault();
      const s = new Date(f.start.value).getTime(), en = new Date(f.end.value).getTime();
      if (!f.title.value.trim()) { toast('Add a title.'); return; }
      if (!(en > s)) { toast('The end has to be after the start.'); return; }
      try { await svc.createEvent(f.acct.value, { title: f.title.value.trim(), start: s, end: en, location: f.location.value, description: f.notes.value }); toast('Event saved'); close(true); } catch (err) { showError(err); }
    };
  });
}

// ================= Contacts =================
export async function showContacts() {
  const body = page('Contacts', '<button class="btn" id="syncContacts">Refresh</button>');
  $('#syncContacts').onclick = async () => { toast('Refreshing contacts…'); await svc.refreshContacts(true); showContacts(); };
  const all = await svc.allContacts();
  body.innerHTML = `<label class="field" style="max-width:420px;margin-bottom:14px">Find someone<input class="input" id="cq" placeholder="Name or email"></label><div id="clist"></div>`;
  const render = (q = '') => {
    const t = q.toLowerCase();
    const seen = new Set();
    const list = all.filter((c) => (!t || c.email.includes(t) || (c.name || '').toLowerCase().includes(t)) && !seen.has(c.email) && seen.add(c.email)).slice(0, 300);
    $('#clist').innerHTML = list.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Name</th><th>Email</th><th></th></tr></thead><tbody>
      ${list.map((c) => `<tr><td>${esc(c.name || '—')}</td><td>${esc(c.email)}</td><td style="text-align:right"><button class="btn small" data-mail="${esc(c.email)}" data-name="${esc(c.name || '')}">Email</button></td></tr>`).join('')}</tbody></table></div>`
      : '<div class="card"><p>No contacts yet. They’re pulled from your mailboxes’ address books and from people you email.</p></div>';
    $$('[data-mail]').forEach((b) => { b.onclick = () => openCompose({ to: [{ name: b.dataset.name, address: b.dataset.mail }] }); });
  };
  $('#cq').oninput = (e) => render(e.target.value);
  render();
}

// ================= Rules & import =================
export function showRules() {
  const body = page('Rules & import', `<button class="btn" id="exportRules">Export rules</button><button class="btn" id="pushRules">Apply to Gmail & Outlook</button><button class="btn primary" id="addRule">Add rule</button>`);
  const rules = () => svc.state.rules;
  body.innerHTML = `<div class="cols"><section class="col-main" aria-label="Your rules">
      <p class="muted" style="margin:0">Rules run top to bottom; the first match wins. Everything else stays in Inbox.</p>
      <div class="table-wrap"><table class="table"><thead><tr><th>#</th><th>Rule</th><th>When mail matches</th><th>Then</th><th>On</th><th></th></tr></thead><tbody id="ruleRows"></tbody></table></div>
      <div class="card"><h2>Apply rules inside Gmail and Outlook</h2><p>This copies your rules into each mailbox so mail gets sorted even when the app is closed. It replaces only rules this app made before; your own Gmail filters and Outlook rules aren’t touched.</p></div>
    </section>
    <aside class="col-side" aria-label="Import" id="importPane"></aside></div>`;
  const renderRows = () => {
    $('#ruleRows').innerHTML = rules().map((r, i) => `<tr>
      <td class="muted">${i + 1}</td><td style="font-weight:600">${esc(r.name)}${isCheckableHere(r) ? '' : '<div class="muted" style="font-weight:400;font-size:12px">Works in Gmail only</div>'}${r.mailboxes === 'all' ? '' : `<div class="muted" style="font-weight:400;font-size:12px">${esc(r.mailboxes.join(', '))}</div>`}</td>
      <td style="color:var(--text-2);max-width:380px">${esc(describeMatch(r))}</td><td>Move to ${esc(folderName(r.actions.moveTo))}${r.actions.markRead ? ', mark read' : ''}</td>
      <td><button class="toggle" role="switch" aria-checked="${r.enabled}" aria-label="${r.enabled ? 'Turn off' : 'Turn on'} ${esc(r.name)}" data-toggle="${i}"><span></span></button></td>
      <td style="white-space:nowrap"><button class="btn small" data-up="${i}" aria-label="Move ${esc(r.name)} up" ${i ? '' : 'disabled'}>↑</button>
        <button class="btn small" data-down="${i}" aria-label="Move ${esc(r.name)} down" ${i < rules().length - 1 ? '' : 'disabled'}>↓</button>
        <button class="btn small" data-edit="${i}">Edit</button></td></tr>`).join('') || '<tr><td colspan="6" class="muted">No rules yet.</td></tr>';
    const save = (list) => svc.saveRules(list).then(renderRows);
    $$('[data-toggle]').forEach((b) => { b.onclick = () => { const l = structuredClone(rules()); l[b.dataset.toggle].enabled = !l[b.dataset.toggle].enabled; save(l); }; });
    $$('[data-up]').forEach((b) => { b.onclick = () => { const l = structuredClone(rules()); const i = Number(b.dataset.up); [l[i - 1], l[i]] = [l[i], l[i - 1]]; save(l); }; });
    $$('[data-down]').forEach((b) => { b.onclick = () => { const l = structuredClone(rules()); const i = Number(b.dataset.down); [l[i + 1], l[i]] = [l[i], l[i + 1]]; save(l); }; });
    $$('[data-edit]').forEach((b) => { b.onclick = () => editRule(Number(b.dataset.edit)).then(renderRows); });
  };
  renderRows();
  $('#addRule').onclick = () => editRule(-1).then(renderRows);
  $('#exportRules').onclick = () => {
    const blob = new Blob([exportRulesJson(rules())], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'inbox-rules.json'; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  };
  $('#pushRules').onclick = async (e) => {
    if (!svc.state.accounts.length) { toast('Add a mailbox first.'); return; }
    e.target.disabled = true;
    const report = await svc.pushRulesEverywhere((a) => { e.target.textContent = `Applying to ${shortName(a)}…`; });
    e.target.disabled = false; e.target.textContent = 'Apply to Gmail & Outlook';
    openDialog((d, close) => {
      d.innerHTML = `<div class="dlg"><header><h2>Rules applied</h2></header><div class="menu-list">${report.map((r) => `<div class="card"><strong>${esc(r.account.email)}</strong>
        <p>${r.error ? `Failed: ${esc(r.error)}` : `${r.created} rule${r.created === 1 ? '' : 's'} created.`}</p>${(r.skipped || []).map((s) => `<p style="font-size:12px">Skipped: ${esc(s)}</p>`).join('')}</div>`).join('')}</div>
        <footer><button class="btn primary" data-x>Done</button></footer></div>`;
      d.querySelector('[data-x]').onclick = () => close();
    });
  };
  renderImport(renderRows);
}

function renderImport(onDone, pending = null) {
  const pane = $('#importPane');
  if (!pending) {
    pane.innerHTML = `<div class="card" style="border-style:dashed"><h2>Import rules</h2><p>Bring in rules you already use. They’re converted so they work the same in every mailbox.</p>
      <label class="btn" style="justify-content:flex-start;height:auto;padding:12px 14px;flex-direction:column;align-items:flex-start;gap:2px;white-space:normal;text-align:left"><span style="font-weight:600">Gmail filters (.xml) or rules file (.json)</span><span class="muted" style="font-size:12px">Gmail › Settings › Filters › Export, or a file exported from this app</span><input type="file" accept=".xml,.json,application/json,text/xml" hidden id="ruleFile"></label>
      <label class="field">Or read rules straight from a mailbox<select class="input" id="ruleAcct"><option value="">Choose a mailbox…</option>${svc.state.accounts.map((a) => `<option value="${esc(a.id)}">${esc(a.email)}</option>`).join('')}</select></label></div>`;
    $('#ruleFile').onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const res = /^\s*[[{]/.test(text) ? parseRulesJson(text) : gmailXmlToRules(text);
        renderImport(onDone, { ...res, source: file.name });
      } catch (err) { showError(err); }
    };
    $('#ruleAcct').onchange = async (e) => {
      if (!e.target.value) return;
      try { const res = await svc.readRulesFrom(e.target.value); renderImport(onDone, { ...res, source: acctOf(e.target.value).email }); } catch (err) { showError(err); }
    };
    return;
  }
  const preview = mergeRules(svc.state.rules, pending.rules);
  pane.innerHTML = `<div class="card"><div style="display:flex;justify-content:space-between;gap:12px;align-items:baseline"><h2>Review import</h2><span class="muted" style="font-size:12px">${esc(pending.source)}</span></div>
    <p>${pending.rules.length} rule${pending.rules.length === 1 ? '' : 's'} found${preview.report.some((r) => r.status === 'merged') ? ' · matching names will be merged' : ''}.</p>
    <div class="menu-list">${preview.report.map((r) => `<div style="display:flex;justify-content:space-between;padding:8px 10px;border-radius:8px;background:var(--surface);font-size:13px"><span>${esc(r.name)}</span><span style="color:${r.status === 'new' ? 'var(--good)' : 'var(--warn)'}">${r.status === 'new' ? 'New' : 'Merge with existing'}</span></div>`).join('')}</div>
    ${pending.skipped.length ? `<details><summary class="muted">${pending.skipped.length} skipped</summary>${pending.skipped.map((s) => `<p style="font-size:12px;margin-top:6px">${esc(s.reason)}${s.detail ? ` — ${esc(s.detail)}` : ''}</p>`).join('')}</details>` : ''}
    <footer style="display:flex;gap:8px;justify-content:flex-end"><button class="btn" id="impCancel">Cancel</button><button class="btn primary" id="impOk" ${pending.rules.length ? '' : 'disabled'}>Import ${pending.rules.length} rule${pending.rules.length === 1 ? '' : 's'}</button></footer></div>`;
  $('#impCancel').onclick = () => renderImport(onDone);
  $('#impOk').onclick = async () => {
    await svc.saveRules(preview.rules);
    onDone();
    pane.innerHTML = `<div class="card" style="border-color:#2E5E52;background:#11201C"><h2 style="color:var(--good)">Rules imported</h2><p>To sort mail that’s already in your inboxes, run a <a href="#/cleanup">Cleanup</a>. To sort new mail even when the app is closed, use “Apply to Gmail & Outlook”.</p><button class="btn small" id="impAgain" style="align-self:flex-start">Import another file</button></div>`;
    $('#impAgain').onclick = () => renderImport(onDone);
  };
}

function editRule(index) {
  const existing = index >= 0 ? svc.state.rules[index] : null;
  const r = existing || normalizeRule({ name: '', match: { any: [] }, actions: { moveTo: 'receipts' } });
  const conds = r.match.any || r.match.all || [];
  const gather = (k) => conds.filter((c) => Object.keys(c).length === 1 && c[k]).flatMap((c) => c[k]);
  const complex = conds.filter((c) => !(Object.keys(c).length === 1 && (c.from || c.subject || c.to || c.bulk === true)));
  return openDialog((d, close) => {
    d.innerHTML = `<form class="dlg"><header><h2>${existing ? 'Edit rule' : 'New rule'}</h2></header>
      <label class="field">Name<input class="input" name="name" value="${esc(r.name)}" required autofocus></label>
      <label class="field">Move matching mail to<select class="input" name="moveTo">${TARGET_FOLDERS.map((f) => `<option value="${f.key}" ${f.key === r.actions.moveTo ? 'selected' : ''}>${esc(f.name)}</option>`).join('')}</select></label>
      <p class="muted" style="margin:0;font-size:13px">Mail matches if <strong>any</strong> of these is true. One entry per line; part of an address or a word is enough.</p>
      <label class="field">Sender contains<textarea class="input" name="from" rows="3">${esc(gather('from').join('\n'))}</textarea></label>
      <label class="field">Subject contains<textarea class="input" name="subject" rows="3">${esc(gather('subject').join('\n'))}</textarea></label>
      <label class="field">Sent to (one of your addresses or a list)<textarea class="input" name="to" rows="2">${esc(gather('to').join('\n'))}</textarea></label>
      <label class="check"><input type="checkbox" name="bulk" ${conds.some((c) => c.bulk === true && Object.keys(c).length === 1) ? 'checked' : ''}> Any marketing mail or newsletter</label>
      ${complex.length ? `<p class="muted" style="margin:0;font-size:12px">Also keeps ${complex.length} imported condition(s) that can’t be edited here: ${esc(complex.map((c) => JSON.stringify(c)).join('; '))}</p>` : ''}
      <label class="check"><input type="checkbox" name="markRead" ${r.actions.markRead ? 'checked' : ''}> Mark as read</label>
      <fieldset style="border:0;padding:0;margin:0;display:flex;flex-direction:column;gap:8px"><legend style="font-size:13px;color:var(--text-2);margin-bottom:6px">Mailboxes</legend>
        <label class="check"><input type="radio" name="scope" value="all" ${r.mailboxes === 'all' ? 'checked' : ''}> All mailboxes</label>
        ${svc.state.accounts.map((a) => `<label class="check"><input type="checkbox" name="mb" value="${esc(a.email)}" ${r.mailboxes !== 'all' && r.mailboxes.includes(a.email) ? 'checked' : ''}> ${esc(a.email)}</label>`).join('')}
      </fieldset>
      <footer>${existing ? '<button type="button" class="btn danger" data-del style="margin-right:auto">Delete rule</button>' : ''}<button type="button" class="btn" data-x>Cancel</button><button class="btn primary">Save</button></footer></form>`;
    const f = d.querySelector('form');
    const lines = (v) => v.split('\n').map((s) => s.trim()).filter(Boolean);
    f.querySelectorAll('[name="mb"]').forEach((cb) => { cb.onchange = () => { if (cb.checked) f.querySelector('[name="scope"]').checked = false; }; });
    d.querySelector('[data-x]').onclick = () => close();
    d.querySelector('[data-del]')?.addEventListener('click', async () => {
      const l = structuredClone(svc.state.rules); l.splice(index, 1); await svc.saveRules(l); close();
    });
    f.onsubmit = async (e) => {
      e.preventDefault();
      const any = [];
      if (lines(f.from.value).length) any.push({ from: lines(f.from.value) });
      if (lines(f.subject.value).length) any.push({ subject: lines(f.subject.value) });
      if (lines(f.to.value).length) any.push({ to: lines(f.to.value) });
      if (f.bulk.checked) any.push({ bulk: true });
      any.push(...complex);
      if (!f.name.value.trim()) { toast('Give the rule a name.'); return; }
      if (!any.length) { toast('Add at least one condition.'); return; }
      const picked = [...f.querySelectorAll('[name="mb"]:checked')].map((x) => x.value);
      const rule = normalizeRule({ ...r, name: f.name.value.trim(), mailboxes: f.querySelector('[name="scope"]').checked || !picked.length ? 'all' : picked, match: { any }, actions: { moveTo: f.moveTo.value, skipInbox: true, markRead: f.markRead.checked } });
      const l = structuredClone(svc.state.rules);
      if (existing) l[index] = rule; else l.push(rule);
      await svc.saveRules(l);
      close();
    };
  });
}

// ================= Cleanup =================
const BUCKET_LABEL = (k) => (k === BUCKET_TRASH ? 'Promotions → Trash' : k === BUCKET_STAY ? 'Stays in Inbox' : folderName(k));

export async function showCleanup() {
  const body = page('Clean up inboxes');
  if (!svc.state.accounts.length) { body.innerHTML = noAccounts; return; }
  const runs = await svc.cleanupRuns();
  body.innerHTML = `<div class="cols"><section class="col-main">
    <form class="card" id="cleanForm"><h2>1. Choose what to clean</h2>
      <p>Runs your rules over mail already in your inboxes. You’ll see exactly what will happen before anything moves.</p>
      <fieldset style="border:0;padding:0;margin:0;display:flex;flex-direction:column;gap:8px"><legend style="font-size:13px;color:var(--text-2);margin-bottom:6px">Mailboxes</legend>
        ${svc.state.accounts.map((a) => `<label class="check"><input type="checkbox" name="acct" value="${esc(a.id)}" checked> ${esc(a.email)}</label>`).join('')}</fieldset>
      <label class="field">How far back<select class="input" name="range" style="max-width:260px"><option value="30d">Last 30 days</option><option value="90d" selected>Last 90 days</option><option value="1y">Last year</option><option value="all">Everything</option></select></label>
      <label class="check"><input type="checkbox" name="trash"> Send promotions to Trash instead of the Promotions folder <span class="muted">(Trash keeps them about 30 days)</span></label>
      <div><button class="btn primary">Preview cleanup</button></div>
    </form>
    <div id="cleanStage"></div>
  </section>
  <aside class="col-side"><div class="card"><h2>Past cleanups</h2>${runs.length ? runs.map((r) => `<div style="display:flex;gap:10px;align-items:center;justify-content:space-between;font-size:13px;border-top:1px solid var(--line);padding-top:10px">
      <span>${esc(fullTime(r.at))}<br><span class="muted">${esc(Object.entries(r.counts).map(([k, n]) => `${n} ${BUCKET_LABEL(k)}`).join(' · '))}</span></span>
      ${r.undone ? '<span class="muted">Undone</span>' : `<button class="btn small" data-undo="${esc(r.runId)}">Undo</button>`}</div>`).join('') : '<p>None yet.</p>'}</div></aside></div>`;
  $$('[data-undo]').forEach((b) => { b.onclick = () => undoRun(b.dataset.undo); });
  $('#cleanForm').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    const accountIds = [...f.querySelectorAll('[name="acct"]:checked')].map((x) => x.value);
    if (!accountIds.length) { toast('Pick at least one mailbox.'); return; }
    const stage = $('#cleanStage');
    f.querySelector('button').disabled = true;
    stage.innerHTML = '<div class="card"><h2>Scanning…</h2><p id="scanMsg">Starting…</p></div>';
    try {
      const plan = await svc.previewCleanup({ accountIds, range: f.range.value, trashPromotions: f.trash.checked }, (p) => {
        const el = $('#scanMsg'); if (el) el.textContent = `${p.account.email}: ${p.loaded || 0} of ${p.found} messages checked`;
      });
      renderPreview(plan);
    } catch (err) { stage.innerHTML = ''; showError(err); }
    f.querySelector('button').disabled = false;
  };
}

function renderPreview(plan) {
  const excluded = new Set();
  const stage = $('#cleanStage');
  const buckets = Object.keys(plan.totals).sort((a, b) => (a === BUCKET_STAY) - (b === BUCKET_STAY) || (a === BUCKET_TRASH) - (b === BUCKET_TRASH));
  const moving = () => Object.entries(plan.totals).filter(([k]) => k !== BUCKET_STAY).reduce((n, [, v]) => n + v, 0) - excluded.size;
  stage.innerHTML = `<div class="card"><h2>2. Review</h2><p>Nothing has changed yet. Untick anything you want left where it is.</p>
    <div class="table-wrap"><table class="table"><thead><tr><th>Mailbox</th>${buckets.map((b) => `<th>${esc(BUCKET_LABEL(b))}</th>`).join('')}</tr></thead><tbody>
      ${plan.accounts.map((a) => `<tr><td>${esc(a.email)}</td>${buckets.map((b) => `<td>${(a.buckets[b] || []).length}</td>`).join('')}</tr>`).join('')}
      <tr><td style="font-weight:600">Total</td>${buckets.map((b) => `<td style="font-weight:600">${plan.totals[b]}</td>`).join('')}</tr></tbody></table></div>
    ${buckets.filter((b) => b !== BUCKET_STAY).map((b) => {
      const list = plan.accounts.flatMap((a) => (a.buckets[b] || []).map((m) => ({ ...m, email: a.email })));
      return `<details><summary style="cursor:pointer">${esc(BUCKET_LABEL(b))} — ${list.length} messages</summary><div style="display:flex;flex-direction:column;gap:4px;margin-top:8px;max-height:320px;overflow-y:auto">
        ${list.slice(0, 200).map((m) => `<label class="check" style="font-size:13px"><input type="checkbox" checked data-key="${esc(m.key)}"> <span style="min-width:0"><strong>${esc(m.from?.name || m.from?.address)}</strong> — ${esc(m.subject)} <span class="muted">· ${esc(m.email)}</span></span></label>`).join('')}
        ${list.length > 200 ? `<p class="muted" style="font-size:12px">…and ${list.length - 200} more</p>` : ''}</div></details>`;
    }).join('')}
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><button class="btn primary" id="runClean">Move <span id="moveCount">${moving()}</span> messages</button><span class="muted" style="font-size:13px">You can undo this afterwards.</span></div></div>`;
  $$('[data-key]', stage).forEach((cb) => { cb.onchange = () => { if (cb.checked) excluded.delete(cb.dataset.key); else excluded.add(cb.dataset.key); $('#moveCount').textContent = moving(); }; });
  $('#runClean').onclick = async () => {
    const final = svc.excludeFromPlan(plan, [...excluded]);
    const trashN = final.totals[BUCKET_TRASH] || 0;
    const ok = await confirmDialog('Run cleanup?', `${moving()} messages will be moved${trashN ? `, including <strong>${trashN} to Trash</strong>` : ''}. You can undo it from “Past cleanups”.`, { ok: 'Run cleanup', danger: trashN > 0 });
    if (ok) runPlan(final);
  };
}

async function runPlan(plan) {
  const stage = $('#cleanStage');
  let cancelled = false;
  stage.innerHTML = `<div class="card"><h2>3. Cleaning up…</h2><div class="progress"><span id="bar"></span></div><p id="progMsg">Starting…</p><div><button class="btn" id="stopClean">Stop</button></div></div>`;
  $('#stopClean').onclick = () => { cancelled = true; $('#stopClean').disabled = true; };
  try {
    const res = await svc.runCleanupPlan(plan, ({ done, total }) => {
      $('#bar').style.width = `${total ? Math.round((done / total) * 100) : 100}%`;
      $('#progMsg').textContent = `${done} of ${total} messages`;
    }, () => cancelled);
    stage.innerHTML = `<div class="card" style="border-color:#2E5E52;background:#11201C"><h2 style="color:var(--good)">${res.cancelled ? 'Stopped' : 'Done'}</h2>
      <p>${res.done} of ${res.total} messages handled.${res.errors.length ? ` ${res.errors.reduce((n, e) => n + e.count, 0)} couldn’t be moved: ${esc(res.errors[0].message)}` : ''}</p>
      <div style="display:flex;gap:8px"><button class="btn" id="undoNow">Undo this cleanup</button><a class="btn primary" href="#/mail/inbox">Go to Inbox</a></div></div>`;
    $('#undoNow').onclick = () => undoRun(plan.runId);
  } catch (e) { showError(e); }
}

async function undoRun(runId) {
  const ok = await confirmDialog('Undo cleanup?', 'Everything this cleanup moved goes back to the Inbox, including anything it sent to Trash.', { ok: 'Undo' });
  if (!ok) return;
  toast('Undoing…');
  try {
    const res = await svc.undoCleanupRun(runId);
    toast(res.errors.length ? `Undid ${res.done - res.errors.reduce((n, e) => n + e.count, 0)}; some failed: ${res.errors[0].message}` : `Moved ${res.done} messages back to Inbox`);
    showCleanup();
  } catch (e) { showError(e); }
}

// ================= Settings =================
export function showSettings() {
  const body = page('Settings');
  const s = svc.state.settings;
  body.innerHTML = `<div class="cols"><section class="col-main">
    <div class="card"><h2>Mailboxes</h2>
      <div id="acctList" style="display:flex;flex-direction:column;gap:10px"></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn primary" id="addG">Add Gmail</button><button class="btn primary" id="addM">Add Outlook / Hotmail</button></div>
      <p style="font-size:12px">Gmail sign-ins last about an hour; when they expire, tap “Reconnect” at the top and they all refresh together.</p>
    </div>
    <form class="card" id="prefs"><h2>Preferences</h2>
      <label class="check"><input type="checkbox" name="sweep" ${s.sweep ? 'checked' : ''}> Sort new mail with my rules while the app is open</label>
      <label class="check"><input type="checkbox" name="remoteImages" ${s.remoteImages ? 'checked' : ''}> Always show images in emails <span class="muted">(off blocks tracking pixels)</span></label>
    </form>
  </section><aside class="col-side">
    <form class="card" id="ids"><h2>Sign-in setup</h2><p>From Google Cloud and Microsoft Azure. See <a href="https://github.com/DevilBike/unified-inbox/blob/main/SETUP.md" target="_blank" rel="noopener">SETUP.md</a>.</p>
      <label class="field">Google client ID<input class="input" name="googleClientId" value="${esc(s.googleClientId || '')}" placeholder="….apps.googleusercontent.com"></label>
      <label class="field">Microsoft application (client) ID<input class="input" name="microsoftClientId" value="${esc(s.microsoftClientId || '')}" placeholder="00000000-0000-0000-0000-000000000000"></label>
      <p style="font-size:12px">Sign-in return address to register: <code>${esc(new URL('auth.html', location.href.split('#')[0]).href)}</code></p>
      <div><button class="btn">Save</button></div></form>
    <div class="card"><h2>This device</h2><p>Mail, rules and sign-ins are stored only in this browser. Export your rules before clearing.</p>
      <div><button class="btn danger" id="wipe">Sign out everywhere and clear this device</button></div></div>
  </aside></div>`;
  const renderAccts = () => {
    $('#acctList').innerHTML = svc.state.accounts.map((a) => `<div style="display:flex;flex-direction:column;gap:8px;border:1px solid var(--line);border-radius:10px;padding:12px">
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><span class="dot" style="background:${esc(a.color)}"></span><strong style="flex:1;min-width:160px">${esc(a.email)}</strong>
        <span class="muted" style="font-size:12px">${a.provider === 'google' ? 'Gmail' : 'Outlook'} · ${a.status === 'needs-signin' ? '<span style="color:var(--warn)">needs reconnect</span>' : 'connected'}</span>
        <input type="color" value="${esc(a.color)}" data-color="${esc(a.id)}" aria-label="Color for ${esc(a.email)}" style="width:36px;height:30px;border:0;background:none">
        <button class="btn small" data-signin="${esc(a.id)}">Sign in again</button><button class="btn small danger" data-rm="${esc(a.id)}">Remove</button></div>
      <label class="field">Signature<textarea class="input" rows="2" data-sig="${esc(a.id)}" placeholder="Added to the end of messages you send from this address">${esc(a.signature || '')}</textarea></label></div>`).join('') || '<p>No mailboxes yet.</p>';
    $$('[data-color]').forEach((el) => { el.onchange = () => svc.updateAccount(el.dataset.color, { color: el.value }); });
    $$('[data-sig]').forEach((el) => { el.onchange = () => { svc.updateAccount(el.dataset.sig, { signature: el.value }); toast('Signature saved'); }; });
    $$('[data-rm]').forEach((b) => { b.onclick = async () => { if (await confirmDialog('Remove mailbox?', 'This only removes it from this app on this device. Your mail isn’t touched.', { ok: 'Remove', danger: true })) { await svc.removeAccount(b.dataset.rm); renderAccts(); } }; });
    $$('[data-signin]').forEach((b) => { b.onclick = async () => { try { const r = await svc.reconnect([acctOf(b.dataset.signin)], { interactive: true }); toast(r.failed.length ? r.failed[0].error : 'Signed in'); renderAccts(); } catch (e) { showError(e); } }; });
  };
  renderAccts();
  const add = (kind) => async () => { try { const a = await svc.addAccount(kind); toast(`Added ${a.email}`); renderAccts(); } catch (e) { showError(e); } };
  $('#addG').onclick = add('google');
  $('#addM').onclick = add('microsoft');
  $('#prefs').onchange = (e) => svc.saveSettings({ [e.target.name]: e.target.checked });
  $('#ids').onsubmit = async (e) => { e.preventDefault(); await svc.saveSettings({ googleClientId: e.target.googleClientId.value.trim(), microsoftClientId: e.target.microsoftClientId.value.trim() }); toast('Saved'); };
  $('#wipe').onclick = async () => { if (await confirmDialog('Clear this device?', 'Removes all mailboxes, cached mail, rules and settings from this browser. Your actual mail isn’t touched.', { ok: 'Clear everything', danger: true })) svc.forgetEverything(); };
}

export { icon };
