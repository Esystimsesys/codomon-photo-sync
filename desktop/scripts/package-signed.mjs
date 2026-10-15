import { readFile, writeFile, mkdtemp, rm, access } from 'node:fs/promises';
import { spawnSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import config from './signing-config.cjs';

process.umask(0o077);
const desktop = fileURLToPath(new URL('..', import.meta.url));
let temporary, keychain, createdKeychain = false;
let activeChild;
const secretEnv = { ...process.env };
const childEnv = { ...process.env };
// The build needs the imported signing identity, not the exported private key or its password.
for (const key of ['OMUKAE_SIGN_P12_BASE64', 'OMUKAE_SIGN_PASSWORD']) delete childEnv[key];
const quiet = (file, args, label) => {
  const result = spawnSync(file, args, { encoding: 'utf8', stdio: 'pipe', env: childEnv, timeout: 60_000 });
  // execFile errors include command arguments, which can include passwords. Never print them.
  if (result.status !== 0) throw new Error(`${label}に失敗しました（秘密情報は出力しません）`);
  return result.stdout;
};
const child = (file, args) => new Promise((resolveChild, rejectChild) => {
  activeChild = spawn(file, args, { cwd: desktop, env: childEnv, stdio: 'inherit' });
  activeChild.once('error', () => rejectChild(new Error('ビルドの起動に失敗しました')));
  activeChild.once('exit', code => { activeChild = undefined; code === 0 ? resolveChild() : rejectChild(new Error('署名付きビルドに失敗しました')); });
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => activeChild?.kill(signal));
try {
  if (process.platform !== 'darwin') throw new Error('署名付きビルドはmacOSで実行してください');
  if (process.argv.slice(2).some(arg => arg !== '--dir')) throw new Error('指定できる引数は --dir だけです');
  const ci = process.env.GITHUB_ACTIONS === 'true';
  if (ci && !(process.env.GITHUB_EVENT_NAME === 'push' && process.env.GITHUB_REF?.startsWith('refs/tags/v'))) {
    throw new Error('GitHub Actionsで署名できるのはvタグのpushだけです');
  }
  temporary = await mkdtemp(join(process.env.RUNNER_TEMP ?? tmpdir(), 'omukae-signing-'));
  keychain = join(ci ? (process.env.RUNNER_TEMP ?? tmpdir()) : temporary, 'omukae-release-signing.keychain-db');
  const p12 = join(temporary, 'identity.p12'), passwordFile = join(temporary, 'password.txt');
  let password;
  if (ci) {
    if (!secretEnv.OMUKAE_SIGN_P12_BASE64 || !secretEnv.OMUKAE_SIGN_PASSWORD) throw new Error('release環境に署名用の2つのシークレットを登録してください');
    await writeFile(p12, Buffer.from(secretEnv.OMUKAE_SIGN_P12_BASE64, 'base64'), { mode: 0o600 });
    password = secretEnv.OMUKAE_SIGN_PASSWORD.trimEnd();
  } else {
    const local = resolve(process.env.OMUKAE_SIGNING_DIR ?? join(homedir(), 'Library/Application Support/omukae-photo-signing'));
    await writeFile(p12, await readFile(join(local, 'identity.p12')), { mode: 0o600 });
    password = (await readFile(join(local, 'password.txt'), 'utf8')).trimEnd();
  }
  await writeFile(passwordFile, password, { mode: 0o600 });
  const pem = quiet('/usr/bin/openssl', ['pkcs12', '-in', p12, '-clcerts', '-nokeys', '-passin', `file:${passwordFile}`], '証明書の読み取り');
  const identity = config.identityOf(pem);
  config.signingConfig({ OMUKAE_REQUIRE_SIGNING: '1', OMUKAE_SIGN_IDENTITY: identity, OMUKAE_SIGN_KEYCHAIN: keychain });
  const keychainPassword = randomBytes(32).toString('base64url');
  quiet('/usr/bin/security', ['create-keychain', '-p', keychainPassword, keychain], '一時キーチェーンの作成');
  createdKeychain = true;
  quiet('/usr/bin/security', ['unlock-keychain', '-p', keychainPassword, keychain], '一時キーチェーンの解除');
  quiet('/usr/bin/security', ['set-keychain-settings', '-t', '3600', keychain], '一時キーチェーンの設定');
  quiet('/usr/bin/security', ['import', p12, '-k', keychain, '-P', password, '-T', '/usr/bin/codesign'], '署名用証明書の読み込み');
  quiet('/usr/bin/security', ['set-key-partition-list', '-S', 'apple-tool:,codesign:', '-s', '-k', keychainPassword, keychain], '署名用のアクセス設定');
  // Remove the exported key before dependency/build code is executed.
  await rm(p12); await rm(passwordFile);
  delete secretEnv.OMUKAE_SIGN_P12_BASE64; delete secretEnv.OMUKAE_SIGN_PASSWORD;
  Object.assign(childEnv, { OMUKAE_REQUIRE_SIGNING: '1', OMUKAE_SIGN_IDENTITY: identity, OMUKAE_SIGN_KEYCHAIN: keychain });
  await child('npm', ['run', process.argv.includes('--dir') ? 'package:dir' : 'package:mac']);
} catch (error) {
  // Do not dump child-process errors or secret-bearing environment variables.
  console.error(error.code === 'ENOENT' ? '署名用の控えが見つかりません。新しい証明書を作らず、既存の控えを復元してください' : error.message);
  process.exitCode = 1;
} finally {
  if (createdKeychain) {
    const result = spawnSync('/usr/bin/security', ['delete-keychain', keychain], { stdio: 'pipe' });
    if (result.status !== 0) { console.error('一時キーチェーンを削除できませんでした'); process.exitCode = 1; }
  }
  if (temporary) await rm(temporary, { recursive: true, force: true });
}
