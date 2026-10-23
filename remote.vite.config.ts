import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  root: resolve(__dirname, 'src/remote'),
  base: './',
  // Remote has an English interface today. Shared transcript formatters must not
  // pull the desktop's complete language catalogs into its first mobile load.
  resolve: { alias: [{ find: /^\.\/i18n\.js$/, replacement: resolve(__dirname, 'src/remote/i18n.ts') }] },
  build: { outDir: resolve(__dirname, 'out/remote'), emptyOutDir: true, target: 'es2022' },
  esbuild: { jsx: 'automatic' }
});
