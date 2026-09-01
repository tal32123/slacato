import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

// E2E_API_PORT lets the Playwright config point this dev server's /api proxy at an API instance
// running on a non-default port (e.g. when :3000 is occupied by an unrelated local process),
// without changing anything for the normal `pnpm dev` workflow, which keeps targeting :3000.
const apiPort = process.env.E2E_API_PORT ?? '3000';

// Documents that are graded deliverables in their own right, also reachable from the running app.
// They are read from where they actually live rather than copied into public/: a committed copy is
// a second original that drifts the moment someone edits one, and the served copy is the one a
// reader opens. The keys are the served paths - `samples/slack-impact.html` matters because the
// overview's only link to it is relative (`../samples/slack-impact.html`), which has to resolve both
// from docs/ on disk and from the served copy at the web root.
const SERVED_DOCUMENTS: Readonly<Record<string, string>> = {
  'technical-overview.html': '../../docs/technical-overview.html',
  'samples/slack-impact.html': '../../samples/slack-impact.html'
};

/** Serves the repository's own documents in dev and emits them into the production build. */
function servedDocuments(): Plugin {
  const read = (relative: string): string =>
    readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
  return {
    name: 'slacato-served-documents',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = (request.url ?? '').split('?')[0]?.replace(/^\//, '') ?? '';
        const source = SERVED_DOCUMENTS[path];
        if (source === undefined) return next();
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.end(read(source));
      });
    },
    generateBundle() {
      for (const [fileName, source] of Object.entries(SERVED_DOCUMENTS))
        this.emitFile({ type: 'asset', fileName, source: read(source) });
    }
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), servedDocuments()],
  server: { proxy: { '/api': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: false } } },
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  appType: 'spa'
});
