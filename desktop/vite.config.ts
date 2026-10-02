import { defineConfig, loadEnv } from 'vite';
export default defineConfig(({ mode }) => {
  const host = loadEnv(mode, process.cwd(), 'CODOMON_').CODOMON_PREVIEW_HOST;
  return { base: './', build: { outDir: 'dist/renderer', emptyOutDir: false }, server: { host: 'localhost', allowedHosts: host ? [host] : [] } };
});
