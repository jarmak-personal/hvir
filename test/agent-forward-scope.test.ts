import { expect, it } from 'vitest'
import { AgentForwardScopeOwner } from '../src/main/agent/forward-scope'
import { asHostId } from '../src/shared/host-path'
import type { AgentConnection } from '../src/main/agent/stream-admission'
import type { AgentForwardGrant } from '../src/shared/agent/contract'

it('retains trusted host/generation and binds reusable additional grants to action/revision/destination', () => {
  const scopes = new AgentForwardScopeOwner(() => undefined),
    controller = new AbortController()
  scopes.register('ssh', 'one:1')
  const connection: AgentConnection = {
    id: 'request',
    origin: 'ssh-forward',
    host: asHostId('ssh'),
    generation: 'one:1',
    signal: controller.signal,
    current: () => undefined,
  }
  const binding = {
    installation: 'install',
    revision: 'revision',
    action: 'action',
    workspace: 'workspace',
  }
  const grant: AgentForwardGrant = {
    host: 'ssh',
    generation: 'one:1',
    ...binding,
    capability: 'connector.execute',
    executionHost: 'local',
  }
  expect(() => scopes.assertTarget(connection, 'local')).toThrow('cannot target')
  expect(() => scopes.assertTarget(connection, 'other')).toThrow('cannot target')
  expect(() =>
    scopes.assertCapability(connection, binding, 'connector.execute', 'local'),
  ).toThrow('additional')
  scopes.configure(grant, true)
  for (let index = 0; index < 2; index++)
    expect(() =>
      scopes.assertCapability(connection, binding, 'connector.execute', 'local'),
    ).not.toThrow()
  expect(() =>
    scopes.assertCapability(
      connection,
      { ...binding, action: 'other' },
      'connector.execute',
      'local',
    ),
  ).toThrow()
  expect(() =>
    scopes.assertCapability(
      connection,
      { ...binding, revision: 'other' },
      'connector.execute',
      'local',
    ),
  ).toThrow()
  expect(() =>
    scopes.assertCapability(connection, binding, 'connector.execute', 'local', 'other'),
  ).toThrow()
  const admitted = scopes.signal(connection)
  scopes.configure(grant, false)
  expect(admitted.aborted).toBe(true)
  expect(() =>
    scopes.assertCapability(connection, binding, 'connector.execute', 'local'),
  ).toThrow()
  scopes.register('ssh', 'two:1')
  expect(() => scopes.assertTarget(connection, 'ssh')).toThrow('revoked')
  expect(scopes.grants('ssh')).toEqual([])
})
