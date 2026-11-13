import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  nativePresenterReceiptMatches,
  runNativeElectronProbe,
} from '../scripts/native-terminal/run-electron-probe.mts'

const directories: string[] = []
async function fixture(mode: string) {
  const directory = await mkdtemp(join(tmpdir(), 'hvir-native-probe-process-'))
  directories.push(directory)
  const entry = join(directory, 'fixture.cjs')
  const library = join(directory, 'configuration.json')
  const pids = join(directory, 'pids.json')
  await writeFile(library, JSON.stringify({ mode, pids }))
  await writeFile(
    entry,
    `
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const config = JSON.parse(fs.readFileSync(process.argv.find(v => v.startsWith('--library=')).slice(10), 'utf8'));
const proof = { nativeUtilityBoundary: 'passed', mainPid: process.pid, utilityPid: process.pid + 1,
  platform: process.platform, arch: process.arch, hardwareGpuQualified: false, orientationQualified: false,
  receiverSandboxed: true, receiverContextIsolated: true, realGhostty: true,
  receivedOzone: process.argv.filter(v=>v.startsWith('--ozone-platform=')),
  receivedNoSandbox: process.argv.includes('--no-sandbox'),
  selectedOzoneEnvironment: process.env.HVIR_NATIVE_TERMINAL_OZONE };
if (config.mode === 'hang' || config.mode === 'orphan') {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 1, 2] });
  fs.writeFileSync(config.pids, JSON.stringify({ parent: process.pid, child: child.pid }));
  if (config.mode === 'orphan') { console.log(JSON.stringify(proof)); process.exit(0); }
  setInterval(() => {}, 1000);
} else if (config.mode === 'missing') process.exit(0);
else if (config.mode === 'wrong-pid') { proof.mainPid++; console.log(JSON.stringify(proof)); }
else if (config.mode === 'bad-sandbox') { proof.receiverSandboxed = false; console.log(JSON.stringify(proof)); }
else if (config.mode === 'uncaught') { console.error('native-probe:uncaught {}'); console.log(JSON.stringify(proof)); }
else if (config.mode === 'nonzero') { console.log(JSON.stringify(proof)); process.exitCode = 2; }
else { console.log(JSON.stringify(proof)); if (config.mode === 'duplicate') console.log(JSON.stringify(proof)); }
`,
  )
  return { library, entry, pids }
}
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}
function killFixtureGroup(pid: number): void {
  try {
    process.kill(-pid, 'SIGKILL')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
}
const diagnostics: unknown[][] = []
beforeEach(() => {
  vi.stubEnv('HVIR_NATIVE_TERMINAL_OZONE', undefined)
  diagnostics.length = 0
  vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => {
    diagnostics.push(values)
  })
})
afterEach(async () => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
  for (const [name, value] of diagnostics) {
    expect(['native-probe:owned-group', 'native-probe:process-exit']).toContain(name)
    const record = JSON.parse(String(value)) as {
      leader?: number
      pid?: number
      members?: { group: number }[]
    }
    if (name === 'native-probe:owned-group') {
      expect(record.leader).toBeGreaterThan(0)
      expect(record.members?.every((member) => member.group === record.leader)).toBe(true)
    } else expect(record.pid).toBeGreaterThan(0)
  }
})
describe('native Electron probe process containment', () => {
  it.each(['hang', 'orphan'])(
    'bounds %s and kills only the owned process group',
    async (mode) => {
      const files = await fixture(mode)
      const started = performance.now()
      await expect(
        runNativeElectronProbe(files.library, {
          binary: process.execPath,
          entry: files.entry,
          timeoutMs: 500,
        }),
      ).rejects.toThrow()
      expect(performance.now() - started).toBeLessThan(3000)
      const pids = JSON.parse(await readFile(files.pids, 'utf8')) as {
        parent: number
        child: number
      }
      // Kernel reaping is asynchronous; allow a bounded interval after SIGKILL.
      const deadline = performance.now() + 2000
      while ((alive(pids.parent) || alive(pids.child)) && performance.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 10))
      expect(alive(pids.parent)).toBe(false)
      expect(alive(pids.child)).toBe(false)
      expect(alive(process.pid)).toBe(true)
    },
  )
  it.each(['SIGINT', 'SIGTERM'] as const)(
    'cleans its owned children when an external wrapper receives %s',
    async (signal) => {
      const files = await fixture('hang')
      const wrapperPath = join(files.library, '..', 'wrapper.mjs')
      const moduleUrl = new URL(
        '../scripts/native-terminal/run-electron-probe.mts',
        import.meta.url,
      ).href
      await writeFile(
        wrapperPath,
        `
import { nativePresenterReceiptMatches, runNativeElectronProbe } from ${JSON.stringify(moduleUrl)};
try {
  await runNativeElectronProbe(${JSON.stringify(files.library)}, {
    binary: process.execPath, entry: ${JSON.stringify(files.entry)}, timeoutMs: 75000,
  });
} catch (error) {
  process.stderr.write(String(error) + '\\n');
  process.exitCode = 1;
}
`,
      )
      const wrapper = spawn(process.execPath, [wrapperPath], {
        stdio: ['ignore', 'ignore', 'pipe'],
      })
      let stderr = ''
      wrapper.stderr.on('data', (data: Buffer) => {
        stderr += data.toString('utf8')
      })
      const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve, reject) => {
          wrapper.once('error', reject)
          wrapper.once('close', (code, receivedSignal) =>
            resolve({ code, signal: receivedSignal }),
          )
        },
      )
      let pids: { parent: number; child: number } | undefined
      let deadlineTimer: NodeJS.Timeout | undefined
      try {
        const deadline = performance.now() + 2000
        while (!pids && performance.now() < deadline) {
          pids = await readFile(files.pids, 'utf8')
            .then((value) => JSON.parse(value) as { parent: number; child: number })
            .catch((error: unknown) => {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
              return undefined
            })
          if (!pids) await new Promise((resolve) => setTimeout(resolve, 10))
        }
        expect(pids).toBeDefined()
        expect(wrapper.kill(signal)).toBe(true)
        const outcome = await Promise.race([
          closed,
          new Promise<never>((_, reject) => {
            deadlineTimer = setTimeout(
              () => reject(new Error('external wrapper did not stop')),
              2000,
            )
          }),
        ])
        expect(outcome).toEqual({ code: 1, signal: null })
        expect(stderr).toContain(signal)
        const reapDeadline = performance.now() + 2000
        while (
          (alive(pids!.parent) || alive(pids!.child)) &&
          performance.now() < reapDeadline
        )
          await new Promise((resolve) => setTimeout(resolve, 10))
        expect(alive(pids!.parent)).toBe(false)
        expect(alive(pids!.child)).toBe(false)
        expect(alive(process.pid)).toBe(true)
      } finally {
        if (deadlineTimer) clearTimeout(deadlineTimer)
        wrapper.kill('SIGKILL')
        // Only the fixture-reported probe PGID belongs to this test. Never signal
        // the wrapper's inherited process group (which includes the test host).
        if (pids) killFixtureGroup(pids.parent)
        wrapper.stderr.destroy()
        wrapper.unref()
      }
    },
  )

  it('accepts one isolated receipt tied to the actual successful main process', async () => {
    const files = await fixture('success')
    const proof = await runNativeElectronProbe(files.library, {
      binary: process.execPath,
      entry: files.entry,
      timeoutMs: 2000,
    })
    expect(proof).toMatchObject({ nativeUtilityBoundary: 'passed', realGhostty: true })
    expect(proof.mainPid).not.toBe(process.pid)
  })
  it.each(['missing', 'duplicate', 'wrong-pid', 'bad-sandbox', 'nonzero', 'uncaught'])(
    'refuses %s proof',
    async (mode) => {
      const files = await fixture(mode)
      await expect(
        runNativeElectronProbe(files.library, {
          binary: process.execPath,
          entry: files.entry,
          timeoutMs: 2000,
        }),
      ).rejects.toThrow()
    },
  )
})

it('preserves deadline cleanup when the diagnostic sink throws', async () => {
  const files = await fixture('hang')
  vi.mocked(console.error).mockImplementation(() => {
    throw new Error('diagnostic-sink-failed')
  })
  await expect(
    runNativeElectronProbe(files.library, {
      binary: process.execPath,
      entry: files.entry,
      timeoutMs: 500,
    }),
  ).rejects.toThrow('deadline')
  const pids = JSON.parse(await readFile(files.pids, 'utf8')) as {
    parent: number
    child: number
  }
  const deadline = performance.now() + 2000
  while ((alive(pids.parent) || alive(pids.child)) && performance.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10))
  expect(alive(pids.parent)).toBe(false)
  expect(alive(pids.child)).toBe(false)
})

describe('native presenter receipt mode fidelity', () => {
  const pixels = {
    nativePresenter: 'passed',
    finalUtilityExit: true,
    requestedPresentation: 'auto',
    mode: 'native-pixels',
    frameCopies: 2,
    routineGpuReadbacks: null,
    compatibilityBoundRefused: true,
    maximumCompatibilityUploadBytes: 16 * 1024 * 1024,
  }
  it('accepts actual Linux compatibility under auto without relabelling it GPU', () => {
    expect(nativePresenterReceiptMatches(pixels, 'auto', 'linux')).toBe(true)
    expect(nativePresenterReceiptMatches(pixels, 'auto', 'darwin')).toBe(false)
    expect(
      nativePresenterReceiptMatches(
        { ...pixels, requestedPresentation: 'pixels' },
        'pixels',
        'linux',
      ),
    ).toBe(true)
    expect(
      nativePresenterReceiptMatches({ ...pixels, frameCopies: 0 }, 'auto', 'linux'),
    ).toBe(false)
    expect(
      nativePresenterReceiptMatches(
        { ...pixels, compatibilityBoundRefused: false },
        'auto',
        'linux',
      ),
    ).toBe(false)
  })
  it('rejects a GPU claim when explicit pixels or any readback was observed', () => {
    const gpu = {
      ...pixels,
      mode: 'native-gpu',
      frameCopies: 0,
      routineGpuReadbacks: 0,
      nativePixelFrames: 0,
    }
    expect(nativePresenterReceiptMatches(gpu, 'auto', 'linux')).toBe(true)
    expect(
      nativePresenterReceiptMatches(
        { ...gpu, requestedPresentation: 'pixels' },
        'pixels',
        'linux',
      ),
    ).toBe(false)
    expect(
      nativePresenterReceiptMatches({ ...gpu, routineGpuReadbacks: 1 }, 'auto', 'linux'),
    ).toBe(false)
    expect(
      nativePresenterReceiptMatches({ ...gpu, frameCopies: 1 }, 'auto', 'linux'),
    ).toBe(false)
    expect(
      nativePresenterReceiptMatches({ ...gpu, nativePixelFrames: 1 }, 'auto', 'linux'),
    ).toBe(false)
  })
})

describe('contained native qualification Ozone forwarding', () => {
  it.each(['x11', 'wayland'] as const)(
    'forwards only explicit %s without changing sandbox flags',
    async (backend) => {
      const files = await fixture('success')
      const proof = await runNativeElectronProbe(
        files.library,
        {
          binary: process.execPath,
          entry: files.entry,
          timeoutMs: 2000,
        },
        undefined,
        backend,
      )
      expect(proof.receivedOzone).toEqual([`--ozone-platform=${backend}`])
      expect(proof.selectedOzoneEnvironment).toBe(backend)
      expect(proof.receivedNoSandbox).toBe(false)
    },
  )
  it('rejects an arbitrary backend before creating a child', async () => {
    const files = await fixture('success')
    await expect(
      runNativeElectronProbe(
        files.library,
        {
          binary: process.execPath,
          entry: files.entry,
          timeoutMs: 2000,
        },
        undefined,
        'headless' as 'x11',
      ),
    ).rejects.toThrow('Ozone must be x11|wayland')
  })
  it('refuses an arbitrary smoke backend before acquiring resources', () => {
    const result = spawnSync(
      'bash',
      [fileURLToPath(new URL('../scripts/run-smoke.sh', import.meta.url))],
      {
        env: {
          ...process.env,
          HVIR_SMOKE_SCENARIO: 'native-terminal-workbench',
          HVIR_NATIVE_TERMINAL_OZONE: 'headless',
        },
        timeout: 2000,
        maxBuffer: 65536,
        encoding: 'utf8',
      },
    )
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(
      'requires Linux native-terminal-workbench and x11|wayland',
    )
  })
})
