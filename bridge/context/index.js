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
