import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, onTestFinished, vi } from 'vitest'

import {
  DEFAULT_SMOKE_SCENARIOS,
  classifySmokeAttempt,
  formatSmokeScenarioResults,
  invokeSmokeScenario,
  parseSmokeRepetitionCount,
  runSmokeScenarioGroups,
  selectedSmokeScenarios,
  smokeScenarioEnvironment,
  smokeAttemptTimeoutMs,
  smokeCheckpointTimeoutMs,
  writeSmokeFailureArtifactWithinDeadline,
  type SmokeScenarioName,
} from '../scripts/run-smoke-scenarios.mts'
import {
  ELECTRON_SMOKE_SCENARIOS,
  parseElectronSmokeScenario,
} from '../src/main/smoke/scenario-selection.mts'

describe('Electron smoke scenario selection', () => {
  it('keeps bare direct Electron smoke compatible with the legacy workflow', () => {
    expect(parseElectronSmokeScenario(undefined)).toBe('legacy-workflow')
    expect(parseElectronSmokeScenario('')).toBe('legacy-workflow')
  })

  it.each(ELECTRON_SMOKE_SCENARIOS)('selects the named %s group', (scenario) => {
    expect(parseElectronSmokeScenario(scenario)).toBe(scenario)
    expect(selectedSmokeScenarios(scenario)).toEqual([scenario])
  })

  it('rejects unknown groups with the complete reproducible name set', () => {
    expect(() => parseElectronSmokeScenario('unknown')).toThrow(
      "Unknown Electron smoke scenario 'unknown'. Expected one of: " +
        'pty-native, viewer-position, viewer-content, git-workflow, workspace-remote, web-pane, renderer-authority, platform-contracts, diagnostic-report-restart, renderer-recovery, development-performance, terminal-presentation, terminal-lifecycle, legacy-workflow, capacity',
    )
    expect(() => selectedSmokeScenarios('unknown')).toThrow(
      "Unknown Electron smoke scenario 'unknown'. Expected one of: " +
        'pty-native, viewer-position, viewer-content, git-workflow, workspace-remote, web-pane, renderer-authority, platform-contracts, diagnostic-report-restart, renderer-recovery, development-performance, terminal-presentation, terminal-lifecycle, legacy-workflow, capacity',
    )
  })

  it('selects an explicit ordered scenario set without replacing the single-name API', () => {
    expect(
      selectedSmokeScenarios(undefined, [
        'pty-native',
        'viewer-position',
        'platform-contracts',
      ]),
    ).toEqual(['pty-native', 'viewer-position', 'platform-contracts'])
    expect(() => selectedSmokeScenarios('pty-native', ['viewer-position'])).toThrow(
      'positional names or HVIR_SMOKE_SCENARIO, not both',
    )
    expect(() => selectedSmokeScenarios(undefined, ['unknown'])).toThrow(
      "Unknown Electron smoke scenario 'unknown'",
    )
  })

  it('schedules the focused native and viewer groups with the legacy workflow', () => {
    expect(selectedSmokeScenarios(undefined)).toEqual(DEFAULT_SMOKE_SCENARIOS)
    expect(DEFAULT_SMOKE_SCENARIOS).toEqual([
      'pty-native',
      'viewer-position',
      'legacy-workflow',
    ])
  })
})

describe('Electron smoke result aggregation', () => {
  it('requires exit zero and the semantic success sentinel', () => {
    expect(
      classifySmokeAttempt({
        exitCode: 0,
        signal: null,
        successSentinel: false,
        durationMs: 10,
      }),
    ).toEqual({
      status: 'failed',
      exitCode: 0,
      error: 'missing success sentinel',
      durationMs: 10,
    })
    expect(
      classifySmokeAttempt({
        exitCode: 0,
        signal: null,
        successSentinel: true,
        durationMs: 10,
      }),
    ).toEqual({ status: 'passed', exitCode: 0, durationMs: 10 })
  })

  it('runs every group for every iteration and continues after failures', async () => {
    const invoked: Array<readonly [SmokeScenarioName, number, number]> = []
    const invoke = vi.fn(
      (scenario: SmokeScenarioName, iteration: number, repetitionCount: number) => {
        invoked.push([scenario, iteration, repetitionCount])
        if (scenario === 'pty-native' && iteration === 1) {
          throw new Error('native load failed')
        }
        if (scenario === 'viewer-position' && iteration === 2) {
          return Promise.resolve({ status: 'failed' as const, exitCode: 2 })
        }
        return Promise.resolve({ status: 'passed' as const, exitCode: 0 })
      },
    )

    const results = await runSmokeScenarioGroups(DEFAULT_SMOKE_SCENARIOS, 2, invoke)

    expect(invoked).toEqual([
      ['pty-native', 1, 2],
      ['viewer-position', 1, 2],
      ['legacy-workflow', 1, 2],
      ['pty-native', 2, 2],
      ['viewer-position', 2, 2],
      ['legacy-workflow', 2, 2],
    ])
    expect(results).toEqual([
      {
        scenario: 'pty-native',
        iteration: 1,
        repetitionCount: 2,
        status: 'failed',
        error: 'native load failed',
      },
      {
        scenario: 'viewer-position',
        iteration: 1,
        repetitionCount: 2,
        status: 'passed',
        exitCode: 0,
      },
      {
        scenario: 'legacy-workflow',
        iteration: 1,
        repetitionCount: 2,
        status: 'passed',
        exitCode: 0,
      },
      {
        scenario: 'pty-native',
        iteration: 2,
        repetitionCount: 2,
        status: 'passed',
        exitCode: 0,
      },
      {
        scenario: 'viewer-position',
        iteration: 2,
        repetitionCount: 2,
        status: 'failed',
        exitCode: 2,
      },
      {
        scenario: 'legacy-workflow',
        iteration: 2,
        repetitionCount: 2,
        status: 'passed',
        exitCode: 0,
      },
    ])
    expect(formatSmokeScenarioResults(results)).toBe(
      '[smoke:summary] attempts=6 iterations=2\n' +
        '- pty-native iteration 1/2: failed (native load failed)\n' +
        '- viewer-position iteration 1/2: passed (exit 0)\n' +
        '- legacy-workflow iteration 1/2: passed (exit 0)\n' +
        '- pty-native iteration 2/2: passed (exit 0)\n' +
        '- viewer-position iteration 2/2: failed (exit 2)\n' +
        '- legacy-workflow iteration 2/2: passed (exit 0)',
    )
  })

  it('defaults to one iteration and accepts bounded ASCII decimal counts', () => {
    expect(parseSmokeRepetitionCount(undefined)).toBe(1)
    expect(parseSmokeRepetitionCount('1')).toBe(1)
    expect(parseSmokeRepetitionCount('20')).toBe(20)
    expect(parseSmokeRepetitionCount('100')).toBe(100)
    expect(parseSmokeRepetitionCount('01')).toBe(1)
  })

  it.each(['', ' ', ' 1', '1 ', '+1', '-1', '1.0', '1e1', '0', '101', '١'])(
    'rejects invalid repetition count %j',
    (value) => {
      expect(() => parseSmokeRepetitionCount(value)).toThrow(
        'HVIR_SMOKE_REPEAT must be an ASCII decimal integer from 1 through 100',
      )
    },
  )

  it('does not pass runner repetition control into an Electron attempt', () => {
    expect(
      smokeScenarioEnvironment(
        {
          HVIR_SMOKE_REPEAT: '20',
          HVIR_SMOKE_SCENARIO: 'legacy-workflow',
          KEEP_ME: 'yes',
        },
        'pty-native',
      ),
    ).toEqual({
      HVIR_SMOKE_SCENARIO: 'pty-native',
      KEEP_ME: 'yes',
    })
  })

  it('keeps every attempt bounded while allowing the capacity sampling window', () => {
    expect(smokeAttemptTimeoutMs('pty-native')).toBe(180_000)
    expect(smokeAttemptTimeoutMs('capacity')).toBe(600_000)
    expect(
      smokeCheckpointTimeoutMs(
        'renderer-authority',
        'renderer-authority-reload-awaiting',
      ),
    ).toBe(15_000)
    expect(
      smokeCheckpointTimeoutMs(
        'renderer-authority',
        'renderer-authority-reload-loaded',
      ),
    ).toBeUndefined()
    expect(smokeCheckpointTimeoutMs('web-pane', null)).toBeUndefined()
  })
})

describe('Electron smoke process failure artifacts', () => {
  async function invokeFixture(options: {
    command: string
    args?: readonly string[]
    timeoutMs?: number
    checkpointTimeoutMs?: number
    scenario?: SmokeScenarioName
  }) {
    const directory = await mkdtemp(join(tmpdir(), 'hvir-smoke-launcher-'))
    onTestFinished(() => rm(directory, { recursive: true, force: true }))
    vi.mocked(console.error).mockImplementation(() => undefined)

    const scenario = options.scenario ?? 'web-pane'
    const result = await invokeSmokeScenario(scenario, 1, 1, {
      ...options,
      artifactDirectory: directory,
      environment: {},
    })
    const artifact = JSON.parse(
      await readFile(join(directory, `${scenario}-iteration-1-of-1.json`), 'utf8'),
    ) as {
      schema: number
      scenario: string
      iteration: number
      repetitionCount: number
      process: {
        exitCode: number | null
        signal: NodeJS.Signals | null
        spawnError: boolean
      }
      semanticSnapshot: { phase: string } | null
    }
    return { artifact, result }
  }

  it('retains spawn, nonzero-exit, and signal outcomes', async () => {
    const spawnFailure = await invokeFixture({
      command: 'hvir-smoke-command-that-does-not-exist',
      timeoutMs: 1_000,
    })
    expect(spawnFailure.artifact.process).toEqual({
      exitCode: null,
      signal: null,
      spawnError: true,
    })

    const nonzero = await invokeFixture({
      command: process.execPath,
      args: ['-e', 'process.exit(7)'],
      timeoutMs: 1_000,
    })
    expect(nonzero.artifact.process).toEqual({
      exitCode: 7,
      signal: null,
      spawnError: false,
    })

    const signaled = await invokeFixture({
      command: process.execPath,
      args: ['-e', "process.kill(process.pid, 'SIGTERM')"],
      timeoutMs: 1_000,
    })
    expect(signaled.artifact.process).toEqual({
      exitCode: null,
      signal: 'SIGTERM',
      spawnError: false,
    })
  })

  it('kills a never-settling attempt and retains its last completed phase first', async () => {
    const evidence = JSON.stringify({
      schema: 1,
      phase: 'renderer-ready',
      checkpoint: null,
      cleanupResource: null,
      owners: {
        windowCount: 1,
        ptyCount: 0,
        watcherActive: true,
        rendererOwnerActive: true,
        rendererGeneration: 2,
      },
    })
    const fixture = await invokeFixture({
      command: process.execPath,
      args: [
        '-e',
        `process.stderr.write(${JSON.stringify(`[smoke:failure-evidence] ${evidence}\n`)}); setInterval(() => undefined, 1_000)`,
      ],
      timeoutMs: 500,
    })

    expect(fixture.result).toMatchObject({
      status: 'failed',
      signal: 'SIGKILL',
      error: 'process timed out',
    })
    expect(fixture.artifact).toMatchObject({
      schema: 1,
      scenario: 'web-pane',
      iteration: 1,
      repetitionCount: 1,
    })
    expect(fixture.artifact.process).toEqual({
      exitCode: null,
      signal: 'SIGKILL',
      spawnError: false,
    })
    expect(fixture.artifact.semanticSnapshot).toEqual({
      schema: 1,
      phase: 'renderer-ready',
      checkpoint: null,
      cleanupResource: null,
      owners: {
        windowCount: 1,
        ptyCount: 0,
        watcherActive: true,
        rendererOwnerActive: true,
        rendererGeneration: 2,
      },
    })
  })

  it('kills a main-loop stall at its renderer-authority checkpoint deadline', async () => {
    const evidence = JSON.stringify({
      schema: 1,
      phase: 'scenario-active',
      checkpoint: 'renderer-authority-reload-awaiting',
      cleanupResource: null,
      owners: {
        windowCount: 1,
        ptyCount: 0,
        watcherActive: true,
        rendererOwnerActive: true,
        rendererGeneration: 1,
      },
    })
    const fixture = await invokeFixture({
      scenario: 'renderer-authority',
      command: process.execPath,
      args: [
        '-e',
        `process.stderr.write(${JSON.stringify(`[smoke:failure-evidence] ${evidence}\n`)}); setInterval(() => undefined, 1_000)`,
      ],
      timeoutMs: 1_000,
      checkpointTimeoutMs: 50,
    })

    expect(fixture.result).toMatchObject({
      status: 'failed',
      signal: 'SIGKILL',
      error:
        'process timed out at renderer-authority-reload-awaiting after 50ms',
    })
    expect(fixture.artifact.semanticSnapshot).toMatchObject({
      phase: 'scenario-active',
      checkpoint: 'renderer-authority-reload-awaiting',
    })
  })

  it('bounds a stalled artifact writer independently of process termination', async () => {
    await expect(
      writeSmokeFailureArtifactWithinDeadline(
        () => new Promise<string>(() => undefined),
        10,
      ),
    ).rejects.toThrow('artifact retention timed out')
  })
})

describe('Electron smoke command contracts', () => {
  const packageJson = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { scripts: Record<string, string> }
  const invocationScript = readFileSync(
    new URL('../scripts/run-smoke.sh', import.meta.url),
    'utf8',
  )
  const interruptionScript = readFileSync(
    new URL('../scripts/run-smoke-interruption.mts', import.meta.url),
    'utf8',
  )
  const gauntletScript = readFileSync(
    new URL('../scripts/phase8-gauntlet.sh', import.meta.url),
    'utf8',
  )
  const prePushHook = readFileSync(
    new URL('../.githooks/pre-push', import.meta.url),
    'utf8',
  )
  const contributing = readFileSync(
    new URL('../CONTRIBUTING.md', import.meta.url),
    'utf8',
  )
  const smokeWorkflow = readFileSync(
    new URL('../src/main/smoke/index.ts', import.meta.url),
    'utf8',
  )
  const capacityScenario = readFileSync(
    new URL('../src/main/smoke/capacity.ts', import.meta.url),
    'utf8',
  )
  const capacityPerformancePolicy = readFileSync(
    new URL('../src/main/smoke/capacity-performance.ts', import.meta.url),
    'utf8',
  )
  const capacityTerminalScenario = readFileSync(
    new URL('../src/main/smoke/capacity-terminals.ts', import.meta.url),
    'utf8',
  )
  const viewerPositionScenario = readFileSync(
    new URL('../src/main/smoke/viewer-position.ts', import.meta.url),
    'utf8',
  )
  const viewerFindScenario = readFileSync(
    new URL('../src/main/smoke/viewer-find.ts', import.meta.url),
    'utf8',
  )
  const viewerContentScenario = readFileSync(
    new URL('../src/main/smoke/viewer-content.ts', import.meta.url),
    'utf8',
  )
  const gitWorkflowScenario = readFileSync(
    new URL('../src/main/smoke/git-workflow.ts', import.meta.url),
    'utf8',
  )
  const workspaceRemoteScenario = readFileSync(
    new URL('../src/main/smoke/workspace-remote.ts', import.meta.url),
    'utf8',
  )
  const webPaneScenario = readFileSync(
    new URL('../src/main/smoke/web-pane.ts', import.meta.url),
    'utf8',
  )
  const rendererAuthorityScenario = readFileSync(
    new URL('../src/main/smoke/renderer-authority.ts', import.meta.url),
    'utf8',
  )
  const terminalPresentationScenario = readFileSync(
    new URL('../src/main/smoke/terminal-presentation.ts', import.meta.url),
    'utf8',
  )
  const terminalRendererLifecycleScenario = readFileSync(
    new URL('../src/main/smoke/terminal-renderer-lifecycle.ts', import.meta.url),
    'utf8',
  )
  const rendererLifecycleScenario = readFileSync(
    new URL('../src/main/smoke/renderer-lifecycle.ts', import.meta.url),
    'utf8',
  )

  it('separates correctness, hosted evidence, and controlled performance commands', () => {
    expect(packageJson.scripts.smoke).toContain('node scripts/run-smoke-scenarios.mts')
    expect(packageJson.scripts.smoke).toContain(
      'viewer-position viewer-content git-workflow workspace-remote web-pane renderer-authority renderer-recovery terminal-presentation terminal-lifecycle legacy-workflow',
    )
    expect(packageJson.scripts['smoke:macos']).toContain(
      'node scripts/run-smoke-scenarios.mts pty-native viewer-position viewer-content git-workflow workspace-remote web-pane renderer-authority platform-contracts renderer-recovery terminal-presentation terminal-lifecycle',
    )
    expect(packageJson.scripts['smoke:macos:ci']).toContain(
      'node scripts/run-smoke-scenarios.mts pty-native viewer-position viewer-content git-workflow workspace-remote web-pane renderer-authority platform-contracts renderer-recovery',
    )
    expect(packageJson.scripts['smoke:macos:ci']).not.toContain('terminal-presentation')
    expect(packageJson.scripts['smoke:macos:ci']).not.toContain('terminal-lifecycle')
    expect(packageJson.scripts['smoke:scenario']).toBe(
      'electron-vite build && node scripts/run-smoke-scenarios.mts',
    )
    expect(packageJson.scripts['smoke:macos']).not.toMatch(
      /terminal-presentation capacity/,
    )
    expect(packageJson.scripts['smoke:capacity']).toContain(
      'HVIR_SMOKE_SCENARIO=capacity node scripts/run-smoke-scenarios.mts',
    )
    expect(packageJson.scripts['smoke:capacity']).not.toContain(
      'HVIR_CAPACITY_PERFORMANCE_GATE',
    )
    expect(packageJson.scripts['performance:capacity']).toContain(
      'HVIR_SMOKE_SCENARIO=capacity HVIR_CAPACITY_PERFORMANCE_GATE=controlled',
    )
    expect(gauntletScript).toContain('npm run performance:capacity')
    expect(prePushHook).toContain('if [[ "$(uname -s)" == "Darwin" ]]')
    expect(prePushHook).toMatch(/^\s*exec npm run smoke:macos$/m)
    expect(prePushHook).not.toContain('smoke:macos:ci')
    expect(contributing).toContain('machine-dependent capacity evidence')
    expect(contributing).toContain('controlled-machine release gate')
  })

  it('passes one selected name into each hermetic unpackaged invocation', () => {
    expect(invocationScript).toContain(
      'HVIR_SMOKE_SCENARIO="${HVIR_SMOKE_SCENARIO:-legacy-workflow}"',
    )
    expect(invocationScript).toContain('HVIR_SMOKE_SOURCE_COMMIT="$source_commit"')
    expect(invocationScript).toContain('HVIR_SMOKE_SOURCE_DIRTY="$source_dirty"')
    expect(invocationScript).toContain('create-smoke-repository.sh')
    expect(invocationScript).toContain('unset ELECTRON_RENDERER_URL')
  })

  it('includes bounded attempt duration in real aggregate results', () => {
    expect(
      formatSmokeScenarioResults([
        {
          scenario: 'pty-native',
          iteration: 1,
          repetitionCount: 1,
          status: 'failed',
          exitCode: 1,
          durationMs: 1234.6,
        },
      ]),
    ).toContain('failed (exit 1 · 1235ms)')
  })

  it('proves failed and interrupted predecessors cannot affect clean successors', () => {
    expect(packageJson.scripts['smoke:isolation']).toContain(
      'node scripts/run-smoke-interruption.mts',
    )
    expect(invocationScript).toContain(
      "ownership_marker_value='hvir-smoke-owned-root-v1'",
    )
    expect(invocationScript).toContain("trap 'terminate_smoke 129' HUP")
    expect(invocationScript).toContain("trap 'terminate_smoke 130' INT")
    expect(invocationScript).toContain("trap 'terminate_smoke 143' TERM")
    expect(invocationScript).toContain('kill -s TERM "$smoke_pid"')
    expect(interruptionScript).toContain("action: 'fail'")
    expect(interruptionScript).toContain("handle.killGroup('SIGKILL')")
    expect(interruptionScript).toContain('cleanupOwnedSmokeRoot(killedWeb.root')
    expect(interruptionScript).toContain('const successors = await Promise.all(')
  })

  it('enters capacity before unrelated legacy profile and viewer assertions', () => {
    const branch = smokeWorkflow.indexOf("if (mode === 'capacity')")
    const recoveryRecords = smokeWorkflow.indexOf(
      'capacityRecoverySessions(supervisor, defaultHarnessProviderId)',
      branch,
    )
    const resetLoadFixtures = smokeWorkflow.indexOf(
      'supervisor.disposeSessions()',
      recoveryRecords,
    )
    const recovery = smokeWorkflow.indexOf(
      'await runCapacityRecoverySmoke',
      resetLoadFixtures,
    )
    expect(branch).toBeGreaterThan(-1)
    expect(branch).toBeLessThan(smokeWorkflow.indexOf('const profileSmoke'))
    expect(smokeWorkflow.indexOf("if (mode === 'capacity')", branch + 1)).toBe(-1)
    expect(recoveryRecords).toBeGreaterThan(branch)
    expect(resetLoadFixtures).toBeGreaterThan(recoveryRecords)
    expect(recovery).toBeGreaterThan(resetLoadFixtures)
    expect(capacityScenario).toContain('const CPU_SAMPLE_COUNT = 3')
    expect(capacityScenario).toContain('const TERMINAL_READINESS_SAMPLE_COUNT = 10')
    expect(capacityScenario).toContain('[smoke:capacity:contracts]')
    expect(capacityScenario).toContain('[smoke:performance:evidence]')
    expect(capacityScenario).toContain(
      'controlled capacity performance gate requires a clean checkout',
    )
    expect(capacityScenario).not.toContain('idleCpu.ratio > 1.5')
    expect(capacityPerformancePolicy).toContain('idleRendererPlusGpuRatio: 1.5')
    expect(capacityPerformancePolicy).toContain('terminalReadinessP95Ratio: 2')
    expect(capacityScenario).toContain('cpu.aggregateChildren.toFixed(3)')
    expect(capacityTerminalScenario).toContain('JSON.stringify(current)')
    expect(capacityTerminalScenario).toContain('current.surfaces === expected')
    expect(capacityTerminalScenario).toContain('actionStartedAtMs.push(Date.now())')
    expect(capacityTerminalScenario).toContain('ready-awaiting-input:%s')
    expect(capacityTerminalScenario).toContain('output.includes(awaitingInputMarker)')
    expect(capacityTerminalScenario).toContain('ready-input:%s')
    expect(capacityTerminalScenario).toContain('countOccurrences(output, marker) !== 1')
  })

  it('treats large-file frame latency as evidence beside a semantic preview contract', () => {
    expect(viewerContentScenario).toContain('first-frame evidence')
    expect(viewerContentScenario).toContain("meta.includes('preview')")
    expect(viewerContentScenario).not.toContain('large-file activation stalled paint')
  })

  it('waits for exact terminal focus instead of assuming a frame count', () => {
    const layoutFocusScenario = terminalPresentationScenario.slice(
      terminalPresentationScenario.indexOf('async function verifyTerminalLayoutFocus'),
      terminalPresentationScenario.indexOf(
        'async function verifyTerminalLaunchMenuOverflow',
      ),
    )
    expect(layoutFocusScenario).toContain("input.addEventListener('focus', finish)")
    expect(layoutFocusScenario).toContain('document.activeElement === input')
    expect(layoutFocusScenario).toContain('!document.hasFocus()')
    expect(layoutFocusScenario).toContain('input.focus()')
    expect(layoutFocusScenario).not.toContain('app.focus(')
    expect(layoutFocusScenario).not.toContain(
      'requestAnimationFrame(() => requestAnimationFrame(resolve))',
    )
  })

  it('observes the live PTY size after changing typography', () => {
    const typographyScenario = terminalPresentationScenario.slice(
      terminalPresentationScenario.indexOf('async function verifyLiveTerminalTypography'),
      terminalPresentationScenario.indexOf('async function focusTerminalEngine'),
    )
    expect(typographyScenario.indexOf('supervisor.attach')).toBeLessThan(
      typographyScenario.indexOf('settingsButton.click()'),
    )
    expect(typographyScenario).not.toContain('WINCH')
    expect(typographyScenario).toContain('queryCount')
    expect(typographyScenario.match(/stty size/g)).toHaveLength(1)
    expect(typographyScenario).not.toContain(
      'new Promise<void>((resolve) => setTimeout(resolve, 100))',
    )
    expect(typographyScenario).not.toContain('new Promise<RegExpMatchArray>')
  })

  it('owns reconnect, recovery, and destruction in a focused renderer lifecycle group', () => {
    const branch = smokeWorkflow.indexOf("if (mode === 'terminal-lifecycle')")
    const legacyWorkflow = smokeWorkflow.indexOf('const profileSmoke')
    expect(branch).toBeGreaterThan(-1)
    expect(branch).toBeLessThan(smokeWorkflow.indexOf('const profileSmoke'))
    expect(smokeWorkflow.slice(legacyWorkflow)).not.toContain(
      'verifyTerminalReconnectRemount',
    )
    expect(smokeWorkflow.slice(legacyWorkflow)).not.toContain(
      'verifyTerminalPresentationLifecycle',
    )
    expect(smokeWorkflow.slice(legacyWorkflow)).not.toContain(
      'verifyRendererRolloverRecovery',
    )
    expect(terminalRendererLifecycleScenario.indexOf('supervisor.attach')).toBeLessThan(
      terminalRendererLifecycleScenario.indexOf('supervisor.write'),
    )
    expect(terminalRendererLifecycleScenario).toContain('JSON.stringify({')
    expect(rendererLifecycleScenario.indexOf("once('did-finish-load'")).toBeLessThan(
      rendererLifecycleScenario.indexOf('win.webContents.reload()'),
    )
    expect(rendererLifecycleScenario.indexOf("once('destroyed'")).toBeLessThan(
      rendererLifecycleScenario.indexOf('win.destroy()'),
    )
    expect(rendererLifecycleScenario).not.toContain('WebPaneRouteRegistry')
    expect(rendererLifecycleScenario).not.toContain('routes.open')
  })

  it('enters the viewer group before legacy work with semantic diagnostics', () => {
    const branch = smokeWorkflow.indexOf("if (mode === 'viewer-position')")
    const focusedScenario = viewerPositionScenario.slice(
      viewerPositionScenario.indexOf('export function verifySourceDiffPosition'),
    )
    expect(branch).toBeGreaterThan(-1)
    expect(branch).toBeLessThan(smokeWorkflow.indexOf('const profileSmoke'))
    expect(focusedScenario).toContain('JSON.stringify(snapshot())')
    expect(focusedScenario).toContain('requestAnimationFrame(painted)')
    expect(focusedScenario).toContain('root.isConnected')
    expect(focusedScenario).not.toContain('setTimeout(')
  })

  it('runs viewer content and Git workflows independently with semantic diagnostics', () => {
    const viewerBranch = smokeWorkflow.indexOf("if (mode === 'viewer-content')")
    const gitBranch = smokeWorkflow.indexOf("if (mode === 'git-workflow')")
    const legacyWorkflow = smokeWorkflow.indexOf('const profileSmoke')
    expect(viewerBranch).toBeGreaterThan(-1)
    expect(gitBranch).toBeGreaterThan(viewerBranch)
    expect(gitBranch).toBeLessThan(legacyWorkflow)
    expect(smokeWorkflow.slice(legacyWorkflow)).not.toContain('verifyViewerContent')
    expect(smokeWorkflow.slice(legacyWorkflow)).not.toContain('verifyGitWorkflow')
    expect(viewerContentScenario).toContain('state=${JSON.stringify(state)}')
    expect(gitWorkflowScenario).toContain('state=${JSON.stringify(state)}')
    expect(viewerContentScenario).not.toContain(
      'requestAnimationFrame(() => requestAnimationFrame',
    )
    expect(gitWorkflowScenario).not.toContain('requestAnimationFrame')
    expect(viewerContentScenario).not.toMatch(/setTimeout\([^\n]*100\)/)
    expect(viewerPositionScenario).not.toContain("querySelector('.terminal-panel')")
    expect(viewerPositionScenario).toContain('cleanScroll')
    expect(viewerFindScenario).not.toContain("querySelector('.terminal-panel')")
    expect(viewerFindScenario).not.toContain(
      'requestAnimationFrame(() => requestAnimationFrame',
    )
  })

  it('runs workspace, web-pane, and renderer authority independently of legacy work', () => {
    const workspaceBranch = smokeWorkflow.indexOf("if (mode === 'workspace-remote')")
    const webPaneBranch = smokeWorkflow.indexOf("if (mode === 'web-pane')")
    const authorityBranch = smokeWorkflow.indexOf("if (mode === 'renderer-authority')")
    const legacyWorkflow = smokeWorkflow.indexOf('const profileSmoke')
    expect(workspaceBranch).toBeGreaterThan(-1)
    expect(webPaneBranch).toBeGreaterThan(workspaceBranch)
    expect(authorityBranch).toBeGreaterThan(webPaneBranch)
    expect(authorityBranch).toBeLessThan(legacyWorkflow)
    expect(smokeWorkflow.slice(legacyWorkflow)).not.toContain(
      'verifyWorkspaceRemoteWorkflow',
    )
    expect(smokeWorkflow.slice(legacyWorkflow)).not.toContain('verifyWebPaneWorkflow')
    expect(smokeWorkflow.slice(legacyWorkflow)).not.toContain(
      'verifyRendererAuthorityLifecycle',
    )

    expect(workspaceRemoteScenario).toContain('state=${JSON.stringify(state)}')
    expect(workspaceRemoteScenario).toContain('no PTY materialized')
    expect(workspaceRemoteScenario).not.toContain('requestAnimationFrame')
    expect(workspaceRemoteScenario).not.toContain('WebPaneRouteRegistry')
    expect(workspaceRemoteScenario).not.toContain('routes.open')
    expect(webPaneScenario).toContain('state=${JSON.stringify(state)}')
    expect(webPaneScenario).toContain('routes.source')
    expect(webPaneScenario).toContain('routes.paneIdForGuest')
    expect(webPaneScenario).not.toMatch(/setTimeout\(poll, 100\)/)
    expect(webPaneScenario).not.toMatch(/setTimeout\(poll, 300\)/)
    expect(rendererAuthorityScenario).toContain('state=${JSON.stringify(state)}')
    expect(rendererAuthorityScenario).toContain('ERR_UNKNOWN_URL_SCHEME')
    expect(rendererAuthorityScenario.indexOf("once('did-finish-load'")).toBeLessThan(
      rendererAuthorityScenario.indexOf('location.reload()'),
    )
    expect(rendererAuthorityScenario.indexOf("once('destroyed'")).toBeLessThan(
      rendererAuthorityScenario.indexOf('win.destroy()'),
    )
  })

  it('enters platform contracts before legacy work with bounded semantic snapshots', () => {
    const branch = smokeWorkflow.indexOf("mode === 'platform-contracts'")
    const platformScenario = readFileSync(
      new URL('../src/main/smoke/platform-contracts.ts', import.meta.url),
      'utf8',
    )
    expect(branch).toBeGreaterThan(-1)
    expect(branch).toBeLessThan(smokeWorkflow.indexOf('const profileSmoke'))
    expect(platformScenario).toContain('JSON.stringify(lastSnapshot)')
    expect(platformScenario).toContain('protocol.isProtocolHandled')
    expect(platformScenario).toContain('net.fetch(preview.url)')
    expect(platformScenario).toContain('supervisor.list()')
    expect(platformScenario).not.toContain('requestAnimationFrame')
  })

  it('documents every selectable group and the aggregate result behavior', () => {
    for (const scenario of ELECTRON_SMOKE_SCENARIOS) {
      expect(contributing).toContain(`\`${scenario}\``)
    }
    expect(contributing).toMatch(/reports a result for\s+every scheduled group/)
  })
})
