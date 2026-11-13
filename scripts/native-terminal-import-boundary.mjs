import { dirname, relative, resolve, sep } from 'node:path'

/** Native loading is confined to the actual caller-thread and OS-resource owners. */
export const nativeTerminalImportBoundary = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      owner:
        'Native terminal bindings are private to the dedicated engine caller and resource process edges; use the native terminal ports.',
    },
  },
  create(context) {
    const owner = resolve(context.filename).split(sep).join('/')
    const source = relative(context.cwd, owner).split(sep).join('/')
    if (!source.startsWith('src/')) return {}
    const inspect = (node, source) => {
      if (typeof source !== 'string') return
      const target = source.startsWith('.')
        ? resolve(dirname(owner), source).split(sep).join('/')
        : source
      const leaf = target.replace(/\.d(?=\.[cm]?ts$)/, '').replace(/\.[cm]?[jt]sx?$/, '')
      const engine =
        leaf === '@hvir/native-terminal/engine' ||
        leaf.endsWith('/packages/native-terminal/engine')
      const resource =
        leaf === '@hvir/native-terminal/resource' ||
        leaf.endsWith('/packages/native-terminal/resource')
      if (!engine && !resource && !target.includes('/packages/native-terminal/build/'))
        return
      const erased =
        node.importKind === 'type' ||
        node.type === 'TSImportType' ||
        (node.type === 'ImportDeclaration' &&
          node.specifiers.length > 0 &&
          node.specifiers.every((specifier) => specifier.importKind === 'type'))
      const allowed = engine
        ? owner.endsWith('/src/workers/native-terminal-engine.ts') ||
          (erased && owner.endsWith('/src/workers/native-terminal-runtime.ts'))
        : resource &&
          (owner.endsWith('/src/workers/native-terminal-runtime.ts') ||
            owner.endsWith('/src/main/terminal/native-terminal-process.ts') ||
            (erased && owner.endsWith('/src/main/terminal/native-terminal-import.ts')))
      if (!allowed) context.report({ node, messageId: 'owner' })
    }
    return {
      ImportDeclaration: (node) => inspect(node, node.source.value),
      ExportNamedDeclaration: (node) => inspect(node, node.source?.value),
      ExportAllDeclaration: (node) => inspect(node, node.source.value),
      ImportExpression: (node) => inspect(node, node.source.value),
      TSImportType: (node) =>
        inspect(node, node.source?.value ?? node.argument?.literal?.value),
      CallExpression: (node) => {
        if (node.callee.type === 'Identifier' && node.callee.name === 'require')
          inspect(node, node.arguments[0]?.value)
      },
    }
  },
}
