import { describe, expect, it, vi } from 'vitest'
import {
  AgentWorkbenchCommandOwner,
  type AgentWorkbenchPorts,
} from '../src/main/agent/command-owner'
import { LocalAgentAccessOwner } from '../src/main/agent/access-owner'
import { AgentReportOwner } from '../src/main/viewer/agent-report-owner'
import { validateCapturedExtension } from '../src/main/extensions/package-store'
import type { ProjectHost } from '../src/main/project-host/project-host'
import { AGENT_CONTRACT } from '../src/shared/agent/contract'
import { hostPath, asHostId, type HostPath } from '../src/shared/host-path'
import { contextFixture } from './fixtures/extension-context'
import { exampleManifest } from './fixtures/extension-package'

function fixture() {
  const context = contextFixture()
  const revision = validateCapturedExtension({
    sourceIdentity: '1:1',
    files: new Map([
      ['index.html', new Uint8Array()],
      ['detail.html', new Uint8Array()],
      [
        'hvir-extension.json',
        new TextEncoder().encode(
          JSON.stringify(
            exampleManifest({
              actions: [
                {
                  id: 'edit',
                  title: 'Edit',
                  view: 'detail',
                  agents: true,
                  effects: { delete: true, replace: false },
                  inputSchema: {
                    type: 'object',
                    required: ['choice'],
                    additionalProperties: false,
                    properties: { choice: { type: 'string', enum: ['one', 'two'] } },
                  },
                },
              ],
            }),
          ),
        ),
      ],
    ]),
  })
  const activation = { installationId: 'installation', generation: 'current', revision }
  const access = new LocalAgentAccessOwner(
    () => undefined,
    () => Promise.resolve(),
    {
      allowed: () => ['installation'],
      writable: () => true,
      signal: () => new AbortController().signal,
    },
  )
  const reports = new AgentReportOwner(() => undefined)
  const ports: AgentWorkbenchPorts = {
    contexts: () => context.contexts,
    activeInstallations: () => [activation],
    activeInstallation: (id) =>
      id === activation.installationId ? activation : undefined,
    openView: vi.fn(),
    invokeAction: vi.fn(() => Promise.resolve({ done: true })),
    access,
    reports,
    presentationOwner: () => ({ id: 1, generation: 1 }),
    assertOwner: () => undefined,
    host: () => undefined,
    openDocument: vi.fn(),
  }
  const controller = new AbortController()
  const owner = new AgentWorkbenchCommandOwner(ports)
  const run = (argv: string[]) =>
    owner.run(
      { contract: AGENT_CONTRACT, argv, stdin: '', defaults: {} },
      { id: 'connection', origin: 'application-local', signal: controller.signal },
    )
  const action = (input: string) =>
    run(['run', '--extension', 'installation', '--action', 'edit', '--input', input])
  return {
    ...context,
    access,
    ports,
    controller,
    run,
    action,
    dispose: () => {
      access.dispose()
      reports.dispose()
    },
  }
}

describe('agent command failure classification', () => {
  it('rejects an overlong report title as invalid before publication while retaining boundary titles', async () => {
    const f = fixture()
    try {
      await f.access.configure({ enabled: true, confirmDestructive: false })
      const title = 'x'.repeat(80)
      const invalid = await f.run([
        'report',
        '--workspace',
        'workspace',
        '--title',
        title + 'x',
      ])
      expect(invalid.exitStatus).toBe(64)
      expect(JSON.parse(invalid.stdout)).toMatchObject({
        ok: false,
        error: { code: 'invalid-command' },
      })
      expect(f.ports.reports.snapshot()).toEqual([])
      const accepted = await f.run([
        'report',
        '--workspace',
        'workspace',
        '--title',
        title,
      ])
      expect(accepted.exitStatus).toBe(0)
      expect(f.ports.reports.snapshot()).toEqual([expect.objectContaining({ title })])
      expect(() =>
        f.ports.reports.publish('workspace', f.root, title + 'x', 'text', ''),
      ).toThrow('Invalid report presentation')
      expect(f.ports.reports.snapshot()).toHaveLength(1)
      await f.access.configure({ enabled: false, confirmDestructive: false })
      expect(
        (await f.run(['report', '--workspace', 'workspace', '--title', title]))
          .exitStatus,
      ).toBe(69)
    } finally {
      f.dispose()
    }
  })

  it.each(
    [
      '{',
      '"' + 'é'.repeat(4096) + '"',
      'null',
      '[]',
      '{}',
      '{"choice":1}',
      '{"choice":"other"}',
      '{"choice":"one","extra":true}',
    ].map((input, index) => ({ input, index })),
  )(
    'rejects invalid action input before confirmation or invocation: $index',
    async ({ input }) => {
      const f = fixture()
      try {
        await f.access.configure({ enabled: true, confirmDestructive: true })
        const confirm = vi.spyOn(f.access, 'authorizeAction')
        const response = await f.action(input)
        expect(response.exitStatus).toBe(64)
        expect(JSON.parse(response.stdout)).toMatchObject({
          ok: false,
          error: { code: 'invalid-input' },
        })
        expect(confirm).not.toHaveBeenCalled()
        expect(f.access.snapshot().confirmations).toEqual([])
        expect(f.ports.invokeAction).not.toHaveBeenCalled()
        expect(f.ports.openView).not.toHaveBeenCalled()
      } finally {
        f.dispose()
      }
    },
  )

  it('dispatches valid input and preserves an arbitrary domain-shaped value', async () => {
    const f = fixture()
    try {
      await f.access.configure({ enabled: true, confirmDestructive: false })
      const value = { outcome: 'refused', operationId: 'domain-operation', code: 64 }
      vi.mocked(f.ports.invokeAction).mockResolvedValue(value)
      const response = await f.action('{"choice":"one"}')
      expect(response.exitStatus).toBe(0)
      expect(JSON.parse(response.stdout)).toMatchObject({ ok: true, value })
      expect(f.ports.invokeAction).toHaveBeenCalledOnce()
      expect(vi.mocked(f.ports.invokeAction).mock.calls[0]?.slice(2, 4)).toEqual([
        'edit',
        { choice: 'one' },
      ])
    } finally {
      f.dispose()
    }
  })

  it.each(['invalid input', 'unapproved', 'interrupted'])(
    'does not classify extension error text %s as a request error',
    async (message) => {
      const f = fixture()
      try {
        await f.access.configure({ enabled: true, confirmDestructive: false })
        vi.mocked(f.ports.invokeAction).mockRejectedValue(new Error(message))
        const response = await f.action('{"choice":"one"}')
        expect(response.exitStatus).toBe(69)
        expect(JSON.parse(response.stdout)).toMatchObject({
          ok: false,
          error: { code: 'unavailable', message },
        })
      } finally {
        f.dispose()
      }
    },
  )

  it('reports an explicitly ended request as interrupted without dispatch', async () => {
    const f = fixture()
    try {
      await f.access.configure({ enabled: true, confirmDestructive: false })
      f.controller.abort()
      const response = await f.action('{"choice":"one"}')
      expect(response.exitStatus).toBe(75)
      expect(JSON.parse(response.stdout)).toMatchObject({
        ok: false,
        error: { code: 'interrupted' },
      })
      expect(f.ports.invokeAction).not.toHaveBeenCalled()
    } finally {
      f.dispose()
    }
  })

  it.each(['local', 'ssh'])(
    'returns 69 for lexical and canonical escapes on %s without reading or presenting',
    async (id) => {
      const f = fixture()
      const qualify = (path: string) => hostPath(asHostId(id), path)
      const root = qualify('/project')
      const state = f.sources.projectState()
      vi.spyOn(f.sources, 'projectState').mockReturnValue({
        ...state,
        root,
        projects: state.projects.map((project) => ({
          ...project,
          registeredRoot: root,
          workspaces: project.workspaces.map((workspace) => ({ ...workspace, root })),
        })),
      })
      const readFile = vi.fn(),
        stat = vi.fn()
      const host = {
        hostId: root.hostId,
        connectionState: 'connected',
        readFile,
        stat,
        realpath: vi.fn((path: HostPath) =>
          Promise.resolve(path.path.endsWith('/escape') ? qualify('/private') : path),
        ),
      } as unknown as ProjectHost
      vi.spyOn(f.ports, 'host').mockImplementation((selected) =>
        selected === id ? host : undefined,
      )
      try {
        await f.access.configure({ enabled: true, confirmDestructive: false })
        for (const path of ['../outside', '/project/escape']) {
          const response = await f.run([
            'open',
            '--workspace',
            'workspace',
            '--path',
            path,
          ])
          expect(response.exitStatus).toBe(69)
          expect(JSON.parse(response.stdout)).toMatchObject({
            ok: false,
            error: { code: 'unavailable' },
          })
          expect(response.stdout).toContain('escapes')
        }
        expect(readFile).not.toHaveBeenCalled()
        expect(stat).not.toHaveBeenCalled()
        expect(f.ports.openDocument).not.toHaveBeenCalled()
      } finally {
        f.dispose()
      }
    },
  )
})
