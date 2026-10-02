import {
  EXTENSION_CAPABILITIES,
  EXTENSION_CONTRACT,
  EXTENSION_LIMITS,
  type ExtensionManifest,
  type ExtensionContribution,
} from './contract'

export interface ManifestValidation {
  readonly manifest: ExtensionManifest
  readonly warnings: readonly string[]
}

export function extensionObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected an object')
  return value as Record<string, unknown>
}

export function extensionText(value: unknown, name: string, max = 120): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > max ||
    [...value].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  ) {
    throw new Error(`Invalid ${name}`)
  }
  return value
}

export function extensionId(value: unknown): string {
  const text = extensionText(value, 'identity', 80)
  if (!/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u.test(text))
    throw new Error('Invalid extension identity')
  return text
}

export function extensionAssetPath(value: unknown): string {
  const text = extensionText(value, 'asset path', 240)
  if (
    text.startsWith('/') ||
    text.includes('\\') ||
    text.includes('%') ||
    text.includes('?') ||
    text.includes('#') ||
    text.includes(':') ||
    text.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error('Asset paths must stay inside the package')
  }
  return text
}

export function unknownExtensionFields(
  object: Record<string, unknown>,
  known: readonly string[],
): string[] {
  return Object.keys(object)
    .filter((key) => !known.includes(key))
    .slice(0, EXTENSION_LIMITS.warnings)
    .map((key) => `Ignored unknown field: ${key.slice(0, 80)}`)
}

function capabilities(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 32)
    throw new Error('Invalid capability list')
  const list = value.map((entry: unknown) => extensionText(entry, 'capability', 80))
  if (new Set(list).size !== list.length) throw new Error('Duplicate capability')
  return list
}

export function assertExtensionCompatibility(
  contract: string,
  required: readonly string[],
  minimumHvir?: string,
): void {
  if (
    !/^\d+\.\d+$/u.test(contract) ||
    Number(contract.split('.')[0]) !== Number(EXTENSION_CONTRACT.split('.')[0])
  ) {
    throw new Error(
      `Requires extension contract ${contract}; hvir supports ${EXTENSION_CONTRACT}${minimumHvir ? `. Requires hvir ${minimumHvir}` : ''}`,
    )
  }
  const missing = required.filter(
    (entry) => !(EXTENSION_CAPABILITIES as readonly string[]).includes(entry),
  )
  if (missing.length)
    throw new Error(
      `Requires extension contract ${contract}; missing capabilities: ${missing.join(', ')}${minimumHvir ? `. Requires hvir ${minimumHvir}` : ''}`,
    )
}

export function validateExtensionManifest(value: unknown): ManifestValidation {
  const object = extensionObject(value)
  const warnings = unknownExtensionFields(object, [
    'id',
    'name',
    'version',
    'contract',
    'minimumHvir',
    'requiredCapabilities',
    'optionalCapabilities',
    'access',
    'views',
  ])
  const requiredCapabilities = capabilities(object['requiredCapabilities'])
  const optionalCapabilities = capabilities(object['optionalCapabilities'])
  const contract = extensionText(object['contract'], 'contract version', 20)
  const minimumHvir =
    object['minimumHvir'] === undefined
      ? undefined
      : extensionText(object['minimumHvir'], 'minimum hvir release', 40)
  assertExtensionCompatibility(contract, requiredCapabilities, minimumHvir)
  if (!Array.isArray(object['access']) || object['access'].length !== 0)
    throw new Error(
      'This hvir contract provides package-local views only; requested access is unavailable',
    )
  const version = extensionText(object['version'], 'package version', 40)
  if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/u.test(version))
    throw new Error('Invalid package version')
  if (
    !Array.isArray(object['views']) ||
    object['views'].length === 0 ||
    object['views'].length > 8
  )
    throw new Error('Declare between one and eight viewer contributions')
  const views: ExtensionContribution[] = object['views'].map((entry: unknown) => {
    const view = extensionObject(entry)
    warnings.push(
      ...unknownExtensionFields(view, [
        'id',
        'title',
        'entry',
        'placement',
        'representations',
      ]),
    )
    if (
      view['placement'] !== 'application' ||
      !Array.isArray(view['representations']) ||
      view['representations'].length !== 1 ||
      view['representations'][0] !== 'view'
    )
      throw new Error('This contract supports application-level view representations')
    return {
      id: extensionId(view['id']),
      title: extensionText(view['title'], 'view title', 80),
      entry: extensionAssetPath(view['entry']),
      placement: 'application',
      representations: ['view'],
    }
  })
  if (new Set(views.map((view) => view.id)).size !== views.length)
    throw new Error('Duplicate viewer contribution identity')
  return {
    manifest: {
      id: extensionId(object['id']),
      name: extensionText(object['name'], 'display name', 80),
      version,
      contract,
      ...(minimumHvir ? { minimumHvir } : {}),
      requiredCapabilities,
      optionalCapabilities,
      access: [],
      views,
    },
    warnings: warnings.slice(0, EXTENSION_LIMITS.warnings),
  }
}
