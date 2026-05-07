'use strict';

/**
 * Diagnostic: instruments the post-/clear path with verbose chokidar +
 * filesystem + transcript-content logging. NOT a test. Used to pin down
 * why lib/transcript.js' nextTurn() intermittently times out after a
 * /clear on CC v2.1.132.
 *
 * What it does:
 *   1. Spawn claude, run t1, t2 directly via the production watcher.
 *   2. Snapshot ~/.claude/projects/ state.
 *   3. Send /clear, then continuously log chokidar events + dir state.
 *   4. Send t3 prompt, keep logging until either we see a usage entry on
 *      stdout OR 60s pass. No assertions; just data.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const chokidar = require('chokidar');
const { spawnSession } = require('../lib/session');
const { createWatcher } = require('../lib/transcript');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const PROMPT = 'Reply with exactly: OK';

function ts() { return new Date().toISOString().slice(11, 23); }
function log(...a) { console.log(`[${ts()}]`, ...a); }

function listProjects() {
  if (!fs.existsSync(PROJECTS_DIR)) return [];
  const out = [];
  for (const proj of fs.readdirSync(PROJECTS_DIR)) {
    const projDir = path.join(PROJECTS_DIR, proj);
    let entries;
    try { entries = fs.readdirSync(projDir); } catch { continue; }
    for (const e of entries) {
      const full = path.join(projDir, e);
      let stat;
      try { stat = fs.statSync(full); } catch { continue; }
      out.push({
        path: full,
        type: stat.isDirectory() ? 'dir' : 'file',
        size: stat.size,
        mtime: stat.mtimeMs,
      });
    }
  }
  return out;
}

function tail(filePath, n = 4) {
  try {
    const c = fs.readFileSync(filePath, 'utf8');
    const lines = c.split('\n').filter(Boolean);
    return lines.slice(-n).map(l => {
      try {
        const o = JSON.parse(l);
        return { type: o.type, subtype: o.subtype, hasUsage: !!(o.message?.usage), uuid: o.uuid?.slice(0,8) };
      } catch { return l.slice(0, 80); }
    });
  } catch (e) {
    return `[err: ${e.message}]`;
  }
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

async function run() {
  log('=== diag: post-/clear watcher behavior on CC v', process.env.CC_VERSION, '===');

  fs.mkdirSync(PROJECTS_DIR, { recursive: true });
  // Run an independent chokidar watcher in parallel with the production one.
  // Pure observability — does not feed into production watcher state.
  const obs = chokidar.watch(PROJECTS_DIR, { persistent: true, ignoreInitial: false, depth: 5 });
  obs.on('all', (event, p) => log('  [chokidar:', event, ']', p));

  const session = spawnSession();
  const watcher = createWatcher();

  log('--- waiting for ready ---');
  await waitForQuiet(session, 2000, 45_000);
  log('--- ready ---');

  log('TURN 1');
  watcher.beforeSend();
  session.send(PROMPT);
  const t1 = await watcher.nextTurn();
  log('  t1 usage:', t1);
  await waitForQuiet(session);

  log('TURN 2');
  watcher.beforeSend();
  session.send(PROMPT);
  const t2 = await watcher.nextTurn();
  log('  t2 usage:', t2);
  await waitForQuiet(session);

  log('--- pre-/clear projects state ---');
  for (const f of listProjects()) log(' ', f);

  log('--- markClear() + send /clear ---');
  watcher.markClear();
  session.send('/clear');

  // After /clear, log dir state every 1.5s for 5s.
  for (let i = 0; i < 4; i++) {
    await sleep(1500);
    log(`--- ${(i + 1) * 1.5}s after /clear ---`);
    for (const f of listProjects()) {
      const t = f.type === 'file' ? tail(f.path, 3) : '(dir)';
      log(' ', f.path, f.size + 'B', t);
    }
  }

  log('--- TURN 3 send (no waitForQuiet — racing the watcher) ---');
  watcher.beforeSend();
  session.send(PROMPT);

  // Start a watchdog that polls dir state every 1s for up to 60s, in
  // parallel with the watcher's own nextTurn() promise.
  const watchdog = (async () => {
    for (let i = 0; i < 60; i++) {
      await sleep(1000);
      log(`--- t${i + 1}s post-send dir state ---`);
      for (const f of listProjects()) {
        if (f.type === 'file') {
          log(' ', f.path, f.size + 'B', tail(f.path, 2));
        }
      }
    }
  })();

  let outcome;
  try {
    const t3 = await watcher.nextTurn();
    outcome = { ok: true, usage: t3 };
  } catch (e) {
    outcome = { ok: false, error: e.message };
  }
  log('--- outcome:', outcome);

  watcher.close();
  obs.close();
  session.close();
  log('--- done ---');
}

run().catch(e => { console.error('Fatal:', e); process.exit(1); });
