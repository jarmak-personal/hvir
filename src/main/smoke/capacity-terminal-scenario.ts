import { createHash } from 'node:crypto'
import type { BrowserWindow } from 'electron'
import {
  dirnameHostPath,
  joinHostPath,
  localPath,
  type HostPath,
} from '../../shared/host-path'
import type { LocalHost } from '../project-host'
import type { PtySupervisor } from '../pty/pty-supervisor'
import type { NativeTerminalApplication } from '../terminal/native-terminal-application'
import { runCapacityTerminalPairedProcess } from './capacity-terminal-pair'
import {
  CAPACITY_TERMINAL_COMPARISON_COUNTS,
  CAPACITY_TERMINAL_COMPARISON_ORDER,
  type CapacityTerminalPassedProcess,
} from './capacity-terminal-comparison'

const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex')
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('capacity-pair-identity-object')
  return value as Record<string, unknown>
}
const text = (value: unknown): string => {
  if (typeof value !== 'string' || value.length < 1 || value.length > 200)
    throw new Error('capacity-pair-identity-text')
  return value
}
const sha = (value: unknown): string => {
  const result = text(value)
  if (!/^[a-f0-9]{40}([a-f0-9]{24})?$/.test(result))
    throw new Error('capacity-pair-identity-sha')
  return result
}

/** Closed contributor-only protocol; application I/O stays behind ProjectHost. */
export async function runCapacityTerminalComparisonScenario(
  win: BrowserWindow,
  supervisor: PtySupervisor,
  host: LocalHost,
  liveReloadPath: HostPath,
  native?: NativeTerminalApplication,
): Promise<boolean> {
  const rawIndex = process.env['HVIR_CAPACITY_COMPARISON_INDEX']
  const keys = ['RUN_ID', 'INDEX', 'RESULT', 'REFRESH_HZ']
  if (keys.every((key) => process.env['HVIR_CAPACITY_COMPARISON_' + key] === undefined))
    return false
  const runId = process.env['HVIR_CAPACITY_COMPARISON_RUN_ID']
  const resultPath = process.env['HVIR_CAPACITY_COMPARISON_RESULT']
  const refreshHz = Number(process.env['HVIR_CAPACITY_COMPARISON_REFRESH_HZ'])
  if (
    !rawIndex ||
    !/^[0-7]$/.test(rawIndex) ||
    !runId ||
    !/^[a-f0-9-]{36}$/.test(runId) ||
    !resultPath?.startsWith('/') ||
    !Number.isFinite(refreshHz) ||
    refreshHz <= 0 ||
    process.env['HVIR_CAPACITY_PERFORMANCE_GATE'] !== 'controlled' ||
    process.env['HVIR_CAPACITY_OBSERVATION'] !== undefined
  )
    throw new Error('capacity-pair-invocation-contract')
  const index = Number(rawIndex)
  const destination = localPath(resultPath)
  const parent = object(
    JSON.parse(
      (
        await host.readFile(
          joinHostPath(dirnameHostPath(destination), 'source-identity.json'),
        )
      ).toString(),
    ) as unknown,
  )
  const runtime = object(parent.runtimeBuild)
  const sourceSha = sha(parent.sourceSha)
  if (
    process.env['HVIR_SMOKE_SOURCE_DIRTY'] !== '0' ||
    process.env['HVIR_SMOKE_SOURCE_COMMIT'] !== sourceSha
  )
    throw new Error('capacity-pair-clean-source-identity')
  const frontendSha = sha(runtime.frontendSha256)
  const lockfileSha = sha(parent.lockfileSha256)
  const artifact = native
    ? {
        sha256: sha(parent.nativeLibrarySha256),
        coreVersion:
          text(object(parent.nativeSdk).applicationVersion) +
          '/vt-' +
          text(object(parent.nativeSdk).vtVersion),
        build: text(object(parent.nativeSdk).source),
      }
    : {
        sha256: frontendSha,
        coreVersion: text(parent.webVersion),
        build: sourceSha,
      }
  const observed = await runCapacityTerminalPairedProcess({
    win,
    supervisor,
    host,
    liveReloadPath,
    native,
    index,
    runId,
    refreshHz,
    retainObservations: (observations) =>
      host.writeFile(
        localPath(resultPath + '.observations.json'),
        JSON.stringify(observations, null, 2) + '\n',
      ),
  })
  const layout = observed.layout
  const result = {
    ...observed,
    status: 'passed' as const,
    engine: CAPACITY_TERMINAL_COMPARISON_ORDER[index]!,
    artifact,
    runtimeEnvironment: {
      versions: {
        electron: process.versions.electron,
        chromium: process.versions.chrome,
        node: process.versions.node,
      },
      platform: process.platform,
      architecture: process.arch,
      buildChannel: 'smoke',
      requestedRefreshHz: refreshHz,
      launchFlags: process.argv.filter(
        (value) =>
          value === '--no-sandbox' ||
          value === '--ozone-platform=x11' ||
          value === '--ozone-platform=wayland',
      ),
      productionSandboxQualified: false,
    },
    identity: {
      sourceSha,
      configurationSha: digest({
        frontendSha,
        lockfileSha,
        paneWidth: 820,
        window: [1283, 800],
        fontSize: layout.fontSize,
        refreshHz: observed.refreshHz,
        backingScale: layout.scale,
        presentation: parent.presentation,
        ozone: parent.ozone,
      }),
      workloadSha: digest({
        rows: 3000,
        counts: CAPACITY_TERMINAL_COMPARISON_COUNTS,
        warmups: 10,
        observer: 'compositor-tags-v2',
        bitsPerPayloadCell: 2,
        tagCells: 27,
        semanticRounds: 300,
      }),
      topologySha: digest({
        steadyLive: 12,
        taggedActor: 0,
        hiddenPlain: 1,
        ansi: 2,
        synchronized: 9,
        temporaryReadinessProbes: 10,
      }),
      observationMethod: 'BrowserWindow.capturePage:synthetic-terminal-tag-v2' as const,
      refreshHz: observed.refreshHz,
      rows: layout.rows,
      columns: layout.columns,
      fontSize: layout.fontSize,
      cssWidth: layout.paneWidth,
      cssHeight: layout.paneHeight,
      backingScale: layout.scale,
    },
  }
  result satisfies CapacityTerminalPassedProcess
  await host.writeFile(destination, JSON.stringify(result, null, 2) + '\n')
  return true
}
