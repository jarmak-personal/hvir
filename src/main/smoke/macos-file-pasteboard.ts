import type { ProjectHost } from '../project-host'
import type { HostPath } from '../../shared'

const APPKIT_FILE_PASTEBOARD_PROGRAM = String.raw`
import AppKit
import Foundation

let pasteboard = NSPasteboard.general
pasteboard.clearContents()
let fileURL = NSURL(fileURLWithPath: CommandLine.arguments.last!)
let wrote = pasteboard.writeObjects([fileURL])
let hasReviewedFormat = pasteboard.types?.contains(.fileURL) == true
print(wrote ? "write=true" : "write=false")
print(hasReviewedFormat ? "format=public.file-url" : "format=missing")
`

/** Installs one real disk-file item in the inherited macOS pasteboard session. */
export async function writeMacFilePasteboard(
  host: Pick<ProjectHost, 'exec'>,
  source: HostPath,
): Promise<void> {
  const result = await host.exec(
    '/usr/bin/swift',
    ['-e', APPKIT_FILE_PASTEBOARD_PROGRAM, source.path],
    { maxBuffer: 64 * 1024 },
  )
  if (result.code !== 0) {
    throw new Error(
      result.code === null
        ? `macOS AppKit file pasteboard writer terminated by ${result.signal ?? 'an unknown signal'}`
        : `macOS AppKit file pasteboard writer exited with code ${result.code}`,
    )
  }
  const evidence = new Set(result.stdout.trim().split(/\r?\n/u))
  if (evidence.has('write=false')) {
    throw new Error('macOS NSPasteboard.writeObjects returned false')
  }
  if (!evidence.has('write=true')) {
    throw new Error('macOS AppKit file pasteboard writer omitted its write result')
  }
  if (!evidence.has('format=public.file-url')) {
    throw new Error(
      'macOS AppKit file pasteboard writer did not publish reviewed public.file-url data',
    )
  }
}
