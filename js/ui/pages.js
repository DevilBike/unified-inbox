import { $, $$, esc, toast, showError, openDialog, confirmDialog, fullTime, timeLabel, icon } from './dom.js';
import * as svc from '../service.js';
import { TARGET_FOLDERS, folderName } from '../core/folders.js';
import { normalizeRule, describeMatch, isCheckableHere } from '../core/rules.js';
import { checkForUpdate, installUpdate, APP_VERSION } from '../update.js';
import { gmailXmlToRules, parseRulesJson, exportRulesJson, mergeRules } from '../core/importers.js';
import { BUCKET_STAY, BUCKET_TRASH } from '../core/cleanup.js';
import { shortName, pickFolder } from './mail.js';
import { renderMessage } from './message.js';

const main = () => $('#main');
const acctOf = (id) => svc.state.accounts.find((a) => a.id === id);
function page(title, actions = '') {
  main().className = 'main';
  main().innerHTML = `<div class="page"><div class="page-head"><h1>${esc(title)}</h1><div class="actions">${actions}</div></div><div id="pageBody"></div></div>`;
  return $('#pageBody');
}
const noAccounts = '<div class="card"><p>No mailboxes yet. <a href="#/settings">Add one in Settings</a>.</p></div>';

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
const DESTS = () => [{ key: BUCKET_STAY, name: 'Leave in Inbox', short: 'Inbox' }, ...TARGET_FOLDERS.map((f) => ({ key: f.key, name: f.name, short: f.name })), { key: BUCKET_TRASH, name: 'Trash', short: 'Trash' }];
const BUCKET_LABEL = (k) => (k === BUCKET_TRASH ? 'Trash' : k === BUCKET_STAY ? 'Stays in Inbox' : folderName(k));
const bucketOrder = (keys) => keys.sort((a, b) => (a === BUCKET_STAY) - (b === BUCKET_STAY) || (a === BUCKET_TRASH) - (b === BUCKET_TRASH)
  || DESTS().findIndex((d) => d.key === a) - DESTS().findIndex((d) => d.key === b));

export async function showCleanup() {
  const body = page('Clean up inboxes');
  if (!svc.state.accounts.length) { body.innerHTML = noAccounts; return; }
  const runs = await svc.cleanupRuns();
  body.innerHTML = `<div class="cols"><section class="col-main">
    <form class="card" id="cleanForm"><h2>1. Choose what to clean</h2>
      <p>Runs your rules over mail already in your inboxes. Then you can read and re-sort anything before a single message moves.</p>
      <fieldset style="border:0;padding:0;margin:0;display:flex;flex-direction:column;gap:8px"><legend style="font-size:13px;color:var(--text-2);margin-bottom:6px">Mailboxes</legend>
        ${svc.state.accounts.map((a) => `<label class="check"><input type="checkbox" name="acct" value="${esc(a.id)}" ${a.status === 'ok' ? 'checked' : 'disabled'}> ${esc(a.email)}${a.status === 'ok' ? '' : ' <span style="color:var(--warn)">(sign in again in Settings)</span>'}</label>`).join('')}</fieldset>
      <label class="field">How far back<select class="input" name="range" style="max-width:260px"><option value="30d">Last 30 days</option><option value="90d" selected>Last 90 days</option><option value="1y">Last year</option><option value="all">Everything</option></select></label>
      <label class="check"><input type="checkbox" name="trash"> Send promotions to Trash instead of the Promotions folder <span class="muted">(Trash keeps them about 30 days)</span></label>
      <div><button class="btn primary">Preview cleanup</button></div>
    </form>
    <div id="cleanStage"></div>
  </section>
  <aside class="col-side"><div class="card"><h2>Past cleanups</h2>${runs.length ? runs.map((r) => `<div style="display:flex;gap:10px;align-items:center;justify-content:space-between;font-size:13px;border-top:1px solid var(--line);padding-top:10px">
      <span>${esc(fullTime(r.at))}<br><span class="muted">${esc(Object.entries(r.counts).map(([k, n]) => `${n} ${BUCKET_LABEL(k)}`).join(' · '))}</span></span>
      ${r.undone ? '<span class="muted">Undone</span>' : `<button class="btn small" data-undo="${esc(r.runId)}">Undo</button>`}</div>`).join('') : '<p>None yet.</p>'}
      <p style="font-size:12px">Every move is logged on this PC, so a cleanup can be undone later.</p></div></aside></div>`;
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

const destSelect = (attr, value) => `<select class="input dest" ${attr} aria-label="Where it goes">${DESTS().map((d) => `<option value="${d.key}" ${d.key === value ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select>`;

function groupBySender(list) {
  const map = new Map();
  for (const m of list) {
    const addr = (m.from?.address || '').toLowerCase() || '(no address)';
    if (!map.has(addr)) map.set(addr, { addr, name: m.from?.name || '', msgs: [] });
    map.get(addr).msgs.push(m);
  }
  return [...map.values()].sort((a, b) => b.msgs.length - a.msgs.length || a.addr.localeCompare(b.addr));
}

function renderPreview(plan) {
  const st = { overrides: new Map(), tab: null, group: true, shown: 60, open: new Set() };
  const ruleBucket = new Map(plan.accounts.flatMap((a) => Object.entries(a.buckets).flatMap(([k, l]) => l.map((m) => [m.key, k]))));
  const stage = $('#cleanStage');
  const current = () => svc.reassignInPlan(plan, st.overrides);
  const setMany = (keys, bucket) => { for (const k of keys) st.overrides.set(k, bucket); };

  const alwaysForSender = async (addr) => {
    const to = await pickFolder('', `Always put mail from ${addr} in`);
    if (!to) return;
    await svc.fileSenderAlways(addr, to);
    setMany(svc.keysFromSender(plan, addr), svc.bucketForFolder(plan, to));
    toast(to === 'inbox' ? `${addr} stays in the Inbox` : `Rule saved: ${addr} → ${folderName(to)}`);
    draw();
  };

  const draw = () => {
    const p = current();
    const buckets = bucketOrder(Object.keys(p.totals));
    if (!st.tab || !p.totals[st.tab]) st.tab = buckets.find((b) => b !== BUCKET_STAY) || buckets[0];
    const moving = Object.entries(p.totals).filter(([k]) => k !== BUCKET_STAY).reduce((n, [, v]) => n + v, 0);
    const trashN = p.totals[BUCKET_TRASH] || 0;
    const list = p.accounts.flatMap((a) => (a.buckets[st.tab] || []).map((m) => ({ ...m, mailbox: a.email })));
    const keys = list.map((m) => m.key);
    const msgRow = (m) => `<div class="rv-row"><button class="rv-main" data-read="${esc(m.key)}" title="Read this message">
        <span class="rv-who">${esc(m.from?.name || m.from?.address || '')}</span><span class="rv-subj">${esc(m.subject || '(no subject)')}</span>
        <span class="muted rv-meta">${esc(shortName(acctOf(m.accountId)))} · ${esc(timeLabel(m.date))}</span></button>
        ${destSelect(`data-sel="${esc(m.key)}"`, st.tab)}</div>`;
    let rows;
    if (st.group) {
      const groups = groupBySender(list);
      rows = groups.slice(0, st.shown).map((g, i) => `<div class="rv-group">
        <div class="rv-row"><button class="rv-main" data-toggle-group="${i}" aria-expanded="${st.open.has(g.addr)}">
          <span class="rv-who">${st.open.has(g.addr) ? '▾' : '▸'} ${esc(g.name || g.addr)} <span class="count">${g.msgs.length}</span></span>
          <span class="rv-subj muted">${esc(g.name ? g.addr : '')}${g.name ? ' · ' : ''}${esc(g.msgs[0].subject || '')}</span></button>
          ${destSelect(`data-gsel="${i}"`, st.tab)}<button class="btn small" data-galways="${i}" title="Make a rule for this sender">Always…</button></div>
        ${st.open.has(g.addr) ? `<div class="rv-children">${g.msgs.slice(0, 100).map(msgRow).join('')}${g.msgs.length > 100 ? `<p class="muted" style="font-size:12px">…and ${g.msgs.length - 100} more</p>` : ''}</div>` : ''}</div>`).join('');
      if (groups.length > st.shown) rows += `<div style="padding:8px"><button class="btn small" id="showMore">Show more senders (${groups.length - st.shown} left)</button></div>`;
      stage._groups = groups;
    } else {
      rows = list.slice(0, st.shown).map(msgRow).join('');
      if (list.length > st.shown) rows += `<div style="padding:8px"><button class="btn small" id="showMore">Show more (${list.length - st.shown} left)</button></div>`;
    }
    stage.innerHTML = `<div class="card"><h2>2. Review and sort</h2>
      <p>Nothing has changed yet. Open any message to read it, then send it somewhere else, or change a whole sender at once.</p>
      <div class="table-wrap"><table class="table"><thead><tr><th>Mailbox</th>${buckets.map((b) => `<th>${esc(BUCKET_LABEL(b))}</th>`).join('')}</tr></thead><tbody>
        ${p.accounts.map((a) => `<tr><td>${esc(a.email)}</td>${buckets.map((b) => `<td>${(a.buckets[b] || []).length}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
      <div class="tabs" role="tablist">${buckets.map((b) => `<button class="tab ${b === st.tab ? 'active' : ''}" role="tab" aria-selected="${b === st.tab}" data-tab="${b}">${esc(BUCKET_LABEL(b))} <span class="count">${p.totals[b]}</span></button>`).join('')}</div>
      <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
        <label class="check"><input type="checkbox" id="groupToggle" ${st.group ? 'checked' : ''}> Group by sender</label>
        <button class="btn small" id="readAll">Read through these ${list.length} one by one</button></div>
      <div class="rv-list">${rows || '<p class="muted">Nothing here.</p>'}</div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><button class="btn primary" id="runClean" ${moving ? '' : 'disabled'}>Move ${moving} messages</button>
        <span class="muted" style="font-size:13px">${trashN ? `${trashN} go to Trash. ` : ''}You can undo this afterwards.</span></div></div>`;

    $$('[data-tab]', stage).forEach((b) => { b.onclick = () => { st.tab = b.dataset.tab; st.shown = 60; draw(); }; });
    $('#groupToggle').onchange = (e) => { st.group = e.target.checked; st.shown = 60; draw(); };
    $('#showMore')?.addEventListener('click', () => { st.shown += 60; draw(); });
    $$('[data-sel]', stage).forEach((sel) => { sel.onchange = () => { st.overrides.set(sel.dataset.sel, sel.value); draw(); }; });
    $$('[data-gsel]', stage).forEach((sel) => { sel.onchange = () => { setMany(stage._groups[Number(sel.dataset.gsel)].msgs.map((m) => m.key), sel.value); draw(); }; });
    $$('[data-galways]', stage).forEach((b) => { b.onclick = () => alwaysForSender(stage._groups[Number(b.dataset.galways)].addr); });
    $$('[data-toggle-group]', stage).forEach((b) => { b.onclick = () => { const g = stage._groups[Number(b.dataset.toggleGroup)]; if (st.open.has(g.addr)) st.open.delete(g.addr); else st.open.add(g.addr); draw(); }; });
    const msgByKey = new Map(list.map((m) => [m.key, m]));
    $$('[data-read]', stage).forEach((b) => { b.onclick = () => reviewOneByOne(keys, keys.indexOf(b.dataset.read), msgByKey).then(draw); });
    $('#readAll').onclick = () => { if (keys.length) reviewOneByOne(keys, 0, msgByKey).then(draw); };
    $('#runClean').onclick = async () => {
      const final = current();
      const ok = await confirmDialog('Run cleanup?', `${moving} messages will be moved${trashN ? `, including <strong>${trashN} to Trash</strong>` : ''}. You can undo it from “Past cleanups”.`, { ok: 'Run cleanup', danger: trashN > 0 });
      if (ok) runPlan(final);
    };
  };

  // Read messages one at a time and pick where each goes (number keys), J/K to step.
  function reviewOneByOne(keys, start, msgByKey) {
    const dests = DESTS();
    const d = $('#dialog');
    d.classList.add('wide');
    return openDialog((dlg, close) => {
      let i = Math.max(0, start);
      let token = 0;
      const bucketNow = (key) => st.overrides.get(key) || ruleBucket.get(key);
      const show = async () => {
        const key = keys[i];
        const m = msgByKey.get(key);
        const b = bucketNow(key);
        const my = ++token;
        dlg.innerHTML = `<div class="dlg review"><header><h2>${i + 1} of ${keys.length}</h2><button class="btn small" data-x>Done</button></header>
          <div class="review-dest" role="group" aria-label="Send this message to">${dests.map((o, n) => `<button class="btn small ${o.key === b ? 'primary' : ''}" data-dest="${o.key}" aria-pressed="${o.key === b}">${esc(o.short)} <span class="kbd">${n + 1}</span></button>`).join('')}</div>
          <label class="check" style="font-size:13px"><input type="checkbox" data-always> Do the same for everything from ${esc(m.from?.address || 'this sender')} and add a rule</label>
          <div class="reader-body review-body" id="rvBody"><p class="muted">Loading…</p></div>
          <footer><button class="btn" data-prev ${i ? '' : 'disabled'}>← Previous <span class="kbd">K</span></button><button class="btn" data-next>${i < keys.length - 1 ? 'Next' : 'Finish'} → <span class="kbd">J</span></button></footer></div>`;
        dlg.querySelector('[data-x]').onclick = () => close();
        dlg.querySelector('[data-prev]').onclick = () => go(-1);
        dlg.querySelector('[data-next]').onclick = () => go(1);
        dlg.querySelectorAll('[data-dest]').forEach((btn) => { btn.onclick = () => choose(btn.dataset.dest); });
        try {
          const full = await svc.openMessage(m, { markRead: false });
          if (my === token) renderMessage($('#rvBody'), full);
        } catch (e) { if (my === token) $('#rvBody').innerHTML = `<p class="muted">Couldn’t open this message. ${esc(e.message)}</p>`; }
      };
      const go = (step) => { const n = i + step; if (n < 0) return; if (n >= keys.length) { close(); return; } i = n; show(); };
      const choose = async (dest) => {
        const m = msgByKey.get(keys[i]);
        const always = dlg.querySelector('[data-always]')?.checked;
        if (always && m.from?.address) {
          if (dest === BUCKET_TRASH) { toast('A rule can’t delete mail. Pick Promotions for the rule, or untick the box.'); return; }
          await svc.fileSenderAlways(m.from.address, dest === BUCKET_STAY ? 'inbox' : dest);
          setMany(svc.keysFromSender(plan, m.from.address), dest === BUCKET_STAY ? BUCKET_STAY : svc.bucketForFolder(plan, dest));
          toast(dest === BUCKET_STAY ? `${m.from.address} stays in the Inbox` : `Rule saved: ${m.from.address} → ${folderName(dest)}`);
        }
        st.overrides.set(keys[i], dest);
        go(1);
      };
      dlg.addEventListener('keydown', (e) => {
        if (e.target.closest('input[type="text"], textarea')) return;
        const n = Number(e.key);
        if (n >= 1 && n <= dests.length) { e.preventDefault(); choose(dests[n - 1].key); } else if (e.key === 'j' || e.key === 'ArrowRight') { e.preventDefault(); go(1); } else if (e.key === 'k' || e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
      });
      show();
    }).finally(() => d.classList.remove('wide'));
  }

  draw();
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
      <p style="font-size:13px">Any “Always…” rules you made are saved. Use “Apply to Gmail & Outlook” on the <a href="#/rules">Rules page</a> so new mail sorts itself too.</p>
      <div style="display:flex;gap:8px"><button class="btn" id="undoNow">Undo this cleanup</button><a class="btn primary" href="#/mail/inbox">Go to Inbox</a></div></div>`;
    $('#undoNow').onclick = () => undoRun(plan.runId);
  } catch (e) {
    stage.innerHTML = `<div class="card"><h2 style="color:var(--bad)">The cleanup stopped</h2><p>${esc(e.message)}</p><p style="font-size:13px">Anything already moved is logged. Undo it from “Past cleanups”, or preview again to carry on.</p></div>`;
    showError(e);
  }
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
export async function showSettings(params = new URLSearchParams()) {
  const body = page('Settings');
  if (params.get('added')) toast(`Signed in to ${params.get('added')}`);
  if (params.get('signin_error')) toast(params.get('signin_error'), { timeout: 12000 });
  if (params.get('added') || params.get('signin_error')) {
    if (params.get('added')) svc.afterSignIn(params.get('added')).catch(() => {});
    history.replaceState(null, '', '#/settings');
  }
  const ids = await svc.getSignInSettings();
  body.innerHTML = `<div class="cols"><section class="col-main">
    <div class="card"><h2>Mailboxes</h2>
      <div id="acctList" style="display:flex;flex-direction:column;gap:10px"></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn primary" id="addG">Add Gmail</button><button class="btn primary" id="addM">Add Outlook / Hotmail</button></div>
      <p style="font-size:12px">You sign in once per mailbox. The app keeps you signed in on this PC.</p>
    </div>
    <form class="card" id="prefs"><h2>Reading</h2>
      <label class="check"><input type="checkbox" name="remoteImages" ${svc.state.prefs.remoteImages ? 'checked' : ''}> Always show images in emails <span class="muted">(off blocks tracking pixels)</span></label>
    </form>
  </section><aside class="col-side">
    <form class="card" id="ids"><h2>Sign-in setup</h2><p>From Google Cloud and Microsoft Azure. See <a href="https://github.com/DevilBike/unified-inbox/blob/main/SETUP.md" target="_blank" rel="noopener">SETUP.md</a>.</p>
      <label class="field">Google client ID<input class="input" name="googleClientId" value="${esc(ids.googleClientId)}" placeholder="….apps.googleusercontent.com" autocomplete="off"></label>
      <label class="field">Google client secret<input class="input" name="googleClientSecret" type="password" placeholder="${ids.hasGoogleSecret ? 'Saved. Paste a new one to replace it' : 'GOCSPX-…'}" autocomplete="off"></label>
      <label class="field">Microsoft application (client) ID<input class="input" name="microsoftClientId" value="${esc(ids.microsoftClientId)}" placeholder="00000000-0000-0000-0000-000000000000" autocomplete="off"></label>
      <p style="font-size:12px">Microsoft redirect URI to register: <code>${esc(ids.redirectUri)}</code></p>
      <div><button class="btn">Save</button></div></form>
    <div class="card"><h2>App version</h2><p>You have version <strong>${esc(APP_VERSION)}</strong>.</p>
      <div id="updInfo"></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn" id="checkUpd">Check for updates</button><a class="btn" href="#/notes">Notes for Claude</a></div></div>
    <div class="card"><h2>On this PC</h2><p>Sign-ins, rules and cleanup history are kept in <code style="overflow-wrap:anywhere">${esc(svc.state.dataDir)}</code>. Nothing is sent anywhere except to Google and Microsoft.</p>
      <div><button class="btn" id="clearCache">Clear cached mail lists</button></div></div>
  </aside></div>`;
  const renderAccts = () => {
    $('#acctList').innerHTML = svc.state.accounts.map((a) => `<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;border:1px solid var(--line);border-radius:10px;padding:12px">
        <span class="dot" style="background:${esc(a.color)}"></span><strong style="flex:1;min-width:160px">${esc(a.email)}</strong>
        <span class="muted" style="font-size:12px">${a.provider === 'google' ? 'Gmail' : 'Outlook'} · ${a.status === 'ok' ? 'connected' : '<span style="color:var(--warn)">sign in again</span>'}</span>
        <input type="color" value="${esc(a.color)}" data-color="${esc(a.id)}" aria-label="Color for ${esc(a.email)}" style="width:36px;height:30px;border:0;background:none">
        <button class="btn small ${a.status === 'ok' ? '' : 'primary'}" data-signin="${esc(a.id)}">Sign in again</button><button class="btn small danger" data-rm="${esc(a.id)}">Remove</button></div>`).join('') || '<p>No mailboxes yet.</p>';
    $$('[data-color]').forEach((el) => { el.onchange = () => svc.updateAccount(el.dataset.color, { color: el.value }).catch(showError); });
    $$('[data-rm]').forEach((b) => { b.onclick = async () => { if (await confirmDialog('Remove mailbox?', 'This removes it from the app and forgets its sign-in on this PC. Your mail isn’t touched.', { ok: 'Remove', danger: true })) { await svc.removeAccount(b.dataset.rm); renderAccts(); } }; });
    $$('[data-signin]').forEach((b) => { b.onclick = () => { const a = acctOf(b.dataset.signin); svc.signIn(a.provider, a.email); }; });
  };
  renderAccts();
  const needSetup = (kind) => { toast(`Add your ${kind === 'google' ? 'Google client ID and secret' : 'Microsoft application ID'} under “Sign-in setup” first.`); $('#ids').scrollIntoView({ behavior: 'smooth' }); };
  $('#addG').onclick = () => (svc.state.setup.google ? svc.signIn('google') : needSetup('google'));
  $('#addM').onclick = () => (svc.state.setup.microsoft ? svc.signIn('microsoft') : needSetup('microsoft'));
  $('#prefs').onchange = (e) => svc.savePrefs({ [e.target.name]: e.target.checked });
  $('#ids').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await svc.saveSignInSettings({ googleClientId: f.googleClientId.value, googleClientSecret: f.googleClientSecret.value, microsoftClientId: f.microsoftClientId.value });
      toast('Saved');
      showSettings();
    } catch (err) { showError(err); }
  };
  $('#clearCache').onclick = async () => { await svc.clearMailCache(); toast('Cleared. Lists reload from your mailboxes.'); };
  $('#checkUpd').onclick = async (e) => {
    e.target.disabled = true; e.target.textContent = 'Checking…';
    const u = await checkForUpdate();
    e.target.disabled = false; e.target.textContent = 'Check for updates';
    if (u.offline) { toast(u.error || 'Couldn’t check. Are you online?'); return; }
    $('#updInfo').innerHTML = u.available
      ? `<div class="banner info" style="flex-direction:column;align-items:flex-start"><strong>Version ${esc(u.latest)} is ready.</strong>${u.changes.length ? `<ul style="margin:4px 0 0;padding-left:18px">${u.changes.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>` : ''}<button class="btn small primary" id="doUpd" style="margin-top:6px">Update now</button></div>`
      : '<p style="color:var(--good)">You’re on the latest version.</p>';
    $('#doUpd')?.addEventListener('click', (ev) => { ev.target.disabled = true; ev.target.textContent = 'Updating…'; installUpdate().catch(showError); });
  };
}

export { icon };
