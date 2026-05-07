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
import { randomUUID } from 'crypto';
import { spawnSession } from '../lib/session.js';
import { createWatcher } from '../lib/transcript.js';
import { assertVersionMatch } from '../lib/version.js';

assertVersionMatch();                         // hard-fail on CC version drift

const NONCE = randomUUID();                   // fresh user-msg bytes per run
const PROMPT = `Reply with exactly: OK ${NONCE}`;

const session = spawnSession();
const watcher = createWatcher();

watcher.beforeSend();
session.send(PROMPT);
const t1 = await watcher.nextTurn();

// Pre-cond: nonce did its job (harness sanity)
if (t1.cacheWrite === 0) throw new Error('nonce did not produce fresh user-msg bytes');

// ... drive more turns; t2 onwards is warm baseline ...

// Assert on ground-truth fields
console.assert(t2.cacheRead > 0, 'expected cache hit on warm baseline');
```

### Rules

- **Every claim must have a test.** No finding without a script that produces
  PASS/FAIL, with the test logic documented in pseudocode.
- **Every finding must cite a Claude Code version.** Behavior changes across
  CC releases. The Dockerfile pins `CC_VERSION` (currently `2.1.132`); tests
  call `assertVersionMatch()` from `lib/version.js`, which runs `claude
  --version` and hard-fails on drift. Findings recorded against an unpinned or
  different version are not portable forward — bump the pin, rerun, update the
  ledger.
- **Don't assert turn 1 is cold.** The Anthropic prompt cache is org-scoped and
  keyed on request bytes — a fresh container still hits entries from prior runs
  within the 5-min TTL. Use turn 2 in the same session as your warm baseline.
- **Per-run nonce only varies the user-message portion of the cache key.** The
  ledger tests inject a per-run UUID via `Reply with exactly: OK ${nonce}`. This
  guarantees the user-message bytes are fresh per run (so `cache_write > 0` on
  turn 1 — useful as a harness sanity pre-condition) but does NOT cold-start
  the prefix cache: the system prompt + tools + CLAUDE.md (the bulk of
  `cache_read`) are unchanged across runs and remain warm from prior org
  activity. To genuinely cold-start the prefix you must either wait past the
  5-min TTL or vary the prefix bytes (e.g. edit CLAUDE.md).
- **Produce a measurable, binary verdict.** PASS/FAIL with concrete numbers from
  the run.

### Entry template for findings

```md
### DO / DON'T: <short imperative>

- **Test(s):** `tests/<file>.js` — `npm run test:<script>`
- **Tested on:** Claude Code v<x.y.z> (matches `CC_VERSION` in Dockerfile)
- **Why:** <one-line mechanism>
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

#### Quick reference (CC v2.1.132, 2026-05-07)

| | Rule | Detail |
|---|------|--------|
| DO | Use `/clear` to reset context (vs restart) | Server prefix cache survives `/clear` (`cache_read` stays >23k). Both `/clear` and restart pay a one-time ~5k `cache_write` on the first occurrence within a TTL window because the conversation messages drop from the prefix; restart pays slightly more (~5.8k vs ~5.3k). Subsequent occurrences within TTL hit fully. Net: `/clear` marginally cheaper than restart on first occurrence, equivalent thereafter. |
| ~~DON'T~~ | ~~Edit files under `.claude/skills/` or `.claude/commands/` mid-session~~ | **Claim rejected on v2.1.132.** Probe-turn `cacheWrite` is *below* `controlMax` in all four watched dirs (Δ between -56 and -13 vs threshold +100). Either the `skillChangeDetector → resetSentSkillNames → re-emit skill_listing` chain no longer changes the request bytes, or the chokidar watch was removed/disabled in this version. See test failure tables below. |

---

#### DO: Use `/clear` to reset context. Don't restart claude.

`/clear` preserves the server-side prompt cache prefix (`cache_read` stays
>23k after `/clear`). Both `/clear` and restart pay a one-time ~5k
`cache_write` on the first occurrence within a TTL window because the
in-session conversation messages drop from the prefix and the post-reset
request bytes haven't been seen yet. Restart pays slightly more than
`/clear` on that first occurrence; subsequent occurrences with identical
bytes hit the cache fully.

**Tests backing this claim:**

1. `tests/clear-command-clears-cache.js` — proves `/clear` preserves
   the server-side cache (claim *"/clear clears the cache"* is REJECTED).
2. `tests/clear-vs-new-session.js` — quantifies the gap between `/clear`
   and restart across cycles within a single TTL window.

```
npm run test:clear-command-clears-cache
npm run test:clear-vs-new-session
```

**Tested on:** Claude Code v2.1.132 (current `CC_VERSION` pin), 2026-05-07.

**Harness controls:** Each run injects a per-run UUID into the user
prompt (`Reply with exactly: OK <uuid>`). This guarantees fresh user-msg
bytes per run (`cache_write > 0` on turn 1) so the cache numbers
correspond to a known prompt history. The system-prompt-and-CLAUDE.md
prefix is shared across runs and may already be cached server-side from
prior org activity — `cache_read` on turn 1 reflects that prior state.

**Why (mechanism):** `/clear` runs `clearSessionCaches()` — in-memory client
state only. It never calls the API, so server-side KV entries survive. The system prompt and `prependUserContext`
(CLAUDE.md + currentDate) recompute to byte-identical content on the next
turn, so the prefix still hits. The conversation message list IS wiped
client-side, so the post-`/clear` request body is shorter than the
pre-`/clear` body — the new exact byte-set may not have been seen before
within the TTL window, producing a one-time `cache_write`. Same pattern
on restart, with a slightly different fresh-process byte-set.

**Measured effect — `clear-command-clears-cache.js` on v2.1.132 (single run, 2026-05-07):**

| turn      | cacheWrite | cacheRead | note                                   |
|-----------|------------|-----------|----------------------------------------|
| t1        | 5243       | 23907     | first turn (per-run UUID); prefix hits |
| t2 warm   | 131        | 29150     | within-session, t1 message now cached  |
| t3 /clear | 5347       | 23907     | post-`/clear`; reads still hit prefix  |

Headline: `t3.cacheRead > 0` — server cache survives `/clear` (claim
"/clear clears the cache" REJECTED). `t3.cacheWrite ≈ 5347` reflects
the one-time write cost: the post-`/clear` byte-set (no in-session
messages) hadn't been seen this run.

**Measured effect — `clear-vs-new-session.js` on v2.1.132 (3-cycle run, 2026-05-07):**

| cycle | A.t3 (`/clear`) write | A.t3 read | B.t1 (new session) write | B.t1 read |
|-------|------------------------|-----------|---------------------------|-----------|
| 1     | 5351                   | 23543     | **5777**                  | 23031     |
| 2     | 5881                   | 23031     | 0                         | 28808     |
| 3     | 0                      | 28912     | 0                         | 28808     |

Cycle 1 shows the gap: `/clear` paid ~5.35k, fresh-process paid ~5.78k —
restart costs ~426 tokens more on the first occurrence. By cycle 2 the
B.t1 byte-set was already cached from cycle 1, so it read fully. A.t3
paid again on cycle 2 (likely a small process-state byte difference;
not yet investigated) and then hit on cycle 3. Across the 3 cycles
restart pays ~5.78k once, `/clear` pays ~5.35k–5.88k twice — overall
neither is dramatically cheaper, but `/clear` retains a consistent
edge on the first hit.

**Historical baseline — pre-version-pin (3-cycle run, 2026-04-14):**

| cycle | `/clear` write | `/clear` read | new-session write | new-session read |
|-------|----------------|---------------|-------------------|------------------|
| 1     | 1358           | 28338         | **29702**         | 0                |
| 2     | 1411           | 28478         | 0                 | 29785            |
| 3     | 0              | 29889         | 0                 | 29785            |

Every `/clear` turn hit cache. First restart of a given process-byte-set
missed entirely (~29.7k full prefix rewrite); subsequent restarts within
TTL hit. The CC version that produced this was not recorded, so it
cannot be reliably attributed to a specific release. The headline
(*prefer `/clear` over restart on first occurrence*) directionally
agrees with the v2.1.132 result; the magnitudes shrunk significantly.

##### Pseudocode — `clear-command-clears-cache.js`

```
NONCE = randomUUID()
PROMPT = `Reply with exactly: OK ${NONCE}`

session = spawn_claude()
wait_until_ready()

t1 = send(PROMPT); measure                   # nonce ensures fresh user-msg bytes
assert t1.cache_write > 0                    # pre-cond: harness sanity

t2  = send(PROMPT); measure                  # warm baseline (same session)
assert t2.cache_read > 0

send('/clear'); wait_until_ready()

t3  = send(PROMPT); measure                  # post-/clear
assert t3.cache_read > 0                     # server cache survives /clear
log    (t2 - t3) / t2 as drop %              # informational
```

##### Pseudocode — `clear-vs-new-session.js`

```
NONCE = randomUUID()                         # constant across all 3 cycles in one run
PROMPT = `Reply with exactly: OK ${NONCE}`

for cycle in 1..3:
    sessionA = spawn_claude()
    a1 = send(PROMPT); measure
    if cycle == 1: assert a1.cache_write > 0 # pre-cond: harness sanity
    a2 = send(PROMPT); measure               # warm baseline
    send('/clear')
    a3 = send(PROMPT); measure               # post-/clear

    close(sessionA)

    sessionB = spawn_claude()                # new process, same auth / CLAUDE.md
    b1 = send(PROMPT); measure               # first turn of fresh process
    close(sessionB)

    record(cycle, a3, b1)
```

---

#### REJECTED on v2.1.132: "Editing files under `.claude/skills/` or `.claude/commands/` mid-session forces cache miss"

The 2026-04-14 ledger said the four chokidar-watched config dirs would each
force a measurable `cache_creation_input_tokens` spike on the next turn after
any file edit. **On Claude Code v2.1.132 this no longer holds.** All four
test scripts FAIL their probe assertion: the probe-turn `cacheWrite` is
within ±10 of the control mean, well below the 100-token threshold.

The four directories that *were* watched:
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

**Tested on:** Claude Code v2.1.132 (current `CC_VERSION` pin), 2026-05-07.
All four currently fail the probe assertion.

**Original mechanism (no longer producing the measurable effect):**
`skillChangeDetector` was supposed to fire `scheduleReload()` →
`clearSkillCaches()` + `clearCommandsCache()` + `resetSentSkillNames()` on
any file change in those four dirs.  `resetSentSkillNames()` was supposed to
cause the `skill_listing` attachment to be re-emitted on the next user turn,
changing the request bytes and forcing a cache miss on the portion after
the last cache breakpoint. On v2.1.132 either (a) the chokidar watch was
removed/disabled, (b) `resetSentSkillNames` no longer triggers re-emit, or
(c) the cache breakpoint placement now isolates `skill_listing` from the
billed prefix — we have not yet investigated which.

**Measured effect — v2.1.132 (per-directory probe, single run each, 2026-05-07):**

| watched dir              | controlMax | probe `cacheWrite` | Δ vs controlMax | verdict |
|--------------------------|------------|--------------------|-----------------|---------|
| `~/.claude/skills/`      | 182        | 126                | -56             | FAIL    |
| `~/.claude/commands/`    | 146        | 123                | -23             | FAIL    |
| `<cwd>/.claude/skills/`  | 140        | 124                | -16             | FAIL    |
| `<cwd>/.claude/commands/`| 127        | 114                | -13             | FAIL    |

Negative control (touching `/tmp/nonwatched-probe.md`) and post-probe
return-to-baseline both PASS — confirming the test apparatus itself is
healthy and that the probe-turn is not anomalous in any other way. Each
run uses a per-run UUID nonce in the prompt (turn 1 `cacheWrite > 0`
checked as harness pre-cond).

**Historical baseline — pre-version-pin (2026-04-14):** all four
directories produced probe-turn `cacheWrite` deltas of 600–1000 above
control max, motivating the original DON'T. Preserved as context for the
behaviour change; cannot be reliably attributed to a specific CC release.

##### Pseudocode — `watched-dir-edit-invalidates-cache.js`

```
NONCE = randomUUID()
PROMPT = `Reply with exactly: OK ${NONCE}`

session = spawn_claude()
wait_until_ready()

t1 = send(PROMPT); measure                          # warm prefix
assert t1.cache_write > 0                           # pre-cond: harness sanity

t2 = send(PROMPT); measure                          # control
t3 = send(PROMPT); measure                          # control
t4 = send(PROMPT); measure                          # control
controlMax = max(t2.write, t3.write, t4.write)

write /tmp/nonwatched-probe.md                      # negative control
sleep(1.5s)
t5 = send(PROMPT); measure
assert t5.write - controlMax < 100                  # non-watched write doesn't invalidate

append text to <target>                             # PROBE: watched dir file
sleep(1.5s)
t6 = send(PROMPT); measure
assert t6.write - controlMax > 100                  # CLAIM: forces cache_creation

t7 = send(PROMPT); measure                          # post-probe control
assert t7.write - controlMax < 100                  # one-shot: back to baseline
```

---

## Architecture

See `CLAUDE.md` for harness internals.

---

## License

MIT — see [`LICENSE`](LICENSE).
