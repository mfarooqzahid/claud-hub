# Claude Hub

A **local-only Chrome extension** for using several Claude accounts in one
browser. Each account keeps its own login in its own Chrome profile; Claude Hub
imports those sessions into a dedicated **hub profile** so a single click can
switch the browser between accounts — and **carries the current conversation's
context** across, so you can keep working when one account hits its limit.

The source profiles are only ever **read**. Cookie writes happen in the hub
profile alone, through Chrome's cookies API, so no real account can be disturbed.

No server, no cloud, no passwords.

> **Unofficial.** It reads the open conversation using claude.ai's internal API
> and reads Chrome's cookie store via a local helper. It can break when Chrome or
> Anthropic change things.

---

## How it fits together

```text
 Profile 3 (account A)      dedicated "Claude Hub" profile
 Profile 5 (account B)      ┌───────────────────────────────┐
 Profile 9 (account C)      │  Claude Hub extension          │
        │  read-only        │  stores each account's cookies │
        └── readAllCookies ─►  click → apply cookies here    │
           (native helper)    │  → reload → you are account B │
                              └───────────────────────────────┘
```

You do your Claude work **inside the hub profile**; switching accounts just
swaps its cookies. The other profiles remain the source of truth for each
login, and are where you go to sign in again if a session expires.

---

## Install

1. **Create a dedicated Chrome profile** (profile menu → **Add** →
   *Continue without an account*). Name it something like **Claude Hub**, and do
   not sign it into a Google account. This profile is the only one Claude Hub
   writes to.
2. **Load the extension there:** in that profile open `chrome://extensions` →
   enable **Developer mode** → **Load unpacked** → select the `extension/`
   folder.
3. **Install the native helper** (it scans the other profiles' sessions — an
   extension can't do that alone):

   ```bash
   python3 native-host/install.py
   ```

   This registers a Chrome **native messaging** helper. Chrome launches it on
   demand; there is no server and no port. Use `--uninstall` to remove it.

> Loading the extension in the account profiles too is harmless, but not needed —
> the helper reads their sessions directly.

---

## Using it

Open the extension popup (or the on-page dock on claude.ai). It shows **one
list**: every Chrome profile the helper finds, one row each.

| Row | Action |
| --- | --- |
| Ready | **Switch here** — applies that account's saved session in this profile |
| No Claude session | **Sign in** — opens that profile so you can log in once |
| Session expired | **Sign in** — re-authenticate in that profile, then **Sync** |

Row actions are icon buttons — hover for a tooltip: **⇄** switch this browser
here (accented when carry is on), **↗** open the account in its own profile,
**→** sign in. The footer uses **ⓘ** diagnose and **⟲** reset.

Every profile is listed. The account that's currently active is tagged
**active** — clicking **⇄** on it re-applies its session, which is the escape
hatch if a cloned session is ever rejected.

Use **Sync accounts** (⟳) after signing in somewhere new, or to refresh saved
sessions. **Reset all data** (popup footer) wipes the saved accounts and
settings *and* clears this profile's applied claude.ai cookies, leaving the hub
profile signed out.

**Carry the conversation:** with **“Carry the current conversation”** checked,
switching captures the open chat, renders a context document (Objective /
Decisions / Problems / Commands / Current state / Recent conversation), opens a
**new chat** in the account you switched to, and pastes the context into its
composer.

The on-page **dock** on claude.ai shows the same list as icons — hover for a
tooltip, click to switch. The one you tap is highlighted; the active account is
ringed. Move the dock to any edge (top/left/right/bottom) with the ✥ button, or
hide/reposition it from the popup.

If something doesn't work, click **Diagnose** in the popup footer. It reports
whether the helper is reachable, how many profiles were found, how many accounts
are saved, whether there's a live session, and whether a context hand-off is
pending.

---

## How it works

```text
claude.ai  ◄──►  content script   (dock, chat capture, composer injection)
                        │
                        ▼
              background service worker   (accounts, cookies, tabs, context)
                        │
          ┌─────────────┴──────────────┐
          ▼                            ▼
  chrome.storage.local         native helper (Chrome launches it)
  saved accounts + settings    scans profiles · reads sessions · relays context
```

* **Sync:** the helper reads every signed-in profile's full claude.ai cookie set
  (`sessionKey`, `sessionKeyLC`, `lastActiveOrg`, `routingHint`, …) in a single
  pass. The worker stores them in this profile's `chrome.storage.local`.
* **Switch:** the worker clears this profile's claude.ai cookies and writes the
  saved set with `chrome.cookies.set()`, verifies the session against
  `claude.ai/api/organizations`, and reloads the tab. If verification fails the
  account is marked **expired** and the row asks you to sign in again.
* **Sign in:** opens the source profile at claude.ai; run **Sync** afterwards to
  import the fresh session.
* **Context hand-off:** captured while the current session is still live, then
  stashed in `chrome.storage.local` for the reloaded page, which pastes it
  self-healingly. The text is also copied to the clipboard as a fallback.
* Context extraction is deterministic (no model calls) and runs in JS.

---

## Security

* No Claude passwords are stored.
* **Session cookies are stored** — in this Chrome profile's `chrome.storage.local`
  (never synced, never uploaded). They are bearer tokens, so treat the hub
  profile like a logged-in session.
* Cookie **writes** happen only in the hub profile. The helper only *reads* the
  other profiles' cookie stores, to import sessions and detect expiry.
* The extension only talks to `claude.ai`; there is no server component.
* The helper speaks only to the extension that installed it (matched by
  extension ID).
* Conversations are never uploaded or stored beyond the transient copy used to
  paste into the next chat.

---

## Repository layout

```text
claude-hub/
├── extension/          # load this in the hub profile
│   ├── manifest.json
│   ├── background.js    # accounts, cookie apply, tabs, context render
│   ├── content.js       # on-page dock, chat capture, composer injection
│   ├── popup.html/.css/.js
│   └── icons/
├── native-host/         # the Chrome native messaging helper
│   ├── claude_hub_host.py   # scan profiles · read sessions · context relay
│   ├── install.py           # register/unregister with Chrome
│   └── build.py             # optional: PyInstaller bundle
├── design/              # icon concept sheet
├── APP.md               # architecture & plan
└── README.md
```
