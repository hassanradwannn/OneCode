import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  root: resolve(__dirname, 'src/remote'),
  base: './',
  build: { outDir: resolve(__dirname, 'out/remote'), emptyOutDir: true, target: 'es2022' },
  esbuild: { jsx: 'automatic' }
});
