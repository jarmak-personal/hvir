import { describe, expect, it, vi } from 'vitest'

import { registerProjectIpc } from '../src/main/ipc/features/project'
import type { IpcInvokeContext, IpcRegistrar } from '../src/main/ipc/authority-router'
import type { SshConfigurationPort } from '../src/main/project-host/ssh-configuration-port'
import type { IpcDeps } from '../src/main/ipc/deps'

function fixture(port: Partial<SshConfigurationPort>) {
  const handlers = new Map<
    string,
    (request: unknown, context: IpcInvokeContext) => unknown
  >()
  const ipc = {
    handle: (
      channel: string,
      handler: (request: unknown, context: IpcInvokeContext) => unknown,
    ) => handlers.set(channel, handler),
  } as unknown as IpcRegistrar
  registerProjectIpc(ipc, { sshConfiguration: port } as IpcDeps)
  let active = true
  const context = {
    owner: () => {
      if (!active) throw new Error('Renderer revoked')
      return { id: 7, generation: 1 }
    },
  } as IpcInvokeContext
  return {
    invoke: (channel: string, request?: unknown) =>
      handlers.get(channel)!(request, context),
    revoke: () => {
      active = false
    },
  }
}

describe('SSH configuration IPC authority', () => {
  it('sends only connection fields and the live-owner assertion to the capability', async () => {
    const addSshHost = vi.fn((_fields, assertActive: () => void) => {
      assertActive()
      return Promise.resolve([])
    })
    const { invoke } = fixture({ addSshHost })
    const fields = {
      alias: 'added',
      hostname: 'new.example.test',
      username: 'riker',
      port: 22,
    }
    await expect(invoke('ssh:add-host', fields)).resolves.toEqual({ ok: true, value: [] })
    expect(addSshHost).toHaveBeenCalledWith(fields, expect.any(Function))
  })

  it('rejects a revoked caller before save and rejects late refresh delivery', async () => {
    const addSshHost = vi.fn(() => Promise.resolve([]))
    const save = fixture({ addSshHost })
    save.revoke()
    await expect(save.invoke('ssh:add-host', {})).resolves.toMatchObject({
      ok: false,
      error: 'Renderer revoked',
    })
    expect(addSshHost).not.toHaveBeenCalled()
    let complete!: () => void
    const read = fixture({
      refreshHosts: () =>
        new Promise((resolve) => {
          complete = () => resolve([])
        }),
    })
    const pending = read.invoke('ssh:refresh-hosts')
    read.revoke()
    complete()
    await expect(pending).resolves.toMatchObject({ ok: false, error: 'Renderer revoked' })
  })

  it('rejects save publication and identity selection after their caller is revoked', async () => {
    let publish!: () => void
    let complete!: () => void
    const save = fixture({
      addSshHost: (_fields, assertActive) =>
        new Promise((resolve, reject) => {
          publish = () => {
            try {
              assertActive()
              resolve([])
            } catch (reason) {
              reject(reason instanceof Error ? reason : new Error(String(reason)))
            }
          }
        }),
    })
    const pending = save.invoke('ssh:add-host', {})
    save.revoke()
    publish()
    await expect(pending).resolves.toMatchObject({ ok: false })
    const picker = fixture({
      pickIdentity: (assertActive) =>
        new Promise((resolve, reject) => {
          complete = () => {
            try {
              assertActive()
              resolve(undefined)
            } catch (reason) {
              reject(reason instanceof Error ? reason : new Error(String(reason)))
            }
          }
        }),
    })
    const selection = picker.invoke('ssh:pick-identity')
    picker.revoke()
    complete()
    await expect(selection).resolves.toMatchObject({ ok: false })
  })
})
