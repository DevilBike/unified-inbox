// MIME and encoding helpers (work in browsers and Node 18+).

export function base64UrlToBytes(s) {
  const b64 = String(s).replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '';
  const bin = atob(b64 + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export function bytesToBase64(bytes) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(bin);
}

export function base64UrlDecodeText(s, charset = 'utf-8') {
  const bytes = base64UrlToBytes(s);
  try { return new TextDecoder(charset).decode(bytes); } catch { return new TextDecoder('utf-8').decode(bytes); }
}

export function textToBase64(text) {
  return bytesToBase64(new TextEncoder().encode(text));
}

export function textToBase64Url(text) {
  return textToBase64(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function getHeader(headers, name) {
  const h = (headers || []).find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
}

// "Name <a@b.com>" -> { name, address }
export function parseAddress(s) {
  const str = String(s || '').trim();
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(str);
  if (m) return { name: m[1].trim(), address: m[2].trim().toLowerCase() };
  return { name: '', address: str.replace(/[<>]/g, '').trim().toLowerCase() };
}

// Split an address list on commas that are not inside quotes or <>.
export function parseAddressList(s) {
  const out = [];
  let cur = '', q = false, angle = false;
  for (const ch of String(s || '')) {
    if (ch === '"') q = !q;
    if (!q && ch === '<') angle = true;
    if (!q && ch === '>') angle = false;
    if (ch === ',' && !q && !angle) { if (cur.trim()) out.push(parseAddress(cur)); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(parseAddress(cur));
  return out.filter((a) => a.address);
}

export function formatAddress(a) {
  if (!a) return '';
  return a.name ? `"${a.name.replace(/"/g, '')}" <${a.address}>` : a.address;
}

function charsetOf(part) {
  const ct = getHeader(part.headers, 'Content-Type');
  const m = /charset="?([^";]+)"?/i.exec(ct);
  return m ? m[1] : 'utf-8';
}

// Walk a Gmail message payload: find the best body and the attachments.
export function extractGmailParts(payload) {
  let html = '', text = '';
  const attachments = [];
  let calendar = null;
  const walk = (part) => {
    if (!part) return;
    const mime = (part.mimeType || '').toLowerCase();
    const filename = part.filename || '';
    if (filename && part.body?.attachmentId) {
      attachments.push({ id: part.body.attachmentId, name: filename, mimeType: mime, size: part.body.size || 0, inline: /inline/i.test(getHeader(part.headers, 'Content-Disposition')), contentId: getHeader(part.headers, 'Content-ID').replace(/[<>]/g, '') });
    } else if (part.body?.data) {
      if (mime === 'text/html' && !html) html = base64UrlDecodeText(part.body.data, charsetOf(part));
      else if (mime === 'text/plain' && !text) text = base64UrlDecodeText(part.body.data, charsetOf(part));
      else if (mime === 'text/calendar' && !calendar) calendar = base64UrlDecodeText(part.body.data, charsetOf(part));
    } else if (mime === 'text/calendar' && part.body?.attachmentId) {
      calendar = { attachmentId: part.body.attachmentId };
    }
    (part.parts || []).forEach(walk);
  };
  walk(payload);
  return { html, text, attachments, calendar };
}

// Pull UID and METHOD from an iCalendar invite.
export function parseIcsInvite(ics) {
  const unfolded = String(ics || '').replace(/\r?\n[ \t]/g, '');
  const get = (k) => { const m = new RegExp(`^${k}(?:;[^:]*)?:(.*)$`, 'mi').exec(unfolded); return m ? m[1].trim() : ''; };
  return { uid: get('UID'), method: get('METHOD').toUpperCase(), summary: get('SUMMARY'), start: get('DTSTART'), end: get('DTEND'), location: get('LOCATION') };
}

export function encodeHeaderWord(s) {
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${textToBase64(s)}?=`;
}

function wrap76(b64) {
  return b64.replace(/.{1,76}/g, '$&\r\n').trimEnd();
}

// Build an RFC 822 message for Gmail's send/draft API.
// attachments: [{ name, mimeType, base64 }]
export function buildRawMessage({ from, to = [], cc = [], bcc = [], subject = '', text = '', html = '', inReplyTo = '', references = '', attachments = [] }) {
  const boundary = `ui_${Math.random().toString(36).slice(2)}`;
  const alt = `alt_${Math.random().toString(36).slice(2)}`;
  const lines = [];
  if (from) lines.push(`From: ${formatAddress(from)}`);
  if (to.length) lines.push(`To: ${to.map(formatAddress).join(', ')}`);
  if (cc.length) lines.push(`Cc: ${cc.map(formatAddress).join(', ')}`);
  if (bcc.length) lines.push(`Bcc: ${bcc.map(formatAddress).join(', ')}`);
  lines.push(`Subject: ${encodeHeaderWord(subject)}`);
  if (inReplyTo) lines.push(`In-Reply-To: ${inReplyTo}`);
  if (references) lines.push(`References: ${references}`);
  lines.push('MIME-Version: 1.0');
  const bodyPart = () => {
    if (!html) return [`Content-Type: text/plain; charset="UTF-8"`, 'Content-Transfer-Encoding: base64', '', wrap76(textToBase64(text))];
    return [
      `Content-Type: multipart/alternative; boundary="${alt}"`, '',
      `--${alt}`, `Content-Type: text/plain; charset="UTF-8"`, 'Content-Transfer-Encoding: base64', '', wrap76(textToBase64(text)),
      `--${alt}`, `Content-Type: text/html; charset="UTF-8"`, 'Content-Transfer-Encoding: base64', '', wrap76(textToBase64(html)),
      `--${alt}--`,
    ];
  };
  if (!attachments.length) {
    lines.push(...bodyPart());
  } else {
    lines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`, '', `--${boundary}`, ...bodyPart());
    for (const a of attachments) {
      const safe = String(a.name).replace(/"/g, '');
      lines.push(`--${boundary}`, `Content-Type: ${a.mimeType || 'application/octet-stream'}; name="${encodeHeaderWord(safe)}"`,
        `Content-Disposition: attachment; filename="${encodeHeaderWord(safe)}"`, 'Content-Transfer-Encoding: base64', '', wrap76(a.base64));
    }
    lines.push(`--${boundary}--`);
  }
  return lines.join('\r\n');
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function textToHtml(text) {
  return `<div style="white-space:pre-wrap;font-family:inherit">${escapeHtml(text)}</div>`;
}

// Simple quote of the original for replies/forwards.
export function quoteForReply(msg, bodyText) {
  const when = new Date(msg.date).toLocaleString();
  const who = msg.from?.name ? `${msg.from.name} <${msg.from.address}>` : msg.from?.address;
  const quoted = String(bodyText || msg.snippet || '').split('\n').map((l) => `> ${l}`).join('\n');
  return `\n\nOn ${when}, ${who} wrote:\n${quoted}`;
}

export function htmlToText(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|h\d|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
