import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { expect, it, vi } from 'vitest'
import { localPath } from '../src/shared/host-path'
import type { ProjectHost } from '../src/main/project-host/project-host'
import type { ExtensionApplicationRuntime } from '../src/main/extensions/extension-application'
import type { BrowserWindow } from 'electron'

vi.mock('electron', () => ({
  app: { getAppPath: () => process.cwd() },
  dialog: { showOpenDialog: vi.fn() },
  BrowserWindow: class {},
  webContents: {},
}))
import { verifyExtensionConnection } from '../src/main/smoke/extension-connection'

it('assembles an authored browser module closure that consumes the actual maintained hello/context client', async () => {
  const owned = await mkdtemp(join(tmpdir(), 'hvir-connection-module-'))
  try {
    const host = {
      createDirectoryExclusive: (path: { path: string }) => mkdir(path.path),
      writeFile: (path: { path: string }, content: string) =>
        writeFile(path.path, content),
      readFile: (path: { path: string }) => readFile(path.path, 'utf8'),
    } as unknown as ProjectHost
    const runtime = {
      activations: {
        packages: {
          root: localPath(join(owned, 'extensions')),
          captureSource: () => Promise.resolve({ hash: 'assembled-source' }),
        },
      },
      connectors: { approvals: {} },
    } as unknown as ExtensionApplicationRuntime
    await expect(
      verifyExtensionConnection({} as BrowserWindow, runtime, host, {
        click: () => Promise.reject(new Error('assembly complete')),
        wait: () => Promise.reject(new Error('Unexpected native wait')),
        guest: () => Promise.reject(new Error('Unexpected native guest')),
      }),
    ).rejects.toThrow('assembly complete')
    const bundle = await build({
      entryPoints: [join(owned, 'connection-source', 'page.js')],
      bundle: true,
      platform: 'browser',
      format: 'iife',
      write: false,
    })
    const listeners = new Set<(message: unknown) => void>(),
      sent: unknown[] = [],
      controls = new Map(
        ['connect', 'locate', 'read', 'state', 'output'].map((id) => [
          id,
          { disabled: true, textContent: '' },
        ]),
      ),
      body = { dataset: {} as Record<string, string> }
    runInNewContext(bundle.outputFiles[0]!.text, {
      document: { body, getElementById: (id: string) => controls.get(id) },
      window: {
        hvirExtension: {
          onMessage: (callback: (message: unknown) => void) => {
            listeners.add(callback)
            return () => listeners.delete(callback)
          },
          send: (message: unknown) => sent.push(message),
        },
        addEventListener: () => {},
      },
      AbortController,
      TextEncoder,
      performance,
      setTimeout,
      clearTimeout,
    })
    expect(sent).toEqual([{ kind: 'hello', contract: '1.0' }])
    for (const listener of listeners)
      listener({ kind: 'context', context: { visible: true } })
    for (const id of ['connect', 'locate', 'read'])
      expect(controls.get(id)?.disabled).toBe(false)
    for (const listener of listeners)
      listener({ kind: 'context', context: { visible: false } })
    for (const id of ['connect', 'locate', 'read'])
      expect(controls.get(id)?.disabled).toBe(true)
    expect(body.dataset['hiddenContexts']).toBe('1')
  } finally {
    await rm(owned, { recursive: true, force: true })
  }
})
