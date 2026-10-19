import { expect, it, vi } from 'vitest'
import { createElectronExtensionSetup } from '../src/main/extensions/electron-extension-setup'
import { localPath, hostPath, asHostId } from '../src/shared/host-path'
import { SETUP_LIMITS } from '../src/shared/extensions/setup-proposal'

vi.mock('electron', () => ({ BrowserWindow: {}, dialog: {} }))

it('uses the native single-file selection and one bounded local ProjectHost UTF-8 snapshot', async () => {
  const choose = vi
    .fn()
    .mockResolvedValue({ canceled: false, filePaths: ['/proposal.json'] })
  const readTextFilePrefix = vi
    .fn()
    .mockResolvedValue({ complete: true, validUtf8: true, content: '{}' })
  const picker = createElectronExtensionSetup(
    { hostId: asHostId('local'), readTextFilePrefix },
    { choose },
  )
  const owner = { id: 1, generation: 1 },
    current = vi.fn()
  const selected = await picker.choose(owner, current)
  expect(choose).toHaveBeenCalledWith(
    owner,
    expect.objectContaining({
      properties: ['openFile'],
      filters: [{ name: 'Setup JSON', extensions: ['json'] }],
    }),
  )
  expect(readTextFilePrefix).not.toHaveBeenCalled()
  expect(await picker.read(selected!, current)).toEqual({
    name: 'proposal.json',
    text: '{}',
  })
  expect(readTextFilePrefix).toHaveBeenCalledWith(
    localPath('/proposal.json'),
    SETUP_LIMITS.bytes,
  )
  readTextFilePrefix.mockResolvedValueOnce({
    complete: false,
    validUtf8: true,
    content: '{}',
  })
  await expect(picker.read(selected!, current)).rejects.toThrow(/384 KiB/)
  readTextFilePrefix.mockResolvedValueOnce({
    complete: true,
    validUtf8: false,
    content: '{}',
  })
  await expect(picker.read(selected!, current)).rejects.toThrow(/UTF-8/)
  await expect(
    picker.read(hostPath(asHostId('remote'), '/proposal.json'), current),
  ).rejects.toThrow(/this machine/)
})

it('fences late native selections and snapshot replies through the current trusted request', async () => {
  const choose = vi
    .fn()
    .mockResolvedValue({ canceled: false, filePaths: ['/proposal.json'] })
  let current = true
  const assertCurrent = () => {
    if (!current) throw new Error('retired')
  }
  const readTextFilePrefix = vi.fn().mockImplementation(() => {
    current = false
    return Promise.resolve({ complete: true, validUtf8: true, content: '{}' })
  })
  const picker = createElectronExtensionSetup(
    { hostId: asHostId('local'), readTextFilePrefix },
    { choose },
  )
  await expect(picker.read(localPath('/proposal.json'), assertCurrent)).rejects.toThrow(
    'retired',
  )
  current = true
  choose.mockImplementationOnce(() => {
    current = false
    return Promise.resolve({ canceled: false, filePaths: ['/proposal.json'] })
  })
  await expect(picker.choose({ id: 1, generation: 1 }, assertCurrent)).rejects.toThrow(
    'retired',
  )
})
