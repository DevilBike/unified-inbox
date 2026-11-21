// Checking for and installing new versions. The local app downloads the newest files
// from GitHub, swaps them in and restarts itself; this page then reloads.
import { APP_VERSION } from './version.js';
import { api } from './api.js';

// Returns { available, current, latest, changes } and never throws.
export async function checkForUpdate() {
  try {
    const u = await api('update');
    return { ...u, current: APP_VERSION };
  } catch (e) {
    return { available: false, current: APP_VERSION, latest: null, changes: [], offline: true, error: e.message };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function installUpdate() {
  const r = await api('update', { method: 'POST' });
  if (!r.restarting) {
    alert('The update is downloaded. Close the Unified Inbox window and start it again to finish.');
    return;
  }
  // Wait for the app to come back, then load the new screens.
  await sleep(1500);
  for (let i = 0; i < 40; i += 1) {
    try { await api('ping'); break; } catch { await sleep(500); }
  }
  location.reload();
}

export { APP_VERSION };
