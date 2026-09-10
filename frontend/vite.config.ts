import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@e2mail/shared/pgp': path.resolve(rootDir, '../shared/src/pgp/index.ts'),
      '@e2mail/shared/i18n': path.resolve(rootDir, '../shared/src/i18n/index.ts'),
      '@e2mail/shared': path.resolve(rootDir, '../shared/src/index.ts'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
    },
  },
});
