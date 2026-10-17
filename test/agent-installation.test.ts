import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
const exec = promisify(execFile)
describe('native agent command ownership', () => {
  it('refuses a foreign agent command before package mutation and admits its own replacement', async () => {
    const volume = await mkdtemp(join(tmpdir(), 'hvir-agent-package-'))
    const directory = join(volume, 'usr/local/bin'),
      command = join(directory, 'hvir-agent')
    try {
      await mkdir(directory, { recursive: true })
      await writeFile(command, '#!/bin/sh\n# foreign user command\nexit 75\n')
      const script = new URL('../build/pkg-scripts/preinstall', import.meta.url).pathname
      await expect(exec('/bin/sh', [script, '', '', volume])).rejects.toMatchObject({
        code: 1,
      })
      expect(await readFile(command, 'utf8')).toContain('foreign user command')
      await writeFile(command, '#!/bin/sh\n# hvir-native-agent-command-v1\n')
      await expect(exec('/bin/sh', [script, '', '', volume])).resolves.toMatchObject({
        stderr: '',
      })
    } finally {
      await rm(volume, { recursive: true })
    }
  })
  it('ships one Node-mode launcher and records exact command ownership/removal in native packages', async () => {
    const read = (path: string) => readFile(new URL(path, import.meta.url), 'utf8')
    const [launcher, builder, postinstall, linuxInstall, linuxRemove, installer] =
      await Promise.all([
        read('../build/native/hvir-agent-command'),
        read('../electron-builder.yml'),
        read('../build/pkg-scripts/postinstall'),
        read('../build/linux/after-install.sh'),
        read('../build/linux/after-remove.sh'),
        read('../scripts/native-installer.template.sh'),
      ])
    expect(launcher).toContain('ELECTRON_RUN_AS_NODE=1 exec "$application" "$entry" "$@"')
    expect(launcher).not.toContain('open -')
    expect(builder).toContain('runAsNode: true')
    expect(builder).toContain('from: build/native/agent-guides')
    expect(postinstall).toContain('agent.previous')
    expect(postinstall).toContain('agent-command=/usr/local/bin/hvir-agent')
    expect(installer).toContain(
      "'hvir-native-agent-command-v1' /usr/local/bin/hvir-agent",
    )
    expect(linuxInstall).toContain('Refusing to replace an unowned hvir-agent command')
    expect(linuxRemove).toContain(
      '"$(readlink /usr/bin/hvir-agent)" = "$HVIR_AGENT_COMMAND"',
    )
  })
})
