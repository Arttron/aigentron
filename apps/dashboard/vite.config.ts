import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    outDir: 'dist',
    commonjsOptions: {
      // @lds/shared is a pnpm workspace symlink resolving outside node_modules,
      // so Rollup's default node_modules-only CJS interop misses it, breaking
      // named imports from its CommonJS build output.
      include: [/node_modules/, /packages\/shared/],
    },
  },
  optimizeDeps: {
    // Same CJS-interop gap as above, but for dev: linked workspace packages are
    // skipped by esbuild's dependency pre-bundling unless listed explicitly.
    include: ['@lds/shared'],
  },
});
