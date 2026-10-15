import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import config from './signing-config.cjs';

const app = process.argv[2];
if (!app) throw new Error('検証する.appを指定してください');
const metadata = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
const verified = spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { stdio: 'pipe' });
const result = spawnSync('/usr/bin/codesign', ['-d', '-r-', app], { encoding: 'utf8' });
if (verified.status !== 0 || result.status !== 0 || !config.matchesRequirement(result.stdout, metadata.build.appId, config.identityOf(readFileSync(config.certificateFile)))) {
  throw new Error('配布アプリの署名または証明書が一致しません');
}
console.log('PASS 署名と配布用証明書の一致');
