import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

interface Workflow {
  jobs: Record<string, { steps: Array<{ name?: string; run?: string }> }>
}
const workflow = parse(
  readFileSync(
    new URL('../.github/workflows/native-terminal.yml', import.meta.url),
    'utf8',
  ),
) as Workflow
const qualification = Object.values(workflow.jobs)
  .flatMap((job) => job.steps)
  .find((step) => step.name === 'Qualify the ordinary native workbench runtime')?.run
if (!qualification) throw new Error('Native workbench qualification step missing')

/** Executes the real workflow shell and JSON assertions; only build/display/producer are fixtures. */
function executeQualification(
  command: string,
  platform: 'macOS' | 'Linux',
  invalid = false,
) {
  const directory = mkdtempSync(join(tmpdir(), 'hvir-native-workbench-report-'))
  try {
    const bin = join(directory, 'bin')
    mkdirSync(bin)
    mkdirSync(join(directory, 'hvir-native-bindings'))
    const producer = join(directory, 'producer.cjs')
    writeFileSync(
      producer,
      `
const proof = {
  platform: process.env.RUNNER_OS === 'Linux' ? 'linux' : 'darwin',
  actualWorkbench: true, resizeControl: 'terminal-rail',
  stack: {successfulExplicitSelection: {backend: 'x11'}},
  rendererSandboxed: true, rendererContextIsolated: true, supervisorSpawns: 1,
  nativeInstanceMatched: true, parserMarker: true, retainedExitTail: true,
  rendererCanvas: true, nativeEncodedKeyboard: true, capturedAnsiRedPixels: 501,
  resizeAcknowledgedByStty: {rows: 21, columns: 80}, development: true,
  hardwareQualified: process.env.HVIR_TEST_INVALID === 'true',
  diagnosticPadding: 'x'.repeat(90000),
};
const line = 'HVIR_NATIVE_WORKBENCH_OK ' + JSON.stringify(proof) + '\\n';
process.stdout.write(line.slice(0, 65536), () => {
  process.stderr.write('controlled native cleanup diagnostic\\n', () => {
    process.stdout.write(line.slice(65536));
  });
});
`,
    )
    writeFileSync(join(bin, 'npm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    writeFileSync(join(bin, 'xvfb-run'), '#!/bin/sh\nshift\nexec "$@"\n', { mode: 0o755 })
    writeFileSync(
      join(bin, 'node'),
      `#!/bin/sh
if [ "$1" = "scripts/run-smoke-scenarios.mts" ]; then
  exec "$HVIR_TEST_NODE" "$HVIR_TEST_PRODUCER"
fi
exec "$HVIR_TEST_NODE" "$@"
`,
      { mode: 0o755 },
    )
    const result = spawnSync('bash', ['-euo', 'pipefail', '-c', command], {
      cwd: directory,
      encoding: 'utf8',
      timeout: 10000,
      maxBuffer: 1024 * 1024,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env['PATH'] ?? ''}`,
        RUNNER_TEMP: directory,
        RUNNER_OS: platform,
        HVIR_TEST_NODE: process.execPath,
        HVIR_TEST_PRODUCER: producer,
        HVIR_TEST_INVALID: String(invalid),
      },
    })
    const proof = readFileSync(
      join(directory, 'hvir-native-bindings/workbench-proof.jsonl'),
      'utf8',
    )
    return { status: result.status, error: result.error, stderr: result.stderr, proof }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

describe('native workbench machine-readable workflow stream', () => {
  it.each(['macOS', 'Linux'] as const)(
    'keeps interleaved %s diagnostics out of a large stdout receipt',
    (platform) => {
      const result = executeQualification(qualification, platform)
      expect(result.error).toBeUndefined()
      expect(result.status).toBe(0)
      expect(result.stderr).toContain('controlled native cleanup diagnostic')
      expect(result.proof).not.toContain('controlled native cleanup diagnostic')
      expect(result.proof.length).toBeGreaterThan(65536)
      expect(result.proof.split('\n').filter(Boolean)).toHaveLength(1)
    },
  )

  it('reproduces corruption when diagnostic stderr is merged before the strict reader', () => {
    const merged = qualification.replaceAll(
      'native-terminal-workbench \\\n',
      'native-terminal-workbench 2>&1 \\\n',
    )
    expect(merged).not.toBe(qualification)
    const result = executeQualification(merged, 'macOS')
    expect(result.status).not.toBe(0)
    expect(result.proof).toContain('controlled native cleanup diagnostic')
    const firstLine = result.proof.split('\n')[0]!
    expect(() => {
      JSON.parse(firstLine.slice('HVIR_NATIVE_WORKBENCH_OK '.length))
    }).toThrow(SyntaxError)
  })

  it('retains the workflow acceptance assertions after separating diagnostic output', () => {
    const result = executeQualification(qualification, 'macOS', true)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('AssertionError')
  })
})
