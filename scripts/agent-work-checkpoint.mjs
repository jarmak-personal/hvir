import { createServer } from 'vite'
import process from 'node:process'

const server = await createServer({
  appType: 'custom',
  configFile: false,
  server: { middlewareMode: true },
})

try {
  const runner = await server.ssrLoadModule('/scripts/agent-work-checkpoint-runner.mts')
  process.exitCode = await runner.runAgentWorkCheckpoint(process.argv.slice(2))
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'Agent-work checkpoint failed.'}\n`,
  )
  process.exitCode = 1
} finally {
  await server.close()
}
