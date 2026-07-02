import path from 'node:path'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const absTarget = env.ABS_SERVER_URL ?? 'http://localhost:13378'

  return {
    plugins: [react(), tailwindcss()],
    optimizeDeps: {
      // epub.js ships CommonJS deps (jszip, @xmldom/xmldom) whose named exports
      // only resolve when Vite pre-bundles the whole tree together.
      include: ['epubjs', 'jszip', '@xmldom/xmldom'],
    },
    resolve: {
      // Pin a single React copy so the dep optimizer can't split it across two
      // pre-bundles (which surfaces as "invalid hook call" at runtime).
      dedupe: ['react', 'react-dom'],
      alias: {
        '@': path.resolve(__dirname, './src'),
        '@hearthshelf/core': path.resolve(__dirname, 'packages/core/src'),
      },
    },
    server: {
      // Honor a PORT env when set (e.g. a preview harness assigning a free port),
      // otherwise Vite's default with its own fallback climb applies.
      port: process.env.PORT ? Number(process.env.PORT) : undefined,
      proxy: {
        // Mirror the production nginx proxy: /abs-api/* maps to the ABS origin
        // root. ABS auth routes live at the root (/login, /api/authorize), so we
        // strip only the /abs-api prefix and forward the rest verbatim.
        '/abs-api': {
          target: absTarget,
          changeOrigin: true,
          secure: false,
          rewrite: (p) => p.replace(/^\/abs-api/, ''),
        },
        '/abs-socket': {
          target: absTarget,
          changeOrigin: true,
          secure: false,
          ws: true,
          rewrite: (p) => p.replace(/^\/abs-socket/, ''),
        },
        // HearthShelf backend (run `node server/index.js` locally on :8080).
        // Mirrors the production nginx /hs/ proxy.
        '/hs': {
          target: env.QG_TARGET ?? 'http://localhost:8080',
          changeOrigin: true,
          secure: false,
        },
      },
    },
  }
})
