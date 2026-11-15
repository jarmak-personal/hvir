import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  buildInputFlags,
  digest,
  pin,
  pinPath,
  verifyArtifact,
  validQueryProof,
  validAppearanceProof,
  withAppearanceFontFixture,
  type NativeArtifact,
} from '../scripts/native-terminal/artifacts.mts'

import {
  APPEARANCE_FONT_FILES,
  APPEARANCE_FONT_LAUNCHER,
  APPEARANCE_FONT_CONFIG_SOURCE,
  APPEARANCE_FONT_FILE,
  APPEARANCE_FONT_LICENSE,
  APPEARANCE_FONT_PROVENANCE,
  APPEARANCE_FONT_SOURCE,
  APPEARANCE_FONT_LICENSE_SOURCE,
  APPEARANCE_FONT_CONFIG,
} from '../scripts/native-terminal/appearance-font-fixture.mts'

let root: string
let manifest: NativeArtifact
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'hvir-native-artifact-test-'))
  const files = []
  for (const name of [
    'libghostty.dylib',
    'loader-probe',
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
  ]) {
    await writeFile(
      join(root, name),
      name === 'appearance-proof.json'
        ? JSON.stringify({
            kind: 'native-appearance',
            passed: true,
            checks: 100,
            ligaturePixelsDiffer: true,
            cursorPolicyCases: 3,
            applicationCursorOverrides: 2,
            hardwareQualified: false,
          })
        : `artifact ${name}`,
    )
    files.push({
      path: name,
      sha256: await digest(join(root, name)),
      bytes: (await readFile(join(root, name))).length,
    })
  }
  manifest = {
    schema: 1,
    source: 'a'.repeat(40),
    pinSha256: await digest(pinPath),
    target: 'macos-arm64',
    applicationVersion: pin.source.applicationVersion,
    vtVersion: pin.source.vtVersion,
    embedAbi: pin.source.embedAbi,
    build: buildInputFlags({ zig: false, sourceArchive: false, packages: false }, false),
    files,
  }
  await save(manifest)
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})
async function save(value: unknown) {
  await writeFile(join(root, 'manifest.json'), JSON.stringify(value))
}

describe('native artifact admission before loader execution', () => {
  it('admits complete matching bytes without loading any code', async () => {
    expect((await verifyArtifact(root, 'macos-arm64')).source).toBe(manifest.source)
  })
  it.each([
    'target',
    'applicationVersion',
    'vtVersion',
    'embedAbi',
    'pinSha256',
  ] as const)('rejects mismatched %s', async (field) => {
    await save({ ...manifest, [field]: field === 'embedAbi' ? 999 : 'wrong' })
    await expect(verifyArtifact(root, 'macos-arm64')).rejects.toThrow('identity mismatch')
  })
  it.each([
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
  ])('rejects incomplete facade input %s before loading', async (name) => {
    await save({
      ...manifest,
      files: manifest.files.filter((file) => file.path !== name),
    })
    await expect(verifyArtifact(root, 'macos-arm64')).rejects.toThrow(
      'missing required file',
    )
  })
  it('requires Linux display and real GL proofs independently of the Mac artifact', async () => {
    const linuxFiles = []
    for (const path of [
      'ghostty-internal.so',
      'linux-display-probe',
      'linux-display-proof.json',
      'linux-facade-probe',
      'linux-facade-proof.json',
      ...APPEARANCE_FONT_FILES,
    ]) {
      await mkdir(join(root, 'appearance-fonts'), { recursive: true })
      await writeFile(join(root, path), `linux artifact ${path}`)
      linuxFiles.push({
        path,
        sha256: await digest(join(root, path)),
        bytes: (await readFile(join(root, path))).length,
      })
    }
    await writeFile(
      join(root, APPEARANCE_FONT_PROVENANCE),
      JSON.stringify({
        schema: 1,
        sourceCommit: pin.source.commit,
        sourceArchiveSha256: pin.source.sha256,
        fontSource: APPEARANCE_FONT_SOURCE,
        fontSha256: linuxFiles.find((file) => file.path === APPEARANCE_FONT_FILE)!.sha256,
        licenseSource: APPEARANCE_FONT_LICENSE_SOURCE,
        licenseSha256: linuxFiles.find((file) => file.path === APPEARANCE_FONT_LICENSE)!
          .sha256,
        launcherSource: APPEARANCE_FONT_LAUNCHER,
        launcherSha256: '1'.repeat(64),
        configSource: APPEARANCE_FONT_CONFIG_SOURCE,
        configSha256: '2'.repeat(64),
      }),
    )
    const provenance = linuxFiles.find(
      (file) => file.path === APPEARANCE_FONT_PROVENANCE,
    )!
    provenance.sha256 = await digest(join(root, APPEARANCE_FONT_PROVENANCE))
    provenance.bytes = (await readFile(join(root, APPEARANCE_FONT_PROVENANCE))).length
    const linux = {
      ...manifest,
      target: 'linux-x64',
      files: [...manifest.files, ...linuxFiles],
    }
    await save(linux)
    await expect(verifyArtifact(root, 'linux-x64')).resolves.toMatchObject({
      target: 'linux-x64',
    })
    for (const missing of linuxFiles.slice(1)) {
      await save({
        ...linux,
        files: linux.files.filter((file) => file.path !== missing.path),
      })
      await expect(verifyArtifact(root, 'linux-x64')).rejects.toThrow(
        'missing required file',
      )
    }
    const original = JSON.parse(
      await readFile(join(root, APPEARANCE_FONT_PROVENANCE), 'utf8'),
    ) as Record<string, unknown>
    for (const changed of [
      { ...original, sourceCommit: '0'.repeat(40) },
      { ...original, fontSource: '/ambient/font.ttf' },
      { ...original, fontSha256: '0'.repeat(64) },
      { ...original, licenseSha256: '0'.repeat(64) },
      { ...original, launcherSource: '/ambient/launcher.mts' },
      { ...original, configSource: '/ambient/config.mts' },
    ]) {
      await writeFile(join(root, APPEARANCE_FONT_PROVENANCE), JSON.stringify(changed))
      const record = {
        path: APPEARANCE_FONT_PROVENANCE,
        sha256: await digest(join(root, APPEARANCE_FONT_PROVENANCE)),
        bytes: (await readFile(join(root, APPEARANCE_FONT_PROVENANCE))).length,
      }
      await save({
        ...linux,
        files: linux.files.map((file) =>
          file.path === APPEARANCE_FONT_PROVENANCE ? record : file,
        ),
      })
      await expect(verifyArtifact(root, 'linux-x64')).rejects.toThrow(
        'invalid appearance font provenance',
      )
    }
  })
  it('rejects changed artifact bytes', async () => {
    await writeFile(join(root, 'libghostty.dylib'), 'corrupt library')
    await expect(verifyArtifact(root, 'macos-arm64')).rejects.toThrow('corrupt file')
  })
  it('rejects a missing loader before invoking it', async () => {
    await save({
      ...manifest,
      files: manifest.files.filter((f) => f.path !== 'loader-probe'),
    })
    await expect(verifyArtifact(root, 'macos-arm64')).rejects.toThrow(
      'native-artifact: missing loader',
    )
  })
  it.each(['../library', '/library', 'notices/../library', 'notices\\..\\library'])(
    'rejects escaped record %s',
    async (path) => {
      await save({
        ...manifest,
        files: [{ ...manifest.files[0], path }, ...manifest.files.slice(1)],
      })
      await expect(verifyArtifact(root, 'macos-arm64')).rejects.toThrow(
        'invalid file record',
      )
    },
  )
  it('rejects duplicate file authority', async () => {
    await save({ ...manifest, files: [...manifest.files, manifest.files[0]] })
    await expect(verifyArtifact(root, 'macos-arm64')).rejects.toThrow(
      'invalid file record',
    )
  })
  it('rejects symlinked library bytes even if their digest matches', async () => {
    await writeFile(
      join(root, 'other-library'),
      await readFile(join(root, 'libghostty.dylib')),
    )
    await rm(join(root, 'libghostty.dylib'))
    await symlink(join(root, 'other-library'), join(root, 'libghostty.dylib'))
    await expect(verifyArtifact(root, 'macos-arm64')).rejects.toThrow('escaped file')
  })

  it('stages a missing artifact directory', async () => {
    await rm(root, { recursive: true })
    await expect(verifyArtifact(root, 'macos-arm64')).rejects.toThrow(
      'native-artifact: missing directory',
    )
  })
  it('stages a missing manifest', async () => {
    await rm(join(root, 'manifest.json'))
    await expect(verifyArtifact(root, 'macos-arm64')).rejects.toThrow(
      'native-artifact: missing manifest',
    )
  })
  it('stages a recorded library missing on disk', async () => {
    await rm(join(root, 'libghostty.dylib'))
    await expect(verifyArtifact(root, 'macos-arm64')).rejects.toThrow(
      'native-artifact: missing file',
    )
  })
  it('names a recorded loader missing on disk', async () => {
    await rm(join(root, 'loader-probe'))
    await expect(verifyArtifact(root, 'macos-arm64')).rejects.toThrow(
      'native-artifact: missing loader',
    )
  })
  it('stages corrupt JSON', async () => {
    await writeFile(join(root, 'manifest.json'), '{')
    await expect(verifyArtifact(root, 'macos-arm64')).rejects.toThrow(
      'native-artifact: invalid manifest',
    )
  })
  it.each([null, [], {}, { schema: 1 }])(
    'stages malformed manifest shape %j',
    async (value) => {
      await save(value)
      await expect(verifyArtifact(root, 'macos-arm64')).rejects.toThrow(
        'native-artifact: invalid manifest',
      )
    },
  )
  it('rejects prepared compiler/cache inputs despite a false development claim', async () => {
    await save({
      ...manifest,
      build: {
        development: false,
        preparedInputs: { zig: true, sourceArchive: false, packages: false },
      },
    })
    await expect(verifyArtifact(root, 'macos-arm64')).rejects.toThrow(
      'native-artifact: identity mismatch',
    )
  })
  it('requires explicit development admission for uncommitted build inputs', async () => {
    await save({ ...manifest, build: { ...manifest.build, development: true } })
    await expect(verifyArtifact(root, 'macos-arm64')).rejects.toThrow('identity mismatch')
    await expect(verifyArtifact(root, 'macos-arm64', true)).resolves.toMatchObject({
      build: { ...manifest.build, development: true },
    })
  })
})

describe('native prepared-input provenance', () => {
  it.each([
    [{ zig: true, sourceArchive: false, packages: false }, false, true],
    [{ zig: false, sourceArchive: false, packages: true }, false, true],
    [{ zig: false, sourceArchive: true, packages: false }, false, false],
    [{ zig: false, sourceArchive: false, packages: false }, true, true],
  ] as const)(
    'records supplied inputs and development status',
    (inputs, dirty, development) => {
      expect(buildInputFlags(inputs, dirty)).toEqual({
        preparedInputs: inputs,
        development,
      })
    },
  )
})

describe('real query probe numerical receipt admission', () => {
  const proof = {
    kind: 'native-query',
    passed: true,
    checks: 1000,
    queryCases: 31,
    maxWork: 8192,
    maxVisited: 8192,
    maxChunkBytes: 65536,
    partialCounts: 2,
    streamedBatches: 3,
    initialCompletedBeforeProducerEnd: true,
    largeSemanticBytes: 1048577,
    largeChunks: 20,
    validatedBytes: 1048700,
    copyDigestFnv1a64: '0123456789abcdef',
    frameAcquisitions: 0,
    hardwareGpuQualified: false,
  }
  it('admits a complete bounded software proof and future additional cases', () => {
    expect(validQueryProof(proof)).toBe(true)
    expect(validQueryProof({ ...proof, queryCases: 32 })).toBe(true)
  })
  it.each([
    ['kind', 'native-selection'],
    ['passed', false],
    ['checks', 99],
    ['queryCases', 30],
    ['maxWork', 8193],
    ['maxVisited', 8193],
    ['maxChunkBytes', 65537],
    ['partialCounts', 0],
    ['streamedBatches', 0],
    ['initialCompletedBeforeProducerEnd', false],
    ['largeSemanticBytes', 1048576],
    ['largeChunks', 1],
    ['validatedBytes', 0],
    ['copyDigestFnv1a64', 'terminal payload'],
    ['frameAcquisitions', 1],
    ['hardwareGpuQualified', true],
    ['maxWork', NaN],
    ['largeChunks', 1.5],
    ['validatedBytes', Number.MAX_SAFE_INTEGER + 1],
  ] as const)('rejects missing or invalid %s evidence', (field, value) => {
    expect(validQueryProof({ ...proof, [field]: value })).toBe(false)
    const missing: Record<string, unknown> = { ...proof }
    delete missing[field]
    expect(validQueryProof(missing)).toBe(false)
  })
})

describe('native appearance proof admission', () => {
  const complete = {
    kind: 'native-appearance',
    passed: true,
    checks: 100,
    ligaturePixelsDiffer: true,
    cursorPolicyCases: 3,
    applicationCursorOverrides: 2,
    hardwareQualified: false,
  }
  it('requires measured shaping and explicit qualification scope', () => {
    expect(validAppearanceProof(complete)).toBe(true)
    for (const incomplete of [
      null,
      [],
      {},
      { ...complete, passed: false },
      { ...complete, checks: 29 },
      { ...complete, checks: 30.5 },
      { ...complete, ligaturePixelsDiffer: false },
      { ...complete, cursorPolicyCases: 2 },
      { ...complete, applicationCursorOverrides: 1 },
      { ...complete, hardwareQualified: true },
      { ...complete, hardwareQualified: undefined },
    ])
      expect(validAppearanceProof(incomplete)).toBe(false)
  })
})

describe('Linux appearance font fixture lifetime', () => {
  async function fontFixture() {
    await mkdir(join(root, 'appearance-fonts'))
    await writeFile(join(root, APPEARANCE_FONT_FILE), 'fixed font fixture bytes')
  }
  it('relocates one font, excludes ambient config and cleans after child settlement', async () => {
    await fontFixture()
    const relocated = join(root, 'relocated & fonts')
    await mkdir(relocated)
    await cp(join(root, 'appearance-fonts'), join(relocated, 'appearance-fonts'), {
      recursive: true,
    })
    const previous = { ...process.env }
    process.env.FONTCONFIG_FILE = '/ambient/fonts.conf'
    process.env.FONTCONFIG_PATH = '/ambient/config'
    process.env.FONTCONFIG_SYSROOT = '/ambient/root'
    let owned: string | undefined
    try {
      await withAppearanceFontFixture(relocated, 'linux', async (environment) => {
        owned = environment.FONTCONFIG_PATH!
        expect(await readFile(environment.FONTCONFIG_FILE!, 'utf8')).toBe(
          APPEARANCE_FONT_CONFIG,
        )
        expect(APPEARANCE_FONT_CONFIG).toContain('<reset-dirs />')
        expect(APPEARANCE_FONT_CONFIG).not.toMatch(/<include|~|\/usr|\/etc/u)
        expect(
          await readFile(join(owned, 'fonts', 'JetBrainsMonoNoNF-Regular.ttf'), 'utf8'),
        ).toBe('fixed font fixture bytes')
        expect(environment.FONTCONFIG_SYSROOT).toBeUndefined()
        expect(environment.XDG_CACHE_HOME).toBe(join(owned, 'cache'))
        expect(environment.HOME).toBe(previous.HOME)
        await access(owned)
      })
      await expect(access(owned!)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(process.env.FONTCONFIG_FILE).toBe('/ambient/fonts.conf')
    } finally {
      for (const key of ['FONTCONFIG_FILE', 'FONTCONFIG_PATH', 'FONTCONFIG_SYSROOT']) {
        if (previous[key] === undefined) delete process.env[key]
        else process.env[key] = previous[key]
      }
    }
  })
  it('cleans the owned cache when the child fails', async () => {
    await fontFixture()
    let owned: string | undefined
    await expect(
      withAppearanceFontFixture(root, 'linux', (environment) => {
        owned = environment.FONTCONFIG_PATH!
        return Promise.reject(new Error('child failed'))
      }),
    ).rejects.toThrow('child failed')
    await expect(access(owned!)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('refuses a symlink in place of the authenticated font file', async () => {
    await fontFixture()
    await rm(join(root, APPEARANCE_FONT_FILE))
    await symlink(join(root, 'loader-probe'), join(root, APPEARANCE_FONT_FILE))
    await expect(
      withAppearanceFontFixture(root, 'linux', () => Promise.resolve('unexpected')),
    ).rejects.toThrow('regular fixture required')
  })
  it('leaves macOS discovery and environment unchanged', async () => {
    await expect(
      withAppearanceFontFixture('/absent-artifact', 'darwin', (environment) => {
        expect(environment).toBe(process.env)
        return Promise.resolve('unchanged')
      }),
    ).resolves.toBe('unchanged')
  })
})
