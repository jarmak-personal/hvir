import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runNativeElectronProbe } from '../scripts/native-terminal/run-electron-probe.mts'

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
  receiverSandboxed: true, receiverContextIsolated: true, realGhostty: true };
if (config.mode === 'hang' || config.mode === 'orphan') {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 1, 2] });
  fs.writeFileSync(config.pids, JSON.stringify({ parent: process.pid, child: child.pid }));
  if (config.mode === 'orphan') { console.log(JSON.stringify(proof)); process.exit(0); }
  setInterval(() => {}, 1000);
} else if (config.mode === 'missing') process.exit(0);
else if (config.mode === 'wrong-pid') { proof.mainPid++; console.log(JSON.stringify(proof)); }
else if (config.mode === 'bad-sandbox') { proof.receiverSandboxed = false; console.log(JSON.stringify(proof)); }
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
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
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
import { runNativeElectronProbe } from ${JSON.stringify(moduleUrl)};
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
  it.each(['missing', 'duplicate', 'wrong-pid', 'bad-sandbox', 'nonzero'])(
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
