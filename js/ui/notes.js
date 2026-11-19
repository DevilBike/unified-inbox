// "Notes for Claude": jot down bugs, ideas and changes as you use the app,
// then send them to GitHub as issues. When it's time to iterate, Claude reads
// the open issues whose titles start with [Claude] (see CLAUDE.md).
import { $, $$, esc, toast, confirmDialog, fullTime } from './dom.js';
import { kv } from '../store.js';
import { APP_VERSION } from '../version.js';

const REPO = 'DevilBike/unified-inbox';
const KINDS = ['Bug', 'Idea', 'Change', 'Question'];

async function load() { return (await kv.get('claudeNotes')) || []; }
async function save(list) { await kv.set('claudeNotes', list); }

function context(note) {
  const device = window.matchMedia('(max-width: 860px)').matches ? 'phone' : 'desktop';
  return [`App version: ${APP_VERSION}`, `Device: ${device} (${navigator.userAgent.match(/Android|Windows|Mac OS X|iPhone|Linux/)?.[0] || 'unknown'})`,
    note.screen ? `Screen: ${note.screen}` : '', `Written: ${new Date(note.at).toISOString().slice(0, 16).replace('T', ' ')}`].filter(Boolean).join('\n');
}

// Title starts with [Claude] so they're easy to find. Body stays well under URL limits.
export function issueUrl(notes) {
  const one = notes.length === 1;
  const first = notes[0];
  const title = one
    ? `[Claude] ${first.kind}: ${first.text.split('\n')[0].slice(0, 70)}`
    : `[Claude] ${notes.length} notes (${[...new Set(notes.map((n) => n.kind))].join(', ')})`;
  const body = notes.map((n, i) => `${one ? '' : `### ${i + 1}. ${n.kind}\n\n`}${n.text.trim()}\n\n<sub>${context(n).replace(/\n/g, ' · ')}</sub>`).join('\n\n---\n\n').slice(0, 6000);
  return `https://github.com/${REPO}/issues/new?${new URLSearchParams({ title, body })}`;
}

export async function quickNote(screen) {
  location.hash = `#/notes?from=${encodeURIComponent(screen || '')}`;
}

export async function showNotes(params = new URLSearchParams()) {
  const main = $('#main');
  main.className = 'main';
  const from = params.get('from') || '';
  main.innerHTML = `<div class="page"><div class="page-head"><h1>Notes for Claude</h1></div>
    <div class="cols"><section class="col-main">
      <form class="card" id="noteForm"><h2>New note</h2>
        <p>Write down anything you want changed: bugs, ideas, things that annoyed you. Send them to GitHub when you’re ready, and Claude reads them next time you work on the app together.</p>
        <label class="field">Type<select class="input" name="kind" style="max-width:220px">${KINDS.map((k) => `<option>${k}</option>`).join('')}</select></label>
        <label class="field">Note<textarea class="input" name="text" rows="5" placeholder="e.g. On my phone the Snooze button is hard to reach…" autofocus></textarea></label>
        <label class="field">Where in the app <span class="muted" style="font-size:12px">(optional)</span><input class="input" name="screen" value="${esc(from)}" placeholder="e.g. Inbox, Rules, Clean up"></label>
        <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn primary">Save note</button><button type="button" class="btn" id="saveSend">Save &amp; send to GitHub</button></div>
      </form>
      <div id="noteList"></div>
    </section>
    <aside class="col-side"><div class="card"><h2>How this works</h2>
      <p>Notes are kept on this device until you send them. Sending opens GitHub with the note filled in as an issue; tap <strong>Submit new issue</strong> there.</p>
      <p>Next time you ask Claude to work on the app, it reads every open issue whose title starts with <code>[Claude]</code> and closes them as they’re done.</p>
      <p><a href="https://github.com/${REPO}/issues?q=is%3Aopen+%5BClaude%5D" target="_blank" rel="noopener">See sent notes on GitHub</a></p></div></aside></div></div>`;

  const render = async () => {
    const list = await load();
    const drafts = list.filter((n) => !n.sentAt);
    const sent = list.filter((n) => n.sentAt);
    const row = (n) => `<div style="display:flex;flex-direction:column;gap:6px;border-top:1px solid var(--line);padding-top:10px">
      <div style="display:flex;gap:8px;align-items:baseline;flex-wrap:wrap"><span class="tag" style="color:var(--accent)">${esc(n.kind)}</span><span class="muted" style="font-size:12px">${esc(fullTime(n.at))}${n.screen ? ` · ${esc(n.screen)}` : ''}${n.sentAt ? ' · sent' : ''}</span></div>
      <div style="white-space:pre-wrap">${esc(n.text)}</div>
      <div style="display:flex;gap:8px">${n.sentAt ? '' : `<button class="btn small" data-send="${esc(n.id)}">Send to GitHub</button>`}<button class="btn small ghost" data-del="${esc(n.id)}">Delete</button></div></div>`;
    $('#noteList').innerHTML = `<div class="card"><div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap"><h2>Not sent yet (${drafts.length})</h2>
      ${drafts.length > 1 ? '<button class="btn small primary" id="sendAll">Send all as one issue</button>' : ''}</div>
      ${drafts.map(row).join('') || '<p>Nothing waiting.</p>'}</div>
      ${sent.length ? `<details class="card"><summary style="cursor:pointer">Sent (${sent.length})</summary>${sent.slice(0, 30).map(row).join('')}</details>` : ''}`;
    $$('[data-send]').forEach((b) => { b.onclick = () => send([b.dataset.send]); });
    $$('[data-del]').forEach((b) => { b.onclick = async () => { if (await confirmDialog('Delete note?', 'This only deletes it from this device.', { ok: 'Delete', danger: true })) { await save((await load()).filter((n) => n.id !== b.dataset.del)); render(); } }; });
    $('#sendAll')?.addEventListener('click', () => send(drafts.map((n) => n.id)));
  };

  const send = async (ids) => {
    const list = await load();
    const picked = list.filter((n) => ids.includes(n.id));
    if (!picked.length) return;
    window.open(issueUrl(picked), '_blank', 'noopener');
    const now = Date.now();
    await save(list.map((n) => (ids.includes(n.id) ? { ...n, sentAt: now } : n)));
    toast('GitHub opened. Tap “Submit new issue” there to finish.', { timeout: 8000 });
    render();
  };

  const add = async (alsoSend) => {
    const f = $('#noteForm');
    const text = f.text.value.trim();
    if (!text) { toast('Write the note first.'); f.text.focus(); return; }
    const note = { id: `n_${Date.now().toString(36)}`, kind: f.kind.value, text, screen: f.screen.value.trim(), at: Date.now() };
    await save([note, ...(await load())]);
    f.text.value = '';
    if (alsoSend) await send([note.id]); else { toast('Note saved'); render(); }
  };
  $('#noteForm').onsubmit = (e) => { e.preventDefault(); add(false); };
  $('#saveSend').onclick = () => add(true);
  render();
}
