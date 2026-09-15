// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import {
  useSkillagerContent,
  type SkillagerContentController,
} from '../src/renderer/src/skillager/use-skillager-content'
import { skillagerMetadataKey } from '../src/renderer/src/skillager/skillager-model'
import { localPath } from '../src/shared/host-path'
import type { SkillagerMetadata } from '../src/shared/skillager'
import type { SkillagerContentRequest } from '../src/shared/skillager-content'
const library = {
  id: 'library',
  root: localPath('/library'),
  skillsRoot: localPath('/library/skills'),
}
const row: SkillagerMetadata = {
  id: 'lib/example',
  name: 'Example',
  description: '',
  trust: 'discovered',
  source: { type: 'library', ownership: 'library', libraryId: 'library' },
  tags: [],
  matchReasons: [],
  exposure: 'unknown',
}
const connection = {
  connectionId: 'connected',
  library,
  executable: localPath('/skillager'),
  version: '0.9.2',
}
afterEach(() => vi.unstubAllGlobals())
function fixture() {
  const node = document.createElement('div'),
    root = createRoot(node)
  document.body.append(node)
  let controller!: SkillagerContentController
  let options = {
    connection,
    root: localPath('/workspace'),
    agent: 'codex' as const,
    activeId: skillagerMetadataKey(row),
    visible: true,
    projectConnection: 'connected',
  }
  const invoke = vi.fn<(channel: string, request: unknown) => Promise<unknown>>(() =>
    Promise.resolve(undefined),
  )
  vi.stubGlobal('hvir', { invoke })
  Object.assign(window, { hvir: { invoke } })
  function Harness() {
    controller = useSkillagerContent(options)
    return <p>{controller.state.content?.text ?? controller.state.message ?? ''}</p>
  }
  const render = async (patch: Partial<typeof options> = {}) => {
    options = { ...options, ...patch }
    await act(async () => {
      root.render(<Harness />)
      await Promise.resolve()
    })
  }
  const open = (request: SkillagerContentRequest, id = 'document') => ({
    ok: true,
    value: {
      contentId: id,
      selection: request.selection,
      content: { entry: 'SKILL.md', path: request.selection.path, size: 4, text: 'body' },
    },
  })
  return {
    node,
    get calls() {
      return invoke.mock.calls.map(([channel, request]) => ({ channel, request }))
    },
    invoke,
    render,
    open,
    get current() {
      return controller
    },
    dispose: async () => {
      await act(async () => {
        root.unmount()
        await Promise.resolve()
      })
      node.remove()
    },
  }
}
it('reads only explicit activation, never metadata/focus/visibility arrival; retains current bytes until an explicit new selection', async () => {
  const f = fixture()
  try {
    f.invoke.mockImplementation((channel, request) =>
      Promise.resolve(
        channel === 'skillager:open-document'
          ? f.open(request as SkillagerContentRequest)
          : undefined,
      ),
    )
    await f.render()
    expect(f.calls).toEqual([])
    await act(async () => {
      f.current.activate(row)
      await Promise.resolve()
    })
    expect(f.node.textContent).toBe('body')
    await f.render()
    expect(f.calls.filter((c) => c.channel === 'skillager:open-document')).toHaveLength(1)
    await f.render({ visible: false })
    expect(
      f.calls.filter((c) => c.channel === 'skillager:release-document'),
    ).toHaveLength(1)
    await f.render({ visible: true })
    expect(f.calls.filter((c) => c.channel === 'skillager:open-document')).toHaveLength(1)
    await act(async () => {
      f.current.activate(row)
      await Promise.resolve()
    })
    expect(f.calls.filter((c) => c.channel === 'skillager:open-document')).toHaveLength(2)
    expect(f.calls.some((c) => /review|accept|exposure/.test(c.channel))).toBe(false)
  } finally {
    await f.dispose()
  }
})
it('cancels a pending body on source/context change and releases late publication without displaying it', async () => {
  const f = fixture()
  let complete!: (value: unknown) => void
  let submitted!: SkillagerContentRequest
  try {
    f.invoke.mockImplementation((channel, request) =>
      channel === 'skillager:open-document'
        ? new Promise((resolve) => {
            complete = resolve
            submitted = request as SkillagerContentRequest
          })
        : Promise.resolve(undefined),
    )
    await f.render()
    await act(async () => {
      f.current.activate(row)
      await Promise.resolve()
    })
    await f.render({ root: localPath('/other-workspace') })
    await act(async () => {
      complete(f.open(submitted, 'late'))
      await Promise.resolve()
    })
    expect(f.node.textContent).not.toContain('body')
    expect(f.calls).toContainEqual({
      channel: 'skillager:release-document',
      request: { contentId: 'late' },
    })
    expect(f.calls.filter((c) => c.channel === 'skillager:open-document')).toHaveLength(1)
  } finally {
    await f.dispose()
  }
})
it('offers a separate explicit current-file read after stale accepted selection and retains exact selected agent', async () => {
  const f = fixture()
  const path = localPath('/workspace/.claude/skills/example')
  const selected: SkillagerMetadata = {
    ...row,
    id: 'project/example',
    trust: 'reviewed',
    contentHash: 'a'.repeat(64),
    source: { type: 'project', ownership: 'external' },
    projectSkill: { path, agent: 'claude', managed: false },
    search: {
      groupId: 'group',
      groupOccurrences: 1,
      installed: true,
      occurrence: {
        id: 'source',
        kind: 'project-original',
        path,
        entrypoint: localPath(path.path + '/SKILL.md'),
        agent: 'claude',
      },
      match: {
        occurrence: {
          id: 'different',
          kind: 'source',
          path,
          entrypoint: localPath(path.path + '/SKILL.md'),
        },
        skillId: 'different',
        contentHash: 'b'.repeat(64),
        score: 1,
        reasons: ['body'],
      },
    },
  }
  try {
    f.invoke.mockImplementation((channel, request) =>
      Promise.resolve(
        channel === 'skillager:open-document'
          ? (request as SkillagerContentRequest).selection.expectedHash
            ? { ok: false, reason: 'stale-review', message: 'Changed source' }
            : f.open(request as SkillagerContentRequest)
          : undefined,
      ),
    )
    await f.render({ activeId: skillagerMetadataKey(selected) })
    await act(async () => {
      f.current.activate(selected)
      await Promise.resolve()
    })
    expect(f.current.state.stale).toBe(true)
    await act(async () => {
      f.current.reopen()
      await Promise.resolve()
    })
    const opens = f.calls
      .filter((c) => c.channel === 'skillager:open-document')
      .map((c) => c.request as SkillagerContentRequest)
    expect(opens.map((r) => r.agent)).toEqual(['claude', 'claude'])
    expect(opens.map((r) => r.selection.expectedHash)).toEqual([
      'a'.repeat(64),
      undefined,
    ])
    expect(f.node.textContent).toBe('body')
    expect(f.current.state.currentFile).toBe(true)
  } finally {
    await f.dispose()
  }
})
