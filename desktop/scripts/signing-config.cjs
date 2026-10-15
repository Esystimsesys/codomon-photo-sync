const { readFileSync } = require('node:fs');
const { X509Certificate } = require('node:crypto');
const { resolve } = require('node:path');

const certificateFile = resolve(__dirname, '../build/signing-certificate.pem');
const identityOf = certificate => new X509Certificate(certificate).fingerprint.replaceAll(':', '').toUpperCase();

// A partially configured release must never fall back to ad-hoc signing.
function signingConfig(env = process.env, expectedIdentity) {
  const identity = env.OMUKAE_SIGN_IDENTITY;
  const keychain = env.OMUKAE_SIGN_KEYCHAIN;
  if (!identity && !keychain && env.OMUKAE_REQUIRE_SIGNING !== '1') return null;
  if (!identity || !keychain || !/^[A-Fa-f0-9]{40}$/.test(identity)) {
    throw new Error('署名には証明書の指紋と専用キーチェーンの両方が必要です');
  }
  const expected = expectedIdentity ?? identityOf(readFileSync(certificateFile));
  if (identity.toUpperCase() !== expected.toUpperCase()) {
    throw new Error('配布用の証明書と一致しません。別の証明書では更新時の許可が引き継がれません');
  }
  return { identity: identity.toUpperCase(), keychain };
}

function matchesRequirement(output, appId, identity) {
  const requirement = output.split('\n').find(line => line.startsWith('designated => '));
  return requirement === `designated => identifier "${appId}" and certificate leaf = H"${identity.toLowerCase()}"`;
}

module.exports = { certificateFile, identityOf, signingConfig, matchesRequirement };
