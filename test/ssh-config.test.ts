import { describe, expect, it } from 'vitest'

import { parseSshConfig } from '../src/main/project-host'

describe('SSH config parsing', () => {
  it('resolves aliases, wildcard defaults, ports, and identity expansion', () => {
    const hosts = parseSshConfig(
      `Host work
  HostName dev.example.test
  Port 2202
  IdentityFile ~/.ssh/%r@%h

Host *
  User picard
  IdentityFile ~/.ssh/common
`,
      '/home/picard',
    )
    expect(hosts).toEqual([
      {
        alias: 'work',
        hostname: 'dev.example.test',
        user: 'picard',
        port: 2202,
        identityFiles: [
          '/home/picard/.ssh/picard@dev.example.test',
          '/home/picard/.ssh/common',
        ],
      },
    ])
  })

  it('does not expose wildcard patterns as selectable aliases', () => {
    expect(parseSshConfig('Host *.internal\n  User deploy\n', '/home/me')).toEqual([])
  })
})
