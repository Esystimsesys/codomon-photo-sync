import test from 'node:test';
import assert from 'node:assert/strict';
import { toSession, loginPageAllowed, onUploader } from '../src/main/session-cookies';

test('login window cookies become the storage state the uploader reuses', () => {
  const session = toSession([
    { name: 'sid', value: 'a', domain: '.mitene.us', path: '/', secure: true, httpOnly: true, session: false, expirationDate: 1800000000.5, sameSite: 'lax' },
    { name: 'host', value: 'b', domain: 'mitene.us', session: true, sameSite: 'unspecified' },
    { name: 'third', value: 'c', domain: '.google.com', path: '/recaptcha', secure: true, expirationDate: 1800000000, sameSite: 'no_restriction' },
    { name: 'broken', value: 'd' },
  ], [{ origin: 'https://mitene.us', localStorage: [{ name: 'k', value: 'v' }] }]);
  assert.deepEqual(session.cookies, [
    { name: 'sid', value: 'a', domain: '.mitene.us', path: '/', expires: 1800000000.5, httpOnly: true, secure: true, sameSite: 'Lax' },
    { name: 'host', value: 'b', domain: 'mitene.us', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' },
    { name: 'third', value: 'c', domain: '.google.com', path: '/recaptcha', expires: 1800000000, httpOnly: false, secure: true, sameSite: 'None' },
  ]);
  assert.deepEqual(session.origins, [{ origin: 'https://mitene.us', localStorage: [{ name: 'k', value: 'v' }] }]);
});

test('the login window stays on Mitene over HTTPS and recognizes the uploader', () => {
  assert.equal(loginPageAllowed('https://mitene.us/web/login'), true);
  assert.equal(loginPageAllowed('https://help.family-album.com/hc/ja'), true);
  assert.equal(loginPageAllowed('http://mitene.us/web/login'), false);
  assert.equal(loginPageAllowed('https://mitene.us.example.com/'), false);
  assert.equal(loginPageAllowed('https://evilmitene.us/'), false);
  assert.equal(loginPageAllowed('file:///etc/passwd'), false);
  assert.equal(onUploader('https://mitene.us/web/uploader'), true);
  assert.equal(onUploader('https://mitene.us/web/login?next=/web/uploader'), false);
});
