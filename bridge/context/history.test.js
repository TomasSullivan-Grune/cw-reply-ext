'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHistory, parseMessages } = require('./history');

function tmpCacheDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cwr-history-'));
}

const SAMPLE = JSON.stringify([
  { account: { name: 'Alice' }, body: 'first\nmessage' },
  { account: { name: 'Bob' }, body: '  spaced   out  ' },
  { account: {}, body: 'no name here' },
]);

test('parseMessages condenses JSON into "Name: text" lines', () => {
  const lines = parseMessages(SAMPLE, 30);
  assert.deepStrictEqual(lines, [
    'Alice: first message',
    'Bob: spaced out',
    '(unknown): no name here',
  ]);
});

test('parseMessages keeps only the last N messages', () => {
  const lines = parseMessages(SAMPLE, 1);
  assert.deepStrictEqual(lines, ['(unknown): no name here']);
});

test('parseMessages returns [] for non-array or invalid JSON', () => {
  assert.deepStrictEqual(parseMessages('not json', 30), []);
  assert.deepStrictEqual(parseMessages('{"a":1}', 30), []);
});

test('absent cache: fetches, writes the cache file, and serves the lines', async () => {
  const cacheDir = tmpCacheDir();
  const h = createHistory({
    cacheDir: cacheDir, ttlMs: 1000, now: () => 1000,
    fetch: async () => ['Alice: hi'],
  });
  const out = await h.getRecent('111');
  assert.strictEqual(out, 'Alice: hi');
  const saved = JSON.parse(fs.readFileSync(path.join(cacheDir, '111.json'), 'utf8'));
  assert.deepStrictEqual(saved.lines, ['Alice: hi']);
  assert.strictEqual(saved.fetchedAt, 1000);
});

test('fresh cache: serves the cache and does not fetch', async () => {
  const cacheDir = tmpCacheDir();
  fs.writeFileSync(path.join(cacheDir, '222.json'),
    JSON.stringify({ fetchedAt: 5000, lines: ['Cached: line'] }));
  let fetched = 0;
  const h = createHistory({
    cacheDir: cacheDir, ttlMs: 1000, now: () => 5500,
    fetch: async () => { fetched += 1; return ['New: line']; },
  });
  const out = await h.getRecent('222');
  assert.strictEqual(out, 'Cached: line');
  assert.strictEqual(fetched, 0);
});

test('stale cache: serves stale immediately and refreshes in the background', async () => {
  const cacheDir = tmpCacheDir();
  fs.writeFileSync(path.join(cacheDir, '333.json'),
    JSON.stringify({ fetchedAt: 1000, lines: ['Stale: line'] }));
  let fetched = 0;
  const h = createHistory({
    cacheDir: cacheDir, ttlMs: 1000, now: () => 9999,
    fetch: async () => { fetched += 1; return ['Fresh: line']; },
  });
  const out = await h.getRecent('333');
  assert.strictEqual(out, 'Stale: line');             // served immediately
  await new Promise((r) => setImmediate(r));          // let background refresh run
  assert.strictEqual(fetched, 1);                     // refresh was triggered
  const saved = JSON.parse(fs.readFileSync(path.join(cacheDir, '333.json'), 'utf8'));
  assert.deepStrictEqual(saved.lines, ['Fresh: line']);
});

test('a failing fetch on absent cache yields empty string, not a throw', async () => {
  const h = createHistory({
    cacheDir: tmpCacheDir(), ttlMs: 1000, now: () => 1,
    fetch: async () => { throw new Error('cwcli missing'); },
  });
  const out = await h.getRecent('444');
  assert.strictEqual(out, '');
});

test('blank room id returns empty string', async () => {
  const h = createHistory({ cacheDir: tmpCacheDir(), fetch: async () => ['x'] });
  assert.strictEqual(await h.getRecent(''), '');
});
