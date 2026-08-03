import { describe, expect, it } from 'vitest'

import {
  installedStartupReady,
  parseProcessTable,
  processDescendants,
  type ProcessRecord,
} from '../scripts/installed-startup-probe.mts'

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
})
