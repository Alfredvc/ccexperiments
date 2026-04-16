'use strict';

const { spawn } = require('child_process');
const path = require('path');

const TARGETS = [
  { label: 'user-skills',      target: '/root/.claude/skills/probe-1.md' },
  { label: 'user-commands',     target: '/root/.claude/commands/probe-1.md' },
  { label: 'project-skills',   target: '/workspace/.claude/skills/probe-1.md' },
  { label: 'project-commands',  target: '/workspace/.claude/commands/probe-1.md' },
];

const ROOT = path.resolve(__dirname, '..');

function runOne({ label, target }) {
  return new Promise((resolve) => {
    const args = [
      'run', '--rm',
      '-v', `${ROOT}/volume/.claude:/auth:ro`,
      '-v', `${ROOT}/tests:/app/tests`,
      '-v', `${ROOT}/lib:/app/lib`,
      '-v', `${ROOT}/fixtures:/fixtures:ro`,
      'claude-caching-test',
      'node', 'tests/watched-dir-edit-invalidates-cache.js',
      '--target', target,
      '--label', label,
    ];

    const child = spawn('docker', args, { stdio: 'pipe' });
    let output = '';

    child.stdout.on('data', (d) => {
      const lines = d.toString().split('\n');
      for (const line of lines) {
        if (line) console.log(`[${label}] ${line}`);
      }
      output += d;
    });

    child.stderr.on('data', (d) => {
      const lines = d.toString().split('\n');
      for (const line of lines) {
        if (line) console.error(`[${label}] ${line}`);
      }
      output += d;
    });

    child.on('close', (code) => {
      resolve({ label, code, output });
    });
  });
}

async function main() {
  console.log(`=== Running ${TARGETS.length} watched-dir tests in parallel ===\n`);

  const results = await Promise.all(TARGETS.map(runOne));

  console.log('\n=== RESULTS ===');
  let anyFail = false;
  for (const { label, code } of results) {
    const status = code === 0 ? 'PASS' : 'FAIL';
    if (code !== 0) anyFail = true;
    console.log(`  ${status}: ${label} (exit ${code})`);
  }

  process.exit(anyFail ? 1 : 0);
}

main();
