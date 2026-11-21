# Working on Unified Inbox

A personal Windows desktop app for **cleaning up** several Gmail and Outlook.com inboxes.
It runs only on the owner's PC: `Start Unified Inbox.bat` runs `server.mjs` (Node, no
dependencies) on `http://localhost:8765` and opens the screens in an Edge app window.
Reading mail exists to help sorting. There's no writing mail, calendar, contacts or snooze;
those were removed on purpose in 0.4.0.

## Start every session by reading the owner's notes

The owner writes notes inside the app (**Notes for Claude**) and sends them here as
GitHub issues whose titles start with `[Claude]`.

1. List the open issues whose titles start with `[Claude]`.
   - Use the REST API: `gh api 'repos/DevilBike/unified-inbox/issues?state=open'`.
   - Read each one. They carry the app version, window width and screen they were written on.
2. Summarise them back to the owner and confirm what to tackle before changing code.
3. When one is done, comment on the issue with what changed and close it.

## Rules

- **The repo is public.** Never commit email addresses, names, mail content, tokens or
  secrets. Tests use placeholders like `person.one@example.com`. Client IDs and the
  client secret are entered in the app and stored on the PC, never in the repo.
- **No dependencies, no build step.** Plain HTML/CSS/ES modules plus `server.mjs`.
- **The server only listens on loopback** and checks the Host header and the `X-Inbox`
  header on `/api/*`. Refresh tokens never leave the server; the screens get short-lived
  access tokens from `POST /api/token`. Keep it that way.
- **Anything that moves or deletes real mail gets extra care.**
  - Cleanup always previews first.
  - Every move is logged to `%LOCALAPPDATA%\UnifiedInbox\cleanup-logs`, and a cleanup can be undone. Keep it that way.
- **Ship a version bump with every change** so the app offers the update:
  1. `js/version.js` → `APP_VERSION`
  2. `version.json` → `version`, `date`, and a short plain-English `changes` list
  3. `package.json` → `version`
  4. Run `npm run files` (regenerates `files.json`, the list the updater downloads); the tests fail if it's stale.
- Avoid changing `Start Unified Inbox.bat` unless needed. It is running while updates are installed. Keep it CRLF.

## Map

```
server.mjs      local app: static files, sign-in (Google/Microsoft auth code + PKCE),
                token renewal, settings/rules/log storage in the user folder, updates
js/api.js       calls to server.mjs
js/core/        pure logic, unit-tested in Node: rules (incl. "Senders → Folder" rules),
                importers, compile (to Gmail filters / Outlook rules), cleanup
                (plan/reassign/run/undo), mime, phish
js/providers/   gmail.js and graph.js: read, move, trash, filters/rules
js/service.js   app state, mailboxes, mail lists, rules, cleanup
js/ui/          pages (cleanup review, rules, settings), mail (folders + reading pane),
                message (one email), notes (Notes for Claude)
tests/          npm test (node --test): core logic + server (sign-in, storage, updates)
tools/files.mjs writes files.json
```

## Checking your work

- `npm test` must pass.
- For UI changes:
  - Run the server with `createApp({ fetchImpl })` faking the token endpoints.
  - Load it with Playwright against mocked Gmail/Graph responses (never real mailboxes).
  - Look at it at 1360px wide (and a narrow ~900px window).
