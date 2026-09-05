import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import prettier from 'eslint-config-prettier'

// --- Seam enforcement (AGENTS.md "Respect the seams") ---------------------
//
// These import bans are how the architecture is enforced mechanically rather
// than by convention. Native/host primitives may only be touched inside the
// `LocalHost` module; `ipcRenderer` only inside the preload bridge; and
// `.spawnPty()` may only be *called* by the PTY supervisor.

/** node builtins + native modules — confined to the LocalHost implementation. */
const HOST_PRIMITIVE_BANS = [
  'fs',
  'node:fs',
  'fs/promises',
  'node:fs/promises',
  'child_process',
  'node:child_process',
  'chokidar',
  'node-pty',
].map((name) => ({
  name,
  message:
    'Host primitives (fs / child_process / chokidar / node-pty) belong only in ' +
    'src/main/project-host/local-host.ts. Go through the ProjectHost seam (ADR-010).',
}))

const DYNAMIC_HOST_IMPORT_BANS = HOST_PRIMITIVE_BANS.map(({ name, message }) => ({
  selector: `ImportExpression[source.value='${name}']`,
  message,
}))

/** `ipcRenderer` — confined to the preload bridge. */
const IPC_RENDERER_BAN = {
  name: 'electron',
  importNames: ['ipcRenderer'],
  message:
    'ipcRenderer may only be used in src/preload. The renderer talks to main ' +
    'through the typed bridge (window.hvir), never ipcRenderer directly.',
}

const SPAWN_PTY_BAN = {
  selector:
    "MemberExpression[property.name='spawnPty'], " +
    "MemberExpression[computed=true][property.value='spawnPty']",
  message:
    'Every PTY must be spawned through the PTY supervisor (ADR-006). Do not access ' +
    'host.spawnPty outside src/main/pty/pty-supervisor.ts.',
}

// Both erased and runtime contract dependencies point inward. The two barrels
// are compatibility/composition surfaces, never domain dependencies.
const SHARED_CONTRACT_IMPORT_BAN =
  '(^|/)(ipc|index|shared)(\\.[cm]?[jt]sx?)?$|(^|/)(main|preload|renderer|workers)(/|$)|^\\.\\.?$|^electron$'
const SHARED_CONTRACT_MESSAGE =
  'Shared capability contracts import named shared leaves, not the IPC aggregate, barrels, or process implementations.'
const SHARED_CONTRACT_EXPRESSION_SELECTOR = SHARED_CONTRACT_IMPORT_BAN.replaceAll(
  '/',
  '\\/',
)

const HARNESS_FACADE_IMPORT_BAN = '(^|/)(?<!shared/)harness-provider(\\.[cm]?[jt]sx?)?$'
const HARNESS_ASSEMBLY_IMPORT_BAN =
  '(^|/)(?<!shared/)(bundled-harness-providers|harness-provider)(\\.[cm]?[jt]sx?)?$'
const HARNESS_IMPLEMENTATION_IMPORT_BAN =
  HARNESS_ASSEMBLY_IMPORT_BAN + '|(^|/)providers(/|$)|(^|/)(claude|codex)-'
const HARNESS_DIRECTION_MESSAGE =
  'Harness contracts and neutral policy depend inward, never on bundled assembly, concrete providers, or their observation implementations.'

function harnessDirectionRules(pattern, message = HARNESS_DIRECTION_MESSAGE) {
  const selector = pattern.replaceAll('/', '\\/')
  return {
    'no-restricted-imports': [
      'error',
      {
        paths: [...HOST_PRIMITIVE_BANS, IPC_RENDERER_BAN],
        patterns: [{ regex: pattern, message }],
      },
    ],
    'no-restricted-syntax': [
      'error',
      SPAWN_PTY_BAN,
      ...DYNAMIC_HOST_IMPORT_BANS,
      {
        selector: `ImportExpression[source.value=/${selector}/], TSImportType[source.value=/${selector}/], CallExpression[callee.name='require'] > Literal.arguments[value=/${selector}/]`,
        message,
      },
    ],
  }
}

export default tseslint.config(
  { ignores: ['out/**', 'dist/**', 'node_modules/**', 'coverage/**'] },

  js.configs.recommended,

  // Type-aware linting for all TypeScript source.
  {
    files: ['**/*.{ts,tsx,mts}'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: [...HOST_PRIMITIVE_BANS, IPC_RENDERER_BAN] },
      ],
      'no-restricted-syntax': ['error', SPAWN_PTY_BAN, ...DYNAMIC_HOST_IMPORT_BANS],
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },

  {
    files: ['src/shared/**/*.{ts,tsx,mts,cts}'],
    ignores: ['src/shared/ipc.ts', 'src/shared/index.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [...HOST_PRIMITIVE_BANS],
          patterns: [
            { regex: SHARED_CONTRACT_IMPORT_BAN, message: SHARED_CONTRACT_MESSAGE },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        SPAWN_PTY_BAN,
        ...DYNAMIC_HOST_IMPORT_BANS,
        {
          selector: `ImportExpression[source.value=/${SHARED_CONTRACT_EXPRESSION_SELECTOR}/], TSImportType[source.value=/${SHARED_CONTRACT_EXPRESSION_SELECTOR}/], CallExpression[callee.name='require'] > Literal.arguments[value=/${SHARED_CONTRACT_EXPRESSION_SELECTOR}/]`,
          message: SHARED_CONTRACT_MESSAGE,
        },
      ],
    },
  },

  // The facade is for application compatibility, not an internal contract owner.
  {
    files: ['src/main/harness/**/*.{ts,tsx,mts,cts}'],
    ignores: ['src/main/harness/harness-provider.ts'],
    rules: harnessDirectionRules(HARNESS_FACADE_IMPORT_BAN),
  },
  {
    files: ['src/main/harness/providers/**/*.{ts,tsx,mts,cts}'],
    rules: harnessDirectionRules(HARNESS_ASSEMBLY_IMPORT_BAN),
  },
  {
    files: [
      'src/main/harness/harness-provider-contract.ts',
      'src/main/harness/harness-provider-registry.ts',
      'src/main/harness/harness-provider-capabilities.ts',
      'src/main/harness/harness-provider-probes.ts',
      'src/main/harness/harness-launch-selection.ts',
      'src/main/harness/harness-composer-contracts.ts',
      'src/main/harness/harness-text-validation.ts',
      'src/main/harness/harness-usage*.ts',
      'src/main/harness/agent-work-usage.ts',
      'src/main/harness/harness-telemetry*.ts',
      'src/main/harness/bounded-line-reader.ts',
    ],
    rules: harnessDirectionRules(HARNESS_IMPLEMENTATION_IMPORT_BAN),
  },

  // PTY internals depend on leaf contracts, never their facade or sibling owners.
  {
    files: ['src/main/pty/**/*.{ts,tsx,mts,cts}'],
    ignores: ['src/main/pty/pty-supervisor.ts'],
    rules: harnessDirectionRules(
      HARNESS_IMPLEMENTATION_IMPORT_BAN +
        '|(^|/)pty-supervisor(\\.[cm]?[jt]sx?)?$|(^|/)pty-(launch-admission|session-lifetime|session-observation|stream-attachment)(\\.[cm]?[jt]sx?)?$',
      'PTY internal owners import leaf contracts, never the supervisor, sibling owners, or concrete harness implementations.',
    ),
  },

  // Project state and workflows consume the host contract, never concrete host owners.
  {
    files: [
      'src/main/project-registry.ts',
      'src/main/project-coordinator.ts',
      'src/main/project-host/project-host.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            ...HOST_PRIMITIVE_BANS,
            IPC_RENDERER_BAN,
            {
              name: './project-host',
              message:
                'Import the ProjectHost contract directly, not concrete catalog exports.',
            },
          ],
          patterns: [
            {
              group: [
                '**/project-registry',
                '**/project-coordinator',
                '**/project-host/index',
                '**/project-host/ssh-*',
                '**/project-host/renderer-ssh-prompter',
                '**/project-host/project-host-catalog',
                '**/project-host/local-host',
                './ssh-*',
                './renderer-ssh-prompter',
                './project-host-catalog',
                './local-host',
              ],
              message:
                'Project state and workflows depend only on the ProjectHost contract and consumer-owned ports.',
            },
          ],
        },
      ],
    },
  },
  // Concrete catalogs implement host capabilities without project persistence/workflows.
  // The ProjectHost contract cannot depend on any concrete owner it describes.
  {
    files: ['src/main/project-host/project-host-catalog.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [...HOST_PRIMITIVE_BANS, IPC_RENDERER_BAN],
          patterns: [
            {
              group: ['**/project-registry', '**/project-coordinator'],
              message:
                'Host capabilities cannot depend on project persistence or project workflows.',
            },
          ],
        },
      ],
    },
  },

  // Renderer: React-specific rules.
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      ...harnessDirectionRules('(^|/)main/harness(/|$)'),
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },

  // Seam exemption: LocalHost owns the host primitives (but still not ipcRenderer).
  {
    files: ['src/main/project-host/local-host.ts'],
    rules: {
      'no-restricted-imports': ['error', { paths: [IPC_RENDERER_BAN] }],
      'no-restricted-syntax': ['error', SPAWN_PTY_BAN],
    },
  },

  // Seam exemption: the preload bridge owns ipcRenderer (but still not host primitives).
  {
    files: ['src/preload/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { paths: [...HOST_PRIMITIVE_BANS] }],
    },
  },

  // Seam exemption: only the supervisor may call host.spawnPty().
  {
    files: ['src/main/pty/pty-supervisor.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...DYNAMIC_HOST_IMPORT_BANS],
    },
  },

  // Tests may reach for node builtins directly to arrange fixtures — they are
  // not production seams.
  {
    files: ['test/**/*.ts'],
    rules: {
      'no-restricted-imports': 'off',
      'no-restricted-syntax': ['error', SPAWN_PTY_BAN],
    },
  },

  // Contributor process launchers may use Node host primitives directly; the
  // ProjectHost boundary governs application source under src/.
  {
    files: [
      'scripts/run-smoke-scenarios.mts',
      'scripts/architecture-hotspots.mts',
      'scripts/architecture-policy.mts',
      'scripts/architecture-inventory.mts',
      'scripts/architecture-authorization.mts',
      'scripts/architecture-github.mts',
      'scripts/architecture-wiring.mts',
      'scripts/run-smoke-interruption.mts',
      'scripts/smoke-failure-artifact.mts',
      'scripts/inspect-packaged-runtime.mts',
      'scripts/installed-startup-probe.mts',
      'scripts/real-host-ssh-contract.mts',
      'scripts/run-real-host-ssh-acceptance.mts',
      'scripts/require-release-ci-evidence.mts',
      'scripts/prepare-release-linux-package.mts',
      'scripts/validate-release-pr.mts',
      'scripts/generate-terminal-theme-catalog.mts',
      'scripts/check-terminal-runtime.mts',
      'scripts/agent-work-checkpoint-store.mts',
      'scripts/ghostty-web-update/candidate-bundle.mts',
      'scripts/ghostty-web-update/cli.mts',
      'scripts/ghostty-web-update/github-delivery.mts',
      'scripts/ghostty-web-update/github-release-source.mts',
      'scripts/ghostty-web-update/repository-candidate.mts',
      'scripts/project-management/native-issue-worktrees.ts',
    ],
    rules: {
      'no-restricted-imports': 'off',
    },
  },

  // Config / plain-JS files: no type-aware linting.
  {
    files: ['**/*.{js,mjs,cjs}'],
    extends: [tseslint.configs.disableTypeChecked],
  },

  prettier,
)
