'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createResolver } = require('./resolve');

function fixtureDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cwr-resolve-'));
  fs.writeFileSync(path.join(dir, 'furusato-iwate.json'),
    JSON.stringify({ slug: 'furusato-iwate', chatwork: { room_id: '438334858' } }));
  fs.writeFileSync(path.join(dir, 'no-room.json'),
    JSON.stringify({ slug: 'no-room', chatwork: { room_id: null } }));
  fs.writeFileSync(path.join(dir, 'broken.json'), '{ not valid json');
  return dir;
}

test('maps a known room_id to its slug', () => {
  const r = createResolver({ configDir: fixtureDir() });
  assert.deepStrictEqual(r.resolve('438334858'), { slug: 'furusato-iwate' });
});

test('returns null for unknown, blank, or null room ids', () => {
  const r = createResolver({ configDir: fixtureDir() });
  assert.strictEqual(r.resolve('999'), null);
  assert.strictEqual(r.resolve(''), null);
  assert.strictEqual(r.resolve(undefined), null);
});

test('returns null when the config dir is unreadable', () => {
  const r = createResolver({ configDir: '/no/such/dir/xyz' });
  assert.strictEqual(r.resolve('438334858'), null);
});

test('ignores malformed config files without throwing', () => {
  const r = createResolver({ configDir: fixtureDir() });
  assert.deepStrictEqual(r.resolve('438334858'), { slug: 'furusato-iwate' });
});
