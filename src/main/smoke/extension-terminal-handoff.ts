import type { BrowserWindow } from 'electron'
import { hostPathEquals, joinHostPath, type HostPath } from '../../shared/host-path'
import type { ProjectHost } from '../project-host/project-host'
import type { PtySupervisor, ManagedPty } from '../pty/pty-supervisor'
import type { LiveSessionMetadataSources } from '../terminal/live-session-metadata'
import type { ElectronSmokeDependencies } from './bootstrap-contract'
import { focusSmokeWindow } from './window-focus'
import { plainShellProvider } from '../harness/harness-provider'
import { TerminalSessionRegistry } from '../terminal/session-registry'

interface Controls {
  click(name: string): Promise<void>
  wait(predicate: () => boolean | Promise<boolean>, label: string): Promise<void>
  command(
    args: readonly string[],
  ): Promise<{ readonly ok: boolean; readonly value?: unknown }>
}

/** Real D6 standing CLI -> D4 guest -> approved D5 connector -> normal renderer/PTY. */
export async function verifyExtensionTerminalHandoff(
  win: BrowserWindow,
  dependencies: ElectronSmokeDependencies,
  host: ProjectHost,
  sources: LiveSessionMetadataSources,
  supervisor: PtySupervisor,
  target: { readonly endpoint: string; readonly workspace: string },
  controls: Controls,
): Promise<void> {
  const extensions = dependencies.extensions,
    agents = dependencies.agents
  const root = sources.projectState().root
  const directory = joinHostPath(extensions.activations!.directory, 'terminal-reference')
  await host.createDirectoryExclusive(directory, { mode: 0o755 })
  const tool = joinHostPath(root, '.terminal-handoff-tool')
  const count = joinHostPath(root, '.terminal-handoff-count')
  const argv = joinHostPath(root, '.terminal-handoff-argv')
  const config = joinHostPath(root, '.terminal-handoff-config')
  const injection = joinHostPath(root, '.terminal-handoff-injected')
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
  await host.createFileExclusive(tool, { mode: 0o755 })
  await host.writeFile(
    tool,
    `#!/bin/sh\nprintf x >> ${quote(count.path)}\nprintf '%s\\0' "$@" > ${quote(argv.path)}\nprintf '%s' "$HVIR_COMMAND_FIXTURE" > ${quote(config.path)}\nprintf 'owned setup failed: 7\\n'\nexit 7\n`,
  )
  const args = [
    'setup',
    '',
    'spaces path',
    "single'quote",
    `$(touch ${quote(injection.path)})`,
    '; false',
    'line\nsecond',
    '日本',
  ]
  await host.writeFile(
    joinHostPath(directory, 'hvir-extension.json'),
    JSON.stringify({
      id: 'hvir.terminal-reference',
      name: 'Terminal reference',
      version: '1.0.0',
      contract: '1.0',
      requiredCapabilities: ['terminal.start', 'actions.invoke', 'context.read'],
      optionalCapabilities: [],
      access: [],
      views: [
        {
          id: 'setup',
          title: 'Owned terminal setup',
          entry: 'index.html',
          placement: 'workspace',
          representations: ['view'],
        },
      ],
      actions: [
        {
          id: 'setup',
          title: 'Open owned setup',
          view: 'setup',
          agents: true,
          description: 'Run an owned failing fixture once in a fresh terminal.',
          effects: { delete: false, replace: false },
        },
      ],
      connectors: [
        {
          id: 'setup-tool',
          description: 'Owned command-once evidence',
          context: 'workspace',
          timeoutMs: 120_000,
          outputBytes: 8192,
          environment: ['HVIR_COMMAND_FIXTURE'],
        },
      ],
    }),
  )
  await host.writeFile(
    joinHostPath(directory, 'index.html'),
    '<!doctype html><script src="setup.js"></script>',
  )
  await host.writeFile(
    joinHostPath(directory, 'setup.js'),
    `const bridge = window.hvirExtension;
    let invocation;
    bridge.onMessage(message => {
      try {
      if(message.kind==='action') {
        invocation=message.invocation;
        if(!invocation.context.workspace?.id)throw new Error('Owned terminal fixture requires admitted workspace context');
        bridge.send({kind:'request',id:'terminal-once',actionId:invocation.id,capability:'terminal.start',
          input:{connector:'setup-tool',workspace:invocation.context.workspace.id,args:${JSON.stringify(args)}}});
      } else if(message.kind==='result' && message.id==='terminal-once') {
        bridge.send({kind:'action-result',id:invocation.id,...(message.ok?{value:message.value}:{error:message.error})});
      }
      } catch(error) {
        if(invocation)bridge.send({kind:'action-result',id:invocation.id,error:String(error)});
        else throw error;
      }
    }); bridge.send({kind:'hello',contract:'1.0'});`,
  )
  await controls.click('Discover extensions')
  await controls.wait(() => !!installation(), 'terminal fixture discovery')
  await selected('Enable')
  await controls.wait(() => !!installation()?.installationId, 'terminal fixture admission')
  const installationId = installation()?.installationId
  if (!installationId) throw new Error('Terminal fixture has no admitted installation')
  await controls.wait(
    () => extensions.activations!.active.has(installationId),
    'terminal fixture Enable',
  )
  const active = extensions.activations!.active.get(installationId)!
  await setInput('Executable for setup-tool', tool.path)
  await setInput(
    'Configuration for setup-tool',
    JSON.stringify({ args: [], env: { HVIR_COMMAND_FIXTURE: 'owned-value' } }),
  )
  await selected('Inspect native access')
  await controls.wait(
    () =>
      dom(
        "[...document.querySelectorAll('.extension-installation')].find(e=>e.querySelector('h4')?.textContent==='Terminal reference')?.textContent.includes('Approve local:')",
      ),
    'terminal canonical decision',
  )
  await selected('Approve native execution')
  await controls.wait(
    () =>
      extensions.connectors!.approvals.status(active)[0]?.availability === 'supported',
    'terminal connector approval',
  )
  await controls.wait(
    () =>
      dom(`(() => {
    const article=[...document.querySelectorAll('.extension-installation')].find(e=>e.querySelector('h4')?.textContent==='Terminal reference');
    const input=article?.querySelector('input[aria-label="Agent access for this extension"]');
    if(!input||input.disabled)return false;if(!input.checked)input.click();return true;
  })()`),
    'terminal agent action grant',
  )
  await controls.wait(
    () => agents.access.snapshot().extensions.includes(active.installationId),
    'terminal standing access',
  )
  await controls.click('Close settings')
  await focusSmokeWindow(win)
  const original = new Set(supervisor.list().map((terminal) => terminal.id))
  const action = await controls.command([
    'run',
    '--instance',
    target.endpoint,
    '--workspace',
    target.workspace,
    '--extension',
    active.installationId,
    '--action',
    'setup',
    '--input',
    'null',
  ])
  const result = action.value as { outcome?: string; terminalId?: string }
  if (
    !action.ok ||
    result.outcome !== 'handed-off' ||
    !result.terminalId ||
    original.has(result.terminalId)
  )
    throw new Error('Public terminal action did not hand off one new identity')
  const terminalId = result.terminalId
  await controls.wait(
    () => supervisor.list().some((terminal) => terminal.id === terminalId),
    'new ordinary terminal',
  )
  const initial = supervisor.get(terminalId)!
  if (
    initial.providerId !== plainShellProvider.manifest.id ||
    initial.profileId !== 'plain-shell-default'
  )
    throw new Error('Command handoff did not preserve ordinary shell identity')
  await controls.wait(async () => exists(argv), 'owned failing setup completed')
  const expected = Buffer.from(args.map((arg) => `${arg}\0`).join(''))
  if (
    !(await host.readFile(argv)).equals(expected) ||
    (await host.readFile(config)).toString() !== 'owned-value' ||
    (await exists(injection))
  )
    throw new Error('Physical setup changed argv/config or evaluated argument syntax')
  await ordinaryInput(initial, 'after-failure')
  await controls.click('Open settings')
  await controls.click('Extensions')
  await selected('Disable')
  await controls.wait(
    () => !extensions.activations!.active.has(active.installationId),
    'terminal fixture Disable',
  )
  if (!supervisor.get(terminalId))
    throw new Error('Disable killed the transferred ordinary terminal')
  await controls.click('Close settings')
  await ordinaryInput(initial, 'after-disable')
  supervisor.write(initial.id, initial.ownerId, 'exit\r', initial.ownerGeneration)
  await controls.wait(() => !supervisor.get(terminalId), 'ordinary shell exit')
  const recovered = (await win.webContents.executeJavaScript(
    `window.hvir.invoke('terminal:recovery',{root:${JSON.stringify(root)}})`,
  )) as Array<{ id: string; profileId: string }>
  if (
    !recovered.some(
      (entry) => entry.id === terminalId && entry.profileId === 'plain-shell-default',
    )
  )
    throw new Error('Real registry did not retain plain-shell recovery')
  const persistedFile = joinHostPath(root, '.terminal-command-recovery.json')
  await controls.wait(async () => {
    try {
      const disk = JSON.parse((await host.readFile(persistedFile)).toString('utf8')) as {
        sessions: Array<{ id: string; profileId: string }>
      }
      return disk.sessions.some(
        (entry) => entry.id === terminalId && entry.profileId === 'plain-shell-default',
      )
    } catch {
      return false
    }
  }, 'exact terminal profile written to disk')
  const freshRegistry = await TerminalSessionRegistry.load(host, persistedFile)
  const exact = freshRegistry.get(terminalId)
  if (
    !exact ||
    exact.profileId !== 'plain-shell-default' ||
    exact.providerId !== plainShellProvider.manifest.id ||
    !hostPathEquals(exact.workspaceRoot, root) ||
    !hostPathEquals(exact.cwd, root)
  )
    throw new Error('Fresh registry load did not preserve the exact ordinary terminal')
  const stored = (await host.readFile(persistedFile)).toString('utf8')
  if (
    stored.includes(tool.path) ||
    stored.includes('owned-value') ||
    stored.includes('terminal-once') ||
    stored.includes('commandTicket')
  )
    throw new Error('Durable recovery retained command-once authority')
  const loaded = new Promise<void>((resolve) =>
    win.webContents.once('did-finish-load', resolve),
  )
  win.webContents.reload()
  await loaded
  await focusSmokeWindow(win)
  await controls.wait(
    () => dom("document.querySelector('.app-shell') !== null"),
    'recovery renderer ready',
  )
  await controls.wait(async () => {
    if (supervisor.get(terminalId)) return true
    return dom(
      "(() => {const button=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='Restore selected');if(!button||button.disabled)return false;button.click();return false})()",
    )
  }, 'fresh ordinary shell recovered through normal renderer')
  const fresh = supervisor.get(terminalId)!
  if (fresh.pid === initial.pid)
    throw new Error('Recovery retained an exited physical shell')
  await ordinaryInput(fresh, 'after-recovery')
  if ((await host.readFile(count)).toString() !== 'x')
    throw new Error('Recovery replayed command-once setup')
  if ([...original].some((id) => !supervisor.get(id)))
    throw new Error('Setup injected into or replaced an existing PTY')
  const proof = {
    terminalId,
    originalPid: initial.pid,
    precedingRecoveryPid: fresh.pid,
    precedingMainPid: process.pid,
  }
  await host.writeFile(
    joinHostPath(root, '.terminal-handoff-proof.json'),
    JSON.stringify(proof),
  )
  console.log('[smoke] terminal initial identities', JSON.stringify(proof))
  console.log(
    '[smoke] public D6 standing/D4/D5 terminal capability: fresh command-once argv/config, failed command -> ordinary shell, Disable survives, persisted plain-shell recovery/no replay OK',
  )
  console.log('HVIR_SMOKE_OK')

  function installation() {
    return extensions
      .activations!.snapshot()
      .installations.find((entry) => entry.source === 'terminal-reference')
  }
  async function dom(expression: string): Promise<boolean> {
    return win.webContents.executeJavaScript(`Boolean(${expression})`) as Promise<boolean>
  }
  async function selected(name: string): Promise<void> {
    await controls.wait(
      () =>
        dom(
          `(() => {const article=[...document.querySelectorAll('.extension-installation')].find(e=>e.querySelector('h4')?.textContent==='Terminal reference');const button=[...(article?.querySelectorAll('button')??[])].find(e=>e.textContent.trim()===${JSON.stringify(name)});if(!button||button.disabled)return false;button.click();return true})()`,
        ),
      `terminal fixture ${name}`,
    )
  }
  async function setInput(label: string, value: string): Promise<void> {
    await controls.wait(
      () =>
        dom(
          `(() => {const article=[...document.querySelectorAll('.extension-installation')].find(e=>e.querySelector('h4')?.textContent==='Terminal reference');const input=article?.querySelector(${JSON.stringify(`[aria-label="${label}"]`)});const setter=Object.getOwnPropertyDescriptor(input instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value')?.set;if(!input||!setter)return false;setter.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));return true})()`,
        ),
      `terminal fixture ${label}`,
    )
  }
  async function exists(path: HostPath): Promise<boolean> {
    try {
      await host.stat(path)
      return true
    } catch {
      return false
    }
  }
  async function ordinaryInput(terminal: ManagedPty, phase: string): Promise<void> {
    const output = joinHostPath(root, `.terminal-shell-${phase}`)
    const pwd = joinHostPath(root, `.terminal-pwd-${phase}`)
    await paneInput(
      win,
      terminal.id,
      `printf '%s' "\${HVIR_COMMAND_FIXTURE-unset}" > ${quote(output.path)}; pwd -P > ${quote(pwd.path)}`,
    )
    await controls.wait(
      async () =>
        (await exists(output)) &&
        (await exists(pwd)) &&
        (await host.readFile(output)).toString() === 'unset' &&
        (await host.readFile(pwd)).toString().trimEnd() ===
          (await host.realpath(root)).path,
      phase,
    )
  }
}

/** New Electron main/renderer/PTY lifetime over the preceding owned registry and marker. */
export async function verifyTerminalCommandProcessRestart(
  win: BrowserWindow,
  host: ProjectHost,
  sources: LiveSessionMetadataSources,
  supervisor: PtySupervisor,
  controls: Pick<Controls, 'wait'>,
): Promise<void> {
  const root = sources.projectState().root
  const proof = JSON.parse(
    (await host.readFile(joinHostPath(root, '.terminal-handoff-proof.json'))).toString(
      'utf8',
    ),
  ) as {
    terminalId: string
    originalPid: number
    precedingRecoveryPid: number
    precedingMainPid: number
  }
  if (proof.precedingMainPid === process.pid)
    throw new Error('Process restart reused the preceding main lifetime')
  const registry = await TerminalSessionRegistry.load(
    host,
    joinHostPath(root, '.terminal-command-recovery.json'),
  )
  const record = registry.get(proof.terminalId)
  if (
    !record ||
    record.profileId !== 'plain-shell-default' ||
    record.providerId !== plainShellProvider.manifest.id ||
    !hostPathEquals(record.workspaceRoot, root) ||
    !hostPathEquals(record.cwd, root)
  )
    throw new Error('New process did not load exact persisted ordinary terminal identity')
  await focusSmokeWindow(win)
  await controls.wait(async () => {
    if (supervisor.get(proof.terminalId)) return true
    await win.webContents.executeJavaScript(
      `(() => {const button=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='Restore selected');if(button&&!button.disabled)button.click()})()`,
    )
    return false
  }, 'new process ordinary shell recovery')
  const recovered = supervisor.get(proof.terminalId)!
  if (
    recovered.pid === proof.originalPid ||
    recovered.pid === proof.precedingRecoveryPid
  )
    throw new Error('New process retained the preceding physical shell')
  const output = joinHostPath(root, '.terminal-shell-after-process-restart')
  const pwd = joinHostPath(root, '.terminal-pwd-after-process-restart')
  const quotePwd = `'${pwd.path.replaceAll("'", "'\\''")}'`
  const quoted = `'${output.path.replaceAll("'", "'\\''")}'`
  await paneInput(
    win,
    recovered.id,
    `printf '%s' "\${HVIR_COMMAND_FIXTURE-unset}" > ${quoted}; pwd -P > ${quotePwd}`,
  )
  await controls.wait(async () => {
    try {
      return (
        (await host.readFile(output)).toString() === 'unset' &&
        (await host.readFile(pwd)).toString().trimEnd() ===
          (await host.realpath(root)).path
      )
    } catch {
      return false
    }
  }, 'new process pane input')
  if (
    (await host.readFile(joinHostPath(root, '.terminal-handoff-count'))).toString() !==
    'x'
  )
    throw new Error('Fresh process recovery replayed setup')
  console.log(
    '[smoke] terminal process restart identities',
    JSON.stringify({ ...proof, recoveredPid: recovered.pid, mainPid: process.pid }),
  )
  console.log(
    '[smoke] fresh Electron process loaded exact persisted plain-shell profile, pane input usable, setup count unchanged/no replay OK',
  )
  console.log('HVIR_SMOKE_OK')
}

async function paneInput(
  win: BrowserWindow,
  terminalId: string,
  command: string,
): Promise<void> {
  await focusSmokeWindow(win)
  const focused: unknown = await win.webContents.executeJavaScript(`(() => {
    const surface=document.querySelector('.terminal-surface[data-terminal-session="'+CSS.escape(${JSON.stringify(terminalId)})+'"]');
    const input=surface?.querySelector('.terminal-engine-host textarea');
    if(!(input instanceof HTMLTextAreaElement)||!surface.classList.contains('active'))return false;
    input.focus();return document.activeElement===input;
  })()`)
  if (!focused) throw new Error('Ordinary terminal pane input was not focused')
  await win.webContents.insertText(command)
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
}
