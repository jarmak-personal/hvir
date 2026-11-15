import { spawn } from 'node:child_process'
import { describe, expect, it, onTestFinished } from 'vitest'
import {
  terminalSearchStreamProducer,
  terminalSearchEvictionProducer,
} from '../src/main/smoke/terminal-search-stream-producer'

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

describe('real timed terminal search eviction producer', () => {
  it.each(['lf', 'crlf'] as const)(
    'emits exactly 15000 unrelated rows before its marker with live partial output (%s)',
    async (lineEnding) => {
      const marker = '__OWNED_EVICTION_DONE__'
      const command = terminalSearchEvictionProducer({
        doneVariable: 'HVIR_EVICTION_DONE',
        lineEnding,
      })
      expect(command).not.toContain(marker)
      expect(Buffer.byteLength(command)).toBeLessThan(1024)
      const child = spawn('/bin/sh', ['-c', 'exec ' + command], {
        env: { ...process.env, HVIR_EVICTION_DONE: marker },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const closed = new Promise<number | null>((resolve, reject) => {
        child.once('error', reject)
        child.once('close', resolve)
      })
      onTestFinished(async () => {
        if (child.exitCode === null && child.signalCode === null) child.kill()
        await closed.catch(() => undefined)
      })
      let stdout = '',
        stderr = '',
        livePartialRows = false
      child.stdout.on('data', (data: Buffer) => {
        stdout += data.toString()
        const rows = stdout.split('\n').length - 1
        if (rows > 0 && rows < 15000 && !stdout.includes(marker))
          livePartialRows ||= child.exitCode === null && child.signalCode === null
      })
      child.stderr.on('data', (data: Buffer) => {
        stderr += data.toString()
      })
      expect(await closed).toBe(0)
      const newline = lineEnding === 'crlf' ? '\r\n' : '\n'
      expect(stdout).toBe(('unrelated output' + newline).repeat(15000) + marker + newline)
      expect(livePartialRows).toBe(true)
      expect(stderr).toBe('')
    },
    10000,
  )
  it('rejects shell expressions in the eviction marker variable', () => {
    expect(() =>
      terminalSearchEvictionProducer({
        doneVariable: 'x;exit 2',
        lineEnding: 'lf',
      }),
    ).toThrow()
  })
})
