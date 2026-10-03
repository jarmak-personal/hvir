import {
  mkdtemp,
  realpath,
  readdir,
  readFile,
  writeFile,
  mkdir,
  symlink,
  rm,
} from 'node:fs/promises'
import { mkdirSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LocalHost } from '../src/main/project-host/local-host'
import { ExtensionAuthoring } from '../src/main/extensions/extension-authoring'
import type { HostId } from '../src/shared'
import { localPath, hostPath } from '../src/shared/host-path'
import { parseAgentCommand } from '../src/shared/agent/commands'
import { PRESENTATION_ASSETS } from '../scripts/prepare-extension-ui.mts'

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'hvir-authoring-'))
  const host = new LocalHost()
  return {
    directory: await realpath(directory),
    host,
    owner: new ExtensionAuthoring(
      host,
      localPath(resolve('packages/extension-authoring')),
    ),
    async dispose() {
      await host.dispose()
      await rm(directory, { recursive: true, force: true })
    },
  }
}
describe('explicit local extension authoring', () => {
  it('materializes the current styled package and shares ordinary validation without execution', async () => {
    const f = await fixture()
    try {
      const output = join(f.directory, 'clock')
      const scaffold = await f.owner.command(
        parseAgentCommand(['scaffold', '--output', output]),
      )
      expect(scaffold.exitStatus).toBe(0)
      expect(
        (JSON.parse(scaffold.stdout) as { authoring: unknown }).authoring,
      ).toMatchObject({
        destination: localPath(output),
        enabled: false,
      })
      const validation = await f.owner.command(
        parseAgentCommand(['validate', '--path', output]),
      )
      expect(
        (JSON.parse(validation.stdout) as { validation: unknown }).validation,
      ).toMatchObject({
        id: 'hvir.clock',
        contract: '1.0',
        kind: 'directory',
        warnings: [],
      })
      for (const asset of PRESENTATION_ASSETS)
        expect(await readFile(join(output, asset))).toEqual(
          await readFile(`src/shared/presentation/${asset}`),
        )
      await writeFile(
        join(output, 'never-executed.js'),
        'throw new Error("package code ran")',
      )
      expect(
        (await f.owner.command(parseAgentCommand(['validate', '--path', output])))
          .exitStatus,
      ).toBe(0)
      await symlink('/outside', join(output, 'escape'))
      expect(
        (await f.owner.command(parseAgentCommand(['validate', '--path', output])))
          .exitStatus,
      ).toBe(64)
      expect(await readdir(f.directory)).toEqual(['clock'])
    } finally {
      await f.dispose()
    }
  })
  it('exports exact inspected skill, refuses occupied paths without accumulating stages and requires explicit local destinations', async () => {
    const f = await fixture()
    try {
      const inspected = await f.owner.command(parseAgentCommand(['skill']))
      const output = join(f.directory, 'SKILL.md')
      expect(
        (await f.owner.command(parseAgentCommand(['skill', '--output', output])))
          .exitStatus,
      ).toBe(0)
      expect(await readFile(output, 'utf8')).toBe(
        (JSON.parse(inspected.stdout) as { skill: string }).skill,
      )
      for (let index = 0; index < 3; index++)
        expect(
          (await f.owner.command(parseAgentCommand(['skill', '--output', output])))
            .exitStatus,
        ).toBe(64)
      expect(await readdir(f.directory)).toEqual(['SKILL.md'])
      for (const args of [
        ['scaffold'],
        ['validate'],
        ['scaffold', '--output', 'relative'],
        ['skill', '--instance', '/endpoint'],
      ])
        expect((await f.owner.command(parseAgentCommand(args))).exitStatus).toBe(64)
      const existing = await readFile(output)
      await mkdir(join(f.directory, 'foreign'))
      await symlink(join(f.directory, 'foreign'), join(f.directory, 'alias'))
      expect(
        (
          await f.owner.command(
            parseAgentCommand([
              'skill',
              '--output',
              join(f.directory, 'alias', 'SKILL.md'),
            ]),
          )
        ).exitStatus,
      ).toBe(64)
      expect(await readdir(join(f.directory, 'foreign'))).toEqual([])
      expect(await readFile(output)).toEqual(existing)
    } finally {
      await f.dispose()
    }
  })
  it('supports customary temporary aliases while refusing nonlocal destinations at the immediate adapter', async () => {
    const f = await fixture()
    try {
      const path = join(f.directory, 'out')
      const alias =
        process.platform === 'darwin'
          ? path
              .replace(/^\/private\/var\//, '/var/')
              .replace(/^\/private\/tmp\//, '/tmp/')
          : path
      await f.host.extensionStorage.materializeAuthoring(
        localPath(alias),
        new Map([['one', Buffer.from('ok')]]),
        'directory',
      )
      expect(await readFile(join(path, 'one'), 'utf8')).toBe('ok')
      await expect(
        f.host.extensionStorage.materializeAuthoring(
          hostPath('ssh:test' as HostId, path),
          new Map([['one', Buffer.from('x')]]),
          'directory',
        ),
      ).rejects.toThrow('absolute local')
    } finally {
      await f.dispose()
    }
  })
  it.each(['destination', 'stage', 'parent', 'partial'] as const)(
    'preserves user objects and refuses %s races before claiming selected publication',
    async (race) => {
      const f = await fixture()
      try {
        const parent = join(f.directory, 'selected')
        await mkdir(parent)
        let iteration = 0
        class RacedAssets extends Map<string, Uint8Array> {
          override *[Symbol.iterator](): MapIterator<[string, Uint8Array]> {
            iteration++
            yield ['first', Buffer.from('owned')]
            if (iteration === 2) {
              if (race === 'destination') writeFileSync(join(parent, 'output'), 'foreign')
              if (race === 'stage') {
                const stage = readdirSync(parent).find((name) =>
                  name.startsWith('.hvir-authoring-'),
                )!
                renameSync(join(parent, stage), join(parent, 'retained'))
                mkdirSync(join(parent, stage))
                writeFileSync(join(parent, stage, 'foreign'), 'preserve')
              }
              if (race === 'parent') {
                renameSync(parent, join(f.directory, 'retained-parent'))
                mkdirSync(parent)
                writeFileSync(join(parent, 'foreign'), 'preserve')
              }
              if (race === 'partial')
                throw new Error('Injected immediate source interruption')
            }
            yield ['second', Buffer.from('owned2')]
          }
        }
        await expect(
          f.host.extensionStorage.materializeAuthoring(
            localPath(join(parent, 'output')),
            new RacedAssets([
              ['first', Buffer.from('owned')],
              ['second', Buffer.from('owned2')],
            ]),
            'directory',
          ),
        ).rejects.toThrow(/preserv|occupied|interruption/)
        if (race === 'destination')
          expect(await readFile(join(parent, 'output'), 'utf8')).toBe('foreign')
        if (race === 'stage') {
          const stage = (await readdir(parent)).find((name) =>
            name.startsWith('.hvir-authoring-'),
          )!
          expect(await readFile(join(parent, stage, 'foreign'), 'utf8')).toBe('preserve')
          expect(await readFile(join(parent, 'retained', 'first'), 'utf8')).toBe('owned')
        }
        if (race === 'parent') {
          expect(await readdir(parent)).toEqual(['foreign'])
          expect(await readFile(join(parent, 'foreign'), 'utf8')).toBe('preserve')
        }
        if (race === 'partial') {
          const stage = (await readdir(parent)).find((name) =>
            name.startsWith('.hvir-authoring-'),
          )!
          expect(await readFile(join(parent, stage, 'first'), 'utf8')).toBe('owned')
        }
      } finally {
        await f.dispose()
      }
    },
  )
})
