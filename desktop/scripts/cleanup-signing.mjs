// Also runs with `always()` in CI, in case the packaging process was interrupted.
import { spawnSync } from 'node:child_process';
import { access, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

const root = process.env.RUNNER_TEMP;
if (!root || process.env.GITHUB_ACTIONS !== 'true') throw new Error('この後片付けはGitHub Actions専用です');
const keychain = join(root, 'omukae-release-signing.keychain-db');
let exists = false;
try { await access(keychain); exists = true; } catch { /* Already removed by package-signed. */ }
if (exists && spawnSync('/usr/bin/security', ['delete-keychain', keychain], { stdio: 'pipe' }).status !== 0) {
  throw new Error('署名用の一時キーチェーンを削除できませんでした');
}
for (const name of await readdir(root)) if (name.startsWith('omukae-signing-')) await rm(join(root, name), { recursive: true, force: true });
