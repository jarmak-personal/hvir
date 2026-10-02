import type { HostPath } from '../../shared/host-path'

export interface CapturedExtensionBytes {
  readonly sourceIdentity: string
  readonly files: ReadonlyMap<string, Uint8Array>
  readonly directories?: readonly string[]
}

export interface ExtensionWriterLease {
  /** Detect path replacement before each authority-bearing admission or effect. */
  readonly assertCurrent: () => Promise<void>
  readonly release: () => Promise<void>
}

export interface ExtensionSource {
  readonly kind: 'directory' | 'zip' | 'development'
  readonly identity: string
  readonly resolved: HostPath
}

export interface ExtensionStoragePort {
  removeDevelopmentLink(
    path: HostPath,
    identity: string,
    signal?: AbortSignal,
  ): Promise<void>
  entryIdentity(path: HostPath): Promise<string>
  inspectSource(path: HostPath): Promise<ExtensionSource>
  readArchive(
    path: HostPath,
    maxBytes: number,
  ): Promise<{ readonly bytes: Uint8Array; readonly identity: string }>
  collectDirectory(
    path: HostPath,
    expected: CapturedExtensionBytes,
    maxEntries: number,
    signal?: AbortSignal,
  ): Promise<void>
  installationNames(path: HostPath, limit: number): Promise<readonly string[]>
  acquireWriter(
    path: HostPath,
    onLost: () => void,
  ): Promise<ExtensionWriterLease | undefined>
  captureDirectory(
    path: HostPath,
    bounds: {
      readonly files: number
      readonly depth: number
      readonly fileBytes: number
      readonly packageBytes: number
    },
    signal?: AbortSignal,
  ): Promise<CapturedExtensionBytes>
}
