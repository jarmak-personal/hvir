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
  const admitted = scopes.actionAuthority(connection, binding).signal
  scopes.configure(grant, false)
  expect(admitted.aborted).toBe(true)
  expect(scopes.signal(connection).aborted).toBe(false)
  expect(() =>
    scopes.assertCapability(connection, binding, 'connector.execute', 'local'),
  ).toThrow()
  scopes.register('ssh', 'two:1')
  expect(() => scopes.assertTarget(connection, 'ssh')).toThrow('revoked')
  expect(scopes.grants('ssh')).toEqual([])
})

it('grant additions and idempotent changes preserve work; removing one grant fences only its captured action binding', () => {
  const scopes = new AgentForwardScopeOwner(() => undefined)
  scopes.register('ssh', 'forward')
  const connection: AgentConnection = {
    id: 'request',
    origin: 'ssh-forward',
    host: asHostId('ssh'),
    generation: 'forward',
    signal: new AbortController().signal,
    current: () => undefined,
  }
  const binding = {
    installation: 'install',
    revision: 'revision',
    action: 'one',
    workspace: 'workspace',
  }
  const grant: AgentForwardGrant = {
    host: 'ssh',
    generation: 'forward',
    ...binding,
    capability: 'connector.execute',
    executionHost: 'local',
  }
  const before = scopes.actionAuthority(connection, binding)
  const view = scopes.viewSignal(connection)
  scopes.configure(grant, true)
  expect(before.signal.aborted).toBe(false)
  expect(() => before.assertCapability('connector.execute', 'local')).toThrow(
    'additional',
  )
  const captured = scopes.actionAuthority(connection, binding)
  const other = scopes.actionAuthority(connection, { ...binding, action: 'two' })
  scopes.configure(grant, true)
  scopes.configure({ ...grant, action: 'two' }, true)
  expect(captured.signal.aborted).toBe(false)
  scopes.configure({ ...grant, action: 'two' }, false)
  expect(captured.signal.aborted).toBe(false)
  expect(other.signal.aborted).toBe(false)
  captured.assertCapability('connector.execute', 'local')
  scopes.configure(grant, false)
  expect(captured.signal.aborted).toBe(true)
  expect(view.aborted).toBe(false)
})
