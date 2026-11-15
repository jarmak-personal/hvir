import { describe, expect, it } from 'vitest'
import {
  FONT_CASE_INPUTS,
  GENERIC_FONT_CASES,
  customFontCases,
  parseFontCase,
  validFontCaseProof,
  validateFontCases,
  type FontCase,
} from '../scripts/native-terminal/font-case-proof.mts'
import { SYSTEM_MONOSPACE_FONT_STACK } from '../src/shared/interface-typography'

const mono = 'Fixture Mono'
const proportional = 'Fixture Proportional'
const cases = () => [...GENERIC_FONT_CASES, ...customFontCases(mono, proportional)]
const caseOutput = (input: FontCase, pid = 1) => ({
  kind: 'native-font-case',
  case: input.id,
  fontFamily: input.fontFamily,
  pid,
  appliedAppearanceSerial: 1,
  geometrySerial: 2,
  cellWidth: 13,
  cellHeight: 17,
  italicFeedApplied: true,
  currentFrameCompleted: true,
  hardwareQualified: false,
})
const caseLog = (family = mono, version = 21301) =>
  [
    'unrelated diagnostic discarded',
    'info(font_shared_grid_set): font regular: Discarded Startup Face',
    `info: dependency fontconfig=${version}`,
    'hvir-font-case-config-begin',
    `info(font_shared_grid_set): font regular: ${family}`,
    `info(font_collection): font synthetic italic created family=${family}`,
    'hvir-font-case-config-end',
    '',
  ].join('\n')
function proof() {
  return {
    kind: 'native-font-cases',
    passed: true,
    records: cases().map((input, i) =>
      parseFontCase(
        JSON.stringify(caseOutput(input, i + 1)),
        caseLog(
          ['sans', 'proportional', 'alias'].includes(input.id) ? proportional : mono,
        ),
        input,
      ),
    ),
    inputs: FONT_CASE_INPUTS.map((path) => ({ path, sha256: 'a'.repeat(64) })),
  }
}

describe('native font qualification request and application evidence', () => {
  it('uses the canonical Settings stack and preserves quoted Unicode custom names', () => {
    expect(GENERIC_FONT_CASES.find((input) => input.id === 'system')?.fontFamily).toBe(
      SYSTEM_MONOSPACE_FONT_STACK,
    )
    expect(customFontCases('字体, Mono; "A"\\B', proportional)[0]?.fontFamily).toBe(
      '"字体, Mono; \\"A\\"\\\\B", ' + SYSTEM_MONOSPACE_FONT_STACK,
    )
    expect(() => customFontCases('bad\nfamily', proportional)).toThrow('settings family')
  })

  it('binds actual native face diagnostics to one acknowledged case and discards other logs', () => {
    const input = cases()[0]!
    const record = parseFontCase(JSON.stringify(caseOutput(input)), caseLog(), input)
    expect(record).toMatchObject({
      case: 'generic',
      appliedAppearanceSerial: 1,
      geometrySerial: 2,
      firstRegular: mono,
      regularFaces: [mono],
      syntheticItalicFaces: [mono],
      requestedPreload: 'libfontconfig.so.1',
      actualFontconfigVersion: 21301,
      hardwareQualified: false,
    })
    expect(JSON.stringify(record)).not.toContain('unrelated diagnostic')
    expect(
      parseFontCase(JSON.stringify(caseOutput(input)), caseLog(mono, 21803), input)
        .actualFontconfigVersion,
    ).toBe(21803)
  })

  it.each([
    ['case', 'missing'],
    ['fontFamily', 'unrelated'],
    ['pid', 0],
    ['appliedAppearanceSerial', 2],
    ['geometrySerial', 1],
    ['cellWidth', 0],
    ['cellHeight', 1.5],
    ['italicFeedApplied', false],
    ['currentFrameCompleted', false],
    ['hardwareQualified', true],
  ])('refuses unqualified case output %s', (field, value) => {
    const input = cases()[0]!
    expect(() =>
      parseFontCase(
        JSON.stringify({ ...caseOutput(input), [field]: value }),
        caseLog(),
        input,
      ),
    ).toThrow('unqualified')
  })

  it('requires bounded, unambiguous actual version and selected-face logs', () => {
    const input = cases()[0]!,
      output = JSON.stringify(caseOutput(input))
    for (const log of [
      '',
      'info: dependency fontconfig=21301\n',
      caseLog() + 'info: dependency fontconfig=21803\n',
      caseLog().replace('hvir-font-case-config-begin', ''),
      caseLog() + 'hvir-font-case-config-begin\n',
      caseLog().replace('hvir-font-case-config-end', ''),
      caseLog().replace('fontconfig=21301', 'fontconfig=' + '9'.repeat(400)),
      caseLog('x'.repeat(257)),
      caseLog() + 'x'.repeat(65537),
    ])
      expect(() => parseFontCase(output, log, input)).toThrow()
  })

  it('requires fresh processes and actual system/missing/custom/alias family selection', () => {
    const good = proof()
    expect(() => validateFontCases(good.records)).not.toThrow()
    expect(validFontCaseProof(good)).toBe(true)
    const duplicate = structuredClone(good)
    duplicate.records[1] = { ...duplicate.records[1]!, pid: duplicate.records[0]!.pid }
    expect(validFontCaseProof(duplicate)).toBe(false)
    for (const index of [2, 3, 4, 5, 6]) {
      const changed = structuredClone(good)
      const wrong = index < 5 ? proportional : mono
      changed.records[index] = {
        ...changed.records[index]!,
        firstRegular: wrong,
        regularFaces: [wrong],
      }
      expect(validFontCaseProof(changed)).toBe(false)
    }
  })

  it('rejects persisted acknowledgement, input-identity and preload corruption', () => {
    const good = proof()
    for (const [field, value] of [
      ['appliedAppearanceSerial', 0],
      ['geometrySerial', 3],
      ['requestedPreload', 'arbitrary-library.so'],
      ['fontconfigPolicy', 'ambient'],
      ['italicFeedApplied', false],
      ['currentFrameCompleted', false],
      ['actualFontconfigVersion', 0],
      ['firstRegular', ''],
      ['regularFaces', []],
      ['fontFamily', 'unrelated'],
    ] as const) {
      const changed = structuredClone(good)
      Object.assign(changed.records[0]!, { [field]: value })
      expect(validFontCaseProof(changed)).toBe(false)
    }
    const changed = structuredClone(good)
    changed.inputs[0]!.sha256 = 'not-a-sha'
    expect(validFontCaseProof(changed)).toBe(false)
    expect(validFontCaseProof({ ...good, inputs: [...good.inputs].reverse() })).toBe(
      false,
    )
    expect(validFontCaseProof({ ...good, records: good.records.slice(1) })).toBe(false)
    expect(validFontCaseProof({ ...good, passed: false })).toBe(false)
  })
})
