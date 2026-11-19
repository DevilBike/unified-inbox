# Unified Inbox

One inbox for several Gmail and Outlook.com mailboxes, with shared folders and rules. It's a web app you install on Windows and Android, and there's no server.

**Open it:** https://devilbike.github.io/unified-inbox/ · **First time?** Follow [SETUP.md](SETUP.md).

## What it does

- **Unified inbox:** mail from every mailbox in one list, tagged by mailbox, with a filter per mailbox
- **Five shared folders:** Receipts, Finance, Jobs, News, Promotions (a Gmail label or Outlook folder of the same name in each mailbox)
- **Email basics:** read, reply, reply all, forward, compose with Cc/Bcc and attachments, drafts, Sent, Junk, Trash, flag, mark unread, a signature per mailbox, and search across all mailboxes
- **Snooze:** hide a message until later; it comes back to the Inbox on every device
- **Rules:** one ordered rule list for all mailboxes
  - **Import** from Gmail's filter export (.xml), live from a Gmail or Outlook mailbox, or from a .json file
  - **Apply to Gmail & Outlook** copies the rules into each mailbox so mail is sorted even when the app is closed
  - While the app is open, new mail the providers miss gets sorted too
- **Clean up:** run the rules over mail already in your inboxes. You preview first, can send promotions to Trash if you want, and can undo afterwards
- **Calendar:** the next 14 days across all calendars, new events, and Accept / Maybe / Decline on invites
- **Contacts:** address books from all mailboxes, plus autocomplete when writing
- **Safety:** remote images are blocked until you ask (this stops tracking pixels), emails are shown in a locked-down frame, and look-alike senders like "Canada Post" from a random domain get a warning
- **Stay signed in:** an optional free Cloudflare Worker ([`token-helper/`](token-helper/)) renews sign-ins in the background. Without it, the app reconnects on your next tap
- **Keyboard:** `J`/`K` next/previous, `E` archive, `#` delete, `R` reply, `A` reply all, `F` forward, `V` move, `H` snooze, `S` flag, `U` unread, `!` junk, `C` compose, `/` search

## How it's built

Plain HTML, CSS and JavaScript modules, with no build step and no dependencies. It talks to the Gmail API and Microsoft Graph directly from the browser.

```
index.html, auth.html        app shell and sign-in return page
js/core/                     rules engine, importers, rule compiler, cleanup, MIME, snooze, phishing check
js/providers/                Gmail (gmail.js) and Outlook (graph.js) adapters
js/service.js                app state, accounts, sync, cleanup
js/ui/                       screens
token-helper/worker.js       optional sign-in renewal helper (Cloudflare Worker)
tests/                       unit tests (npm test)
```

Run the tests with `npm test`, or run the app locally with `npm start` (see SETUP.md).
