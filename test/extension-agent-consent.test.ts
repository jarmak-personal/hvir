import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { readInstallationState } from '../src/main/extensions/installation-state'
import { LocalAgentAccessOwner } from '../src/main/agent/access-owner'
import { extensionInstallationFixture } from './fixtures/extension-installation'

it('persists consent through the extension writer, refuses a second writer and revokes pending actions on writer loss while inspection remains available', async () => {
  const data = await extensionInstallationFixture(),
    owner = data.make(),
    conflict = data.make(),
    successor = data.make()
  const access = new LocalAgentAccessOwner(vi.fn(), () => Promise.resolve(), {
    allowed: () => owner.agentAccess(),
    writable: () => owner.snapshot().writable,
    signal: (id) => owner.agentSignal(id),
  })
  try {
    await data.packageAt('valid')
    await owner.start(data.lock)
    await owner.enable('valid', owner.snapshot().installations[0]!.revision!)
    const installation = [...owner.active.keys()][0]!
    await conflict.start(data.lock)
    expect(conflict.snapshot().writable).toBe(false)
    await expect(conflict.configureAgentAccess(installation, true)).rejects.toThrow(
      'Another hvir instance',
    )
    expect(conflict.agentAccess()).toEqual([])
    access.restore({
      enabled: true,
      confirmDestructive: true,
      extensions: [installation],
    })
    expect(access.snapshot().extensions).toEqual([])
    await owner.configureAgentAccess(installation, true)
    expect(access.snapshot().extensions).toEqual([installation])
    expect(
      readInstallationState(
        JSON.parse(await fs.readFile(join(data.root, 'state.json'), 'utf8')),
      ).installations[0]!.agentAccess,
    ).toBe(true)
    const inspection = access.admit(new AbortController().signal)
    const actionSignal = AbortSignal.any([
      inspection.signal,
      access.extensionSignal(installation),
    ])
    const pending = access.authorizeAction(
      {
        installation,
        title: 'Declared delete',
        input: 'null',
        effects: { delete: true, replace: false },
      },
      inspection.current,
      actionSignal,
    )
    const refused = expect(pending).rejects.toThrow()
    expect(access.snapshot().confirmations).toHaveLength(1)
    await fs.rename(data.lock.path, `${data.lock.path}.old`)
    await fs.writeFile(data.lock.path, '')
    await expect(owner.assertWritable()).rejects.toThrow('revoked')
    await refused
    expect(actionSignal.aborted).toBe(true)
    expect(access.snapshot().extensionsWritable).toBe(false)
    expect(access.snapshot().confirmations).toEqual([])
    expect(() => inspection.current()).not.toThrow()
    await access.configure({ enabled: false, confirmDestructive: false })
    await access.configure({ enabled: true, confirmDestructive: false })
    expect(() => access.admit(new AbortController().signal).current()).not.toThrow()
    await owner.dispose()
    await successor.start(data.lock)
    expect(successor.agentAccess()).toEqual([installation])
  } finally {
    access.dispose()
    await Promise.all([owner.dispose(), conflict.dispose(), successor.dispose()])
    await data.dispose()
  }
})

it('serializes consent writes and keeps the latest disable effective while an older enable publication completes', async () => {
  const data = await extensionInstallationFixture(),
    owner = data.make()
  let finish: (() => void) | undefined
  const write = data.host.writeFile.bind(data.host)
  try {
    await data.packageAt('valid')
    await owner.start(data.lock)
    await owner.enable('valid', owner.snapshot().installations[0]!.revision!)
    const installation = [...owner.active.keys()][0]!
    await owner.configureAgentAccess(installation, true)
    const admitted = owner.agentSignal(installation)
    let publications = 0
    vi.spyOn(data.host, 'writeFile').mockImplementation(async (path, bytes, options) => {
      if (path.path === join(data.root, 'state.json')) {
        publications++
        if (publications === 1)
          await new Promise<void>((resolve) => {
            finish = resolve
          })
        if (publications === 2) expect(owner.agentAccess()).toEqual([])
      }
      return write(path, bytes, options)
    })
    const older = owner.configureAgentAccess(installation, true)
    await vi.waitFor(() => expect(finish).toBeDefined())
    const newer = owner.configureAgentAccess(installation, false)
    expect(admitted.aborted).toBe(true)
    expect(owner.agentAccess()).toEqual([])
    finish!()
    await Promise.all([older, newer])
    expect(owner.agentAccess()).toEqual([])
    expect(
      readInstallationState(
        JSON.parse(await fs.readFile(join(data.root, 'state.json'), 'utf8')),
      ).installations[0]!.agentAccess,
    ).toBe(false)
  } finally {
    finish?.()
    vi.restoreAllMocks()
    await owner.dispose()
    await data.dispose()
  }
})

it('defaults missing consent to off in the current schema while keeping accepted installations usable, and rejects present non-booleans', async () => {
  const data = await extensionInstallationFixture(),
    owner = data.make(),
    successor = data.make()
  const path = join(data.root, 'state.json')
  try {
    await data.packageAt('valid')
    await owner.start(data.lock)
    await owner.enable('valid', owner.snapshot().installations[0]!.revision!)
    const state = readInstallationState(JSON.parse(await fs.readFile(path, 'utf8')))
    const { agentAccess: _agentAccess, ...installation } = state.installations[0]!
    const current = { ...state, installations: [installation] }
    expect(readInstallationState(current).installations[0]!.agentAccess).toBe(false)
    for (const agentAccess of [null, 'true', 0, {}, []])
      expect(() =>
        readInstallationState({
          ...state,
          installations: [{ ...installation, agentAccess }],
        }),
      ).toThrow('Invalid extension state')
    await owner.dispose()
    await fs.writeFile(path, JSON.stringify(current))
    await successor.start(data.lock)
    expect(successor.active.has(installation.installationId)).toBe(true)
    expect(successor.agentAccess()).toEqual([])
    await successor.configureAgentAccess(installation.installationId, true)
    expect(
      readInstallationState(JSON.parse(await fs.readFile(path, 'utf8'))).installations[0]!
        .agentAccess,
    ).toBe(true)
  } finally {
    await Promise.all([owner.dispose(), successor.dispose()])
    await data.dispose()
  }
})
