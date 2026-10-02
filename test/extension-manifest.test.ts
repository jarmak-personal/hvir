import { describe, expect, it } from 'vitest'
import { validateExtensionManifest } from '../src/shared/extensions/manifest'

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
})
