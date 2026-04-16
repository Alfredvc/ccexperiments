# claude-code-caching

## Purpose

Experimental harness that produces a **tested, repeatable dos-and-don'ts
ledger** for Claude Code cache optimization. Subscriptions bill on total
tokens; cached reads cost ~10% of fresh writes, so cache hygiene is cost
hygiene.

Scope:

1. **Test claims.** Every entry in the README ledger must be backed by a
   script in `tests/` that inspects `cache_creation_input_tokens` /
   `cache_read_input_tokens` in transcript JSONL and produces PASS/FAIL.
2. **Validate mechanisms.** Tests cite `docs/caching-system.md` or
   `docs/cache-clearing.md` so predictions have a reason.
3. **Publish findings.** The README ledger (dos / don'ts) is the
   user-facing deliverable.

See `README.md` for the ledger and test template.

## How It Works

### Docker-based isolation

Tests run inside Docker to get a clean `~/.claude` each time. The `volume/.claude/` directory on the host holds auth credentials; `entrypoint.sh` copies only auth-relevant files into the container (excluding `projects/`, `sessions/`, `history.jsonl`) so each run starts with zero transcript history.

- `npm run build` — build the Docker image
- `npm run auth` — interactive session to authenticate (stores creds in `volume/.claude/`)
- `npm run test:clear-command-clears-cache` — confirms `/clear` preserves the server cache
- `npm run test:clear-vs-new-session` — 3-cycle comparison of `/clear` vs restart
- `npm run start` — drop into a bash shell inside the container for manual experimentation

### Architecture

```
Dockerfile          — two-stage build: native deps (node-pty) + runtime (claude CLI)
entrypoint.sh       — copies auth from /auth mount into /root/.claude, promotes claude.json
package.json        — node-pty dependency, docker-oriented npm scripts
lib/session.js      — spawns interactive claude via node-pty, exposes send/onData/close
lib/transcript.js   — locates and parses ~/.claude/projects/**/*.jsonl transcript files
tests/              — experiment scripts that combine session + transcript watching
docs/               — reference documentation (cache-clearing architecture from source reading)
volume/.claude/     — host-side auth credentials (gitignored)
settings.json       — Claude Code settings for THIS project (not used inside Docker)
```

### lib/session.js

Spawns claude as an interactive PTY (not `-p` headless mode) via `node-pty`. Returns a session object with `send(text)`, `onData(fn)`, `output` buffer, and `close()`. Uses `claude-haiku-4-5-20251001` model to keep costs low. PTY dimensions set to 220x50 to avoid line-wrapping artifacts.

### lib/transcript.js

Event-driven watcher for `~/.claude/projects/**/*.jsonl` transcript files. Uses chokidar to watch for new JSONL files (`add` events) and file modifications (`change` events). Provides `createWatcher()` which returns:

- `nextTurn()` — async, resolves when the next API response with cache usage appears. Does a catch-up scan on entry (in case chokidar events fired before the call), then waits for chokidar events. 30s timeout.
- `markClear()` — call before sending `/clear` to snapshot file state (handles transcript file rotation or continued writes)
- `beforeSend()` — call before each `session.send()` to advance the read offset past prior turn data
- `close()` — stop the chokidar watcher and clean up timers

Session file identification: excludes JSONL files that existed before watcher creation, accepts the first new file as "our" session transcript. Post-`/clear`, accepts either a brand-new file or growth past the snapshot offset in the existing file.

### tests/clear-command-clears-cache.js

Backs the ledger DO *"Use `/clear` to reset context; don't restart"*
(see `README.md`). Tests the claim *"using `/clear` clears the session
cache"* against the **server-side prompt cache** (the billing-relevant
one) — claim is REJECTED.

Three turns:
1. **Turn 1** (informational): logged, not asserted — see caveat below.
2. **Turn 2** (warm baseline, same session): assert `cache_read > 0`
3. **`/clear`** then **Turn 3**: assert `cache_read > 0` AND
   `cache_read < turn2.cache_read`. Rationale: `/clear` only resets
   in-memory client state (`clearSessionCaches()` — see
   `docs/cache-clearing.md`). It never calls the API, so server-side KV
   entries survive. The system prompt and `prependUserContext`
   (CLAUDE.md + currentDate) recompute to byte-identical content on the
   next turn, so the prefix still hits. Conversation messages are wiped
   client-side, so the message-level portion of the prefix no longer
   contributes — hence `< turn2.cache_read`.

Verdict: claim is **rejected** for the server-side cache. Observed
post-/clear `cache_read` was ~96% of the warm baseline, confirming the
system-prompt + CLAUDE.md prefix survived intact.

**Caveat — no such thing as a "cold" turn 1 across runs.** The Anthropic
server-side cache is org-scoped and keyed on request bytes, not on
client identity or `~/.claude` state. A docker container with an empty
`~/.claude` still hits cache entries written by prior runs (same auth,
same system prompt, same CLAUDE.md, same prompt text) as long as the
5-min TTL hasn't expired. First observed in run at 2026-04-14:
`turn 1 cache_read = 29592, cache_write = 0`. Future tests that need a
truly cold baseline must either wait past TTL or vary request bytes
(e.g. unique nonce in the prompt).

Uses `waitForQuiet()` (PTY output stops changing for N ms) to detect when
claude finishes responding.

### tests/clear-vs-new-session.js

Backs the same ledger DO. Runs 3 cycles back-to-back in one docker
container:

- Each cycle spawns **session A** (turn1 + turn2 warm baseline + `/clear`
  + turn3 post-clear), closes it, then spawns a fresh **session B**
  (new process, same auth/CLAUDE.md) and measures turn1.
- Reports a per-cycle table and pattern-matches the verdict:
  - All A.turn3 hit, all B.turn1 miss → restart bytes are process-unique (worst).
  - B.turn1 misses cycle 1, hits 2+3 → restart bytes stable but differ from `/clear` bytes (first restart pays, rest free).
  - All hit → equivalent after warmup.

Observed on 2026-04-14 (see README table): B.turn1 missed in cycle 1
(write=29702) then hit in cycles 2 and 3 (read=29785, write=0). A.turn3
hit every cycle (write 0–1411). Confirms `/clear` is strictly cheaper
than restart on the first occurrence.

### Test-writing rules for new ledger entries

Every new test must:
- Map a claim to a specific assertion on `cache_creation_input_tokens` /
  `cache_read_input_tokens` (the only ground truth).
- Cite the mechanism in `docs/caching-system.md` or
  `docs/cache-clearing.md` so the expected direction has a reason, not a
  guess.
- Produce PASS/FAIL suitable for the README ledger (dos / don'ts).

## Known Issues / Fragility

- **Session ID not tracked** — the watcher doesn't know which JSONL file belongs to its session. It infers "our file" by excluding pre-existing files and accepting the first new one. Works for single-session containers but would break with concurrent sessions. Could extract session ID from the JSONL filename after it appears.
- **`waitForQuiet` is heuristic** — detects "claude is done" by watching for PTY output to stabilize. Works but slow (1.5-2s quiet window). No better alternative without parsing ANSI output for specific UI patterns.

## Reference Documents

- **`docs/caching-system.md`** — exhaustive reference on the API-level prompt cache: what gets cached (system prompt composition, tool schemas, CLAUDE.md injection, attachments), where cache breakpoints are placed, all 11 tracked invalidation dimensions, the pre-API message rewriting pipeline, compaction flows, and edge cases. Cites source file paths in `../claude-code/src/`.
- **`docs/cache-clearing.md`** — reference on Claude Code's internal **in-memory caches** (plugin manifests, command memoizes, skill indexes, agent definitions): what each cache holds, every trigger that clears it, and the full `clearAllCaches()` / `clearSessionCaches()` / `clearCommandsCache()` hierarchies. Complements `caching-system.md` — the in-memory caches feed into what's sent to the API, but are a separate layer from the server-side prompt cache.
