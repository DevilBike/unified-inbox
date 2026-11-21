// Shows one email: header, warnings, attachments and the body in a locked-down frame.
// Used by the reading pane and by the cleanup review.
import { esc, fullTime, fmtBytes, icon, showError } from './dom.js';
import * as svc from '../service.js';
import { phishingHint } from '../core/phish.js';

function frameDoc(full, allowImages) {
  const body = full.html || `<pre style="white-space:pre-wrap;font:14px/1.6 system-ui,sans-serif">${esc(full.text || full.snippet || '')}</pre>`;
  const img = allowImages ? 'img-src https: http: data:;' : 'img-src data:;';
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; ${img} style-src 'unsafe-inline'; font-src data: https:; media-src 'none'"><base target="_blank"><style>body{margin:0;padding:16px;font:14px/1.55 system-ui,sans-serif;color:#1b1d22;background:#fff;word-wrap:break-word}img{max-width:100%;height:auto}table{max-width:100%}</style></head><body>${body}</body></html>`;
}

const hasRemoteImages = (html) => /<img[^>]+src=["']?https?:/i.test(html || '') || /url\(["']?https?:/i.test(html || '');

// Renders into `el`. Returns nothing; "Show images" re-renders in place.
export function renderMessage(el, full, { allowImages = svc.state.prefs.remoteImages, extra = '' } = {}) {
  const a = svc.state.accounts.find((x) => x.id === full.accountId);
  const hint = phishingHint(full.from, full.subject, full.snippet);
  const atts = (full.attachments || []).filter((x) => !x.inline);
  el.innerHTML = `
    <h2>${esc(full.subject || '(no subject)')}</h2>
    <div class="sender">
      <span class="avatar" style="color:${esc(a?.color || '#E7E9EE')}">${esc((full.from?.name || full.from?.address || '?').charAt(0).toUpperCase())}</span>
      <span style="display:flex;flex-direction:column;gap:2px;min-width:0">
        <span style="font-weight:600">${esc(full.from?.name || full.from?.address)} <span class="muted" style="font-weight:400">${full.from?.name ? `&lt;${esc(full.from.address)}&gt;` : ''}</span></span>
        <span class="muted" style="font-size:12px">to ${esc((full.to || []).map((t) => t.address).join(', ') || a?.email)}${full.cc?.length ? ` · cc ${esc(full.cc.map((t) => t.address).join(', '))}` : ''} · ${esc(fullTime(full.date))} · in ${esc(a?.email || '')}</span>
      </span>
    </div>
    ${extra}
    ${hint ? `<div class="banner warn" role="alert"><strong>Possible scam.</strong> ${esc(hint)}</div>` : ''}
    ${!allowImages && hasRemoteImages(full.html) ? '<div class="banner info"><span style="flex:1">Images are hidden to protect your privacy.</span><button class="btn small" data-show-images>Show images</button></div>' : ''}
    ${atts.length ? `<div class="attachments">${atts.map((x, i) => `<button class="att" data-att="${i}">${icon('clip')} ${esc(x.name)} <span class="muted">${fmtBytes(x.size)}</span></button>`).join('')}</div>` : ''}
    <iframe class="mail-frame" title="Message" sandbox="allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer"></iframe>`;
  el.querySelector('iframe').srcdoc = frameDoc(full, allowImages);
  el.querySelector('[data-show-images]')?.addEventListener('click', () => renderMessage(el, full, { allowImages: true, extra }));
  el.querySelectorAll('[data-att]').forEach((b) => { b.onclick = () => svc.downloadAttachment(full, atts[Number(b.dataset.att)]).catch(showError); });
}
