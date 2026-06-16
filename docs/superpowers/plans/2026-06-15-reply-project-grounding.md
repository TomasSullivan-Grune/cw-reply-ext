# Reply Project Grounding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Inject cached, project-specific context (a curated summary plus recent room history) into the Reply bridge's prompt when a Chatwork room maps to a known project, so drafts are grounded in project facts; behaviour is unchanged for unmapped rooms.

**Architecture:** The extension sends the Chatwork `roomId` to the bridge. The bridge resolves `roomId → project slug` from the existing `internal-pm-tool/config/projects/*.json` files, loads a maintained `context/projects/<slug>.md` summary (mtime-cached), and appends recent room messages fetched via `cwcli` (TTL cache with stale-while-revalidate refresh). The assembled context is prepended to Claude's prompt. Every failure path degrades to the current ungrounded reply.

**Tech Stack:** Node.js (CommonJS) bridge, `cwcli` for Chatwork history, Node's built-in `node:test` + `node:assert` for tests (no new dependencies), a Chrome MV3 content script + background worker for the extension.

---

## File Structure

New files (under `cw-reply-ext/bridge/context/`):
- `resolve.js` — builds `roomId → slug` index from the project config dir; mtime-aware.
- `curated.js` — loads `projects/<slug>.md`; mtime-cached.
- `history.js` — recent-message parser + TTL cache with stale-while-revalidate; default `cwcli` fetcher.
- `index.js` — assembles the final context block; owns the unmapped flag.
- `projects/furusato-iwate.md` — first curated summary (example + real use).
- `resolve.test.js`, `curated.test.js`, `history.test.js`, `index.test.js` — unit tests.

Modified files:
- `bridge/server.js` — `buildPrompt` gains a `context` arg; `/reply` handler assembles context and returns `unmapped`.
- `bridge/package.json` — add a `test` script.
- `background.js` — thread `roomId` into the POST body and `unmapped` back out.
- `content.js` — extract `roomId` from `location.hash`; show a notice when `unmapped`.
- `reply.css` — style the notice.
- `.gitignore` — ignore `bridge/context/cache/`.

---

## Task 1: Room-to-project resolver

**Files:**
- Create: `cw-reply-ext/bridge/context/resolve.js`
- Test: `cw-reply-ext/bridge/context/resolve.test.js`
- Modify: `cw-reply-ext/bridge/package.json`

- [ ] **Step 1: Add the test script to package.json**

Replace the `scripts` block in `cw-reply-ext/bridge/package.json` so it reads:

```json
  "scripts": {
    "start": "node server.js",
    "test": "node --test"
  },
```

- [ ] **Step 2: Write the failing test**

Create `cw-reply-ext/bridge/context/resolve.test.js`:

```js
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
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd cw-reply-ext/bridge && node --test context/resolve.test.js`
Expected: FAIL — cannot find module `./resolve`.

- [ ] **Step 4: Write the implementation**

Create `cw-reply-ext/bridge/context/resolve.js`:

```js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_CONFIG_DIR =
  process.env.CW_REPLY_PROJECTS_CONFIG_DIR ||
  path.join(os.homedir(), 'grune-workspace', '30_internal_projects',
            'internal-pm-tool', 'config', 'projects');

function createResolver(opts) {
  const configDir = (opts && opts.configDir) || DEFAULT_CONFIG_DIR;
  let index = null;       // Map<roomId, slug>
  let signature = null;   // dir fingerprint the index was built from

  // Fingerprint = newest .json mtime + file count. Changes when any config is
  // edited, added, or removed, so the in-memory index re-builds on next use.
  function dirSignature() {
    let entries;
    try { entries = fs.readdirSync(configDir); }
    catch (e) { return null; }
    let newest = 0;
    let count = 0;
    for (const f of entries) {
      if (!f.endsWith('.json')) continue;
      count += 1;
      try {
        const st = fs.statSync(path.join(configDir, f));
        if (st.mtimeMs > newest) newest = st.mtimeMs;
      } catch (e) { /* ignore a file that vanished mid-scan */ }
    }
    return newest + ':' + count;
  }

  function build() {
    const map = new Map();
    let entries;
    try { entries = fs.readdirSync(configDir); }
    catch (e) { return map; }
    for (const f of entries) {
      if (!f.endsWith('.json')) continue;
      try {
        const cfg = JSON.parse(fs.readFileSync(path.join(configDir, f), 'utf8'));
        const rid = cfg && cfg.chatwork && cfg.chatwork.room_id;
        const slug = cfg && cfg.slug;
        if (rid && slug) map.set(String(rid), String(slug));
      } catch (e) { /* skip malformed config */ }
    }
    return map;
  }

  function resolve(roomId) {
    if (!roomId) return null;
    const sig = dirSignature();
    if (sig === null) return null;           // dir unreadable
    if (index === null || sig !== signature) { index = build(); signature = sig; }
    const slug = index.get(String(roomId));
    return slug ? { slug: slug } : null;
  }

  return { resolve: resolve };
}

module.exports = { createResolver: createResolver, DEFAULT_CONFIG_DIR: DEFAULT_CONFIG_DIR };
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd cw-reply-ext/bridge && node --test context/resolve.test.js`
Expected: PASS — 4 tests pass.

- [ ] **Step 6: Commit**

```bash
cd cw-reply-ext
git add bridge/package.json bridge/context/resolve.js bridge/context/resolve.test.js
git commit -m "Add room-to-project resolver for reply grounding"
```

---

## Task 2: Curated summary loader

**Files:**
- Create: `cw-reply-ext/bridge/context/curated.js`
- Test: `cw-reply-ext/bridge/context/curated.test.js`

- [ ] **Step 1: Write the failing test**

Create `cw-reply-ext/bridge/context/curated.test.js`:

```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd cw-reply-ext/bridge && node --test context/curated.test.js`
Expected: FAIL — cannot find module `./curated`.

- [ ] **Step 3: Write the implementation**

Create `cw-reply-ext/bridge/context/curated.js`:

```js
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_DIR = path.join(__dirname, 'projects');

function createCurated(opts) {
  const dir = (opts && opts.dir) || DEFAULT_DIR;
  const cache = new Map(); // slug -> { mtimeMs, text }

  function getCurated(slug) {
    if (!slug) return '';
    const file = path.join(dir, slug + '.md');
    let st;
    try { st = fs.statSync(file); }
    catch (e) { return ''; }            // no curated file for this project
    const hit = cache.get(slug);
    if (hit && hit.mtimeMs === st.mtimeMs) return hit.text;
    let text = '';
    try { text = fs.readFileSync(file, 'utf8').trim(); }
    catch (e) { return ''; }
    cache.set(slug, { mtimeMs: st.mtimeMs, text: text });
    return text;
  }

  return { getCurated: getCurated };
}

module.exports = { createCurated: createCurated, DEFAULT_DIR: DEFAULT_DIR };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd cw-reply-ext/bridge && node --test context/curated.test.js`
Expected: PASS — 4 tests pass.

- [ ] **Step 5: Commit**

```bash
cd cw-reply-ext
git add bridge/context/curated.js bridge/context/curated.test.js
git commit -m "Add curated project summary loader for reply grounding"
```

---

## Task 3: Recent-history cache

**Files:**
- Create: `cw-reply-ext/bridge/context/history.js`
- Test: `cw-reply-ext/bridge/context/history.test.js`

- [ ] **Step 1: Write the failing test**

Create `cw-reply-ext/bridge/context/history.test.js`:

```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd cw-reply-ext/bridge && node --test context/history.test.js`
Expected: FAIL — cannot find module `./history`.

- [ ] **Step 3: Write the implementation**

Create `cw-reply-ext/bridge/context/history.js`:

```js
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const DEFAULT_CACHE_DIR = path.join(__dirname, 'cache');
const DEFAULT_TTL_MS = Number(process.env.CW_REPLY_CONTEXT_TTL_MS) || 3600000; // 1h
const DEFAULT_COUNT = Number(process.env.CW_REPLY_HISTORY_COUNT) || 30;
const FETCH_TIMEOUT_MS = 8000;

function condenseBody(body) {
  return String(body).replace(/\s+/g, ' ').trim().slice(0, 300);
}

// Pure: raw `cwcli msgs --json` output -> ["Name: text", ...] for the last N.
function parseMessages(jsonText, count) {
  let arr;
  try { arr = JSON.parse(jsonText); } catch (e) { return []; }
  if (!Array.isArray(arr)) return [];
  return arr.slice(-count).map(function (m) {
    const name = (m && m.account && m.account.name) ? m.account.name : '(unknown)';
    return name + ': ' + condenseBody((m && m.body) || '');
  }).filter(function (line) { return line.replace(/^[^:]*:\s*/, '').length > 0; });
}

// Default fetcher: shells out to cwcli with a hard timeout; always resolves.
function defaultFetch(count) {
  return function (roomId) {
    return new Promise(function (resolve) {
      let out = '';
      const child = spawn('cwcli', ['msgs', String(roomId), '--force', '--json'],
        { stdio: ['ignore', 'pipe', 'pipe'] });
      const timer = setTimeout(function () { child.kill('SIGKILL'); resolve([]); }, FETCH_TIMEOUT_MS);
      child.stdout.on('data', function (d) { out += d; });
      child.on('error', function () { clearTimeout(timer); resolve([]); });
      child.on('close', function () { clearTimeout(timer); resolve(parseMessages(out, count)); });
    });
  };
}

function createHistory(opts) {
  opts = opts || {};
  const cacheDir = opts.cacheDir || DEFAULT_CACHE_DIR;
  const ttlMs = opts.ttlMs != null ? opts.ttlMs : DEFAULT_TTL_MS;
  const count = opts.count != null ? opts.count : DEFAULT_COUNT;
  const now = opts.now || Date.now;
  const fetchLines = opts.fetch || defaultFetch(count);

  function cacheFile(roomId) { return path.join(cacheDir, String(roomId) + '.json'); }

  function readCache(roomId) {
    try {
      const data = JSON.parse(fs.readFileSync(cacheFile(roomId), 'utf8'));
      if (data && Array.isArray(data.lines) && typeof data.fetchedAt === 'number') return data;
    } catch (e) { /* cache miss */ }
    return null;
  }

  function writeCache(roomId, lines) {
    try {
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(cacheFile(roomId), JSON.stringify({ fetchedAt: now(), lines: lines }));
    } catch (e) { /* best effort */ }
  }

  async function refresh(roomId) {
    try {
      const lines = await fetchLines(roomId);
      if (Array.isArray(lines)) { writeCache(roomId, lines); return lines; }
    } catch (e) { /* fall through */ }
    return [];
  }

  async function getRecent(roomId) {
    if (!roomId) return '';
    const cached = readCache(roomId);
    if (cached) {
      const fresh = (now() - cached.fetchedAt) < ttlMs;
      if (!fresh) { refresh(roomId); }      // stale-while-revalidate: don't await
      return cached.lines.join('\n');
    }
    const lines = await refresh(roomId);    // absent: bounded fetch, then serve
    return lines.join('\n');
  }

  return { getRecent: getRecent };
}

module.exports = {
  createHistory: createHistory,
  parseMessages: parseMessages,
  DEFAULT_CACHE_DIR: DEFAULT_CACHE_DIR,
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd cw-reply-ext/bridge && node --test context/history.test.js`
Expected: PASS — 8 tests pass.

- [ ] **Step 5: Commit**

```bash
cd cw-reply-ext
git add bridge/context/history.js bridge/context/history.test.js
git commit -m "Add recent-history cache (TTL + stale-while-revalidate) for reply grounding"
```

---

## Task 4: Context assembler and the first curated file

**Files:**
- Create: `cw-reply-ext/bridge/context/index.js`
- Create: `cw-reply-ext/bridge/context/projects/furusato-iwate.md`
- Test: `cw-reply-ext/bridge/context/index.test.js`

- [ ] **Step 1: Write the failing test**

Create `cw-reply-ext/bridge/context/index.test.js`:

```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd cw-reply-ext/bridge && node --test context/index.test.js`
Expected: FAIL — cannot find module `./index`.

- [ ] **Step 3: Write the implementation**

Create `cw-reply-ext/bridge/context/index.js`:

```js
'use strict';

const { createResolver } = require('./resolve');
const { createCurated } = require('./curated');
const { createHistory } = require('./history');

const HEADER = '[Project background — for context only; do not quote verbatim]';

function createContext(opts) {
  opts = opts || {};
  const resolver = opts.resolver || createResolver();
  const curated = opts.curated || createCurated();
  const history = opts.history || createHistory();

  async function assemble(roomId) {
    if (!roomId) return { context: '', unmapped: false };
    const hit = resolver.resolve(roomId);
    if (!hit) return { context: '', unmapped: true };

    const parts = [];
    const curatedText = curated.getCurated(hit.slug);
    if (curatedText) parts.push(curatedText);
    const recentText = await history.getRecent(roomId);
    if (recentText) parts.push('Recent conversation in this room:\n' + recentText);

    if (!parts.length) return { context: '', unmapped: false };
    return { context: HEADER + '\n' + parts.join('\n\n'), unmapped: false };
  }

  return { assemble: assemble };
}

module.exports = { createContext: createContext };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd cw-reply-ext/bridge && node --test context/index.test.js`
Expected: PASS — 5 tests pass.

- [ ] **Step 5: Create the first curated summary**

Create `cw-reply-ext/bridge/context/projects/furusato-iwate.md`:

```markdown
# Furusato Iwate (Labo)

## People & roles
- PM lead: Ludo
- PMs: Tomas Sullivan, Ludo
- Customer: Ekuna

## Status
Labo (ongoing retainer) project. Tomas handles labo work and new requirements.

## Glossary / proper nouns
- "Labo" — the ongoing monthly development retainer engagement.
- Furusato Iwate — the customer's furusato-nozei (hometown tax) system.

## Tone
Polite Japanese business register (敬語). Concise, factual, no over-promising on
dates or scope unless explicitly instructed.
```

- [ ] **Step 6: Run the full bridge test suite**

Run: `cd cw-reply-ext/bridge && node --test`
Expected: PASS — all tests across resolve/curated/history/index pass.

- [ ] **Step 7: Commit**

```bash
cd cw-reply-ext
git add bridge/context/index.js bridge/context/index.test.js bridge/context/projects/furusato-iwate.md
git commit -m "Add context assembler and furusato-iwate curated summary"
```

---

## Task 5: Wire context into the bridge prompt and handler

**Files:**
- Modify: `cw-reply-ext/bridge/server.js`

- [ ] **Step 1: Require the context module**

In `cw-reply-ext/bridge/server.js`, after the existing `const { spawn } = require('child_process');` line (line 23), add:

```js
const { createContext } = require('./context');
```

And after the `TIMEOUT_MS` constant (line 27), add:

```js
const projectContext = createContext();
```

- [ ] **Step 2: Replace buildPrompt to accept a context argument**

Replace the entire `buildPrompt` function (lines 29–72) with this version. It is identical to the original except for the new `context` parameter and the conditional block that inserts it — when `context` is empty the produced prompt is byte-for-byte unchanged:

```js
function buildPrompt(message, instructions, sender, recipients, context) {
  const recList = Array.isArray(recipients) ? recipients.filter(function (r) { return r && r.trim(); }) : [];
  const lines = [
    'You are drafting a reply to a workplace chat message on Chatwork. The',
    'conversation is most often Japanese business communication, but may be in',
    'any language.',
    '',
    'IMPORTANT — who is who:',
    '- The message below was WRITTEN AND SENT BY: ' + (sender && sender.trim() ? sender.trim() : '(unknown sender)') + '.',
    '  This is the person you are replying TO.',
    recList.length
      ? '- The sender addressed it TO these recipients: ' + recList.join(', ') + '. These' +
        '\n  names are recipients/mentions — NOT the author. Do not mistake them for the sender.'
      : '- Any [To:ID]Name, [返信 ...]Name, or [rp ...]Name tags INSIDE the message are' +
        '\n  people the sender was addressing (recipients/mentions). The name after such' +
        '\n  a tag is a RECIPIENT — it is NOT the sender.',
    '',
    'Write a reply to the message below, addressed to the sender, following the',
    'user’s instructions.',
    '',
    'Rules:',
    '- Output in the SAME language as the original message and instructions.',
    '  NEVER translate. If they are English, reply in English. If Japanese,',
    '  reply in Japanese. This is non-negotiable.',
    '- Keep a polite, professional business register appropriate to the original,',
    '  unless the instructions ask otherwise.',
    '- Preserve any Chatwork tags the reply needs exactly: [To:ID], [rp ...],',
    '  [qt]...[/qt], [info]...[/info], [title]...[/title], [code]...[/code], [hr].',
    '  Do NOT invent mention IDs that were not given to you.',
    '- Keep URLs, numbers, dates, and proper nouns verbatim.',
    '- Follow the user’s instructions closely. Do not add information, opinions,',
    '  or commitments they did not ask for.',
    '',
    'Output EXACTLY the reply text and nothing else — no preamble, no',
    'meta-commentary, no "this is a", no skill notices, no explanations, no code',
    'fences, no surrounding quotes.',
    '',
  ];

  if (context && context.trim()) {
    lines.push(
      context.trim(),
      'Use the project background above only to inform the reply — do not copy it',
      'verbatim and do not invent facts or commitments from it.',
      ''
    );
  }

  lines.push(
    'Message from ' + (sender && sender.trim() ? sender.trim() : 'the sender') + ':',
    message,
    '',
    'User’s instructions for the reply:',
    instructions
  );

  return lines.join('\n');
}
```

- [ ] **Step 3: Read roomId, assemble context, and return the unmapped flag**

In the `/reply` request handler, replace the block from `const instructions = (parsed.instructions || '').toString();` through the `res.end(JSON.stringify({ reply: reply }));` line (lines 145–154) with:

```js
      const instructions = (parsed.instructions || '').toString();
      const roomId = (parsed.roomId || '').toString();
      if (!instructions.trim()) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No reply instructions provided.' }));
        return;
      }
      let context = '';
      let unmapped = false;
      try {
        const assembled = await projectContext.assemble(roomId);
        context = assembled.context;
        unmapped = assembled.unmapped;
      } catch (e) {
        console.error('[reply] context error (ignored):', (e && e.message) || e);
      }
      console.log('[reply] from "' + sender + '" to [' + recipients.join(', ') + '], room ' + (roomId || '-') + ', msg ' + message.length + ' chars, instructions ' + instructions.length + ' chars, context ' + context.length + ' chars → running claude…');
      const reply = await runClaude(buildPrompt(message, instructions, sender, recipients, context));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ reply: reply, unmapped: unmapped }));
```

- [ ] **Step 4: Verify prompt-building behaves correctly with and without context**

`server.js` starts listening on import, so extract `buildPrompt` (it ends right before `function runClaude`) and exercise it in isolation:

```bash
cd cw-reply-ext/bridge && node -e "
const src = require('fs').readFileSync('server.js','utf8');
const body = src.match(/function buildPrompt[\s\S]*?(?=\nfunction runClaude)/)[0];
const buildPrompt = new Function(body + '\nreturn buildPrompt;')();
const noCtx = buildPrompt('MSG','INSTR','Alice',['Bob'],'');
const withCtx = buildPrompt('MSG','INSTR','Alice',['Bob'],'CTX');
console.log(noCtx.includes('Project background') || noCtx.includes('CTX') ? 'FAIL: context leaked' : 'OK: no-context prompt clean');
console.log(withCtx.includes('CTX') ? 'OK: context inserted' : 'FAIL: context missing');
"
```
Expected: `OK: no-context prompt clean` and `OK: context inserted`.

- [ ] **Step 5: Smoke-test the live endpoint (stop any running reply bridge first)**

```bash
# stop the currently-running reply bridge if any, then start the new one
lsof -tiTCP:8766 -sTCP:LISTEN | xargs -r kill
cd cw-reply-ext/bridge && (node server.js &) && sleep 1
curl -s -X POST http://localhost:8766/reply -H 'Content-Type: application/json' \
  -d '{"message":"テスト","sender":"Alice","recipients":[],"instructions":"短く了解と返信","roomId":"438334858"}' \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);console.log("reply len:",(o.reply||"").length,"unmapped:",o.unmapped)})'
```
Expected: a non-zero reply length and `unmapped: false`. Then test an unmapped room:
```bash
curl -s -X POST http://localhost:8766/reply -H 'Content-Type: application/json' \
  -d '{"message":"テスト","sender":"Alice","recipients":[],"instructions":"短く了解と返信","roomId":"1"}' \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);console.log("unmapped:",o.unmapped)})'
```
Expected: `unmapped: true`.

- [ ] **Step 6: Commit**

```bash
cd cw-reply-ext
git add bridge/server.js
git commit -m "Inject project context into reply prompt; return unmapped flag"
```

---

## Task 6: Thread roomId and unmapped through the background worker

**Files:**
- Modify: `cw-reply-ext/background.js`

- [ ] **Step 1: Add roomId to the POST body**

In `cw-reply-ext/background.js`, replace the `body:` line (line 16) with:

```js
    body: JSON.stringify({ message: msg.message || '', sender: msg.sender || '', recipients: msg.recipients || [], instructions: msg.instructions || '', roomId: msg.roomId || '' }),
```

- [ ] **Step 2: Pass the unmapped flag back to the content script**

In `cw-reply-ext/background.js`, replace the success `sendResponse` line (line 25) with:

```js
      sendResponse({ ok: true, reply: data.reply || '', unmapped: !!data.unmapped });
```

- [ ] **Step 3: Verify the file parses**

Run: `cd cw-reply-ext && node --check background.js && echo OK`
Expected: `OK`.

- [ ] **Step 4: Commit**

```bash
cd cw-reply-ext
git add background.js
git commit -m "Pass roomId to bridge and unmapped flag back to content script"
```

---

## Task 7: Send roomId from the page and show the unmapped notice

**Files:**
- Modify: `cw-reply-ext/content.js`
- Modify: `cw-reply-ext/reply.css`

- [ ] **Step 1: Add a getRoomId helper**

In `cw-reply-ext/content.js`, immediately before the `function buildModal()` declaration (line 89), add:

```js
  // Chatwork puts the open room in the URL hash, e.g. "#!rid438334858".
  function getRoomId() {
    const m = /#!rid(\d+)/.exec(location.hash || '');
    return m ? m[1] : '';
  }
```

- [ ] **Step 2: Add a notice element to the modal**

In `cw-reply-ext/content.js`, inside `buildModal`, add a notice line right after the opening `'<div class="cwr-body">'` (line 98). Change:

```js
        '<div class="cwr-body">' +
          '<div class="cwr-context">' +
```
to:
```js
        '<div class="cwr-body">' +
          '<div class="cwr-notice" style="display:none"></div>' +
          '<div class="cwr-context">' +
```

- [ ] **Step 3: Add a setNotice helper**

In `cw-reply-ext/content.js`, immediately after the `setStatus` function (ends line 161), add:

```js
  function setNotice(text) {
    const n = modalEl.querySelector('.cwr-notice');
    if (!text) { n.style.display = 'none'; n.textContent = ''; return; }
    n.style.display = 'block';
    n.textContent = text;
  }
```

- [ ] **Step 4: Send roomId and react to unmapped in runReply**

In `cw-reply-ext/content.js`, in `runReply`, replace the `chrome.runtime.sendMessage({ type: 'reply', ... })` call and its `.then` success body. Change the send line (line 186) to include `roomId` and clear any prior notice just before it:

Replace:
```js
    setStatus('Drafting…', true);

    chrome.runtime.sendMessage({ type: 'reply', message: currentMessage, sender: currentSender, recipients: currentRecipients, instructions: instructions })
      .then(function (resp) {
        if (!resp) { showError('No response from the extension background.'); return; }
        if (!resp.ok) { showError(resp.error, resp.notReachable); return; }
        overlay.querySelector('.cwr-draft').value = resp.reply || '';
```
with:
```js
    setStatus('Drafting…', true);
    setNotice('');

    chrome.runtime.sendMessage({ type: 'reply', message: currentMessage, sender: currentSender, recipients: currentRecipients, instructions: instructions, roomId: getRoomId() })
      .then(function (resp) {
        if (!resp) { showError('No response from the extension background.'); return; }
        if (!resp.ok) { showError(resp.error, resp.notReachable); return; }
        if (resp.unmapped) { setNotice('No project context for this room.'); }
        overlay.querySelector('.cwr-draft').value = resp.reply || '';
```

- [ ] **Step 5: Clear the notice when the modal opens**

In `cw-reply-ext/content.js`, inside `openModal`, just after `currentSender = (sender || '').trim();` (line 207), add:

```js
    setNotice('');
```

- [ ] **Step 6: Style the notice**

Append to `cw-reply-ext/reply.css`:

```css
.cwr-notice {
  margin: 0 0 8px;
  padding: 6px 10px;
  font-size: 12px;
  color: #8a6d3b;
  background: #fcf8e3;
  border: 1px solid #faebcc;
  border-radius: 4px;
}
```

- [ ] **Step 7: Verify content.js parses**

Run: `cd cw-reply-ext && node --check content.js && echo OK`
Expected: `OK`.

- [ ] **Step 8: Commit**

```bash
cd cw-reply-ext
git add content.js reply.css
git commit -m "Send roomId from page; show notice when room has no project context"
```

---

## Task 8: Ignore the cache directory and final verification

**Files:**
- Modify: `cw-reply-ext/.gitignore`

- [ ] **Step 1: Ignore the runtime cache**

Append to `cw-reply-ext/.gitignore`:

```
bridge/context/cache/
```

- [ ] **Step 2: Confirm the cache dir is untracked**

Run:
```bash
cd cw-reply-ext && git status --porcelain bridge/context/cache/ ; echo "exit: $?"
```
Expected: no output (the directory is ignored / empty).

- [ ] **Step 3: Run the entire bridge test suite once more**

Run: `cd cw-reply-ext/bridge && node --test`
Expected: PASS — all resolve/curated/history/index tests green.

- [ ] **Step 4: Manual end-to-end check in the browser**

1. Restart the reply bridge: `lsof -tiTCP:8766 -sTCP:LISTEN | xargs -r kill; cd cw-reply-ext/bridge && node server.js` (leave running).
2. Reload the unpacked extension in Chrome (`chrome://extensions` → reload `cw-reply-ext`).
3. Open the furusato-iwate Chatwork room (`#!rid438334858`), click the ↩ button on a message, enter an instruction, and Generate. Confirm a draft appears with **no** notice, and the bridge log shows `context > 0 chars`.
4. Open any unmapped room, repeat, and confirm the "No project context for this room." notice appears and a normal draft is still produced.

- [ ] **Step 5: Commit**

```bash
cd cw-reply-ext
git add .gitignore
git commit -m "Ignore reply grounding runtime cache directory"
```

---

## Self-Review Notes

- **Spec coverage:** resolver (Task 1) ↔ spec §1; curated loader (Task 2) ↔ §2; history cache (Task 3) ↔ §3; prompt assembly + handler (Task 5) ↔ §4–5; extension changes (Tasks 6–7) ↔ §6; config env vars honoured in resolve.js/history.js ↔ config table; gitignore + failure-path checks (Task 8) ↔ failure-modes section.
- **Env vars:** `CW_REPLY_CONTEXT_TTL_MS`, `CW_REPLY_HISTORY_COUNT`, `CW_REPLY_PROJECTS_CONFIG_DIR` are all read with the documented defaults.
- **Type consistency:** `createResolver().resolve → {slug}|null`, `createCurated().getCurated → string`, `createHistory().getRecent → Promise<string>`, `createContext().assemble → Promise<{context, unmapped}>` — used consistently across tasks and tests.
- **Privacy:** history is fetched only after a successful project mapping, so 1:1 DMs (never mapped) are never auto-read, satisfying the home `CLAUDE.md` DM rule.
