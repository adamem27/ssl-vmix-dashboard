import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: `http://127.0.0.1:${process.env.PORT ?? 4310}`, changeOrigin: false },
      '/json': { target: `http://127.0.0.1:${process.env.PORT ?? 4310}`, changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist', emptyOutDir: true,
    // commentator.html: the commentator screen as a static page (exported to a folder and uploaded by the venue PC)
    rollupOptions: { input: { main: 'index.html', commentator: 'commentator.html' } },
  },
});
