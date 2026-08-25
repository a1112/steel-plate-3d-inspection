import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  const serviceOrigin = env.VITE_INSPECTION_SERVICE_ORIGIN || 'http://127.0.0.1:4873';
  const serviceProxy = {
    target: serviceOrigin,
    changeOrigin: true,
    secure: false,
  };

  return {
    plugins: [react(), tailwindcss()],
    cacheDir: '../../target/client/vite-cache',
    server: {
      host: '0.0.0.0',
      port: 1432,
      strictPort: true,
      allowedHosts: true,
      proxy: {
        '/api': serviceProxy,
        '/internal': serviceProxy,
      },
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
          }
        },
      },
    },
  };
});
