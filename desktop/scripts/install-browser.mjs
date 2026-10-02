import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
const result=spawnSync(process.execPath,['node_modules/playwright/cli.js','install','--no-shell','chromium'],{stdio:'inherit',env:{...process.env,PLAYWRIGHT_BROWSERS_PATH:resolve('browsers')}});
process.exit(result.status??1);
