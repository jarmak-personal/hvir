export interface NativeInstallerRenderOptions {
  readonly version: string
  readonly repository: string
  readonly linuxX64Artifact: string
  readonly linuxArm64Artifact: string
  readonly macosArm64Artifact: string
  readonly macosTeamId: string
  readonly output: string
  readonly acceptanceAssetDirectory?: string
  readonly acceptanceUnsignedMacos?: boolean
}

export interface NativeInstallerArtifact {
  readonly name: string
  readonly sha256: string
}

export interface NativeInstallerRenderResult {
  readonly artifacts: {
    readonly linuxX64: NativeInstallerArtifact
    readonly linuxArm64: NativeInstallerArtifact
    readonly macosArm64: NativeInstallerArtifact
  }
  readonly outputPath: string
  readonly releaseBaseUrl: string
}

export function renderNativeInstaller(
  options: NativeInstallerRenderOptions,
): Promise<NativeInstallerRenderResult>
