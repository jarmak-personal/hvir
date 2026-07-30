import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'
import YAML from 'yaml'

const workflow = readFileSync(
  new URL('../.github/workflows/real-host-ssh.yml', import.meta.url),
  'utf8',
)

describe('real-host SSH workflow', () => {
  it('is valid YAML', () => {
    expect(() => {
      void YAML.parse(workflow)
    }).not.toThrow()
  })

  it('is manual/scheduled and never joins the pull-request gate', () => {
    expect(workflow).toContain('workflow_dispatch:')
    expect(workflow).toContain('schedule:')
    expect(workflow).not.toContain('pull_request:')
    expect(workflow).toContain('permissions:\n  contents: read')
    expect(workflow).toContain('environment: real-host-ssh')
  })

  it('skips absent infrastructure and fails partial configuration', () => {
    expect(workflow).toContain("echo 'configured=false'")
    expect(workflow).toContain('acceptance is skipped')
    expect(workflow).toContain("if: needs.configuration.outputs.configured == 'true'")
    expect(workflow).toContain('partially configured')
    expect(workflow).toContain('exit 1')
  })

  it('passes only explicit protected configuration and retains bounded failures', () => {
    expect(workflow).toContain('secrets.HVIR_REAL_SSH_HOST')
    expect(workflow).toContain('secrets.HVIR_REAL_SSH_HOST_KEY')
    expect(workflow).toContain('secrets.HVIR_REAL_SSH_PRIVATE_KEY')
    expect(workflow).toContain('npm run acceptance:ssh:real-host')
    expect(workflow).toContain('if: failure()')
    expect(workflow).toContain('retention-days: 7')
    expect(workflow).toContain('if-no-files-found: ignore')
  })
})
