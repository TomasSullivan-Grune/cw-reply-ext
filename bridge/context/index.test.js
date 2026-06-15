'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createContext } = require('./index');

function fakeResolver(map) {
  return { resolve: (id) => (map[id] ? { slug: map[id] } : null) };
}

test('blank room id: empty context, not unmapped', async () => {
  const ctx = createContext({
    resolver: fakeResolver({}), curated: { getCurated: () => '' },
    history: { getRecent: async () => '' },
  });
  assert.deepStrictEqual(await ctx.assemble(''), { context: '', unmapped: false });
});

test('unmapped room: empty context, unmapped true', async () => {
  const ctx = createContext({
    resolver: fakeResolver({}), curated: { getCurated: () => 'x' },
    history: { getRecent: async () => 'y' },
  });
  assert.deepStrictEqual(await ctx.assemble('999'), { context: '', unmapped: true });
});

test('mapped room: combines curated summary and recent history', async () => {
  const ctx = createContext({
    resolver: fakeResolver({ '438334858': 'furusato-iwate' }),
    curated: { getCurated: () => 'PM: Ludo' },
    history: { getRecent: async () => 'Alice: hi' },
  });
  const out = await ctx.assemble('438334858');
  assert.strictEqual(out.unmapped, false);
  assert.strictEqual(out.context,
    '[Project background — for context only; do not quote verbatim]\n' +
    'PM: Ludo\n\n' +
    'Recent conversation in this room:\nAlice: hi');
});

test('mapped room with no sources: empty context, not unmapped', async () => {
  const ctx = createContext({
    resolver: fakeResolver({ '438334858': 'furusato-iwate' }),
    curated: { getCurated: () => '' },
    history: { getRecent: async () => '' },
  });
  assert.deepStrictEqual(await ctx.assemble('438334858'), { context: '', unmapped: false });
});

test('mapped room, curated only: history section omitted', async () => {
  const ctx = createContext({
    resolver: fakeResolver({ '1': 'p' }),
    curated: { getCurated: () => 'PM: Ludo' },
    history: { getRecent: async () => '' },
  });
  const out = await ctx.assemble('1');
  assert.strictEqual(out.context,
    '[Project background — for context only; do not quote verbatim]\nPM: Ludo');
});
