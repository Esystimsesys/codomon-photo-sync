import { readFileSync } from 'node:fs';
import { defineConfig, loadEnv } from 'vite';
export default defineConfig(({ mode }) => {
  const host = loadEnv(mode, process.cwd(), 'CODOMON_').CODOMON_PREVIEW_HOST;
  // ブラウザだけのデモ表示でも、配るアプリと同じバージョンを出す。
  const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };
  return { base: './', define: { __APP_VERSION__: JSON.stringify(version) }, build: { outDir: 'dist/renderer', emptyOutDir: false }, server: { host: 'localhost', allowedHosts: host ? [host] : [] } };
});
