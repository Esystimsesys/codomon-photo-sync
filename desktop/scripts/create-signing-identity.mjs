// Run once. Keep the encrypted PKCS#12 and password outside the repository and back them up offline.
import { mkdir, mkdtemp, readFile, writeFile, rm, access, realpath } from 'node:fs/promises';
import { randomBytes, X509Certificate } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join, resolve, dirname, relative, isAbsolute, sep, basename } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

process.umask(0o077);
const destination = resolve(process.argv[2] ?? join(homedir(), 'Library/Application Support/omukae-photo-signing'));
const publicCertificate = fileURLToPath(new URL('../build/signing-certificate.pem', import.meta.url));
const repository = fileURLToPath(new URL('../..', import.meta.url));
const withinRepository = path => { const p = relative(repository, path); return p !== '..' && !p.startsWith('..' + sep) && !isAbsolute(p); };
let temporary;
let created = false;
const exists = async p => { try { await access(p); return true; } catch { return false; } };
const run = args => {
  const result = spawnSync('/usr/bin/openssl', args, { encoding: 'utf8', stdio: 'pipe' });
  if (result.status !== 0) throw new Error('証明書の作成に失敗しました（秘密情報は出力しません）');
};
try {
  if (withinRepository(destination)) throw new Error('秘密鍵の保存先はリポジトリの外にしてください');
  if (await exists(destination) || await exists(publicCertificate)) {
    throw new Error('署名用の保存先または公開証明書が既にあります。証明書を作り直さず、既存の控えを使ってください');
  }
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  if (withinRepository(join(await realpath(dirname(destination)), basename(destination)))) throw new Error('秘密鍵の保存先はリポジトリの外にしてください');
  await mkdir(destination, { mode: 0o700 });
  created = true;
  temporary = await mkdtemp(join(destination, '.create-'));
  const passwordFile = join(destination, 'password.txt');
  await writeFile(passwordFile, randomBytes(32).toString('base64url') + '\n', { mode: 0o600, flag: 'wx' });
  const config = join(temporary, 'certificate.cnf');
  await writeFile(config, '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=Omukae Photo Release Signing\n[ext]\nbasicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=critical,codeSigning\n');
  const key = join(temporary, 'private.pem'), certificate = join(temporary, 'certificate.pem');
  run(['req', '-x509', '-newkey', 'rsa:3072', '-sha256', '-days', '7300', '-nodes', '-keyout', key, '-out', certificate, '-config', config]);
  run(['pkcs12', '-export', '-inkey', key, '-in', certificate, '-out', join(destination, 'identity.p12'), '-passout', `file:${passwordFile}`]);
  const pem = await readFile(certificate);
  const parsed = new X509Certificate(pem);
  const identity = parsed.fingerprint.replaceAll(':', '');
  await writeFile(join(destination, 'README.txt'), `おむかえフォトの配布用署名\n\nidentity.p12 は暗号化した証明書と秘密鍵です。password.txt がそのパスワードです。\n両方をパスワード管理アプリ等に控え、オフラインのバックアップも保管してください。\nリポジトリ・チャット・ビルド成果物に入れないでください。\n毎回この同じ証明書を使います。証明書を再作成すると、利用者に「写真」関係の許可がもう一度必要になります。\n\n証明書の指紋（公開情報）: ${identity}\n有効期限: ${parsed.validTo}\n`);
  await writeFile(publicCertificate, pem, { flag: 'wx', mode: 0o644 });
  console.log(`署名用の控えを保存しました: ${destination}`);
  console.log(`公開証明書を保存しました: ${publicCertificate}`);
} catch (error) {
  if (created) await rm(destination, { recursive: true, force: true });
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (temporary) await rm(temporary, { recursive: true, force: true });
}
