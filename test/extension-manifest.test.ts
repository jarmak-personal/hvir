import { describe, expect, it } from 'vitest'
import { validateExtensionManifest } from '../src/shared/extensions/manifest'
import { EXTENSION_LIMITS } from '../src/shared/extensions/contract'

import { exampleManifest } from './fixtures/extension-package'

describe('public extension manifest policy', () => {
  it.each(['1.0', '1.1', '1.99'])(
    'admits compatible target %s with all required capabilities',
    (contract) => {
      expect(
        validateExtensionManifest(exampleManifest({ contract })).manifest.contract,
      ).toBe(contract)
    },
  )
  it('keeps unavailable optional capabilities independent', () => {
    expect(
      validateExtensionManifest(
        exampleManifest({ optionalCapabilities: ['future.read'] }),
      ).manifest.optionalCapabilities,
    ).toEqual(['future.read'])
  })
  it.each([
    { contract: '2.0' },
    { contract: '0.9' },
    { requiredCapabilities: ['future.safety'] },
    { access: ['project.all'] },
  ])('refuses incompatible or unavailable authority: %j', (override) => {
    expect(() => validateExtensionManifest(exampleManifest(override))).toThrow()
  })
  it('reports unknown fields without weakening known authority', () => {
    const validated = validateExtensionManifest(
      exampleManifest({
        userApproved: true,
        permission: 'all-hosts',
        newField: { anything: true },
      }),
    )
    expect(validated.warnings).toHaveLength(3)
    expect(validated.manifest.access).toEqual([])
    expect(() =>
      validateExtensionManifest(
        exampleManifest({
          userApproved: true,
          requiredCapabilities: ['unknown.required.safety'],
        }),
      ),
    ).toThrow('unknown.required.safety')
  })
  it('names an application release only when supplied', () => {
    expect(() => validateExtensionManifest(exampleManifest({ contract: '2.0' }))).toThrow(
      'Requires extension contract 2.0',
    )
    expect(() =>
      validateExtensionManifest(
        exampleManifest({ requiredCapabilities: ['unsupported'], minimumHvir: '0.9.0' }),
      ),
    ).toThrow('Requires hvir 0.9.0')
  })
  it.each([
    '/etc/passwd',
    '../outside.html',
    'dir/../../outside.html',
    'dir\\file.html',
    'https://elsewhere/view',
    'view.html?target=other',
    '%2e%2e/view',
  ])('refuses escaping or ambiguous asset %s', (entry) => {
    expect(() =>
      validateExtensionManifest(
        exampleManifest({
          views: [
            {
              id: 'view',
              title: 'View',
              entry,
              placement: 'application',
              representations: ['view'],
            },
          ],
        }),
      ),
    ).toThrow()
  })
  it('bounds unknown-field warnings and rejects duplicate view identities', () => {
    const unknown = Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => [`unknown${index}`, true]),
    )
    expect(validateExtensionManifest(exampleManifest(unknown)).warnings).toHaveLength(16)
    const view = {
      id: 'view',
      title: 'View',
      entry: 'index.html',
      placement: 'application',
      representations: ['view'],
    }
    expect(() =>
      validateExtensionManifest(exampleManifest({ views: [view, view] })),
    ).toThrow('Duplicate')
  })
  it('admits bounded workspace/top placements and finite actions while refusing authority omissions', () => {
    const base = exampleManifest()
    const view = base.views[0]!
    const rail = {
      id: 'status',
      placement: 'session',
      kind: 'observation',
      icon: '◷',
      tooltip: 'Status',
      click: { view: view.id, placement: 'popup' },
    }
    const action = {
      id: 'summarize',
      title: 'Summarize',
      view: view.id,
      agents: true,
      effects: { delete: false, replace: false },
      timeoutMs: EXTENSION_LIMITS.actionMaximumMs,
    }
    const admitted = validateExtensionManifest(
      exampleManifest({
        views: [
          { ...view, placement: 'workspace', navigation: 'left' },
          { ...view, id: 'library', navigation: 'top' },
        ],
        railItems: [rail],
        actions: [action],
        updater: 'updater.html',
      }),
    ).manifest
    expect(admitted.views.map((entry) => entry.navigation)).toEqual(['left', 'top'])
    expect(admitted.actions?.[0]?.timeoutMs).toBe(180000)
    for (const invalid of [
      { ...action, agents: undefined },
      { ...action, effects: undefined },
      { ...action, effects: { delete: false } },
      { ...action, timeoutMs: 999 },
      { ...action, timeoutMs: 180001 },
      { ...action, timeoutMs: Infinity },
      { ...action, view: 'undeclared' },
    ])
      expect(() =>
        validateExtensionManifest(exampleManifest({ actions: [invalid] })),
      ).toThrow()
    for (const invalid of [
      { ...rail, icon: '<svg>' },
      { ...rail, label: 'a'.repeat(25) },
      { ...rail, click: { view: 'undeclared', placement: 'popup' } },
    ])
      expect(() =>
        validateExtensionManifest(exampleManifest({ railItems: [invalid] })),
      ).toThrow()
  })
  it('accepts the exact per-package contribution counts and rejects overflow or duplicate identities', () => {
    const view = exampleManifest().views[0]!
    const views = Array.from(
      { length: EXTENSION_LIMITS.viewsPerExtension },
      (_, index) => ({ ...view, id: `view-${index}` }),
    )
    const railItems = Array.from({ length: EXTENSION_LIMITS.railItems }, (_, index) => ({
      id: `item-${index}`,
      placement: 'header',
      kind: 'control',
      icon: '◇',
      tooltip: 'Open',
      click: { view: views[0]!.id, placement: 'viewer' },
    }))
    const actions = Array.from({ length: EXTENSION_LIMITS.actions }, (_, index) => ({
      id: `action-${index}`,
      title: 'Action',
      view: views[0]!.id,
      agents: false,
      effects: { delete: false, replace: false },
    }))
    expect(
      validateExtensionManifest(exampleManifest({ views, railItems, actions })).manifest
        .views,
    ).toHaveLength(8)
    for (const overflow of [
      { views: [...views, { ...views[0]!, id: 'extra' }] },
      { railItems: [...railItems, { ...railItems[0]!, id: 'extra' }] },
      { actions: [...actions, { ...actions[0]!, id: 'extra' }] },
      { railItems: [railItems[0], railItems[0]] },
      { actions: [actions[0], actions[0]] },
    ])
      expect(() =>
        validateExtensionManifest(exampleManifest({ views, ...overflow })),
      ).toThrow()
  })
})
