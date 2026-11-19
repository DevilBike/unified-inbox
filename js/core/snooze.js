// Snooze is stored in the mailbox itself so every device sees it:
// Gmail: a label "Snoozed/2026-11-20T15:00Z"; Outlook: the message sits in a
// "Snoozed" folder with a category "Snoozed until 2026-11-20T15:00Z".

export const SNOOZE_ROOT = 'Snoozed';
const CATEGORY_PREFIX = 'Snoozed until ';

export function toIsoMinute(ms) {
  return new Date(Math.floor(ms / 60000) * 60000).toISOString().replace(/:\d\d\.\d{3}Z$/, 'Z');
}

export function snoozeLabelName(ms) { return `${SNOOZE_ROOT}/${toIsoMinute(ms)}`; }
export function snoozeCategory(ms) { return `${CATEGORY_PREFIX}${toIsoMinute(ms)}`; }

function parseIsoMinute(s) {
  const t = Date.parse(String(s).replace(/Z$/, ':00Z'));
  return Number.isFinite(t) ? t : null;
}

export function parseSnoozeLabel(name) {
  const m = /^Snoozed\/(\d{4}-\d\d-\d\dT\d\d:\d\dZ)$/.exec(String(name || ''));
  return m ? parseIsoMinute(m[1]) : null;
}

export function parseSnoozeCategory(cat) {
  const s = String(cat || '');
  return s.startsWith(CATEGORY_PREFIX) ? parseIsoMinute(s.slice(CATEGORY_PREFIX.length)) : null;
}

export function isSnoozeCategory(cat) { return String(cat || '').startsWith(CATEGORY_PREFIX); }

// Snooze presets in local time.
export function snoozePresets(now = new Date()) {
  const at = (d, h, m = 0) => { const x = new Date(d); x.setHours(h, m, 0, 0); return x; };
  const laterToday = new Date(now.getTime() + 3 * 3600000);
  const tomorrow = at(new Date(now.getTime() + 86400000), 8);
  const sat = new Date(now); sat.setDate(now.getDate() + ((6 - now.getDay() + 7) % 7 || 7));
  const mon = new Date(now); mon.setDate(now.getDate() + ((1 - now.getDay() + 7) % 7 || 7));
  return [
    { label: 'Later today', at: laterToday.getTime() },
    { label: 'Tomorrow morning', at: tomorrow.getTime() },
    { label: 'This weekend', at: at(sat, 9).getTime() },
    { label: 'Next week', at: at(mon, 8).getTime() },
  ];
}
