import { spawn } from 'node:child_process'
import { describe, expect, it, onTestFinished } from 'vitest'
import { terminalSearchStreamProducer } from '../src/main/smoke/terminal-search-stream-producer'

describe('real timed terminal search producer', () => {
  it.each(['lf', 'crlf'] as const)(
    'emits all rows, the ordinal-30 match and final marker through one Node process (%s)',
    async (lineEnding) => {
      const command = terminalSearchStreamProducer({
        matchVariable: 'HVIR_MATCH',
        doneVariable: 'HVIR_DONE',
        readyVariable: 'HVIR_READY',
        lineEnding,
      })
      expect(command).not.toContain('exact-search-needle')
      expect(command).not.toContain('__DONE__')
      expect(Buffer.byteLength(command)).toBeLessThan(1024)
      const child = spawn('/bin/sh', ['-c', 'exec ' + command], {
        env: {
          ...process.env,
          HVIR_MATCH: 'exact-search-needle',
          HVIR_DONE: '__DONE__',
          HVIR_READY: '__READY__',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      onTestFinished(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill()
      })
      let stdout = '',
        stderr = '',
        observedLiveMatch = false
      child.stdout.on('data', (data: Buffer) => {
        stdout += data.toString()
        const lines = stdout.replaceAll('\r', '')
        if (lines.includes('\nexact-search-needle\n') && !lines.includes('__DONE__'))
          observedLiveMatch ||= child.exitCode === null && child.signalCode === null
      })
      child.stderr.on('data', (data: Buffer) => {
        stderr += data.toString()
      })
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject)
        child.once('close', resolve)
      })
      expect(code).toBe(0)
      expect(observedLiveMatch).toBe(true)
      const newline = lineEnding === 'crlf' ? '\r\n' : '\n'
      const rows = ['__READY__']
      for (let i = 0; i < 150; i++) {
        rows.push(`stream filler ${i}`)
        if (i === 30) rows.push('exact-search-needle')
      }
      rows.push('__DONE__', '')
      expect(stdout).toBe(rows.join(newline))
      expect(stderr).toBe('')
    },
    10000,
  )
  it('refuses interpolated shell expressions instead of executing them', () => {
    expect(() =>
      terminalSearchStreamProducer({
        matchVariable: 'x;exit 2',
        doneVariable: 'DONE',
        lineEnding: 'lf',
      }),
    ).toThrow('terminal-stream-producer-variable')
  })
})
