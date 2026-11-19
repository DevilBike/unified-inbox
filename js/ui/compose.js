import { openDialog, esc, toast, showError, confirmDialog, fmtBytes } from './dom.js';
import * as svc from '../service.js';
import { parseAddressList, formatAddress } from '../core/mime.js';
import { fileToBase64 } from '../providers/http.js';

const MAX_ATTACH = 20 * 1024 * 1024;

function prefixSubject(prefix, subject) {
  const s = subject || '';
  return new RegExp(`^${prefix}:`, 'i').test(s) ? s : `${prefix}: ${s}`;
}

// opts: { mode: 'new'|'reply'|'replyAll'|'forward', original, accountId, to, subject, text, draftId }
export function openCompose(opts = {}) {
  const accounts = svc.state.accounts;
  if (!accounts.length) { toast('Add a mailbox in Settings first.'); return; }
  const mode = opts.mode || 'new';
  const o = opts.original;
  const accountId = opts.accountId || o?.accountId || accounts[0].id;
  const me = accounts.find((a) => a.id === accountId);
  let to = opts.to || [];
  let cc = [];
  let subject = opts.subject || '';
  if (o && mode !== 'new') {
    if (mode === 'forward') subject = prefixSubject('Fwd', o.subject);
    else {
      subject = prefixSubject('Re', o.subject);
      to = [o.from];
      if (mode === 'replyAll') {
        const others = [...(o.to || []), ...(o.cc || [])].filter((a) => a.address !== me.email && a.address !== o.from.address);
        cc = others;
      }
    }
  }
  const title = { new: 'New message', reply: 'Reply', replyAll: 'Reply all', forward: 'Forward' }[mode];
  const files = [];
  const uploaded = new WeakSet(); // files already attached to a saved Outlook draft
  let draftId = opts.draftId || null;
  let dirty = false;

  return openDialog((d, close) => {
    d.innerHTML = `<form class="dlg" novalidate>
      <header><h2>${esc(title)}</h2><button type="button" class="btn ghost small" data-close aria-label="Close">Close</button></header>
      <label class="field">From
        <select class="input" name="from" ${o && mode !== 'new' ? 'disabled' : ''}>${accounts.map((a) => `<option value="${esc(a.id)}" ${a.id === accountId ? 'selected' : ''}>${esc(a.email)}</option>`).join('')}</select>
      </label>
      ${addrField('to', 'To', to)}
      <div data-ccrow ${cc.length ? '' : 'hidden'}>${addrField('cc', 'Cc', cc)}${addrField('bcc', 'Bcc', [])}</div>
      <button type="button" class="btn ghost small" data-showcc ${cc.length ? 'hidden' : ''} style="align-self:flex-start">Add Cc / Bcc</button>
      <label class="field">Subject<input class="input" name="subject" value="${esc(subject)}"></label>
      <label class="field">Message<textarea class="input" name="text" rows="10" ${mode === 'new' ? '' : 'autofocus'}>${esc(opts.text || '')}</textarea></label>
      ${o && mode !== 'new' && mode !== 'forward' ? '<p class="muted" style="margin:0;font-size:12px">The original message is quoted below your reply when it’s sent.</p>' : ''}
      ${o && mode === 'forward' && o.attachments?.length ? `<p class="muted" style="margin:0;font-size:12px">The original’s ${o.attachments.length} attachment(s) will be included.</p>` : ''}
      <div class="attachments" data-files></div>
      <footer>
        <label class="btn" style="margin-right:auto">Attach<input type="file" multiple hidden data-file></label>
        <button type="button" class="btn ghost" data-discard>Discard</button>
        <button type="button" class="btn" data-save>Save draft</button>
        <button type="submit" class="btn primary">Send</button>
      </footer>
    </form>`;
    const form = d.querySelector('form');
    const field = (n) => form.elements[n];
    form.addEventListener('input', () => { dirty = true; });
    wireAddr(d);
    d.querySelector('[data-showcc]').onclick = (e) => { d.querySelector('[data-ccrow]').hidden = false; e.target.hidden = true; };
    const renderFiles = () => {
      d.querySelector('[data-files]').innerHTML = files.map((f, i) => `<span class="att">${esc(f.name)} <span class="muted">${fmtBytes(f.size)}</span><button type="button" class="btn ghost small" data-rm="${i}" aria-label="Remove ${esc(f.name)}">×</button></span>`).join('');
      d.querySelectorAll('[data-rm]').forEach((b) => { b.onclick = () => { files.splice(Number(b.dataset.rm), 1); renderFiles(); }; });
    };
    d.querySelector('[data-file]').onchange = (e) => {
      for (const f of e.target.files) {
        if (files.reduce((n, x) => n + x.size, 0) + f.size > MAX_ATTACH) { toast('Attachments are limited to 20 MB in total.'); break; }
        files.push(f);
      }
      e.target.value = '';
      dirty = true;
      renderFiles();
    };

    const collect = async () => ({
      accountId: field('from').value,
      mode, original: o, draftId,
      to: parseAddressList(field('to').value), cc: parseAddressList(field('cc').value), bcc: parseAddressList(field('bcc').value),
      subject: field('subject').value, text: field('text').value,
      attachments: await Promise.all(files.map(toAttachment)),
      newAttachments: await Promise.all(files.filter((f) => !uploaded.has(f)).map(toAttachment)),
    });
    const toAttachment = async (f) => ({ name: f.name, mimeType: f.type || 'application/octet-stream', base64: await fileToBase64(f) });
    const busy = (on) => form.querySelectorAll('button, select, input, textarea').forEach((el) => { el.disabled = on; });

    form.onsubmit = async (e) => {
      e.preventDefault();
      const draft = await collect();
      if (!draft.to.length && !draft.cc.length && !draft.bcc.length) { toast('Add at least one recipient.'); field('to').focus(); return; }
      busy(true);
      try {
        await svc.sendDraft(draft);
        toast('Sent');
        close(true);
      } catch (err) { busy(false); showError(err, 'Not sent: '); }
    };
    d.querySelector('[data-save]').onclick = async () => {
      busy(true);
      try { draftId = await svc.saveDraft(await collect()); dirty = false; files.forEach((f) => uploaded.add(f)); toast('Draft saved'); } catch (err) { showError(err, 'Draft not saved: '); }
      busy(false);
      if (o && mode !== 'new') field('from').disabled = true;
    };
    d.querySelector('[data-discard]').onclick = async () => {
      if (dirty && !(await confirmDialogInline(d))) return;
      try { if (draftId) await svc.discardDraft(field('from').value, draftId); } catch (err) { showError(err); }
      close(false);
    };
    d.querySelector('[data-close]').onclick = async () => {
      if (dirty) {
        try { draftId = await svc.saveDraft(await collect()); toast('Saved to Drafts'); } catch (err) { showError(err, 'Draft not saved: '); return; }
      }
      close(false);
    };
    d.addEventListener('cancel', (e) => { if (dirty) { e.preventDefault(); d.querySelector('[data-close]').click(); } });
  });
}

function confirmDialogInline(d) {
  return Promise.resolve(window.confirm('Discard this message?'));
}

function addrField(name, label, list) {
  return `<div class="field addr-wrap"><label for="f-${name}" style="font-size:13px;color:var(--text-2)">${label}</label>
    <input class="input" id="f-${name}" name="${name}" autocomplete="off" value="${esc(list.map(formatAddress).join(', '))}${list.length ? ', ' : ''}">
    <div class="suggest" hidden></div></div>`;
}

function wireAddr(root) {
  root.querySelectorAll('.addr-wrap').forEach((wrap) => {
    const input = wrap.querySelector('input');
    const box = wrap.querySelector('.suggest');
    let items = [];
    let on = 0;
    const lastToken = () => input.value.split(',').pop().trim();
    const pick = (c) => {
      const parts = input.value.split(',');
      parts[parts.length - 1] = ` ${formatAddress({ name: c.name, address: c.email })}`;
      input.value = `${parts.join(',').replace(/^\s+/, '')}, `;
      box.hidden = true;
      input.focus();
    };
    const render = () => {
      box.innerHTML = items.map((c, i) => `<button type="button" class="${i === on ? 'on' : ''}" data-i="${i}">${esc(c.name || c.email)} <span class="muted">${esc(c.name ? c.email : '')}</span></button>`).join('');
      box.hidden = !items.length;
      box.querySelectorAll('button').forEach((b) => { b.onmousedown = (e) => { e.preventDefault(); pick(items[Number(b.dataset.i)]); }; });
    };
    input.addEventListener('input', async () => {
      const t = lastToken();
      items = t.length >= 2 ? await svc.suggestContacts(t) : [];
      on = 0;
      render();
    });
    input.addEventListener('keydown', (e) => {
      if (box.hidden) return;
      if (e.key === 'ArrowDown') { on = (on + 1) % items.length; render(); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { on = (on - 1 + items.length) % items.length; render(); e.preventDefault(); }
      else if (e.key === 'Enter' || e.key === 'Tab') { if (items[on]) { e.preventDefault(); pick(items[on]); } }
      else if (e.key === 'Escape') { box.hidden = true; e.stopPropagation(); e.preventDefault(); }
    });
    input.addEventListener('blur', () => setTimeout(() => { box.hidden = true; }, 150));
  });
}

export { confirmDialog };
