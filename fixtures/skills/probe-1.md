---
name: probe-fixture-alpha
description: Test fixture skill for the claude-code-caching harness. Not a real skill. Do not invoke. Exists only so the server emits a skill_listing attachment and the test can measure cache behavior when its source file is edited mid-session.
---

# Probe Fixture Alpha

Placeholder body for the cache-invalidation experiment. This file is
checked in under `fixtures/skills/` and copied into
`~/.claude/skills/` by the container entrypoint. The test harness
modifies this file between turns to trigger `scheduleReload()` in
`skillChangeDetector` and observe the resulting `cache_creation_input_tokens`
delta on the subsequent API turn.
