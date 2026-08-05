#!/usr/bin/env node

import console from 'node:console'
import { resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const REQUIRED_PRESENTATION_METHODS = [
  'requestRender',
  'setRenderPaused',
  'resetCursorBlink',
  'getRenderStats',
] as const
const RECOVERY = 'Run `npm ci` in this worktree, then retry the command.'

interface TerminalConstructor {
  readonly prototype: object
}

type LoadTerminal = () => Promise<unknown>

function hasCustomLinkProviderPriority(prototype: object): boolean {
  const register = Reflect.get(prototype, 'registerLinkProvider') as unknown
  if (typeof register !== 'function') return false

  const provider = Object.freeze({})
  let receivedProvider: unknown
  let receivedPriority: unknown
  try {
    Reflect.apply(
      register,
      {
        linkDetector: {
          registerProvider(candidate: unknown, priority?: boolean) {
            receivedProvider = candidate
            receivedPriority = priority
          },
        },
      },
      [provider],
    )
  } catch {
    return false
  }
  return receivedProvider === provider && receivedPriority === true
}

function isTerminalConstructor(value: unknown): value is TerminalConstructor {
  if (typeof value !== 'function') return false
  const prototype = Reflect.get(value, 'prototype') as unknown
  return typeof prototype === 'object' && prototype !== null
}

export function assertTerminalRuntimeContract(terminal: TerminalConstructor): void {
  const missing: string[] = REQUIRED_PRESENTATION_METHODS.filter(
    (method) => typeof Reflect.get(terminal.prototype, method) !== 'function',
  )
  if (!hasCustomLinkProviderPriority(terminal.prototype)) {
    missing.push('custom link-provider priority')
  }
  if (missing.length === 0) return

  throw new Error(
    `Installed dependencies do not match this checkout: ghostty-web is missing required terminal runtime capabilities (${missing.join(', ')}). ${RECOVERY}`,
  )
}

export async function verifyTerminalRuntimeContract(
  loadTerminal: LoadTerminal = async () => (await import('ghostty-web')).Terminal,
): Promise<void> {
  let terminal: unknown
  try {
    terminal = await loadTerminal()
  } catch (cause) {
    throw new Error(
      `Installed dependencies do not match this checkout: ghostty-web could not be loaded. ${RECOVERY}`,
      { cause },
    )
  }
  if (!isTerminalConstructor(terminal)) {
    throw new Error(
      `Installed dependencies do not match this checkout: ghostty-web does not export the required Terminal constructor. ${RECOVERY}`,
    )
  }
  assertTerminalRuntimeContract(terminal)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await verifyTerminalRuntimeContract()
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
