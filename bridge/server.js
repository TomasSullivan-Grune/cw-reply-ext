#!/usr/bin/env node
/* Chatwork Reply — local bridge
 *
 * Listens on http://localhost:8766 and, for each request, runs Claude Code in
 * headless mode (`claude -p`) to draft a reply to the supplied Chatwork message
 * following the user's instructions. Auth is whatever Claude Code is already
 * configured with (your Max subscription, or an ANTHROPIC_API_KEY if set).
 * No credentials are handled here.
 *
 * Run:  node server.js
 * Stop: Ctrl-C
 *
 * Env vars:
 *   CW_REPLY_PORT    (default 8766)
 *   CW_REPLY_MODEL   (optional; passed to `claude --model`. Default: Claude Code's default)
 *   ANTHROPIC_API_KEY (optional; if set, Claude Code bills the API instead of your subscription)
 */

'use strict';

const http = require('http');
const os = require('os');
const { spawn } = require('child_process');

const PORT = Number(process.env.CW_REPLY_PORT) || 8766;
const MODEL = process.env.CW_REPLY_MODEL || '';
const TIMEOUT_MS = 120000;

function buildPrompt(message, instructions) {
  return [
    'You are drafting a reply to a workplace chat message on Chatwork. The',
    'conversation is most often Japanese business communication, but may be in',
    'any language.',
    '',
    'Write a reply to the message below, following the user’s instructions.',
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
    'Original message:',
    message,
    '',
    'User’s instructions for the reply:',
    instructions,
  ].join('\n');
}

function runClaude(prompt) {
  return new Promise((resolve, reject) => {
    const args = ['-p', prompt, '--output-format', 'json', '--system-prompt', 'You are a helpful assistant.'];
    if (MODEL) args.push('--model', MODEL);

    // Run in a temp dir so Claude Code doesn't pick up a project's CLAUDE.md.
    const child = spawn('claude', args, { cwd: os.tmpdir(), stdio: ['ignore', 'pipe', 'pipe'] });

    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Claude timed out after ' + (TIMEOUT_MS / 1000) + 's'));
    }, TIMEOUT_MS);

    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (!out && code !== 0) { reject(new Error(err.trim() || ('claude exited with code ' + code))); return; }
      // `--output-format json` returns a single object; the text is in `.result`.
      try {
        const data = JSON.parse(out);
        resolve(data.result != null ? String(data.result) : out.trim());
      } catch (e) {
        resolve(out.trim());
      }
    });
  });
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
}

const server = http.createServer((req, res) => {
  cors(res);

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method !== 'POST' || req.url !== '/reply') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }

  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 2e6) req.destroy(); });
  req.on('end', async () => {
    try {
      const parsed = JSON.parse(body || '{}');
      const message = (parsed.message || '').toString();
      const instructions = (parsed.instructions || '').toString();
      if (!instructions.trim()) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No reply instructions provided.' }));
        return;
      }
      console.log('[reply] msg ' + message.length + ' chars, instructions ' + instructions.length + ' chars → running claude…');
      const reply = await runClaude(buildPrompt(message, instructions));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ reply: reply }));
      console.log('[reply] done');
    } catch (e) {
      const msg = (e && e.message) || String(e);
      const enoent = /ENOENT/.test(msg);
      console.error('[reply] error:', msg);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: enoent
          ? "Couldn't find the 'claude' command. Install Claude Code (npm i -g @anthropic-ai/claude-code) and run `claude` once to log in."
          : msg,
      }));
    }
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('Chatwork Reply bridge listening on http://localhost:' + PORT);
  console.log('Using model: ' + (MODEL || 'Claude Code default'));
  console.log('Auth: ' + (process.env.ANTHROPIC_API_KEY ? 'ANTHROPIC_API_KEY (API billing)' : 'Claude Code login (subscription)'));
  console.log('Leave this running while you use the Reply button. Ctrl-C to stop.');
});
