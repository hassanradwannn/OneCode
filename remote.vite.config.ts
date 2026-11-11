import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { artifactRuntimePlugin } from './scripts/artifact-runtime-plugin.js';

export default defineConfig({
  plugins: [artifactRuntimePlugin()],
  root: resolve(__dirname, 'src/remote'),
  base: './',
  // Remote has an English interface today. Shared transcript formatters must not
  // pull the desktop's complete language catalogs into its first mobile load.
  resolve: { alias: [{ find: /^\.\/i18n\.js$/, replacement: resolve(__dirname, 'src/remote/i18n.ts') }] },
  // Keep bundled fonts on this origin; Remote's font policy excludes data URLs.
  build: { outDir: resolve(__dirname, 'out/remote'), emptyOutDir: true, target: 'es2022', assetsInlineLimit: 0 },
  esbuild: { jsx: 'automatic' }
});
