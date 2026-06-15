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
