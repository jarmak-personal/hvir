import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import {
  capacityComparisonEnvironment,
  captureCapacityComparisonBuildIdentity,
  parseCapacityComparisonArguments,
  runCapacityTerminalComparison,
} from '../scripts/run-capacity-terminal-comparison.mts'
import { CAPACITY_TERMINAL_COMPARISON_ORDER } from '../src/main/smoke/capacity-terminal-comparison'

async function attempt() {
  const root = await mkdtemp(join(tmpdir(), 'hvir-comparison-runner-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  return {
    output: join(root, 'attempt'),
    nativeLibrary: '/candidate/library.dylib',
    refreshHz: 120,
  }
}

interface StoredRecord {
  status: string
  index: number
  slots: { status: string; outcome: { exitCode: number } }[]
  submitted: { failure: string }[]
}
async function json(path: string): Promise<StoredRecord> {
  return JSON.parse(await readFile(path, 'utf8')) as StoredRecord
}

describe('capacity comparison process adapter', () => {
  it('accepts only an explicit fresh absolute destination, library and positive refresh', () => {
    expect(
      parseCapacityComparisonArguments([
        '--output',
        '/new/attempt',
        '--native-library',
        '/candidate/lib.so',
        '--refresh-hz',
        '144.5',
      ]),
    ).toEqual({
      output: '/new/attempt',
      nativeLibrary: '/candidate/lib.so',
      refreshHz: 144.5,
    })
    for (const args of [
      [],
      ['--output', 'relative'],
      ['--output', '/out', '--native-library', '/lib', '--refresh-hz', 'Infinity'],
      ['--output', '/out', '--native-library', '/lib', '--refresh-hz', '0'],
      [
        '--output',
        '/out',
        '--native-library',
        '/lib',
        '--refresh-hz',
        '60',
        '--output',
        '/again',
      ],
    ])
      expect(() => parseCapacityComparisonArguments(args)).toThrow('invalid-arguments')
  })

  it('selects only the scheduled engine and rejects official-series diagnostics', async () => {
    const options = await attempt()
    const ambient = {
      HVIR_NATIVE_TERMINAL_LIBRARY: '/old/lib',
      HVIR_SMOKE_REPEAT: '42',
      HVIR_CAPACITY_COMPARISON_INDEX: '99',
      HVIR_NATIVE_TERMINAL_OZONE: 'wayland',
      MY_APP_CDP_METRICS: 'unrelated',
    }
    const web = capacityComparisonEnvironment(ambient, options, 'run', 0)
    const native = capacityComparisonEnvironment(ambient, options, 'run', 1)
    expect(web.HVIR_NATIVE_TERMINAL_LIBRARY).toBeUndefined()
    expect(web.HVIR_SMOKE_REPEAT).toBeUndefined()
    expect(native.HVIR_NATIVE_TERMINAL_LIBRARY).toBe(options.nativeLibrary)
    expect(web.HVIR_NATIVE_TERMINAL_OZONE).toBe('wayland')
    expect(web.HVIR_CAPACITY_COMPARISON_INDEX).toBe('0')
    expect(web.HVIR_CAPACITY_PERFORMANCE_GATE).toBe('controlled')
    for (const key of [
      'HVIR_NATIVE_IMPORT_DIAGNOSTICS',
      'HVIR_NATIVE_IMPORT_DIAGNOSTIC_WINDOW',
      'HVIR_NATIVE_TERMINAL_TRACE_CONFIG',
      'HVIR_CAPACITY_OBSERVATION',
      'HVIR_NATIVE_TERMINAL',
      'HVIR_DEVTOOLS',
      'HVIR_CDP_PORT',
      'NODE_OPTIONS',
    ]) {
      expect(() =>
        capacityComparisonEnvironment({ [key]: '' }, options, 'run', 0),
      ).toThrow()
    }
    expect(() =>
      capacityComparisonEnvironment(
        { HVIR_NATIVE_TERMINAL_PRESENTATION: 'pixels' },
        options,
        'run',
        0,
      ),
    ).toThrow()
  })

  it('awaits all eight owned attempts and preserves failed children, missing and wrong-slot results', async () => {
    const options = await attempt()
    const engines: string[] = []
    let active = false
    const result = await runCapacityTerminalComparison(
      { ...options, environment: {} },
      {
        invoke: async (scenario, iteration, total, invocation) => {
          expect(active).toBe(false)
          active = true
          expect([scenario, iteration, total]).toEqual([
            'capacity',
            engines.length + 1,
            8,
          ])
          const env = invocation!.environment!
          engines.push(env.HVIR_NATIVE_TERMINAL_LIBRARY ? 'native' : 'web')
          const index = iteration - 1
          if (index !== 2)
            await writeFile(
              env.HVIR_CAPACITY_COMPARISON_RESULT!,
              JSON.stringify({
                index: index === 3 ? 99 : index,
                pair: Math.floor(index / 2),
                engine: CAPACITY_TERMINAL_COMPARISON_ORDER[index],
                status: 'failed',
                failure: 'fixture-failed',
              }),
            )
          await Promise.resolve()
          active = false
          return {
            status: index === 1 ? 'failed' : 'passed',
            exitCode: index === 1 ? 9 : 0,
          }
        },
      },
    )
    expect(engines).toEqual(CAPACITY_TERMINAL_COMPARISON_ORDER)
    expect(result.timingPassed).toBe(false)
    const aggregate = await json(join(options.output, 'comparison.json'))
    expect(aggregate.submitted).toHaveLength(8)
    expect(aggregate.submitted[1]!.failure).toBe('child-failed')
    expect(aggregate.submitted[2]!.failure).toBe('missing-or-invalid-process-result')
    expect(aggregate.submitted[3]!.failure).toBe('missing-or-invalid-process-result')
    expect((await json(join(options.output, 'process-3.json'))).index).toBe(99)
    const invocation = await json(join(options.output, 'invocation.json'))
    expect(invocation.status).toBe('completed')
    expect(invocation.slots[1]!.outcome.exitCode).toBe(9)
    expect(
      invocation.slots.every((slot: { status: string }) => slot.status === 'completed'),
    ).toBe(true)
  })

  it('stops on a changed candidate while retaining the completed failure and pending slots', async () => {
    const options = await attempt()
    let unchanged = true
    let count = 0
    const result = await runCapacityTerminalComparison(
      { ...options, environment: {} },
      {
        candidateUnchanged: () => Promise.resolve(unchanged),
        invoke: () => {
          count++
          unchanged = false
          return Promise.resolve({ status: 'passed' as const, exitCode: 0 })
        },
      },
    )
    expect(count).toBe(1)
    expect(result.timingPassed).toBe(false)
    const record = await json(join(options.output, 'invocation.json'))
    expect(record.status).toBe('unsafe-environment')
    expect(record.slots[0]!.status).toBe('completed')
    expect(
      record.slots
        .slice(1)
        .every((slot: { status: string }) => slot.status === 'pending'),
    ).toBe(true)
    const aggregate = await json(join(options.output, 'comparison.json'))
    expect(aggregate.submitted[0]!.failure).toBe('candidate-changed')
  })

  it('leaves unscheduled slots pending after interruption and refuses an existing destination', async () => {
    const options = await attempt()
    const controller = new AbortController()
    let count = 0
    await runCapacityTerminalComparison(
      { ...options, environment: {}, interruptionSignal: controller.signal },
      {
        invoke: (_scenario, _iteration, _total, invocation) => {
          count++
          expect(invocation?.interruptionSignal).toBe(controller.signal)
          controller.abort()
          return Promise.resolve({
            status: 'failed' as const,
            signal: 'SIGTERM' as const,
          })
        },
      },
    )
    expect(count).toBe(1)
    const before = await readFile(join(options.output, 'invocation.json'), 'utf8')
    const record = JSON.parse(before) as StoredRecord
    expect(record.status).toBe('interrupted')
    expect(
      record.slots
        .slice(1)
        .every((slot: { status: string }) => slot.status === 'pending'),
    ).toBe(true)
    await expect(
      runCapacityTerminalComparison({ ...options, environment: {} }),
    ).rejects.toThrow()
    expect(await readFile(join(options.output, 'invocation.json'), 'utf8')).toBe(before)
  })
})

async function runtimeBuildFixture() {
  const root = await mkdtemp(join(tmpdir(), 'hvir-comparison-build-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  for (const path of [
    'out/main/index.js',
    'out/main/chunks/utility-host.js',
    'out/preload/index.js',
    'out/renderer/index.html',
    'out/renderer/assets/workbench.js',
    'packages/native-terminal/build/Release/bindings.json',
    'packages/native-terminal/build/Release/native_terminal_engine.node',
    'packages/native-terminal/build/Release/native_terminal_resource.node',
  ]) {
    const directory = path.slice(0, path.lastIndexOf('/'))
    await mkdir(join(root, directory), { recursive: true })
    await writeFile(join(root, path), 'initial-build-bytes')
  }
  return root
}

describe('capacity comparison actual runtime build identity', () => {
  it.each([
    'out/main/chunks/utility-host.js',
    'out/preload/index.js',
    'out/renderer/assets/workbench.js',
    'packages/native-terminal/build/Release/native_terminal_engine.node',
    'packages/native-terminal/build/Release/native_terminal_resource.node',
    'packages/native-terminal/build/Release/bindings.json',
  ])(
    'stops the series when %s changes while the main entrypoint remains identical',
    async (changed) => {
      const root = await runtimeBuildFixture()
      const options = await attempt()
      const entrypoint = await readFile(join(root, 'out/main/index.js'), 'utf8')
      const initial = await captureCapacityComparisonBuildIdentity(root)
      let count = 0
      const result = await runCapacityTerminalComparison(
        { ...options, environment: {} },
        {
          candidateUnchanged: async () =>
            JSON.stringify(await captureCapacityComparisonBuildIdentity(root)) ===
            JSON.stringify(initial),
          invoke: async () => {
            count++
            await writeFile(join(root, changed), 'changed-runtime-bytes')
            return { status: 'passed', exitCode: 0 }
          },
        },
      )
      expect(await readFile(join(root, 'out/main/index.js'), 'utf8')).toBe(entrypoint)
      expect(count).toBe(1)
      expect(result.timingPassed).toBe(false)
      const record = await json(join(options.output, 'invocation.json'))
      expect(record.status).toBe('unsafe-environment')
      expect(
        record.slots
          .slice(1)
          .every((slot: { status: string }) => slot.status === 'pending'),
      ).toBe(true)
      expect(
        (await json(join(options.output, 'comparison.json'))).submitted[0]!.failure,
      ).toBe('candidate-changed')
    },
  )

  it('keeps the same canonical byte manifests across all eight unchanged processes', async () => {
    const root = await runtimeBuildFixture()
    const options = await attempt()
    const initial = await captureCapacityComparisonBuildIdentity(root)
    const snapshots: string[] = []
    let count = 0
    await runCapacityTerminalComparison(
      { ...options, environment: {} },
      {
        candidateUnchanged: async () => {
          const current = JSON.stringify(
            await captureCapacityComparisonBuildIdentity(root),
          )
          snapshots.push(current)
          return current === JSON.stringify(initial)
        },
        invoke: () => {
          count++
          return Promise.resolve({ status: 'failed' as const, exitCode: 1 })
        },
      },
    )
    expect(count).toBe(8)
    expect(snapshots).toHaveLength(16)
    expect(new Set(snapshots).size).toBe(1)
    expect(initial.frontendSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(initial.components).toHaveLength(4)
    expect(JSON.stringify(initial)).not.toContain('initial-build-bytes')
    expect(
      initial.components
        .flatMap((component) => component.files)
        .every((file) => !file.path.startsWith('/')),
    ).toBe(true)
  })

  it('detects new files and refuses missing entrypoints and escaping symlinks', async () => {
    const root = await runtimeBuildFixture()
    const initial = await captureCapacityComparisonBuildIdentity(root)
    await writeFile(join(root, 'out/renderer/extra.js'), 'unexpected-build-file')
    expect(await captureCapacityComparisonBuildIdentity(root)).not.toEqual(initial)
    await rm(join(root, 'out/renderer/index.html'))
    await expect(captureCapacityComparisonBuildIdentity(root)).rejects.toThrow(
      'missing-runtime-build-file',
    )
    await writeFile(join(root, 'out/renderer/index.html'), 'restored')
    await symlink('/etc/passwd', join(root, 'out/main/escape.js'))
    await expect(captureCapacityComparisonBuildIdentity(root)).rejects.toThrow(
      'invalid-runtime-build-file',
    )
    await rm(join(root, 'out/main/escape.js'))
    await rm(join(root, 'out/preload'), { recursive: true })
    await symlink('/tmp', join(root, 'out/preload'))
    await expect(captureCapacityComparisonBuildIdentity(root)).rejects.toThrow(
      'invalid-runtime-build-directory',
    )
  })
})
