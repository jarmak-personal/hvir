import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin, type UserConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

import { DEVELOPMENT_PERFORMANCE_FIXTURE_REQUEST_EVENT } from './src/renderer/src/development/development-performance-events'
import type { ApplicationBuildChannel } from './src/shared'

function excludeDevelopmentPerformanceFixtureFromProduction(): Plugin {
  return {
    name: 'exclude-development-performance-fixture-from-production',
    apply: 'build',
    generateBundle(_options, bundle): void {
      const retainedPolicy = Object.values(bundle).find(
        (output) =>
          output.type === 'chunk' &&
          output.code.includes(DEVELOPMENT_PERFORMANCE_FIXTURE_REQUEST_EVENT),
      )
      if (retainedPolicy) {
        this.error(
          `Production renderer chunk ${retainedPolicy.fileName} retained the development Performance Timeline fixture`,
        )
      }
    },
  }
}

function excludeSmokeRuntimeFromProduction(smokeBuild: boolean): Plugin {
  return {
    name: 'exclude-smoke-runtime-from-production',
    apply: 'build',
    generateBundle(_options, bundle): void {
      if (smokeBuild) return
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk') continue
        const smokeModule = Object.keys(output.modules).find((moduleId) =>
          moduleId.replaceAll('\\', '/').includes('/src/main/smoke/'),
        )
        if (smokeModule) {
          this.error(
            `Production main chunk ${output.fileName} retained smoke module ${smokeModule}`,
          )
        }
        if (output.code.includes('HVIR_SMOKE')) {
          this.error(
            `Production main chunk ${output.fileName} retained the HVIR_SMOKE activation path`,
          )
        }
      }
    },
  }
}

function excludeNativeProbeFromProduction(probeBuild: boolean): Plugin {
  return {
    name: 'exclude-native-terminal-probe-from-production',
    apply: 'build',
    generateBundle(_options, bundle): void {
      if (probeBuild) return
      for (const output of Object.values(bundle)) {
        if (
          output.type === 'chunk' &&
          Object.keys(output.modules).some((moduleId) =>
            moduleId
              .replaceAll('\\', '/')
              .match(
                /\/(native-terminal-probe\.ts|native-terminal\/electron-probe\.mts)$/,
              ),
          )
        )
          this.error(
            `Production chunk ${output.fileName} retained the native terminal fault probe`,
          )
      }
    },
  }
}

// Three build targets. `externalizeDepsPlugin` keeps `dependencies` (node-pty,
// chokidar) out of the main/preload bundles so native modules load from
// node_modules at runtime instead of being bundled.
const baseConfig: UserConfig = {
  main: {
    plugins: [externalizeDepsPlugin({ include: ['@hvir/native-terminal'] })],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          // Utility-process workers are built as sibling entries so the main
          // process can `utilityProcess.fork` their compiled output.
          'native-terminal-worker': resolve('src/workers/native-terminal-worker.ts'),
          'native-terminal-engine': resolve('src/workers/native-terminal-engine.ts'),
          'echo-worker': resolve('src/workers/echo-worker.ts'),
          'git-worker': resolve('src/workers/git-worker.ts'),
          'document-worker': resolve('src/workers/document-worker.ts'),
          'agent-cli': resolve('src/agent-cli/index.ts'),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ include: ['@hvir/native-terminal'] })],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/preload/index.ts'),
          'extension-guest': resolve('src/preload/extension-guest.ts'),
        },
      },
    },
  },
  renderer: {
    root: 'src/renderer',
    // These are loaded from module workers or other dynamic imports. Vite's
    // HTML crawl cannot discover them on a cold dev start, so without an
    // explicit list first use re-optimizes dependencies and reloads the whole
    // Electron renderer in the middle of a view-mode change.
    optimizeDeps: {
      include: [
        'markdown-it',
        'markdown-it-task-lists',
        'mermaid',
        'yaml',
        '@shikijs/langs',
        'shiki/core',
        'shiki/engine/javascript',
        'shiki/langs',
        '@shikijs/themes/dark-plus',
        '@shikijs/themes/github-light-default',
      ],
    },
    worker: {
      // Shiki's fine-grained language imports are split into worker chunks;
      // Rollup cannot represent that graph in the default IIFE worker format.
      format: 'es',
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          mermaid: resolve('src/renderer/mermaid.html'),
        },
      },
    },
    plugins: [react(), excludeDevelopmentPerformanceFixtureFromProduction()],
  },
}

export default defineConfig(({ mode }) => {
  const smokeBuild = mode === 'smoke'
  const nativeProbe = mode === 'native-terminal-probe'
  const buildChannel: ApplicationBuildChannel = smokeBuild
    ? 'smoke'
    : mode === 'ssh-acceptance'
      ? 'ssh-acceptance'
      : mode === 'development'
        ? 'development'
        : 'release'
  return {
    ...baseConfig,
    main: {
      ...baseConfig.main,
      build: {
        ...baseConfig.main?.build,
        rollupOptions: {
          ...baseConfig.main?.build?.rollupOptions,
          input: {
            ...(baseConfig.main?.build?.rollupOptions?.input as Record<string, string>),
            ...(nativeProbe
              ? {
                  'native-terminal-probe': resolve(
                    'scripts/native-terminal/electron-probe.mts',
                  ),
                }
              : {}),
          },
        },
      },
      plugins: [
        ...(baseConfig.main?.plugins ?? []),
        excludeSmokeRuntimeFromProduction(smokeBuild),
        excludeNativeProbeFromProduction(nativeProbe),
      ],
      define: {
        ...baseConfig.main?.define,
        __HVIR_SMOKE_BUILD__: JSON.stringify(smokeBuild),
        __HVIR_BUILD_CHANNEL__: JSON.stringify(buildChannel),
      },
    },
    preload: {
      ...baseConfig.preload,
      plugins: [
        ...(baseConfig.preload?.plugins ?? []),
        excludeNativeProbeFromProduction(nativeProbe),
      ],
      build: {
        ...baseConfig.preload?.build,
        rollupOptions: {
          ...baseConfig.preload?.build?.rollupOptions,
          input: {
            ...(baseConfig.preload?.build?.rollupOptions?.input as Record<
              string,
              string
            >),
            ...(nativeProbe
              ? {
                  'native-terminal-probe': resolve(
                    'src/preload/native-terminal-probe.ts',
                  ),
                }
              : {}),
          },
        },
      },
    },
  }
})
