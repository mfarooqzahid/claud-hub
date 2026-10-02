# Claude Hub — Plan & Architecture

> **Status:** Chrome extension + a small local **native messaging helper**. No
> server, no port. A dedicated hub profile imports each account's claude.ai
> session and switches between them in place. Source profiles are read-only. See
> [§11 Evolution](#11-evolution).

---

## 1. Goal

Let one person use **several Claude subscription accounts** in a single browser
without signing in and out:

* **Switch** the browser to another account with one click — no re-login.
* **Carry the current conversation's context** into the account you switch to, so
  you can keep going when one account hits its limit.
* Stay **fully local** — no server, no cloud, no stored passwords.
* Never disturb the real profiles each account lives in.

---

## 2. What it is today

```text
other Chrome profiles              dedicated "Claude Hub" profile
┌───────────────┐  readAllCookies  ┌───────────────────────────────┐
│ Profile 3   A │ ───────────────► │  extension + saved accounts    │
│ Profile 5   B │  (native host)   │                                │
│ Profile 9   C │  read-only       │  click B → clear claude.ai     │
└───────────────┘                  │  cookies → chrome.cookies.set  │
                                   │  → reload → now signed in as B │
                                   └───────────────────────────────┘
```

An extension can only see **its own** Chrome profile. The helper supplies the
rest: enumerating profiles and reading each one's claude.ai session. Because the
extension writes only to its own profile, the accounts stay untouched where they
live.

---

## 3. Components

### 3.1 Extension (`extension/`), Manifest V3

| File | Responsibility |
| --- | --- |
| `manifest.json` | Config + permissions + a `key` that pins a stable extension ID (so the native host can allowlist it) |
| `background.js` | Service worker: lists profiles, imports/stores each account's cookie set, applies one to this profile, verifies it, captures and renders the carried context |
| `content.js` | On-page dock (shadow DOM), captures the open conversation via claude.ai's API, pastes carried context (self-healing across re-renders) |
| `popup.html/.css/.js` | One flat account list; icon actions (⇄ switch, ↗ open profile, → sign in); Sync; carry toggle; dock show/hide + position |
| `icons/` | Extension icon + source |

### 3.2 Native helper (`native-host/`)

| File | Responsibility |
| --- | --- |
| `claude_hub_host.py` | The helper: profile discovery, session detection, full-cookie read, profile launch, context-file relay, native messaging loop |
| `install.py` | Registers/unregisters the host manifest with Chrome/Chromium/Brave (Linux/macOS/Windows) |
| `build.py` | Optional PyInstaller bundle for machines without Python |

---

## 4. Data & storage

`chrome.storage.local` in the **hub profile** holds the imported sessions and UI
state:

```js
claudeHubAccounts = {
  "chrome:Profile 5": {
    profileId, profile, browser, browserLabel, label, email,
    sessionId,          // sha256(sessionKey)[:16] — identifies the account
    claudeEmail,        // real Claude account email, learned from the page
    savedAt, status,    // "ready" | "expired"
    cookies: [ { name, value, domain, path, secure, httpOnly,
                 sameSite, hostOnly, session } ]
  }, …
}
claudeHubCarry          // bool — carry the current chat when switching
claudeHubRailVisible    // bool — show the on-page dock
claudeHubRailPosition   // 'right' | 'bottom' | 'left' | 'top'
claudeHubSelectedKey    // last account tapped in the dock (UI highlight)
pendingTransfer         // { text, createdAt } — context waiting to be pasted
```

The source profiles are never written to. **Reset all data** clears the saved
accounts, the UI settings, *and* this profile's applied claude.ai cookies, so the
hub profile ends up signed out. The cross-profile context hand-off still uses
`$TMPDIR/claude-hub-transfer.json` (helper-owned, used once, 30-minute TTL) for
the "open profile" path, while switching in place uses `pendingTransfer`.

---

## 5. The list

There is exactly **one list**: every Chrome profile the helper can find, one row
each.

| Field | Meaning |
| --- | --- |
| `title` | the real Claude account email (once visited), else the profile's Google email, else the profile label |
| `subtitle` | `Chrome · <profile>` plus status (`ready to switch`, `not signed in`, `session expired — sign in again`, `active in this browser`) |
| `status` | `active` \| `ready` \| `expired` \| `signin` |
| `action` | `switch` (apply the saved session here) or `signin` (open that profile to log in) |

The **dock** on claude.ai and the **popup** render the same list — every Chrome
profile, including the one Claude Hub runs in. The active account is tagged
`active`; clicking it re-applies its session, the recovery path if a cloned
session gets rejected. The active account is also reported separately as
`active` so the popup can name it and the carry step can reference it.

---

## 6. Switching an account

```text
click an account
   ↓
background captures the open conversation (while the current session is live)
   ↓
renders the context document and stashes it in storage.local (+ clipboard)
   ↓
clears this profile's claude.ai cookies
   ↓
chrome.cookies.set(...) for every stored cookie
   ↓
reloads claude.ai (fresh chat when carrying); the content script pastes the context
   ↓
the content script confirms the session (and reports the real Claude email),
or flags the account expired so its row asks to sign in again
```

Before clearing, the worker snapshots the current cookie set. If the page then
reports the clone was rejected, it restores that snapshot (`claudeHubRollback`),
so the hub falls back to the previous working account instead of a login page.

If verification fails, the account is marked **expired** and its row becomes
**Sign in**. No other Chrome profile is ever touched.

If a profile has no Claude session yet, its action is **Sign in** and the helper
opens that profile at the login page. Run **Sync accounts** afterwards to import
the new session.

---

## 7. Carrying the conversation

With carry enabled, switching also transfers the *open* conversation's context:

```text
1. background asks the content script to capture the open chat
   → GET /api/organizations → GET .../chat_conversations/{id}   (page's session)
2. background renders a context document (JS, deterministic — no model calls)
   Objective · Important decisions · Problems encountered
   Relevant commands · Current state · Recent conversation (last 12 msgs)
3. the reloaded page reads it from storage.local and pastes it into the composer,
   self-healing across claude.ai re-renders; it clears once the message is sent
4. the same text is copied to the clipboard as a fallback
```

The full transcript is not sent, only a bounded excerpt.

---

## 8. Native messaging

Chrome launches `native-host/claude_hub_host.py` on demand and talks over
stdin/stdout using Chrome's protocol (4-byte native-endian length + UTF-8 JSON).

Messages (`type`):

| Command | Returns |
| --- | --- |
| `ping` | `{ok, host, version}` |
| `listProfiles` | `{ok, profiles:[{id, browser, label, email, has_session, session_id}]}` |
| `readAllCookies` | `{ok, profiles:[{id, …, session_id, cookies:[…]}]}` — every signed-in profile in one pass |
| `openProfile` | launches Chrome for a `profileId` (+ optional `url`) |
| `writeTransfer` / `readTransfer` / `clearTransfer` | cross-profile context relay |

The helper only **reads** cookie stores; there are no write commands.
`install.py` writes the host manifest to the per-platform NativeMessagingHosts
directories, with `allowed_origins` = the extension's pinned ID. On Windows it
also writes the registry keys.

---

## 9. Permissions

| Permission | Why |
| --- | --- |
| `cookies` | Read/clear/write claude.ai cookies **in this profile only**, to switch accounts |
| `tabs` | Read the active Claude tab, reload it after a switch, capture, refresh the dock |
| `storage` | Saved accounts and UI settings |
| `clipboardWrite` | Copy the carried context as a fallback |
| `scripting` | Inject the content script into already-open tabs as a fallback |
| `nativeMessaging` | Talk to the local helper |
| hosts `https://claude.ai/*`, `https://*.claude.ai/*` | Talk to claude.ai only |

---

## 10. Security requirements

* Never store Claude passwords.
* Session cookies **are** stored, in the hub profile's `chrome.storage.local`
  only — never synced, never uploaded. They are bearer tokens; the hub profile
  should be treated as a logged-in session.
* Cookie **writes** are confined to the profile the extension runs in. The helper
  only reads other profiles' cookie stores.
* The extension talks only to `claude.ai`; the helper talks only to the extension
  (matched by ID) and the local filesystem.
* Conversations are never uploaded; the carried context lives briefly in
  `storage.local` / the temp file and clears when sent or after the TTL.
* `data/`, `*.db`, `.env` are git-ignored.

---

## 11. Evolution

1. **Local web app + hub.** Imported, stored, searched and viewed conversations,
   with a Python provider layer. Removed: conversations/search UI, provider
   layer, context packages.
2. **Lean FastAPI hub + extension.** Stored accounts and encrypted sessions; the
   extension switched cookies. Worked, but required running a server.
3. **Standalone extension.** Accounts saved from the browser; context rendering
   in JS. Lost the ability to see other Chrome profiles.
4. **Standalone extension + native helper.** A native host restored profile
   scanning and session import while keeping the no-server model.
5. **Open-the-profile model.** Cookie swapping was removed entirely; Claude Hub
   opened the right Chrome profile instead. Nothing was cloned, but switching
   meant leaving the current window.
6. **Hub-profile switch model** *(current)*. A dedicated hub profile imports each
   account's session (read-only from the source profiles) and switches in place
   via the cookies API. The old conflict is gone because writes happen only in a
   neutral profile, and expired sessions are detected and re-prompted.

---

## 12. Possible next steps

* Encrypt stored sessions at rest with a helper-held key.
* Per-account avatars on the dock.
* Editable context preview before switching.
* A compact position picker on the dock.
* "Pick a recent chat" carry-over, not just the open one.
* Publish to the Chrome Web Store.
