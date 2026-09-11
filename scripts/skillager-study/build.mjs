import process from 'node:process'
import console from 'node:console'
import { build } from 'vite'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
const root = fileURLToPath(new URL('.', import.meta.url))
const output = resolve(process.argv[2] || '/tmp/hvir-skillager-study')
const bundle = await build({
  configFile: false,
  envFile: false,
  publicDir: false,
  logLevel: 'error',
  build: {
    write: false,
    minify: false,
    lib: { entry: resolve(root, 'study.mjs'), formats: ['iife'], name: 'SkillagerStudy' },
  },
})
const outputs = Array.isArray(bundle) ? bundle : [bundle]
if (outputs.length !== 1 || !('output' in outputs[0]))
  throw new Error('Expected one study bundle')
const script = outputs[0].output.find((item) => item.type === 'chunk' && item.isEntry)
if (!script) throw new Error('Study entry chunk is missing')
const html = (await readFile(resolve(root, 'shell.html'), 'utf8'))
  .replace(
    '<!-- STYLE -->',
    `<style>${await readFile(resolve(root, 'study.css'), 'utf8')}</style>`,
  )
  .replace(
    '<!-- SCRIPT -->',
    `<script>${script.code.replaceAll('</script', '<\\/script')}</script>`,
  )
await mkdir(output, { recursive: true })
await writeFile(resolve(output, 'index.html'), html)
console.log(resolve(output, 'index.html'))
