import { describe, expect, it, vi } from 'vitest'

import {
  SynchronizedOutputWriter,
  synchronizedOutputMarkers,
} from '../src/renderer/src/terminal/synchronized-output'

const { begin, end } = synchronizedOutputMarkers

describe('SynchronizedOutputWriter', () => {
  it('writes ordinary output immediately', () => {
    const writes: string[] = []
    const output = new SynchronizedOutputWriter((data) => writes.push(data))

    output.write('prompt')

    expect(writes).toEqual(['prompt'])
  })

  it('holds a synchronized frame and emits it atomically across split markers', () => {
    const writes: string[] = []
    const output = new SynchronizedOutputWriter((data) => writes.push(data))

    output.write(`before${begin.slice(0, 4)}`)
    output.write(`${begin.slice(4)}working${end.slice(0, 5)}`)
    expect(writes).toEqual(['before'])

    output.write(`${end.slice(5)}after`)

    expect(writes).toEqual(['before', `${begin}working${end}`, 'after'])
  })

  it('closes a timed-out frame before releasing it to the emulator', () => {
    vi.useFakeTimers()
    try {
      const writes: string[] = []
      const output = new SynchronizedOutputWriter((data) => writes.push(data), 150)

      output.write(`${begin}partial`)
      vi.advanceTimersByTime(149)
      expect(writes).toEqual([])
      vi.advanceTimersByTime(1)

      expect(writes).toEqual([`${begin}partial${end}`])
      output.write('visible')
      expect(writes.at(-1)).toBe('visible')
    } finally {
      vi.useRealTimers()
    }
  })

  it('bounds malformed frames by size', () => {
    const writes: string[] = []
    const output = new SynchronizedOutputWriter((data) => writes.push(data), 150, 12)

    output.write(`${begin}overflow`)

    expect(writes).toEqual([`${begin}overflow${end}`])
  })
})
