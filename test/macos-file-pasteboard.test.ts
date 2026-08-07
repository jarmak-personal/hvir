import { describe, expect, it, vi } from 'vitest'

import { writeMacFilePasteboard } from '../src/main/smoke/macos-file-pasteboard'
import type { ProjectHost } from '../src/main/project-host'
import { asHostId, hostPath, type ExecResult } from '../src/shared'

describe('writeMacFilePasteboard', () => {
  it('passes the source path separately to the native AppKit writer', async () => {
    const path = "/tmp/file path ' argv-only.txt"
    const source = hostPath(asHostId('fixture-pasteboard-host'), path)
    const exec = executor(success())

    await writeMacFilePasteboard({ exec }, source)

    expect(exec).toHaveBeenCalledOnce()
    const [command, args, options] = exec.mock.calls[0]!
    expect(command).toBe('/usr/bin/swift')
    expect(args[0]).toBe('-e')
    expect(args.slice(2)).toEqual([path])
    expect(args[1]).toContain('NSPasteboard.general')
    expect(args[1]).toContain('writeObjects([fileURL])')
    expect(args[1]).not.toContain(path)
    expect(args[1]).not.toContain(source.hostId)
    expect(options).toEqual({ maxBuffer: 64 * 1024 })
  })

  it('rejects a failed native writer without exposing its output', async () => {
    const exec = executor({
      code: 2,
      signal: null,
      stdout: 'unreviewed output',
      stderr: 'unreviewed error',
    })

    await expect(writeMacFilePasteboard({ exec }, source())).rejects.toThrow(
      'macOS AppKit file pasteboard writer exited with code 2',
    )
  })

  it('rejects an explicit NSPasteboard write failure', async () => {
    const exec = executor(success('write=false\nformat=missing\n'))

    await expect(writeMacFilePasteboard({ exec }, source())).rejects.toThrow(
      'macOS NSPasteboard.writeObjects returned false',
    )
  })

  it('rejects a writer that omits its explicit write result', async () => {
    const exec = executor(success('format=public.file-url\n'))

    await expect(writeMacFilePasteboard({ exec }, source())).rejects.toThrow(
      'omitted its write result',
    )
  })

  it('rejects a write that lacks the reviewed file URL format', async () => {
    const exec = executor(success('write=true\nformat=missing\n'))

    await expect(writeMacFilePasteboard({ exec }, source())).rejects.toThrow(
      'did not publish reviewed public.file-url data',
    )
  })
})

function executor(result: ExecResult) {
  return vi.fn<Pick<ProjectHost, 'exec'>['exec']>(() => Promise.resolve(result))
}

function success(stdout = 'write=true\nformat=public.file-url\n'): ExecResult {
  return { code: 0, signal: null, stdout, stderr: '' }
}

function source() {
  return hostPath(asHostId('fixture-pasteboard-host'), '/tmp/source')
}
