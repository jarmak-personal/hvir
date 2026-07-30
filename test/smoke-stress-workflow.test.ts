import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const workflow = readFileSync(
  new URL('../.github/workflows/smoke-stress.yml', import.meta.url),
  'utf8',
)

describe('Electron smoke stress workflow', () => {
  it('schedules fixed, non-retry evidence on Linux and macOS ARM64', () => {
    expect(workflow).toContain('workflow_dispatch:')
    expect(workflow).toContain('schedule:')
    expect(workflow).toContain('- ubuntu-24.04')
    expect(workflow).toContain('- macos-15')
    expect(workflow).toContain('pty-native')
    expect(workflow).toContain('renderer-recovery')
    expect(workflow).toContain('web-pane')
    expect(workflow).toContain('fromJSON(')
    expect(workflow).toContain("github.event_name == 'schedule' && '20'")
    expect(workflow).toContain('fail-fast: false')
    expect(workflow).not.toContain('pull_request:')
  })

  it('uploads only bounded failure artifacts for failed jobs', () => {
    expect(workflow).toContain('HVIR_SMOKE_ARTIFACT_DIR:')
    expect(workflow).toContain('if: failure()')
    expect(workflow).toContain('actions/upload-artifact@v7')
    expect(workflow).toContain('retention-days: 7')
    expect(workflow).toContain('if-no-files-found: ignore')
  })
})
