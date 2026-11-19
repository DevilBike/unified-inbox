// Checking for and installing new versions of the app.
import { APP_VERSION } from './version.js';

let registration = null;

export function setRegistration(reg) { registration = reg; }

function newer(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
}

// Returns { available, current, latest, changes } — never throws.
export async function checkForUpdate() {
  try {
    const res = await fetch(`version.json?t=${Date.now()}`, { cache: 'no-store' });
    const info = await res.json();
    return { available: newer(info.version, APP_VERSION), current: APP_VERSION, latest: info.version, date: info.date, changes: info.changes || [] };
  } catch {
    return { available: false, current: APP_VERSION, latest: null, changes: [], offline: true };
  }
}

// Throws away cached copies of the app and reloads with the newest files.
export async function installUpdate() {
  try { await registration?.update(); } catch { /* fine */ }
  try {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
  } catch { /* no cache storage */ }
  // Refresh the browser's own cache of the app's files too.
  const files = ['index.html', 'auth.html', 'css/app.css', 'sw.js', 'manifest.webmanifest', 'js/app.js', 'js/version.js', 'js/update.js', 'js/service.js', 'js/store.js', 'js/auth.js', 'js/config.js',
    'js/ui/dom.js', 'js/ui/mail.js', 'js/ui/pages.js', 'js/ui/compose.js', 'js/ui/notes.js', 'js/providers/http.js', 'js/providers/gmail.js', 'js/providers/graph.js',
    'js/core/folders.js', 'js/core/rules.js', 'js/core/importers.js', 'js/core/compile.js', 'js/core/cleanup.js', 'js/core/mime.js', 'js/core/phish.js', 'js/core/snooze.js', 'js/core/default-rules.js'];
  await Promise.all(files.map((f) => fetch(f, { cache: 'reload' }).catch(() => null)));
  location.reload();
}

export { APP_VERSION };
