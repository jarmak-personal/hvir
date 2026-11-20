import { afterEach, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let root: string | undefined
let wrapper: ChildProcess | undefined
let childPid: number | undefined
function stopGroup(pid: number | undefined) {
  if (!pid) return
  try {
    process.kill(-pid, 'SIGKILL')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
}
afterEach(async () => {
  stopGroup(wrapper?.pid)
  stopGroup(childPid)
  if (root) await rm(root, { recursive: true, force: true })
})

it.each(['SIGINT', 'SIGHUP'] as const)(
  'forwards terminal %s once and waits for tool cleanup',
  async (signal) => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'hvir-native-setup-signal-')))
    const receipt = join(root, 'cleanup.json')
    const tool = `
    const fs = require('node:fs');
    let signals = 0;
    const stop = () => {
      signals++;
      setTimeout(() => {
        fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ signals, cleanup: true }));
        process.exit(0);
      }, 50);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    setInterval(() => {}, 1000);
    console.log('READY:' + process.pid);
  `
    const entry = join(root, 'wrapper.mjs')
    await writeFile(
      entry,
      `
    import { runDevelopmentProcess } from ${JSON.stringify(new URL('../scripts/native-terminal/development-process.mts', import.meta.url).href)};
    runDevelopmentProcess(['-e', ${JSON.stringify(tool)}], ${JSON.stringify(root)})
      .then(() => { process.exitCode = 0; }, () => { process.exitCode = 3; });
  `,
    )
    wrapper = spawn(process.execPath, [entry], {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const exited = new Promise<number | null>((resolve, reject) => {
      wrapper!.once('error', reject)
      wrapper!.once('exit', resolve)
    })
    await new Promise<void>((resolve, reject) => {
      let output = ''
      const timeout = setTimeout(
        () => reject(new Error('Signal fixture did not become ready')),
        5000,
      )
      wrapper!.stdout!.on('data', (chunk: Buffer) => {
        output += chunk.toString()
        const match = output.match(/READY:(\d+)/)
        if (match) {
          childPid = Number(match[1])
          clearTimeout(timeout)
          resolve()
        }
      })
      wrapper!.once('error', (error) => {
        clearTimeout(timeout)
        reject(error)
      })
    })
    // Emulate the terminal sending Ctrl-C to the foreground process group. The tool
    // has its own group and receives exactly the one signal forwarded by its owner.
    process.kill(-wrapper.pid!, signal)
    expect(await exited).toBe(3)
    expect(JSON.parse(await readFile(receipt, 'utf8'))).toEqual({
      signals: 1,
      cleanup: true,
    })
    expect(() => process.kill(childPid!, 0)).toThrow()
  },
  10000,
)
