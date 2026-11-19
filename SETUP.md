# Setup guide

About 30–40 minutes, once. You'll do four things:

1. Turn on GitHub Pages (so the app has a web address)
2. Register the app with Google (for your Gmail mailboxes)
3. Register the app with Microsoft (for Outlook.com / Hotmail / Live)
4. Open the app, paste in the two IDs, and add your mailboxes

Throughout this guide, the app's address is:

```
https://devilbike.github.io/unified-inbox/
```

and its sign-in return address is:

```
https://devilbike.github.io/unified-inbox/auth.html
```

---

## 1. Turn on GitHub Pages

1. Open **github.com/DevilBike/unified-inbox** → **Settings** → **Pages** (left menu).
2. Under **Build and deployment**, set **Source** to **Deploy from a branch**.
3. Branch: **main**, folder: **/ (root)** → **Save**.
4. Wait a minute, then refresh. The page shows "Your site is live at https://devilbike.github.io/unified-inbox/".

---

## 2. Google (Gmail, Google Calendar, Google Contacts)

### 2a. Create a project and turn on the APIs

1. Go to **console.cloud.google.com** and sign in with your main Gmail.
2. Top bar → project picker → **New project** → name it `Unified Inbox` → **Create**. Make sure it's selected.
3. Left menu → **APIs & Services** → **Library**. Search for and **Enable** each of these:
   - **Gmail API**
   - **Google Calendar API**
   - **People API**

### 2b. Set up the sign-in screen

1. Left menu → **Google Auth Platform** (older screens call it **OAuth consent screen**) → **Get started**.
2. App name: `Unified Inbox`. Support email: your Gmail. **Next**.
3. Audience: **External**. **Next**.
4. Contact email: your Gmail. Agree to the policy → **Create**.
5. **Audience** (left menu) → **Test users** → **Add users** → add all 3 of your Gmail addresses → **Save**.
   Leave the app in **Testing**. That's fine for personal use.
6. **Data Access** (left menu) → **Add or remove scopes**. Paste these into **Manually add scopes**, one per line, then **Add to table** → **Update** → **Save**:

   ```
   https://www.googleapis.com/auth/gmail.modify
   https://www.googleapis.com/auth/gmail.settings.basic
   https://www.googleapis.com/auth/gmail.send
   https://www.googleapis.com/auth/calendar.events
   https://www.googleapis.com/auth/contacts.readonly
   https://www.googleapis.com/auth/contacts.other.readonly
   ```

### 2c. Create the client ID

1. **Clients** (left menu) → **Create client**.
2. Application type: **Web application**. Name: `Unified Inbox web`.
3. **Authorized JavaScript origins** → add both:
   - `https://devilbike.github.io`
   - `http://localhost:8080`
4. **Authorized redirect URIs** → add both:
   - `https://devilbike.github.io/unified-inbox/auth.html`
   - `http://localhost:8080/auth.html`
5. **Create**. Copy the **Client ID** (ends in `.apps.googleusercontent.com`). You don't need the client secret.

When you first sign in, Google shows **"Google hasn't verified this app"**. That's expected for your own app in Testing mode: click **Continue**.

---

## 3. Microsoft (Outlook.com, Hotmail, Live: mail, calendar, contacts)

1. Go to **entra.microsoft.com** (or **portal.azure.com**) and sign in with your Outlook/Hotmail/Live account.
   If it asks you to set up a directory or a free Azure account, follow the prompts. Registering an app is free.
2. Search for **App registrations** → **New registration**.
   - Name: `Unified Inbox`
   - Supported account types: **Personal Microsoft accounts only**
   - Redirect URI: choose **Single-page application (SPA)** and enter
     `https://devilbike.github.io/unified-inbox/auth.html`
   - **Register**
3. On the app's page → **Authentication** → under **Single-page application** → **Add URI** →
   `http://localhost:8080/auth.html` → **Save**.
4. **API permissions** → **Add a permission** → **Microsoft Graph** → **Delegated permissions** → tick:
   - `Mail.ReadWrite`, `Mail.Send`, `MailboxSettings.ReadWrite`
   - `Calendars.ReadWrite`
   - `Contacts.Read`, `People.Read`
   - `offline_access`, `User.Read` (usually already there)

   → **Add permissions**. (No admin consent is needed for personal accounts.)
5. **Overview** → copy the **Application (client) ID** (looks like `1a2b3c4d-…`).

---

## 4. Put the IDs in and add your mailboxes

**Recommended:** put both IDs in `js/config.js` on GitHub so every device (PC and phone) gets them:

1. On GitHub, open `js/config.js` → pencil icon (Edit).
2. Paste the Google client ID between the quotes after `googleClientId:` and the Microsoft ID after `microsoftClientId:`.
3. **Commit changes**. Pages updates in about a minute.

These IDs are public identifiers, not passwords, so they're safe in a public repo.

*(Or, on each device, open the app → **Settings** → **Sign-in setup** → paste them → **Save**.)*

Then open **https://devilbike.github.io/unified-inbox/** → **Settings**:

1. **Add Gmail**: sign in to your first Gmail. Repeat for the other two.
2. **Add Outlook / Hotmail**: sign in to your live.ca account. Repeat for Hotmail.
3. Go to **Rules & import** → check the rules → **Apply to Gmail & Outlook**. From now on new mail is sorted inside Gmail and Outlook themselves, even when the app is closed.
4. Go to **Clean up** → pick how far back → **Preview cleanup** → review → run. You can undo it afterwards.

If your browser blocks the sign-in window, allow pop-ups for `devilbike.github.io`.

---

## Install it like an app

- **Windows (Chrome or Edge):** open the app → click the **Install** icon at the right end of the address bar (or **⋮ → Cast, save and share → Install page as app**).
- **Android (Chrome):** open the app → **⋮** → **Add to home screen** → **Install**.

Each device keeps its own sign-ins, so add your mailboxes once on the PC and once on the phone. Rules don't need re-adding on the phone if you import the file you exported from the PC (**Rules & import** → **Export rules**).

---

## Run it on your PC instead (optional)

Needs Node.js (you have it). In Command Prompt:

```
cd %USERPROFILE%\Documents
git clone https://github.com/DevilBike/unified-inbox.git
cd unified-inbox
npm start
```

Then open **http://localhost:8080**. Sign-in works there too because you added the localhost addresses above.

---

## Good to know

- **Gmail sign-ins last about an hour.** When they expire, a **Reconnect** button appears at the top. One tap refreshes all of them, and the window closes by itself. Outlook sign-ins renew automatically for about a day, then they need the same tap.
- **Snooze** works in every mailbox: snoozed mail sits in a **Snoozed** label/folder and comes back to the Inbox the next time the app is open after the snooze time.
- **Promotions in Outlook** are detected from Outlook's own "Other" (Focused Inbox) sorting plus an unsubscribe link, so keep Focused Inbox turned on in Outlook.com settings.
- **Your data:** mail goes straight from your device to Google and Microsoft. Nothing is stored on any server. Mail, rules and sign-ins are kept in the browser on each device; **Settings → Clear this device** erases them.
