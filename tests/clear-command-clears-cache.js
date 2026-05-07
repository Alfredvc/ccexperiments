'use strict';

/**
 * Claim under test: "Using /clear clears the session cache."
 *
 * Disambiguation: "cache" here = the Anthropic Messages API server-side
 * prompt cache (the one that affects token billing). This is what matters
 * for subscription $ — cache_read_input_tokens is ~10% the cost of
 * cache_creation_input_tokens.
 *
 * Mechanism:
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
 *
 * If turn 3 cache_read == 0, the claim would be TRUE and our model of
 * /clear is wrong. Either way the test produces a definitive verdict.
 *
 * Note (CC v2.1.132): the older sub-claim "t3.cache_read < t2.cache_read
 * because conversation messages drop out of the prefix" is no longer a
 * reliable assertion. Two observed patterns:
 *   - "no drop": t3.cache_read ≈ t2.cache_read (within ~0.5%), with
 *     near-zero cache_write
 *   - "drop": t3.cache_read ~20% lower than t2, with notable cache_write
 *     (~5–6k)
 * Both yield t3.cache_read > 0, so the headline claim still holds. The
 * sub-effect's intermittency is logged informationally rather than
 * asserted; we don't yet have a model for what determines which pattern
 * a given run lands in.
 *
 * Runs inside Docker with a fresh $HOME (no pre-existing ~/.claude).
 * Uses the interactive TUI (no -p) to exercise the same code paths as
 * human users.
 */

const { randomUUID } = require('crypto');
const { spawnSession } = require('../lib/session');
const { createWatcher } = require('../lib/transcript');
const { assertVersionMatch } = require('../lib/version');

// Per-run UUID guarantees the server-side prompt cache (org-scoped,
// 5-min TTL) is cold on turn 1 of every run. Within a single run the
// prompt is constant, so within-session caching is exercised normally.
const NONCE = randomUUID();
const PROMPT = `Reply with exactly: OK ${NONCE}`;

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
  const ccVersion = assertVersionMatch();
  console.log(`=== claim: "/clear clears the (server-side prompt) cache" (CC v${ccVersion}) ===`);
  console.log(`Per-run nonce: ${NONCE}\n`);

  const session = spawnSession();
  const watcher = createWatcher();

  console.log('--- Waiting for claude to start ---');
  await waitForQuiet(session, 2000, 45_000);
  console.log('--- Ready ---\n');

  // Turn 1 — pre-cond: nonce must produce fresh user-msg bytes
  // (cacheWrite > 0). cacheRead may be > 0 since the prefix
  // (system+tools+CLAUDE.md) is shared across runs and may already be
  // cached server-side; that's expected, not pollution.
  console.log('Turn 1: first turn (nonce in user message ensures fresh user-msg bytes)');
  watcher.beforeSend();
  session.send(PROMPT);
  const t1 = await watcher.nextTurn();
  console.log('  usage:', t1);

  if (t1.cacheWrite === 0) {
    throw new Error(
      `Pre-condition failed: expected cacheWrite > 0 on turn 1 (nonce should force fresh user-msg bytes), got cacheWrite=${t1.cacheWrite}. Nonce did not vary the request — harness misconfigured.`
    );
  }

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

  // Informational: on older CC the conversation-level tokens dropped out
  // of cache post-/clear, so t3 read was strictly less than t2. On
  // v2.1.132 this sub-effect is intermittent (sometimes ~20% drop,
  // sometimes within noise). Logged for the ledger; not asserted.
  const dropPct = ((t2.cacheRead - t3.cacheRead) / t2.cacheRead) * 100;
  console.log(`  info: t3.cacheRead vs t2.cacheRead → ${dropPct.toFixed(2)}% drop (negative = t3 higher)`);

  watcher.close();
  session.close();

  console.log('\n=== VERDICT ===');
  if (failed) {
    console.log('Some assertions failed. See FAIL lines above.');
    process.exit(1);
  }
  console.log('Claim REJECTED: /clear does not invalidate the server-side prompt cache.');
  console.log('  cc_version=%s', ccVersion);
  console.log('  turn1 write=%d read=%d', t1.cacheWrite, t1.cacheRead);
  console.log('  turn2 write=%d read=%d', t2.cacheWrite, t2.cacheRead);
  console.log('  turn3 write=%d read=%d  (post-/clear; read>0 refutes claim)', t3.cacheWrite, t3.cacheRead);
}

run().catch(err => {
  console.error('\nUnhandled error:', err);
  process.exit(1);
});
