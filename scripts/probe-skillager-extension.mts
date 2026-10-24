import { withSmokeRunLock } from './smoke-run-lock.mts'
import { parseArgs } from 'node:util'
import { invokeSmokeScenario } from './run-smoke-scenarios.mts'

async function main(): Promise<void> {
  // Explicit installed-CLI capacity walkthrough, separate from the normal smoke deadline.
  for (const name of [
    'HVIR_SKILLAGER_EVIDENCE_CLI',
    'HVIR_SKILLAGER_EVIDENCE_CATALOG',
    'HVIR_SKILLAGER_EVIDENCE_LIBRARY',
  ]) {
    if (!process.env[name]) throw new Error(`Set ${name} to the supported existing setup`)
  }
  const { values } = parseArgs({
    options: {
      'reader-diagnostic': { type: 'boolean' },
      'project-inventory': { type: 'boolean' },
      package: { type: 'string' },
    },
    strict: true,
  })
  const diagnostic = values['reader-diagnostic'] === true
  if (values.package && !values.package.startsWith('/'))
    throw new Error('--package must be an absolute ZIP path')
  const result = await invokeSmokeScenario('extensions', 1, 1, {
    timeoutMs: 900_000,
    environment: {
      ...process.env,
      ...(values.package ? { HVIR_SKILLAGER_EVIDENCE_PACKAGE: values.package } : {}),
      HVIR_SKILLAGER_EVIDENCE_READER_DIAGNOSTIC: diagnostic ? '1' : '0',
      HVIR_SKILLAGER_PROJECT_PROOF: values['project-inventory'] ? '1' : '0',
    },
  })
  console.log('[probe:extension:skillager]', JSON.stringify(result))
  if (result.status !== 'passed') process.exitCode = 1
}
await withSmokeRunLock(main)
