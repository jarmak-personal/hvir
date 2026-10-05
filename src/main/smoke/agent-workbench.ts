import { app, type BrowserWindow } from 'electron'
import { join } from 'node:path'
import type { ExtensionManifest, ExtensionAction } from '../../shared/extensions/contract'
import type { HostPath } from '../../shared/host-path'
import { localPath, joinHostPath } from '../../shared/host-path'
import type { ProjectHost } from '../project-host/project-host'
import type { PtySupervisor } from '../pty/pty-supervisor'
import type { LiveSessionMetadataSources } from '../terminal/live-session-metadata'
import type { ElectronSmokeDependencies } from './bootstrap-contract'
import { focusSmokeWindow } from './window-focus'
import { ensureExplicitBareShellLaunch } from './terminal-explicit-launch'
import { verifyAuthoringActionExamples } from './extension-authoring-actions'
import {
  verifyExtensionTerminalHandoff,
  verifyTerminalCommandProcessRestart,
} from './extension-terminal-handoff'

interface AgentCliOutcome {
  readonly ok: boolean
  readonly items?: readonly { readonly id: string }[]
  readonly untrusted?: boolean
  readonly declaration?: ExtensionAction
  readonly report?: { readonly id: string; readonly handle: string }
  readonly document?: { readonly path: HostPath; readonly content?: never }
  readonly value?: unknown
}
function agentSmokeHosts(host: ProjectHost) {
  return {
    local: host,
    hostById: (id: string) => (id === host.hostId ? host : undefined),
    listHosts: () => [
      {
        hostId: host.hostId,
        label: 'Local',
        kind: 'local' as const,
        connectionState: host.connectionState,
        watchTier: host.watchTier,
      },
    ],
    materializeHost: (id: string) => {
      if (id !== host.hostId) throw new Error('Unknown smoke host')
      return Promise.resolve(host)
    },
    onHostStateChange: (listener: Parameters<ProjectHost['onConnectionState']>[0]) =>
      host.onConnectionState(listener),
  }
}
/** Install stable targets before the first window can trigger a terminal spawn. */
export function prepareAgentSmoke(
  dependencies: ElectronSmokeDependencies,
  host: ProjectHost,
  sources: LiveSessionMetadataSources,
  supervisor: PtySupervisor,
): void {
  if (dependencies.mode !== 'agent-workbench') return
  const hosts = agentSmokeHosts(host)
  void dependencies.extensions.start(host, sources, hosts)
  void dependencies.agents.start(host, sources, hosts, supervisor)
}
/** Dedicated real CLI/socket/UI scenario; connectors, rails and Sessions are unnecessary. */
export async function verifyAgentWorkbench(
  win: BrowserWindow,
  dependencies: ElectronSmokeDependencies,
  host: ProjectHost,
  sources: LiveSessionMetadataSources,
  supervisor: PtySupervisor,
): Promise<boolean> {
  if (dependencies.mode !== 'agent-workbench') return false
  const { agents, extensions } = dependencies
  await focusSmokeWindow(win)
  if (process.env['HVIR_EXTENSION_TERMINAL_PROBE_PHASE'] === 'restart') {
    await verifyTerminalCommandProcessRestart(win, host, sources, supervisor, { wait })
    return true
  }
  await ensureExplicitBareShellLaunch(win, supervisor)
  await extensions.start(host, sources, agentSmokeHosts(host))
  await agents.start(
    host,
    sources,
    { hostById: (id) => (id === host.hostId ? host : undefined) },
    supervisor,
  )
  const endpoint = agents.access.snapshot().endpoint
  if (!endpoint) throw new Error('Agent endpoint did not start')
  const entry = app.isPackaged
    ? join(process.resourcesPath, 'app.asar/out/main/agent-cli.js')
    : join(app.getAppPath(), 'out/main/agent-cli.js')
  async function command(
    args: readonly string[],
    input?: string,
    expected = 0,
  ): Promise<AgentCliOutcome> {
    const result = await host.exec(process.execPath, [entry, ...args], {
      env: { ELECTRON_RUN_AS_NODE: '1' },
      unsetEnv: ['HVIR_AGENT_ENDPOINT', 'HVIR_AGENT_WORKSPACE', 'HVIR_AGENT_SESSION'],
      input,
      maxBuffer: 256 * 1024,
    })
    if (result.code !== expected)
      throw new Error(
        `Agent CLI ${args[0]} failed (${result.code}): ${result.stdout} ${result.stderr}`,
      )
    return JSON.parse(result.stdout) as AgentCliOutcome
  }
  await command(['help'])
  await command(['commands'])
  await command(['guide', 'access'])
  await socketAbsent(host, endpoint)
  await command(['workspaces', '--instance', endpoint], undefined, 69)
  await click(win, 'Open settings')
  await click(win, 'Extensions')
  await wait(
    () =>
      dom(
        win,
        `(() => { const input = [...document.querySelectorAll('input[type="checkbox"]')].find(input => input.parentElement.textContent.includes('Allow agents to inspect and present workspace content')); if (!input || input.disabled) return false; if (!input.checked) input.click(); return true; })()`,
      ),
    'ordinary ready agent access control',
  )
  await wait(() => agents.access.snapshot().enabled, 'ordinary agent Enable')
  await wait(async () => {
    try {
      return (await command(['workspaces', '--instance', endpoint])).ok
    } catch {
      return false
    }
  }, 'enabled endpoint')
  const workspaces = await command(['workspaces', '--instance', endpoint, '--limit', '1'])
  const workspace = workspaces.items?.[0]?.id
  if (!workspace) throw new Error('Agent metadata did not include the explicit workspace')
  if (process.env['HVIR_EXTENSION_TERMINAL_PROBE'] === '1') {
    await verifyExtensionTerminalHandoff(
      win,
      dependencies,
      host,
      sources,
      supervisor,
      { endpoint, workspace },
      { command, click: (name) => click(win, name), wait },
    )
    return true
  }
  const directory = extensions.activations!.directory,
    reference = joinHostPath(directory, 'agent-reference')
  await host.createDirectoryExclusive(reference, { mode: 0o755 })
  const source = localPath(
    app.isPackaged
      ? join(process.resourcesPath, 'extension-reference')
      : join(app.getAppPath(), 'packages/extension-reference'),
  )
  for (const item of await host.readdir(source))
    await host.writeFile(
      joinHostPath(reference, item.name),
      await host.readFile(joinHostPath(source, item.name)),
    )
  const manifestPath = joinHostPath(reference, 'hvir-extension.json')
  const manifest = {
    ...(JSON.parse(
      (await host.readFile(manifestPath)).toString('utf8'),
    ) as ExtensionManifest),
  }
  delete manifest.connectors
  manifest.optionalCapabilities = []
  delete manifest.updater
  delete manifest.railItems
  await host.writeFile(manifestPath, JSON.stringify(manifest))
  await wait(
    () =>
      dom(
        win,
        `(() => { const summary = [...document.querySelectorAll('summary')].find(item => item.textContent.trim() === 'Author and discovery controls'); if (!summary || !summary.checkVisibility()) return false; if (!summary.parentElement.open) summary.click(); return summary.parentElement.open; })()`,
      ),
    'ordinary author controls disclosure',
  )
  await click(win, 'Discover extensions')
  await wait(
    () =>
      extensions
        .activations!.snapshot()
        .installations.some((item) => item.source === 'agent-reference'),
    'reference discovery',
  )
  await click(win, 'Enable')
  await wait(() => extensions.activations!.active.size === 1, 'reference Enable')
  const installation = [...extensions.activations!.active.keys()][0]!
  await wait(
    () =>
      dom(
        win,
        `(() => { const input = document.querySelector('input[aria-label="Agent access for this extension"]'); if (!input || input.disabled) return false; if (!input.checked) input.click(); return true; })()`,
      ),
    'ordinary ready extension access control',
  )
  await wait(
    () => agents.access.snapshot().extensions.includes(installation),
    'ordinary extension agent access',
  )
  await click(win, 'Close settings')
  const terminal = supervisor.list()[0]!
  const session = extensions.contexts!.launchTarget(terminal)!.session
  // Execute through the supervised shell without target flags: its protected values must work.
  const output = joinHostPath(sources.projectState().root, '.agent-terminal-result.json')
  const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
  supervisor.write(
    terminal.id,
    terminal.ownerId,
    `ELECTRON_RUN_AS_NODE=1 ${shellQuote(process.execPath)} ${shellQuote(entry)} sessions > ${shellQuote(output.path)}\r`,
    terminal.ownerGeneration,
  )
  await wait(async () => {
    try {
      return (
        (JSON.parse((await host.readFile(output)).toString('utf8')) as { ok?: boolean })
          .ok === true
      )
    } catch {
      return false
    }
  }, 'protected terminal defaults')
  await host.removeFile(output)
  const other = (await command(['workspaces', '--instance', endpoint])).items?.find(
    (item) => item.id !== workspace,
  )
  if (!other) throw new Error('Explicit other workspace fixture is missing')
  supervisor.write(
    terminal.id,
    terminal.ownerId,
    `printf 'Explicit workspace result' | ELECTRON_RUN_AS_NODE=1 ${shellQuote(process.execPath)} ${shellQuote(entry)} report --workspace ${shellQuote(other.id)} --stdin > ${shellQuote(output.path)}\r`,
    terminal.ownerGeneration,
  )
  await wait(async () => {
    try {
      return Boolean(
        (JSON.parse((await host.readFile(output)).toString('utf8')) as AgentCliOutcome)
          .report?.id,
      )
    } catch {
      return false
    }
  }, 'explicit workspace replaces inherited session')
  const explicit = JSON.parse(
    (await host.readFile(output)).toString('utf8'),
  ) as AgentCliOutcome
  if (agents.reports.read(explicit.report!.id).workspace !== other.id)
    throw new Error('CLI inherited the wrong workspace')
  agents.reports.close(explicit.report!.id)
  await host.removeFile(output)

  const selected = await command([
    'action',
    '--instance',
    endpoint,
    '--extension',
    installation,
    '--action',
    'describe-session',
  ])
  if (!selected.untrusted || !selected.declaration?.inputSchema)
    throw new Error('Selected action declaration was not explicit untrusted schema')
  const before = (await win.webContents.executeJavaScript(
    `(() => { const input = document.createElement('input'); input.id='agent-focus-proof'; document.body.append(input); input.focus(); return document.activeElement.id; })()`,
  )) as string
  const target = ['--instance', endpoint, '--workspace', workspace, '--session', session]
  const action = await command([
    'run',
    ...target,
    '--extension',
    installation,
    '--action',
    'describe-session',
    '--input',
    'null',
  ])
  if (
    !action.ok ||
    (await win.webContents.executeJavaScript('document.activeElement?.id')) !== before
  )
    throw new Error('Reference action failed or stole keyboard focus')
  await verifyAuthoringActionExamples(
    win,
    agents.access,
    { workspace, session },
    {
      run: (id, expected = 0) =>
        command(
          [
            'run',
            ...target,
            '--extension',
            installation,
            '--action',
            id,
            '--input',
            'null',
          ],
          undefined,
          expected,
        ),
      click: (name) => click(win, name),
      wait,
    },
  )
  await win.webContents.executeJavaScript(
    "document.getElementById('agent-focus-proof').focus()",
  )
  const published = await command(
    ['report', ...target, '--title', 'Agent native report', '--stdin'],
    '# Native report\n\n![inert](https://example.invalid/tracking)\n\n[README](README.md)',
  )
  await wait(
    () => dom(win, "document.querySelector('.agent-report-tab') !== null"),
    'quiet report tab',
  )
  if ((await win.webContents.executeJavaScript('document.activeElement?.id')) !== before)
    throw new Error('Report publication stole focus')
  await wait(
    () =>
      dom(
        win,
        "document.querySelector('.projects-bar .agent-report-badge') !== null && (!document.querySelector('.workspaces-bar') || document.querySelector('.workspaces-bar .agent-report-badge') !== null)",
      ),
    'separate workspace and project report badges',
  )
  if (!agents.reports.read(published.report!.id).unread)
    throw new Error('Unviewed report lost its quiet badge')
  await win.webContents.executeJavaScript(
    `document.querySelector('.agent-report-tab button:not(.tab-close)').click()`,
  )
  await wait(
    () =>
      dom(win, "document.querySelector('.agent-report-view .markdown-body') !== null"),
    'worker-rendered report',
  )
  if (await dom(win, "document.querySelector('.agent-report-view img') !== null"))
    throw new Error('Report mounted an automatic resource')
  await wait(
    () => !agents.reports.read(published.report!.id).unread,
    'view clears only report attention',
  )
  await command(
    [
      'report',
      ...target,
      '--handle',
      published.report!.handle,
      '--title',
      'Replacement',
      '--format',
      'text',
      '--stdin',
    ],
    'retained replacement',
  )
  await command(['report', ...target, '--handle', 'unknown', '--stdin'], 'refused', 69)
  const opened = await command(['open', ...target, '--path', 'README.md'])
  if (
    opened.document?.content !== undefined ||
    opened.document?.path.path !==
      joinHostPath(sources.projectState().root, 'README.md').path
  )
    throw new Error(
      'Document response exposed contents or lost its host-qualified target',
    )
  await command(['open', ...target, '--path', '../outside.md'], undefined, 69)
  await command(['sessions', '--instance', endpoint, '--session', 'stale'], undefined, 69)
  await click(win, 'Open settings')
  await click(win, 'Extensions')
  await setAgentAccess(win, false)
  await wait(() => !agents.access.snapshot().enabled, 'ordinary access Off')
  await command(['workspaces', '--instance', endpoint], undefined, 69)
  if (agents.reports.read(published.report!.id).content !== 'retained replacement')
    throw new Error('Access revocation deleted completed content')
  await socketAbsent(host, endpoint)
  await setAgentAccess(win, true)
  await wait(() => agents.access.snapshot().enabled, 'ordinary access re-enable')
  if (agents.access.snapshot().endpoint !== endpoint)
    throw new Error('Re-enable changed the terminal target')
  await wait(async () => {
    try {
      return (await command(['sessions', '--instance', endpoint])).ok
    } catch {
      return false
    }
  }, 're-enabled endpoint')
  await setAgentAccess(win, false)
  await socketAbsent(host, endpoint)
  await click(win, 'Close settings')
  await agents.dispose()
  await socketAbsent(host, endpoint)
  await command(['workspaces', '--instance', endpoint], undefined, 69)
  console.log(
    '[smoke] real agent CLI/socket, protected terminal defaults, connector-free action, quiet inert report, exact document and revocation OK',
  )
  console.log('HVIR_SMOKE_OK')
  return true
}
async function dom(win: BrowserWindow, script: string): Promise<boolean> {
  return Boolean(await win.webContents.executeJavaScript(script))
}
async function click(win: BrowserWindow, name: string): Promise<void> {
  await wait(
    () =>
      dom(
        win,
        `(() => { const button = [...document.querySelectorAll('button')].find(item => item.getAttribute('aria-label') === ${JSON.stringify(name)} || item.textContent.trim() === ${JSON.stringify(name)}); if (!button || button.disabled) return false; button.click(); return true; })()`,
      ),
    `ordinary ${name}`,
  )
}
async function wait(
  predicate: () => boolean | Promise<boolean>,
  label: string,
): Promise<void> {
  const deadline = Date.now() + 15000
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`Agent native smoke timed out: ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

async function socketAbsent(host: ProjectHost, endpoint: string): Promise<void> {
  await wait(async () => {
    try {
      await host.stat(localPath(endpoint))
      return false
    } catch (reason) {
      if ((reason as { code?: unknown }).code === 'ENOENT') return true
      throw reason
    }
  }, 'Off endpoint release')
}
async function setAgentAccess(win: BrowserWindow, enabled: boolean): Promise<void> {
  await wait(
    () =>
      dom(
        win,
        `(() => { const input = [...document.querySelectorAll('input[type="checkbox"]')].find(input => input.parentElement.textContent.includes('Allow agents to inspect and present workspace content')); if (!input || input.disabled) return false; if (input.checked !== ${JSON.stringify(enabled)}) input.click(); return true; })()`,
      ),
    'ordinary ready agent access control',
  )
}
