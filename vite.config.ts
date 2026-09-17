import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// This build is 100% client-side: there is no backend to talk to. Everything the
// simulation needs (game engine, database, LLM inference) either runs in the tab or
// talks directly to a provider you configure in Settings.
export default defineConfig({
  base: './',
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    // The app is served through a sandboxed preview host; allow any Host header.
    allowedHosts: true,
  },
  preview: {
    host: '0.0.0.0',
    port: 5173,
    allowedHosts: true,
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
  },
  optimizeDeps: {
    // transformers.js is loaded at runtime (CDN or local file), never bundled.
    exclude: ['@huggingface/transformers'],
  },
});
