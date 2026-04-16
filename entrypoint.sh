#!/bin/sh
# Copy only auth-relevant files from the mounted read-only source.
# Excludes projects/ (stale transcripts) and sessions/ (stale UI state)
# so each container run starts with a clean transcript directory.
if [ -d "/auth" ]; then
  mkdir -p /root/.claude
  for item in /auth/* /auth/.*; do
    base=$(basename "$item")
    case "$base" in
      .|..|projects|sessions|history.jsonl) continue ;;
    esac
    cp -r "$item" /root/.claude/ 2>/dev/null || true
  done
  # Promote claude.json → ~/.claude.json (overrides the baked onboarding/trust state)
  if [ -f "/root/.claude/claude.json" ]; then
    cp /root/.claude/claude.json /root/.claude.json
  fi
fi

# Copy test fixtures into place if mounted at /fixtures.
# All four watched dirs (user + project × skills + commands) are populated
# so chokidar registers watchers on each at claude startup — per
# docs/cache-clearing.md line 152 + caveat line 156.
if [ -d "/fixtures" ]; then
  if [ -d "/fixtures/skills" ]; then
    mkdir -p /root/.claude/skills
    cp /fixtures/skills/*.md /root/.claude/skills/ 2>/dev/null || true
  fi
  if [ -d "/fixtures/commands" ]; then
    mkdir -p /root/.claude/commands
    cp /fixtures/commands/*.md /root/.claude/commands/ 2>/dev/null || true
  fi
  if [ -d "/fixtures/project-skills" ]; then
    mkdir -p /workspace/.claude/skills
    cp /fixtures/project-skills/*.md /workspace/.claude/skills/ 2>/dev/null || true
  fi
  if [ -d "/fixtures/project-commands" ]; then
    mkdir -p /workspace/.claude/commands
    cp /fixtures/project-commands/*.md /workspace/.claude/commands/ 2>/dev/null || true
  fi
  if [ -f "/fixtures/CLAUDE.md" ]; then
    cp /fixtures/CLAUDE.md /workspace/CLAUDE.md
  fi
fi

exec "$@"
