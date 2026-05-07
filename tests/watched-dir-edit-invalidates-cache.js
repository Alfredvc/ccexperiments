'use strict';

/**
 * Claim under test (parametric over target dir):
 *   "Modifying a file under a chokidar-watched claude config directory
 *    between turns within a single session forces measurable
 *    cache_creation_input_tokens on the next turn, beyond a no-op control."
 *
 * The four watched dirs per docs/cache-clearing.md line 152:
 *   ~/.claude/skills/          — "user-skills"
 *   ~/.claude/commands/        — "user-commands"
 *   <cwd>/.claude/skills/      — "project-skills"
 *   <cwd>/.claude/commands/    — "project-commands"
 *
 * All four fire the same `skillChangeDetector.scheduleReload()` →
 *   clearSkillCaches() + clearCommandsCache() + resetSentSkillNames()
 * (line 148). resetSentSkillNames() re-emits the skill_listing attachment
 * on the next user turn (lines 227–233) — the observable cache-creation
 * signal.
 *
 * Fixtures (mounted read-only at /fixtures, copied by entrypoint.sh):
 *   fixtures/skills/              → /root/.claude/skills/            (5 skills)
 *   fixtures/commands/            → /root/.claude/commands/          (5 commands)
 *   fixtures/project-skills/      → /workspace/.claude/skills/       (5 skills)
 *   fixtures/project-commands/    → /workspace/.claude/commands/     (5 commands)
 *   fixtures/CLAUDE.md            → /workspace/CLAUDE.md
 * All four dirs exist at claude startup so chokidar watchers register on
 * each (caveat at docs/cache-clearing.md line 156).
 *
 * Usage:
 *   node watched-dir-edit-invalidates-cache.js --target <abs-path-to-file> --label <label>
 *
 * Experimental shape (single container, single session):
 *   turn 1:      warm prefix
 *   turns 2–4:   CONTROL (no file change) — establish variance band
 *   turn 5:      NEGATIVE CONTROL — touch /tmp/nonwatched-probe.md
 *   turn 6:      PROBE — touch <target>
 *   turn 7:      POST-PROBE CONTROL — return to baseline
 *
 * Assertions:
 *   - turn 5 cacheWrite within threshold of controlMax (rules out
 *     "any fs write jostles something")
 *   - turn 6 cacheWrite > controlMax + DELTA_THRESHOLD (claim)
 *   - turn 7 cacheWrite within threshold of controlMax (one-shot)
 */

const fs = require('fs');
const { randomUUID } = require('crypto');
const { spawnSession } = require('../lib/session');
const { createWatcher } = require('../lib/transcript');
const { assertVersionMatch } = require('../lib/version');

const NONWATCHED_PATH = '/tmp/nonwatched-probe.md';
// Per-run UUID — guarantees server cache cold on turn 1 so within-run
// turn 2+ measurements are uncontaminated by prior runs' bytes.
const NONCE = randomUUID();
const PROMPT = `Reply with exactly: OK ${NONCE}`;
const DELTA_THRESHOLD = 100;
const CHOKIDAR_WAIT_MS = process.env.CCEXP_PROBE_WAIT_MS
  ? Number(process.env.CCEXP_PROBE_WAIT_MS)
  : 1500;

function parseArgs(argv) {
  const args = { target: null, label: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--target') args.target = argv[++i];
    else if (argv[i] === '--label') args.label = argv[++i];
  }
  if (!args.target || !args.label) {
    console.error('Usage: node watched-dir-edit-invalidates-cache.js --target <path> --label <label>');
    process.exit(2);
  }
  return args;
}

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
  if (!condition) { console.error(`FAIL: ${msg}`); failed = true; }
  else            { console.log(`PASS: ${msg}`); }
}

function verifyFixtures(targetPath) {
  const required = [
    '/root/.claude/skills',
    '/root/.claude/commands',
    '/workspace/.claude/skills',
    '/workspace/.claude/commands',
    '/workspace/CLAUDE.md',
  ];
  for (const p of required) {
    if (!fs.existsSync(p)) {
      throw new Error(`Missing fixture: ${p}. Check fixtures mount + entrypoint.`);
    }
  }
  if (!fs.existsSync(targetPath)) {
    throw new Error(`Target file does not exist: ${targetPath}`);
  }
  console.log(`--- Fixtures OK; target exists: ${targetPath} ---`);
}

async function sendTurn(session, watcher, label) {
  watcher.beforeSend();
  session.send(PROMPT);
  const u = await watcher.nextTurn();
  console.log(`  ${label}: cacheWrite=${u.cacheWrite} cacheRead=${u.cacheRead} inputTokens=${u.inputTokens}`);
  await waitForQuiet(session);
  return u;
}

function mean(xs) { return xs.reduce((a, b) => a + b, 0) / xs.length; }
function max(xs)  { return xs.reduce((a, b) => a > b ? a : b, -Infinity); }

async function run() {
  const { target, label } = parseArgs(process.argv.slice(2));
  const ccVersion = assertVersionMatch();
  console.log(`=== claim [${label}]: "editing ${target} mid-session forces cache_creation on the next turn" (CC v${ccVersion}) ===`);
  console.log(`Per-run nonce: ${NONCE}\n`);

  verifyFixtures(target);

  const session = spawnSession();
  const watcher = createWatcher();

  console.log('--- Waiting for claude to start ---');
  await waitForQuiet(session, 2000, 45_000);
  console.log('--- Ready ---\n');

  console.log('Turn 1: warm prefix (nonce ensures fresh user-msg bytes)');
  const t1 = await sendTurn(session, watcher, 'turn1');
  if (t1.cacheWrite === 0) {
    throw new Error(
      `Pre-condition failed: expected cacheWrite > 0 on turn 1 (nonce should force fresh user-msg bytes), got cacheWrite=${t1.cacheWrite}. Harness misconfigured.`
    );
  }

  console.log('\nTurns 2-4: CONTROL (no file change)');
  const t2 = await sendTurn(session, watcher, 'turn2');
  const t3 = await sendTurn(session, watcher, 'turn3');
  const t4 = await sendTurn(session, watcher, 'turn4');

  const controls = [t2.cacheWrite, t3.cacheWrite, t4.cacheWrite];
  const controlMean = mean(controls);
  const controlMax = max(controls);
  console.log(`  control cacheWrite: values=${JSON.stringify(controls)} mean=${controlMean.toFixed(1)} max=${controlMax}`);

  console.log(`\nNegative control: touch ${NONWATCHED_PATH} (not watched)`);
  fs.writeFileSync(NONWATCHED_PATH, 'probe\n');
  fs.appendFileSync(NONWATCHED_PATH, 'more\n');
  await sleep(CHOKIDAR_WAIT_MS);
  const t5 = await sendTurn(session, watcher, 'turn5 (neg ctrl)');

  const probeText = `\n<!-- probe ${Date.now()} -->\n`;
  console.log(`\nProbe: append text to ${target}`);
  fs.appendFileSync(target, probeText);
  await sleep(CHOKIDAR_WAIT_MS);
  const t6 = await sendTurn(session, watcher, 'turn6 (probe)');

  console.log('\nTurn 7: POST-PROBE CONTROL (no file change)');
  const t7 = await sendTurn(session, watcher, 'turn7 (post-probe)');

  watcher.close();
  session.close();

  console.log('\n=== ASSERTIONS ===');
  const negCtrlDelta = t5.cacheWrite - controlMax;
  check(negCtrlDelta < DELTA_THRESHOLD,
    `negative control: turn5 within ${DELTA_THRESHOLD} of controlMax (delta=${negCtrlDelta}) — non-watched fs write does not invalidate`);

  const probeDelta = t6.cacheWrite - controlMax;
  check(probeDelta > DELTA_THRESHOLD,
    `CLAIM [${label}]: turn6 cacheWrite exceeds controlMax by > ${DELTA_THRESHOLD} (delta=${probeDelta}) — edit of ${target} forced cache_creation`);

  const returnDelta = t7.cacheWrite - controlMax;
  check(returnDelta < DELTA_THRESHOLD,
    `return-to-baseline: turn7 within ${DELTA_THRESHOLD} of controlMax (delta=${returnDelta}) — invalidation is one-shot`);

  console.log('\n=== SUMMARY ===');
  console.log(`  cc_version:  ${ccVersion}`);
  console.log(`  label:       ${label}`);
  console.log(`  target:      ${target}`);
  console.log(`  turn1 warm:          write=${t1.cacheWrite} read=${t1.cacheRead}`);
  console.log(`  turn2 ctrl:          write=${t2.cacheWrite} read=${t2.cacheRead}`);
  console.log(`  turn3 ctrl:          write=${t3.cacheWrite} read=${t3.cacheRead}`);
  console.log(`  turn4 ctrl:          write=${t4.cacheWrite} read=${t4.cacheRead}`);
  console.log(`  turn5 neg ctrl:      write=${t5.cacheWrite} read=${t5.cacheRead}`);
  console.log(`  turn6 PROBE:         write=${t6.cacheWrite} read=${t6.cacheRead}`);
  console.log(`  turn7 post-probe:    write=${t7.cacheWrite} read=${t7.cacheRead}`);
  console.log(`  control mean=${controlMean.toFixed(1)} max=${controlMax}`);
  console.log(`  probe delta vs controlMax = ${probeDelta}`);

  if (failed) {
    console.log(`\nOne or more assertions FAILED for [${label}] — see FAIL lines above.`);
    process.exit(1);
  }
  console.log(`\nClaim CONFIRMED for [${label}]: editing the target file forces measurable, one-shot cache_creation on the next turn.`);
}

run().catch(err => {
  console.error('\nUnhandled error:', err);
  process.exit(1);
});
