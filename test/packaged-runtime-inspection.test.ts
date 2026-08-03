import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  inspectPackagedRuntimeGraph,
  readAsarArchive,
} from '../scripts/inspect-packaged-runtime.mts'

const productionEntries = [
  '/out/main/index.js',
  '/out/main/echo-worker.js',
  '/out/main/git-worker.js',
  '/out/main/chunks/git-branches.js',
  '/out/renderer/index.js',
  '/node_modules/node-pty/build/Release/pty.node',
  '/node_modules/node-pty/build/Release/spawn-helper',
]
const buildConfig = readFileSync(
  new URL('../electron.vite.config.ts', import.meta.url),
  'utf8',
)
const mainEntry = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as {
  scripts: Record<string, string>
  devDependencies: Record<string, string>
}
const inspectorSource = readFileSync(
  new URL('../scripts/inspect-packaged-runtime.mts', import.meta.url),
  'utf8',
)

function uint32Pickle(value: number): Buffer {
  const pickle = Buffer.alloc(8)
  pickle.writeUInt32LE(4, 0)
  pickle.writeUInt32LE(value, 4)
  return pickle
}

function stringPickle(value: string): Buffer {
  const encoded = Buffer.from(value)
  const alignedLength = Math.ceil(encoded.length / 4) * 4
  const pickle = Buffer.alloc(8 + alignedLength)
  pickle.writeUInt32LE(4 + alignedLength, 0)
  pickle.writeUInt32LE(encoded.length, 4)
  encoded.copy(pickle, 8)
  return pickle
}

describe('packaged runtime inspection', () => {
  it('keeps smoke activation behind the smoke-only build while packages use production', () => {
    expect(buildConfig).toContain("const smokeBuild = mode === 'smoke'")
    expect(buildConfig).toContain('excludeSmokeRuntimeFromProduction(smokeBuild)')
    expect(mainEntry).toContain("if (__HVIR_SMOKE_BUILD__ && process.env['HVIR_SMOKE'])")
    expect(packageJson.scripts.build).toContain('electron-vite build')
    expect(packageJson.scripts['build:smoke']).toContain('--mode smoke')
    for (const script of [
      'build:dir',
      'pack:mac:arm64',
      'pack:mac:arm64:signed',
      'pack:linux:x64',
      'pack:linux:arm64',
    ]) {
      expect(packageJson.scripts[script]).toContain('npm run build')
      expect(packageJson.scripts[script]).not.toContain('build:smoke')
    }
  })

  it('reads packed and unpacked ASAR entries without an installed package dependency', () => {
    const root = mkdtempSync(join(tmpdir(), 'hvir-asar-inspection-'))
    try {
      const archivePath = join(root, 'app.asar')
      const packedContent = Buffer.from('production')
      const unpackedContent = Buffer.from('native')
      const header = stringPickle(
        JSON.stringify({
          files: {
            'packed.js': { size: packedContent.length, offset: '0' },
            'native.node': { size: unpackedContent.length, unpacked: true },
          },
        }),
      )
      writeFileSync(
        archivePath,
        Buffer.concat([uint32Pickle(header.length), header, packedContent]),
      )
      mkdirSync(`${archivePath}.unpacked`)
      writeFileSync(`${archivePath}.unpacked/native.node`, unpackedContent)

      const archive = readAsarArchive(archivePath)
      expect(archive.entries).toEqual(['/packed.js', '/native.node'])
      expect(archive.readEntry('/packed.js')).toEqual(packedContent)
      expect(archive.readEntry('/native.node')).toEqual(unpackedContent)
      expect(inspectorSource).not.toContain("from '@electron/asar'")
      expect(packageJson.devDependencies['@electron/asar']).toBeUndefined()
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  })

  it('accepts the production bootstrap, workers, renderer, and native payload', () => {
    expect(
      inspectPackagedRuntimeGraph(productionEntries, () => 'production', 'darwin'),
    ).toEqual({
      mainEntries: [
        '/out/main/index.js',
        '/out/main/echo-worker.js',
        '/out/main/git-worker.js',
      ],
      nativeEntries: [
        '/node_modules/node-pty/build/Release/pty.node',
        '/node_modules/node-pty/build/Release/spawn-helper',
      ],
    })
  })

  it('requires the spawn helper only on the target that executes it', () => {
    const linuxEntries = productionEntries.filter(
      (entry) => !entry.endsWith('/spawn-helper'),
    )
    expect(
      inspectPackagedRuntimeGraph(linuxEntries, () => 'production', 'linux'),
    ).toMatchObject({
      nativeEntries: ['/node_modules/node-pty/build/Release/pty.node'],
    })
    expect(() =>
      inspectPackagedRuntimeGraph(linuxEntries, () => 'production', 'darwin'),
    ).toThrow('/node_modules/node-pty/build/Release/spawn-helper')
  })

  it.each([
    '/out/main/echo-worker.js',
    '/out/main/git-worker.js',
    '/node_modules/node-pty/build/Release/pty.node',
    '/node_modules/node-pty/build/Release/spawn-helper',
  ])('rejects a package missing %s', (missing) => {
    expect(() =>
      inspectPackagedRuntimeGraph(
        productionEntries.filter((entry) => entry !== missing),
        () => 'production',
        'darwin',
      ),
    ).toThrow(missing)
  })

  it('rejects an emitted scenarios chunk', () => {
    expect(() =>
      inspectPackagedRuntimeGraph(
        [...productionEntries, '/out/main/chunks/scenarios-abc.js'],
        () => 'production',
        'darwin',
      ),
    ).toThrow('retained smoke entry')
  })

  it.each(['HVIR_SMOKE', 'runElectronSmokeScenario', '.hvir-smoke'])(
    'rejects the smoke marker %s in any packaged JavaScript',
    (marker) => {
      expect(() =>
        inspectPackagedRuntimeGraph(
          productionEntries,
          (entry) =>
            entry === '/out/renderer/index.js' ? marker : 'production',
          'darwin',
        ),
      ).toThrow(`retained smoke marker ${marker}`)
    },
  )
})
