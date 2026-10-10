import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rules } from '../scripts/secret-patterns.js';
const has = (name, value) => rules.some(([rule, regex]) => rule === name && [...value.matchAll(regex)].length > 0);
test('secret rules detect synthetic tokens, private keys, JSON credentials and credential URLs', () => {
  const random = crypto.randomUUID().replaceAll('-', '');
  assert.equal(has('npm-token', ['npm', '_', random].join('')), true);
  assert.equal(has('github-token', ['ghp', '_', random].join('')), true);
  assert.equal(has('private-key', ['-----BEGIN ', 'PRIVATE KEY-----'].join('')), true);
  assert.equal(has('literal-credential', JSON.stringify({ password: random })), true);
  assert.equal(has('url-credential', ['postgres://', 'synthetic:', random, '@localhost/fixture'].join('')), true);
  assert.equal(has('literal-credential', 'password = getPassword()'), false);
});
