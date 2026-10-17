import { describe, expect, it } from 'vitest'
import { validateExtensionManifest } from '../src/shared/extensions/manifest'
import { exampleManifest } from './fixtures/extension-package'

const connector = {
  id: 'installed-tool',
  description: 'Installed tool',
  context: 'application',
  timeoutMs: 180_000,
  outputBytes: 4 * 1024 * 1024,
  environment: ['TOOL_HOME'],
}
describe('connector declaration contract', () => {
  it('declares native requirements as data and reports unknown fields without granting them', () => {
    const result = validateExtensionManifest(
      exampleManifest({
        connectors: [{ ...connector, claimedReadOnly: true }],
        optionalCapabilities: [
          'connector.execute',
          'connector.output',
          'connector.status',
        ],
      }),
    )
    expect(result.manifest.connectors).toEqual([connector])
    expect(result.manifest.access).toEqual([])
    expect(result.warnings).toContain('Ignored unknown field: claimedReadOnly')
  })
  it.each([
    { timeoutMs: 0 },
    { timeoutMs: 180_001 },
    { outputBytes: 0 },
    { outputBytes: 4 * 1024 * 1024 + 1 },
    { context: 'selected-workspace' },
    { environment: ['TOKEN', 'TOKEN'] },
    { environment: ['INVALID;NAME'] },
  ])('rejects malformed finite declaration %j', (change) => {
    expect(() =>
      validateExtensionManifest(
        exampleManifest({ connectors: [{ ...connector, ...change }] }),
      ),
    ).toThrow()
  })
  it('rejects duplicate connector identities and more than eight declarations', () => {
    expect(() =>
      validateExtensionManifest(exampleManifest({ connectors: [connector, connector] })),
    ).toThrow('Duplicate connector')
    expect(() =>
      validateExtensionManifest(
        exampleManifest({ connectors: Array(9).fill(connector) }),
      ),
    ).toThrow('Too many connector')
  })
})
