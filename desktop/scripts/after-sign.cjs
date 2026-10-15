const { execFileSync } = require('node:child_process');
const { join } = require('node:path');
const { signAsync } = require('@electron/osx-sign');
const { signingConfig, matchesRequirement } = require('./signing-config.cjs');

exports.default = async context => {
  if (context.electronPlatformName !== 'darwin') return;
  const config = signingConfig();
  if (!config) return; // Ordinary checks use electron-builder's ad-hoc signature.
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  await signAsync({
    app,
    identity: config.identity,
    keychain: config.keychain,
    // A self-signed certificate is deliberately not added to the system trust store.
    identityValidation: false,
    preAutoEntitlements: false,
    // A timestamp only matters for notarization or an expired certificate, and costs one network call per file.
    optionsForFile: () => ({ hardenedRuntime: false, timestamp: 'none' }),
  });
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { stdio: 'pipe' });
  // Pin both the identifier and certificate; a valid but different signature is not enough.
  const result = require('node:child_process').spawnSync('/usr/bin/codesign', ['-d', '-r-', app], { encoding: 'utf8' });
  if (result.status !== 0 || !matchesRequirement(result.stdout, context.packager.appInfo.id, config.identity)) {
    throw new Error('署名後のアプリの識別情報が配布用の証明書と一致しません');
  }
  console.log('配布用の証明書で署名し、更新後も同じアプリとして認識されることを確認しました');
};
