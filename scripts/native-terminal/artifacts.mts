import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  APPEARANCE_FONT_FILES,
  APPEARANCE_FONT_LAUNCHER,
  APPEARANCE_FONT_CONFIG_SOURCE,
  APPEARANCE_FONT_CONFIG,
  APPEARANCE_FONT_FILE,
  APPEARANCE_FONT_LICENSE,
  APPEARANCE_FONT_PROVENANCE,
  APPEARANCE_FONT_SOURCE,
  APPEARANCE_FONT_LICENSE_SOURCE,
} from './appearance-font-fixture.mts'

import {
  GENERIC_FONT_CASES,
  customFontCases,
  parseFontCase,
  validateFontCases,
  validFontCaseProof,
  FONT_CASE_INPUTS,
  type FontCase,
  type FontCaseRecord,
} from './font-case-proof.mts'

export const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const pinPath = resolve(repository, 'scripts/native-terminal/pin.json')
export const pin = JSON.parse(await readFile(pinPath, 'utf8')) as {
  schema: number
  source: {
    commit: string
    tag: string
    url: string
    sha256: string
    applicationVersion: string
    vtVersion: string
    embedAbi: number
  }
  zig: { version: string; archives: Record<string, { url: string; sha256: string }> }
  dependencies: Record<string, string>
  patches: { file: string; sha256: string; purpose: string }[]
  targets: Record<
    string,
    { platform: string; arch: string; triple: string; library: string }
  >
}
export async function digest(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}
/** Artifact-qualified probe callback settles after child exit, then its fonts/cache retire. */
export async function withAppearanceFontFixture<T>(
  artifact: string,
  platform: string,
  run: (environment: NodeJS.ProcessEnv) => Promise<T>,
): Promise<T> {
  if (platform !== 'linux') return run(process.env)
  if (!(await lstat(join(artifact, APPEARANCE_FONT_FILE))).isFile())
    throw new Error('native-appearance-font: regular fixture required')
  const owned = await mkdtemp(join(tmpdir(), 'hvir-native-appearance-fonts-'))
  try {
    const fonts = join(owned, 'fonts')
    await mkdir(fonts)
    await mkdir(join(owned, 'cache'))
    await cp(
      join(artifact, APPEARANCE_FONT_FILE),
      join(fonts, basename(APPEARANCE_FONT_FILE)),
    )
    const configuration = join(owned, 'fonts.conf')
    await writeFile(configuration, APPEARANCE_FONT_CONFIG, { flag: 'wx' })
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      FONTCONFIG_FILE: configuration,
      FONTCONFIG_PATH: owned,
      XDG_CACHE_HOME: join(owned, 'cache'),
    }
    // A caller's sysroot must not redirect this owned relative font directory.
    delete environment.FONTCONFIG_SYSROOT
    return await run(environment)
  } finally {
    await rm(owned, { recursive: true, force: true })
  }
}

/** Seven fresh native processes; preload is requested, actual version comes from native INFO. */
export async function qualifyNativeFontCases(
  run: (
    font: FontCase,
    environment: NodeJS.ProcessEnv,
  ) => Promise<{ stdout: string; stderr: string }>,
) {
  const owned = await mkdtemp(join(tmpdir(), 'hvir-native-font-cases-'))
  const records: FontCaseRecord[] = []
  try {
    await mkdir(join(owned, 'cache'))
    const launch = async (font: FontCase) => {
      const environment: NodeJS.ProcessEnv = {
        ...process.env,
        GHOSTTY_LOG: 'stderr',
        LD_PRELOAD: 'libfontconfig.so.1',
        XDG_CACHE_HOME: join(owned, 'cache'),
      }
      delete environment.FONTCONFIG_FILE
      delete environment.FONTCONFIG_PATH
      delete environment.FONTCONFIG_SYSROOT
      if (font.id === 'alias') {
        const target = records[1]!.firstRegular
          .replaceAll('&', '&amp;')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;')
        const configuration = join(owned, 'alias.conf')
        await writeFile(
          configuration,
          '<fontconfig><include>/etc/fonts/fonts.conf</include>' +
            '<alias binding="strong"><family>hvir Native Font Alias</family><prefer><family>' +
            target +
            '</family></prefer></alias></fontconfig>',
          { flag: 'wx' },
        )
        environment.FONTCONFIG_FILE = configuration
      }
      const result = await run(font, environment)
      records.push(parseFontCase(result.stdout, result.stderr, font))
    }
    for (const font of GENERIC_FONT_CASES) await launch(font)
    for (const font of customFontCases(
      records[0]!.firstRegular,
      records[1]!.firstRegular,
    ))
      await launch(font)
    validateFontCases(records)
    const inputs = await Promise.all(
      FONT_CASE_INPUTS.map(async (path) => ({
        path,
        sha256: await digest(join(repository, path)),
      })),
    )
    const proof = { kind: 'native-font-cases', passed: true, records, inputs }
    if (!validFontCaseProof(proof)) throw new Error('native-font-case: incomplete proof')
    return proof
  } finally {
    await rm(owned, { recursive: true, force: true })
  }
}

export interface NativeArtifact {
  readonly schema: 1
  readonly source: string
  readonly pinSha256: string
  readonly target: string
  readonly applicationVersion: string
  readonly vtVersion: string
  readonly embedAbi: number
  readonly build: Record<string, unknown>
  readonly files: readonly { path: string; sha256: string; bytes: number }[]
}
export interface PreparedNativeInputs {
  readonly zig: boolean
  readonly sourceArchive: boolean
  readonly packages: boolean
}
export function buildInputFlags(preparedInputs: PreparedNativeInputs, dirty: boolean) {
  return {
    preparedInputs,
    development: dirty || preparedInputs.zig || preparedInputs.packages,
  }
}

/** Closed result emitted by the maintained real-Surface appearance executable. */
export function validAppearanceProof(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const proof = value as Record<string, unknown>
  return (
    proof.kind === 'native-appearance' &&
    proof.passed === true &&
    typeof proof.checks === 'number' &&
    Number.isSafeInteger(proof.checks) &&
    proof.checks >= 30 &&
    proof.ligaturePixelsDiffer === true &&
    proof.cursorPolicyCases === 3 &&
    proof.applicationCursorOverrides === 2 &&
    proof.hardwareQualified === false
  )
}

/** Optional real Mac writer-retirement proof; never a headless-build prerequisite. */
export function validFrameRetirementProof(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const proof = value as { schema?: unknown; summary?: unknown; cases?: unknown }
  if (
    proof.schema !== 1 ||
    !proof.summary ||
    typeof proof.summary !== 'object' ||
    !Array.isArray(proof.cases) ||
    proof.cases.length !== 6
  )
    return false
  const summary = proof.summary as Record<string, unknown>
  if (
    summary.kind !== 'native-frame-retirement' ||
    summary.passed !== true ||
    summary.cases !== 6 ||
    summary.realIOSurfaceTransport !== true ||
    summary.callbackTailBarrierExercised !== true ||
    summary.productionRecoveryQualified !== false ||
    summary.linuxHardwareQualified !== false
  )
    return false
  const names = [
    'stable',
    'resize-before-fence',
    'resize-after-fence',
    'hidden-before-fence',
    'hidden-after-fence',
    'joined-actor-ended',
  ]
  return proof.cases.every((candidate: unknown, index: number) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate))
      return false
    const row = candidate as Record<string, unknown>
    return (
      row.kind === 'native-frame-retirement-case' &&
      row.case === names[index] &&
      row.passed === true &&
      row.authenticatedReceiptA === true &&
      row.retainedAPackedByteComparison === true &&
      row.childExit === 0 &&
      row.childReaped === true &&
      row.resourceCleanup === true &&
      (index === 5
        ? row.retirementStatus === 4 &&
          row.freshFrames === 0 &&
          row.joinedActorEnded === true &&
          row.sameParserContinued === false
        : row.retirementStatus === 2 &&
          row.freshFrames === 6 &&
          row.sameParserContinued === true &&
          row.observedThreeTargetReuseCycle === true &&
          typeof row.retainedAUnchangedChecks === 'number' &&
          row.retainedAUnchangedChecks >= 8) &&
      (index !== 0 ||
        (row.callbackTailHeld === true && row.pendingReleaseRefused === true))
    )
  })
}

/** Closed numerical proof from the maintained real-Surface query executable. */
export function validQueryProof(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const proof = value as Record<string, unknown>
  const count = (n: unknown): n is number =>
    typeof n === 'number' && Number.isSafeInteger(n) && n >= 0
  return (
    proof.kind === 'native-query' &&
    proof.passed === true &&
    count(proof.checks) &&
    proof.checks >= 100 &&
    count(proof.queryCases) &&
    proof.queryCases >= 31 &&
    count(proof.maxWork) &&
    proof.maxWork > 0 &&
    proof.maxWork <= 8192 &&
    count(proof.maxVisited) &&
    proof.maxVisited <= 8192 &&
    count(proof.maxChunkBytes) &&
    proof.maxChunkBytes > 0 &&
    proof.maxChunkBytes <= 65536 &&
    count(proof.partialCounts) &&
    proof.partialCounts > 0 &&
    count(proof.streamedBatches) &&
    proof.streamedBatches > 0 &&
    proof.initialCompletedBeforeProducerEnd === true &&
    count(proof.largeSemanticBytes) &&
    proof.largeSemanticBytes > 1024 * 1024 &&
    count(proof.largeChunks) &&
    proof.largeChunks >= 2 &&
    count(proof.validatedBytes) &&
    proof.validatedBytes >= proof.largeSemanticBytes &&
    typeof proof.copyDigestFnv1a64 === 'string' &&
    /^[a-f0-9]{16}$/.test(proof.copyDigestFnv1a64) &&
    proof.frameAcquisitions === 0 &&
    proof.hardwareGpuQualified === false
  )
}

async function artifactRead<T>(
  read: () => Promise<T>,
  stage: 'directory' | 'manifest' | 'file' | 'loader',
): Promise<T> {
  try {
    return await read()
  } catch (error) {
    const missing = ['ENOENT', 'ENOTDIR'].includes(
      (error as NodeJS.ErrnoException).code ?? '',
    )
    throw new Error(`native-artifact: ${missing ? 'missing' : 'unreadable'} ${stage}`, {
      cause: error,
    })
  }
}
/** Check identity/integrity for a trusted local build or exact CI artifact producer.
 * A self-reported manifest is not proof of authorship. Application imports are forbidden. */
export async function verifyArtifact(
  directory: string,
  target: string,
  allowDevelopment = false,
): Promise<NativeArtifact> {
  const selected = pin.targets[target]
  if (!selected) throw new Error('native-artifact: unsupported target')
  const root = await artifactRead(() => realpath(directory), 'directory')
  if (!(await artifactRead(() => lstat(root), 'directory')).isDirectory())
    throw new Error('native-artifact: invalid directory')
  const manifestPath = resolve(root, 'manifest.json')
  const info = await artifactRead(() => lstat(manifestPath), 'manifest')
  if (!info.isFile() || info.size > 1024 * 1024)
    throw new Error('native-artifact: invalid manifest')
  const text = await artifactRead(() => readFile(manifestPath, 'utf8'), 'manifest')
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('native-artifact: invalid manifest')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('native-artifact: invalid manifest')
  const m = parsed as NativeArtifact
  const prepared = m.build?.preparedInputs as PreparedNativeInputs | undefined
  if (
    typeof m.schema !== 'number' ||
    typeof m.source !== 'string' ||
    typeof m.pinSha256 !== 'string' ||
    typeof m.target !== 'string' ||
    typeof m.applicationVersion !== 'string' ||
    typeof m.vtVersion !== 'string' ||
    !Number.isSafeInteger(m.embedAbi) ||
    !m.build ||
    typeof m.build.development !== 'boolean' ||
    !prepared ||
    ['zig', 'sourceArchive', 'packages'].some(
      (key) => typeof prepared[key as keyof PreparedNativeInputs] !== 'boolean',
    ) ||
    !Array.isArray(m.files) ||
    m.files.length < 3 ||
    m.files.length > 256
  )
    throw new Error('native-artifact: invalid manifest')
  if (
    m.schema !== 1 ||
    !/^[a-f0-9]{40}$/.test(m.source) ||
    m.pinSha256 !== (await digest(pinPath)) ||
    m.target !== target ||
    m.applicationVersion !== pin.source.applicationVersion ||
    m.vtVersion !== pin.source.vtVersion ||
    m.embedAbi !== pin.source.embedAbi ||
    (!allowDevelopment && (m.build.development || prepared.zig || prepared.packages))
  )
    throw new Error('native-artifact: identity mismatch')
  const names = new Set<string>()
  for (const file of m.files as NativeArtifact['files']) {
    if (
      !file ||
      typeof file.path !== 'string' ||
      !file.path ||
      isAbsolute(file.path) ||
      file.path.split(/[\\/]/).some((p) => !p || p === '.' || p === '..') ||
      names.has(file.path) ||
      !/^[a-f0-9]{64}$/.test(file.sha256) ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 1 ||
      file.bytes > 512 * 1024 * 1024
    )
      throw new Error('native-artifact: invalid file record')
    names.add(file.path)
    const path = resolve(root, file.path),
      stage = file.path === 'loader-probe' ? 'loader' : 'file'
    const actual = await artifactRead(() => realpath(path), stage)
    const stat = await artifactRead(() => lstat(path), stage)
    if (
      relative(root, actual).startsWith(`..${sep}`) ||
      actual !== path ||
      !stat.isFile()
    )
      throw new Error('native-artifact: escaped file')
    if (
      stat.size !== file.bytes ||
      (await artifactRead(() => digest(path), stage)) !== file.sha256
    )
      throw new Error('native-artifact: corrupt file')
  }
  if (!names.has('loader-probe')) throw new Error('native-artifact: missing loader')
  if (
    ![
      selected.library,
      'hvir_ghostty_embed.h',
      'ghostty.h',
      'terminal.h',
      'facade-probe',
      'facade-proof.json',
      'input-probe',
      'input-proof.json',
      'effects-probe',
      'effects-proof.json',
      'selection-probe',
      'selection-proof.json',
      'query-probe',
      'query-proof.json',
      'appearance-probe',
      'appearance-proof.json',
      'frame-metadata-probe',
      'frame-metadata-proof.json',
      ...(selected.platform === 'linux'
        ? [
            'linux-display-probe',
            'linux-display-proof.json',
            'linux-facade-probe',
            'linux-facade-proof.json',
            ...APPEARANCE_FONT_FILES,
            'font-cases-proof.json',
          ]
        : []),
    ].every((n) => names.has(n))
  )
    throw new Error('native-artifact: missing required file')
  if (
    m.build.retirementProbe !== undefined &&
    typeof m.build.retirementProbe !== 'boolean'
  )
    throw new Error('native-artifact: invalid retirement proof selector')
  if (m.build.retirementProbe === true) {
    if (
      selected.platform !== 'darwin' ||
      !names.has('frame-retirement-probe') ||
      !names.has('frame-retirement-proof.json') ||
      !validFrameRetirementProof(
        JSON.parse(await readFile(join(root, 'frame-retirement-proof.json'), 'utf8')),
      )
    )
      throw new Error('native-artifact: invalid retirement proof')
  }
  if (selected.platform === 'linux') {
    let parsedFont: unknown
    try {
      parsedFont = JSON.parse(
        await readFile(join(root, APPEARANCE_FONT_PROVENANCE), 'utf8'),
      )
    } catch {
      throw new Error('native-artifact: invalid appearance font provenance')
    }
    if (!parsedFont || typeof parsedFont !== 'object' || Array.isArray(parsedFont))
      throw new Error('native-artifact: invalid appearance font provenance')
    const font = parsedFont as Record<string, unknown>
    const files = m.files as NativeArtifact['files']
    if (
      !font ||
      font.schema !== 1 ||
      font.sourceCommit !== pin.source.commit ||
      font.sourceArchiveSha256 !== pin.source.sha256 ||
      font.fontSource !== APPEARANCE_FONT_SOURCE ||
      font.licenseSource !== APPEARANCE_FONT_LICENSE_SOURCE ||
      font.launcherSource !== APPEARANCE_FONT_LAUNCHER ||
      font.configSource !== APPEARANCE_FONT_CONFIG_SOURCE ||
      typeof font.configSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(font.configSha256) ||
      typeof font.launcherSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(font.launcherSha256) ||
      font.fontSha256 !==
        files.find((file) => file.path === APPEARANCE_FONT_FILE)?.sha256 ||
      font.licenseSha256 !==
        files.find((file) => file.path === APPEARANCE_FONT_LICENSE)?.sha256
    )
      throw new Error('native-artifact: invalid appearance font provenance')
  }
  if (selected.platform === 'linux') {
    let cases: unknown
    try {
      cases = JSON.parse(await readFile(join(root, 'font-cases-proof.json'), 'utf8'))
    } catch {
      throw new Error('native-artifact: invalid font cases proof')
    }
    if (!validFontCaseProof(cases))
      throw new Error('native-artifact: invalid font cases proof')
  }
  let appearance: unknown
  try {
    appearance = JSON.parse(await readFile(join(root, 'appearance-proof.json'), 'utf8'))
  } catch {
    throw new Error('native-artifact: invalid appearance proof')
  }
  if (!validAppearanceProof(appearance))
    throw new Error('native-artifact: invalid appearance proof')
  return m
}
