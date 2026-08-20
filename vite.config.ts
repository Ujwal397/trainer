import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  base: './',
  resolve: {
    alias: {
      '@core': r('./src/core'),
      '@render': r('./src/render'),
      '@ui': r('./src/ui'),
      '@storage': r('./src/storage'),
      '@input': r('./src/input'),
      '@data': r('./src/data'),
    },
  },
  build: { target: 'es2022', sourcemap: true },
});
