import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    outDir: '../static',
    emptyOutDir: true,
    assetsDir: 'vite-assets',
    // LiteGraph is intentionally shipped as one large editor dependency.
    chunkSizeWarningLimit: 1200,
    rolldownOptions: {
      onLog(level, log, handler) {
        const isKnownLiteGraphEval = log.code === 'EVAL'
          && String(log.id || '').replaceAll('\\', '/').includes('/litegraph.js/');
        if (isKnownLiteGraphEval) return;
        handler(level, log);
      }
    }
  },
  server: {
    proxy: {
      '/api': 'http://localhost:8000',
      '/assets': 'http://localhost:8000'
    }
  }
});
