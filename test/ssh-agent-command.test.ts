import { expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { remoteCommand } from '../src/main/project-host/ssh-command'
import { asHostId, hostPath } from '../src/shared/host-path'

it('gates the entire trusted PATH launch on cwd and prepends to a profile PATH', () => {
  const directory = mkdtempSync(join(tmpdir(), 'hvir-ssh-command-')),
    bin = join(directory, 'bin'),
    project = join(directory, 'project')
  mkdirSync(bin)
  mkdirSync(project)
  writeFileSync(join(bin, 'hvir-agent'), '#!/bin/sh\nprintf "%s" "$PWD"', { mode: 0o755 })
  try {
    const command = remoteCommand('hvir-agent', [], {
      cwd: hostPath(asHostId('ssh'), project),
      env: { PATH: '/usr/bin:/bin' },
      pathPrefix: hostPath(asHostId('ssh'), bin),
    })
    expect(execFileSync('sh', ['-c', command], { encoding: 'utf8' })).toBe(project)
    const missing = remoteCommand('sh', ['-c', 'printf WRONG'], {
      cwd: hostPath(asHostId('ssh'), join(directory, 'missing')),
      pathPrefix: hostPath(asHostId('ssh'), bin),
    })
    expect(() => execFileSync('sh', ['-c', missing], { stdio: 'pipe' })).toThrow()
    expect(() =>
      remoteCommand('true', [], {
        cwd: hostPath(asHostId('ssh'), project),
        pathPrefix: hostPath(asHostId('other'), bin),
      }),
    ).toThrow('another host')
  } finally {
    rmSync(directory, { recursive: true })
  }
})
