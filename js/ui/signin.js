// Signing in: opens Google or Microsoft in your normal browser (where you're usually
// already signed in), then waits here until you've approved it.
import { esc, toast, openDialog } from './dom.js';
import * as svc from '../service.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Resolves to the signed-in email, or null if cancelled / failed.
export async function signInFlow(provider, hint = '') {
  const name = provider === 'google' ? 'Google' : 'Microsoft';
  let start;
  try { start = await svc.startSignIn(provider, hint); } catch (e) { toast(e.message, { timeout: 9000 }); return null; }
  if (!start.opened) window.open(start.url, '_blank', 'noopener');
  let cancelled = false;
  return openDialog((d, close) => {
    d.innerHTML = `<div class="dlg"><header><h2>Approve in your browser</h2></header>
      <p class="muted" style="margin:0;line-height:1.5">${esc(name)}’s sign-in page is open in your browser${hint ? ` for <strong>${esc(hint)}</strong>` : ''}. Pick the account and click <strong>Allow</strong>. This window updates by itself.</p>
      <div class="progress indeterminate"><span></span></div>
      <footer><button class="btn" data-again>Open it again</button><button class="btn" data-x>Cancel</button></footer></div>`;
    d.querySelector('[data-x]').onclick = () => { cancelled = true; close(null); };
    d.querySelector('[data-again]').onclick = () => window.open(start.url, '_blank', 'noopener');
    (async () => {
      const until = Date.now() + 15 * 60000;
      while (!cancelled && Date.now() < until) {
        await sleep(1500);
        let r;
        try { r = await svc.signInResult(start.state); } catch { continue; }
        if (!r.done) continue;
        if (r.error) { toast(r.error, { timeout: 12000 }); close(null); return; }
        await svc.afterSignIn(r.email);
        toast(`Signed in to ${r.email}`);
        close(r.email);
        return;
      }
      if (!cancelled) { toast('Sign-in timed out. Try again.'); close(null); }
    })();
  });
}
