import { existsSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import ts from 'typescript'

export const MODULE_EXTENSION = /\.[cm]?[jt]sx?$/
export const DECLARATION_EXTENSION = /\.d\.[cm]?ts$/
export const RESOLUTION_CONFIGS = [
  'tsconfig.base.json',
  'tsconfig.node.json',
  'tsconfig.web.json',
]

export type ImportForm =
  | 'import'
  | 'export'
  | 'import-type'
  | 'import-equals'
  | 'dynamic-import'
  | 'require'
  | 'worker'
  | 'module-runner'
  | 'utility-process'
  | 'discovery'
export interface ModuleReference {
  form: ImportForm
  specifier?: string
  line: number
  column: number
  erased: boolean
  names: string[]
}

/** The same AST collector is used on source and TypeScript's emitted JavaScript. */
export function moduleReferences(
  source: ts.SourceFile,
  compilerOptions?: ts.CompilerOptions,
): ModuleReference[] {
  const refs: ModuleReference[] = []
  const requireFactories = new Set<string>()
  const requireLoaders = new Set(['require'])
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteralLike(statement.moduleSpecifier) ||
      !['node:module', 'module'].includes(statement.moduleSpecifier.text)
    )
      continue
    const bindings = statement.importClause?.namedBindings
    if (bindings && ts.isNamedImports(bindings))
      for (const binding of bindings.elements) {
        if ((binding.propertyName ?? binding.name).text === 'createRequire')
          requireFactories.add(binding.name.text)
      }
  }
  const createsRequire = (node: ts.Node): node is ts.CallExpression =>
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    requireFactories.has(node.expression.text)
  function findLoaders(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      createsRequire(node.initializer)
    )
      requireLoaders.add(node.name.text)
    ts.forEachChild(node, findLoaders)
  }
  findLoaders(source)
  function add(
    node: ts.Node,
    form: ImportForm,
    value: ts.Node | undefined,
    erased = false,
    names: string[] = [],
  ) {
    const point = source.getLineAndCharacterOfPosition(node.getStart(source))
    refs.push({
      form,
      specifier: value && ts.isStringLiteralLike(value) ? value.text : undefined,
      line: point.line + 1,
      column: point.character + 1,
      erased,
      names,
    })
  }
  function walk(node: ts.Node): void {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause
      const bindings = clause?.namedBindings
      add(node, 'import', node.moduleSpecifier, clause?.isTypeOnly, [
        ...(clause?.name ? ['default'] : []),
        ...(bindings && ts.isNamedImports(bindings)
          ? bindings.elements.map((e) => (e.propertyName ?? e.name).text)
          : bindings
            ? ['*']
            : []),
      ])
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      add(
        node,
        'export',
        node.moduleSpecifier,
        node.isTypeOnly,
        node.exportClause && ts.isNamedExports(node.exportClause)
          ? node.exportClause.elements.map((e) => (e.propertyName ?? e.name).text)
          : ['*'],
      )
    } else if (ts.isImportTypeNode(node)) {
      add(
        node,
        'import-type',
        ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined,
        true,
        node.qualifier && ts.isIdentifier(node.qualifier) ? [node.qualifier.text] : ['*'],
      )
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      const erased =
        node.isTypeOnly ||
        (compilerOptions !== undefined &&
          moduleReferences(
            ts.createSourceFile(
              'import-equals.js',
              ts.transpileModule(node.getText(source), {
                fileName: source.fileName,
                compilerOptions: { ...compilerOptions, noEmit: false },
              }).outputText,
              ts.ScriptTarget.Latest,
              true,
            ),
          ).length === 0)
      add(node, 'import-equals', node.moduleReference.expression, erased, ['*'])
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword)
        add(node, 'dynamic-import', node.arguments[0], false, ['*'])
      else if (
        (ts.isIdentifier(node.expression) && requireLoaders.has(node.expression.text)) ||
        createsRequire(node.expression)
      )
        add(node, 'require', node.arguments[0], false, ['*'])
      else if (
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'ssrLoadModule'
      )
        add(node, 'module-runner', node.arguments[0])
      else if (
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.getText(source) === 'utilityProcess.fork'
      )
        add(node, 'utility-process', node.arguments[0])
      else if (
        ts.isPropertyAccessExpression(node.expression) &&
        ((node.expression.name.text === 'glob' &&
          node.expression.expression.getText(source) === 'import.meta') ||
          (node.expression.name.text === 'resolve' &&
            requireLoaders.has(node.expression.expression.getText(source))))
      ) {
        add(node, 'discovery', node.arguments[0])
      }
    } else if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      ['Worker', 'SharedWorker'].includes(node.expression.text)
    ) {
      const target = node.arguments?.[0]
      const url =
        target &&
        ts.isNewExpression(target) &&
        ts.isIdentifier(target.expression) &&
        target.expression.text === 'URL'
          ? target
          : undefined
      add(node, 'worker', url?.arguments?.[0] ?? target)
    }
    ts.forEachChild(node, walk)
  }
  walk(source)
  return refs
}

export function createModuleResolution(root: string) {
  root = realpathSync(root)
  const configs = new Map<string, ts.ParsedCommandLine>()
  for (const path of RESOLUTION_CONFIGS) {
    if (!existsSync(resolve(root, path)))
      throw new Error(`Missing required resolution input: ${path}`)
    const config = ts.getParsedCommandLineOfConfigFile(
      resolve(root, path),
      {},
      {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
          throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '))
        },
      },
    )
    const errors = config?.errors.filter((d) => d.code !== 18003) ?? []
    if (!config || errors.length)
      throw new Error(
        `Malformed resolution input: ${path}: ${errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' ')).join('; ')}`,
      )
    configs.set(path, config)
  }
  const caches = new Map<ts.CompilerOptions, ts.ModuleResolutionCache>()
  function options(path: string): ts.CompilerOptions {
    const config =
      path.startsWith('src/renderer/') || path.endsWith('.test.tsx')
        ? 'tsconfig.web.json'
        : configs.get('tsconfig.node.json')!.fileNames.includes(resolve(root, path))
          ? 'tsconfig.node.json'
          : 'tsconfig.base.json'
    return configs.get(config)!.options
  }
  function resolveReference(
    owner: string,
    specifier: string,
  ): { target?: string; external: boolean; local: boolean } {
    const compilerOptions = options(owner)
    let cache = caches.get(compilerOptions)
    if (!cache) {
      cache = ts.createModuleResolutionCache(root, (p) => p, compilerOptions)
      caches.set(compilerOptions, cache)
    }
    const found = ts.resolveModuleName(
      specifier,
      resolve(root, owner),
      compilerOptions,
      ts.sys,
      cache,
    ).resolvedModule
    const local =
      specifier.startsWith('.') ||
      isAbsolute(specifier) ||
      Object.keys(compilerOptions.paths ?? {}).some((pattern) => {
        const [prefix, suffix] = pattern.split('*')
        return suffix === undefined
          ? specifier === prefix
          : specifier.startsWith(prefix!) && specifier.endsWith(suffix)
      }) ||
      specifier.startsWith('#')
    if (!found) return { external: false, local }
    const target = relative(root, realpathSync(found.resolvedFileName)).replaceAll(
      '\\',
      '/',
    )
    return {
      target,
      external: target.includes('/node_modules/') || target.startsWith('node_modules/'),
      local,
    }
  }
  function runtimeCompanion(
    owner: string,
    specifier: string,
    target: string,
  ): string | undefined {
    if (!DECLARATION_EXTENSION.test(target)) return target
    // TypeScript can select release-changelog.d.mts for an actual release-changelog.mjs.
    // Resolve the implementation with the same aliases/options but without declarations.
    const host: ts.ModuleResolutionHost = {
      ...ts.sys,
      fileExists: (path) => !DECLARATION_EXTENSION.test(path) && ts.sys.fileExists(path),
    }
    const found = ts.resolveModuleName(
      specifier,
      resolve(root, owner),
      { ...options(owner), allowJs: true },
      host,
    ).resolvedModule
    if (found && !DECLARATION_EXTENSION.test(found.resolvedFileName))
      return relative(root, realpathSync(found.resolvedFileName)).replaceAll('\\', '/')
    return undefined
  }
  return {
    options,
    resolveReference,
    runtimeCompanion,
    asset: (owner: string, specifier: string) =>
      relative(root, resolve(root, dirname(owner), specifier)).replaceAll('\\', '/'),
  }
}
