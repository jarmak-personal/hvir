import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { buildSync } from 'esbuild'
import { expect, it } from 'vitest'

type Value = Record<string, unknown>
function load<T>(name: string): T {
  const bundle = buildSync({
    entryPoints: [`packages/skillager-extension/src/${name}.mjs`],
    bundle: true,
    format: 'iife',
    globalName: 'Module',
    write: false,
  })
  const sandbox = { TextEncoder, Module: undefined as unknown }
  runInNewContext(bundle.outputFiles[0]!.text, sandbox)
  return sandbox.Module as T
}
function status(mode = 'disabled') {
  const value = JSON.parse(
    readFileSync('test/fixtures/skillager-management/first-no-git-status.json', 'utf8'),
  ) as Value
  value['git'] = { mode }
  return value
}
function result(observed = status(), created = false) {
  return {
    schema: 'skillager.library-init.v1',
    status: created ? 'initialized' : 'already-initialized',
    created,
    errors: [],
    library: observed['library'],
    git: observed['git'],
  }
}
const argv = load<{ initializationArgs(input: unknown): string[] }>('management-argv')
const contract = load<{
  initializationResult(value: unknown, status: unknown, input: unknown): Value
}>('management-contract')

it('keeps unrelated operations and distinct custom targets available while fencing any unknown default target', () => {
  const module = load<{
    pendingManagement(): {
      observe(id: string, value: unknown): void
      assertAvailable(value: unknown): void
    }
  }>('management-pending')
  const owner = module.pendingManagement()
  owner.observe('default', {
    action: 'initialize-library',
    selection: { location: 'default' },
  })
  expect(() =>
    owner.assertAvailable({
      action: 'initialize-library',
      selection: {
        location: 'custom',
        root: { hostId: 'local', path: '/owned/other' },
        git: true,
      },
    }),
  ).toThrow(/Reconcile/)
  expect(() =>
    owner.assertAvailable({
      action: 'sync-library',
      library: { id: 'registered', root: { hostId: 'local', path: '/owned/registered' } },
    }),
  ).not.toThrow()
  owner.observe('default', undefined)
  owner.observe('custom', {
    action: 'initialize-library',
    selection: {
      location: 'custom',
      root: { hostId: 'local', path: '/owned/one' },
      git: false,
    },
  })
  expect(() =>
    owner.assertAvailable({
      action: 'initialize-library',
      selection: {
        location: 'custom',
        root: { hostId: 'local', path: '/owned/two' },
        git: true,
      },
    }),
  ).not.toThrow()
  expect(() =>
    owner.assertAvailable({
      action: 'initialize-library',
      selection: { location: 'default' },
    }),
  ).toThrow(/Reconcile/)
})

it('uses only public CLI defaults and retains explicit custom/no-Git argv', () => {
  expect(argv.initializationArgs({ location: 'default' })).toEqual([
    'library',
    'init',
    '--json',
  ])
  expect(
    argv.initializationArgs({
      location: 'custom',
      root: { hostId: 'local', path: '/owned/custom' },
      git: false,
    }),
  ).toEqual(['library', 'init', '--path', '/owned/custom', '--no-git', '--json'])
  for (const input of [
    {},
    { root: { hostId: 'local', path: '/owned/custom' }, git: true },
    { location: 'default', git: false },
    { location: 'default', root: { hostId: 'local', path: '/guessed/home' } },
    { location: 'custom', root: { hostId: 'ssh', path: '/remote' }, git: true },
    { location: 'custom', root: { hostId: 'local', path: 'relative' }, git: true },
    { location: 'custom', root: { hostId: 'local', path: '/owned' } },
  ])
    expect(() => argv.initializationArgs(input)).toThrow()
})

it.each(['system', 'disabled'])(
  'connects verified actual %s mode even when default intent encounters an existing registration',
  (mode) => {
    const observed = status(mode)
    expect(
      contract.initializationResult(result(observed), observed, { location: 'default' }),
    ).toMatchObject({ connect: true, created: false, observed: { gitMode: mode } })
  },
)

it('verifies fresh default creation without guessing its path, and preserves custom mismatch as an explicit connection choice', () => {
  const observed = status('system')
  expect(
    contract.initializationResult(result(observed, true), observed, {
      location: 'default',
    }),
  ).toMatchObject({ connect: true, created: true })
  expect(
    contract.initializationResult(result(observed), observed, {
      location: 'custom',
      root: { hostId: 'local', path: '/different' },
      git: false,
    }),
  ).toMatchObject({ connect: false, observed: { gitMode: 'system' } })
})

it.each(['library_id', 'root', 'mode', 'errors', 'created'])(
  'refuses inconsistent or incomplete public initialization %s',
  (field) => {
    const observed = status(),
      value = result(observed)
    if (field === 'mode') value.git = { mode: 'system' }
    else if (field === 'errors') value.errors = ['Git failed'] as never[]
    else if (field === 'created') delete (value as Value)['created']
    else value.library = { ...(value.library as Value), [field]: 'changed' }
    expect(() =>
      contract.initializationResult(value, observed, { location: 'default' }),
    ).toThrow(/could not be verified/)
  },
)

it('retains interrupted default intent, blocks overlapping initialization only, and reports current registration without claiming completion', async () => {
  const owner = load<{
    executeManagement(client: unknown, invocation: unknown): Promise<Value>
  }>('management-operation')
  const calls: string[][] = [],
    outputs = new Map<string, unknown>()
  let registered = true
  const client = {
    alive: true,
    request(capability: string, input: Value) {
      if (capability === 'connector.output')
        return Promise.resolve(
          input['release']
            ? null
            : {
                data:
                  input['stream'] === 'stderr'
                    ? ''
                    : JSON.stringify(outputs.get(String(input['receipt']))),
                nextOffset: null,
              },
        )
      const args = input['args'] as string[]
      calls.push(args)
      if (args.includes('init'))
        return Promise.resolve({
          outcome: 'interrupted',
          receipt: 'interrupted',
          truncated: false,
        })
      const receipt = String(calls.length)
      outputs.set(
        receipt,
        registered
          ? status()
          : { schema: 'skillager.library-status.v1', initialized: false },
      )
      return Promise.resolve({ outcome: 'completed', code: 0, receipt, truncated: false })
    },
  }
  const invoke = (id: string, action: string, input: Value) =>
    owner.executeManagement(client, { id, action, input, caller: 'guest', context: {} })
  expect(
    await invoke('original', 'initialize-library', { location: 'default' }),
  ).toMatchObject({ outcome: 'uncertain', operationId: 'original' })
  expect(calls).toEqual([['library', 'init', '--json']])
  expect(
    await invoke('repeat', 'initialize-library', {
      location: 'custom',
      root: { hostId: 'local', path: '/owned/other' },
      git: true,
    }),
  ).toMatchObject({ outcome: 'refused' })
  expect(calls).toHaveLength(1)
  const current = await invoke('observe', 'operation-state', {
    mode: 'observe',
    operationId: 'original',
  })
  expect(JSON.parse(String(current['observation']))).toMatchObject({
    target: 'unknown',
    originalCompletion: 'unknown',
    registered: { gitMode: 'disabled' },
  })
  expect(await invoke('list', 'operation-state', { mode: 'list' })).toEqual({
    ids: ['original'],
  })
  registered = false
  expect(
    await invoke('empty', 'operation-state', {
      mode: 'observe',
      operationId: 'original',
    }),
  ).toMatchObject({ outcome: 'refused' })
  expect(await invoke('list', 'operation-state', { mode: 'list' })).toEqual({
    ids: ['original'],
  })
})

it('does not retry initialization or fall back without Git after a native failure', async () => {
  const owner = load<{
    executeManagement(client: unknown, invocation: unknown): Promise<Value>
  }>('management-operation')
  const calls: string[][] = []
  const client = {
    alive: true,
    request(capability: string, input: Value) {
      if (capability === 'connector.output')
        return Promise.resolve(
          input['release']
            ? null
            : {
                data: input['stream'] === 'stderr' ? 'Git unavailable' : '{}',
                nextOffset: null,
              },
        )
      calls.push(input['args'] as string[])
      return Promise.resolve({
        outcome: 'completed',
        code: 1,
        receipt: 'failure',
        truncated: false,
      })
    },
  }
  expect(
    await owner.executeManagement(client, {
      id: 'failed',
      action: 'initialize-library',
      input: { location: 'default' },
      caller: 'guest',
      context: {},
    }),
  ).toMatchObject({ outcome: 'uncertain', operationId: 'failed' })
  expect(calls).toEqual([['library', 'init', '--json']])
})
