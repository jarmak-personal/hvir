import { createServer } from 'vite'
import process from 'node:process'

const server = await createServer({
  appType: 'custom',
  configFile: false,
  server: { middlewareMode: true },
})

try {
  const runner = await server.ssrLoadModule('/scripts/prove-harness-usage-runner.mts')
  process.exitCode = await runner.runHarnessUsageProof(process.argv.slice(2))
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'Harness usage proof failed.'}\n`,
  )
  process.exitCode = 1
} finally {
  await server.close()
}
