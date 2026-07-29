import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  base: '/3d-experiments/',
  plugins: [react()],
  // rapier3d-compat resolves its .wasm file via `new URL(..., import.meta.url)`.
  // Vite's esbuild-based dep pre-bundling mangles that expression, so exclude it
  // and let the browser load it as native ESM instead.
  optimizeDeps: {
    exclude: ['@dimforge/rapier3d-compat'],
  },
})
