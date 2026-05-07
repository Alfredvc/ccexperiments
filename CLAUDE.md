# claude-code-caching

## Purpose

Systematic, reproducible framework for testing and validating hypotheses about
Claude Code behavior. Runs experiments in Docker-isolated containers, collects
ground-truth data from transcript JSONL, and produces PASS/FAIL verdicts.

Current focus: prompt cache behavior (cost optimization). The harness is
general-purpose — any hypothesis about Claude Code's interactive behavior that
can be measured from transcript JSONL is testable here.

Scope:

1. **Test claims.** Every finding in the README must be backed by a script in
   `tests/` that inspects transcript JSONL fields and produces PASS/FAIL.
2. **Publish findings.** The README findings section is the user-facing
   deliverable.

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
Dockerfile          — two-stage build: native deps (node-pty) + runtime (pinned claude CLI via official native installer)
entrypoint.sh       — copies auth from /auth mount into /root/.claude, promotes claude.json
package.json        — node-pty dependency, docker-oriented npm scripts
lib/session.js      — spawns interactive claude via node-pty, exposes send/onData/close
lib/transcript.js   — locates and parses ~/.claude/projects/**/*.jsonl transcript files
lib/version.js      — reads `claude --version` and asserts it matches CC_VERSION env (no JSONL trust)
tests/              — experiment scripts that combine session + transcript watching
volume/.claude/     — host-side auth credentials (gitignored)
settings.json       — Claude Code settings for THIS project (not used inside Docker)
```

The Dockerfile installs claude via `curl -fsSL https://claude.ai/install.sh | bash -s ${CC_VERSION}` (recommended path per the official setup docs), pinned by `ARG CC_VERSION`. Binary lands at `/root/.local/bin/claude`, which is added to `PATH`. Bumping the version is one-line edit + rebuild + rerun.

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

Three turns. The user prompt is `Reply with exactly: OK ${randomUUID()}`
— per-run UUID nonce ensures fresh user-message bytes per run.

1. **Turn 1**: assert `cacheWrite > 0` (harness sanity — confirms the
   nonce produced previously-unseen user-msg bytes; not a claim test).
2. **Turn 2** (warm baseline, same session): assert `cache_read > 0`.
3. **`/clear`** then **Turn 3**: assert `cache_read > 0` (the headline).
   `/clear` only resets in-memory client state (`clearSessionCaches()`).
   It never calls the API, so server-side KV entries survive. The system
   prompt and `prependUserContext` (CLAUDE.md + currentDate) recompute to
   byte-identical content on the next turn, so the prefix still hits.

Logged informationally (not asserted): `(t2.cacheRead - t3.cacheRead) /
t2.cacheRead` as drop %. Older CC versions exhibited a clean ~20% drop
post-/clear (in-session conversation messages dropped from the cached
prefix). On v2.1.132 the sub-effect's magnitude varies; we don't model
it, just record.

Verdict: claim *"`/clear` clears the (server-side) cache"* is
**rejected** for the server-side cache. Observed post-/clear
`cache_read` is the same order as the warm baseline (≥23k on v2.1.132).

**Caveat — what the nonce DOES and DOESN'T control.** Per-run UUID is
embedded only in the user message, which is *after* the cache breakpoint.
So the nonce guarantees fresh user-msg bytes (`cacheWrite > 0`), but
does NOT cold-start the prefix. The system prompt + tools + CLAUDE.md
are unchanged across runs; if any prior run sent identical prefix bytes
within the 5-min TTL, turn 1's `cacheRead` will be > 0. To genuinely
cold-start the prefix you must vary prefix bytes (e.g. edit CLAUDE.md)
or wait past TTL. The pre-cond `cacheWrite > 0` is the strongest
deterministic signal achievable from the user-side.

Uses `waitForQuiet()` (PTY output stops changing for N ms) to detect when
claude finishes responding.

### tests/diag-post-clear.js, tests/diag-multi-spawn.js

Diagnostic scripts (not assertion tests). Used during the v2.1.132
re-validation effort to figure out (a) why post-/clear `nextTurn()`
intermittently timed out and (b) whether claude rotates the JSONL on
every spawn. They dump chokidar events, dir state, and PTY output. Keep
as a template if a future CC version causes similar flakes.

### tests/clear-vs-new-session.js

Backs the same ledger DO. Runs 3 cycles back-to-back in one docker
container. Per-run UUID nonce, constant across the 3 cycles within a
single run (same prompt bytes each cycle):

- Each cycle spawns **session A** (turn1 + turn2 warm baseline + `/clear`
  + turn3 post-clear), closes it, then spawns a fresh **session B**
  (new process, same auth/CLAUDE.md) and measures turn1.
- Cycle 1 only: assert `A.turn1.cacheWrite > 0` (harness pre-cond —
  confirms the nonce produced fresh user-msg bytes).
- Reports a per-cycle table; verdict pattern-matched from columns.

Observed on 2026-04-14 (CC version not pinned at the time): B.turn1
missed in cycle 1 (write=29702) then hit in cycles 2 and 3 (read=29785,
write=0). A.turn3 hit every cycle (write 0–1411). Motivated the
original "`/clear` is strictly cheaper than restart on the first
occurrence" finding.

Re-run on v2.1.132, 2026-05-07 (with per-run nonce harness): cycle 1
shows the gap reduced but still present — A.turn3 wrote 5351, B.turn1
wrote 5777 (Δ ≈ 426 in `/clear`'s favor). Cycle 2: A.turn3 wrote 5881,
B.turn1 wrote 0 (read 28808 — fully cached from cycle 1). Cycle 3: both
hit fully. Headline directionally matches the historical baseline (`/clear`
cheaper than restart on first occurrence) but at a much smaller
magnitude (~5–6k full-prefix-rewrite tokens, not the ~29k of the older
data). README has both tables side-by-side.

### Test-writing rules for new ledger entries

Every new test must:
- Map a claim to a specific assertion on `cache_creation_input_tokens` /
  `cache_read_input_tokens` (the only ground truth).
- **Pin and verify the Claude Code version.** Call
  `assertVersionMatch()` from `lib/version.js` at the start of `run()`. It
  shells out to `claude --version`, compares to `CC_VERSION` (set via
  `ARG`/`ENV` in the Dockerfile), and hard-fails on drift. Print the version
  in the test header and final verdict so the captured stdout is
  self-describing.
- Produce PASS/FAIL suitable for the README ledger (dos / don'ts).
- The README ledger entry must include a **Tested on:** line citing the
  exact CC version that produced the numbers. No version, no claim.

### Pinning the Claude Code version

- `Dockerfile` has `ARG CC_VERSION=<x.y.z>` and installs via the official
  native installer (`curl -fsSL https://claude.ai/install.sh | bash -s
  ${CC_VERSION}`) into `/root/.local/bin/claude`. Bump the ARG, rebuild, and
  rerun all ledger tests when adopting a new version. Don't float to latest.
- `lib/version.js` reads the binary at runtime via `claude --version`. JSONL
  `version` fields are *not* used as the source of truth — they describe what
  the binary wrote, but a drift check needs the binary itself before any API
  call has happened.

## Known Issues / Fragility

- **Session ID not tracked** — the watcher doesn't know which JSONL file belongs to its session. It infers "our file" by excluding pre-existing files (snapshot at `createWatcher()` time) and accepting the first new one. CC v2.1.132 rotates the JSONL on every spawn AND on every `/clear`, so the heuristic works for the cycle-based tests; it would break with concurrent sessions inside a single watcher. Could extract session ID from the JSONL filename after it appears.
- **OAuth refresh-token rotation kills sequential containers.** The volume mount `volume/.claude:/auth:ro` is read-only by design (per-run isolation). Inside a container, claude refreshes its access token using the host's `refreshToken`; rotation invalidates the old `refreshToken` server-side. Subsequent docker-runs start with the now-invalidated token and fail with HTTP 401 / `"Please run /login"`. Mitigation today: run `npm run auth` to refresh the host file whenever a sequence of tests starts to 401. Long-term: revisit the `:ro` design.
- **Post-/clear async title-generation write to old JSONL.** v2.1.132 writes `last-prompt` and `ai-title` entries to the *old* JSONL after `/clear`. The watcher's `clearSnapshot` path used to accept any growth on the old file as the new active session; the title-gen write would lock `sessionFile` to the wrong file and stall on the next `nextTurn()`. Fixed by accepting only files whose path is new since `markClear()` (see `lib/transcript.js`).
- **Server-side cache state leaks across tests.** The Anthropic prompt cache is org-scoped and TTL-based (~5 min). Running tests back-to-back means later tests see warm-cache state set up by earlier tests. To exercise a "cold" first turn, either wait > 5 min between tests or vary the prompt bytes (unique nonce). Currently no test does this — first-restart-cold findings cannot be reliably reproduced from a back-to-back run.
- **`waitForQuiet` is heuristic** — detects "claude is done" by watching for PTY output to stabilize. Works but slow (1.5-2s quiet window). No better alternative without parsing ANSI output for specific UI patterns.
