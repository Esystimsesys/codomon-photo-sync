import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { signingConfig, matchesRequirement, identityOf, certificateFile } = require('../scripts/signing-config.cjs');
const identity = identityOf(readFileSync(certificateFile));

test('ordinary checks use ad-hoc signing, but an incomplete or wrong release identity fails closed', () => {
  assert.equal(signingConfig({}), null);
  assert.throws(() => signingConfig({ OMUKAE_REQUIRE_SIGNING: '1' }), /両方/);
  assert.throws(() => signingConfig({ OMUKAE_SIGN_IDENTITY: identity }), /両方/);
  assert.throws(() => signingConfig({ OMUKAE_SIGN_KEYCHAIN: '/tmp/test.keychain-db' }), /両方/);
  assert.throws(() => signingConfig({ OMUKAE_SIGN_IDENTITY: '0'.repeat(40), OMUKAE_SIGN_KEYCHAIN: '/tmp/test.keychain-db' }), /一致しません/);
  assert.deepEqual(signingConfig({ OMUKAE_SIGN_IDENTITY: identity.toLowerCase(), OMUKAE_SIGN_KEYCHAIN: '/tmp/test.keychain-db' }), { identity, keychain: '/tmp/test.keychain-db' });
});

test('release verification rejects ad-hoc and different app or certificate requirements', () => {
  const appId = 'io.github.esystimsesys.codomon-photo-sync';
  const requirement = `designated => identifier "${appId}" and certificate leaf = H"${identity.toLowerCase()}"`;
  assert.equal(matchesRequirement(`Executable=/tmp/Test.app\n${requirement}\n`, appId, identity), true);
  assert.equal(matchesRequirement(`# designated => cdhash H"${identity.toLowerCase()}"`, appId, identity), false);
  assert.equal(matchesRequirement(requirement, 'a.different.app', identity), false);
  assert.equal(matchesRequirement(requirement, appId, '0'.repeat(40)), false);
  assert.equal(matchesRequirement(`${requirement} or true`, appId, identity), false);
});

test('CI signing refuses PRs and branch builds before accessing any keychain, and refuses missing tag secrets', () => {
  for (const [event, ref] of [['pull_request', 'refs/pull/1/merge'], ['workflow_dispatch', 'refs/tags/v0.1.0'], ['push', 'refs/heads/main'], ['push', 'refs/tags/v0.1.0']]) {
    const result = spawnSync(process.execPath, ['scripts/package-signed.mjs', '--dir'], {
      encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: event, GITHUB_REF: ref, OMUKAE_SIGN_P12_BASE64: '', OMUKAE_SIGN_PASSWORD: '' },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, event === 'push' && ref.startsWith('refs/tags/') ? /シークレット/ : /vタグのpushだけ/);
  }
});
