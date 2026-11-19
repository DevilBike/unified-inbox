import { escapeHtml } from '../core/mime.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const esc = escapeHtml;

export function toast(message, { action, onAction, timeout = 5000 } = {}) {
  const host = $('#toasts');
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<span>${esc(message)}</span>${action ? `<button class="btn small">${esc(action)}</button>` : ''}`;
  host.appendChild(el);
  const close = () => el.remove();
  if (action) el.querySelector('button').addEventListener('click', () => { close(); onAction?.(); });
  setTimeout(close, timeout);
  return close;
}

export function showError(e, prefix = '') {
  console.error(e);
  toast(`${prefix}${e?.message || e}`, { timeout: 7000 });
}

// Open a modal. build(dialogEl, close) fills it. Resolves with the value passed to close().
export function openDialog(build) {
  const d = $('#dialog');
  return new Promise((resolve) => {
    let done = false;
    const close = (value) => { if (done) return; done = true; d.close(); d.innerHTML = ''; resolve(value); };
    d.onclose = () => { if (!done) { done = true; d.innerHTML = ''; resolve(undefined); } };
    d.innerHTML = '';
    build(d, close);
    d.showModal();
    const first = d.querySelector('[autofocus]') || d.querySelector('input, textarea, select, button');
    first?.focus();
  });
}

export function dialogOpen() { return $('#dialog').open; }

export function confirmDialog(title, body, { ok = 'OK', danger = false } = {}) {
  return openDialog((d, close) => {
    d.innerHTML = `<div class="dlg"><header><h2>${esc(title)}</h2></header><p class="muted" style="margin:0;line-height:1.5">${body}</p>
      <footer><button class="btn" data-x>Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" data-ok autofocus>${esc(ok)}</button></footer></div>`;
    d.querySelector('[data-x]').onclick = () => close(false);
    d.querySelector('[data-ok]').onclick = () => close(true);
  });
}

export function timeLabel(ms) {
  const d = new Date(ms);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const diff = (now - d) / 86400000;
  if (diff < 6) return d.toLocaleDateString([], { weekday: 'short' });
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return d.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
}

export function fullTime(ms) {
  return new Date(ms).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function fmtBytes(n) {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

export const ICONS = {
  inbox: '<path d="M4 13h4l2 3h4l2-3h4"/><path d="M5 5h14l1 8v6H4v-6z"/>',
  receipts: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>',
  finance: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M3 10h18"/>',
  jobs: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5h6v2"/>',
  news: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/>',
  promotions: '<path d="M3 11l14-6v14L3 13z"/><path d="M7 13v5"/>',
  snoozed: '<circle cx="12" cy="13" r="7"/><path d="M12 10v3l2 2M9 3h6"/>',
  flagged: '<path d="M5 21V4h11l-2 4 2 4H5"/>',
  drafts: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
  sent: '<path d="M4 12l16-8-6 16-3-6z"/>',
  junk: '<circle cx="12" cy="12" r="8"/><path d="M6.5 6.5l11 11"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  contacts: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4-6 8-6s7 2 8 6"/>',
  rules: '<path d="M4 6h16M4 12h10M4 18h6"/>',
  cleanup: '<path d="M3 21l6-6M14 4l6 6-8 8-6-6z"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2"/>',
  back: '<path d="M15 18l-6-6 6-6"/>',
  clip: '<path d="M8 12l6-6a3 3 0 014 4l-8 8a5 5 0 01-7-7l7-7"/>',
};

export function icon(name, cls = 'icon') {
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}
