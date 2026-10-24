import { dirname, resolve, sep } from 'node:path'

/** Smoke depends on production seams; only the exact bootstrap adapter points back. */
export const smokeImportBoundary = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      tooling: 'Desktop smoke locks belong only to contributor tooling and tests.',
      inward: 'Smoke scenarios and fixtures must not import the smoke root.',
      production:
        'Production features must not import smoke code; only the explicit bootstrap adapter may launch it.',
    },
  },
  create(context) {
    const owner = resolve(context.filename).split(sep).join('/')
    const smokeDirectory = '/src/main/smoke'
    const inspect = (node, source) => {
      if (typeof source !== 'string') return
      if (source === 'proper-lockfile' || source === '@types/proper-lockfile') {
        context.report({ node, messageId: 'tooling' })
        return
      }
      if (!source.startsWith('.')) return
      const target = resolve(dirname(owner), source)
        .split(sep)
        .join('/')
        .replace(/\.[cm]?[jt]sx?$/, '')
      if (target.endsWith('/scripts/smoke-run-lock')) {
        context.report({ node, messageId: 'tooling' })
        return
      }
      const targetSmoke =
        target.endsWith(smokeDirectory) || target.includes(smokeDirectory + '/')
      if (!targetSmoke) return
      const ownerSmoke = owner.includes(smokeDirectory + '/')
      if (ownerSmoke) {
        const root =
          target.endsWith(smokeDirectory) || target.endsWith(smokeDirectory + '/index')
        if (root && !owner.endsWith(smokeDirectory + '/scenarios.ts')) {
          context.report({ node, messageId: 'inward' })
        }
      } else if (owner.includes('/src/')) {
        const bootstrap =
          owner.endsWith('/src/main/index.ts') &&
          target.endsWith(smokeDirectory + '/scenarios') &&
          node.type === 'ImportExpression'
        if (!bootstrap) context.report({ node, messageId: 'production' })
      }
    }
    return {
      ImportDeclaration: (node) => inspect(node, node.source.value),
      ExportNamedDeclaration: (node) => inspect(node, node.source?.value),
      ExportAllDeclaration: (node) => inspect(node, node.source.value),
      ImportExpression: (node) => inspect(node, node.source.value),
      TSImportType: (node) =>
        inspect(node, node.source?.value ?? node.argument?.literal?.value),
      CallExpression: (node) => {
        if (node.callee.type === 'Identifier' && node.callee.name === 'require') {
          inspect(node, node.arguments[0]?.value)
        }
      },
    }
  },
}
