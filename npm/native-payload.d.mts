export interface NativePayloadMetadata {
  readonly platform: string
  readonly arch: string
  readonly executable: string
  readonly archiveSha256: string
}

export interface NativePayloadCacheOptions {
  readonly platform?: string
  readonly environment?: NodeJS.ProcessEnv
  readonly home?: string
}

export interface PrepareNativePayloadOptions {
  readonly packageDirectory: string
  readonly packageName: string
  readonly packageVersion: string
  readonly metadata: NativePayloadMetadata
  readonly cacheRoot?: string
  readonly report?: (message: string) => void
}

export function nativePayloadCacheRoot(options?: NativePayloadCacheOptions): string
export function sha256File(path: string): Promise<string>
export function prepareNativePayload(
  options: PrepareNativePayloadOptions,
): Promise<string>
