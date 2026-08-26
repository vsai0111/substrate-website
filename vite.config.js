import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Static SPA build. Relative base keeps assets working from S3 subpaths,
// CloudFront origins, and `npx serve dist` alike.
export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: false,
    target: 'es2019',
    cssCodeSplit: false,
  },
  server: {
    port: 5173,
    open: false,
  },
})
