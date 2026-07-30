import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    ssr: 'scripts/run-real-host-ssh-acceptance.mts',
    target: 'node24',
    outDir: 'out/real-host-ssh',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        format: 'cjs',
        entryFileNames: 'real-host-ssh-acceptance.cjs',
      },
    },
  },
})
