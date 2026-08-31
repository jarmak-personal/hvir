import { describe, expect, it } from 'vitest'

import {
  installedStartupReady,
  observeInstalledStartup,
  parseProcessTable,
  processDescendants,
  runWithInstalledStartupLiveness,
  type ProcessRecord,
} from '../scripts/installed-startup-probe.mts'
import { parseDevToolsActivePort } from '../scripts/installed-harness-dialog-probe.mts'

const expectedMain = '/opt/hvir/hvir'

function processRecord(
  pid: number,
  parentPid: number,
  command: string,
  state = 'S',
): ProcessRecord {
  return { pid, parentPid, processGroupId: 100, state, command }
}

describe('installed startup process evidence', () => {
  it('accepts only a bounded DevTools loopback port record', () => {
    expect(parseDevToolsActivePort('9338\n/devtools/browser/id\n')).toBe(9338)
    expect(() => parseDevToolsActivePort('0\n')).toThrow('invalid DevTools port')
    expect(() => parseDevToolsActivePort('not-a-port\n')).toThrow('invalid DevTools port')
  })

  it('parses the platform ps projection without treating command spaces as fields', () => {
    expect(
      parseProcessTable(
        '  100     1   100 S    /opt/hvir/hvir --project-root=/tmp/repository\n' +
          '  102   100   100 S    /opt/hvir/hvir --type=renderer --field trial\n',
      ),
    ).toEqual([
      processRecord(100, 1, '/opt/hvir/hvir --project-root=/tmp/repository'),
      processRecord(102, 100, '/opt/hvir/hvir --type=renderer --field trial'),
    ])
  })

  it('finds transitive descendants without admitting unrelated processes', () => {
    const processes = [
      processRecord(100, 1, expectedMain),
      processRecord(101, 100, 'helper'),
      processRecord(102, 101, 'renderer --type=renderer'),
      processRecord(200, 1, 'unrelated --type=renderer'),
    ]
    expect(processDescendants(processes, 100).map((process) => process.pid)).toEqual([
      101, 102,
    ])
  })

  it('requires the exact package-owned live main and a live descendant renderer', () => {
    const ready = [
      processRecord(100, 1, `${expectedMain} --project-root=/tmp/repository`),
      processRecord(101, 100, 'helper'),
      processRecord(102, 101, 'renderer --type=renderer'),
    ]
    expect(installedStartupReady(ready, 100, expectedMain)).toBe(true)
    expect(
      installedStartupReady(
        [processRecord(100, 1, '/tmp/not-hvir'), ready[2]!],
        100,
        expectedMain,
      ),
    ).toBe(false)
    expect(
      installedStartupReady(
        [ready[0]!, processRecord(102, 100, 'renderer --type=renderer', 'Z')],
        100,
        expectedMain,
      ),
    ).toBe(false)
    expect(installedStartupReady(ready.slice(0, 2), 100, expectedMain)).toBe(false)
  })

  it('fails when a renderer that satisfied readiness disappears during acceptance', async () => {
    const ready = [
      processRecord(100, 1, expectedMain),
      processRecord(102, 100, 'renderer --type=renderer'),
    ]
    const observations = [ready, ready.slice(0, 1)]
    let index = 0

    await expect(
      runWithInstalledStartupLiveness(
        () => new Promise<string>(() => undefined),
        () => {
          const observation = observeInstalledStartup(
            observations[Math.min(index++, observations.length - 1)]!,
            100,
            expectedMain,
          )
          if (!observation.ready) {
            throw new Error(
              `Installed hvir lost ordinary startup liveness (main ${observation.main}; renderer ${observation.renderer})`,
            )
          }
          return Promise.resolve()
        },
        0,
      ),
    ).rejects.toThrow('lost ordinary startup liveness (main live; renderer missing)')
  })

  it('preserves a CDP target failure while the installed process is live', async () => {
    await expect(
      runWithInstalledStartupLiveness(
        () => Promise.reject(new Error('Target crashed')),
        () => Promise.resolve(),
        0,
      ),
    ).rejects.toThrow('Target crashed')
  })

  it('stops liveness polling after a successful exercise begins deliberate shutdown', async () => {
    let observations = 0
    await expect(
      runWithInstalledStartupLiveness(
        () => Promise.resolve('dialog evidence'),
        () => {
          observations += 1
          return Promise.resolve()
        },
        0,
      ),
    ).resolves.toBe('dialog evidence')
    const completedObservations = observations

    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 10))
    expect(observations).toBe(completedObservations)
    expect(observations).toBeGreaterThanOrEqual(1)
  })
})
