import {
  EXTENSION_CAPABILITIES,
  EXTENSION_CONTRACT,
  EXTENSION_LIMITS,
  type ExtensionManifest,
  type ExtensionContribution,
} from './contract'
import { validateContributionDeclarations } from './contributions'

export interface ManifestValidation {
  readonly manifest: ExtensionManifest
  readonly warnings: readonly string[]
}

import {
  extensionObject,
  extensionText,
  extensionId,
  extensionAssetPath,
} from './validation'
export {
  extensionObject,
  extensionText,
  extensionId,
  extensionAssetPath,
} from './validation'

/** One portable materialized topology for captured directories and ZIP entries. */
export function validateExtensionAssetTopology(
  entries: Iterable<readonly [string, boolean]>,
): void {
  const paths = new Map<string, { name: string; directory: boolean }>()
  const admit = (name: string, directory: boolean): void => {
    const key = name.normalize('NFC').toLowerCase()
    const prior = paths.get(key)
    if (prior && (prior.name !== name || prior.directory !== directory))
      throw new Error('Package asset paths conflict across supported platforms')
    paths.set(key, { name, directory })
    if (paths.size > EXTENSION_LIMITS.files)
      throw new Error('Package has too many materialized entries, including directories')
  }
  for (const [name, directory] of entries) {
    extensionAssetPath(name)
    const parts = name.split('/')
    if (parts.length - (directory ? 0 : 1) > EXTENSION_LIMITS.depth)
      throw new Error('Package directories are too deep')
    for (let index = 1; index < parts.length; index++)
      admit(parts.slice(0, index).join('/'), true)
    admit(name, directory)
  }
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
    'railItems',
    'actions',
    'updater',
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
        'navigation',
      ]),
    )
    if (
      !['application', 'workspace'].includes(view['placement'] as string) ||
      !Array.isArray(view['representations']) ||
      view['representations'].length !== 1 ||
      view['representations'][0] !== 'view'
    )
      throw new Error(
        'This contract supports application or workspace view representations',
      )
    return {
      id: extensionId(view['id']),
      title: extensionText(view['title'], 'view title', 80),
      entry: extensionAssetPath(view['entry']),
      placement: view['placement'] as 'application' | 'workspace',
      ...(view['navigation'] === undefined ? {} : { navigation: readNavigation(view) }),
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
      ...validateContributionDeclarations(object, views, (value, known) =>
        warnings.push(...unknownExtensionFields(value, known)),
      ),
    },
    warnings: warnings.slice(0, EXTENSION_LIMITS.warnings),
  }
}

function readNavigation(view: Record<string, unknown>): 'top' | 'left' {
  if (
    (view['navigation'] === 'top' && view['placement'] === 'application') ||
    (view['navigation'] === 'left' && view['placement'] === 'workspace')
  )
    return view['navigation']
  throw new Error(
    'Top destinations are application-level; left views are workspace-scoped',
  )
}
