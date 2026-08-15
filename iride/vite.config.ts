import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    outDir: '../static',
    emptyOutDir: true,
    assetsDir: 'vite-assets'
  },
  server: {
    proxy: {
      '/api': 'http://localhost:8000',
      '/assets': 'http://localhost:8000'
    }
  }
});
