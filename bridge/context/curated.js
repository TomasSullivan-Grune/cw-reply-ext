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
