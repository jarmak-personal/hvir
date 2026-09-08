import { runInNewContext } from 'node:vm'
import { expect, it } from 'vitest'
import {
  installReplacementDeliveryObserver,
  waitForReplacementDeliveries,
} from '../src/main/smoke/renderer-recovery-delivery'
import { asHostId, hostPath, localPath } from '../src/shared'

it('matches fragmented per-terminal output while retaining exact watch and health authority', async () => {
  const listeners = new Map<string, (value: unknown) => void>()
  const window = {
    hvir: {
      on: (channel: string, listener: (value: unknown) => void) =>
        listeners.set(channel, listener),
    },
    __hvirRendererRecoveryDeliveries: {
      local: false,
      ssh: false,
      watch: false,
      health: false,
    },
  }
  const contents = {
    executeJavaScript: (script: string): Promise<unknown> =>
      Promise.resolve(runInNewContext(script, { window, setTimeout }) as unknown),
  }
  const path = localPath('/fixture/live.txt')
  await installReplacementDeliveryObserver(contents, path, 'exact-occurrence')
  const data = listeners.get('pty:data')!
  data({ id: 'unrelated', data: 'hvir-replacement-local' })
  data({ id: 'renderer-recovery-local', data: 'hvir-replacement-' })
  data({ id: 'renderer-recovery-ssh', data: 'local' })
  expect(window.__hvirRendererRecoveryDeliveries.local).toBe(false)
  expect(window.__hvirRendererRecoveryDeliveries.ssh).toBe(false)
  data({ id: 'renderer-recovery-local', data: 'local' })
  for (const character of 'hvir-replacement-ssh')
    data({ id: 'renderer-recovery-ssh', data: character })
  listeners.get('project:watch')!({ path: hostPath(asHostId('other'), path.path) })
  listeners.get('workbench-health:state')!({ items: [{ occurrenceId: 'wrong' }] })
  expect(window.__hvirRendererRecoveryDeliveries).toEqual({
    local: true,
    ssh: true,
    watch: false,
    health: false,
  })
  listeners.get('project:watch')!({ path })
  listeners.get('workbench-health:state')!({
    items: [{ occurrenceId: 'exact-occurrence' }],
  })
  await waitForReplacementDeliveries(contents)
})
