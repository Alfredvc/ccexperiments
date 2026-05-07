'use strict';

/**
 * Diagnostic: does Claude Code v2.1.132 create a NEW JSONL on every
 * `claude` spawn, or reuse the most recent one in the workspace?
 *
 * This is the question that decides how lib/transcript.js' watcher
 * identifies "our session's file" — see plan
 * /Users/alfredvc/.claude/plans/linked-wibbling-boole.md, section A.
 *
 * Procedure:
 *   1. Spawn session 1, send a prompt, wait for response, close.
 *   2. Snapshot projects dir.
 *   3. Spawn session 2, BEFORE sending anything snapshot dir again.
 *   4. Send a prompt, wait, snapshot dir.
 *   5. Print which file each session 2's user message landed in:
 *      - Same uuid as session 1's file → REUSE. Watcher ID scheme broken
 *        (preSessionFiles will reject).
 *      - Different uuid → ROTATE. Watcher's first-new-file approach should
 *        in principle work; root cause of cycle-2 timeout is elsewhere.
 *
 * Pure observability. No assertions.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const chokidar = require('chokidar');
const { spawnSession } = require('../lib/session');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const PROMPT = 'Reply with exactly: OK';

function ts() { return new Date().toISOString().slice(11, 23); }
function log(...a) { console.log(`[${ts()}]`, ...a); }

function listJsonl() {
  if (!fs.existsSync(PROJECTS_DIR)) return [];
  const out = [];
  for (const proj of fs.readdirSync(PROJECTS_DIR)) {
    const projDir = path.join(PROJECTS_DIR, proj);
    let entries;
    try { entries = fs.readdirSync(projDir); } catch { continue; }
    for (const e of entries) {
      if (!e.endsWith('.jsonl')) continue;
      const full = path.join(projDir, e);
      const stat = fs.statSync(full);
      out.push({ uuid: e.slice(0, 8), full, size: stat.size, mtime: stat.mtimeMs });
    }
  }
  return out.sort((a, b) => a.mtime - b.mtime);
}

function firstUserMessageUuid(filePath) {
  try {
    const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
    for (const l of lines) {
      try {
        const e = JSON.parse(l);
        if (e.type === 'user' && e.message?.role === 'user' && typeof e.message.content === 'string') {
          return { sessionId: e.sessionId, content: e.message.content.slice(0, 60), uuid: e.uuid };
        }
      } catch {}
    }
  } catch {}
  return null;
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
}

function snap(label) {
  log(`SNAPSHOT [${label}]`);
  for (const f of listJsonl()) {
    const head = firstUserMessageUuid(f.full);
    log(`  ${f.uuid}  size=${f.size}B  mtime=${new Date(f.mtime).toISOString().slice(11,23)}  sessionId=${head?.sessionId?.slice(0,8) || '-'}  firstUser="${head?.content || '-'}"`);
  }
}

async function run() {
  log('=== diag-multi-spawn (CC v', process.env.CC_VERSION, ') ===');

  fs.mkdirSync(PROJECTS_DIR, { recursive: true });
  const obs = chokidar.watch(PROJECTS_DIR, { persistent: true, ignoreInitial: false, depth: 5 });
  obs.on('all', (event, p) => log('  [chokidar:', event, ']', p));

  // Session 1
  log('--- spawn session 1 ---');
  const s1 = spawnSession();
  await waitForQuiet(s1, 2000, 45_000);
  log('--- s1 ready, send prompt ---');
  s1.send(PROMPT);
  await waitForQuiet(s1);
  log('--- s1 turn done ---');
  snap('after s1 turn');
  s1.close();
  await sleep(1500);
  snap('after s1 close');

  // Session 2
  log('--- spawn session 2 ---');
  const s2 = spawnSession();
  log('--- s2 spawned, snapshot before ready ---');
  await sleep(500);
  snap('s2 just spawned');
  await waitForQuiet(s2, 2000, 45_000);
  snap('s2 ready (pre-prompt)');

  // Dump s2 PTY output (strip ANSI for legibility) before prompt
  const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '\n');
  log('--- s2 PTY output (last 1500 chars, ANSI stripped) ---');
  log(stripAnsi(s2.output).slice(-1500));

  log('--- s2 send prompt ---');
  s2.send(PROMPT);
  await waitForQuiet(s2);
  snap('s2 turn done');

  log('--- s2 PTY output AFTER prompt (last 3000 chars, ANSI stripped) ---');
  log(stripAnsi(s2.output).slice(-3000));

  log('--- search /root/.claude for any recent files ---');
  const { execSync } = require('child_process');
  try {
    const out = execSync(`find /root/.claude -type f -mmin -2 2>/dev/null`, { encoding: 'utf8' });
    log(out);
  } catch (e) { log('find err:', e.message); }

  log('--- /root/.claude.json mtime/snippet ---');
  try {
    const cj = '/root/.claude.json';
    const st = fs.statSync(cj);
    log('  mtime:', new Date(st.mtimeMs).toISOString().slice(11,23), 'size:', st.size);
    const c = fs.readFileSync(cj, 'utf8');
    log('  content[0..400]:', c.slice(0, 400));
  } catch (e) { log('claude.json err:', e.message); }

  s2.close();

  obs.close();
  log('--- done ---');
}

run().catch(e => { console.error('Fatal:', e); process.exit(1); });
