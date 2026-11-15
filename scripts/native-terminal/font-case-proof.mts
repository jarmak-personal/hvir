import {
  SYSTEM_MONOSPACE_FONT_STACK,
  MAX_FONT_FAMILY_LENGTH,
} from '../../src/shared/interface-typography.ts'

export interface FontCase {
  readonly id: string
  readonly fontFamily: string
}
export const GENERIC_FONT_CASES: readonly FontCase[] = [
  { id: 'generic', fontFamily: 'monospace' },
  { id: 'sans', fontFamily: 'sans-serif' },
  { id: 'system', fontFamily: SYSTEM_MONOSPACE_FONT_STACK },
  {
    id: 'missing',
    fontFamily: '"hvir Native Missing Font", ' + SYSTEM_MONOSPACE_FONT_STACK,
  },
]
export function customFontCases(mono: string, proportional: string): readonly FontCase[] {
  const stack = (family: string) => {
    if (
      !family ||
      family.length > MAX_FONT_FAMILY_LENGTH ||
      Array.from(family).some((character) => {
        const code = character.codePointAt(0)!
        return code < 32 || code === 127
      })
    )
      throw new Error('native-font-case: unusable settings family')
    return (
      '"' +
      family.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"') +
      '", ' +
      SYSTEM_MONOSPACE_FONT_STACK
    )
  }
  return [
    { id: 'mono', fontFamily: stack(mono) },
    { id: 'proportional', fontFamily: stack(proportional) },
    { id: 'alias', fontFamily: stack('hvir Native Font Alias') },
  ]
}
export interface FontCaseRecord {
  readonly case: string
  readonly fontFamily: string
  readonly pid: number
  readonly appliedAppearanceSerial: 1
  readonly geometrySerial: 2
  readonly cellWidth: number
  readonly cellHeight: number
  readonly italicFeedApplied: true
  readonly currentFrameCompleted: true
  readonly hardwareQualified: false
  readonly firstRegular: string
  readonly regularFaces: readonly string[]
  readonly syntheticItalicFaces: readonly string[]
  readonly actualFontconfigVersion: number
  readonly requestedPreload: 'libfontconfig.so.1'
  readonly fontconfigPolicy: 'compiled-default' | 'owned-alias-including-etc-default'
}
export function parseFontCase(
  stdout: string,
  stderr: string,
  expected: FontCase,
): FontCaseRecord {
  if (stdout.length > 8192 || stderr.length > 65536)
    throw new Error('native-font-case: output bound')
  const value: unknown = JSON.parse(stdout)
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('native-font-case: result')
  const v = value as Record<string, unknown>
  const starts = [...stderr.matchAll(/^hvir-font-case-config-begin$/gmu)]
  const ends = [...stderr.matchAll(/^hvir-font-case-config-end$/gmu)]
  if (starts.length !== 1 || ends.length !== 1 || starts[0]!.index >= ends[0]!.index)
    throw new Error('native-font-case: configuration log boundary')
  const configured = stderr.slice(starts[0]!.index, ends[0]!.index)
  const regular = [
    ...configured.matchAll(/^info\(font_shared_grid_set\): font regular: ([^\r\n]+)$/gmu),
  ].map((m) => m[1]!)
  const italic = [
    ...configured.matchAll(
      /^info\(font_collection\): font synthetic italic created family=([^\r\n]+)$/gmu,
    ),
  ].map((m) => m[1]!)
  const versions = [...stderr.matchAll(/^info: dependency fontconfig=(\d+)$/gmu)]
  if (
    v.kind !== 'native-font-case' ||
    v.case !== expected.id ||
    v.fontFamily !== expected.fontFamily ||
    !Number.isSafeInteger(v.pid) ||
    Number(v.pid) <= 0 ||
    v.appliedAppearanceSerial !== 1 ||
    v.geometrySerial !== 2 ||
    !Number.isSafeInteger(v.cellWidth) ||
    Number(v.cellWidth) <= 0 ||
    !Number.isSafeInteger(v.cellHeight) ||
    Number(v.cellHeight) <= 0 ||
    v.italicFeedApplied !== true ||
    v.currentFrameCompleted !== true ||
    v.hardwareQualified !== false ||
    !regular.length ||
    regular.length > 32 ||
    italic.length > 32 ||
    [...regular, ...italic].some((name) => name.length > 256) ||
    versions.length !== 1 ||
    !Number.isSafeInteger(Number(versions[0]![1])) ||
    Number(versions[0]![1]) <= 0
  )
    throw new Error('native-font-case: unqualified result')
  return {
    case: expected.id,
    fontFamily: expected.fontFamily,
    pid: Number(v.pid),
    appliedAppearanceSerial: 1,
    geometrySerial: 2,
    cellWidth: Number(v.cellWidth),
    cellHeight: Number(v.cellHeight),
    italicFeedApplied: true,
    currentFrameCompleted: true,
    hardwareQualified: false,
    firstRegular: regular[0]!,
    regularFaces: regular,
    syntheticItalicFaces: italic,
    actualFontconfigVersion: Number(versions[0]![1]),
    requestedPreload: 'libfontconfig.so.1',
    fontconfigPolicy:
      expected.id === 'alias' ? 'owned-alias-including-etc-default' : 'compiled-default',
  }
}
export function validateFontCases(records: readonly FontCaseRecord[]): void {
  const ids = ['generic', 'sans', 'system', 'missing', 'mono', 'proportional', 'alias']
  if (
    records.length !== ids.length ||
    new Set(records.map((r) => r.pid)).size !== ids.length ||
    records.some((r, i) => r.case !== ids[i])
  )
    throw new Error('native-font-case: fresh ordered cases')
  const mono = records[0]!,
    proportional = records[1]!
  if (
    mono.firstRegular === proportional.firstRegular ||
    [records[2]!, records[3]!, records[4]!].some(
      (r) => r.firstRegular !== mono.firstRegular,
    ) ||
    [records[5]!, records[6]!].some((r) => r.firstRegular !== proportional.firstRegular)
  )
    throw new Error('native-font-case: family selection')
}
export const FONT_CASE_INPUTS = [
  'packages/native-terminal/appearance_probe.c',
  'scripts/native-terminal/artifacts.mts',
  'scripts/native-terminal/font-case-proof.mts',
  'src/shared/interface-typography.ts',
] as const
export function validFontCaseProof(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  if (
    v.kind !== 'native-font-cases' ||
    v.passed !== true ||
    !Array.isArray(v.records) ||
    !Array.isArray(v.inputs)
  )
    return false
  try {
    const records = v.records.map((item: unknown) => {
      if (!item || typeof item !== 'object' || Array.isArray(item))
        throw new Error('record')
      const r = item as Record<string, unknown>
      if (
        typeof r.case !== 'string' ||
        typeof r.fontFamily !== 'string' ||
        typeof r.firstRegular !== 'string' ||
        !r.firstRegular ||
        r.firstRegular.length > 256 ||
        !Array.isArray(r.regularFaces) ||
        !Array.isArray(r.syntheticItalicFaces) ||
        r.regularFaces.length > 32 ||
        r.syntheticItalicFaces.length > 32 ||
        r.regularFaces[0] !== r.firstRegular ||
        [...(r.regularFaces as unknown[]), ...(r.syntheticItalicFaces as unknown[])].some(
          (n: unknown) => typeof n !== 'string' || n.length > 256,
        ) ||
        !Number.isSafeInteger(r.pid) ||
        Number(r.pid) <= 0 ||
        r.appliedAppearanceSerial !== 1 ||
        r.geometrySerial !== 2 ||
        !Number.isSafeInteger(r.cellWidth) ||
        Number(r.cellWidth) <= 0 ||
        !Number.isSafeInteger(r.cellHeight) ||
        Number(r.cellHeight) <= 0 ||
        r.italicFeedApplied !== true ||
        r.currentFrameCompleted !== true ||
        r.hardwareQualified !== false ||
        r.requestedPreload !== 'libfontconfig.so.1' ||
        r.fontconfigPolicy !==
          (r.case === 'alias'
            ? 'owned-alias-including-etc-default'
            : 'compiled-default') ||
        !Number.isSafeInteger(r.actualFontconfigVersion) ||
        Number(r.actualFontconfigVersion) <= 0
      )
        throw new Error('facts')
      return item as FontCaseRecord
    })
    validateFontCases(records)
    const expected = [
      ...GENERIC_FONT_CASES,
      ...customFontCases(records[0]!.firstRegular, records[1]!.firstRegular),
    ]
    if (
      records.some((r, i) => r.fontFamily !== expected[i]!.fontFamily) ||
      v.inputs.length !== FONT_CASE_INPUTS.length
    )
      return false
    return v.inputs.every((input: unknown, i) => {
      if (!input || typeof input !== 'object') return false
      const field = input as Record<string, unknown>
      return (
        field.path === FONT_CASE_INPUTS[i] &&
        typeof field.sha256 === 'string' &&
        /^[a-f0-9]{64}$/u.test(field.sha256)
      )
    })
  } catch {
    return false
  }
}
