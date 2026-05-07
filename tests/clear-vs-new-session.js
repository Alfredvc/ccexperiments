'use strict';

/**
 * Claim under test: "/clear and starting a new session are equivalent
 * for server-side cache utilization."
 *
 * First single-cycle run showed striking divergence:
 *   A post-/clear : cache_read ≈ 29,696, cache_write = 0   (full hit)
 *   B new-session : cache_read = 0,      cache_write ≈ 29,630 (total miss)
 *
 * This multi-cycle version runs 3 iterations in ONE docker run to
 * disambiguate:
 *   - If each iteration's B.turn1 keeps missing (write ≈ 29k every time),
 *     new-session bytes are process-unique → restart always costs a full
 *     prefix rewrite. Worst case.
 *   - If iteration-1 B.turn1 misses but iterations 2+ hit, new-session
 *     bytes are stable across processes but differ from /clear bytes →
 *     first restart pays, subsequent ones within TTL are free.
 *   - If all B.turn1s hit after cycle 1, confirms stability.
 *
 * Each cycle:
 *   Session A: turn1 + turn2 (warm) + /clear + turn3
 *   Session A close.
 *   Session B: turn1'
 *   Session B close.
 *
 * All cycles run back-to-back in one container; the TTL window covers
 * the whole run (5 min default).
 */

const { randomUUID } = require('crypto');
const { spawnSession } = require('../lib/session');
const { createWatcher } = require('../lib/transcript');
const { assertVersionMatch } = require('../lib/version');

// Per-run UUID — see clear-command-clears-cache.js. Guarantees cold
// first turn on cycle 1 so the "first restart cold?" question is testable.
const NONCE = randomUUID();
const PROMPT = `Reply with exactly: OK ${NONCE}`;
const CYCLES = 3;

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

async function runTurn(session, watcher, label) {
  console.log('  ' + label);
  watcher.beforeSend();
  session.send(PROMPT);
  const usage = await watcher.nextTurn();
  console.log('    usage:', usage);
  return usage;
}

async function runCycle(index) {
  console.log(`\n━━━ Cycle ${index} ━━━`);

  // Session A
  console.log('[A] spawn');
  const sessionA = spawnSession();
  const watcherA = createWatcher();
  await waitForQuiet(sessionA, 2000, 45_000);

  const a1 = await runTurn(sessionA, watcherA, 'A turn 1');
  if (index === 1) {
    if (a1.cacheWrite === 0) {
      throw new Error(
        `Pre-condition failed (cycle 1, A.turn1): expected cacheWrite > 0 (nonce should force fresh user-msg bytes), got cacheWrite=${a1.cacheWrite}. Harness misconfigured.`
      );
    }
  }
  await waitForQuiet(sessionA);
  const a2 = await runTurn(sessionA, watcherA, 'A turn 2 (warm baseline)');
  await waitForQuiet(sessionA);

  console.log('  A: /clear');
  watcherA.markClear();
  sessionA.send('/clear');
  await waitForQuiet(sessionA, 2000);

  const a3 = await runTurn(sessionA, watcherA, 'A turn 3 (post-/clear)');
  await waitForQuiet(sessionA);

  watcherA.close();
  sessionA.close();
  await sleep(1000);

  // Session B
  console.log('[B] spawn');
  const sessionB = spawnSession();
  const watcherB = createWatcher();
  await waitForQuiet(sessionB, 2000, 45_000);

  const b1 = await runTurn(sessionB, watcherB, 'B turn 1 (new-session first turn)');

  watcherB.close();
  sessionB.close();
  await sleep(1000);

  return { a1, a2, a3, b1 };
}

function fmt(n) { return String(n).padStart(7); }

async function run() {
  const ccVersion = assertVersionMatch();
  console.log('=== multi-cycle claim: "/clear ≡ new-session" ===');
  console.log(`Claude Code version: ${ccVersion}`);
  console.log(`Per-run nonce: ${NONCE}`);
  console.log(`Running ${CYCLES} cycles back-to-back in one container.\n`);

  const results = [];
  for (let i = 1; i <= CYCLES; i++) {
    results.push(await runCycle(i));
  }

  console.log('\n\n============ RESULTS ============');
  console.log('cycle  | a1 read  write  | a2 read  write  | a3(/clear) read  write | b1(new) read  write');
  console.log('-------|-----------------|-----------------|------------------------|--------------------');
  results.forEach((r, i) => {
    console.log(
      `  ${i+1}    | ${fmt(r.a1.cacheRead)} ${fmt(r.a1.cacheWrite)} | ${fmt(r.a2.cacheRead)} ${fmt(r.a2.cacheWrite)} | ${fmt(r.a3.cacheRead)} ${fmt(r.a3.cacheWrite)}        | ${fmt(r.b1.cacheRead)} ${fmt(r.b1.cacheWrite)}`
    );
  });

  console.log('\n=== ANALYSIS ===');

  const allA3Hit = results.every(r => r.a3.cacheRead > 0 && r.a3.cacheWrite < 2000);
  const allB1Miss = results.every(r => r.b1.cacheRead === 0);
  const allB1Hit = results.every(r => r.b1.cacheRead > 0);
  const b1WritesConsistent = (() => {
    const ws = results.map(r => r.b1.cacheWrite);
    const max = Math.max(...ws), min = Math.min(...ws);
    return { all: ws, max, min, spread: max - min };
  })();
  const b1ReadsAcrossCycles = results.map(r => r.b1.cacheRead);

  console.log('A.turn3 (post-/clear) hits cache every cycle :', allA3Hit);
  console.log('B.turn1 (new-session) misses every cycle     :', allB1Miss);
  console.log('B.turn1 hits every cycle                     :', allB1Hit);
  console.log('B.turn1 reads across cycles                  :', b1ReadsAcrossCycles);
  console.log('B.turn1 writes across cycles                 :', b1WritesConsistent.all);
  console.log('B.turn1 write spread                         :', b1WritesConsistent.spread);

  console.log('\n=== VERDICT ===');
  if (allA3Hit && allB1Miss) {
    console.log('new-session bytes are PROCESS-UNIQUE within the measured window.');
    console.log('Every restart pays ~full prefix rewrite; /clear keeps the cache.');
    console.log('LEDGER: prefer /clear over restart (strong).');
  } else if (results[0].b1.cacheRead === 0 && results.slice(1).every(r => r.b1.cacheRead > 0)) {
    console.log('new-session bytes are STABLE but differ from /clear bytes.');
    console.log('First restart costs full rewrite; subsequent restarts within TTL hit cache.');
    console.log('LEDGER: prefer /clear for first reset; restarts fine after bytes cached.');
  } else if (allA3Hit && allB1Hit) {
    console.log('Both paths hit cache every cycle — effectively equivalent after warmup.');
    console.log('First new-session run likely cold; subsequent warm.');
  } else {
    console.log('Mixed / noisy pattern — inspect table above.');
  }
}

run().catch(err => {
  console.error('\nUnhandled error:', err);
  process.exit(1);
});
