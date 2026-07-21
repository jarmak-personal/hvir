import { describe, expect, it, vi } from 'vitest'

import { LocalHost } from '../src/main/project-host/local-host'
import {
  MAX_OPEN_WEB_PANES_PER_HOST,
  WebPaneRouteRegistry,
} from '../src/main/web-pane/web-pane-route-registry'
import { localPath } from '../src/shared'

const root = localPath('/tmp/hvir-web-pane-tests')

function registry() {
  const disposeSession = vi.fn(() => Promise.resolve())
  const destroyGuest = vi.fn()
  const routes = new WebPaneRouteRegistry({
    prepareSession: vi.fn(() => Promise.resolve(disposeSession)),
    destroyGuest,
  })
  return { routes, disposeSession, destroyGuest }
}

function open(
  routes: WebPaneRouteRegistry,
  url: string,
  overrides: {
    readonly ownerId?: number
    readonly ownerGeneration?: number
    readonly terminalId?: string
  } = {},
) {
  return routes.open({
    ownerId: overrides.ownerId ?? 41,
    ownerGeneration: overrides.ownerGeneration,
    sourceTerminalId: overrides.terminalId ?? 'terminal-1',
    workspaceRoot: root,
    host: new LocalHost(),
    url,
  })
}

describe('WebPaneRouteRegistry', () => {
  it('deduplicates an origin while retaining the newly activated path', async () => {
    const { routes } = registry()
    try {
      const first = await open(routes, 'http://localhost:5173/first')
      const second = await open(routes, 'http://localhost:5173/second?q=1')
      expect(second.paneId).toBe(first.paneId)
      expect(second.partition).toBe(first.partition)
      expect(second.url).toBe('http://localhost:5173/second?q=1')

      expect(
        routes.claimAttachment({
          ownerId: 41,
          paneId: first.paneId,
          partition: first.partition,
          initialUrl: first.url,
        }),
      ).toBeUndefined()
      expect(
        routes.claimAttachment({
          ownerId: 41,
          paneId: first.paneId,
          partition: first.partition,
          initialUrl: second.url,
        }),
      ).toEqual(second)
    } finally {
      await routes.closeAll()
    }
  })

  it('coalesces rapid activation without authorizing the stale attachment URL', async () => {
    let finishPreparation: ((dispose: () => Promise<void>) => void) | undefined
    const prepared = new Promise<() => Promise<void>>((resolve) => {
      finishPreparation = resolve
    })
    const routes = new WebPaneRouteRegistry({
      prepareSession: () => prepared,
      destroyGuest: vi.fn(),
    })
    const firstOpening = open(routes, 'http://localhost:5173/first')
    const secondOpening = open(routes, 'http://localhost:5173/second')
    await vi.waitFor(() => expect(finishPreparation).toBeTypeOf('function'))
    finishPreparation!(() => Promise.resolve())
    const [first, second] = await Promise.all([firstOpening, secondOpening])

    expect(second.paneId).toBe(first.paneId)
    expect(
      routes.claimAttachment({
        ownerId: 41,
        paneId: first.paneId,
        partition: first.partition,
        initialUrl: first.url,
      }),
    ).toBeUndefined()
    expect(
      routes.claimAttachment({
        ownerId: 41,
        paneId: second.paneId,
        partition: second.partition,
        initialUrl: second.url,
      }),
    ).toEqual(second)
    await routes.closeAll()
  })

  it('keeps host aliases and renderer owners isolated', async () => {
    const { routes } = registry()
    try {
      const localhost = await open(routes, 'http://localhost:5173/')
      const ipv4 = await open(routes, 'http://127.0.0.1:5173/')
      const anotherOwner = await open(routes, 'http://localhost:5173/', {
        ownerId: 99,
      })
      expect(new Set([localhost.paneId, ipv4.paneId, anotherOwner.paneId]).size).toBe(3)
      expect(
        new Set([localhost.partition, ipv4.partition, anotherOwner.partition]).size,
      ).toBe(3)
    } finally {
      await routes.closeAll()
    }
  })

  it('isolates reused webContents ids by document generation', async () => {
    const { routes } = registry()
    const previous = await open(routes, 'http://localhost:5173/', {
      ownerGeneration: 1,
    })
    const current = await open(routes, 'http://localhost:5173/', {
      ownerGeneration: 2,
    })

    expect(current.paneId).not.toBe(previous.paneId)
    expect(routes.has(previous.paneId, 41, 2)).toBe(false)
    expect(routes.has(current.paneId, 41, 2)).toBe(true)

    await routes.closeOwner(41, 1)
    expect(routes.has(previous.paneId, 41, 1)).toBe(false)
    expect(routes.has(current.paneId, 41, 2)).toBe(true)
    await routes.closeAll()
  })

  it('gates attachment once and binds the resulting guest by its partition', async () => {
    const { routes, destroyGuest } = registry()
    const route = await open(routes, 'http://localhost:5173/')
    expect(
      routes.claimAttachment({
        ownerId: 7,
        paneId: route.paneId,
        partition: route.partition,
        initialUrl: route.url,
      }),
    ).toBeUndefined()
    expect(
      routes.claimAttachment({
        ownerId: 41,
        paneId: route.paneId,
        partition: route.partition,
        initialUrl: route.url,
      }),
    ).toEqual(route)
    expect(
      routes.claimAttachment({
        ownerId: 41,
        paneId: route.paneId,
        partition: route.partition,
        initialUrl: route.url,
      }),
    ).toBeUndefined()
    expect(routes.bindGuestForPartition(41, route.partition, 812)).toBe(route.paneId)
    expect(routes.bindGuestForPartition(41, route.partition, 813)).toBeUndefined()

    await routes.close(route.paneId, 41)
    expect(destroyGuest).toHaveBeenCalledWith(812)
  })

  it('classifies the three navigation outcomes without opening anything', async () => {
    const { routes } = registry()
    try {
      const route = await open(routes, 'http://localhost:5173/')
      expect(routes.navigationForPane(route.paneId, 41, '/relative')).toEqual({
        kind: 'block',
      })
      expect(
        routes.navigationForPane(route.paneId, 41, 'http://localhost:5173/deep'),
      ).toEqual({ kind: 'allow', url: 'http://localhost:5173/deep' })
      expect(
        routes.navigationForPane(route.paneId, 41, 'http://localhost:3000/api'),
      ).toEqual({ kind: 'loopback', url: 'http://localhost:3000/api' })
      expect(
        routes.navigationForPane(route.paneId, 41, 'https://example.com/login'),
      ).toEqual({ kind: 'external', url: 'https://example.com/login' })
      expect(
        routes.navigationForPane(route.paneId, 41, 'custom-protocol://example'),
      ).toEqual({ kind: 'block' })
    } finally {
      await routes.closeAll()
    }
  })

  it('revokes a late open when its workspace closes', async () => {
    let finishPreparation: ((dispose: () => Promise<void>) => void) | undefined
    const prepared = new Promise<() => Promise<void>>((resolve) => {
      finishPreparation = resolve
    })
    const disposeSession = vi.fn(() => Promise.resolve())
    const routes = new WebPaneRouteRegistry({
      prepareSession: () => prepared,
      destroyGuest: vi.fn(),
    })

    const opening = open(routes, 'http://localhost:5173/')
    await vi.waitFor(() => expect(finishPreparation).toBeTypeOf('function'))
    await routes.closeWorkspace(root)
    finishPreparation!(disposeSession)

    await expect(opening).rejects.toThrow('revoked while opening')
    expect(disposeSession).toHaveBeenCalledOnce()
  })

  it('revokes a late open when its renderer owner closes', async () => {
    let finishPreparation: ((dispose: () => Promise<void>) => void) | undefined
    const prepared = new Promise<() => Promise<void>>((resolve) => {
      finishPreparation = resolve
    })
    const disposeSession = vi.fn(() => Promise.resolve())
    const routes = new WebPaneRouteRegistry({
      prepareSession: () => prepared,
      destroyGuest: vi.fn(),
    })

    const opening = open(routes, 'http://localhost:5173/')
    await vi.waitFor(() => expect(finishPreparation).toBeTypeOf('function'))
    await routes.closeOwner(41)
    finishPreparation!(disposeSession)

    await expect(opening).rejects.toThrow('revoked while opening')
    expect(disposeSession).toHaveBeenCalledOnce()
  })

  it('tears down every route for one owner without touching another owner', async () => {
    const { routes, disposeSession, destroyGuest } = registry()
    const first = await open(routes, 'http://localhost:5173/')
    const second = await open(routes, 'http://localhost:5174/')
    const other = await open(routes, 'http://localhost:5175/', { ownerId: 99 })
    for (const [route, guestId] of [
      [first, 801],
      [second, 802],
      [other, 803],
    ] as const) {
      const ownerId = route === other ? 99 : 41
      expect(
        routes.claimAttachment({
          ownerId,
          paneId: route.paneId,
          partition: route.partition,
          initialUrl: route.url,
        }),
      ).toEqual(route)
      expect(routes.bindGuestForPartition(ownerId, route.partition, guestId)).toBe(
        route.paneId,
      )
    }

    await routes.closeOwner(41)

    expect(routes.has(first.paneId, 41)).toBe(false)
    expect(routes.has(second.paneId, 41)).toBe(false)
    expect(routes.has(other.paneId, 99)).toBe(true)
    expect(destroyGuest).toHaveBeenCalledWith(801)
    expect(destroyGuest).toHaveBeenCalledWith(802)
    expect(destroyGuest).not.toHaveBeenCalledWith(803)
    expect(disposeSession).toHaveBeenCalledTimes(2)
    await routes.closeAll()
  })

  it('lists and closes only the routes sourced by one terminal generation', async () => {
    const { routes } = registry()
    const first = await open(routes, 'http://localhost:5173/', {
      ownerGeneration: 2,
    })
    const second = await open(routes, 'http://localhost:5174/', {
      ownerGeneration: 2,
    })
    const other = await open(routes, 'http://localhost:5175/', {
      ownerGeneration: 2,
      terminalId: 'terminal-2',
    })

    expect(routes.paneIdsForTerminal('terminal-1', 41, 2, root)).toEqual(
      [first.paneId, second.paneId].sort(),
    )
    await routes.closeTerminal('terminal-1', 41, 2)
    expect(routes.has(first.paneId, 41, 2)).toBe(false)
    expect(routes.has(second.paneId, 41, 2)).toBe(false)
    expect(routes.has(other.paneId, 41, 2)).toBe(true)
    await routes.closeAll()
  })

  it('revokes a late open when its source terminal begins moving', async () => {
    let finishPreparation: ((dispose: () => Promise<void>) => void) | undefined
    const prepared = new Promise<() => Promise<void>>((resolve) => {
      finishPreparation = resolve
    })
    const disposeSession = vi.fn(() => Promise.resolve())
    const routes = new WebPaneRouteRegistry({
      prepareSession: () => prepared,
      destroyGuest: vi.fn(),
    })

    const opening = open(routes, 'http://localhost:5173/', {
      ownerGeneration: 2,
    })
    await vi.waitFor(() => expect(finishPreparation).toBeTypeOf('function'))
    expect(routes.hasPendingForTerminal('terminal-1', 41, 2)).toBe(true)
    await routes.closeTerminal('terminal-1', 41, 2)
    finishPreparation!(disposeSession)

    await expect(opening).rejects.toThrow('revoked while opening')
    expect(disposeSession).toHaveBeenCalledOnce()
    expect(routes.hasPendingForTerminal('terminal-1', 41, 2)).toBe(false)
  })

  it('blocks new routes behind an exact terminal-move authority lease', async () => {
    const { routes } = registry()
    const existing = await open(routes, 'http://localhost:5173/', {
      ownerGeneration: 2,
    })
    const release = routes.blockTerminalMove('terminal-1', 41, 2, root, [existing.paneId])

    await expect(
      open(routes, 'http://localhost:5173/reused', { ownerGeneration: 2 }),
    ).rejects.toThrow('authority is moving')
    await expect(
      open(routes, 'http://localhost:5174/', { ownerGeneration: 2 }),
    ).rejects.toThrow('authority is moving')
    release()
    await expect(
      open(routes, 'http://localhost:5174/', { ownerGeneration: 2 }),
    ).resolves.toMatchObject({ origin: 'http://localhost:5174' })
    expect(() =>
      routes.blockTerminalMove('terminal-1', 41, 2, root, ['stale-pane']),
    ).toThrow('authority changed')
    await routes.closeAll()
  })

  it('refuses host capacity without silently evicting an existing pane', async () => {
    const { routes } = registry()
    try {
      const opened = await Promise.all(
        Array.from({ length: MAX_OPEN_WEB_PANES_PER_HOST }, (_, index) =>
          open(routes, `http://localhost:${5_100 + index}/`),
        ),
      )
      await expect(open(routes, 'http://localhost:6100/')).rejects.toThrow(
        `limit ${MAX_OPEN_WEB_PANES_PER_HOST}`,
      )
      expect(opened.every((route) => routes.has(route.paneId, 41))).toBe(true)
    } finally {
      await routes.closeAll()
    }
  })
})
