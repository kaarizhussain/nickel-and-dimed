import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': 'http://localhost:3001' } },
  // PGlite ships its own WASM and data files; Vite's pre-bundler would break the
  // paths it loads them from.
  optimizeDeps: { exclude: ['@electric-sql/pglite'] },
});
