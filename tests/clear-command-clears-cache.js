'use strict';

/**
 * Claim under test: "Using /clear clears the session cache."
 *
 * Disambiguation: "cache" here = the Anthropic Messages API server-side
 * prompt cache (the one that affects token billing). This is what matters
 * for subscription $ — cache_read_input_tokens is ~10% the cost of
 * cache_creation_input_tokens.
 *
 * What the docs say (see docs/caching-system.md §6.4, §7.4,
 * docs/cache-clearing.md `clearSessionCaches()`):
 *   - /clear invokes clearSessionCaches() which resets in-memory,
 *     client-side state: getUserContext (CLAUDE.md+date), getSystemContext
 *     (git), command/skill/agent caches, prompt-cache-break detection,
 *     and the conversation message list.
 *   - It does NOT invalidate server-side KV entries. Nothing in /clear
 *     touches the Anthropic API.
 *   - After /clear, the system prompt + prependUserContext (CLAUDE.md +
 *     currentDate) recompute to byte-identical content (inputs stable),
 *     so the server-side prefix cache still matches on the next turn.
 *
 * Note on "cold": the server-side cache is org-scoped and keyed on
 * request bytes, not on client identity. A fresh ~/.claude does NOT
 * imply a cold server cache — if any recent run sent an identical
 * system prompt + CLAUDE.md + prompt text within the 5-min TTL, the
 * server will serve cache_read > 0 on turn 1. We therefore do not
 * assert turn 1 is cold; we only need turn 2 as a warm baseline and
 * turn 3 as the post-/clear observation.
 *
 * Expected outcome (claim is FALSE for server-side cache):
 *   Turn 2 (warm baseline):   cache_read  > 0
 *   /clear
 *   Turn 3 (post-/clear):     cache_read  > 0     ← refutes claim
 *                             cache_read  < turn 2 cache_read
 *                             (conversation messages are gone; only
 *                              the sys-prompt + first-user-meta prefix
 *                              still matches)
 *
 * If turn 3 cache_read == 0, the claim would be TRUE and our model of
 * /clear is wrong. Either way the test produces a definitive verdict.
 *
 * Runs inside Docker with a fresh $HOME (no pre-existing ~/.claude).
 * Uses the interactive TUI (no -p) to exercise the same code paths as
 * human users.
 */

const { spawnSession } = require('../lib/session');
const { createWatcher } = require('../lib/transcript');

const PROMPT = 'Reply with exactly: OK';

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitForQuiet(session, quietMs = 1500, timeoutMs = 30_000) {
  let lastLen = -1;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(200);
    const len = session.output.length;
    if (len === lastLen) {
      await sleep(quietMs);
      if (session.output.length === len) return;
    }
    lastLen = session.output.length;
  }
  throw new Error('Timed out waiting for quiet PTY output');
}

let failed = false;
function check(condition, msg) {
  if (!condition) {
    console.error(`FAIL: ${msg}`);
    failed = true;
  } else {
    console.log(`PASS: ${msg}`);
  }
}

async function run() {
  console.log('=== claim: "/clear clears the (server-side prompt) cache" ===\n');

  const session = spawnSession();
  const watcher = createWatcher();

  console.log('--- Waiting for claude to start ---');
  await waitForQuiet(session, 2000, 45_000);
  console.log('--- Ready ---\n');

  // Turn 1 — informational only (server cache is org-scoped; prior runs
  // within TTL can already have populated it).
  console.log('Turn 1: first turn (not necessarily cold server-side)');
  watcher.beforeSend();
  session.send(PROMPT);
  const t1 = await watcher.nextTurn();
  console.log('  usage:', t1);

  await waitForQuiet(session);

  // Turn 2 — warm
  console.log('\nTurn 2: warm (same session)');
  watcher.beforeSend();
  session.send(PROMPT);
  const t2 = await watcher.nextTurn();
  console.log('  usage:', t2);
  check(t2.cacheRead > 0, `turn2: cache_read > 0 (got ${t2.cacheRead})`);

  await waitForQuiet(session);

  // /clear
  console.log('\nSending /clear');
  watcher.markClear();
  session.send('/clear');
  await waitForQuiet(session, 2000);

  // Turn 3 — post-clear
  console.log('\nTurn 3: post-/clear');
  watcher.beforeSend();
  session.send(PROMPT);
  const t3 = await watcher.nextTurn();
  console.log('  usage:', t3);

  // Core verdict assertion: server cache survives /clear.
  check(
    t3.cacheRead > 0,
    `turn3: cache_read > 0 (got ${t3.cacheRead}) — server prefix still cached after /clear`
  );

  // Sanity: conversation-level tokens dropped out of cache, so
  // turn 3 should read strictly fewer cached tokens than turn 2.
  check(
    t3.cacheRead < t2.cacheRead,
    `turn3: cache_read < turn2 cache_read (t3=${t3.cacheRead} < t2=${t2.cacheRead}) — convo messages no longer contribute`
  );

  watcher.close();
  session.close();

  console.log('\n=== VERDICT ===');
  if (failed) {
    console.log('Some assertions failed. See FAIL lines above.');
    process.exit(1);
  }
  console.log('Claim REJECTED: /clear does not invalidate the server-side prompt cache.');
  console.log('  turn1 write=%d read=%d', t1.cacheWrite, t1.cacheRead);
  console.log('  turn2 write=%d read=%d', t2.cacheWrite, t2.cacheRead);
  console.log('  turn3 write=%d read=%d  (post-/clear; read>0 refutes claim)', t3.cacheWrite, t3.cacheRead);
}

run().catch(err => {
  console.error('\nUnhandled error:', err);
  process.exit(1);
});
