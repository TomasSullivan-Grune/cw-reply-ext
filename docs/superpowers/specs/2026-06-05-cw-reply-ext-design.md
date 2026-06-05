# cw-reply-ext — Design

**Date:** 2026-06-05
**Status:** Approved

## Purpose

A Chrome extension (MV3) for Chatwork that lets the user draft a reply to any
message with Claude. It injects a small `↩` reply button under each message's
date/timestamp. Clicking it opens a modal where the user types reply
instructions; the original message plus the instructions are sent to a local
Claude bridge, which returns a draft reply. The user reviews the draft and
presses **Reflect** to append it to the current composer — without overwriting
whatever is already typed.

It reuses the proven patterns from the two sibling extensions
(`cw-preview-ext`, `chatwork-polish_extension`): MutationObserver-based
injection, Promise-style `chrome.runtime.sendMessage` (MV3 fix), a background
worker relay to `localhost` (private-network workaround), and a `claude -p`
bridge launched with `--system-prompt` + `stdio:['ignore','pipe','pipe']`.

## Components

### manifest.json
- MV3.
- Content script on `https://*.chatwork.com/*`, `run_at: document_idle`.
- `background.service_worker: background.js`.
- `host_permissions`: `http://localhost:8766/*`, `http://127.0.0.1:8766/*`.
- Loads `content.js` + `reply.css`.

### content.js
- **Injection:** MutationObserver (debounced 250ms) + 2s interval re-scan.
  For each `[data-testid="timeline_user-name"]`, walk up to the message
  container, locate the timestamp element and the `<pre>` message body, and
  insert a small `↩` icon button after the timestamp. Mark injected containers
  with a data attribute to prevent duplicates.
- **Read message:** read the `<pre>` `innerText` — raw Chatwork tags
  (`[To:]`, `[qt]`, etc.) preserved as useful context for Claude.
- **Modal:** shows the original message (read-only) + an instructions textarea
  + **Generate** button. After generation, shows the draft reply + **Reflect**
  and **Copy** buttons. All DOM/CSS prefixed `cwr-`. Stops Chatwork global key
  shortcuts from firing while typing (capture-phase `stopPropagation`, Escape
  closes).
- **Generate:** `chrome.runtime.sendMessage({type:'reply', message, instructions})`
  Promise-style; render `resp.reply` or error.
- **Reflect (append, never overwrite):** find composer via `findComposer`
  helper (reused). If composer has content, focus, move cursor to end, and
  `document.execCommand('insertText', false, '\n' + draft)` so React's state
  updates. If empty, insert the draft alone.

### background.js
- Relays `{type:'reply'}` messages to `http://localhost:8766/reply`.
- Returns `{ok:true, reply}` or `{ok:false, error, notReachable}`.
- `return true` to keep the channel open for async `sendResponse`.

### bridge/server.js
- HTTP server on port 8766. `GET /health`, `POST /reply`.
- `POST /reply` body: `{message, instructions}`.
- Runs `claude -p <prompt> --output-format json --system-prompt 'You are a
  helpful assistant.'` with `cwd: os.tmpdir()`, `stdio:['ignore','pipe','pipe']`,
  120s timeout. Parses `.result` from JSON output.
- Prompt: given a Chatwork message and the user's instructions, write a reply
  that follows the instructions; preserve Chatwork tags exactly; output in the
  same language as the instructions/message; never translate; output ONLY the
  reply text, no preamble/meta-commentary/code fences.
- CORS headers incl. `Access-Control-Allow-Private-Network: true`.

### reply.css
- `cwr-` prefixed styles for the trigger button + modal.

## Data Flow

`<pre>` message text + instructions → content.js → background.js →
bridge `/reply` → `claude -p` → draft reply → modal → Reflect → append to
composer (newline-separated).

## Error Handling

- Bridge unreachable → modal shows "Start the bridge: `cd bridge && node
  server.js`" (same UX as polish ext, `notReachable` flag).
- Empty instructions → inline validation, no request sent.
- `claude` not found (ENOENT) → install/login hint.

## Out of Scope (YAGNI)

- Hover-only buttons.
- Inserting at cursor position (append-at-end only, per decision).
- Rendering Chatwork tags in the modal (raw text is fine for context).
- Threading / multi-message context.
