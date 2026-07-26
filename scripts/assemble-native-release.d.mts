export interface NativeReleaseAssemblyOptions {
  readonly version: string
  readonly sourceSha: string
  readonly repository: string
  readonly macosTeamId: string
  readonly assetDirectory: string
}

export interface NativeReleaseArtifact {
  readonly platform: 'linux' | 'macos'
  readonly architecture: 'x64' | 'arm64'
  readonly name: string
  readonly sha256: string
}

export interface NativeReleaseManifest {
  readonly schemaVersion: 1
  readonly version: string
  readonly tag: string
  readonly sourceCommit: string
  readonly installer: {
    readonly name: string
    readonly sha256: string
  }
  readonly notices: {
    readonly name: string
    readonly sha256: string
  }
  readonly artifacts: readonly NativeReleaseArtifact[]
}

export interface NativeReleaseAssemblyResult {
  readonly assetDirectory: string
  readonly checksumsPath: string
  readonly installerPath: string
  readonly manifest: NativeReleaseManifest
  readonly manifestPath: string
}

export function assembleNativeRelease(
  options: NativeReleaseAssemblyOptions,
): Promise<NativeReleaseAssemblyResult>
