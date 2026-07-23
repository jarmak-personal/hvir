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
const RECOVERY = 'Run `npm ci` in this worktree, then retry `npm run dev`.'

interface TerminalConstructor {
  readonly prototype: object
}

type LoadTerminal = () => Promise<unknown>

function isTerminalConstructor(value: unknown): value is TerminalConstructor {
  if (typeof value !== 'function') return false
  const prototype = Reflect.get(value, 'prototype') as unknown
  return typeof prototype === 'object' && prototype !== null
}

export function assertTerminalRuntimePatch(terminal: TerminalConstructor): void {
  const missing = REQUIRED_PRESENTATION_METHODS.filter(
    (method) => typeof Reflect.get(terminal.prototype, method) !== 'function',
  )
  if (missing.length === 0) return

  throw new Error(
    `Installed dependencies do not match this checkout: ghostty-web is missing the required terminal presentation patch (${missing.join(', ')}). ${RECOVERY}`,
  )
}

export async function verifyTerminalRuntimePatch(
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
  assertTerminalRuntimePatch(terminal)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await verifyTerminalRuntimePatch()
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
