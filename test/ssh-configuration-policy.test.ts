import { describe, expect, it } from 'vitest'
import SSHConfig from 'ssh-config'

import {
  prependSshHost,
  validateSshHostRequest,
} from '../src/main/project-host/ssh-configuration-policy'
import { parseSshConfig } from '../src/main/project-host/ssh-config'
import { localPath } from '../src/shared/host-path'

const request = {
  alias: 'added',
  hostname: 'new.example.test',
  username: 'riker',
  port: 2222,
}

describe('SSH configuration policy', () => {
  it('preserves comments, original bytes and effective global/wildcard settings for existing hosts', () => {
    const text =
      '# original comment\r\nUser global\r\nIdentityFile ~/.ssh/default\r\nHost *\r\n  Port 2200\r\nHost old other\r\n  HostName old.example.test\r\n# final comment'
    const saved = prependSshHost(text, request, '/home/test')
    expect(saved.endsWith(text)).toBe(true)
    const before = SSHConfig.parse(text)
    const after = SSHConfig.parse(saved)
    for (const alias of ['old', 'other', 'unnamed']) {
      expect(after.compute(alias, { ignoreCase: true, matchExec: false })).toEqual(
        before.compute(alias, { ignoreCase: true, matchExec: false }),
      )
    }
    expect(
      parseSshConfig(saved, '/home/test').find(({ alias }) => alias === 'added'),
    ).toEqual({
      alias: 'added',
      hostname: request.hostname,
      user: request.username,
      port: request.port,
      identityFiles: ['/home/test/.ssh/default'],
    })
  })

  it('quotes a selected local identity path without turning it into directives', () => {
    const identityFile = localPath('/home/test/keys/key with spaces')
    const saved = prependSshHost('', { ...request, identityFile }, '/home/test')
    expect(parseSshConfig(saved, '/home/test')[0]?.identityFiles).toEqual([
      identityFile.path,
    ])
  })

  it.each([
    '# header comment\nHost old\n  User picard\n',
    '\n# wildcard defaults\nHost *\n  User picard\nHost old\n',
    '# match defaults\nMatch all\n  User picard\nHost old\n',
    '# comments only\n\n',
  ])(
    'does not add empty wildcard sections to a config without global directives: %j',
    (text) => {
      const first = prependSshHost(text, request, '/home/test')
      const second = prependSshHost(first, { ...request, alias: 'another' }, '/home/test')
      expect(second.endsWith(text)).toBe(true)
      expect(second.match(/^Host \*$/gm) ?? []).toEqual(text.match(/^Host \*$/gm) ?? [])
      expect(
        SSHConfig.parse(second).compute('old', { ignoreCase: true, matchExec: false }),
      ).toEqual(
        SSHConfig.parse(text).compute('old', { ignoreCase: true, matchExec: false }),
      )
    },
  )

  it('restores global directive scope once across repeated additions', () => {
    const text = '# global defaults\nUser picard\nHost old\n  Port 2200\n'
    const first = prependSshHost(text, request, '/home/test')
    const second = prependSshHost(first, { ...request, alias: 'another' }, '/home/test')
    expect(second.endsWith(text)).toBe(true)
    expect(second.match(/^Host \*$/gm)).toHaveLength(1)
    for (const alias of ['old', 'unnamed']) {
      const before = SSHConfig.parse(text).compute(alias, {
        ignoreCase: true,
        matchExec: false,
      })
      const after = SSHConfig.parse(second).compute(alias, {
        ignoreCase: true,
        matchExec: false,
      })
      // The parser's Host metadata names the first matching section, not a setting.
      delete before['host']
      delete after['host']
      expect(after).toEqual(before)
    }
    expect(
      parseSshConfig(second, '/home/test').find(({ alias }) => alias === 'added'),
    ).toEqual(parseSshConfig(first, '/home/test').find(({ alias }) => alias === 'added'))
  })

  it('rejects duplicates from current multi-alias entries case insensitively', () => {
    expect(() =>
      prependSshHost('Host original Added\n  User picard\n', request, '/home/test'),
    ).toThrow('already exists')
  })

  it.each([
    { alias: '*' },
    { alias: 'two aliases' },
    { alias: 'local' },
    { hostname: 'example\nProxyCommand evil' },
    { hostname: '-option' },
    { username: '' },
    { username: 'user\rname' },
    { port: 0 },
    { port: 65536 },
    { port: 1.5 },
    { port: '22' },
    { destination: '/tmp/other' },
    { contents: 'Host evil' },
    { identityFile: { hostId: 'remote', path: '/key' } },
    { identityFile: localPath('relative') },
    { identityFile: localPath('/key\nUser evil') },
    { identityFile: localPath('/key/%h') },
  ])('rejects unsafe or unsupported submitted fields: %j', (change) => {
    expect(() => validateSshHostRequest({ ...request, ...change })).toThrow()
  })
})
