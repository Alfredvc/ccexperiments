# Claude Code Test Harness

A **systematic, reproducible framework** for testing and validating hypotheses
about Claude Code behavior. Run experiments in Docker-isolated containers,
collect ground-truth data from transcript JSONL, and produce PASS/FAIL verdicts.

## Why this exists

Claude Code behavior is often opaque: caching, context management, session
state, tool loading, prompt structure. It's easy to form a hypothesis ("does
`/clear` preserve the server cache?") but hard to test it reliably — shared
org-level server state, TTL windows, and interactive TUI behavior all interfere.

This harness solves that:

- **Docker isolation** — fresh `~/.claude` per run; no cross-contamination from
  personal sessions.
- **Real interactive sessions** — uses `node-pty` (full PTY, not `-p` headless
  mode), so results reflect actual user-facing behavior.
- **Ground-truth measurement** — reads `cache_creation_input_tokens` /
  `cache_read_input_tokens` directly from transcript JSONL; no guessing.
- **Repeatable** — every finding is backed by a runnable test that produces
  PASS/FAIL.

---

## How to run

```
npm run build                              # build docker image
npm run auth                               # one-time: authenticate inside container
npm run start                              # drop into a container shell for manual experiments
```

Individual test commands are listed under each finding below.

---

## Writing a new test

Each test maps a hypothesis to a concrete assertion on transcript JSONL fields.

### Skeleton

```js
import { createSession } from '../lib/session.js';
import { createWatcher } from '../lib/transcript.js';

const session = await createSession();
const watcher = createWatcher();

// Warm baseline (never assert turn 1 is cold — see caveat below)
await watcher.beforeSend();
await session.send('your prompt here');
const t1 = await watcher.nextTurn();

// ... drive more turns ...

// Assert on ground-truth fields
console.assert(t1.cache_read_input_tokens > 0, 'expected cache hit');
```

### Rules

- **Every claim must have a test.** No finding without a script that produces
  PASS/FAIL, with the test logic documented in pseudocode.
- **Don't assert turn 1 is cold.** The Anthropic prompt cache is org-scoped and
  keyed on request bytes — a fresh container still hits entries from prior runs
  within the 5-min TTL. Use turn 2 in the same session as your warm baseline.
  Alternatively, inject a unique nonce into the prompt to force a novel prefix
  hash, or wait past the 5-min TTL.
- **Cite the mechanism.** Every assertion should reference `docs/caching-system.md`
  or `docs/cache-clearing.md` so the expected direction has a documented reason,
  not a guess.
- **Produce a measurable, binary verdict.** PASS/FAIL with concrete numbers from
  the run.

### Entry template for findings

```md
### DO / DON'T: <short imperative>

- **Test(s):** `tests/<file>.js` — `npm run test:<script>`
- **Why:** <one-line mechanism; cite docs/>
- **Measured effect:** <concrete numbers from a run>

#### Pseudocode
<flow of the test in prose-code>
```

---

## Findings

### Caching

Claude Code subscriptions bill on total tokens. The Anthropic Messages API
prompt cache makes cached reads ~10% the cost of fresh writes. Every turn that
hits the cache is mostly free; every turn that misses pays full freight.

#### Quick reference

| | Rule | Detail |
|---|------|--------|
| DO | Use `/clear` to reset context | Preserves server-side cache. Restarting claude costs up to ~29k fresh write tokens on first occurrence. |
| DON'T | Edit files under `.claude/skills/` or `.claude/commands/` mid-session | Any change to the 4 watched config dirs forces a cache miss on the next turn (~600–1000 extra write tokens). |

---

#### DO: Use `/clear` to reset context. Don't restart claude.

`/clear` preserves the server-side prompt cache (0–1.4k fresh write tokens
on the next turn). Restarting the CLI can cost up to ~29k fresh write tokens
the first time a new process runs within a TTL window, because the new
process's request bytes differ slightly and miss the cached prefix. Subsequent
restarts with identical bytes hit the cache, but the first one has already paid.

**Tests backing this claim:**

1. `tests/clear-command-clears-cache.js` — proves `/clear` preserves
   the server-side cache (claim *"/clear clears the cache"* is REJECTED).
2. `tests/clear-vs-new-session.js` — proves `/clear` and restart are
   NOT equivalent; restart costs more on first occurrence.

```
npm run test:clear-command-clears-cache
npm run test:clear-vs-new-session
```

**Why (mechanism):** `/clear` runs `clearSessionCaches()` — in-memory client
state only (see `docs/cache-clearing.md`). It never calls the API, so
server-side KV entries survive. The system prompt and `prependUserContext`
(CLAUDE.md + currentDate) recompute to byte-identical content on the next turn,
so the prefix still hits. A new process produces bytes that differ from a
`/clear`'d session → different cache key → fresh write.

**Measured effect (3-cycle run, 2026-04-14):**

| cycle | `/clear` write | `/clear` read | new-session write | new-session read |
|-------|----------------|---------------|-------------------|------------------|
| 1     | 1358           | 28338         | **29702**         | 0                |
| 2     | 1411           | 28478         | 0                 | 29785            |
| 3     | 0              | 29889         | 0                 | 29785            |

Every `/clear` turn hits cache. First restart of a given process-byte-set misses
entirely. After that byte sequence is cached, subsequent restarts within TTL hit.

##### Pseudocode — `clear-command-clears-cache.js`

```
session = spawn_claude()
wait_until_ready()

_t1 = send(prompt); measure                  # may be cold or warm server-side — not asserted
t2  = send(prompt); measure                  # warm baseline (same session)

send('/clear'); wait_until_ready()

t3  = send(prompt); measure                  # post-/clear

assert t2.cache_read > 0                     # sanity: warm baseline
assert t3.cache_read > 0                     # server cache survives /clear
assert t3.cache_read < t2.cache_read         # convo messages no longer in prefix
```

##### Pseudocode — `clear-vs-new-session.js`

```
for cycle in 1..3:
    sessionA = spawn_claude()
    _a1 = send(prompt); measure
    _a2 = send(prompt); measure              # warm baseline
    send('/clear')
    a3  = send(prompt); measure              # post-/clear

    close(sessionA)

    sessionB = spawn_claude()                # new process, same auth / CLAUDE.md
    b1  = send(prompt); measure              # first turn of fresh process
    close(sessionB)

    record(cycle, a3, b1)

analyze:
    if every a3 hits AND every b1 misses     → process bytes unique; every restart pays
    elif b1 misses cycle 1, hits 2+          → bytes stable but differ from /clear; first restart pays
    elif all hit                             → equivalent after warmup
```

---

#### DON'T: Edit files under `.claude/skills/` or `.claude/commands/` mid-session

Modifying any file in the four chokidar-watched config directories forces a
measurable `cache_creation_input_tokens` spike on the next turn — even appending
a single line. The invalidation is one-shot: the turn after the probe returns to
baseline.

The four watched directories:
- `~/.claude/skills/` (user skills)
- `~/.claude/commands/` (user commands)
- `<cwd>/.claude/skills/` (project skills)
- `<cwd>/.claude/commands/` (project commands)

**Tests:**

```
npm run test:user-skills-edit-invalidates-cache
npm run test:user-commands-edit-invalidates-cache
npm run test:project-skills-edit-invalidates-cache
npm run test:project-commands-edit-invalidates-cache
npm run test:all-watched-dirs                        # all four in parallel
```

**Why (mechanism):** All four directories are watched by `skillChangeDetector`
via chokidar (`docs/cache-clearing.md` line 152). Any file change fires
`scheduleReload()` → `clearSkillCaches()` + `clearCommandsCache()` +
`resetSentSkillNames()` (line 148). `resetSentSkillNames()` causes the
`skill_listing` attachment to be re-emitted on the next user turn (lines
227–233), changing the request bytes and forcing a cache miss on the portion
after the last cache breakpoint.

**Caveat:** Watchers only register on directories that exist at process startup
(`docs/cache-clearing.md` line 156). If a dir is created mid-session, edits to
it won't trigger invalidation until the next restart.

**Measured effect:** All four directories confirmed. Typical probe delta vs
control max: 600–1000 `cache_creation_input_tokens`. Negative control (touching
`/tmp/nonwatched-probe.md`) stays within threshold. Post-probe turn returns to
baseline (one-shot invalidation).

##### Pseudocode — `watched-dir-edit-invalidates-cache.js`

```
session = spawn_claude()
wait_until_ready()

t1 = send(prompt); measure                          # warm prefix

t2 = send(prompt); measure                          # control
t3 = send(prompt); measure                          # control
t4 = send(prompt); measure                          # control
controlMax = max(t2.write, t3.write, t4.write)

write /tmp/nonwatched-probe.md                      # negative control
sleep(1.5s)
t5 = send(prompt); measure
assert t5.write - controlMax < 100                  # non-watched write doesn't invalidate

append text to <target>                             # PROBE: watched dir file
sleep(1.5s)
t6 = send(prompt); measure
assert t6.write - controlMax > 100                  # CLAIM: forces cache_creation

t7 = send(prompt); measure                          # post-probe control
assert t7.write - controlMax < 100                  # one-shot: back to baseline
```

---

## Architecture

See `CLAUDE.md` for harness internals and `docs/` for reference docs on Claude
Code's caching internals:

- `docs/caching-system.md` — server-side API prompt cache: what gets cached,
  where markers go, all 11 invalidation dimensions.
- `docs/cache-clearing.md` — client-side in-memory caches (plugins, commands,
  skills, agents): what each holds and what clears it.
