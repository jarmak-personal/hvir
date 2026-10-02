import { isAbsolute } from 'node:path'

import type { AddSshHostRequest } from '../../shared/ssh-configuration'
import { parseSshConfig } from './ssh-config'

export const MAX_SSH_CONFIG_BYTES = 256 * 1024

export function validateSshHostRequest(value: unknown): AddSshHostRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Enter SSH host connection fields')
  }
  const fields = value as Record<string, unknown>
  if (
    Object.keys(fields).some(
      (key) => !['alias', 'hostname', 'username', 'port', 'identityFile'].includes(key),
    )
  )
    throw new Error('Unsupported SSH host field')
  const token = (name: string, pattern: RegExp): string => {
    const field = fields[name]
    if (typeof field !== 'string' || !pattern.test(field)) {
      throw new Error(`Enter a valid SSH ${name}`)
    }
    return field
  }
  const alias = token('alias', /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/)
  if (alias.toLowerCase() === 'local') throw new Error('The alias local is reserved')
  const hostname = token('hostname', /^[A-Za-z0-9:][A-Za-z0-9.:%_-]{0,254}$/)
  const username = token('username', /^[A-Za-z0-9_][A-Za-z0-9_.@-]{0,254}$/)
  const port = fields.port
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Enter a port between 1 and 65535')
  }
  const identityFile = fields.identityFile as AddSshHostRequest['identityFile']
  if (
    identityFile !== undefined &&
    (!identityFile ||
      identityFile.hostId !== 'local' ||
      typeof identityFile.path !== 'string' ||
      !isAbsolute(identityFile.path) ||
      identityFile.path.length > 4096 ||
      [...identityFile.path].some(
        (character) =>
          character.charCodeAt(0) < 32 ||
          character.charCodeAt(0) === 127 ||
          character === '%',
      ))
  )
    throw new Error('Choose a local identity file with an absolute path')
  return { alias, hostname, username, port, ...(identityFile ? { identityFile } : {}) }
}

/** Preserve the original bytes; exact new fields precede existing wildcard defaults. */
export function prependSshHost(
  text: string,
  request: AddSshHostRequest,
  home: string,
): string {
  const fields = validateSshHostRequest(request)
  if (
    parseSshConfig(text, home).some(
      ({ alias }) => alias.toLowerCase() === fields.alias.toLowerCase(),
    )
  ) {
    throw new Error('That SSH alias already exists. Choose another alias')
  }
  const newline = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = [
    `Host ${fields.alias}`,
    `  HostName ${fields.hostname}`,
    `  User ${fields.username}`,
    `  Port ${fields.port}`,
  ]
  if (fields.identityFile) {
    const quoted = fields.identityFile.path
      .replaceAll('\\', '\\\\')
      .replaceAll('"', '\\"')
    lines.push(`  IdentityFile "${quoted}"`)
  }
  return lines.join(newline) + newline + newline + (text ? `Host *${newline}` + text : '')
}
