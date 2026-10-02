import type { HostPath } from '../../shared/host-path'

export interface CapturedExtensionBytes {
  readonly sourceIdentity: string
  readonly files: ReadonlyMap<string, Uint8Array>
}

export interface ExtensionWriterLease {
  /** Detect path replacement before each authority-bearing admission or effect. */
  readonly assertCurrent: () => Promise<void>
  readonly release: () => Promise<void>
}

export interface ExtensionStoragePort {
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
  ): Promise<CapturedExtensionBytes>
}
