import { invokeSmokeScenario } from './run-smoke-scenarios.mts'

// Explicit installed-CLI capacity walkthrough, separate from the normal smoke deadline.
for (const name of [
  'HVIR_SKILLAGER_EVIDENCE_CLI',
  'HVIR_SKILLAGER_EVIDENCE_CATALOG',
  'HVIR_SKILLAGER_EVIDENCE_LIBRARY',
]) {
  if (!process.env[name]) throw new Error(`Set ${name} to the supported existing setup`)
}
const diagnostic = process.argv.slice(2).includes('--reader-diagnostic')
if (process.argv.slice(2).some((argument) => argument !== '--reader-diagnostic'))
  throw new Error('Only --reader-diagnostic is supported')
const result = await invokeSmokeScenario('extensions', 1, 1, {
  timeoutMs: 900_000,
  environment: {
    ...process.env,
    HVIR_SKILLAGER_EVIDENCE_READER_DIAGNOSTIC: diagnostic ? '1' : '0',
  },
})
console.log('[probe:extension:skillager]', JSON.stringify(result))
if (result.status !== 'passed') process.exitCode = 1
