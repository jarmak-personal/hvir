import { execFileSync } from 'node:child_process'
import {
  closeSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from 'node:fs'
import { parseArgs } from 'node:util'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REQUIRED_MAIN_ENTRIES = [
  '/out/main/index.js',
  '/out/main/echo-worker.js',
  '/out/main/git-worker.js',
] as const
const PTY_NATIVE_ENTRY = '/node_modules/node-pty/build/Release/pty.node'
const PTY_SPAWN_HELPER_ENTRY =
  '/node_modules/node-pty/build/Release/spawn-helper'
const FORBIDDEN_RUNTIME_MARKERS = [
  'HVIR_SMOKE',
  'runElectronSmokeScenario',
  '.hvir-smoke',
] as const

export interface PackagedRuntimeInspection {
  readonly mainEntries: readonly string[]
  readonly nativeEntries: readonly string[]
}

export type NativePlatform = 'darwin' | 'linux'

interface AsarEntry {
  readonly files?: Readonly<Record<string, AsarEntry>>
  readonly link?: string
  readonly offset?: string
  readonly size?: number
  readonly unpacked?: boolean
}

interface AsarArchive {
  readonly entries: readonly string[]
  readEntry(entry: string): Buffer
}

function readExactly(
  descriptor: number,
  buffer: Buffer,
  position: number,
  label: string,
): void {
  if (readSync(descriptor, buffer, 0, buffer.length, position) !== buffer.length) {
    throw new Error(`Unable to read packaged ${label}`)
  }
}

function parseAsarHeader(archive: string): {
  readonly header: AsarEntry
  readonly headerSize: number
} {
  const archiveSize = statSync(archive).size
  const descriptor = openSync(archive, 'r')
  try {
    const sizePickle = Buffer.alloc(8)
    readExactly(descriptor, sizePickle, 0, 'ASAR header size')
    if (sizePickle.readUInt32LE(0) !== 4) {
      throw new Error('Packaged ASAR header size pickle is invalid')
    }
    const headerSize = sizePickle.readUInt32LE(4)
    if (headerSize < 8 || headerSize > archiveSize - 8) {
      throw new Error(`Packaged ASAR header size ${headerSize} is invalid`)
    }

    const headerPickle = Buffer.alloc(headerSize)
    readExactly(descriptor, headerPickle, 8, 'ASAR header')
    const payloadSize = headerPickle.readUInt32LE(0)
    const stringSize = headerPickle.readUInt32LE(4)
    if (payloadSize > headerSize - 4 || stringSize > payloadSize - 4) {
      throw new Error('Packaged ASAR header pickle is invalid')
    }
    const parsed: unknown = JSON.parse(
      headerPickle.subarray(8, 8 + stringSize).toString('utf8'),
    )
    if (!parsed || typeof parsed !== 'object' || !('files' in parsed)) {
      throw new Error('Packaged ASAR header has no file graph')
    }
    return { header: parsed as AsarEntry, headerSize }
  } finally {
    closeSync(descriptor)
  }
}

export function readAsarArchive(archive: string): AsarArchive {
  const { header, headerSize } = parseAsarHeader(archive)
  const entries: string[] = []
  const nodes = new Map<string, AsarEntry>()

  const visit = (entry: AsarEntry, base: string): void => {
    for (const [name, child] of Object.entries(entry.files ?? {})) {
      const path = `${base}/${name}`
      entries.push(path)
      nodes.set(path, child)
      visit(child, path)
    }
  }
  visit(header, '')

  return {
    entries,
    readEntry(entry): Buffer {
      const node = nodes.get(entry)
      if (!node) {
        throw new Error(`Packaged ASAR entry ${entry} does not exist`)
      }
      if (node.link) {
        throw new Error(`Inspected packaged ASAR entry ${entry} is a link`)
      }
      if (!Number.isSafeInteger(node.size) || node.size! < 0) {
        throw new Error(`Packaged ASAR entry ${entry} has an invalid size`)
      }
      if (node.unpacked) {
        return readFileSync(`${archive}.unpacked${entry}`)
      }
      if (!node.offset || !/^\d+$/.test(node.offset)) {
        throw new Error(`Packaged ASAR entry ${entry} has an invalid offset`)
      }
      const offset = Number(node.offset)
      if (!Number.isSafeInteger(offset)) {
        throw new Error(`Packaged ASAR entry ${entry} has an unsafe offset`)
      }
      const content = Buffer.alloc(node.size!)
      const descriptor = openSync(archive, 'r')
      try {
        readExactly(
          descriptor,
          content,
          8 + headerSize + offset,
          `ASAR entry ${entry}`,
        )
      } finally {
        closeSync(descriptor)
      }
      return content
    },
  }
}

export function requiredNativeEntries(
  platform: NativePlatform,
): readonly string[] {
  return platform === 'darwin'
    ? [PTY_NATIVE_ENTRY, PTY_SPAWN_HELPER_ENTRY]
    : [PTY_NATIVE_ENTRY]
}

export function inspectPackagedRuntimeGraph(
  entries: readonly string[],
  readEntry: (entry: string) => string,
  platform: NativePlatform,
): PackagedRuntimeInspection {
  for (const required of REQUIRED_MAIN_ENTRIES) {
    if (!entries.includes(required)) {
      throw new Error(`Packaged runtime is missing production entry ${required}`)
    }
  }
  const nativeEntries = requiredNativeEntries(platform)
  for (const required of nativeEntries) {
    if (!entries.includes(required)) {
      throw new Error(`Packaged runtime is missing native payload ${required}`)
    }
  }

  const smokeEntry = entries.find(
    (entry) =>
      entry.startsWith('/out/main/smoke/') ||
      /\/out\/main\/(?:chunks\/)?scenarios-[^/]+\.js$/.test(entry),
  )
  if (smokeEntry) {
    throw new Error(`Packaged runtime retained smoke entry ${smokeEntry}`)
  }

  const javascriptEntries = entries.filter(
    (entry) => entry.startsWith('/out/') && entry.endsWith('.js'),
  )
  for (const entry of javascriptEntries) {
    const source = readEntry(entry)
    const marker = FORBIDDEN_RUNTIME_MARKERS.find((candidate) =>
      source.includes(candidate),
    )
    if (marker) {
      throw new Error(`Packaged runtime entry ${entry} retained smoke marker ${marker}`)
    }
  }

  return {
    mainEntries: REQUIRED_MAIN_ENTRIES,
    nativeEntries,
  }
}

function inspectNativePayloads(
  archive: string,
  entries: readonly string[],
  architecture: string,
): void {
  for (const entry of entries) {
    const unpackedPath = `${archive}.unpacked${entry}`
    const mode = statSync(unpackedPath).mode & 0o777
    if (mode !== 0o755) {
      throw new Error(
        `Packaged native payload ${entry} has mode ${mode.toString(8)} instead of 755`,
      )
    }
    const description = execFileSync('/usr/bin/file', ['-b', unpackedPath], {
      encoding: 'utf8',
    }).trim()
    if (!description.includes(architecture)) {
      throw new Error(
        `Packaged native payload ${entry} does not match architecture ${architecture}`,
      )
    }
  }
}

function main(): void {
  const { values } = parseArgs({
    options: {
      archive: { type: 'string' },
      'native-architecture': { type: 'string' },
      'native-platform': { type: 'string' },
    },
    strict: true,
  })
  if (
    !values.archive ||
    !values['native-architecture'] ||
    !values['native-platform']
  ) {
    throw new Error(
      '--archive, --native-architecture, and --native-platform are required',
    )
  }
  const platform = values['native-platform']
  if (platform !== 'darwin' && platform !== 'linux') {
    throw new Error('--native-platform must be darwin or linux')
  }
  const archive = readAsarArchive(values.archive)
  const inspection = inspectPackagedRuntimeGraph(
    archive.entries,
    (entry) => archive.readEntry(entry).toString('utf8'),
    platform,
  )
  inspectNativePayloads(
    values.archive,
    inspection.nativeEntries,
    values['native-architecture'],
  )
  console.log(
    `Verified packaged production graph (${inspection.mainEntries.length} entries) and native payload (${inspection.nativeEntries.length} files).`,
  )
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
