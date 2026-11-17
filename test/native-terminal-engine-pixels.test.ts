import { buildSync } from 'esbuild'
import { once } from 'node:events'
import { Worker } from 'node:worker_threads'
import { describe, expect, it } from 'vitest'

// Execute the actual designated caller with a fake immediate N-API dependency.
// Real worker_threads performs every message clone/detachment below.
const bundle = buildSync({
  entryPoints: ['src/workers/native-terminal-engine.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['@hvir/native-terminal/engine'],
  write: false,
}).outputFiles[0]!.text
const source = `
const Module=require('node:module');
const {workerData,markAsUntransferable}=require('node:worker_threads');
const load=Module._load;
const source=Uint8Array.of(0,0,255,255,255,0,0,255,0,255,0,255,0,0,0,0);
let copied, generic, capacity;
Module._load=function(name,...args){
 if(name!=='@hvir/native-terminal/engine')return load.call(this,name,...args);
 return {
  open:()=>({result:0,host:{}}),
  copyFrame:(_host,_id,_lease,requested)=>{
   capacity=requested;
   if(workerData.mode==='refused')return {result:7};
   copied=workerData.mode==='pooled'?Buffer.from(source):
    new Uint8Array(workerData.mode==='shared'?new SharedArrayBuffer(16):new ArrayBuffer(workerData.mode==='short'?12:16));
   copied.set(source.subarray(0,copied.length));
   if(workerData.mode==='marked')markAsUntransferable(copied.buffer);
   return {result:0,data:copied,stride:workerData.mode==='stride'?4:8};
  },
  read:()=>{generic=new Uint8Array(new ArrayBuffer(4));generic.set([1,2,3,4]);return {result:0,data:generic};},
  inspect:()=>({result:0,status:{capacity,copiedLength:copied?.byteLength??null,
   genericLength:generic?.byteLength??null,source:[...source]}})
 };
};
${bundle}`
async function message(worker: Worker) {
  const values: unknown[] = await once(worker, 'message', {
    signal: AbortSignal.timeout(3000),
  })
  const value = values[0]
  return value as { id?: number; fatal?: boolean; kind?: string; value?: unknown }
}
async function launch(mode = 'owned') {
  const worker = new Worker(source, {
    eval: true,
    workerData: { library: '/fixed/library', mode },
  })
  try {
    expect(await message(worker)).toEqual({ kind: 'ready' })
    return worker
  } catch (error) {
    await worker.terminate()
    throw error
  }
}
async function request(worker: Worker, id: number, operation: string, args: unknown[]) {
  const result = message(worker)
  worker.postMessage({ id, operation, args })
  return result
}

describe('designated caller compatibility pixel transfer', () => {
  it('moves the actual owned normalized output and preserves source and generic result storage', async () => {
    const worker = await launch()
    try {
      const pixels = await request(worker, 1, 'pixels', ['7', '9', 2, 2, 2])
      expect(pixels).toEqual({
        id: 1,
        value: {
          result: 0,
          stride: 8,
          data: Uint8Array.of(0, 255, 0, 255, 0, 0, 0, 0, 255, 0, 0, 255, 0, 0, 255, 255),
        },
      })
      const inspected = await request(worker, 2, 'inspect', ['7'])
      expect(inspected).toMatchObject({
        value: {
          status: {
            capacity: 16,
            copiedLength: 0,
            source: [0, 0, 255, 255, 255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 0, 0],
          },
        },
      })
      expect(await request(worker, 3, 'read', ['7'])).toEqual({
        id: 3,
        value: { result: 0, data: Uint8Array.of(1, 2, 3, 4) },
      })
      expect(await request(worker, 4, 'inspect', ['7'])).toMatchObject({
        value: { status: { genericLength: 4 } },
      })
    } finally {
      await worker.terminate()
    }
  })
  it('keeps the original native refusal result and derives capacity from real large dimensions', async () => {
    const worker = await launch('refused')
    try {
      expect(await request(worker, 1, 'pixels', ['7', '9', 1, 5120, 2880])).toEqual({
        id: 1,
        value: { result: 7 },
      })
      expect(await request(worker, 2, 'inspect', ['7'])).toMatchObject({
        value: { status: { capacity: 58982400 } },
      })
    } finally {
      await worker.terminate()
    }
  })
  it.each(['pooled', 'marked', 'shared', 'short', 'stride'])(
    'does not publish or transfer %s storage as an owned exact image',
    async (mode) => {
      const worker = await launch(mode)
      try {
        const exit = once(worker, 'exit', { signal: AbortSignal.timeout(3000) })
        expect(await request(worker, 1, 'pixels', ['7', '9', 1, 2, 2])).toEqual({
          id: 1,
          fatal: true,
        })
        expect(await exit).toEqual([1])
      } finally {
        await worker.terminate()
      }
    },
  )
})
