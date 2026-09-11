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
let socket
const errors = [],
  checks = []
const deadline = setTimeout(() => chrome.kill(), 45_000)
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
  await call('Page.navigate', { url: pathToFileURL(join(root, 'index.html')).href })
  await waitFor(
    `document.querySelector('#content')?.textContent.includes('Connect Skillager')`,
  )
  await assert(
    `!document.querySelector('[data-skill]')`,
    'Integration defaults off without metadata rows',
  )
  await click('#settings')
  await click('#enabled')
  await assert(
    `document.querySelector('#dialog').textContent.includes('/home/example/.local/bin/skillager') && document.querySelector('#dialog').textContent.includes('/home/example/.skillager/library')`,
    'Connection displays exact local executable and library',
  )
  await click('[data-action="connect"]')
  await assert(
    `document.querySelectorAll('[data-skill]').length===6`,
    'Explicit connection reveals metadata including pending drafts',
  )
  const terminal = await run(
    `JSON.stringify(document.querySelector('#terminal-pane').getBoundingClientRect().toJSON())`,
  )
  await click('[data-viewer="history"]')
  await click('#close-skills')
  await click('#skills-nav')
  await assert(
    `JSON.stringify(document.querySelector('#terminal-pane').getBoundingClientRect().toJSON())===${JSON.stringify(terminal)} && !document.querySelector('#skills-view').hidden`,
    'Switching, closing and reopening viewer tabs preserves terminal geometry',
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
  await click('[data-viewer="history"]')
  await run('new Promise(resolve=>setTimeout(resolve,600))')
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
  await flow('stale')
  await click('[data-action="apply"]')
  await assert(
    `document.querySelector('#dialog-title').textContent.includes('out of date')`,
    'Changed source/target preview requires new review',
  )
  await flow('remote')
  await assert(
    `document.querySelector('#add-mode option[value="stub"]').disabled`,
    'Remote Stub is unavailable',
  )
  await click('[data-action="preview-add"]')
  await assert(
    `document.querySelector('#dialog').textContent.includes('Local · /home/example/.skillager/library') && document.querySelector('#dialog').textContent.includes('SSH · build-host') && document.querySelector('#dialog').textContent.includes('Stage and verify')`,
    'Remote preview names local source, remote destination and verified staging',
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
  await flow('missing')
  await assert(
    `document.querySelector('#content').textContent.includes('Skillager unavailable')`,
    'Missing CLI is distinct from empty library',
  )
  await flow('empty')
  await assert(
    `document.querySelector('#content').textContent.includes('one useful skill')`,
    'Empty library has its own state',
  )
  await flow('browse')
  await click('#settings')
  await click('[data-action="change-library"]')
  await assert(
    `!document.querySelector('[data-skill]') && !document.querySelector('[data-action="connect"]').disabled`,
    'Changing library identity/location revokes metadata and requires reconnecting',
  )
  await click('#enabled')
  await click('[data-action="close"]')
  await assert(
    `document.querySelector('#connection-label').textContent==='Skillager disabled'`,
    'Disabling revokes the library connection',
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
      expression: `document.querySelector('#content')?.textContent.includes('Connect Skillager')`,
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
    scope: 'Synthetic standalone study only; no hvir, CLI or SSH execution.',
  }
  await writeFile(join(root, 'validation.json'), JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result, null, 2))
} finally {
  clearTimeout(deadline)
  socket?.close()
  chrome.kill()
  await new Promise((resolve) =>
    chrome.exitCode !== null ? resolve() : chrome.once('exit', resolve),
  )
  await rm(profile, { recursive: true, force: true })
}
