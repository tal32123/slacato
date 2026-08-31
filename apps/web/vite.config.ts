import { fileURLToPath, URL } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// E2E_API_PORT lets the Playwright config point this dev server's /api proxy at an API instance
// running on a non-default port (e.g. when :3000 is occupied by an unrelated local process),
// without changing anything for the normal `pnpm dev` workflow, which keeps targeting :3000.
const apiPort = process.env.E2E_API_PORT ?? '3000';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { proxy: { '/api': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: false } } },
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  appType: 'spa'
});
