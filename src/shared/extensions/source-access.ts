import type { HostPath } from '../host-path'
import { extensionId, extensionObject, extensionText } from './validation'

export const SOURCE_LIMITS = {
  declarations: 4,
  stateBytes: 128 * 1024,
  textBytes: 2 * 1024 * 1024,
  assetBytes: 2 * 1024 * 1024,
  receipts: 8,
  receiptBytes: 16 * 1024 * 1024,
  receiptMs: 300_000,
  pageBytes: 2048,
} as const

export interface ExtensionSourceDeclaration {
  readonly id: string
  readonly description: string
  readonly context: 'application' | 'workspace'
  readonly mode: 'read-only'
}
export interface ExtensionSourceGrant {
  readonly installationId: string
  readonly declaration: ExtensionSourceDeclaration
  readonly root?: HostPath
  readonly workspaceId?: string
}
export interface ExtensionSourceSelection {
  readonly installationId: string
  readonly source: string
  readonly root?: HostPath
  readonly workspaceId?: string
}
export interface ExtensionSourceStatus {
  readonly source: string
  readonly granted: boolean
  readonly root?: HostPath
  readonly workspaceId?: string
  readonly explanation?: string
}
export function validateSourceDeclarations(
  value: unknown,
  warn: (object: Record<string, unknown>, known: readonly string[]) => void = () =>
    undefined,
): ExtensionSourceDeclaration[] {
  if (!Array.isArray(value) || value.length > SOURCE_LIMITS.declarations)
    throw new Error('Invalid read-only source declarations')
  const declarations = value.map((entry: unknown) => {
    const item = extensionObject(entry)
    warn(item, ['id', 'description', 'context', 'mode'])
    if (
      !['application', 'workspace'].includes(item['context'] as string) ||
      item['mode'] !== 'read-only'
    )
      throw new Error('Sources require an application or workspace read-only scope')
    return {
      id: extensionId(item['id']),
      description: extensionText(item['description'], 'source description', 240),
      context: item['context'] as 'application' | 'workspace',
      mode: 'read-only' as const,
    }
  })
  if (new Set(declarations.map((entry) => entry.id)).size !== declarations.length)
    throw new Error('Duplicate source declaration')
  return declarations
}
