import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
  readdir,
  utimes,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { expect, it, onTestFinished } from 'vitest'

const moduleUrl = pathToFileURL(resolve('scripts/smoke-run-lock.mts')).href

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'hvir-smoke-lock-test-'))
  const target = join(root, 'desktop')
  const launcher = join(root, 'launcher.mts')
  await writeFile(
    launcher,
    `import { runSmokeLocked } from ${JSON.stringify(moduleUrl)}
runSmokeLocked(process.execPath, process.argv.slice(2), ${JSON.stringify(target)}).catch(e => {
 console.error(e.message); process.exitCode = 1
})`,
  )
  const children: ChildProcess[] = []
  onTestFinished(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
    // Include detached workload groups when a test kills its supervisor.
    try {
      for (const name of await readdir(`${target}.lock`)) {
        if (!name.startsWith('group-')) continue
        const pid: unknown = JSON.parse(
          await readFile(join(`${target}.lock`, name), 'utf8'),
        )
        if (typeof pid === 'number') {
          try {
            process.kill(-pid, 'SIGKILL')
          } catch {
            /* already gone */
          }
        }
      }
    } catch {
      /* released */
    }
    await rm(root, { recursive: true, force: true })
  })
  const start = (script: string, waitMs = '10000', cwd = root) => {
    const child = spawn(process.execPath, [launcher, '-e', script], {
      cwd,
      env: { ...process.env, HVIR_SMOKE_LOCK_WAIT_MS: waitMs },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    children.push(child)
    let output = ''
    child.stdout.on('data', (data: Buffer) => {
      output += data.toString()
    })
    child.stderr.on('data', (data: Buffer) => {
      output += data.toString()
    })
    const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolveDone) => {
        child.once('close', (code, signal) => resolveDone({ code, signal }))
      },
    )
    return { child, done, output: () => output }
  }
  return { root, target, start }
}

async function until(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const end = performance.now() + 8000
  while (!(await predicate())) {
    if (performance.now() > end) throw new Error('process evidence did not arrive')
    await delay(20)
  }
}
const hold = `console.log('WORKLOAD_READY'); setInterval(() => {}, 1000)`

it('serializes independent launchers across working directories and releases after success', async () => {
  const { start } = await fixture()
  const first = start(hold)
  await until(() => first.output().includes('WORKLOAD_READY'))
  const second = start(`console.log('SECOND_STARTED')`, '10000', resolve('.'))
  await until(() => second.output().includes('Waiting for another smoke run'))
  expect(second.output()).not.toContain('SECOND_STARTED')
  first.child.kill('SIGTERM')
  await first.done
  expect(await second.done).toEqual({ code: 0, signal: null })
  expect(second.output()).toContain('SECOND_STARTED')
}, 15000)

it('cancels waiting promptly and times out before workload launch', async () => {
  const { start } = await fixture()
  const first = start(hold)
  await until(() => first.output().includes('WORKLOAD_READY'))
  const cancelled = start(`console.log('UNEXPECTED_START')`)
  await until(() => cancelled.output().includes('Waiting'))
  cancelled.child.kill('SIGINT')
  expect((await cancelled.done).code).not.toBe(0)
  expect(cancelled.output()).not.toContain('UNEXPECTED_START')
  const expired = start(`console.log('UNEXPECTED_START')`, '100')
  expect((await expired.done).code).toBe(1)
  expect(expired.output()).toContain('Acquisition timed out')
  expect(expired.output()).not.toContain('UNEXPECTED_START')
  first.child.kill('SIGTERM')
  await first.done
}, 15000)

it('retains owner-death evidence even with an ancient heartbeat and a surviving child', async () => {
  const { target, start } = await fixture()
  const first = start(hold)
  await until(() => first.output().includes('WORKLOAD_READY'))
  first.child.kill('SIGKILL')
  // Detached workload holds inherited pipes; supervisor exit is the relevant boundary.
  await once(first.child, 'exit')
  await utimes(join(`${target}.lock`, 'gate'), new Date(0), new Date(0))
  const next = start(`console.log('UNEXPECTED_START')`)
  expect((await next.done).code).toBe(1)
  expect(next.output()).toContain('Previous smoke launcher died')
  expect(next.output()).toContain('remove this exact directory')
  expect(next.output()).not.toContain('UNEXPECTED_START')
  expect(await readdir(`${target}.lock`)).toContain('owner.json')
}, 15000)

it('preserves failure status and releases only after lingering descendants terminate', async () => {
  const { target, start } = await fixture()
  const failed = start(`
    const {spawn} = require('node:child_process');
    spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], {stdio:'ignore'});
    process.exit(7);
  `)
  expect((await failed.done).code, failed.output()).toBe(7)
  expect(await readdir(`${target}.lock`)).toEqual([])
  const next = start(`console.log('SUCCESSOR')`)
  expect((await next.done).code).toBe(0)
}, 15000)

it('lets the scenario launcher retain interruption evidence after its full grace period', async () => {
  const { root, target, start } = await fixture()
  const runner = pathToFileURL(resolve('scripts/run-smoke-scenarios.mts')).href
  const leaf = `process.on('SIGTERM', () => {}); ${hold}`
  const first = start(`
    import(${JSON.stringify(runner)}).then(async ({ invokeSmokeScenario, registerSmokeLauncherSignals, formatSmokeScenarioResults }) => {
      const controller = new AbortController();
      const remove = registerSmokeLauncherSignals(controller);
      const result = await invokeSmokeScenario('pty-native', 1, 1, {
        command: process.execPath, args: ['-e', ${JSON.stringify(leaf)}],
        interruptionSignal: controller.signal, artifactDirectory: ${JSON.stringify(join(root, 'artifacts'))},
      });
      console.log('RECEIVED_SIGNAL=' + controller.signal.reason);
      console.log(formatSmokeScenarioResults([{ scenario: 'pty-native', iteration: 1, repetitionCount: 1, ...result }]));
      remove(); process.exitCode = 1;
    });
  `)
  await until(() => first.output().includes('WORKLOAD_READY'))
  first.child.kill('SIGINT')
  const successor = start(`console.log('SUCCESSOR_AFTER_KILL')`, '25000')
  await until(() => successor.output().includes('Waiting'))
  expect(successor.output()).not.toContain('SUCCESSOR_AFTER_KILL')
  expect(await readdir(`${target}.lock`)).toContain('owner.json')
  expect((await first.done).code).toBe(1)
  expect(first.output()).toContain('RECEIVED_SIGNAL=SIGINT')
  expect(first.output()).toContain('[smoke:summary]')
  expect(first.output()).toContain('launcher interrupted')
  const artifact: unknown = JSON.parse(
    await readFile(join(root, 'artifacts', 'pty-native-iteration-1-of-1.json'), 'utf8'),
  )
  expect(artifact).toMatchObject({
    outcome: 'launcher-interrupted',
    process: { signal: 'SIGKILL' },
  })
  expect((await successor.done).code).toBe(0)
}, 25000)

it('retains incomplete spawn evidence and diagnoses explicit recovery', async () => {
  const { target, start } = await fixture()
  const uncertain = start(`
    require('node:fs').writeFileSync(require('node:path').join(process.env.HVIR_SMOKE_LOCK_DIRECTORY, 'group-uncertain.json'), 'null');
  `)
  expect((await uncertain.done).code).toBe(1)
  expect(uncertain.output()).toContain('before its identity was recorded')
  expect(uncertain.output()).toContain('remove this exact directory')
  expect(await readdir(`${target}.lock`)).toContain('owner.json')
  const next = start(`console.log('UNEXPECTED_START')`)
  expect((await next.done).code).toBe(1)
  expect(next.output()).not.toContain('UNEXPECTED_START')
}, 15000)

it('reports explicit recovery when a held gate has no owner record', async () => {
  const { target, start } = await fixture()
  await mkdir(join(`${target}.lock`, 'gate'), { recursive: true })
  const next = start(`console.log('UNEXPECTED_START')`, '100')
  expect((await next.done).code).toBe(1)
  expect(next.output()).toContain('no owner evidence')
  expect(next.output()).toContain('remove this exact directory')
  expect(next.output()).not.toContain('UNEXPECTED_START')
}, 15000)

it('re-enters a lease and runs parallel nested groups without reacquiring it', async () => {
  const { target, start } = await fixture()
  const leaf = `process.send('ready'); process.on('message', () => process.exit(0))`
  const nested = start(`
    import(${JSON.stringify(moduleUrl)}).then(async ({withSmokeRunLock, hasSmokeRunLease, spawnSmokeProcess}) => {
      await withSmokeRunLock(async () => {
        if (!hasSmokeRunLease()) throw new Error('missing inherited lease');
        const children = [1, 2].map(() => spawnSmokeProcess(process.execPath, ['-e', ${JSON.stringify(leaf)}], {
          detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: process.env,
        }));
        await Promise.all(children.map(child => new Promise(resolve => child.once('message', resolve))));
        console.log('TWO_GROUPS_READY');
        const outcomes = children.map(child => new Promise(resolve => child.once('close', resolve)));
        children.forEach(child => child.send('finish'));
        await Promise.all(outcomes);
        const check = spawnSmokeProcess(process.execPath, [${JSON.stringify(resolve('scripts/smoke-run-lock.mts'))}, '--check-lease'], {
          detached: true, stdio: 'inherit', env: process.env,
        });
        const code = await new Promise(resolve => check.once('close', resolve));
        if (code !== 0) throw new Error('lease CLI validation failed');
      });
    });
  `)
  expect((await nested.done).code, nested.output()).toBe(0)
  expect(nested.output()).toContain('TWO_GROUPS_READY')
  expect(await readdir(`${target}.lock`)).toEqual([])
}, 15000)
