# Working on Unified Inbox

A personal, installable web app (Windows + Android) that puts several Gmail and
Outlook.com mailboxes in one inbox. Hosted on GitHub Pages. No server and no build
step: plain HTML, CSS and ES modules.

## Start every session by reading the owner's notes

The owner writes notes inside the app (**Notes for Claude**) and sends them here as
GitHub issues whose titles start with `[Claude]`.

1. List the open issues whose titles start with `[Claude]`. Read each one. They carry
   the app version, device (phone/desktop) and screen they were written on.
2. Summarise them back to the owner and confirm what to tackle before changing code.
3. When one is done, comment on the issue with what changed and close it.

## Rules

- **The repo is public.** Never commit email addresses, names, mail content, tokens or
  secrets. Tests use placeholders like `person.one@example.com`. Client IDs in
  `js/config.js` are public by design; client secrets live only in the Cloudflare
  Worker's settings.
- **No dependencies, no build step.** Everything must run straight from GitHub Pages.
  `tools/serve.mjs` serves it locally (`npm start`).
- **Anything that moves or deletes real mail gets extra care.** Cleanup always previews
  first, logs every move, and can be undone. Keep it that way.
- **Ship a version bump with every change** so devices offer the update:
  1. `js/version.js` → `APP_VERSION`
  2. `version.json` → `version`, `date`, and a short plain-English `changes` list
  3. `sw.js` → `CACHE` name
  4. If you add a JS/CSS file, add it to the list in `js/update.js`.

## Map

```
js/core/        pure logic, unit-tested in Node: rules, importers, compile (to Gmail
                filters / Outlook rules), cleanup (plan/run/undo), mime, snooze, phish
js/providers/   gmail.js (Gmail + Calendar + People APIs), graph.js (Microsoft Graph)
js/service.js   app state, accounts and sign-in, sync, sweep, cleanup, calendar, contacts
js/auth.js      sign-in popups, token helper calls
js/ui/          screens: mail, compose, pages (calendar, contacts, rules, cleanup,
                settings), notes (Notes for Claude)
token-helper/   optional Cloudflare Worker that renews sign-ins (holds client secrets)
tests/          npm test (node --test)
```

## Checking your work

- `npm test` must pass.
- For UI changes, load the app with Playwright against mocked Gmail/Graph responses
  (never real mailboxes) and look at desktop (1360px) and phone (390px) widths.
