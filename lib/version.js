'use strict';

const { execFileSync } = require('child_process');

/**
 * Read installed Claude Code version via `claude --version`.
 * Returns the bare semver string (e.g. "2.1.132").
 *
 * Single source of truth: we trust the binary, not env or JSONL `version`
 * fields. JSONL gets written *after* the API call, so any drift between
 * the binary and what we think it is would already have biased the result.
 */
function getInstalledVersion() {
  const out = execFileSync('claude', ['--version'], { encoding: 'utf8' });
  // `claude --version` prints e.g. "2.1.132 (Claude Code)" — extract the semver.
  const m = out.match(/(\d+\.\d+\.\d+)/);
  if (!m) throw new Error(`Could not parse claude --version output: ${JSON.stringify(out)}`);
  return m[1];
}

/**
 * Assert installed version matches the build-time pin (`CC_VERSION` env).
 * Hard-fails. No "warn and continue" — a version-drift run produces
 * untrustworthy ledger numbers.
 */
function assertVersionMatch() {
  const expected = process.env.CC_VERSION;
  if (!expected) throw new Error('CC_VERSION env not set; container build is misconfigured');
  const actual = getInstalledVersion();
  if (actual !== expected) {
    throw new Error(`Claude Code version drift: pinned=${expected} installed=${actual}`);
  }
  return actual;
}

module.exports = { getInstalledVersion, assertVersionMatch };
