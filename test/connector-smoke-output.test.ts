import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import type { BrowserWindow, WebContents } from 'electron'
import { expect, it, vi } from 'vitest'
import { localPath } from '../src/shared/host-path'
import type { ExtensionApplicationRuntime } from '../src/main/extensions/extension-application'
import type { ProjectHost } from '../src/main/project-host/project-host'
import type { RendererResourceScopes } from '../src/main/renderer-resource-scopes'
import { verifyExtensionConnectors } from '../src/main/smoke/extension-connectors'

vi.mock('../src/main/smoke/window-focus', () => ({
  focusSmokeWindow: () => Promise.resolve(),
}))

/** Immediate guest bridge/document only; real native authority stays in Electron. */
function guestFixture() {
  type Message = {
    kind: string
    id?: string
    capability?: string
    input?: { release?: boolean }
  }
  const listeners = new Set<(message: unknown) => void>()
  const clicks = new Map<string, () => void>()
  const elements = new Map(
    [
      'status',
      'native-run',
      'native-next',
      'native-status',
      'native-output',
      'native-args',
    ].map((id) => [
      id,
      {
        textContent: '',
        disabled: false,
        value: '[]',
        addEventListener: (_name: string, callback: () => void) =>
          clicks.set(id, callback),
        removeEventListener: () => clicks.delete(id),
        click: () => clicks.get(id)?.(),
      },
    ]),
  )
  let executes = 0
  let heldPage: Message | undefined
  const emit = (message: unknown) => {
    for (const callback of listeners) callback(message)
  }
  const reply = (message: Message, value: unknown) =>
    emit({ kind: 'result', id: message.id, ok: true, value })
  const context = createContext({
    window: {
      hvirExtension: {
        onMessage: (callback: (message: unknown) => void) => {
          listeners.add(callback)
          return () => listeners.delete(callback)
        },
        send: (message: Message) => {
          if (message.capability === 'connector.execute') {
            executes++
            reply(
              message,
              executes === 1
                ? { outcome: 'not-started', reason: 'unapproved' }
                : { outcome: 'completed', host: 'local', code: 0, receipt: 'owned' },
            )
          } else if (message.capability === 'connector.output') {
            if (message.input?.release) reply(message, { released: true })
            else heldPage = message
          }
        },
      },
      hvirUI: { bindPresentation: () => () => {} },
      setTimeout,
      clearTimeout,
      addEventListener: () => {},
      removeEventListener: () => {},
    },
    document: { getElementById: (id: string) => elements.get(id) },
    Date,
  })
  runInContext(readFileSync('packages/extension-reference/reference.js', 'utf8'), context)
  return {
    guest: {
      executeJavaScript: (script: string) =>
        Promise.resolve(runInContext(script, context) as unknown),
    } as unknown as WebContents,
    element: (id: string) => elements.get(id)!,
    hasPage: () => !!heldPage,
    release: () => {
      if (!heldPage) throw new Error('No held page')
      reply(heldPage, { data: 'connector evidence\n', nextOffset: null })
    },
    close: () => runInContext('dispose()', context) as unknown,
  }
}

it('waits for the actual reference output page and idle Run control after completed execution', async () => {
  const data = guestFixture()
  const view = {
    id: 'view',
    installationId: 'owned',
    contributionId: 'reference',
    role: 'viewer',
  }
  const active = {
    installationId: 'owned',
    revision: { manifest: { id: 'hvir.connector-reference' } },
  }
  const runtime = {
    activations: {
      directory: localPath('/owned/extensions'),
      active: new Map([['owned', active]]),
    },
    guests: { snapshot: () => [view] },
    connectors: { approvals: { status: () => [{ availability: 'supported' }] } },
    contributions: { snapshot: () => [] },
  } as unknown as ExtensionApplicationRuntime
  const host = {
    createDirectoryExclusive: () => Promise.resolve(),
    createFileExclusive: () => Promise.resolve(),
    writeFile: () => Promise.resolve(),
    readdir: () => Promise.resolve([]),
    readFile: () => Promise.resolve(Buffer.from('{}')),
    stat: () => Promise.reject(new Error('Absent authored marker')),
  } as unknown as ProjectHost
  const win = {
    webContents: { id: 1, executeJavaScript: () => Promise.resolve({ ready: true }) },
  } as unknown as BrowserWindow
  const scopes = {
    currentOwner: () => ({ id: 1, generation: 1 }),
  } as unknown as RendererResourceScopes
  let readyObserved = false
  const diagnostic = vi.spyOn(console, 'log').mockImplementation(() => {})
  try {
    const result = verifyExtensionConnectors(
      win,
      runtime,
      scopes,
      host,
      localPath('/owned/reference'),
      {
        click: () => Promise.resolve(),
        guest: () => Promise.resolve(data.guest),
        wait: async (predicate, label) => {
          if (label === 'approved native public result') {
            await vi.waitFor(() => expect(data.hasPage()).toBe(true))
            expect(data.element('native-status').textContent).toContain('completed')
            expect(data.element('native-run').disabled).toBe(true)
            expect(await predicate()).toBe(false)
            data.release()
            await vi.waitFor(() =>
              expect(data.element('native-run').disabled).toBe(false),
            )
            expect(await predicate()).toBe(true)
            readyObserved = true
          } else if (label === 'approved updater observation without popup') {
            throw new Error('Later updater milestone outside this boundary proof')
          }
        },
      },
    )
    await expect(result).rejects.toThrow(
      'Later updater milestone outside this boundary proof',
    )
    expect(readyObserved).toBe(true)
    expect(data.element('native-output').textContent).toBe('connector evidence\n')
  } finally {
    data.close()
    diagnostic.mockRestore()
  }
})
