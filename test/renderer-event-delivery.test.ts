import { describe, expect, it } from 'vitest'

import {
  classifyRendererEventDeliveryFailure,
  classifyRendererEventDeliveryTarget,
} from '../src/main/renderer-event-delivery'

describe('renderer event delivery failure classification', () => {
  it.each([
    { destroyed: false, expected: 'available' },
    { destroyed: true, expected: 'disposed-frame' },
  ] as const)(
    'classifies frame liveness before delivery ($destroyed)',
    ({ destroyed, expected }) => {
      expect(classifyRendererEventDeliveryTarget(destroyed)).toBe(expected)
    },
  )

  it('classifies only Electron disposed-frame delivery as stale', () => {
    expect(
      classifyRendererEventDeliveryFailure(
        new Error('Render frame was disposed before WebFrameMain could be accessed'),
      ),
    ).toBe('disposed-frame')
  })

  it.each([
    new Error('Render frame was disposed before WebFrameMain could be accessed later'),
    new Error('Renderer transport failed'),
    { message: 'Render frame was disposed before WebFrameMain could be accessed' },
  ])('rethrows an unrelated failure without replacing it', (failure) => {
    expect(() => classifyRendererEventDeliveryFailure(failure)).toThrow(failure)
  })
})
