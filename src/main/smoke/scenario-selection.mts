export const ELECTRON_SMOKE_SCENARIOS = [
  'pty-native',
  'viewer-position',
  'platform-contracts',
  'terminal-presentation',
  'legacy-workflow',
  'capacity',
] as const

export type ElectronSmokeScenario = (typeof ELECTRON_SMOKE_SCENARIOS)[number]

/** Keep direct `HVIR_SMOKE=1` invocations compatible with the legacy workflow. */
export function parseElectronSmokeScenario(
  value: string | undefined,
): ElectronSmokeScenario {
  if (value === undefined || value === '') return 'legacy-workflow'
  if (ELECTRON_SMOKE_SCENARIOS.includes(value as ElectronSmokeScenario)) {
    return value as ElectronSmokeScenario
  }
  throw new Error(
    `Unknown Electron smoke scenario '${value}'. Expected one of: ${ELECTRON_SMOKE_SCENARIOS.join(', ')}`,
  )
}
