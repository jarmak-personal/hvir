import { extensionSettingsControls } from './extension-settings-controls'
import { app, type BrowserWindow, type WebContents } from 'electron'
import { joinHostPath, type HostPath } from '../../shared/host-path'
import type { ExtensionManifest } from '../../shared/extensions/contract'
import { validateExtensionManifest } from '../../shared/extensions/manifest'
import type { ExtensionView } from '../../shared/extensions/workbench'
import type { ProjectHost } from '../project-host/project-host'
import type { RendererResourceScopes } from '../renderer-resource-scopes'
import type { ExtensionApplicationRuntime } from '../extensions/extension-application'
import { verifyExtensionRailGeometry } from './extension-presentation-geometry'
import { focusSmokeWindow } from './window-focus'

interface ContributionControls {
  click(name: string): Promise<void>
  wait(predicate: () => boolean | Promise<boolean>, label: string): Promise<void>
  guest(view: ExtensionView): Promise<WebContents>
}

/** The earlier security/package scenario selects only ordinary viewer declarations. */
export async function prepareExtensionViewerFixture(
  host: ProjectHost,
  directory: HostPath,
): Promise<void> {
  const path = joinHostPath(directory, 'hvir-extension.json')
  const manifest = JSON.parse(
    (await host.readFile(path)).toString('utf8'),
  ) as ExtensionManifest
  const fixture = {
    ...manifest,
    views: manifest.views.filter((view) => ['reference', 'detail'].includes(view.id)),
    requiredCapabilities: ['presentation.read', 'viewer.open-own'],
  }
  delete fixture.updater
  delete fixture.railItems
  delete fixture.actions
  await host.writeFile(path, JSON.stringify(fixture))
}

/** Ordinary reference package, Settings, live terminal rows and native guest lifecycle. */
export async function verifyExtensionContributions(
  win: BrowserWindow,
  extensions: ExtensionApplicationRuntime,
  scopes: RendererResourceScopes,
  host: ProjectHost,
  source: HostPath,
  controls: ContributionControls,
): Promise<void> {
  const activation = extensions.activations!,
    guests = extensions.guests!
  const renderer = scopes.currentOwner(win.webContents.id)
  const directory = joinHostPath(activation.directory, 'contributions')
  await host.createDirectoryExclusive(directory, { mode: 0o755 })
  for (const entry of await host.readdir(source))
    await host.writeFile(
      joinHostPath(directory, entry.name),
      await host.readFile(joinHostPath(source, entry.name)),
    )
  const manifestPath = joinHostPath(directory, 'hvir-extension.json')
  const fullManifest = await host.readFile(manifestPath)
  const staticManifest = {
    ...(JSON.parse(fullManifest.toString('utf8')) as ExtensionManifest),
  }
  const header = staticManifest.railItems!.find((item) => item.placement === 'header')!
  staticManifest.railItems = [
    ...staticManifest.railItems!,
    ...Array.from({ length: 6 }, (_, index) => ({
      ...header,
      id: `bounded-header-${index}`,
      label: `Bounded header action ${index}`,
    })),
  ]
  delete staticManifest.updater
  validateExtensionManifest(staticManifest)
  await host.writeFile(manifestPath, JSON.stringify(staticManifest))
  await controls.click('Discover extensions')
  await controls.wait(
    () =>
      activation
        .snapshot()
        .installations.some((entry) => entry.source === 'contributions'),
    'contributions discovery',
  )
  await extensionSettingsControls(win, staticManifest.name, {
    wait: (predicate, label) => controls.wait(predicate, label),
    within: (work) => work,
  }).select()
  await controls.click('Enable')
  await controls.wait(() => activation.active.size === 1, 'contributions Enable')
  const installationId = [...activation.active.keys()][0]!
  await controls.click('Close settings')
  const focusTarget = (await win.webContents.executeJavaScript(
    "(() => { const bounds = document.querySelector('.project-tab-main').getBoundingClientRect(); return {x:bounds.x+bounds.width/2,y:bounds.y+bounds.height/2}; })()",
  )) as { x: number; y: number }
  win.webContents.sendInputEvent({
    type: 'mouseDown',
    x: Math.round(focusTarget.x),
    y: Math.round(focusTarget.y),
    button: 'left',
    clickCount: 1,
  })
  win.webContents.sendInputEvent({
    type: 'mouseUp',
    x: Math.round(focusTarget.x),
    y: Math.round(focusTarget.y),
    button: 'left',
    clickCount: 1,
  })
  console.log(
    '[smoke] contribution host focus after native teardown',
    JSON.stringify({
      window: win.isFocused(),
      visible: win.isVisible(),
      minimized: win.isMinimized(),
      focusable: win.isFocusable(),
      document: (await win.webContents.executeJavaScript(
        'document.hasFocus()',
      )) as boolean,
    }),
  )
  await focusSmokeWindow(win)
  await controls.wait(
    () => dom("document.querySelector('.extension-terminal-items button') !== null"),
    'static header item without guest',
  )
  if (guests.snapshot(renderer).length)
    throw new Error('Static contribution started a guest')
  await launchShell()
  await launchShell()
  await controls.wait(
    () => extensions.contexts!.sessions(renderer).length === 2,
    'two exact live sessions without Sessions destination',
  )
  const sessions = extensions.contexts!.sessions(renderer)
  await controls.wait(
    () =>
      dom(
        "document.querySelectorAll('.terminal-list-row .extension-terminal-items button').length === 2",
      ),
    'static session row controls',
  )
  if (guests.snapshot(renderer).length)
    throw new Error('Static session controls started a guest')
  console.log(
    '[smoke] static extension controls and two live Shell rows without guests OK',
  )
  await verifyExtensionRailGeometry(
    win,
    (predicate, label) => controls.wait(predicate, label),
    7,
  )

  await host.writeFile(manifestPath, fullManifest)
  await settings()
  await controls.click('Reload')
  await controls.click('Close settings')
  try {
    await controls.wait(
      () =>
        guests.snapshot(renderer).filter((view) => view.role === 'updater').length === 1,
      'one updater for visible rows',
    )
  } catch (error) {
    let sample: unknown
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      sample = await Promise.race([
        win.webContents.executeJavaScript(`(() => ({
          settingsOpen:!!document.querySelector('.settings-dialog'),
          workbenchHidden:document.querySelector('main.workbench')?.hidden ?? null,
          topDestinationVisible:document.querySelector('.extension-top-destination')?.hidden === false,
          headerItems:document.querySelectorAll('.terminal-header-actions .extension-terminal-items button').length,
          sessionItems:document.querySelectorAll('.terminal-list-row .extension-terminal-items button').length,
          focused:document.hasFocus()
        }))()`),
        new Promise((resolve) => {
          timeout = setTimeout(() => resolve({ deadline: true }), 1000)
        }),
      ])
    } catch {
      sample = { unavailable: true }
    } finally {
      clearTimeout(timeout)
    }
    const platform = activation.snapshot()
    const installation = platform.installations.find(
      (entry) => entry.installationId === installationId,
    )
    const contribution = extensions
      .contributions!.snapshot()
      .find((entry) => entry.installationId === installationId)
    console.log(
      '[smoke] first contribution updater evidence',
      JSON.stringify({
        sample,
        writable: platform.writable,
        installationPresent: !!installation,
        enabled: installation?.enabled,
        updaterDeclared: !!installation?.manifest?.updater,
        contributionPresent: !!contribution,
        contributionUpdaterDeclared: !!contribution?.manifest.updater,
        contributionError: !!contribution?.error,
        demandRevoked: contribution?.error === 'Updater demand was revoked',
        sessionCount: extensions.contexts!.sessions(renderer).length,
        views: guests
          .snapshot(renderer)
          .filter((view) => view.installationId === installationId)
          .slice(0, 8)
          .map((view) => ({ role: view.role, failed: !!view.failure })),
      }).slice(0, 1500),
    )
    throw error
  }
  const updater = guests.snapshot(renderer).find((view) => view.role === 'updater')!
  const updaterGuest = await controls.guest(updater)
  await controls.wait(
    () => observation()?.availability === 'current',
    'visible header observation without popup',
  )
  if (guests.snapshot(renderer).some((view) => view.context?.surface === 'popup'))
    throw new Error('Header demand needed a popup')
  const firstObserved = observation()!.observedAt!
  await controls.wait(
    () => (observation()?.observedAt ?? 0) > firstObserved,
    'ongoing visible item observation',
  )

  // Compact presentation ends the last demand; data becomes stale and native timers pause.
  await controls.click('Collapse terminal rail')
  await controls.wait(
    () => observation()?.availability === 'stale',
    'compact observation stale',
  )
  await new Promise((resolve) => setTimeout(resolve, 1200))
  const frozen = observation()!.observedAt
  await new Promise((resolve) => setTimeout(resolve, 2200))
  if (observation()!.observedAt !== frozen)
    throw new Error('No-demand updater continued publishing')
  await controls.click('Restore terminal rail')
  await controls.wait(
    () =>
      observation()?.availability === 'current' && observation()!.observedAt! > frozen!,
    'current observation renewed after restore',
  )
  if (guests.snapshot(renderer).filter((view) => view.role === 'updater').length !== 1)
    throw new Error('Restore duplicated updater')

  console.log('[smoke] shared visible updater pause/renew OK')
  await controls.click('Reference workspace')
  await controls.wait(
    () => guests.snapshot(renderer).some((view) => view.context?.surface === 'left'),
    'left workspace placement',
  )
  const left = guests.snapshot(renderer).find((view) => view.context?.surface === 'left')!
  const leftGuest = await controls.guest(left)
  await connected(leftGuest)
  await subscribed(leftGuest, 'left')
  await controls.click('Project views')
  await controls.wait(
    () => dom(`document.querySelector('[data-extension-view="${left.id}"]').hidden`),
    'left builtin selection hides guest',
  )
  await controls.click('Reference workspace')
  if (
    guests.snapshot(renderer).find((view) => view.context?.surface === 'left')?.id !==
      left.id ||
    leftGuest.isDestroyed()
  )
    throw new Error('Left selection orphaned guest')
  await controls.click('Close Reference workspace')
  await controls.wait(() => leftGuest.isDestroyed(), 'left explicit native close')

  console.log('[smoke] left workspace selection/hide/reopen/close OK')
  await controls.click('Reference library')
  await controls.wait(
    () =>
      dom(
        "document.querySelector('.extension-top-destination')?.hidden === false && document.querySelector('main.workbench')?.hidden === true",
      ),
    'controlled top destination',
  )
  if (
    !(await dom(
      "document.querySelectorAll('.projects-bar [aria-current=page]').length === 1 && document.querySelector('.project-tab-main')?.getAttribute('aria-current') !== 'page'",
    ))
  )
    throw new Error('Top destination retained builtin current-page selection')
  const top = guests.snapshot(renderer).find((view) => view.context?.surface === 'top')!
  const topGuest = await controls.guest(top)
  await connected(topGuest)
  await subscribed(topGuest, 'top')
  const topContext = (await request(topGuest, 'top-context', 'context.read')) as {
    workspace?: unknown
    sessions?: unknown[]
  }
  if (topContext.workspace || topContext.sessions?.length)
    throw new Error('Independent top destination received terminal context')
  await controls.click('Sessions')
  await controls.wait(
    () => dom("document.querySelector('.extension-top-destination').hidden"),
    'Sessions governs extension destination visibility',
  )
  if (topGuest.isDestroyed()) throw new Error('Top navigation orphaned guest')
  await controls.click('Reference library')
  await controls.wait(
    () =>
      dom(
        "document.querySelector('.extension-top-destination')?.hidden === false && document.querySelector('main.workbench')?.hidden === true",
      ),
    'reopened controlled top destination',
  )
  await controls.click('Close Reference library')
  await controls.wait(
    () =>
      topGuest.isDestroyed() &&
      dom("document.querySelector('.extension-top-destination').hidden"),
    'top close returns builtin destination',
  )

  // The popup is a native guest, but its focus never activates the terminal row.
  await controls.wait(
    () =>
      dom(
        "document.querySelectorAll('.terminal-list-row .extension-terminal-items button').length === 2",
      ),
    'rows restored after top navigation',
  )
  console.log('[smoke] controlled top destination navigation/close OK')
  const terminalIds = extensions.contexts!.terminalIds(renderer)
  const bell = (await win.webContents.executeJavaScript(
    `(() => { try { window.hvir.send('pty:write', {id:${JSON.stringify(terminalIds[sessions[0]!.id])},data:${JSON.stringify("printf '\\007'\r")}}); return {ok:true}; } catch (error) { return {ok:false,error:String(error),stack:String(error.stack)}; } })()`,
  )) as { ok: boolean; error?: string; stack?: string }
  if (!bell.ok)
    throw new Error(`Inactive terminal bell send failed: ${bell.error}`, {
      cause: bell.stack,
    })
  await controls.wait(
    () =>
      dom(
        "document.querySelector('.terminal-list-row .terminal-attention-badge.bell') !== null",
      ),
    'positive inactive-terminal bell',
  )
  console.log('[smoke] inactive terminal positive bell control OK')
  const attentionExpression =
    "[...document.querySelectorAll('.terminal-list-row')].map(row => ({id:row.querySelector('.terminal-list-main').dataset.terminalSession,active:row.classList.contains('active'),attention:row.querySelector('.terminal-attention-badge')?.getAttribute('aria-label') ?? null}))"
  const attention = (await win.webContents.executeJavaScript(
    attentionExpression,
  )) as unknown
  await win.webContents.executeJavaScript(
    "document.querySelector('.terminal-list-row .extension-terminal-items button').click()",
  )
  await controls.wait(
    () => guests.snapshot(renderer).some((view) => view.context?.surface === 'popup'),
    'session popup guest',
  )
  const popup = guests
    .snapshot(renderer)
    .find((view) => view.context?.surface === 'popup')!
  const popupGuest = await controls.guest(popup)
  console.log('[smoke] popup guest attached')
  await connected(popupGuest)
  await subscribed(popupGuest, 'popup')
  console.log('[smoke] popup guest negotiated')
  const context = (await request(popupGuest, 'session-context', 'context.read')) as {
    session?: { id: string }
  }
  console.log('[smoke] popup context read completed')
  if (!sessions.some((session) => session.id === context.session?.id))
    throw new Error('Popup lacks exact live session context')
  await popupGuest.executeJavaScript("document.getElementById('mark-session').click()")
  await controls.wait(
    () =>
      extensions
        .contributions!.snapshot()
        .some((extension) =>
          extension.values.some(
            (value) => value.session === context.session!.id && value.label === 'Marked',
          ),
        ),
    'exact session item published',
  )
  console.log('[smoke] exact session publication OK')
  app.focus({ steal: true })
  win.focus()
  await win.webContents.executeJavaScript(
    `document.querySelector('[data-extension-view="${popup.id}"] webview').focus()`,
  )
  popupGuest.focus()
  console.log(
    '[smoke] popup focus admission',
    JSON.stringify({
      window: win.isFocused(),
      guest: popupGuest.isFocused(),
      guestDocument: (await popupGuest.executeJavaScript(
        'document.hasFocus()',
      )) as boolean,
      parent: (await win.webContents.executeJavaScript('document.hasFocus()')) as boolean,
    }),
  )
  await controls.wait(
    async () =>
      !popupGuest.isDestroyed() &&
      Boolean(await popupGuest.executeJavaScript('document.hasFocus()')),
    'actual native popup document keyboard focus',
  )
  const popupFocus = (await win.webContents.executeJavaScript(
    '({focused:document.hasFocus(),visibility:document.visibilityState,items:document.querySelectorAll(".terminal-list-row .extension-terminal-items button").length})',
  )) as { focused: boolean; visibility: string; items: number }
  console.log(
    '[smoke] popup native foreground',
    JSON.stringify({
      window: win.isFocused(),
      guest: popupGuest.isFocused(),
      parent: popupFocus,
    }),
  )
  popupGuest.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
  popupGuest.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
  await controls.wait(
    () =>
      popupGuest.isDestroyed() && dom("!document.querySelector('.extension-item-popup')"),
    'native guest Escape dismisses popup',
  )
  console.log('[smoke] native popup Escape disposal OK')
  await controls.wait(
    () =>
      dom(
        "document.hasFocus() && document.querySelectorAll('.terminal-list-row .extension-terminal-items button').length === 2",
      ),
    'popup Escape restores native host focus and visible items',
  )
  if (
    !(await dom("document.activeElement?.closest('.extension-terminal-items') !== null"))
  )
    throw new Error('Popup Escape did not return focus to its item')
  console.log('[smoke] popup focus returned to its item')
  const afterAttention = (await win.webContents.executeJavaScript(
    attentionExpression,
  )) as unknown
  if (JSON.stringify(attention) !== JSON.stringify(afterAttention))
    throw new Error('Popup focus changed terminal attention')
  console.log('[smoke] popup preserved inactive bell and active terminal selection')
  await controls.wait(
    () =>
      dom(
        "document.querySelector('.terminal-list-row .extension-terminal-items button') !== null",
      ),
    'current popup item before reopen',
  )
  await win.webContents.executeJavaScript(
    "document.querySelector('.terminal-list-row .extension-terminal-items button').click()",
  )
  await controls.wait(
    () => guests.snapshot(renderer).some((view) => view.context?.surface === 'popup'),
    'popup reopen',
  )
  console.log('[smoke] popup reopened with current guest')
  const reopened = guests
    .snapshot(renderer)
    .find((view) => view.context?.surface === 'popup')!
  if (reopened.id === popup.id) throw new Error('Popup close reused revoked guest')
  await controls.click('Close Reference session')
  await controls.wait(
    () => !guests.snapshot(renderer).some((view) => view.context?.surface === 'popup'),
    'popup ordinary close',
  )

  console.log('[smoke] popup reopen/ordinary close OK')
  await win.webContents.executeJavaScript(
    "document.querySelector('.terminal-list-row .extension-terminal-items button').click()",
  )
  await controls.wait(
    () => guests.snapshot(renderer).some((view) => view.context?.surface === 'popup'),
    'outside-dismiss popup',
  )
  const outside = guests
    .snapshot(renderer)
    .find((view) => view.context?.surface === 'popup')!
  const outsideGuest = await controls.guest(outside)
  await connected(outsideGuest)
  await win.webContents.executeJavaScript(
    "document.querySelector('main.workbench').dispatchEvent(new PointerEvent('pointerdown', {bubbles:true}))",
  )
  await controls.wait(
    () =>
      outsideGuest.isDestroyed() &&
      dom("!document.querySelector('.extension-item-popup')"),
    'ordinary outside pointer dismissal',
  )

  // Settings is an ordinary activation route even when the terminal rail is compact.
  await controls.click('Collapse terminal rail')
  await settings()
  await controls.wait(
    () =>
      dom('document.querySelector(\'[aria-label="Extension action context"]\') !== null'),
    'ordinary Settings action context control',
  )
  await win.webContents.executeJavaScript(
    `(() => { const select = document.querySelector('[aria-label="Extension action context"]'); select.value = ${JSON.stringify(sessions[0]!.id)}; select.dispatchEvent(new Event('change', { bubbles: true })); select.focus(); })()`,
  )
  if (
    !(await dom(
      "document.hasFocus() && document.activeElement?.getAttribute('aria-label') === 'Extension action context'",
    ))
  )
    throw new Error('Settings action focus positive control failed')
  console.log('[smoke] Settings exact action target selected')
  await actionFocus('before-invocation')
  await controls.click('Run Describe session')
  console.log('[smoke] Settings action control invoked')
  await controls.wait(
    () => guests.snapshot(renderer).some((view) => view.contributionId === 'detail'),
    'named action detail admitted',
  )
  const detail = guests
    .snapshot(renderer)
    .find((view) => view.contributionId === 'detail')!
  const detailGuest = await controls.guest(detail)
  await actionFocus('native-attached', detailGuest)
  await controls.wait(
    () =>
      dom(
        "document.querySelector('.extension-actions [role=status]')?.textContent === 'Action completed'",
      ),
    'ordinary Settings action',
  )
  await actionFocus('completed', detailGuest)
  if (
    !(await dom(
      "document.hasFocus() && document.activeElement?.getAttribute('aria-label') === 'Extension action context'",
    ))
  )
    throw new Error('Named action stole actual Settings keyboard focus')
  console.log('[smoke] ordinary Settings action completed with retained keyboard focus')
  if (
    !(await dom(
      "[...document.querySelectorAll('button')].some(button => button.textContent.trim() === 'Close settings')",
    ))
  )
    throw new Error('Named action stole Settings placement')
  console.log('[smoke] named action native guest attached')
  await controls.click('Close settings')
  await controls.wait(
    () =>
      dom(
        `document.querySelector('[data-extension-view="${detail.id}"]')?.hidden === false`,
      ),
    'ordinary detail visibly placed',
  )
  await subscribed(detailGuest, 'viewer')

  if (
    !(await dom(
      'document.querySelector(\'button[aria-label="Restore terminal rail"]\') !== null',
    ))
  )
    throw new Error(
      'Visible-viewer independent demand lacked compact-rail positive control',
    )
  const viewerObserved = observation()!.observedAt!
  await controls.wait(
    () => (observation()?.observedAt ?? 0) > viewerObserved,
    'visible viewer refresh with compact rail',
  )
  await controls.click('Sessions')
  await controls.wait(
    () =>
      observation()?.availability === 'stale' &&
      dom(
        `document.querySelector('[data-extension-view="${detail.id}"]')?.hidden === true`,
      ),
    'last ordinary contribution hidden with compact rail',
  )
  await new Promise((resolve) => setTimeout(resolve, 1200))
  const viewerFrozen = observation()!.observedAt
  await new Promise((resolve) => setTimeout(resolve, 2200))
  if (observation()!.observedAt !== viewerFrozen)
    throw new Error('Hidden last viewer retained updater refresh')
  await win.webContents.executeJavaScript(
    "document.querySelector('.project-tab-main').click()",
  )
  await controls.wait(
    () =>
      observation()?.availability === 'current' &&
      observation()!.observedAt! > viewerFrozen!,
    'visible ordinary viewer demand renewed',
  )
  if (
    guests.snapshot(renderer).find((view) => view.role === 'updater')?.id !== updater.id
  )
    throw new Error('Ordinary view demand replaced shared updater')
  await controls.click('Restore terminal rail')
  console.log(
    '[smoke] ordinary viewer independently refreshes with compact rail and pauses on last hide OK',
  )

  // An admitted finite action stays runnable while its ordinary placement is hidden.
  // Guest execution does not fence the separate parent selection publication.
  await win.webContents.executeJavaScript(`(() => {
    const observation = window.__extensionActionPlacement = {selected:false};
    observation.dispose = window.hvir.on('extensions:views-changed', ({selectedId}) => {
      if (selectedId === ${JSON.stringify(detail.id)}) observation.selected = true;
    });
  })()`)
  let placementCleanupFailure: { readonly reason: unknown } | undefined
  try {
    await beginAction('hidden-action', 2400)
    console.log('[smoke] hidden action request started')
    await controls.wait(
      async () =>
        String(
          await detailGuest.executeJavaScript(
            "document.getElementById('status')?.textContent",
          ),
        ).startsWith('Action for '),
      'admitted action executing before hide',
    )
    await controls.wait(
      () =>
        dom(`window.__extensionActionPlacement.selected &&
      document.querySelector('[data-extension-view="${detail.id}"]')?.hidden === false &&
      [...document.querySelectorAll('.viewer-tab[aria-selected="true"] .tab-main')].some(button => button.title === ${JSON.stringify(`${detail.extensionName} · ${detail.title}`)})`),
      'fresh action publication visibly selected before hide',
    )
    await controls.wait(
      () => dom("window.__extensionActions['hidden-action']?.state === 'pending'"),
      'finite action admitted',
    )
    await controls.click('Reference library')
    await controls.wait(
      () =>
        dom(`document.querySelector('[data-extension-view="${detail.id}"]')?.hidden === true &&
      [...document.querySelectorAll('.sessions-destination[aria-current="page"]')].some(button => button.textContent.trim() === 'Reference library') &&
      window.__extensionActions['hidden-action']?.state === 'pending'`),
      'ordinary action placement hidden',
    )
    await controls.wait(
      () => dom("window.__extensionActions['hidden-action']?.state === 'done'"),
      'finite hidden native action completed',
    )
    const hiddenResult = (await win.webContents.executeJavaScript(
      "window.__extensionActions['hidden-action'].value",
    )) as { session?: string; caller?: string }
    if (hiddenResult.session !== sessions[0]!.id || hiddenResult.caller !== 'human')
      throw new Error('Action lost exact caller/context')
  } finally {
    try {
      await win.webContents.executeJavaScript(`(() => {
        window.__extensionActionPlacement?.dispose();
        delete window.__extensionActionPlacement;
      })()`)
    } catch (reason) {
      placementCleanupFailure = { reason }
      console.error('[smoke] action placement observer cleanup failed')
    }
  }
  if (placementCleanupFailure) throw placementCleanupFailure.reason
  await controls.click('Close Reference library')
  await beginAction('closed-action', 5000)
  await controls.wait(
    async () =>
      (await detailGuest.executeJavaScript(
        "document.getElementById('status')?.textContent",
      )) === `Action for ${sessions[0]!.title} · human`,
    'named action executing before close',
  )
  await controls.click('Close Reference detail')
  await controls.wait(
    () =>
      detailGuest.isDestroyed() &&
      dom("window.__extensionActions['closed-action']?.state === 'failed'"),
    'explicit close cancels finite action',
  )
  // Ending exactly the marked shell removes its ephemeral value and leaves the other shell live.
  await win.webContents.executeJavaScript(
    `document.querySelector('.terminal-list-main[data-terminal-session="${terminalIds[sessions[0]!.id]}"]').closest('.terminal-list-row').querySelector('.terminal-close-button').click()`,
  )
  await controls.wait(
    () =>
      extensions.contexts!.sessions(renderer).length === 1 &&
      !extensions
        .contributions!.snapshot()
        .some((entry) =>
          entry.values.some((value) => value.session === context.session!.id),
        ),
    'ended exact session value removed',
  )
  if (
    !extensions
      .contexts!.sessions(renderer)
      .some((session) => session.id === sessions[1]!.id)
  )
    throw new Error('Exact session revocation affected unrelated shell')
  console.log(
    '[smoke] all four live subscriptions and ended exact session value cleanup OK',
  )
  // Updaters never receive action-opening capabilities.
  const denied = (await updaterGuest.executeJavaScript(
    `new Promise(resolve => { const unsubscribe = window.hvirExtension.onMessage(message => { if (message.kind === 'result' && message.id === 'updater-action') { unsubscribe(); resolve(message.ok) } }); window.hvirExtension.send({ kind:'request', id:'updater-action', capability:'actions.invoke', input:{action:'describe-session'} }); })`,
  )) as boolean
  if (denied) throw new Error('Updater admitted a named action')
  updaterGuest.forcefullyCrashRenderer()
  await controls.wait(
    () =>
      observation()?.availability === 'failed' &&
      !!extensions
        .contributions!.snapshot()
        .find((entry) => entry.installationId === installationId)?.error,
    'unchanged-demand updater failure becomes visible',
  )
  await focusSmokeWindow(win)
  await controls.click('Collapse terminal rail')
  await controls.click('Restore terminal rail')
  await controls.wait(
    () =>
      dom(
        "document.querySelector('.terminal-header-actions .extension-terminal-items button')?.title.includes('failed')",
      ),
    'failed observation stays distinct after demand changes',
  )
  if (
    guests.snapshot(renderer).find((view) => view.role === 'updater')?.id !== updater.id
  )
    throw new Error('Failed updater automatically restarted')
  await settings()
  await controls.click('Disable')
  await controls.wait(
    () => guests.snapshot(renderer).length === 0 && updaterGuest.isDestroyed(),
    'Disable revokes all contribution guests',
  )
  console.log(
    '[smoke] static header/session items without guest, shared visible updater pause/renew, left/top navigation, exact-session popup/native Escape/focus, Settings action, hidden finite work and close/Disable cancellation OK',
  )

  function observation() {
    return extensions
      .contributions!.snapshot()
      .find((entry) => entry.installationId === installationId)
      ?.values.find((value) => value.item === 'pulse')
  }
  async function actionFocus(phase: string, guest?: WebContents): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      const parent = (await Promise.race([
        win.webContents.executeJavaScript(`(() => {
          const active = document.activeElement;
          return {
            focused: document.hasFocus(),
            tag: active?.tagName,
            context: active?.getAttribute('aria-label') === 'Extension action context',
            dialog: active?.classList.contains('settings-dialog'),
            heading: active?.id === 'settings-extensions-title',
            terminal: !!active?.closest('.terminal-container'),
            guest: active?.tagName === 'WEBVIEW',
            ...(window.__extensionSettingsFocus ?
              { initialSettingsFocus: window.__extensionSettingsFocus.completed } : {})
          };
        })()`),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error(`Named action focus diagnostic timed out: ${phase}`)),
            5000,
          )
        }),
      ])) as {
        focused: boolean
        tag: string
        context: boolean
        dialog: boolean
        heading: boolean
        terminal: boolean
        guest: boolean
        initialSettingsFocus?: boolean
      }
      console.log(
        '[smoke] named action focus',
        JSON.stringify({
          phase,
          window: win.isFocused(),
          parent,
          ...(guest ? { guest: guest.isFocused() } : {}),
        }),
      )
    } finally {
      clearTimeout(timeout)
    }
  }
  async function dom(expression: string): Promise<boolean> {
    try {
      return Boolean(await win.webContents.executeJavaScript(expression))
    } catch (reason) {
      throw new Error(`Extension DOM assertion failed: ${expression}`, { cause: reason })
    }
  }
  async function settings(): Promise<void> {
    await win.webContents.executeJavaScript(`(() => {
      window.__extensionSettingsFocus?.dispose();
      const receipt = { completed: false, dispose: () =>
        document.removeEventListener('focusin', focused, true) };
      const focused = event => {
        if (!event.target?.classList?.contains('settings-dialog')) return;
        receipt.completed = true;
        receipt.dispose();
      };
      window.__extensionSettingsFocus = receipt;
      document.addEventListener('focusin', focused, true);
    })()`)
    try {
      await controls.click('Open settings')
      await controls.wait(
        () => dom('window.__extensionSettingsFocus.completed'),
        'Settings initial focus completed',
      )
      await actionFocus('settings-initial-focus-completed')
    } catch (reason) {
      await actionFocus('settings-initial-focus-failed').catch(() => undefined)
      throw reason
    } finally {
      await win.webContents
        .executeJavaScript(
          `window.__extensionSettingsFocus?.dispose();
          delete window.__extensionSettingsFocus`,
        )
        .catch(() => undefined)
    }
    await controls.click('Extensions')
    await extensionSettingsControls(win, 'hvir Reference', {
      wait: (predicate, label) => controls.wait(predicate, label),
      within: (work) => work,
    }).select('Extension actions')
  }
  async function connected(guest: WebContents): Promise<void> {
    await controls.wait(
      async () =>
        (await guest.executeJavaScript(
          "document.getElementById('status')?.textContent",
        )) === 'Connected · contract 1.0',
      'ordinary native guest handshake',
    )
  }
  async function subscribed(guest: WebContents, surface: string): Promise<void> {
    await controls.wait(
      async () =>
        String(
          await guest.executeJavaScript(
            "document.getElementById('observation')?.textContent",
          ),
        ).includes('current'),
      `live ${surface} public presentation subscription`,
    )
  }
  async function launchShell(): Promise<void> {
    const before = extensions.contexts!.sessions(renderer).length
    await controls.wait(
      () =>
        dom(
          'document.querySelector(\'button[aria-label="New terminal"]:not(:disabled)\') !== null',
        ),
      'ordinary rail launch control',
    )
    await win.webContents.executeJavaScript(
      'document.querySelector(\'button[aria-label="New terminal"]\').click()',
    )
    await controls.wait(
      () =>
        dom(
          "document.querySelector('button[aria-label=\"New terminal\"]').getAttribute('aria-expanded') === 'true'",
        ),
      'rail launch menu expanded',
    )
    await controls.wait(
      () =>
        dom(
          "[...document.querySelectorAll('.terminal-new-menu strong')].some(node => node.textContent.trim() === 'Shell')",
        ),
      'Shell launch choice',
    )
    await win.webContents.executeJavaScript(
      "[...document.querySelectorAll('.terminal-new-menu strong')].find(node => node.textContent.trim() === 'Shell').closest('button').click()",
    )
    await controls.wait(
      () =>
        extensions.contexts!.sessions(renderer).length > before &&
        dom("!document.querySelector('.terminal-new-menu')"),
      'exact live Shell and closed launch menu',
    )
  }
  async function request(
    guest: WebContents,
    id: string,
    capability: string,
  ): Promise<unknown> {
    const result = (await guest.executeJavaScript(
      `new Promise(resolve => { const unsubscribe = window.hvirExtension.onMessage(message => { if (message.kind === 'result' && message.id === ${JSON.stringify(id)}) { unsubscribe(); resolve(message) } }); window.hvirExtension.send({kind:'request',id:${JSON.stringify(id)},capability:${JSON.stringify(capability)}}); })`,
    )) as { ok: boolean; value?: unknown; error?: string }
    if (!result.ok) throw new Error(result.error)
    return result.value
  }
  async function beginAction(id: string, delayMs: number): Promise<void> {
    const action = {
      installationId,
      action: 'describe-session',
      input: { delayMs },
      context: {
        surface: 'viewer',
        workspaceId: sessions[0]!.workspace.id,
        sessionId: sessions[0]!.id,
      },
    }
    const started = (await win.webContents.executeJavaScript(
      `(() => { try { window.__extensionActions ??= {}; const record = window.__extensionActions[${JSON.stringify(id)}] = {state:'pending'}; window.hvir.invoke('extensions:action', ${JSON.stringify(action)}).then(result => {record.state='done';record.value=result.value}, error => {record.state='failed';record.error=error.message}); return {ok:true}; } catch (error) { return {ok:false,error:String(error),stack:String(error.stack)}; } })()`,
    )) as { ok: boolean; error?: string; stack?: string }
    if (!started.ok)
      throw new Error(`Named action request failed: ${id}: ${started.error}`, {
        cause: started.stack,
      })
  }
}
