import { expect, it, onTestFinished, vi } from 'vitest'
import { SshHost } from '../src/main/project-host/ssh-host'
import { IpcAuthority } from '../src/main/ipc/authority-router'
import { authorizeDocumentRead } from '../src/main/viewer/document-read-authority'
import { SkillagerReviewOwner } from '../src/main/skillager/skillager-review-owner'
import { hostPath, joinHostPath, localPath } from '../src/shared/host-path'
import { createRendererResourceFixture } from './fixtures/renderer-resource-fixture'
const hostname = process.env.HVIR_SKILLAGER_SSH_HOST
const password = process.env.HVIR_SKILLAGER_SSH_PASSWORD
const fingerprint = process.env.HVIR_SKILLAGER_SSH_FINGERPRINT
it.runIf(Boolean(hostname && password && fingerprint))(
  'reads literal project Full/Stub/Router and confined supporting content through the real authorized SSH host, without a remote CLI',
  async () => {
    const host = new SshHost({
      config: {
        alias: 'skillager-reading-acceptance',
        hostname: hostname!,
        port: Number(process.env.HVIR_SKILLAGER_SSH_PORT),
        user: process.env.HVIR_SKILLAGER_SSH_USER!,
        identityFiles: [],
      },
      trust: {
        trustedHostKey: () => fingerprint!,
        rememberHostKey: () => Promise.reject(Error('Unexpected host-key change')),
      },
      prompter: {
        prompt: (request) =>
          Promise.resolve(request.kind === 'password' ? [password!] : undefined),
      },
    })
    const resources = createRendererResourceFixture(),
      owner = resources.activateOwner()
    const unexpected = vi.fn(() =>
      Promise.reject(Error('Unexpected remote CLI or approval')),
    )
    const reviews = new SkillagerReviewOwner(
      { review: unexpected, history: unexpected, diff: unexpected, accept: unexpected },
      resources.scopes,
      {
        create: () => {
          throw Error('Unexpected HTML')
        },
        release: () => {},
      },
      { previewExposure: unexpected, updateSourceHash: unexpected },
    )
    let directory: string | undefined = undefined
    onTestFinished(async () => {
      try {
        await reviews.revoke()
        if (directory) {
          const removed = await host.exec('rm', ['-rf', '--', directory], {
            signal: AbortSignal.timeout(10_000),
          })
          expect(removed.code).toBe(0)
        }
      } finally {
        await host.dispose()
      }
    })
    await host.connect()
    const created = await host.exec(
      'mktemp',
      ['-d', '/tmp/hvir-skillager-reading-XXXXXX'],
      { signal: AbortSignal.timeout(10_000) },
    )
    expect(created.code).toBe(0)
    const proposedDirectory = created.stdout.trim()
    expect(proposedDirectory).toMatch(/^\/tmp\/hvir-skillager-reading-[A-Za-z0-9]+$/)
    directory = proposedDirectory
    const workspaceRoot = hostPath(host.hostId, directory)
    const authority = new IpcAuthority({
      getProject: () => ({ host, root: workspaceRoot }),
      getProjectState: () => {
        throw Error('Unexpected project enumeration')
      },
      getRegisteredWorkspaceRoot: (root) => root,
    })
    const grant = {
      selection: {
        executable: localPath('/local-cli'),
        catalog: localPath('/local-catalog'),
        environment: {},
        version: '0.9.2',
        library: {
          id: 'library',
          root: localPath('/library'),
          skillsRoot: localPath('/library/skills'),
        },
      },
      assertCurrent: () => {
        if (host.connectionState !== 'connected') throw Error('Disconnected')
      },
    }
    const validateDocument = vi.fn(() => Promise.resolve())
    for (const kind of ['full', 'stub', 'router'] as const) {
      const root = joinHostPath(workspaceRoot, '.agents/skills', kind)
      expect(
        (
          await host.exec('mkdir', ['-p', root.path], {
            signal: AbortSignal.timeout(10_000),
          })
        ).code,
      ).toBe(0)
      const path = joinHostPath(root, 'SKILL.md')
      const text =
        kind === 'full'
          ? '# Installed full skill\nComplete instructions in the project.\n'
          : kind === 'stub'
            ? '# Installed stub\nOpen the definition on demand.\n'
            : '# Installed router\n- Member skill\n'
      await host.writeFile(path, text)
      await host.writeFile(joinHostPath(root, 'guide.md'), '# Remote supporting guide\n')
      const request = {
        connectionId: 'connection',
        requestId: kind === 'full' ? 1 : kind === 'stub' ? 2 : 3,
        workspaceRoot,
        agent: 'codex' as const,
        selection: { kind, skillId: 'lib/example', root, path },
      }
      const opened = await reviews.openDocument(
        owner,
        request,
        grant,
        { documentAccess: unexpected, validateDocument },
        (path) => authorizeDocumentRead(authority, { path }),
      )
      expect(opened.content.text).toBe(text)
      expect(opened.content.path.hostId).toBe(host.hostId)
      expect(
        (
          await reviews.documentContent(owner, {
            ...request,
            contentId: opened.contentId,
            entry: 'guide.md',
          })
        ).text,
      ).toBe('# Remote supporting guide\n')
      await expect(
        reviews.documentContent(owner, {
          ...request,
          contentId: opened.contentId,
          entry: '../../outside',
        }),
      ).rejects.toThrow()
      await reviews.releaseDocument(owner, opened.contentId)
    }
    expect(validateDocument).toHaveBeenCalledTimes(3)
    expect(unexpected).not.toHaveBeenCalled()
  },
  90_000,
)
