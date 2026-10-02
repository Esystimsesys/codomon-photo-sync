import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: './tests', testMatch: 'ui.spec.ts', fullyParallel: true, use: { baseURL: 'http://localhost:4179', headless: true, viewport: {width: 1280, height: 900} }, webServer: { command: 'npm run dev -- --port 4179 --strictPort', url: 'http://localhost:4179', reuseExistingServer: !process.env.CI }, reporter: 'list' });
