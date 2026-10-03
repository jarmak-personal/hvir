import type { DocumentMarkdownOwner } from '../../src/main/viewer/document-markdown-owner'
import { vi } from 'vitest'
import { hostPath, asHostId } from '../../src/shared/host-path'
import type { ProjectHost } from '../../src/main/project-host/project-host'
import type { ExtensionActivation } from '../../src/main/extensions/activation'
import { ExtensionSourceApprovalOwner } from '../../src/main/extensions/source-approval'
import {
  ExtensionSourceReadingOwner,
  type SourceCaller,
} from '../../src/main/extensions/source-reading'

export function sourceFixture(
  context: 'application' | 'workspace' = 'application',
  markdown?: DocumentMarkdownOwner,
  hostId = asHostId('local'),
) {
  const declaration = {
    id: 'source',
    description: 'Selected source',
    context,
    mode: 'read-only' as const,
  }
  const activation = {
    installationId: 'installation',
    generation: 'generation',
    revision: { manifest: { access: [declaration] } },
  } as unknown as ExtensionActivation
  const active = new Map([[activation.installationId, activation]])
  let state: unknown = [],
    live = true
  const root = hostPath(hostId, '/library'),
    path = hostPath(hostId, '/library/skill/SKILL.md')
  const readImage = vi.fn(async function* () {
    yield await Promise.resolve(Buffer.from('image'))
  })
  const host = {
    hostId,
    connectionState: 'connected' as ProjectHost['connectionState'],
    realpath: vi.fn<ProjectHost['realpath']>((value) => Promise.resolve(value)),
    stat: vi.fn<ProjectHost['stat']>((value) =>
      Promise.resolve({
        type: value.path === root.path ? 'dir' : 'file',
        size: 10,
        mode: 0o644,
        mtimeMs: 0,
      }),
    ),
    readTextFilePrefix: vi.fn<ProjectHost['readTextFilePrefix']>(() =>
      Promise.resolve({
        content: '# Current instruction',
        complete: true,
        byteLength: 21,
        lineCount: 1,
        validUtf8: true,
      }),
    ),
    fileTransfer: {
      readFileChunks: readImage,
    } as unknown as NonNullable<ProjectHost['fileTransfer']>,
  }
  const authority = {
    active,
    assertWritable: vi.fn(() => Promise.resolve()),
    readSourceGrants: vi.fn(() => Promise.resolve(state)),
    saveSourceGrants: vi.fn((value: unknown, current: () => void) => {
      current()
      state = JSON.parse(JSON.stringify(value)) as unknown
      return Promise.resolve()
    }),
  }
  const approvals = new ExtensionSourceApprovalOwner(
    {
      local: { hostId: asHostId('local') },
      hostById: (id) => (id === hostId ? host : undefined),
    },
    authority,
    (id, source) => reading.revoke(id, source),
  )
  const reading = new ExtensionSourceReadingOwner(approvals, markdown)
  const controller = new AbortController()
  const caller: SourceCaller = {
    activation,
    view: 'view',
    allowed: true,
    signal: controller.signal,
    current: () => {
      if (!live) throw new Error('View closed')
    },
    context: () => ({
      value: {
        surface: 'viewer',
        visible: true,
        workspace: { id: 'workspace', name: 'Workspace', host: hostId },
      },
      root,
      current: () => live,
    }),
  }
  return {
    root,
    path,
    declaration,
    activation,
    active,
    host,
    readImage,
    authority,
    approvals,
    reading,
    caller,
    controller,
    state: () => state,
    close: () => {
      live = false
      reading.closeView(caller.view)
    },
    dispose: () => {
      reading.dispose()
      approvals.dispose()
    },
    async grant() {
      await approvals.start()
      const prepared = await approvals.prepare(
        {
          installationId: 'installation',
          source: 'source',
          ...(context === 'application' ? { root } : {}),
        },
        () => {},
      )
      await approvals.approve(prepared.token)
    },
  }
}
