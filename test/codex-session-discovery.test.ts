import { describe, expect, it } from 'vitest'

import { createCodexSessionDiscovery } from '../src/main/harness/codex-session-discovery'
import type { ProjectHost } from '../src/main/project-host'
import { localPath } from '../src/shared'

const CWD = localPath('/tmp/project')
const LAUNCHED_AT = Date.parse('2026-07-13T16:00:00.000Z')
const HOST_CLOCK_SKEW_MS = 15 * 60 * 1_000
const HOST_LAUNCHED_AT = LAUNCHED_AT + HOST_CLOCK_SKEW_MS
const FIRST_ID = '019ab123-4567-7890-abcd-ef0123456789'
const SECOND_ID = '019ab123-4567-7890-abcd-ef0123456790'

interface DiscoveryFixture {
  readonly host: ProjectHost
  readonly setPaths: (paths: readonly string[]) => void
  readonly setRecord: (path: string, record: string) => void
  readonly discovery: ReturnType<typeof createCodexSessionDiscovery>
  readonly identify: (
    snapshot: unknown,
  ) => ReturnType<ReturnType<typeof createCodexSessionDiscovery>['identify']>
}

function fixture(): DiscoveryFixture {
  let paths: readonly string[] = []
  let now = LAUNCHED_AT
  const records = new Map<string, string>()
  const host = {
    exec: (command: string, args: readonly string[]) => {
      if (command === 'sh') {
        return Promise.resolve({
          code: 0,
          signal: null,
          stdout: `hvir-clock:${Math.floor((now + HOST_CLOCK_SKEW_MS) / 1_000)}\0${paths.length > 0 ? `${paths.join('\0')}\0` : ''}`,
          stderr: '',
        })
      }
      const path = args.at(-1) ?? ''
      return Promise.resolve({
        code: records.has(path) ? 0 : 1,
        signal: null,
        stdout: records.get(path) ?? '',
        stderr: '',
      })
    },
  } as unknown as ProjectHost
  const discovery = createCodexSessionDiscovery({
    timeoutMs: 40,
    initialPollMs: 10,
    maxPollMs: 10,
    settleMs: 10,
    now: () => now,
    sleep: (ms) => {
      now += ms
      return Promise.resolve()
    },
  })
  return {
    host,
    setPaths: (next) => {
      paths = next
    },
    setRecord: (path, record) => records.set(path, record),
    discovery,
    identify: (snapshot) =>
      discovery.identify(host, snapshot, {
        cwd: CWD,
        launchedAtMs: LAUNCHED_AT,
        signal: new AbortController().signal,
      }),
  }
}

function rolloutPath(id: string): string {
  return `/home/user/.codex/sessions/2026/07/13/rollout-2026-07-13T12-00-00-${id}.jsonl`
}

function sessionMeta(
  id: string,
  overrides: {
    readonly cwd?: string
    readonly originator?: string
    readonly timestamp?: string
  } = {},
): string {
  return JSON.stringify({
    // This event timestamp can lag actual session creation substantially.
    timestamp: new Date(HOST_LAUNCHED_AT + 120_000).toISOString(),
    type: 'session_meta',
    payload: {
      id,
      timestamp: overrides.timestamp ?? new Date(HOST_LAUNCHED_AT + 1).toISOString(),
      cwd: overrides.cwd ?? CWD.path,
      originator: overrides.originator ?? 'codex-tui',
    },
  })
}

describe('Codex session discovery', () => {
  it('identifies one new session_meta record on a skewed project-host clock', async () => {
    const f = fixture()
    const before = rolloutPath('019ab123-4567-7890-abcd-ef0123456700')
    f.setPaths([before])
    const snapshot = await f.discovery.snapshot(f.host)
    const created = rolloutPath(FIRST_ID)
    f.setPaths([before, created])
    f.setRecord(created, sessionMeta(FIRST_ID))

    await expect(f.identify(snapshot)).resolves.toEqual({
      status: 'identified',
      sessionId: FIRST_ID,
    })
  })

  it('does not consider a session that existed in the launch snapshot', async () => {
    const f = fixture()
    const existing = rolloutPath(FIRST_ID)
    f.setPaths([existing])
    f.setRecord(existing, sessionMeta(FIRST_ID))
    const snapshot = await f.discovery.snapshot(f.host)

    await expect(f.identify(snapshot)).resolves.toEqual({ status: 'unavailable' })
  })

  it('rejects wrong cwd, originator, time, and filename identity', async () => {
    const f = fixture()
    const snapshot = await f.discovery.snapshot(f.host)
    const wrongCwd = rolloutPath(FIRST_ID)
    const wrongOrigin = rolloutPath(SECOND_ID)
    const oldId = '019ab123-4567-7890-abcd-ef0123456791'
    const old = rolloutPath(oldId)
    const mismatchId = '019ab123-4567-7890-abcd-ef0123456792'
    const mismatch = rolloutPath(mismatchId)
    f.setPaths([wrongCwd, wrongOrigin, old, mismatch])
    f.setRecord(wrongCwd, sessionMeta(FIRST_ID, { cwd: '/tmp/other' }))
    f.setRecord(wrongOrigin, sessionMeta(SECOND_ID, { originator: 'another-originator' }))
    f.setRecord(
      old,
      sessionMeta(oldId, {
        timestamp: new Date(HOST_LAUNCHED_AT - 10_000).toISOString(),
      }),
    )
    f.setRecord(mismatch, sessionMeta(FIRST_ID))

    await expect(f.identify(snapshot)).resolves.toEqual({
      status: 'unavailable',
    })
  })

  it('fails closed when more than one record matches', async () => {
    const f = fixture()
    const snapshot = await f.discovery.snapshot(f.host)
    const first = rolloutPath(FIRST_ID)
    const second = rolloutPath(SECOND_ID)
    f.setPaths([first, second])
    f.setRecord(first, sessionMeta(FIRST_ID))
    f.setRecord(second, sessionMeta(SECOND_ID))

    await expect(f.identify(snapshot)).resolves.toEqual({
      status: 'ambiguous',
    })
  })
})
