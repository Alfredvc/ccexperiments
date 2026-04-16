'use strict';

const pty = require('node-pty');

const CLAUDE_ARGS = [
  '--model', 'claude-haiku-4-5-20251001',
];

const PTY_OPTS = {
  cwd: '/workspace',
  env: process.env,
  cols: 220,
  rows: 50,
};

/**
 * Spawns an interactive claude session via PTY.
 * Returns a session object with send/close methods and a raw output stream.
 */
function spawnSession() {
  const proc = pty.spawn('claude', CLAUDE_ARGS, PTY_OPTS);

  let outputBuffer = '';
  const listeners = [];

  proc.onData((data) => {
    outputBuffer += data;
    for (const fn of listeners) fn(data);
  });

  return {
    /**
     * Send a line of text (user message or slash command).
     * Appends \r (carriage return) to submit.
     */
    send(text) {
      proc.write(text + '\r');
    },

    /** Raw output since session start (includes ANSI). */
    get output() { return outputBuffer; },

    /** Subscribe to PTY data chunks as they arrive. */
    onData(fn) { listeners.push(fn); },

    close() {
      proc.kill();
    },

    /** Underlying node-pty process (for pid etc.) */
    proc,
  };
}

module.exports = { spawnSession };
