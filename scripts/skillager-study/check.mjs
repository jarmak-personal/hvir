import nodeAssert from 'node:assert/strict'
import { automaticRefreshAllowed } from './model.mjs'
import { setTimeout, clearTimeout } from 'node:timers'
const { fetch, WebSocket } = globalThis
import { Buffer } from 'node:buffer'
import process from 'node:process'
import console from 'node:console'
// Real Chromium checks of synthetic presentation only, adapted from the original offline study.
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { pathToFileURL, URL } from 'node:url'
const root = resolve(process.argv[2] || '/tmp/hvir-skillager-study')
const chromePath =
  process.env.HVIR_STUDY_CHROME ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
for (const enabled of [false, true])
  for (const connected of [false, true])
    for (const railMode of ['skills', 'files'])
      for (const viewer of ['skills', 'history'])
        for (const visible of [false, true])
          for (const focused of [false, true])
            nodeAssert.equal(
              automaticRefreshAllowed(
                { enabled, connected, railMode, viewer },
                visible,
                focused,
              ),
              enabled &&
                connected &&
                (railMode === 'skills' || viewer === 'skills') &&
                visible &&
                focused,
            )
const profile = await mkdtemp(join(tmpdir(), 'hvir-skillager-browser-'))
const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--remote-debugging-port=0',
    '--user-data-dir=' + profile,
    'about:blank',
  ],
  { stdio: ['ignore', 'ignore', 'pipe'] },
)
// Observe close from acquisition so an already-signaled exit cannot be missed in cleanup.
let childClosed = false
const childClose = new Promise((resolve) =>
  chrome.once('close', () => {
    childClosed = true
    resolve(true)
  }),
)
async function waitForClose(ms) {
  let timer
  try {
    return await Promise.race([
      childClose,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
let socket
const errors = [],
  checks = []
const deadline = setTimeout(() => chrome.kill('SIGKILL'), 45_000)
checks.push(
  'Automatic refresh eligibility: all 64 enable/connection/sidebar/viewer/visibility/focus combinations at the pure gate',
)
const limitations = [
  'Periodic eligibility is checked at its pure owner; browser checks exercise visibility/focus/viewer events, not a real 60-second wall-clock wait.',
]
try {
  const endpoint = await new Promise((resolve, reject) => {
    let log = ''
    chrome.stderr.on('data', (data) => {
      log += data
      const match = log.match(/DevTools listening on (ws:\/\/[^\s]+)/)
      if (match) resolve(match[1])
    })
    chrome.once('error', reject)
    chrome.once('exit', (code) => reject(new Error('Chrome exited ' + code)))
  })
  const tab = await (
    await fetch('http://' + new URL(endpoint).host + '/json/new?about:blank', {
      method: 'PUT',
    })
  ).json()
  socket = new WebSocket(tab.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
    socket.addEventListener(
      'close',
      () => reject(new Error('Browser socket closed before ready')),
      { once: true },
    )
  })
  let id = 0
  const pending = new Map()
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id) {
      const task = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) task?.reject(new Error(JSON.stringify(message.error)))
      else task?.resolve(message.result)
    } else if (message.method === 'Runtime.exceptionThrown')
      errors.push(message.params.exceptionDetails.text)
  })
  socket.addEventListener('close', () => {
    for (const task of pending.values())
      task.reject(new Error('Browser connection closed'))
    pending.clear()
  })
  const call = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const next = ++id
      pending.set(next, { resolve, reject })
      socket.send(
        JSON.stringify({ id: next, method, params, ...(sessionId ? { sessionId } : {}) }),
      )
    })
  const run = async (expression) => {
    const result = await call('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (result.exceptionDetails)
      throw new Error(
        result.exceptionDetails.exception?.description || result.exceptionDetails.text,
      )
    return result.result.value
  }
  const click = (selector) =>
    run(`document.querySelector(${JSON.stringify(selector)}).click()`)
  // New setup controls use actual pointer delivery and hit testing, not DOM click().
  const pointClick = async (selector) => {
    const point = await run(
      `(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.scrollIntoView({block:'nearest'});const r=el.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;if(!el.contains(document.elementFromPoint(x,y)))throw Error('Setup control is not reachable');return {x,y}})()`,
    )
    await call('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      ...point,
      button: 'left',
      clickCount: 1,
    })
    await call('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      ...point,
      button: 'left',
      clickCount: 1,
    })
  }
  const choose = (selector, value) =>
    run(
      `document.querySelector(${JSON.stringify(selector)}).value=${JSON.stringify(value)};document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new Event('change',{bubbles:true}))`,
    )
  const flow = (value) => choose('#scenario', value)
  const assert = async (expression, label) => {
    if (!(await run(expression))) throw new Error(label)
    checks.push(label)
  }
  const waitFor = (expression) =>
    run(
      `new Promise((resolve,reject)=>{const deadline=Date.now()+3000;function check(){if(${expression})return resolve(true);if(Date.now()>deadline)return reject(Error('State deadline'));setTimeout(check,20)}check()})`,
    )
  await call('Runtime.enable')
  await call('Page.enable')
  await call('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  })
  // Observe actual study timers without advancing its clock; retain one canceled search callback.
  await call('Page.addScriptToEvaluateOnNewDocument', {
    source: `
    window.studyTimers={intervals:new Set(),search:null,setup:null};
    const interval=window.setInterval,clear=window.clearInterval,timeout=window.setTimeout;
    window.setInterval=(fn,ms,...args)=>{const id=interval(fn,ms,...args);if(ms===60000)studyTimers.intervals.add(id);return id};
    window.clearInterval=id=>{studyTimers.intervals.delete(id);return clear(id)};
    window.setTimeout=(fn,ms,...args)=>{if(ms===500)studyTimers.search=fn;if(ms===600)studyTimers.setup=fn;return timeout(fn,ms,...args)};
  `,
  })
  const capture = async (name) => {
    const shot = await call('Page.captureScreenshot', { format: 'png' })
    await writeFile(join(root, name + '.png'), Buffer.from(shot.data, 'base64'))
  }
  const absent = `!document.querySelector('#skills-nav') && !document.querySelector('[data-viewer="skills"]') && !document.querySelector('#destination') && !document.querySelector('#connection-label') && !document.querySelector('[data-skill]') && document.querySelector('#skills-view').innerHTML==='' && document.querySelector('#skills-rail').innerHTML==='' && studyTimers.intervals.size===0`
  await call('Page.navigate', { url: pathToFileURL(join(root, 'index.html')).href })
  await waitFor(
    `document.querySelector('#document-view') && !document.querySelector('#document-view').hidden`,
  )
  await call('Page.bringToFront')
  await waitFor(`document.hasFocus()`)
  await assert(
    absent +
      ` && !/Skills|Skillager|Accepted ≠|Open Skills/.test(document.querySelector('.frame').innerText)`,
    'Initial off state has no feature surface, placeholder, command, status or periodic demand',
  )
  await capture('initial-off')
  await click('#settings')
  await assert(
    `!!document.querySelector('#enabled') && !document.querySelector('[data-action="connect"]') && !document.querySelector('[data-action="change-library"]') && !document.querySelector('#dialog').textContent.includes('executable')`,
    'Disabled Settings retains only the enable switch for this feature',
  )
  await click('#enabled')
  await assert(
    `document.querySelector('#dialog').textContent.includes('/home/example/.local/bin/skillager') && document.querySelector('#dialog').textContent.includes('/home/example/.skillager/library') && !document.querySelector('[data-viewer="skills"]') && studyTimers.intervals.size===0`,
    'Enable reveals connection settings without connecting or reopening a feature viewer',
  )
  await click('[data-action="close"]')
  await click('#skills-nav')
  await assert(
    `document.querySelector('#skills-rail').textContent.includes('Connect Skillager') && !document.querySelector('#document-view').hidden`,
    'Skills is a Files/Git sidebar peer; disconnected navigation preserves the document viewer',
  )
  await click('#settings')
  await click('[data-action="connect"]')
  await assert(
    `document.querySelectorAll('#skills-rail [data-skill]').length===6 && !document.querySelector('[data-viewer="skills"]') && studyTimers.intervals.size===1`,
    'Connection reveals sidebar metadata including pending drafts without opening a detail tab',
  )
  const terminal = await run(
    `JSON.stringify([document.querySelector('#terminal-pane').innerHTML,document.querySelector('.sessions').innerHTML,document.querySelector('#terminal-pane').getBoundingClientRect().toJSON(),document.querySelector('.sessions').getBoundingClientRect().toJSON()])`,
  )
  await click('[data-select="migration-review"]')
  await assert(
    `!!document.querySelector('#skills-rail #search') && !!document.querySelector('#skills-view #details') && !document.querySelector('#skills-view').textContent.includes('sample instructions')`,
    'Sidebar selection opens metadata in the main viewer without reading a body',
  )
  await capture('sidebar-details')
  await click('#details [data-action="read"]')
  await assert(
    `document.querySelector('#skills-view').textContent.includes('SKILL.md · sample instructions') && !document.querySelector('#dialog').open`,
    'Explicit Review content opens the selected snapshot in the main viewer',
  )
  await capture('explicit-review')
  await run(
    `document.querySelector('[data-skill="deploy-checklist"]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}))`,
  )
  await assert(
    `!document.querySelector('#skills-view').textContent.includes('sample instructions') && document.querySelector('#dialog-title').textContent.includes('deploy-checklist') && !document.querySelector('#dialog').textContent.includes('sample instructions')`,
    'Opening another skill action menu revokes prior body review and reveals metadata only',
  )
  await click('#dialog [data-action="read"]')
  await assert(
    `document.querySelector('#skills-view').textContent.includes('Review content · deploy-checklist') && document.querySelector('#skills-view').textContent.includes('sample instructions')`,
    'The newly selected skill body requires its own explicit Review content',
  )
  await assert(
    `document.querySelector('#review-count').textContent==='1 library review' && document.querySelector('#updates-count').textContent==='1 workspace update'`,
    'Enabled sidebar distinguishes library review from workspace update badges',
  )
  await click('[data-rail="git"]')
  await assert(
    `!document.querySelector('#git-rail').hidden && document.querySelector('#skills-view').textContent.includes('sample instructions') && studyTimers.intervals.size===1`,
    'Changing sidebar preserves the open feature review and its refresh demand',
  )
  await click('[data-viewer="history"]')
  await assert(
    `studyTimers.intervals.size===0 && !!document.querySelector('[data-viewer="skills"]')`,
    'Hiding both feature surfaces releases periodic demand without closing its tab',
  )
  await click('#skills-nav')
  await assert(
    `!document.querySelector('#history-view').hidden && studyTimers.intervals.size===1`,
    'Returning to Skills sidebar preserves an ordinary viewer and resumes sidebar demand',
  )
  await click('[data-action="close-skills"]')
  await assert(
    `!document.querySelector('[data-viewer="skills"]') && !!document.querySelector('#skills-rail #search') && studyTimers.intervals.size===1`,
    'Closing one feature tab releases its content while the visible sidebar remains usable',
  )
  await assert(
    `JSON.stringify([document.querySelector('#terminal-pane').innerHTML,document.querySelector('.sessions').innerHTML,document.querySelector('#terminal-pane').getBoundingClientRect().toJSON(),document.querySelector('.sessions').getBoundingClientRect().toJSON()])===${JSON.stringify(terminal)}`,
    'Sidebar and viewer navigation preserve terminal/session content and geometry',
  )
  await assert(
    `document.querySelector('.sessions').getBoundingClientRect().top>=document.querySelector('.main').getBoundingClientRect().bottom`,
    'Terminal session rail remains below the viewer',
  )
  await flow('search')
  await assert(
    `document.querySelector('#search-status').textContent.includes('Initial indexing') && !document.querySelector('#search').disabled`,
    'Cold search loading leaves input usable',
  )
  await run(
    `document.querySelector('#search').value='not submitted';document.querySelector('#search').dispatchEvent(new Event('input',{bubbles:true}))`,
  )
  await waitFor(
    `document.querySelector('#search-status').textContent.includes('3 results returned')`,
  )
  await assert(
    `['Title match','Description match','Body match','Company database collection'].every(s=>document.querySelector('#skill-list').textContent.includes(s))`,
    'Submitted results retain match reasons and external ownership',
  )
  await assert(
    `document.querySelector('#search').value==='not submitted' && document.querySelectorAll('[data-skill]').length===3`,
    'Typing during search does not retarget the submitted query',
  )
  await assert(
    `document.querySelector('#search-status').textContent.includes('for “deadlock”') && !document.querySelector('#search-status').textContent.includes('not submitted')`,
    'Result label identifies submitted text while the input holds an unsubmitted draft',
  )
  await run(
    `document.querySelector('#search').value='deadlock';document.querySelector('#search').dispatchEvent(new Event('input',{bubbles:true}))`,
  )
  await choose('#search-scope', 'personal')
  await click('#search-form button[type="submit"]')
  await waitFor(
    `document.querySelector('#search-status').textContent.includes('1 results returned')`,
  )
  await assert(
    `document.querySelector('#search-status').textContent.includes('workspace exposure unknown') && document.querySelector('.search-caption').textContent.includes('50,000')`,
    'Personal scope discloses exposure unknown and accepted-body coverage',
  )
  await click('#search-form button[type="submit"]')
  await click('[data-action="cancel-search"]')
  await assert(
    `!document.querySelector('#search-status').textContent.includes('Searching')`,
    'Submitted query has explicit cancellation',
  )
  await flow('search')
  await click('[data-rail="files"]')
  await run('studyTimers.search()')
  await assert(
    `!document.querySelector('#skills-view').hidden && !document.querySelector('#search-status').textContent.includes('results returned')`,
    'Leaving the sidebar cancels search publication while preserving a visible feature viewer',
  )
  await click('[data-viewer="history"]')
  await assert(
    `document.querySelector('#skills-view').hidden && !document.querySelector('#history-view').hidden`,
    'Late search cannot reopen departed viewer',
  )
  await flow('add')
  await choose('#add-destination', 'local-review')
  await choose('#add-mode', 'stub')
  await choose('#add-agent', 'claude')
  await click('[data-action="preview-add"]')
  await assert(
    `document.querySelector('#dialog').textContent.includes('/work/hvir-worktrees/database-review/.claude') && document.querySelector('#dialog').textContent.includes('Supporting instructions: none')`,
    'Preview names exact worktree/agent and supporting effects',
  )
  await click('[data-action="apply"]')
  await click('#workspace-nav')
  await assert(
    `document.querySelector('#skill-list').textContent.includes('incident-notes') && document.querySelector('#skill-list').textContent.includes('Stub')`,
    'Add applies only to selected workspace and agent',
  )
  await flow('switch')
  await click('[data-action="apply"]')
  await assert(
    `document.querySelector('#details').textContent.includes('Stub')`,
    'Explicit mode change changes the managed copy',
  )
  await flow('pending')
  await click('[data-action="apply"]')
  await assert(
    `document.querySelector('#details').textContent.includes('83fe091') && document.querySelector('#details').textContent.includes('Workspace copy behind')`,
    'Library acceptance retains the old workspace version',
  )
  await flow('update')
  await click('[data-action="apply"]')
  await assert(
    `document.querySelector('#details').textContent.includes('Current')`,
    'Explicit update advances the selected exposure',
  )
  await flow('remove')
  await click('[data-action="apply"]')
  await click('#workspace-nav')
  await assert(
    `!document.querySelector('[data-skill="pr-review"]')`,
    'Removal deletes the selected workspace exposure',
  )
  await click('#library-nav')
  await assert(
    `!!document.querySelector('[data-skill="pr-review"]')`,
    'Removal preserves library metadata',
  )
  for (const name of ['modified', 'pinned', 'unmanaged', 'blocked']) {
    await flow(name)
    await assert(
      `['switch','update','remove'].every(a=>document.querySelector('#details [data-action="'+a+'"]').disabled)`,
      `${name} target preserves ordinary replacement and removal protection`,
    )
  }
  await flow('unmanaged')
  await assert(
    `!document.querySelector('#details').textContent.includes('Exposed version') && !document.querySelector('#skill-list').textContent.includes('Full skill · Unmanaged') && document.querySelector('#details').textContent.includes('No recorded Skillager exposure')`,
    'Unmanaged presence has no recorded exposure mode or version',
  )
  await flow('blocked')
  await assert(
    `document.querySelector('#details').textContent.includes('Blocked by library policy') && document.querySelector('#details .pill').textContent==='Current' && document.querySelector('#details').textContent.includes('Exposed version')`,
    'Blocked policy belongs to the source; the actual existing exposure retains its own state',
  )
  for (const [selector, value] of [
    ['#destination', 'local-review'],
    ['#agent', 'claude'],
  ]) {
    await flow('update')
    await choose(selector, value)
    await assert(
      `!document.querySelector('#dialog').open && !document.querySelector('dialog[open] [data-action="apply"]')`,
      `Changing ${selector} through its existing control revokes the prepared dialog`,
    )
    await choose(selector, selector === '#destination' ? 'local-main' : 'codex')
    await assert(
      `document.querySelector('#details').textContent.includes('7da204b')`,
      'Selection revocation preserves the original workspace copy',
    )
  }
  await flow('stale')
  await click('[data-action="apply"]')
  await assert(
    `document.querySelector('#dialog-title').textContent.includes('out of date')`,
    'An actual source-version change after preview requires new review',
  )
  await flow('remote')
  await assert(
    `document.querySelector('#active-workspace').textContent.includes('SSH · build-host')`,
    'Ordinary workspace bar names the same active workspace as Skills observation and management',
  )
  await assert(
    `document.querySelector('#add-mode option[value="stub"]').disabled`,
    'Remote Stub is unavailable',
  )
  await click('[data-action="preview-add"]')
  await assert(
    `document.querySelector('#dialog').textContent.includes('Local · /home/example/.skillager/library') && document.querySelector('#dialog').textContent.includes('SSH · build-host') && document.querySelector('#dialog').textContent.includes('hvir checks this workspace') && document.querySelector('#dialog').textContent.includes('hvir’s deployment record for this workspace and agent') && !document.querySelector('#dialog').textContent.includes('skillager.materialized.yaml')`,
    'Remote preview names local source, remote destination and hvir deployment-record effects without a Skillager sidecar',
  )
  await click('[data-action="apply"]')
  await assert(
    `document.querySelector('#search-scope').value==='personal' && document.querySelector('#search-scope option[value="available"]').disabled`,
    'SSH defaults to personal scope and disables unsupported workspace search',
  )
  await flow('unavailable')
  await assert(
    `document.querySelector('#freshness').textContent.includes('Unavailable')`,
    'Freshness displays unavailable and last-check time',
  )
  const terminalState = await run(
    `JSON.stringify([document.querySelector('#terminal-pane').innerHTML,document.querySelector('.sessions').innerHTML,document.querySelector('#terminal-pane').getBoundingClientRect().toJSON(),document.querySelector('.sessions').getBoundingClientRect().toJSON()])`,
  )
  const staleFreshness = await run(`document.querySelector('#freshness').textContent`)
  const other = await call('Target.createTarget', { url: 'about:blank' })
  await call('Target.activateTarget', { targetId: other.targetId })
  const background = await run(
    `({visible: document.visibilityState==='visible', focused: document.hasFocus()})`,
  )
  if (!background.visible || !background.focused) {
    await run(
      `document.dispatchEvent(new Event('visibilitychange'));window.dispatchEvent(new Event('focus'))`,
    )
    await assert(
      `document.querySelector('#freshness').textContent===${JSON.stringify(staleFreshness)}`,
      'Background focus/visibility signals preserve freshness using actual browser background state',
    )
    await call('Page.bringToFront')
    await waitFor(
      `document.querySelector('#freshness').textContent.startsWith('Checked at')`,
    )
    await assert(
      `document.querySelector('#freshness').textContent.includes('Local · hvir / main')`,
      'Returning real browser focus refreshes only the selected workspace',
    )
  } else {
    limitations.push(
      'This headless Chromium did not expose background focus/visibility loss; that combination is covered only at the pure gate.',
    )
  }
  await call('Target.closeTarget', { targetId: other.targetId })
  await click('[data-viewer="history"]')
  await click('[data-rail="files"]')
  const hiddenFreshness = await run(`document.querySelector('#freshness').textContent`)
  await run(
    `document.dispatchEvent(new Event('visibilitychange'));window.dispatchEvent(new Event('focus'))`,
  )
  await assert(
    `document.querySelector('#freshness').textContent===${JSON.stringify(hiddenFreshness)}`,
    'Focus/visibility signals do not refresh while both feature surfaces are hidden',
  )
  await click('#skills-nav')
  await assert(
    `JSON.stringify([document.querySelector('#terminal-pane').innerHTML,document.querySelector('.sessions').innerHTML,document.querySelector('#terminal-pane').getBoundingClientRect().toJSON(),document.querySelector('.sessions').getBoundingClientRect().toJSON()])===${JSON.stringify(terminalState)}`,
    'Refresh events leave terminal/session content, attention and geometry unchanged',
  )
  await flow('missing')
  const terminalBeforeProbe = await run(
    `document.querySelector('#terminal-pane').innerHTML`,
  )
  await assert(
    `document.querySelector('#content').textContent.includes('Skillager wasn’t found.') && document.querySelector('#content code').textContent==='uv tool install skillager' && getComputedStyle(document.querySelector('#content code')).userSelect!=='none' && Array.from(document.querySelectorAll('#content button')).every(b=>b.textContent==='Check again')`,
    'Missing CLI provides selectable local-terminal guidance and only a probe action',
  )
  await click('#content [data-action="check-again"]')
  await assert(
    `document.querySelector('#content').textContent.includes('Skillager wasn’t found.') && !document.querySelector('[data-skill]') && studyTimers.intervals.size===0 && document.querySelector('#terminal-pane').innerHTML===${JSON.stringify(terminalBeforeProbe)}`,
    'Check again preserves a missing fixture without connecting, periodic demand or terminal injection',
  )
  await capture('missing-cli')
  await click('#settings')
  await assert(
    `document.querySelector('#dialog code').textContent==='uv tool install skillager' && !document.querySelector('#dialog').textContent.includes('Resolved executable') && !document.querySelector('#dialog').textContent.includes('0.9.0') && !document.querySelector('[data-action="connect"]')`,
    'Missing Settings does not invent a resolved executable or version',
  )
  await click('#dialog [data-action="check-again"]')
  await assert(
    `document.querySelector('#dialog').textContent.includes('Skillager wasn’t found.')`,
    'Settings Check again also preserves unavailable fixture state',
  )
  await click('#enabled')
  await assert(
    `!!document.querySelector('#enabled') && !document.querySelector('#dialog code') && !document.querySelector('[data-action="check-again"]')`,
    'Disabled Settings removes installation guidance and retains only the enable switch',
  )
  await flow('cli-available')
  await click('#settings')
  await click('#dialog [data-action="check-again"]')
  await assert(
    `document.querySelector('#dialog').textContent.includes('Resolved executable') && !document.querySelector('[data-action="connect"]').disabled && !document.querySelector('[data-skill]') && !document.querySelector('[data-viewer="skills"]') && studyTimers.intervals.size===0`,
    'An externally available CLI probe returns to explicit connection without auto-connect or reopening a feature viewer',
  )
  await click('[data-action="close"]')
  await assert(
    `document.querySelector('#content').textContent.includes('Connect Skillager')`,
    'Successful probe updates the enabled sidebar to the normal connection step',
  )
  await flow('empty')
  await assert(
    `document.querySelector('#first-skill-prompt').readOnly && document.querySelector('#first-skill-prompt').value.includes('Leave it pending')`,
    'Observed empty personal library provides selectable guidance leaving the draft pending',
  )
  await click('#workspace-nav')
  await assert(
    `!document.querySelector('#first-skill-prompt') && document.querySelector('#content').textContent.includes('No skills added to this workspace')`,
    'An empty workspace keeps its own state instead of personal-library onboarding',
  )
  await flow('setup')
  await assert(
    `document.querySelector('#library-location').readOnly && document.querySelector('#library-location').value==='/home/example/.skillager/library' && document.querySelector('#library-git').checked && !document.querySelector('.connection-details').open && !document.querySelector('[data-skill]') && studyTimers.intervals.size===0`,
    'Missing library shows the local default, explicit Git default and setup before diagnostics without connection',
  )
  await capture('onboarding')
  const beforeSetup = await run(
    `JSON.stringify([document.querySelector('#terminal-pane').innerHTML,document.querySelector('.sessions').innerHTML])`,
  )
  await pointClick('[data-action="choose-folder"]')
  await choose('#sample-folder', '/home/example/Documents/my-skills')
  await pointClick('#dialog [data-action="close"]')
  await assert(
    `document.querySelector('#library-location').value==='/home/example/.skillager/library' && !document.querySelector('[data-action="cancel-setup"]')`,
    'Canceling the sample folder picker preserves the original target without starting initialization',
  )
  await pointClick('[data-action="choose-folder"]')
  await choose('#sample-folder', '/home/example/Documents/my-skills')
  await pointClick('[data-action="use-folder"]')
  await pointClick('#library-git')
  await assert(
    `document.querySelector('#library-location').value==='/home/example/Documents/my-skills' && !document.querySelector('#library-git').checked`,
    'Folder choice keeps the exact selected path and no-Git requires an explicit user choice',
  )
  await pointClick('#library-setup button[type="submit"]')
  await assert(
    `document.querySelector('.library-setup').textContent.includes('Creating your personal library') && document.querySelector('.library-setup').textContent.includes('Git history: disabled') && !document.querySelector('[data-action="connect"]') && studyTimers.intervals.size===0`,
    'Create and connect presents the selected path and Git mode as pending without premature metadata connection',
  )
  await waitFor(`!!document.querySelector('#first-skill-prompt')`)
  await assert(
    `document.querySelector('#first-skill-prompt').value.includes('/home/example/Documents/my-skills') && document.querySelector('#content').textContent.includes('Your personal library is ready') && document.querySelector('#content').textContent.includes('Git history: disabled') && !document.querySelector('[data-action="connect"]') && !document.querySelector('[data-viewer="skills"]') && JSON.stringify([document.querySelector('#terminal-pane').innerHTML,document.querySelector('.sessions').innerHTML])===${JSON.stringify(beforeSetup)}`,
    'Verified sample setup opens first-skill guidance directly without terminal input, approval or a body viewer',
  )
  await capture('onboarding-ready')
  await flow('setup-remote')
  await pointClick('#library-setup button[type="submit"]')
  await waitFor(`!!document.querySelector('#first-skill-prompt')`)
  await assert(
    `document.querySelector('#active-workspace').textContent.includes('SSH') && document.querySelector('#first-skill-prompt').value.includes('/home/example/.skillager/library') && document.querySelector('#content').textContent.includes('Git history: enabled')`,
    'Default Git setup beside an SSH workspace still names the local personal-library target',
  )
  await flow('setup-git-mismatch')
  await pointClick('#library-setup button[type="submit"]')
  await waitFor(`!!document.querySelector('#content [data-action="connect"]')`)
  await assert(
    `document.querySelector('#content').textContent.includes('different Git history setting') && document.querySelector('#content').textContent.includes('Git history: disabled') && !document.querySelector('#first-skill-prompt') && studyTimers.intervals.size===0`,
    'Existing Git-mode mismatch shows the actual mode and requires explicit connection',
  )
  await pointClick('#content [data-action="connect"]')
  await assert(
    `!!document.querySelector('#first-skill-prompt')`,
    'Explicit connection after a mode mismatch enters the observed empty library',
  )
  await flow('setup-error')
  await pointClick('#library-setup button[type="submit"]')
  await waitFor(`!!document.querySelector('[data-action="check-setup"]')`)
  await assert(
    `document.querySelector('#content').textContent.includes('Git initialization failed: permission denied') && document.querySelector('#content').textContent.includes('may have been created') && !document.querySelector('#library-setup') && studyTimers.intervals.size===0`,
    'Git failure reports actual error and possible effects without no-Git fallback or blind retry',
  )
  await pointClick('[data-action="check-setup"]')
  await assert(
    `document.querySelector('#library-git').checked && document.querySelector('#content').textContent.includes('No registered library was found')`,
    'Explicit absent-status reconciliation retains the Git choice and discloses potentially retained files',
  )
  await flow('setup-status-unavailable')
  await pointClick('#library-setup button[type="submit"]')
  await pointClick('[data-action="cancel-setup"]')
  await pointClick('[data-action="check-setup"]')
  await assert(
    `document.querySelector('#content').textContent.includes('status is unavailable') && !document.querySelector('#library-setup') && !document.querySelector('[data-action="connect"]') && studyTimers.intervals.size===0`,
    'Unavailable reconciliation retains uncertainty and cannot enable another initialization',
  )
  await flow('setup')
  await pointClick('#library-setup button[type="submit"]')
  await click('#settings')
  await click('#enabled')
  await click('[data-action="close"]')
  await run('studyTimers.setup()')
  await assert(
    absent,
    'Disable during setup removes all feature surfaces and rejects the actual late completion',
  )
  await click('#settings')
  await click('#enabled')
  await click('[data-action="show-setup"]')
  await run('studyTimers.setup()')
  await assert(
    `!!document.querySelector('[data-action="check-setup"]') && !document.querySelector('#library-setup') && !document.querySelector('#first-skill-prompt') && studyTimers.intervals.size===0`,
    'Re-enable preserves uncertain setup without reconnecting, restarting initialization or accepting late completion',
  )
  await pointClick('[data-action="check-setup"]')
  await assert(
    `document.querySelector('#content').textContent.includes('Library found') && document.querySelector('#content').textContent.includes('Git history: enabled') && !!document.querySelector('[data-action="connect"]') && !document.querySelector('#first-skill-prompt')`,
    'Found-status reconciliation displays actual library details for a fresh explicit connection',
  )
  await flow('search')
  await run(
    `document.querySelector('#search').value='no-match-first-skill';document.querySelector('#search-form').requestSubmit()`,
  )
  await waitFor(
    `document.querySelector('#search-status').textContent.includes('0 results returned')`,
  )
  await assert(
    `!document.querySelector('#first-skill-prompt')`,
    'No-match submitted search is not treated as an empty personal inventory',
  )
  await flow('unavailable')
  await assert(
    `!document.querySelector('#first-skill-prompt') && document.querySelector('#freshness').textContent.includes('Unavailable')`,
    'Unavailable observation retains its own state without onboarding',
  )
  await flow('browse')
  await click('#settings')
  await click('[data-action="change-library"]')
  await assert(
    `!document.querySelector('[data-skill]') && !document.querySelector('[data-action="connect"]').disabled`,
    'Changing library identity/location revokes metadata and requires reconnecting',
  )
  await click('[data-action="connect"]')
  await click('#skills-nav')
  await click('[data-select="migration-review"]')
  await click('#details [data-action="read"]')
  await assert(
    `document.querySelector('#skills-view').textContent.includes('/library-new/skills/migration-review')`,
    'Reconnected content review names the selected library location',
  )
  await click('[data-action="metadata"]')
  await click('[data-select="deploy-checklist"]')
  await click('#details [data-action="accept"]')
  await assert(
    `document.querySelector('#dialog').textContent.includes('/library-new/skills/deploy-checklist')`,
    'Reconnected library acceptance names the same selected source',
  )
  await click('[data-action="close"]')
  await click('[data-select="incident-notes"]')
  await click('#details [data-action="add"]')
  await click('[data-action="preview-add"]')
  await assert(
    `document.querySelector('#dialog').textContent.includes('/library-new/skills/incident-notes')`,
    'Reconnected exposure preview names the same selected source',
  )
  await click('[data-action="close"]')
  await click('#settings')
  await click('#enabled')
  await click('[data-action="close"]')
  await assert(
    absent,
    'Disabling removes feature content and revokes the library connection',
  )
  await flow('search')
  await click('[data-viewer="history"]')
  await click('#settings')
  await click('#enabled')
  await click('[data-action="close"]')
  await run(
    `studyTimers.search();document.dispatchEvent(new KeyboardEvent('keydown',{key:'/',bubbles:true}));document.dispatchEvent(new Event('visibilitychange'));window.dispatchEvent(new Event('focus'))`,
  )
  await assert(
    absent +
      ` && !document.querySelector('#files-rail').hidden && !document.querySelector('#history-view').hidden && document.querySelector('#toast').hidden`,
    'Disable during search rejects its actual late callback and shortcut/focus events, preserving the ordinary viewer',
  )
  await capture('disabled-after-search')
  await click('#settings')
  await click('#enabled')
  await click('[data-action="close"]')
  await run('studyTimers.search()')
  await assert(
    `!document.querySelector('[data-viewer="skills"]') && !document.querySelector('#history-view').hidden && !document.querySelector('[data-skill]') && studyTimers.intervals.size===0`,
    'Re-enable does not reconnect, reopen prior content, or accept old search publication',
  )
  await click('#settings')
  await click('[data-action="connect"]')
  await click('#skills-nav')
  await run('studyTimers.search()')
  await assert(
    `document.querySelectorAll('[data-skill]').length===6 && !document.querySelector('#search-status').textContent.includes('results returned') && !document.querySelector('[data-viewer="skills"]')`,
    'A fresh connection also rejects the prior generation search callback',
  )
  await flow('update')
  await click('#settings')
  await click('#enabled')
  await click('[data-action="close"]')
  await assert(
    absent +
      ` && !document.querySelector('#dialog').open && document.querySelector('#dialog').innerHTML==='' && document.querySelector('#toast').textContent===''`,
    'Disable during a prepared mutation removes the preview and notification content',
  )
  await flow('add')
  await click('[data-action="preview-add"]')
  await click('[data-action="apply"]')
  await assert(
    `!document.querySelector('#toast').hidden`,
    'A completed sample action publishes its feature notification',
  )
  await click('#settings')
  await click('#enabled')
  await click('[data-action="close"]')
  await assert(
    absent +
      ` && document.querySelector('#toast').hidden && document.querySelector('#toast').textContent===''`,
    'Disable clears a visible feature notification',
  )
  await flow('browse')
  await call('Emulation.setDeviceMetricsOverride', {
    width: 900,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await assert(
    `document.documentElement.scrollWidth<=900`,
    'Compact viewport has no horizontal document overflow',
  )
  await assert(
    `(()=>{const rows=Array.from(document.querySelectorAll('#skill-list [data-skill]')).slice(0,2);return rows.length===2 && rows.every(row=>{const bounds=row.getBoundingClientRect(),rail=document.querySelector('#skills-rail').getBoundingClientRect();return bounds.top>=rail.top && bounds.bottom<=rail.bottom})})()`,
    'Compact sidebar keeps its first two metadata rows visible without scrolling',
  )
  const screenshot = await call('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(root, 'compact.png'), Buffer.from(screenshot.data, 'base64'))
  const html = await readFile(join(root, 'index.html'), 'utf8')
  await writeFile(
    join(root, 'sandbox.html'),
    `<!doctype html><iframe style="width:100vw;height:100vh" sandbox="allow-scripts" srcdoc="${html.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}"></iframe>`,
  )
  await call('Page.navigate', { url: pathToFileURL(join(root, 'sandbox.html')).href })
  await waitFor(`document.readyState==='complete' && !!document.querySelector('iframe')`)
  const targets = await call('Target.getTargets')
  const child = targets.targetInfos.find((target) => target.type === 'iframe')
  let contextId, sessionId
  if (child) {
    const attached = await call('Target.attachToTarget', {
      targetId: child.targetId,
      flatten: true,
    })
    sessionId = attached.sessionId
  } else {
    const tree = await call('Page.getFrameTree')
    const world = await call('Page.createIsolatedWorld', {
      frameId: tree.frameTree.childFrames[0].frame.id,
      worldName: 'study-proof',
    })
    contextId = world.executionContextId
  }
  const proof = await call(
    'Runtime.evaluate',
    {
      expression: `!!document.querySelector('#document-view') && !document.querySelector('#document-view').hidden && !document.querySelector('#skills-nav')`,
      ...(contextId ? { contextId } : {}),
      returnByValue: true,
    },
    sessionId,
  )
  if (!proof.result.value) throw new Error('Opaque sandbox failed to render')
  checks.push('Self-contained artifact renders inside opaque allow-scripts sandbox')
  if (errors.length) throw new Error(errors.join(', '))
  const result = {
    checks,
    errors,
    limitations,
    scope: 'Synthetic standalone study only; no hvir, CLI or SSH execution.',
  }
  await writeFile(join(root, 'validation.json'), JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result, null, 2))
} finally {
  clearTimeout(deadline)
  socket?.close()
  try {
    if (
      !childClosed &&
      chrome.pid &&
      chrome.exitCode === null &&
      chrome.signalCode === null
    )
      chrome.kill()
    if (!(await waitForClose(2000))) {
      chrome.kill('SIGKILL')
      if (!(await waitForClose(2000))) {
        process.exitCode = 1
        console.error('Browser close was not observed after bounded termination.')
      }
    }
  } finally {
    await rm(profile, { recursive: true, force: true })
  }
}
