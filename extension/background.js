// Claude Hub — background service worker (standalone, no local server).
//
// Everything the content script can't do directly: enumerate the user's Chrome
// profiles through the native helper, capture the current conversation, and —
// in the dedicated hub profile only — store each account's claude.ai cookie set
// and apply it to switch accounts.
//
// Safety: the helper READS the other profiles' cookie stores; it never writes
// them. Only THIS profile's cookies are ever changed, and only via the Chrome
// cookies API, so no other account can be disturbed.

const CLAUDE = 'https://claude.ai'

// ------------------------------------------------------------ native host
// Chrome launches this on demand; it scans Chrome profiles, opens one, and
// brokers the cross-profile context hand-off through a temp file.
const HOST_NAME = 'com.claudehub.host'

function nativeSend(message) {
  return new Promise((resolve) => {
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(
      () => finish({ ok: false, available: false, error: 'The native helper timed out.' }),
      15000,
    )
    try {
      chrome.runtime.sendNativeMessage(HOST_NAME, message, (response) => {
        if (chrome.runtime.lastError) {
          finish({ ok: false, available: false, error: chrome.runtime.lastError.message })
        } else {
          finish(response || { ok: false, error: 'Empty response from the helper' })
        }
      })
    } catch (err) {
      finish({ ok: false, available: false, error: String(err) })
    }
  })
}

// ------------------------------------------------------------ context render
// Ported from the hub's Python heuristics — deterministic, no model calls.
const CODE_FENCE = /```[^\n]*\n([\s\S]*?)```/g
const COMMAND_PREFIXES = [
  '$ ', 'sudo ', 'kubectl ', 'terraform ', 'docker ', 'npm ', 'pnpm ',
  'pip ', 'git ', 'aws ', 'gcloud ', 'helm ', 'make ',
]
const DECISION_MARKERS = [
  'we decided', 'decision', "we'll use", 'we will use', 'the approach is',
  'architecture is', 'chosen', 'i recommend using', "let's go with",
  'final design',
]
const PROBLEM_MARKERS = [
  'error', 'issue', 'problem', 'failed', 'failure', 'bug', "doesn't work",
  'does not work', 'workaround', 'broken', 'crash',
]
const MAX_LINES = 8

function trimText(text, limit = 1200) {
  const value = (text || '').trim()
  if (value.length <= limit) return value
  return value.slice(0, limit).replace(/\s+$/, '') + '…'
}

function cleanLine(line) {
  return line.replace(/^[\s>*\-#•\d.)]+/, '').trim()
}

function matchingLines(messages, markers) {
  const found = []
  const seen = new Set()
  for (const message of messages) {
    for (const raw of (message.content || '').split('\n')) {
      const line = cleanLine(raw)
      if (line.length < 12) continue
      const lower = line.toLowerCase()
      if (markers.some((marker) => lower.includes(marker))) {
        const key = lower.slice(0, 80)
        if (seen.has(key)) continue
        seen.add(key)
        found.push(line)
        if (found.length >= MAX_LINES) return found
      }
    }
  }
  return found
}

function extractCommands(messages) {
  const found = []
  const seen = new Set()
  for (const message of messages) {
    const content = message.content || ''
    for (const block of content.matchAll(CODE_FENCE)) {
      for (const raw of block[1].split('\n')) {
        const line = raw.trim()
        if (line && !seen.has(line) && line.length < 200) {
          seen.add(line)
          found.push(line)
        }
      }
    }
    const stripped = content.replace(CODE_FENCE, '')
    for (const raw of stripped.split('\n')) {
      const line = raw.trim()
      if (
        COMMAND_PREFIXES.some((prefix) => line.startsWith(prefix)) &&
        !seen.has(line)
      ) {
        seen.add(line)
        found.push(line)
      }
    }
    if (found.length >= MAX_LINES) break
  }
  return found.slice(0, MAX_LINES)
}

function renderTranscript(messages) {
  return messages
    .map((message) => {
      const label = message.role === 'user' ? 'User' : 'Claude'
      return `${label}:\n${(message.content || '').trim()}`
    })
    .join('\n\n')
}

function buildSections(messages) {
  const firstUser = messages.find((message) => message.role === 'user')
  const lastAssistant = [...messages]
    .reverse()
    .find((message) => message.role === 'assistant')
  const decisions = matchingLines(messages, DECISION_MARKERS)
  const problems = matchingLines(messages, PROBLEM_MARKERS)
  const commands = extractCommands(messages)

  const sections = []
  if (firstUser) sections.push(['Objective', trimText(firstUser.content)])
  if (decisions.length) {
    sections.push(['Important decisions', decisions.map((d) => `- ${d}`).join('\n')])
  }
  if (problems.length) {
    sections.push(['Problems encountered', problems.map((p) => `- ${p}`).join('\n')])
  }
  if (commands.length) {
    sections.push(['Relevant commands', '```\n' + commands.join('\n') + '\n```'])
  }
  if (lastAssistant) {
    sections.push(['Current state', trimText(lastAssistant.content)])
  }
  if (messages.length > 2) {
    sections.push(['Recent conversation', renderTranscript(messages.slice(-12))])
  }
  return sections
}

function renderContextDocument({ title, sourceLabel, messages }) {
  const normalized = (messages || []).map((message) => ({
    role: message.role === 'assistant' ? 'assistant' : 'user',
    content: message.content || '',
  }))

  const lines = ['PROJECT CONTEXT — continued from another Claude account']
  if (title) lines.push(`Conversation: ${title}`)
  if (sourceLabel) lines.push(`Original account: ${sourceLabel}`)
  lines.push('')
  for (const [heading, body] of buildSections(normalized)) {
    lines.push(`## ${heading}`)
    lines.push(body)
    lines.push('')
  }
  lines.push(
    'Continue from this context. Ask me if anything is unclear before proceeding.',
  )
  return lines.join('\n').trim() + '\n'
}

// ---------------------------------------- current session (read-only)
// The live claude.ai session in THIS profile, used to mark which saved account
// is currently active. Reading it never changes anything.
async function currentSessionValue() {
  try {
    const cookie = await chrome.cookies.get({ url: CLAUDE, name: 'sessionKey' })
    return cookie ? cookie.value : null
  } catch {
    return null
  }
}

// --------------------------------------------------------------------- tabs
async function claudeTabs() {
  return chrome.tabs.query({ url: 'https://claude.ai/*' })
}

async function activeClaudeTab() {
  const tabs = await claudeTabs()
  if (!tabs.length) return null
  return tabs.find((tab) => tab.active) || tabs[0]
}

async function sendToTab(tabId, message) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, message)
    if (response) return response
  } catch {
    // Content script not present yet — inject it and retry once.
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js'],
    })
    return await chrome.tabs.sendMessage(tabId, message)
  } catch {
    return null
  }
}

async function broadcastRefresh() {
  for (const tab of await claudeTabs()) {
    chrome.tabs.sendMessage(tab.id, { type: 'sidebar:refresh' }).catch(() => {})
  }
}

// ------------------------------------------------------------------ hashing
async function sha256Hex(text) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(text),
  )
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

// ----------------------------------------------------------------- profiles
// Cache the native profile scan briefly so the dock's periodic re-render does
// not spawn a helper process every time.
let profileCache = { at: 0, value: [], available: false }

async function getChromeProfiles() {
  if (Date.now() - profileCache.at < 15000 && profileCache.at !== 0) {
    return profileCache
  }
  const response = await nativeSend({
    type: 'listProfiles',
    extensionId: chrome.runtime.id,
  })
  const available = Boolean(response && response.ok)
  const profiles = available
    ? (response.profiles || [])
        .filter((profile) => profile.browser === 'chrome')
        .map((profile) => ({
          id: profile.id,
          browser: profile.browser,
          browserLabel: profile.browser_label,
          profile: profile.profile,
          label: profile.label,
          email: profile.email,
          hasSession: profile.has_session,
          sessionId: profile.session_id || null,
          isCurrentProfile: Boolean(profile.is_current),
          hasExtension: Boolean(profile.has_extension),
        }))
    : []
  profileCache = { at: Date.now(), value: profiles, available }
  return profileCache
}

// ----------------------------------------------------------------- accounts
// Each account is the full claude.ai cookie set read from that account's own
// Chrome profile. We keep them in this hub profile's storage so a click can
// apply one here. Nothing is ever written back to the source profiles.
const ACCOUNTS_KEY = 'claudeHubAccounts'

async function getAccounts() {
  try {
    const stored = await chrome.storage.local.get(ACCOUNTS_KEY)
    return stored[ACCOUNTS_KEY] || {}
  } catch {
    return {}
  }
}

async function saveAccounts(accounts) {
  try {
    await chrome.storage.local.set({ [ACCOUNTS_KEY]: accounts })
    return true
  } catch {
    return false
  }
}

async function setAccountStatus(profileId, status) {
  const accounts = await getAccounts()
  if (accounts[profileId]) {
    accounts[profileId].status = status
    await saveAccounts(accounts)
  }
}

// Read every signed-in profile's cookie set in one helper pass and store it.
async function syncAccounts() {
  const response = await nativeSend({ type: 'readAllCookies' })
  if (!response || !response.ok) {
    return {
      ok: false,
      error: (response && response.error) || 'The native helper is unavailable.',
    }
  }
  const previous = await getAccounts()
  const accounts = {}
  for (const entry of response.profiles || []) {
    const prior = previous[entry.id]
    accounts[entry.id] = {
      profileId: entry.id,
      profile: entry.profile,
      browser: entry.browser,
      browserLabel: entry.browser_label,
      label: entry.label,
      email: entry.email || null,
      // The real Claude account identity, learned from the page once visited.
      claudeEmail: prior ? prior.claudeEmail || null : null,
      sessionId: entry.session_id || null,
      savedAt: Date.now(),
      // A fresh import means the source profile is signed in right now.
      status: 'ready',
      cookies: entry.cookies || [],
    }
  }
  await saveAccounts(accounts)
  return { ok: true, count: Object.keys(accounts).length }
}

// ------------------------------------------------------------ cookie apply
// chrome.cookies.set wants a URL whose host matches the cookie's domain.
// claude.ai is HTTPS-only and the host permission is https://, so always use
// https here even for cookies whose own Secure flag is false — otherwise Chrome
// rejects the write with "No host permissions".
function cookieUrl(cookie) {
  const host = String((cookie && cookie.domain) || 'claude.ai').replace(/^\./, '')
  const path = (cookie && cookie.path) || '/'
  return `https://${host}${path}`
}

function cookieSetDetails(cookie) {
  if (!cookie || !cookie.name) return null
  const host = String(cookie.domain || 'claude.ai').replace(/^\./, '')
  const secure = cookie.secure !== false
  const details = {
    url: `https://${host}/`,
    name: cookie.name,
    value: cookie.value == null ? '' : String(cookie.value),
    path: cookie.path || '/',
    secure,
    httpOnly: Boolean(cookie.httpOnly),
  }
  if (!cookie.hostOnly) details.domain = cookie.domain || `.${host}`
  let sameSite = cookie.sameSite
  // Chrome rejects SameSite=None without Secure.
  if (sameSite === 'no_restriction' && !secure) sameSite = 'lax'
  if (['no_restriction', 'lax', 'strict', 'unspecified'].includes(sameSite)) {
    details.sameSite = sameSite
  }
  if (!cookie.session && cookie.expirationDate) {
    details.expirationDate = cookie.expirationDate
  }
  return details
}

// Clear this profile's claude.ai cookies. Only the extension's own profile is
// touched.
async function clearClaudeCookies() {
  const existing = await chrome.cookies.getAll({ domain: 'claude.ai' })
  for (const cookie of existing) {
    await chrome.cookies
      .remove({ url: cookieUrl(cookie), name: cookie.name, storeId: cookie.storeId })
      .catch(() => {})
  }
  return existing.length
}

// Clear, then write the stored set. Returns what actually landed so Diagnose can
// report whether the session cookies were injected.
async function applyAccountCookies(cookies) {
  await clearClaudeCookies()
  let written = 0
  const failed = []
  for (const cookie of cookies || []) {
    const details = cookieSetDetails(cookie)
    if (!details) continue
    try {
      await chrome.cookies.set(details)
      written += 1
    } catch (err) {
      failed.push(`${cookie.name} (${(err && err.message) || 'rejected'})`)
    }
  }
  return { written, failed }
}

// The content script reports whether claude.ai accepts the session, from the
// page context where cookies are definitely attached. Match the live session to
// a saved account and record the verdict (plus the real Claude identity).
async function reportSessionStatus({ loggedIn, email } = {}) {
  const session = await currentSessionValue()
  if (!session) return
  const liveHash = (await sha256Hex(session)).slice(0, 16)
  const accounts = await getAccounts()
  const match = Object.values(accounts).find((a) => a.sessionId === liveHash)
  if (!match) return
  let changed = false
  if (loggedIn === false) {
    // The clone didn't take. Put the previous account's cookies back so the hub
    // falls back to a working session instead of a login page.
    const stored = await chrome.storage.local.get('claudeHubRollback')
    const rollback = stored.claudeHubRollback
    if (
      rollback &&
      rollback.profileId === match.profileId &&
      rollback.cookies &&
      rollback.cookies.length
    ) {
      await chrome.storage.local.remove('claudeHubRollback')
      await applyAccountCookies(rollback.cookies)
      reloadClaudeTabs()
    }
  }
  if (loggedIn != null) {
    const status = loggedIn ? 'ready' : 'expired'
    if (match.status !== status) {
      match.status = status
      changed = true
    }
  }
  if (email && match.claudeEmail !== email) {
    match.claudeEmail = email
    changed = true
  }
  if (changed) await saveAccounts(accounts)
}

async function reloadClaudeTabs(url) {
  const tabs = await claudeTabs()
  if (!tabs.length) {
    if (url) await chrome.tabs.create({ url }).catch(() => {})
    return
  }
  if (url) {
    // Navigate the main tab to a fresh URL so the document re-runs auth with
    // the new cookies; reload the rest bypassing cache.
    await chrome.tabs.update(tabs[0].id, { url, active: true }).catch(() => {})
    for (const tab of tabs.slice(1)) {
      chrome.tabs.reload(tab.id, { bypassCache: true }).catch(() => {})
    }
    return
  }
  for (const tab of tabs) chrome.tabs.reload(tab.id, { bypassCache: true }).catch(() => {})
}

// ---------------------------------------------------------------- switching
async function switchAccount({ profileId, carry, sourceLabel, tabId }) {
  const accounts = await getAccounts()
  const account = accounts[profileId]
  if (!account || !account.cookies || !account.cookies.length) {
    return {
      ok: false,
      error: 'No saved session for that account. Run Sync accounts first.',
    }
  }

  // Drop any stale context before applying; set it again only if we capture.
  await chrome.storage.local.remove('pendingTransfer')
  nativeSend({ type: 'clearTransfer' }).catch(() => {})

  // Capture while the current session is still live, and stash it for the
  // reloaded page in this same profile.
  let carried = false
  let text = null
  if (carry) {
    const prep = await prepareOpen({ carry: true, sourceLabel, tabId })
    carried = Boolean(prep && prep.carried)
    text = (prep && prep.text) || null
    if (text) {
      await chrome.storage.local.set({
        pendingTransfer: { text, createdAt: Date.now() },
      })
    }
  }

  // Remember the current cookies so a rejected clone can be rolled back.
  const rollback = await chrome.cookies.getAll({ domain: 'claude.ai' })

  const applied = await applyAccountCookies(account.cookies)
  await chrome.storage.local.set({
    claudeHubLastSwitch: {
      profileId,
      profile: account.profile,
      email: account.claudeEmail || account.email || null,
      at: Date.now(),
      written: applied.written,
      total: (account.cookies || []).length,
      failed: applied.failed.slice(0, 8),
    },
  })
  if (!applied.written) {
    if (rollback.length) await applyAccountCookies(rollback)
    await setAccountStatus(profileId, 'expired')
    return { ok: false, error: 'Could not apply the saved cookies.' }
  }

  await chrome.storage.local.set({
    claudeHubRollback: { profileId, cookies: rollback },
  })

  // Optimistic; the content script reports the real verdict after the reload.
  await setAccountStatus(profileId, 'ready')
  await reloadClaudeTabs(carried ? 'https://claude.ai/new' : 'https://claude.ai/')
  broadcastRefresh()
  return { ok: true, carried, text }
}

// -------------------------------------------------------------------- state
// One flat list of Chrome profiles — nothing else, so there is no second
// "accounts" list to duplicate it.
async function buildState() {
  const [session, profileResult] = await Promise.all([
    currentSessionValue(),
    getChromeProfiles(),
  ])
  let accounts = await getAccounts()

  // First run (or after a reset): import every signed-in profile's session.
  if (
    !Object.keys(accounts).length &&
    profileResult.value.some((profile) => profile.hasSession)
  ) {
    const synced = await syncAccounts()
    if (synced.ok) accounts = await getAccounts()
  }

  const liveHash = session ? (await sha256Hex(session)).slice(0, 16) : null

  const all = profileResult.value.map((profile) => {
    const account = accounts[profile.id] || null
    const expired = Boolean(account && account.status === 'expired')
    // A failed verification wins over a hash match: the cookie is still there,
    // but it no longer signs us in.
    const isCurrent = Boolean(
      !expired &&
        liveHash &&
        ((account && account.sessionId === liveHash) ||
          profile.sessionId === liveHash),
    )
    const title =
      (account && (account.claudeEmail || account.email || account.label)) ||
      profile.email ||
      profile.label ||
      profile.profile

    let status
    if (isCurrent) status = 'active'
    else if (expired) status = 'expired'
    else if (profile.hasSession || account) status = 'ready'
    else status = 'signin'

    const canSwitch = status === 'ready' || status === 'active'
    const subtitle = [
      `${profile.browserLabel || 'Chrome'} · ${profile.profile}`,
      status === 'signin' ? 'not signed in' : null,
      status === 'expired' ? 'session expired — sign in again' : null,
      status === 'ready' && !isCurrent ? 'ready to switch' : null,
      isCurrent ? 'active in this browser' : null,
    ]
      .filter(Boolean)
      .join(' · ')

    return {
      key: `profile:${profile.id}`,
      profileId: profile.id,
      profile: profile.profile,
      browser: profile.browser,
      browserLabel: profile.browserLabel,
      email:
        (account && (account.claudeEmail || account.email)) ||
        profile.email ||
        null,
      title,
      subtitle,
      isCurrent,
      isHost: Boolean(profile.hasExtension),
      hasAccount: Boolean(account),
      status,
      action: canSwitch ? 'switch' : 'signin',
    }
  })

  // Every profile is listed. The active account is marked so it can be
  // re-applied (the escape hatch if a cloned session gets rejected).
  const active = all.find((entry) => entry.isCurrent) || null
  const entries = all

  return {
    profilesAvailable: profileResult.available,
    entries,
    active: active
      ? {
          key: active.key,
          profileId: active.profileId,
          profile: active.profile,
          email: active.email,
          title: active.title,
        }
      : null,
  }
}

// -------------------------------------------------------------------- open
// Capture the current chat and stash it for the profile we are about to open.
// Returns the text too, so the caller can also put it on the clipboard — the
// target Chrome profile may not have this extension loaded.
async function prepareOpen({ carry, sourceLabel, tabId }) {
  if (!carry) return { carried: false, text: null }

  const tab = tabId != null ? { id: tabId } : await activeClaudeTab()
  if (!tab) return { carried: false, text: null }

  const response = await sendToTab(tab.id, { type: 'capture' })
  const capture = response && response.ok ? response.data : null
  if (!capture || !capture.messages || !capture.messages.length) {
    return { carried: false, text: null }
  }

  const text = renderContextDocument({
    title: capture.title,
    sourceLabel,
    messages: capture.messages,
  })
  if (!text) return { carried: false, text: null }

  const written = await nativeSend({ type: 'writeTransfer', text })
  return { carried: Boolean(written && written.ok), text }
}

// --------------------------------------------------------------- diagnostics
// Reports what switching an account depends on.
async function diagnose() {
  const report = []

  const ping = await nativeSend({ type: 'ping' })
  report.push(
    ping && ping.ok
      ? `helper: ok (v${ping.version || '?'})`
      : `helper: unavailable — ${(ping && ping.error) || 'no response'}`,
  )

  const profiles = await getChromeProfiles()
  report.push(
    profiles.available
      ? `profiles: ${profiles.value.length} found`
      : 'profiles: scanning off (helper unavailable)',
  )

  const accounts = await getAccounts()
  report.push(`saved accounts: ${Object.keys(accounts).length}`)

  // Did the session cookies actually land in this profile?
  const jar = await chrome.cookies.getAll({ domain: 'claude.ai' })
  const hubKey = jar.find((cookie) => cookie.name === 'sessionKey') || null
  report.push(
    `this profile claude.ai cookies: ${jar.length} (sessionKey: ${
      hubKey ? `yes, …${hubKey.value.slice(-4)}` : 'NO'
    })`,
  )

  const session = await currentSessionValue()
  if (session) {
    const hash = (await sha256Hex(session)).slice(0, 16)
    const match = Object.values(accounts).find((a) => a.sessionId === hash)
    report.push(
      `live session hash: ${hash} → ${
        match ? match.claudeEmail || match.profile : 'no saved account'
      }`,
    )
  } else {
    report.push('live session: none')
  }

  const last = await chrome.storage.local.get('claudeHubLastSwitch')
  const lastSwitch = last.claudeHubLastSwitch
  report.push(
    lastSwitch
      ? `last switch: ${lastSwitch.profile} · wrote ${lastSwitch.written}/${
          lastSwitch.total
        }${
          lastSwitch.failed && lastSwitch.failed.length
            ? ' · failed: ' + lastSwitch.failed.join(', ')
            : ''
        }`
      : 'last switch: none',
  )

  const transfer = await nativeSend({ type: 'readTransfer', consume: false })
  report.push(
    transfer && transfer.ok && transfer.data && transfer.data.text
      ? `pending context hand-off: ${transfer.data.text.length} chars`
      : 'pending context hand-off: none',
  )

  report.push('cookie writes: this profile only (source profiles are read-only)')

  return report.join('\n')
}

// --------------------------------------------------------------- messaging
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return

  if (message.type === 'state') {
    buildState()
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }))
    return true
  }

  if (message.type === 'prepareOpen') {
    const tabId = sender.tab ? sender.tab.id : null
    prepareOpen({ carry: message.carry, sourceLabel: message.sourceLabel, tabId })
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }))
    return true
  }

  if (message.type === 'openProfile') {
    nativeSend({
      type: 'openProfile',
      profileId: message.profileId,
      url: message.url,
    })
      .then((response) => sendResponse(response || { ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }))
    return true
  }

  if (message.type === 'syncAccounts') {
    syncAccounts()
      .then((response) => {
        broadcastRefresh()
        sendResponse(response || { ok: true })
      })
      .catch((err) => sendResponse({ ok: false, error: String(err) }))
    return true
  }

  if (message.type === 'switchAccount') {
    switchAccount({
      profileId: message.profileId,
      carry: message.carry,
      sourceLabel: message.sourceLabel,
      tabId: sender.tab ? sender.tab.id : null,
    })
      .then((response) => sendResponse(response || { ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }))
    return true
  }

  if (message.type === 'sessionStatus') {
    reportSessionStatus({ loggedIn: message.loggedIn, email: message.email })
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: true }))
    return true
  }

  if (message.type === 'pendingTransfer') {
    nativeSend({ type: 'readTransfer', consume: true })
      .then((response) => {
        const data = response && response.ok ? response.data : null
        sendResponse({ ok: true, data })
      })
      .catch(() => sendResponse({ ok: true, data: null }))
    return true
  }

  if (message.type === 'diagnose') {
    diagnose()
      .then((text) => sendResponse({ ok: true, text }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }))
    return true
  }

  if (message.type === 'reset') {
    ;(async () => {
      try {
        await chrome.storage.local.clear()
        await clearClaudeCookies()
        await nativeSend({ type: 'clearTransfer' }).catch(() => {})
        profileCache = { at: 0, value: [], available: false }
        await reloadClaudeTabs()
        broadcastRefresh()
        sendResponse({ ok: true })
      } catch (err) {
        sendResponse({ ok: false, error: String(err) })
      }
    })()
    return true
  }
})
