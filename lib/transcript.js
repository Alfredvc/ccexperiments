'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const chokidar = require('chokidar');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const NEXT_TURN_TIMEOUT_MS = 30_000;

/**
 * Recursively find a value by key anywhere in a JSON structure.
 */
function findKey(obj, key) {
  if (obj === null || typeof obj !== 'object') return undefined;
  if (key in obj) return obj[key];
  for (const v of Object.values(obj)) {
    const found = findKey(v, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * Extract cache usage from a JSONL entry. Returns null if not a completed API response.
 * Requires inputTokens > 0 to skip partial streaming writes that have 0-valued usage fields.
 */
function extractUsage(entry) {
  const inputTokens = findKey(entry, 'input_tokens');
  if (!inputTokens) return null;
  const write = findKey(entry, 'cache_creation_input_tokens');
  const read  = findKey(entry, 'cache_read_input_tokens');
  if (write === undefined && read === undefined) return null;
  return {
    cacheWrite:  write ?? 0,
    cacheRead:   read  ?? 0,
    inputTokens,
  };
}

/**
 * Return all .jsonl paths under PROJECTS_DIR.
 */
function allJSONLFiles() {
  const results = [];
  if (!fs.existsSync(PROJECTS_DIR)) return results;
  for (const proj of fs.readdirSync(PROJECTS_DIR)) {
    const projDir = path.join(PROJECTS_DIR, proj);
    let entries;
    try { entries = fs.readdirSync(projDir); } catch { continue; }
    for (const f of entries) {
      if (!f.endsWith('.jsonl')) continue;
      results.push(path.join(projDir, f));
    }
  }
  return results;
}

/**
 * Scan lines in `content` starting at `startOffset` for a cache usage entry.
 * Returns { usage, newOffset } or null if not found yet.
 */
function scanForUsage(content, startOffset) {
  const slice = content.slice(startOffset);
  const lines = slice.split('\n').filter(Boolean);
  let consumed = 0;

  for (const line of lines) {
    consumed += Buffer.byteLength(line, 'utf8') + 1; // +1 for \n
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const usage = extractUsage(entry);
    if (usage) {
      return { usage, newOffset: startOffset + consumed };
    }
  }
  return null;
}

/**
 * Creates an event-driven transcript watcher backed by chokidar.
 *
 * Watches ~/.claude/projects/ for new JSONL files (session transcripts)
 * and file changes. Replaces the old polling-based approach.
 *
 * Usage:
 *   const w = createWatcher();
 *   const turn1 = await w.nextTurn();   // wait for next API response with cache usage
 *   w.markClear();                      // call right before /clear
 *   const turn3 = await w.nextTurn();   // works even if new file created
 *   w.close();                          // cleanup when done
 */
function createWatcher() {
  const preSessionFiles = new Set(allJSONLFiles());

  let sessionFile = null;
  let fileOffset = 0;
  let clearSnapshot = null;

  // Pending nextTurn() promise state
  let pendingResolve = null;
  let pendingTimeout = null;

  // Ensure projects dir exists so chokidar can watch it
  fs.mkdirSync(PROJECTS_DIR, { recursive: true });

  const fsWatcher = chokidar.watch(PROJECTS_DIR, {
    persistent: true,
    ignoreInitial: true,
    depth: 1, // projects/<hash>/<file>.jsonl
  });

  /**
   * Attempt to identify and scan a JSONL file for usage data.
   * Called on chokidar events and as a catch-up scan on nextTurn() entry.
   */
  function tryResolve(filePath) {
    if (!pendingResolve) return;
    if (!filePath.endsWith('.jsonl')) return;

    // Post-clear: re-identify the active file
    if (clearSnapshot) {
      const isNew = !clearSnapshot.excludePaths.has(filePath);
      if (isNew) {
        sessionFile = filePath;
        fileOffset = 0;
        clearSnapshot = null;
      } else if (clearSnapshot.minOffset > 0) {
        let size;
        try { size = fs.statSync(filePath).size; } catch { return; }
        if (size > clearSnapshot.minOffset) {
          sessionFile = filePath;
          fileOffset = clearSnapshot.minOffset;
          clearSnapshot = null;
        } else {
          return;
        }
      } else {
        return;
      }
    }

    // Pre-session-file: identify our session's file
    if (!sessionFile) {
      if (preSessionFiles.has(filePath)) return;
      sessionFile = filePath;
      fileOffset = 0;
    }

    if (filePath !== sessionFile) return;

    let content;
    try { content = fs.readFileSync(sessionFile, 'utf8'); } catch { return; }

    const result = scanForUsage(content, fileOffset);
    if (result) {
      fileOffset = result.newOffset;
      const resolve = pendingResolve;
      pendingResolve = null;
      clearTimeout(pendingTimeout);
      pendingTimeout = null;
      resolve(result.usage);
    }
  }

  fsWatcher.on('add', (filePath) => tryResolve(filePath));
  fsWatcher.on('change', (filePath) => tryResolve(filePath));

  function nextTurn() {
    return new Promise((resolve, reject) => {
      pendingResolve = resolve;

      pendingTimeout = setTimeout(() => {
        const r = pendingResolve;
        pendingResolve = null;
        if (r) reject(new Error('Timed out waiting for cache usage entry in transcript'));
      }, NEXT_TURN_TIMEOUT_MS);

      // Catch-up scan: events may have fired before nextTurn() was called.
      // Check all JSONL files so we don't miss data already on disk.
      for (const f of allJSONLFiles()) {
        tryResolve(f);
        if (!pendingResolve) return; // resolved during scan
      }
    });
  }

  /**
   * Call immediately before sending /clear.
   * Snapshots current file set + offset so the next nextTurn() correctly
   * handles either a new transcript file or continued writes to the existing one.
   */
  function markClear() {
    const knownFiles = new Set(allJSONLFiles());
    const currentSize = sessionFile
      ? (() => { try { return fs.statSync(sessionFile).size; } catch { return 0; } })()
      : 0;

    clearSnapshot = {
      excludePaths: knownFiles,
      minOffset: currentSize,
    };
  }

  /**
   * Call immediately before session.send() for each turn.
   * Advances fileOffset to end of transcript so nextTurn() only scans
   * entries written AFTER this point.
   */
  function beforeSend() {
    if (!sessionFile) return;
    try {
      const content = fs.readFileSync(sessionFile, 'utf8');
      fileOffset = content.length;
    } catch {}
  }

  function close() {
    fsWatcher.close();
    if (pendingTimeout) clearTimeout(pendingTimeout);
    pendingResolve = null;
  }

  return { nextTurn, markClear, beforeSend, close };
}

module.exports = { createWatcher };
