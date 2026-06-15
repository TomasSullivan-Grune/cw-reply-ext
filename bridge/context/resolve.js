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
