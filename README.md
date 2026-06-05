# Chatwork Reply (Claude)

A Chrome extension that adds a small **↩ reply** button under each Chatwork
message. Click it, tell Claude how you want to reply, review the draft, and
press **Reflect** to append it to your message box — without overwriting what
you've already typed.

Drafting runs through a small local bridge that calls Claude Code on your
machine. No message content leaves your computer except through your own
Claude Code session.

## Setup

1. **Start the bridge** (keep it running while you use the button):
   ```bash
   cd bridge
   node server.js
   ```
   Requires Claude Code installed and logged in (`npm i -g @anthropic-ai/claude-code`, then run `claude` once).

2. **Load the extension** in Chrome:
   - Go to `chrome://extensions`
   - Enable **Developer mode**
   - **Load unpacked** → select this folder

3. Open Chatwork. A small `↩` appears under each message. Click it, type how
   you'd like to reply, **Generate**, then **Reflect**.

## How it works

```
message <pre> + your instructions
  → content.js → background worker → bridge (localhost:8766)
  → claude -p → draft reply → modal → Reflect → appended to composer
```

The bridge listens on port **8766** (the Polish extension uses 8765, so both
can run side by side).

### Bridge env vars

- `CW_REPLY_PORT` — default `8766`
- `CW_REPLY_MODEL` — passed to `claude --model` (default: Claude Code's default)
- `ANTHROPIC_API_KEY` — if set, bills the API instead of your subscription
