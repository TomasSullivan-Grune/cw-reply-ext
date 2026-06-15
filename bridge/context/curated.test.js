'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCurated } = require('./curated');

function fixtureDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cwr-curated-'));
  fs.writeFileSync(path.join(dir, 'furusato-iwate.md'), '# Furusato\nPM: Ludo\n');
  return dir;
}

test('returns the file contents for an existing slug', () => {
  const c = createCurated({ dir: fixtureDir() });
  assert.strictEqual(c.getCurated('furusato-iwate'), '# Furusato\nPM: Ludo');
});

test('returns empty string when no curated file exists', () => {
  const c = createCurated({ dir: fixtureDir() });
  assert.strictEqual(c.getCurated('unknown-slug'), '');
});

test('returns empty string for a blank slug', () => {
  const c = createCurated({ dir: fixtureDir() });
  assert.strictEqual(c.getCurated(''), '');
});

test('reflects edits after the file mtime changes', () => {
  const dir = fixtureDir();
  const c = createCurated({ dir: dir });
  assert.strictEqual(c.getCurated('furusato-iwate'), '# Furusato\nPM: Ludo');
  const file = path.join(dir, 'furusato-iwate.md');
  const future = new Date(Date.now() + 10000);
  fs.writeFileSync(file, 'updated');
  fs.utimesSync(file, future, future);
  assert.strictEqual(c.getCurated('furusato-iwate'), 'updated');
});
