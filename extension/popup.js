// Claude Hub popup — one flat list of Chrome profiles. Clicking an account
// applies its saved session in this hub profile; "Open profile" opens the
// account's own Chrome profile (for signing in). The current conversation is
// carried across when enabled.

const statusEl = document.getElementById('status')
const accountsEl = document.getElementById('accounts')
const refreshBtn = document.getElementById('refresh')
const syncBtn = document.getElementById('sync')
const carryEl = document.getElementById('carry')
const railVisibleEl = document.getElementById('rail-visible')
const positionsEl = document.getElementById('positions')
const resetBtn = document.getElementById('reset')
const diagnoseBtn = document.getElementById('diagnose')
const diagnosticsEl = document.getElementById('diagnostics')

let busy = false
let currentTitle = null
let hostAvailable = false
let tmpStatus = null

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text != null) node.textContent = text
  return node
}

function setStatus(text, isError = false) {
  statusEl.textContent = text || ''
  statusEl.className = 'status' + (isError ? ' error' : '')
}

function send(message) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message })
        } else {
          resolve(response)
        }
      })
    } catch (err) {
      resolve({ ok: false, error: String(err) })
    }
  })
}

function action(label, fn) {
  return async () => {
    if (busy) return
    busy = true
    setStatus(label)
    try {
      const message = await fn()
      tmpStatus = message ? { text: message } : null
    } catch (err) {
      tmpStatus = { text: err.message || String(err), error: true }
    } finally {
      busy = false
      await render()
    }
  }
}

// ----------------------------------------------------------------- actions
const switchAccount = (entry) =>
  action(`Switching to ${entry.title}`, async () => {
    const res = await send({
      type: 'switchAccount',
      profileId: entry.profileId,
      carry: carryEl.checked,
      sourceLabel: currentTitle,
    })
    if (!res || !res.ok) throw new Error((res && res.error) || 'unknown error')
    if (res.carried && res.text && navigator.clipboard) {
      try {
        await navigator.clipboard.writeText(res.text)
      } catch {
        /* clipboard is best-effort */
      }
    }
    return res.carried
      ? `Switched to ${entry.title}. Context carried into the new chat.`
      : `Switched to ${entry.title}.`
  })

const openProfile = (entry) =>
  action(`Opening ${entry.profile || entry.title}`, async () => {
    const res = await send({ type: 'openProfile', profileId: entry.profileId })
    if (!res || !res.ok) throw new Error((res && res.error) || 'unknown error')
    return `Opened ${entry.profile || entry.title}'s own profile. Sign in there, then Sync.`
  })

const syncNow = () =>
  action('Syncing accounts', async () => {
    const res = await send({ type: 'syncAccounts' })
    if (!res || !res.ok) throw new Error((res && res.error) || 'unknown error')
    return `Imported ${res.count} account${res.count === 1 ? '' : 's'}.`
  })

// ------------------------------------------------------------------- rows
function actionButton(icon, title, handler, active = false) {
  const button = el('button', 'iconbtn action' + (active ? ' on' : ''), icon)
  button.title = title
  button.setAttribute('aria-label', title)
  button.disabled = busy
  button.addEventListener('click', handler)
  return button
}

function row({ title, sub, isCurrent, status, actions = [] }) {
  const item = el('div', 'item' + (isCurrent ? ' current' : ''))
  item.appendChild(el('span', 'dot'))

  const meta = el('div', 'meta')
  meta.appendChild(el('div', 'name', title))
  meta.appendChild(el('div', 'sub', sub))
  item.appendChild(meta)

  if (isCurrent) item.appendChild(el('span', 'tag', 'active'))
  else if (status === 'expired') item.appendChild(el('span', 'tag', 'expired'))
  for (const action of actions) item.appendChild(action)

  return item
}

function entryActions(entry) {
  if (entry.action === 'signin') {
    return [actionButton('→', 'Sign in to this profile', openProfile(entry))]
  }
  return [
    actionButton(
      '⇄',
      carryEl.checked ? 'Switch here and carry this chat' : 'Switch here',
      switchAccount(entry),
      carryEl.checked,
    ),
    actionButton('↗', 'Open this account in its own profile', openProfile(entry)),
  ]
}

async function render() {
  accountsEl.replaceChildren()
  const stateRes = await send({ type: 'state' })

  if (!stateRes || !stateRes.ok) {
    setStatus(`Extension error: ${(stateRes && stateRes.error) || 'unknown'}`, true)
    return
  }

  hostAvailable = Boolean(stateRes.data.profilesAvailable)
  const entries = stateRes.data.entries || []
  const active = stateRes.data.active || null
  currentTitle = active ? active.title : null

  let rendered = 0
  for (const entry of entries) {
    accountsEl.appendChild(
      row({
        title: entry.title,
        sub: entry.subtitle,
        isCurrent: entry.isCurrent,
        status: entry.status,
        actions: entryActions(entry),
      }),
    )
    rendered += 1
  }

  if (rendered === 0) {
    accountsEl.appendChild(
      el(
        'div',
        'empty',
        active
          ? 'No other accounts found. Sign in to Claude in another Chrome profile, then Sync.'
          : 'No Chrome profiles found. Run native-host/install.py once so profiles can be detected, then reopen this popup.',
      ),
    )
  }

  if (!hostAvailable) {
    accountsEl.appendChild(
      el(
        'div',
        'empty',
        'Chrome profile scanning is off. Run native-host/install.py once to enable it.',
      ),
    )
  }

  if (tmpStatus) {
    setStatus(tmpStatus.text, tmpStatus.error)
    tmpStatus = null
  } else if (active) {
    setStatus(`Active: ${active.title}`)
  } else if (rendered) {
    setStatus('Pick an account to switch this browser to.')
  } else {
    setStatus('No other accounts found.')
  }
}

// -------------------------------------------------------------- settings
function setActivePosition(position) {
  for (const button of positionsEl.querySelectorAll('button[data-pos]')) {
    button.classList.toggle('active', button.dataset.pos === position)
  }
}

function initSettings() {
  chrome.storage.local
    .get(['claudeHubCarry', 'claudeHubRailVisible', 'claudeHubRailPosition'])
    .then((settings) => {
      carryEl.checked = settings.claudeHubCarry !== false
      railVisibleEl.checked = settings.claudeHubRailVisible !== false
      setActivePosition(settings.claudeHubRailPosition || 'right')
    })

  carryEl.addEventListener('change', () => {
    chrome.storage.local.set({ claudeHubCarry: carryEl.checked })
    render()
  })
  railVisibleEl.addEventListener('change', () =>
    chrome.storage.local.set({ claudeHubRailVisible: railVisibleEl.checked }),
  )
  positionsEl.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-pos]')
    if (!button) return
    setActivePosition(button.dataset.pos)
    chrome.storage.local.set({ claudeHubRailPosition: button.dataset.pos })
  })
}

refreshBtn.addEventListener('click', render)
syncBtn.addEventListener('click', syncNow)

let resetArmed = false
resetBtn.addEventListener('click', async () => {
  if (!resetArmed) {
    resetArmed = true
    resetBtn.classList.add('armed')
    resetBtn.title = 'Click again to confirm'
    return
  }
  resetArmed = false
  resetBtn.classList.remove('armed')
  resetBtn.title = 'Reset all data'
  const res = await send({ type: 'reset' })
  tmpStatus =
    res && res.ok
      ? { text: 'All data cleared and this profile signed out.' }
      : { text: (res && res.error) || 'Reset failed', error: true }
  render()
})

diagnoseBtn.addEventListener('click', async () => {
  diagnosticsEl.hidden = false
  diagnosticsEl.textContent = 'Running diagnostics…'
  const res = await send({ type: 'diagnose' })
  diagnosticsEl.textContent =
    res && res.ok
      ? res.text
      : `Diagnostics failed: ${(res && res.error) || 'unknown'}`
})

initSettings()
;(async () => {
  // Pull each signed-in profile's session in when the popup opens.
  await send({ type: 'syncAccounts' })
  render()
})()
