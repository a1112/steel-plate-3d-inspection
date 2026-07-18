import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  cacheDir: '../../target/client/vite-cache',
  server: {
    host: '0.0.0.0',
    port: 1432,
    strictPort: true,
    allowedHosts: true,
  },
  preview: {
    host: '0.0.0.0',
    port: 1432,
    strictPort: true,
    allowedHosts: true,
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/test/setup.ts',
    exclude: ['**/._*', '**/node_modules/**', '**/dist/**', '**/target/**'],
  },
  build: {
    outDir: '../../target/client/frontend-dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/three') || id.includes('@react-three/fiber')) {
            return 'three-runtime';
          }
          if (id.includes('node_modules/recharts')) {
            return 'chart-runtime';
          }
          if (id.includes('@tauri-apps/api')) {
            return 'tauri-runtime';
          }
          if (id.includes('node_modules')) {
            return 'vendor';
          }
          return undefined;
        },
      },
    },
  },
});
