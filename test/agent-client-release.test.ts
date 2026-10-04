import { createRequire } from 'node:module'
import { mkdtemp, mkdir, writeFile, readFile, appendFile, rm, cp } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import {
  AGENT_CLIENT_TARGETS,
  agentClientManifest,
  inspectAgentClientManifest,
} from '../scripts/agent-client-artifacts.mjs'
import { inspectPackagedExtensionAssets } from '../scripts/inspect-packaged-extension-assets.mts'

const require = createRequire(import.meta.url),
  cleanups: string[] = [],
  source = 'a'.repeat(40)
afterEach(async () => {
  for (const directory of cleanups.splice(0))
    await rm(directory, { recursive: true, force: true })
  vi.unstubAllEnvs()
})
async function fixture() {
  const app = await mkdtemp(join(tmpdir(), 'hvir-client-sign-'))
  cleanups.push(app)
  const root = join(app, 'Contents/Resources/agent-clients')
  for (const target of AGENT_CLIENT_TARGETS) {
    const path = join(root, target),
      bytes = Buffer.from(target)
    await mkdir(join(path, 'notices'), { recursive: true })
    for (const notice of [
      'hvir-LICENSE',
      'musl-1.2.5-COPYRIGHT',
      'rust-1.99.0-COPYRIGHT-library.html',
    ])
      await writeFile(join(path, 'notices', notice), 'fixture notice')
    await writeFile(join(path, 'hvir-agent'), bytes)
    await writeFile(
      join(path, 'metadata.json'),
      JSON.stringify({
        contract: '1.0',
        source,
        target,
        development: false,
        toolchain: '1.99.0',
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      }),
    )
  }
  await agentClientManifest(root, source)
  const hook = require('../build/native/sign-agent-clients.cjs') as {
    signWith(
      options: { app: string; identity: string },
      exec: (command: string, args: string[]) => Promise<void>,
      sign: (options: { ignore(file: string): boolean }) => Promise<void>,
    ): Promise<void>
  }
  return { app, root, hook }
}
it('rejects missing, mixed-source or changed unsigned clients before any signing', async () => {
  const f = await fixture(),
    exec = vi.fn(() => Promise.resolve()),
    sign = vi.fn(() => Promise.resolve())
  await appendFile(join(f.root, 'macos-x64/hvir-agent'), 'changed before signing')
  await expect(
    f.hook.signWith({ app: f.app, identity: 'selected' }, exec, sign),
  ).rejects.toThrow('integrity')
  expect(exec).not.toHaveBeenCalled()
  expect(sign).not.toHaveBeenCalled()
  await rm(join(f.root, 'linux-arm64/hvir-agent'))
  await expect(agentClientManifest(f.root, source)).rejects.toThrow()
})
it('binds final signed bytes and excludes exactly two pre-signed client files from the ordinary app signer', async () => {
  const f = await fixture(),
    exec = vi.fn(async (_command: string, args: string[]) => {
      if (args.includes('--force')) await appendFile(args.at(-1)!, '-signed')
    }),
    sign = vi.fn((options: { ignore(file: string): boolean }) => {
      for (const target of AGENT_CLIENT_TARGETS)
        expect(options.ignore(join(f.root, target, 'hvir-agent'))).toBe(
          target.startsWith('macos'),
        )
      expect(options.ignore(join(f.root, 'manifest.json'))).toBe(false)
      expect(options.ignore(join(f.root, 'macos-arm64/metadata.json'))).toBe(false)
      return Promise.resolve()
    })
  await f.hook.signWith({ app: f.app, identity: 'selected' }, exec, sign)
  expect(exec).toHaveBeenCalledTimes(4)
  expect(sign).toHaveBeenCalledOnce()
  const manifest = JSON.parse(await readFile(join(f.root, 'manifest.json'), 'utf8')) as {
    clients: Record<string, { sha256: string; buildSha256: string }>
  }
  for (const target of AGENT_CLIENT_TARGETS) {
    const bytes = await readFile(join(f.root, target, 'hvir-agent'))
    expect(manifest.clients[target]?.sha256).toBe(
      createHash('sha256').update(bytes).digest('hex'),
    )
    const metadata = JSON.parse(
      await readFile(join(f.root, target, 'metadata.json'), 'utf8'),
    ) as { source: string; sha256: string }
    expect(metadata.source).toBe(source)
    expect(manifest.clients[target]?.buildSha256).toBe(metadata.sha256)
  }
})
it('the actual packager identity resolver cannot silently bypass forced signing when custom sign is configured', async () => {
  vi.stubEnv('CSC_IDENTITY_AUTO_DISCOVERY', 'false')
  require('app-builder-lib')
  const { MacTargetHelper } = require('app-builder-lib/out/mac/MacTargetHelper') as {
    MacTargetHelper: new (packager: unknown) => {
      findSigningIdentity(...args: unknown[]): Promise<unknown>
    }
  }
  const config = { sign: 'build/native/sign-agent-clients.cjs' },
    packager = {
      forceCodeSigning: true,
      config: {},
      platform: { name: 'mac' },
      platformSpecificBuildOptions: config,
      codeSigningInfo: { value: Promise.resolve({ keychainFile: null }) },
      helper: undefined as unknown,
    }
  packager.helper = new MacTargetHelper(packager)
  const { MacPackager } = require('app-builder-lib/out/macPackager') as {
    MacPackager: {
      prototype: {
        sign(app: string, out: string, config: unknown, arch: number): Promise<boolean>
      }
    }
  }
  expect(
    await MacPackager.prototype.sign.call(packager, '/unbuilt.app', '/output', config, 3),
  ).toBe(false)
  const prepare = require('../build/native/prepare-agent-clients.cjs') as (context: {
    packager: unknown
  }) => Promise<void>
  const { isSignAllowed } = require('app-builder-lib/out/codeSign/macCodeSign') as {
    isSignAllowed(this: void, printWarning: boolean): boolean
  }
  await expect(prepare({ packager })).rejects.toThrow(
    isSignAllowed(false)
      ? 'Required macOS signing identity is absent'
      : 'Required macOS signing is unavailable',
  )
})

it('requires redistribution notices for every packaged target', async () => {
  const f = await fixture()
  await rm(join(f.root, 'linux-x64/notices/musl-1.2.5-COPYRIGHT'))
  await expect(agentClientManifest(f.root, source)).rejects.toThrow()
})

it('inspects complete installed guides, starter, reference and four final client payloads without rewriting provenance', async () => {
  const f = await fixture(),
    resources = join(f.app, 'Contents/Resources')
  await cp('build/native/agent-guides', join(resources, 'agent-guides'), {
    recursive: true,
  })
  await cp('packages/extension-authoring', join(resources, 'extension-authoring'), {
    recursive: true,
  })
  await cp('packages/extension-reference', join(resources, 'extension-reference'), {
    recursive: true,
  })
  await cp('build/native/hvir-agent-command', join(resources, 'hvir-agent-command'))
  const before = await readFile(join(f.root, 'manifest.json'))
  await inspectPackagedExtensionAssets(resources, readFile)
  expect(await readFile(join(f.root, 'manifest.json'))).toEqual(before)
  await appendFile(join(f.root, 'linux-arm64/hvir-agent'), 'changed')
  await expect(inspectAgentClientManifest(f.root)).rejects.toThrow('integrity')
  expect(await readFile(join(f.root, 'manifest.json'))).toEqual(before)
  await rm(join(resources, 'agent-guides/access.md'))
  await expect(inspectPackagedExtensionAssets(resources, readFile)).rejects.toThrow(
    'ENOENT',
  )
})
