import { describe, expect, it } from 'vitest'

import {
  asHarnessProfileId,
  asHarnessProviderId,
  localPath,
  type HarnessProfileInput,
} from '../src/shared'
import {
  applyExecutableGrant,
  applyPathBindingGrant,
  harnessProfileBindingError,
  harnessRiskLabel,
  previewRiskLabel,
} from '../src/renderer/src/settings/harness-profile-editor-policy'
import { HarnessProfileRequestPolicy } from '../src/renderer/src/settings/harness-profile-request-policy'

describe('harness profile editor policy', () => {
  it('invalidates load/save/delete races when workspaces switch or mutations overlap', () => {
    const policy = new HarnessProfileRequestPolicy()
    policy.switchWorkspace()
    const load = policy.start('load')
    const save = policy.start('mutation')
    const remove = policy.start('mutation')
    expect(policy.isCurrent(save)).toBe(false)
    expect(policy.isCurrent(remove)).toBe(true)
    policy.switchWorkspace()
    expect(policy.isCurrent(load)).toBe(false)
    expect(policy.isCurrent(save)).toBe(false)
    expect(policy.isCurrent(remove)).toBe(false)
  })

  it('drops stale probes and previews while allowing failure retry', () => {
    const policy = new HarnessProfileRequestPolicy()
    policy.switchWorkspace()
    const oldProbe = policy.start('probe:profile')
    const currentProbe = policy.start('probe:profile')
    expect(policy.isCurrent(oldProbe)).toBe(false)
    expect(policy.isCurrent(currentProbe)).toBe(true)

    const preview = policy.start('preview')
    policy.switchProfile()
    expect(policy.isCurrent(preview, true)).toBe(false)

    const failedSave = policy.start('mutation')
    const retry = policy.start('mutation')
    expect(policy.isCurrent(failedSave)).toBe(false)
    expect(policy.isCurrent(retry)).toBe(true)
  })

  it('applies main-issued grants without changing unrelated permission fields', () => {
    const path = localPath('/outside/tool')
    expect(
      applyExecutableGrant(
        { kind: 'path', path: localPath('/old') },
        { id: 'grant-1', path },
      ),
    ).toEqual({ kind: 'path', path, grantId: 'grant-1' })

    const input: HarnessProfileInput = {
      displayName: 'Custom',
      providerId: asHarnessProviderId('opaque'),
      scope: { kind: 'global' },
      executable: { kind: 'command', command: 'agent' },
      args: [],
      environment: [],
      pathBindings: [
        { name: 'first', path: localPath('/first') },
        { name: 'second', path: localPath('/second') },
      ],
      order: 1,
    }
    const updated = applyPathBindingGrant(input, 1, { id: 'grant-2', path })
    expect(updated.pathBindings[0]).toBe(input.pathBindings[0])
    expect(updated.pathBindings[1]).toEqual({
      name: 'second',
      path,
      grantId: 'grant-2',
    })
  })

  it('keeps invalid binding drafts out of command previews', () => {
    const input: HarnessProfileInput = {
      displayName: 'Custom',
      providerId: asHarnessProviderId('opaque'),
      scope: { kind: 'global' },
      executable: { kind: 'command', command: 'agent' },
      args: [],
      environment: [{ kind: 'literal', name: 'TOKEN', value: '' }],
      pathBindings: [{ name: 'repo', path: localPath('/repo') }],
      order: 1,
    }

    expect(harnessProfileBindingError(input)).toBeUndefined()
    expect(
      harnessProfileBindingError({
        ...input,
        environment: [{ kind: 'literal', name: '', value: '' }],
      }),
    ).toBe('Invalid environment binding')
    expect(
      harnessProfileBindingError({
        ...input,
        environment: [
          {
            kind: 'reference',
            name: 'TOKEN',
            source: 'host',
            sourceName: '',
          },
        ],
      }),
    ).toBe("Invalid environment binding for 'TOKEN'")
    expect(
      harnessProfileBindingError({
        ...input,
        environment: [
          { kind: 'literal', name: 'TOKEN', value: '' },
          { kind: 'unset', name: 'TOKEN' },
        ],
      }),
    ).toBe("Duplicate environment binding 'TOKEN'")
    expect(
      harnessProfileBindingError({
        ...input,
        pathBindings: [{ name: '', path: localPath('/repo') }],
      }),
    ).toBe('Invalid profile path binding')
    expect(
      harnessProfileBindingError({
        ...input,
        pathBindings: [
          { name: 'repo', path: localPath('/one') },
          { name: 'repo', path: localPath('/two') },
        ],
      }),
    ).toBe("Duplicate path binding 'repo'")
    expect(
      harnessProfileBindingError({
        ...input,
        args: [
          {
            parts: [{ kind: 'path', source: 'binding', binding: 'missing' }],
          },
        ],
      }),
    ).toBe("Unknown path binding 'missing'")
  })

  it('keeps risk labels policy-only and preview-derived', () => {
    expect(harnessRiskLabel('elevated')).toBe('Elevated')
    expect(previewRiskLabel([])).toBe('Pending validation')
    expect(
      previewRiskLabel([
        {
          profileId: asHarnessProfileId('profile'),
          launchRevision: 1,
          providerId: asHarnessProviderId('opaque'),
          mode: 'fresh',
          executable: 'agent',
          args: [],
          environment: [],
          command: 'agent',
          risk: 'unclassified',
          artifactIdentity: 'artifact',
        },
      ]),
    ).toBe('Unclassified')
  })
})
