import { app, type BrowserWindow, type WebContents } from 'electron'
import { join } from 'node:path'
import { joinHostPath, localPath } from '../../shared/host-path'
import type { ExtensionView } from '../../shared/extensions/workbench'
import type { ProjectHost } from '../project-host/project-host'
import type { ExtensionApplicationRuntime } from '../extensions/extension-application'
import type { RendererResourceScopes } from '../renderer-resource-scopes'
import { ExtensionAuthoring } from '../extensions/extension-authoring'
import { parseAgentCommand } from '../../shared/agent/commands'
import { extensionSettingsControls } from './extension-settings-controls'

interface Facts {
  visible: boolean
  state: string
  reads: number
  released: number
  receipts: number
  bytes: number
  peakRate: number
  frames: number
  inputs: number
  paintedInputs: number
  cancelled: number
  actionPending: boolean
  lastDuration: number
  maxReceiptMs: number
}
/** Task-owned native output through the shipped offline helper and both real guest guards. */
export async function verifyExtensionOutputTransfer(
  win: BrowserWindow,
  extensions: ExtensionApplicationRuntime,
  scopes: RendererResourceScopes,
  host: ProjectHost,
  controls: {
    click(name: string): Promise<void>
    wait(
      this: void,
      predicate: () => boolean | Promise<boolean>,
      label: string,
    ): Promise<void>
    guest(view: ExtensionView): Promise<WebContents>
  },
): Promise<boolean> {
  if (process.env.HVIR_EXTENSION_OUTPUT_EVIDENCE !== '1') return false
  if (app.isPackaged)
    throw new Error('Output evidence requires its maintained fixture checkout')
  const activations = extensions.activations!,
    guests = extensions.guests!
  const directory = joinHostPath(activations.directory, 'output-transfer')
  const authoring = new ExtensionAuthoring(
    host,
    localPath(join(app.getAppPath(), 'packages/extension-authoring')),
  )
  const scaffold = await authoring.command(
    parseAgentCommand(['scaffold', '--output', directory.path]),
  )
  if (scaffold.exitStatus !== 0) throw new Error('Output evidence scaffold failed')
  for (const name of ['index.html', 'transfer.mjs']) {
    const content = await host.readFile(
      localPath(join(app.getAppPath(), 'test/fixtures/extensions/output-transfer', name)),
    )
    await host.writeFile(
      joinHostPath(directory, name),
      name === 'transfer.mjs'
        ? content.toString('utf8').replaceAll('../../../../src/shared/extensions/', './')
        : content,
    )
  }
  await host.writeFile(
    joinHostPath(directory, 'hvir-extension.json'),
    JSON.stringify({
      id: 'hvir.output-transfer',
      name: 'Output transfer evidence',
      version: '1.0.0',
      contract: '1.0',
      requiredCapabilities: [
        'connector.execute',
        'connector.output',
        'actions.invoke',
        'context.read',
        'presentation.read',
      ],
      optionalCapabilities: [],
      access: [],
      views: [
        {
          id: 'transfer',
          title: 'Output transfer',
          entry: 'index.html',
          placement: 'application',
          representations: ['view'],
        },
      ],
      actions: [
        {
          id: 'drain',
          title: 'Drain bounded native output',
          view: 'transfer',
          agents: false,
          effects: { delete: false, replace: false },
        },
      ],
      connectors: [
        {
          id: 'tool',
          description: 'Task-owned output proof',
          context: 'application',
          timeoutMs: 30000,
          outputBytes: 4194304,
          environment: [],
        },
      ],
    }),
  )
  const tool = joinHostPath(activations.directory, '..', 'output-evidence-tool')
  await host.createFileExclusive(tool, { mode: 0o755 })
  await host.writeFile(
    tool,
    `#!/bin/sh
case "$1" in
small) head -c 665600 /dev/zero | tr '\\000' 'a' ;;
large) head -c 2097151 /dev/zero | tr '\\000' '\\001'
       head -c 2097153 /dev/zero | tr '\\000' '\\002' >&2 ;;
*) exit 2 ;;
esac
`,
  )
  const settings = extensionSettingsControls(win, 'Output transfer evidence', {
    wait: controls.wait,
    within: (work) => work,
  })
  await controls.click('Open settings')
  await controls.click('Extensions')
  await controls.click('Discover extensions')
  await controls.wait(
    () =>
      activations
        .snapshot()
        .installations.some((entry) => entry.source === 'output-transfer'),
    'output package discovery',
  )
  await settings.click('Enable')
  await controls.wait(
    () =>
      [...activations.active.values()].some(
        (entry) => entry.revision.manifest.id === 'hvir.output-transfer',
      ),
    'output package enabled',
  )
  const activation = [...activations.active.values()].find(
    (entry) => entry.revision.manifest.id === 'hvir.output-transfer',
  )!
  await settings.select('Program access')
  await settings.set('Executable for tool', tool.path)
  await settings.click('Inspect native access')
  await settings.click('Approve native execution')
  await controls.wait(
    () =>
      extensions.connectors!.approvals.status(activation)[0]?.availability ===
      'supported',
    'output tool approval',
  )
  await settings.select('Extension actions')
  await settings.click('Open Output transfer')
  const owner = scopes.currentOwner(win.webContents.id)
  const view = () =>
    guests
      .snapshot(owner)
      .find(
        (entry) =>
          entry.installationId === activation.installationId &&
          entry.contributionId === 'transfer',
      )
  await controls.wait(() => !!view(), 'output guest placement')
  const ordinaryView = view()!
  const guest = await controls.guest(ordinaryView)
  let observed = guest
  const readFacts = async (target: WebContents): Promise<Facts> => {
    // Production suspension remains authoritative; CDP can inspect a settled hidden
    // action without waking the guest or waiting for its frozen task queue.
    const result = (await target.debugger.sendCommand('Runtime.evaluate', {
      expression: '({...window.outputTransfer})',
      returnByValue: true,
    })) as { result: { value: Facts } }
    return result.result.value
  }
  const inspect = async (): Promise<Facts> => ({
    ...(await readFacts(observed)),
    actionPending: (await readFacts(guest)).actionPending,
  })
  const click = async (id: string): Promise<void> => {
    await guest.executeJavaScript(
      `document.getElementById(${JSON.stringify(id)}).click()`,
    )
  }
  async function wait(
    label: string,
    predicate: (facts: Facts) => boolean,
    milliseconds = 10_000,
  ) {
    const deadline = Date.now() + milliseconds
    while (true) {
      const value = await inspect()
      if (predicate(value)) return value
      if (value.state === 'failed' || Date.now() >= deadline) {
        console.log(
          '[smoke] bounded output failure facts',
          JSON.stringify({ label, ...value }),
        )
        throw new Error(`Output transfer evidence failed: ${label}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
  const evidence: Record<string, Facts> = {}
  try {
    await wait('ordinary ready', (value) => value.visible && value.state === 'ready')
    await click('small')
    evidence['650KiB'] = await wait(
      '650 KiB complete',
      (value) => value.state === 'complete',
    )
    assertComplete(evidence['650KiB'], 1, 650 * 1024, 7)
    console.log('[smoke] output checkpoint 650KiB', JSON.stringify(evidence['650KiB']))
    await click('large')
    await wait(
      'four maximum receipts admitted',
      (value) => value.receipts === 4 && value.reads >= 4,
    )
    // A real Chromium input event changes the fixture DOM; its next animation frame
    // establishes paint opportunity while the transfer is still in flight.
    const point = (await guest.executeJavaScript(
      `(() => { const r=document.getElementById('probe').getBoundingClientRect(); return {x:Math.floor(r.x+r.width/2),y:Math.floor(r.y+r.height/2)} })()`,
    )) as { x: number; y: number }
    guest.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point })
    guest.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point })
    await wait(
      'input and paint during transfer',
      (value) =>
        value.state === 'running' && value.inputs === 1 && value.paintedInputs === 1,
    )
    evidence['four-visible'] = await wait(
      'four maximum visible complete',
      (value) => value.state === 'complete',
      30_000,
    )
    assertComplete(evidence['four-visible'], 4, 16 * 1024 * 1024, 264)
    console.log(
      '[smoke] output checkpoint four-visible',
      JSON.stringify(evidence['four-visible']),
    )
    if (evidence['four-visible'].frames < 2)
      throw new Error('No paint opportunity during transfer')
    await click('action')
    // Human-opened and action-origin views intentionally have separate caches.
    await controls.wait(
      () =>
        guests
          .snapshot(owner)
          .some(
            (entry) =>
              entry.installationId === activation.installationId &&
              entry.id !== ordinaryView.id,
          ),
      'separate action guest placement',
    )
    const actionView = guests
      .snapshot(owner)
      .find(
        (entry) =>
          entry.installationId === activation.installationId &&
          entry.id !== ordinaryView.id,
      )!
    const actionGuest = await controls.guest(actionView)
    observed = actionGuest
    await wait(
      'finite action admitted',
      (value) => value.actionPending && value.receipts === 4 && value.state === 'running',
    )
    await controls.click('Open settings')
    await controls.click('Extensions')
    await wait(
      'finite action hidden',
      (value) => !value.visible && value.state === 'running',
    )
    evidence['four-hidden-action'] = await wait(
      'hidden action complete',
      (value) => value.state === 'complete' && !value.actionPending,
      30_000,
    )
    assertComplete(evidence['four-hidden-action'], 4, 16 * 1024 * 1024, 264)
    console.log(
      '[smoke] output checkpoint four-hidden-action',
      JSON.stringify(evidence['four-hidden-action']),
    )
    await controls.click('Close settings')
    await controls.wait(
      async () => (await readFacts(guest)).visible,
      'ordinary visible again',
    )
    await click('action')
    await wait(
      'withdrawal after retained pages',
      (value) =>
        value.actionPending &&
        value.receipts === 4 &&
        value.reads >= 4 &&
        value.state === 'running',
    )
    await click('withdraw')
    await wait(
      'withdrawal settled',
      (value) => value.cancelled === 1 && !value.actionPending,
    )
    // Span one paced transport window: this observes absence of late completion,
    // never substitutes a sleep for production readiness.
    await new Promise((resolve) => setTimeout(resolve, 1100))
    evidence['withdrawn'] = await inspect()
    if (evidence['withdrawn'].state !== 'cancelled')
      throw new Error('Late output restored a withdrawn action')
    observed = guest
    await click('large')
    evidence['capacity-recovered'] = await wait(
      'four receipt capacity after withdrawal',
      (value) => value.state === 'complete',
      30_000,
    )
    assertComplete(evidence['capacity-recovered'], 4, 16 * 1024 * 1024, 264)
    console.log(
      '[smoke] output checkpoint capacity-recovered',
      JSON.stringify(evidence['capacity-recovered']),
    )
    console.log('[smoke] bounded native output evidence', JSON.stringify(evidence))
    await controls.click('Open settings')
    await controls.click('Extensions')
    await settings.click('Disable')
    await controls.wait(
      () =>
        guest.isDestroyed() &&
        actionGuest.isDestroyed() &&
        !activations.active.has(activation.installationId),
      'output guest and activation disposed',
    )
    console.log(
      '[smoke] output transfer guest/resource teardown OK; hosted input/paint evidence, no quantitative performance claim',
    )
    console.log('HVIR_SMOKE_OK')
    return true
  } catch (error) {
    if (!guest.isDestroyed())
      console.log(
        '[smoke] output transfer terminal facts',
        JSON.stringify(await inspect().catch(() => ({ unavailable: true }))),
      )
    throw error
  }
}
function assertComplete(value: Facts, count: number, bytes: number, reads: number) {
  if (
    value.receipts !== count ||
    value.released !== count ||
    value.bytes !== bytes ||
    value.reads > reads ||
    value.peakRate > 24 ||
    value.maxReceiptMs >= 30_000
  )
    throw new Error('Native output did not satisfy complete bounded receipt delivery')
}
