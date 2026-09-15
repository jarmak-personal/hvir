import { expect, it, vi } from 'vitest'
import { asHostId, hostPath, localPath } from '../src/shared/host-path'
import { revealSkillagerFolder } from '../src/renderer/src/skillager/skillager-files-reveal'
import type { ResolveEntryResponse } from '../src/shared'

it.each(['local', 'ssh:fixture'])(
  'reveals only the exact current %s project folder through Files',
  async (id) => {
    const root = hostPath(asHostId(id), '/project'),
      path = hostPath(root.hostId, '/project/.skills/example'),
      reveal = vi.fn()
    await revealSkillagerFolder(root, path, new AbortController().signal, {
      current: () => true,
      resolve: () => Promise.resolve({ path, type: 'dir' }),
      reveal,
    })
    expect(reveal).toHaveBeenCalledExactlyOnceWith(path)
  },
)
it.each([
  'file',
  'different',
  'outside',
  'root',
  'error',
  'cancel',
  'workspace',
  'connection',
  'origin',
] as const)(
  'rejects %s classification without any fallback or late focus',
  async (kind) => {
    const root = localPath('/project'),
      path =
        kind === 'outside'
          ? localPath('/elsewhere')
          : kind === 'root'
            ? root
            : localPath('/project/.skills/example')
    const controller = new AbortController(),
      reveal = vi.fn()
    let current = true,
      finish!: (result: ResolveEntryResponse) => void
    const resolve = vi.fn(() =>
      kind === 'error'
        ? Promise.reject(new Error('unavailable'))
        : new Promise<ResolveEntryResponse>((done) => {
            finish = done
          }),
    )
    const result = revealSkillagerFolder(root, path, controller.signal, {
      current: () => current,
      resolve,
      reveal,
    })
    const refused = expect(result).rejects.toThrow()
    if (!['outside', 'root', 'error'].includes(kind)) {
      if (kind === 'cancel') controller.abort()
      if (['workspace', 'connection', 'origin'].includes(kind)) current = false
      finish({
        path: kind === 'different' ? localPath('/project/other') : path,
        type: kind === 'file' ? 'file' : 'dir',
      })
    }
    await refused
    expect(reveal).not.toHaveBeenCalled()
    if (kind === 'outside' || kind === 'root') expect(resolve).not.toHaveBeenCalled()
  },
)
