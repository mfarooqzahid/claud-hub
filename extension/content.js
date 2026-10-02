// Content script on claude.ai: the on-page account dock, plus capturing the
// current conversation and inserting carried context into the composer.
//
// The whole script is wrapped in an IIFE with a load guard so it is safe to
// inject more than once (declared content script + chrome.scripting fallback).
;(function () {
  if (window.__claudeHubContentLoaded) return
  window.__claudeHubContentLoaded = true

  const CLAUDE = 'https://claude.ai'
  const TRANSFER_TTL_MS = 30 * 60 * 1000

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim()

  // Storage helpers that never throw. After the extension is reloaded/updated,
  // an open tab's content script loses its context and chrome.* calls reject
  // with "Extension context invalidated"; these swallow that gracefully.
  async function storageGet(keys) {
    try {
      return await chrome.storage.local.get(keys)
    } catch {
      return {}
    }
  }
  async function storageSet(values) {
    try {
      await chrome.storage.local.set(values)
      return true
    } catch {
      return false
    }
  }
  async function storageRemove(keys) {
    try {
      await chrome.storage.local.remove(keys)
      return true
    } catch {
      return false
    }
  }

  // ---------------------------------------------------------------- capture
  function conversationIdFromUrl() {
    const match = location.pathname.match(/\/chat\/([0-9a-fA-F-]{36})/)
    return match ? match[1] : null
  }

  async function claudeApi(path) {
    const res = await fetch(CLAUDE + path, {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    })
    if (!res.ok) throw new Error(`Claude API ${res.status} for ${path}`)
    return res.json()
  }

  async function organizationId() {
    const orgs = await claudeApi('/api/organizations')
    const list = Array.isArray(orgs) ? orgs : orgs.data || []
    const first = list[0] || {}
    return first.uuid || first.id
  }

  // Best-effort account identity from the page's own session, used when saving
  // the current account. Falls back to null so the caller can name it manually.
  async function identifyAccount() {
    for (const path of ['/api/account', '/api/account/profile']) {
      try {
        const data = await claudeApi(path)
        const email = data && (data.email_address || data.email)
        const name = data && (data.full_name || data.name)
        if (email || name) return { email: email || null, name: name || null }
      } catch {
        /* try the next endpoint */
      }
    }
    try {
      const orgs = await claudeApi('/api/organizations')
      const list = Array.isArray(orgs) ? orgs : (orgs && orgs.data) || []
      const first = list[0] || {}
      return {
        email: first.email_address || first.email || null,
        name: first.name || null,
      }
    } catch {
      return null
    }
  }

  function normalizeMessage(raw) {
    const sender = String(raw.sender || raw.role || 'human').toLowerCase()
    const role = ['assistant', 'ai', 'claude'].includes(sender)
      ? 'assistant'
      : 'user'
    let content = raw.text
    if (!content && Array.isArray(raw.content)) {
      content = raw.content.map((p) => p.text || '').join('')
    }
    return { id: raw.uuid || raw.id, role, content: content || '' }
  }

  async function captureConversation() {
    const conversationId = conversationIdFromUrl()
    if (!conversationId) return null
    const orgId = await organizationId()
    const data = await claudeApi(
      `/api/organizations/${orgId}/chat_conversations/${conversationId}`,
    )
    const messages = (data.chat_messages || []).map(normalizeMessage)
    return {
      title: data.name || document.title,
      conversationId,
      messages,
    }
  }

  // Report from the page context whether claude.ai accepts this profile's
  // session. The service worker can't be sure cookies are attached to its own
  // fetch, so this is the authoritative check that flags an expired account.
  async function reportSession() {
    try {
      const res = await fetch(CLAUDE + '/api/organizations', {
        credentials: 'include',
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      })
      const type = res.headers.get('content-type') || ''
      const loggedIn = res.ok && type.includes('application/json')
      let identity = null
      if (loggedIn) identity = await identifyAccount()
      sendToBackground({
        type: 'sessionStatus',
        loggedIn,
        email: identity && identity.email,
      })
    } catch {
      sendToBackground({ type: 'sessionStatus', loggedIn: null })
    }
  }

  // ----------------------------------------------------------------- insert
  function findComposer() {
    const candidates = document.querySelectorAll('div[contenteditable="true"]')
    let fallback = null
    for (const el of candidates) {
      if (el.closest('[aria-hidden="true"]')) continue
      const rect = el.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) continue
      if (el.classList.contains('ProseMirror')) return el
      if (!fallback) fallback = el
    }
    return fallback
  }

  function placeCaretAtEnd(el) {
    try {
      const selection = window.getSelection()
      if (!selection) return
      const range = document.createRange()
      range.selectNodeContents(el)
      range.collapse(false)
      selection.removeAllRanges()
      selection.addRange(range)
    } catch {
      /* ignore */
    }
  }

  // Try the most reliable path first (execCommand drives ProseMirror's input
  // handling); fall back to a synthetic paste. Returns true if text landed.
  function insertInto(composer, text) {
    composer.focus()
    placeCaretAtEnd(composer)
    try {
      document.execCommand('insertText', false, text)
    } catch {
      /* ignore */
    }
    if (!normalize(composer.innerText)) {
      try {
        const data = new DataTransfer()
        data.setData('text/plain', text)
        composer.dispatchEvent(
          new ClipboardEvent('paste', {
            clipboardData: data,
            bubbles: true,
            cancelable: true,
          }),
        )
      } catch {
        /* ignore */
      }
    }
    return Boolean(normalize(composer.innerText))
  }

  // Keep re-inserting while the app is settling. claude.ai may remount the
  // composer right after a session switch, which clears a one-shot injection.
  async function ensureInserted(text) {
    const target = normalize(text)
    const probe = target.slice(0, 40)
    const deadline = Date.now() + 25000
    let stable = 0
    let sawText = false

    while (Date.now() < deadline) {
      const composer = findComposer()
      if (composer) {
        const current = normalize(composer.innerText)
        if (!current) {
          insertInto(composer, text)
          stable = 0
        } else if (
          current === target ||
          (probe && current.startsWith(probe) && current.length >= target.length * 0.9)
        ) {
          sawText = true
          stable += 1
          if (stable >= 4) return 'stable' // held still for ~3s
        } else if (probe && current.length < target.length && target.startsWith(current)) {
          stable = 0 // still rendering, wait
        } else {
          return 'user' // someone typed; never clobber
        }
      } else {
        stable = 0
      }
      await sleep(800)
    }
    return sawText ? 'unstable' : 'failed'
  }

  // ------------------------------------------------------------ transfer I/O
  async function readTransfer() {
    const { pendingTransfer } = await storageGet('pendingTransfer')
    if (pendingTransfer && pendingTransfer.text) {
      if (
        pendingTransfer.createdAt &&
        Date.now() - pendingTransfer.createdAt > TRANSFER_TTL_MS
      ) {
        await storageRemove('pendingTransfer')
        return null
      }
      return pendingTransfer
    }
    // Cross-profile hand-off: the window we were opened from left the context in
    // a temp file brokered by the native helper, because chrome.storage.local is
    // per Chrome profile. Consume it once.
    const res = await sendToBackground({ type: 'pendingTransfer' })
    if (res && res.ok && res.data && res.data.text) {
      await storageSet({ pendingTransfer: res.data })
      return res.data
    }
    return null
  }

  async function markApplied(transfer) {
    await storageSet({
      pendingTransfer: { ...transfer, appliedAt: Date.now() },
    })
  }

  async function clearTransfer() {
    await storageRemove('pendingTransfer')
  }

  let sendWatch = null
  function watchForSend() {
    if (sendWatch) return
    sendWatch = setInterval(async () => {
      const { pendingTransfer } = await storageGet('pendingTransfer')
      if (!pendingTransfer) {
        clearInterval(sendWatch)
        sendWatch = null
        return
      }
      // A conversation URL means the message was sent (or the user moved on).
      if (/^\/chat\//.test(location.pathname)) {
        await clearTransfer()
        clearInterval(sendWatch)
        sendWatch = null
      }
    }, 2500)
  }

  function toast(message) {
    const el = document.createElement('div')
    el.textContent = message
    Object.assign(el.style, {
      position: 'fixed',
      bottom: '22px',
      right: '22px',
      zIndex: '2147483647',
      background: '#1f1e1d',
      color: '#f3f2ee',
      border: '1px solid #3a3a37',
      borderRadius: '10px',
      padding: '10px 14px',
      font: '13px ui-sans-serif, system-ui, sans-serif',
      boxShadow: '0 6px 24px rgba(0,0,0,.4)',
      maxWidth: '360px',
      lineHeight: '1.45',
    })
    document.body.appendChild(el)
    setTimeout(() => el.remove(), 6000)
  }

  let resuming = false
  async function resumePendingTransfer() {
    if (resuming) return
    const transfer = await readTransfer()
    if (!transfer) return

    // Already applied and now inside a conversation: assume it was sent.
    if (transfer.appliedAt && /^\/chat\//.test(location.pathname)) {
      await clearTransfer()
      return
    }

    const onNewChat = location.pathname === '/new' || location.pathname === '/'
    if (!onNewChat) return // wait until we're on a fresh chat

    resuming = true
    await markApplied(transfer)
    const result = await ensureInserted(transfer.text)
    resuming = false

    if (result === 'stable' || result === 'user') {
      toast(
        'Context from your previous Claude account is in the composer. Add your next message and send.',
      )
      // Keep the transfer so a refresh/remount restores it; it clears when the
      // message is sent or after the TTL.
      watchForSend()
    } else if (result === 'unstable') {
      toast(
        'Context inserted, but Claude is still loading. If the box is empty, switch again to retry.',
      )
      watchForSend()
    }
    // 'failed' (no composer yet): leave the transfer so a later load retries.
  }

  // ---------------------------------------------------------- on-page dock
  // A slim strip of account icons on an edge of claude.ai. Hover shows a
  // tooltip; click switches. Rendered in a shadow root so claude.ai's styles
  // and ours never collide.
  const CARRY_KEY = 'claudeHubCarry'
  const RAIL_VISIBLE_KEY = 'claudeHubRailVisible'
  const RAIL_POSITION_KEY = 'claudeHubRailPosition'
  const SELECTED_KEY = 'claudeHubSelectedKey'
  const POSITIONS = ['right', 'bottom', 'left', 'top']
  let carryEnabled = true
  let railVisible = true
  let railPosition = 'right'
  let sidebar = null
  let lastState = null
  let switching = false
  // Which account the user tapped in the dock. Nothing is highlighted until then.
  let selectedKey = null
  // Rendering guards. The dock must not rebuild its buttons constantly or a
  // click (mousedown→mouseup) never lands and the tooltip flickers.
  let renderSeq = 0
  let lastSignature = null
  let renderTimer = null

  function scheduleRender() {
    if (renderTimer) return
    renderTimer = setTimeout(() => {
      renderTimer = null
      renderSidebar().catch(() => {})
    }, 120)
  }

  function initials(title) {
    const base = String(title || '?').split('@')[0].trim()
    const parts = base.split(/[^a-zA-Z0-9]+/).filter(Boolean)
    if (!parts.length) return '?'
    const letters =
      parts.length === 1 ? parts[0].slice(0, 2) : parts[0][0] + parts[1][0]
    return letters.toUpperCase()
  }

  function bgFor(key) {
    let hue = 0
    for (let i = 0; i < key.length; i += 1) {
      hue = (hue * 31 + key.charCodeAt(i)) % 360
    }
    return `linear-gradient(135deg, hsl(${hue} 52% 44%), hsl(${(hue + 45) % 360} 52% 34%))`
  }

  function sendToBackground(message) {
    return new Promise((resolve) => {
      let done = false
      const finish = (value) => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve(value)
      }
      // Never leave a click waiting forever — a stuck request would freeze the
      // dock's "switching" guard and make every later tap look dead.
      const timer = setTimeout(
        () =>
          finish({
            ok: false,
            error: 'Claude Hub did not respond. Refresh this page and try again.',
          }),
        15000,
      )
      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) {
            finish({ ok: false, error: chrome.runtime.lastError.message })
          } else {
            finish(response)
          }
        })
      } catch (err) {
        finish({ ok: false, error: String(err) })
      }
    })
  }

  function ensureSidebar() {
    if (sidebar && document.documentElement.contains(sidebar.host)) return sidebar
    const host = document.createElement('div')
    host.id = 'claude-hub-dock'
    const shadow = host.attachShadow({ mode: 'open' })
    shadow.innerHTML = `
      <style>
        .bar {
          position: fixed; display: flex; align-items: center; gap: 7px;
          padding: 8px 6px; border-radius: 999px; z-index: 2147483000;
          background: rgba(28,28,26,.74); border: 1px solid rgba(255,255,255,.12);
          -webkit-backdrop-filter: blur(14px); backdrop-filter: blur(14px);
          box-shadow: 0 8px 30px rgba(0,0,0,.35);
          font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
        }
        .bar.pos-right { right: 10px; top: 50%; transform: translateY(-50%); flex-direction: column; }
        .bar.pos-left  { left: 10px;  top: 50%; transform: translateY(-50%); flex-direction: column; }
        .bar.pos-top   { top: 10px;   left: 50%; transform: translateX(-50%); flex-direction: row; }
        .bar.pos-bottom{ bottom: 10px;left: 50%; transform: translateX(-50%); flex-direction: row; }
        .ctrl {
          position: relative;
          width: 34px; height: 34px; border-radius: 50%; cursor: pointer; flex: 0 0 auto;
          border: 1px solid rgba(255,255,255,.18); background: transparent;
          color: #c9c8c2; font-size: 14px; display: grid; place-items: center;
          transition: background .15s, color .15s;
        }
        .ctrl:hover { color: #fff; background: rgba(255,255,255,.08); }
        .ctrl.on { background: rgba(214,140,90,.92); color: #1a1a18; border-color: transparent; }
        .sep { background: rgba(255,255,255,.14); flex: 0 0 auto; }
        .bar.pos-right .sep, .bar.pos-left .sep { width: 22px; height: 1px; }
        .bar.pos-top .sep, .bar.pos-bottom .sep { width: 1px; height: 22px; }
        .item {
          position: relative; width: 34px; height: 34px; border-radius: 50%;
          border: none; cursor: pointer; color: #fff; font-size: 12px; flex: 0 0 auto;
          font-weight: 600; letter-spacing: .3px; display: grid; place-items: center;
          box-shadow: 0 2px 8px rgba(0,0,0,.3); transition: transform .12s;
        }
        .item:hover { transform: scale(1.09); }
        .item.current { outline: 2px solid #d68c5a; outline-offset: 2px; }
        .item.here { box-shadow: 0 0 0 2px rgba(214,140,90,.65); }
        .item.action-signin { opacity: .5; }
        .tip {
          position: absolute; background: #1b1b19; color: #f3f2ee; z-index: 1;
          border: 1px solid rgba(255,255,255,.14); border-radius: 8px;
          padding: 6px 10px; white-space: nowrap; font-size: 12px; line-height: 1.4;
          box-shadow: 0 6px 20px rgba(0,0,0,.4); opacity: 0; pointer-events: none;
          transition: opacity .12s;
        }
        .bar.pos-right .tip { right: 44px; top: 50%; transform: translateY(-50%); }
        .bar.pos-left .tip  { left: 44px;  top: 50%; transform: translateY(-50%); }
        .bar.pos-top .tip   { top: 44px;   left: 50%; transform: translateX(-50%); }
        .bar.pos-bottom .tip{ bottom: 44px;left: 50%; transform: translateX(-50%); }
        .tip b { display: block; font-weight: 600; }
        .tip span { color: #a9a8a2; font-size: 11px; }
        .item:hover .tip, .ctrl:hover .tip { opacity: 1; }
        .msg { color: #c9c8c2; font-size: 11px; padding: 3px; }
      </style>
      <div class="bar"></div>
    `
    sidebar = { host, bar: shadow.querySelector('.bar') }
    document.documentElement.appendChild(host)
    return sidebar
  }

  function hintFor(entry) {
    if (entry.isCurrent) return 'active in this browser'
    if (entry.action === 'signin') {
      return entry.status === 'expired'
        ? 'session expired — click to sign in again'
        : 'not signed in — click to sign in'
    }
    return carryEnabled
      ? 'click to switch this browser + carry this chat'
      : 'click to switch this browser'
  }

  // Build a round control button whose tooltip matches the account tooltips.
  function makeControl(glyph, tooltipText, onClick, active = false) {
    const button = document.createElement('button')
    button.className = 'ctrl' + (active ? ' on' : '')
    const icon = document.createElement('span')
    icon.textContent = glyph
    // A button may only contain phrasing content — a span, not a div.
    const tip = document.createElement('span')
    tip.className = 'tip'
    tip.textContent = tooltipText
    button.append(icon, tip)
    button.addEventListener('click', onClick)
    return { button, tip }
  }

  async function onEntryClick(entry) {
    if (switching) return
    // Tap selects the profile; nothing is highlighted before that.
    selectedKey = entry.key
    storageSet({ [SELECTED_KEY]: selectedKey })
    renderSidebar().catch(() => {})
    // The active account is still clickable: re-applying it is how you get back
    // to chats if a cloned session was rejected.
    switching = true
    try {
      const here = lastState && lastState.active
      const sourceLabel = here ? here.title : null

      if (entry.action === 'signin') {
        const res = await sendToBackground({
          type: 'openProfile',
          profileId: entry.profileId,
        })
        toast(
          res && res.ok
            ? `Opening ${entry.profile || entry.title} to sign in…`
            : 'Could not open that profile',
        )
        return
      }

      const res = await sendToBackground({
        type: 'switchAccount',
        profileId: entry.profileId,
        carry: carryEnabled,
        sourceLabel,
      })
      if (!res || !res.ok) {
        toast(`Could not switch: ${(res && res.error) || 'unknown error'}`)
        return
      }
      // Keep a clipboard copy too, in case the composer injection is blocked.
      if (res.carried && res.text && navigator.clipboard) {
        try {
          await navigator.clipboard.writeText(res.text)
        } catch {
          /* clipboard is best-effort */
        }
      }
      if (res.carried) {
        toast(`Switching to ${entry.title}. Context carried into the new chat.`)
      } else {
        toast(`Switching to ${entry.title}…`)
      }
    } finally {
      switching = false
    }
  }

  function styleBar() {
    if (!sidebar) return
    sidebar.bar.className = 'bar pos-' + railPosition
  }

  async function renderSidebar() {
    if (!railVisible) {
      lastSignature = null
      if (sidebar) {
        sidebar.host.remove()
        sidebar = null
      }
      return
    }
    const seq = ++renderSeq
    const root = ensureSidebar()
    styleBar()
    const res = await sendToBackground({ type: 'state' })
    if (seq !== renderSeq) return // superseded by a newer render
    const bar = root.bar

    if (!res || !res.ok) {
      const err = (res && res.error) || ''
      lastSignature = null
      bar.replaceChildren()
      const msg = document.createElement('div')
      msg.className = 'msg'
      msg.textContent = /context invalidated|receiving end does not exist|did not respond/i.test(
        err,
      )
        ? 'reload this page'
        : 'unavailable'
      bar.appendChild(msg)
      return
    }

    lastState = res.data

    // Skip the DOM rebuild when nothing the dock shows has changed. Replacing
    // the buttons on every poll/refresh is what made them unclickable and made
    // the tooltip flicker.
    const signature = JSON.stringify({
      selectedKey,
      carryEnabled,
      railPosition,
      entries: (res.data.entries || []).map((e) => [
        e.key,
        e.action,
        e.status,
        e.isCurrent,
      ]),
    })
    if (signature === lastSignature && sidebar === root) return
    lastSignature = signature
    bar.replaceChildren()

    const carry = makeControl(
      '⇄',
      carryEnabled
        ? 'Carrying the current conversation: on'
        : 'Carrying the current conversation: off',
      async () => {
        carryEnabled = !carryEnabled
        await storageSet({ [CARRY_KEY]: carryEnabled })
        renderSidebar()
      },
      carryEnabled,
    )
    bar.appendChild(carry.button)

    const move = makeControl(
      '✥',
      `Move dock (now: ${railPosition})`,
      async () => {
        const index = POSITIONS.indexOf(railPosition)
        railPosition = POSITIONS[(index + 1) % POSITIONS.length]
        await storageSet({ [RAIL_POSITION_KEY]: railPosition })
        styleBar()
        move.tip.textContent = `Move dock (now: ${railPosition})`
      },
    )
    bar.appendChild(move.button)

    const sep = document.createElement('div')
    sep.className = 'sep'
    bar.appendChild(sep)

    // One flat list of Chrome profiles — the same single list the popup shows.
    const dockEntries = res.data.entries || []

    for (const entry of dockEntries) {
      const item = document.createElement('button')
      item.className = 'item'
      const selected = entry.key === selectedKey
      if (selected) item.classList.add('current')
      if (entry.isCurrent) item.classList.add('here')
      if (entry.action === 'signin') item.classList.add('action-signin')
      item.style.background = selected
        ? 'linear-gradient(135deg,#d68c5a,#b0693c)'
        : bgFor(entry.key)
      item.textContent = initials(entry.title)

      const tip = document.createElement('span')
      tip.className = 'tip'
      const name = document.createElement('b')
      name.textContent = entry.title
      const sub = document.createElement('span')
      sub.textContent = [entry.subtitle, hintFor(entry)].filter(Boolean).join(' — ')
      tip.append(name, sub)
      item.appendChild(tip)

      item.addEventListener('click', () => onEntryClick(entry))
      bar.appendChild(item)
    }

    if (!dockEntries.length) {
      const msg = document.createElement('div')
      msg.className = 'msg'
      msg.textContent = 'no profiles'
      bar.appendChild(msg)
    }
  }

  storageGet([CARRY_KEY, RAIL_VISIBLE_KEY, RAIL_POSITION_KEY, SELECTED_KEY]).then((value) => {
    if (typeof value[CARRY_KEY] === 'boolean') carryEnabled = value[CARRY_KEY]
    if (typeof value[RAIL_VISIBLE_KEY] === 'boolean') {
      railVisible = value[RAIL_VISIBLE_KEY]
    }
    if (POSITIONS.includes(value[RAIL_POSITION_KEY])) {
      railPosition = value[RAIL_POSITION_KEY]
    }
    if (typeof value[SELECTED_KEY] === 'string') selectedKey = value[SELECTED_KEY]
    renderSidebar()
  })

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return
    const keys = Object.keys(changes)
    // The tap itself already re-renders; ignoring its own write avoids a second
    // rebuild that would eat the click.
    if (keys.length === 1 && keys[0] === SELECTED_KEY) return
    if (changes[CARRY_KEY]) carryEnabled = changes[CARRY_KEY].newValue !== false
    if (changes[RAIL_VISIBLE_KEY]) {
      railVisible = changes[RAIL_VISIBLE_KEY].newValue !== false
    }
    if (changes[RAIL_POSITION_KEY] && changes[RAIL_POSITION_KEY].newValue) {
      railPosition = changes[RAIL_POSITION_KEY].newValue
    }
    scheduleRender()
  })

  window.addEventListener('focus', scheduleRender)
  setInterval(scheduleRender, 60000)

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message && message.type === 'capture') {
      captureConversation()
        .then((data) => sendResponse({ ok: true, data }))
        .catch((err) => sendResponse({ ok: false, error: String(err) }))
      return true
    }
    if (message && message.type === 'sidebar:refresh') {
      scheduleRender()
      sendResponse({ ok: true })
      return false
    }
  })

  resumePendingTransfer().catch(() => {})
  reportSession().catch(() => {})
  window.addEventListener('focus', () => reportSession().catch(() => {}))
})()
