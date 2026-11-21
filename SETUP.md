# Setting up Unified Inbox

Unified Inbox runs on your Windows PC. It cleans up several Gmail and Outlook.com
inboxes at once: it sorts old mail into a few folders, lets you read and re-sort
anything before it moves, and can undo a cleanup.

Setup takes about 20 minutes, once. After that, you open it from the desktop shortcut.

## 1. Install Node.js

Get the **LTS** version from <https://nodejs.org> and install it with the default options.

## 2. Get the app

1. On <https://github.com/DevilBike/unified-inbox>, click **Code → Download ZIP**.
2. Unzip it somewhere that stays put, for example `Documents\unified-inbox`.
3. Double-click **Start Unified Inbox.bat**.
   - A small black window opens. Leave it open while you use the app; close it to stop the app.
   - The app opens in its own window at `http://localhost:8765`.
   - A **Unified Inbox** shortcut is added to your desktop. Use that from now on.

The app opens on Settings. Steps 3 and 4 give you the IDs it asks for.

## 3. Google (for Gmail)

1. Go to <https://console.cloud.google.com> and create a project, for example "Unified Inbox".
2. **APIs & Services → Library**: enable the **Gmail API**.
3. **APIs & Services → OAuth consent screen** (on newer screens: **Google Auth Platform**):
   - User type **External**. Fill in an app name and your email.
   - **Data access / Scopes**: add `.../auth/gmail.modify` and `.../auth/gmail.settings.basic`.
   - **Audience**: click **Publish app**, so it's "In production".
     - If you leave it in "Testing", Google signs you out every 7 days.
     - You don't need to submit it for verification. It's only for you.
4. **Credentials → Create credentials → OAuth client ID**. Choose **Desktop app**.
5. Copy the **Client ID** and **Client secret** into the app's Settings, under **Sign-in setup**, and click **Save**.

When you add a Gmail account, Google warns that it "hasn't verified this app". That's
expected for a personal app. Click **Advanced → Go to Unified Inbox**, then tick every box
on the permissions screen.

## 4. Microsoft (for Outlook.com, Hotmail, Live)

1. Go to <https://portal.azure.com> → **App registrations → New registration**.
2. Fill it in:
   - Name: Unified Inbox.
   - Supported account types: **Personal Microsoft accounts only**.
   - Redirect URI: platform **Public client/native (mobile & desktop)**, address `http://localhost:8765/auth/callback`.
3. **API permissions → Add a permission → Microsoft Graph → Delegated**: add `Mail.ReadWrite`,
   `MailboxSettings.ReadWrite`, `User.Read` and `offline_access`.
4. Copy the **Application (client) ID** from the Overview page into Settings, and click **Save**.

## 5. Add your mailboxes

In Settings, click **Add Gmail** or **Add Outlook / Hotmail** once for each mailbox.

- The sign-in page opens in the app window, then returns you to Settings.
- When you add another account, pick it on the account chooser (or click "Use another account").
- You stay signed in. If a mailbox ever needs you again, a button at the top says so.

## Using it

- **Clean up inboxes**:
  1. Pick mailboxes and how far back, then click **Preview**. Nothing moves yet.
  2. Go through each tab. Open any message to read it, change where it goes, or change a whole sender at once.
  3. **Always…** turns a sender into a rule.
  4. Click **Move**. Every move is logged, and **Undo** puts it all back.
- **Rules & import**: edit the rules, import Gmail filters, and **Apply to Gmail & Outlook** so new mail sorts itself even when this app is closed.
- **Read and sort**: browse any folder.
  - Reading pane shortcuts: **V** move, **A** always file this sender, **E** archive, **#** delete.
- **Notes for Claude**: jot down bugs and ideas; they go to GitHub for the next round of changes.

## Good to know

- Sign-ins, rules and cleanup history are kept in `%LOCALAPPDATA%\UnifiedInbox` on your PC.
  The app folder holds no personal data, so you can delete and re-download it safely.
- Updates: when a new version is out, an **Update** button appears at the top.
  One click downloads it and restarts the app.
- The app only listens on your own PC (localhost). Other devices on your network can't reach it.
- To run it from a terminal instead: `npm start` in the app folder. Tests: `npm test`.
