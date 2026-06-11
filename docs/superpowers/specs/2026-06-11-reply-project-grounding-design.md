# Reply project grounding — design

**Date:** 2026-06-11
**Status:** Approved for planning
**Component:** `cw-reply-ext` (Chatwork Reply extension + local bridge)

## Problem

The Reply bridge drafts replies from the message, sender, recipients, and the
user's instructions alone. It has no awareness of which project a chat belongs
to, so it cannot ground a reply in project facts (people, status, terminology,
prior conversation). Fetching that context on every reply would be too slow.

## Goal

When a reply is drafted in a chat that maps to a known project, inject a cached
project-context block into Claude's prompt so the draft is grounded in project
facts. When no mapping exists, behaviour is unchanged.

## Approach (agreed)

- **Context = curated per-project summary + recent room history.**
- **Cache = TTL with on-demand refresh** (serve cached, refresh in the
  background when stale; stale-while-revalidate). No external scheduler.
- **Unmapped rooms** behave exactly as today, with a notice shown in the modal.
- **Curated summary** is stored bridge-local (option a, confirmed).
- **Default TTL** is approximately 1 hour, configurable via environment variable.

## Data flow

```
Chatwork page (content.js)
  Extracts room_id from the URL hash (#!rid438334858) plus message/sender/recipients
        │  POST /reply { roomId, message, sender, recipients, instructions }
        ▼
Reply bridge (server.js)
  1. resolve(roomId)  ─►  scans config/projects/*.json  →  slug | null
  2. if a slug is found:
        curated = context/projects/<slug>.md      ← maintained by you, cached by mtime
        recent  = cache/<roomId>.json             ← last N messages, TTL + background refresh
        context = curated + recent
     else:
        context = ""   and   unmapped = true       → modal displays a notice
  3. buildPrompt(... , context)   ← adds a "Project background" section
  4. claude -p → reply
        ▼
  { reply, unmapped }  returned to the modal
```

## Components

### 1. Room-to-project resolver — `bridge/context/resolve.js`

- Reads each `internal-pm-tool/config/projects/*.json` and builds a
  `room_id → slug` index from the existing `chatwork.room_id` field.
- The config directory is located at
  `~/grune-workspace/30_internal_projects/internal-pm-tool/config/projects/`.
  The bridge resolves `~` via `os.homedir()`. The path is overridable via
  `CW_REPLY_PROJECTS_CONFIG_DIR` for testing.
- No new mapping to maintain; populating a config's `room_id` enables grounding
  for that room. Currently mapped: furusato-iwate (`438334858`) and three
  others.
- Returns `null` when the room id is absent, unmapped, or the config directory
  cannot be read. `null` means "no context" — never an error.
- The index is read once and cached in memory for the bridge process lifetime,
  re-read when any config file's modification time changes.

**Interface:** `resolve(roomId) → { slug } | null`

### 2. Curated project summary — `bridge/context/projects/<slug>.md`

- A maintained per-project Markdown document, stored with the extension so the
  bridge is self-contained.
- Suggested contents: key people and roles, current project status, glossary and
  proper nouns, and tone guidance. The format is free text; the bridge does not
  parse it, it passes the contents through.
- Re-read only when the file's modification time changes; otherwise served from
  an in-memory cache. Cost is negligible.
- Absent file → curated section is empty; this is not an error.

**Interface:** `getCurated(slug) → string` (empty string when no file)

### 3. Recent-history cache — `bridge/context/cache/<roomId>.json`

- Shape: `{ "fetchedAt": <unix-ms>, "lines": ["Name: text", ...] }`.
- Populated via `cwcli` (the user's configured Chatwork CLI), taking the last
  `N` messages of the room and condensing each to a `Name: text` line. `N`
  default 30, configurable via `CW_REPLY_HISTORY_COUNT`.
- TTL default approximately 1 hour, configurable via
  `CW_REPLY_CONTEXT_TTL_MS`.
- Read path on a reply request:
  - **Fresh** (age < TTL): serve directly.
  - **Stale** (age >= TTL): serve the stale lines immediately, and spawn a
    background `cwcli` refresh that rewrites the cache file for the next reply.
  - **Absent**: perform one bounded synchronous fetch (short timeout), write the
    cache, and serve the result. If the fetch fails or times out, serve empty.
- The `cache/` directory is created on first write and is git-ignored.
- Privacy: history is fetched only for rooms that map to a project — all such
  rooms are customer group rooms — so one-to-one direct messages are never read
  automatically. This satisfies the DM-privacy rule in the home `CLAUDE.md`.

**Interface:** `getRecent(roomId) → string` (empty string on any failure)

### 4. Prompt assembly — `bridge/server.js` `buildPrompt`

- `buildPrompt` gains an optional `context` argument.
- When non-empty, a section is inserted before the message block:

  ```
  [Project background — for context only; do not quote verbatim]
  <curated summary>

  Recent conversation in this room:
  <recent history lines>
  ```

- The instruction wording directs Claude to use the background to inform the
  reply without copying it verbatim or inventing commitments from it.
- When `context` is empty (unmapped room or all sources empty), the prompt is
  byte-for-byte identical to today's.

### 5. Request handling — `bridge/server.js` `/reply` handler

- Accept a new optional `roomId` field in the POST body.
- Flow: `resolve(roomId)` → if a slug is found, assemble
  `context = getCurated(slug) + getRecent(roomId)`; otherwise `context = ""`
  and `unmapped = true`.
- Response shape gains a flag: `{ reply, unmapped }`. `unmapped` is `true` only
  when a `roomId` was supplied but no mapping was found; omitted/false otherwise.

### 6. Extension — `cw-reply-ext/content.js` and `background.js`

- `content.js`: extract `roomId` from `location.hash`
  (`#!rid<digits>` → `<digits>`; empty when not matched), and include it in the
  `chrome.runtime.sendMessage` payload.
- `background.js`: pass `roomId` through to the bridge POST body.
- `content.js`: when the bridge response has `unmapped: true`, show a small
  inline notice in the modal (for example, "No project context for this room").
  The notice is informational and does not block sending.

## Configuration summary

| Variable | Default | Purpose |
| --- | --- | --- |
| `CW_REPLY_CONTEXT_TTL_MS` | 3600000 (1h) | Recent-history cache TTL |
| `CW_REPLY_HISTORY_COUNT` | 30 | Number of recent messages to cache |
| `CW_REPLY_PROJECTS_CONFIG_DIR` | resolved from `os.homedir()` | Override config dir for testing |

## Failure modes (all degrade to current behaviour)

- No `roomId` in the request → no context, no notice.
- `roomId` present but unmapped → no context, modal shows the notice.
- Config directory unreadable → resolver returns `null`, no context.
- Curated file absent → curated section empty.
- `cwcli` missing or fails → recent section empty.
- Any context-assembly error is caught; the reply proceeds without context. The
  grounding feature must never turn a working reply into an error.

## Out of scope

- Auto-generating the curated summary from project-folder documents.
- A scheduled (launchd/cron) refresh job.
- Adding project grounding to the Polish extension.
- Backfilling `room_id` into the unmapped project configs (a manual edit done
  per project as needed; it is what enables grounding for that room).

## Testing notes

- Resolver: given a fixture config dir, maps a known `room_id` to its slug and
  returns `null` for unknown/blank ids.
- Recent-history cache: fresh/stale/absent branches select the correct path;
  a failing `cwcli` yields an empty string, not a throw.
- Prompt assembly: empty context produces the current prompt verbatim;
  non-empty context inserts the background section in the right position.
- End-to-end: a `/reply` for the furusato-iwate room returns a grounded draft;
  a `/reply` for an unmapped room returns `unmapped: true` and an ungrounded
  draft identical to today's output.
