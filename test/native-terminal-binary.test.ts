import { describe, expect, it } from 'vitest'
import { linuxDependencyIsolation } from '../scripts/native-terminal/binary.mts'

const required = [
  'ghostty_init',
  'ghostty_info',
  'ghostty_external_surface_new',
  'hvir_ghostty_embed_abi',
]
const symbol = (name: string, index = '12', binding = 'GLOBAL') =>
  `  12: 0000000000123450 32 FUNC ${binding} DEFAULT ${index} ${name}`
const approved = required.map((name) => symbol(name)).join('\n')

describe('full native Linux dependency isolation', () => {
  it('preserves only the public/private Ghostty API and system imports', () => {
    const proof = linuxDependencyIsolation(
      `${approved}\n${symbol('eglGetDisplay', 'UND')}\n${symbol('memcpy@GLIBC_2.14', 'UND')}\n${symbol('FcGetVersion', '12', 'LOCAL')}`,
      '00000010 00001 R_X86_64_JUMP_SLOT 00000000 eglGetDisplay + 0',
    )
    expect(proof.exports).toEqual([...required].sort())
    expect(proof.imports).toEqual(['eglGetDisplay', 'memcpy'])
    expect(proof.bundledDependencies).toContain('fontconfig')
    expect(proof.policy).toBe('linux-local-bundled-definitions')
  })
  it.each([
    'FcGetVersion',
    'hb_version_string',
    'FT_Init_FreeType',
    'png_create_read_struct',
    'xmlReadFile',
    'onig_new',
    'inflate',
    'crc32',
  ])('rejects a bundled %s definition exported for ambient interposition', (name) => {
    expect(() => linuxDependencyIsolation(`${approved}\n${symbol(name)}`, '')).toThrow(
      'unexpected dynamic export',
    )
  })
  it.each(['GLOBAL', 'WEAK', 'UNIQUE'])(
    'rejects unexpected %s definitions',
    (binding) => {
      expect(() =>
        linuxDependencyIsolation(
          `${approved}\n${symbol('accidental_export', '12', binding)}`,
          '',
        ),
      ).toThrow('unexpected dynamic export')
    },
  )
  it('rejects an undefined dependency even when no relocation is shown', () => {
    expect(() =>
      linuxDependencyIsolation(`${approved}\n${symbol('FcGetVersion', 'UND')}`, ''),
    ).toThrow('preemptible bundled dependency import')
  })
  it.each(['R_X86_64_JUMP_SLOT', 'R_AARCH64_JUMP_SLOT'])(
    'rejects %s calls into an ambient dependency',
    (relocation) => {
      expect(() =>
        linuxDependencyIsolation(
          approved,
          `000001 000002 ${relocation} 0000000 hb_version_string + 0`,
        ),
      ).toThrow('preemptible bundled dependency relocation')
    },
  )
  it.each(required)('requires the embedding export %s', (missing) => {
    expect(() =>
      linuxDependencyIsolation(
        required
          .filter((name) => name !== missing)
          .map((name) => symbol(name))
          .join('\n'),
        '',
      ),
    ).toThrow('missing embedding export')
  })
})
