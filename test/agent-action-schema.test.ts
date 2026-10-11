import { expect, it } from 'vitest'
import {
  validateActionInput,
  validateActionSchema,
} from '../src/shared/extensions/action-input'
it('enforces the bounded selected declaration without trusting descriptions or unknown schema policy', () => {
  const schema = validateActionSchema({
    type: ['object', 'null'],
    properties: { delayMs: { type: 'number' } },
    additionalProperties: false,
  })
  expect(() => validateActionInput(null, schema)).not.toThrow()
  expect(() => validateActionInput({ delayMs: 500 }, schema)).not.toThrow()
  expect(() => validateActionInput({ approval: 'human' }, schema)).toThrow('undeclared')
  expect(() => validateActionInput({ delayMs: '500' }, schema)).toThrow('schema')
  expect(() => validateActionSchema({ type: 'object', $ref: '/policy' })).toThrow(
    'Unsupported',
  )
})
