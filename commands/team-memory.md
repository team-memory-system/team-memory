---
description: Team Memory on this computer — what is on, the memory server, sharing or one teammate on and off, setup, or a check that fixes what it can
argument-hint: "[on | off | shared-on | shared-off [teammate] | setup | doctor]"
---

The person typed `/team-memory $ARGUMENTS`. Do what its first word asks:

- `setup`: read `${CLAUDE_PLUGIN_ROOT}/skills/setup-memory/SKILL.md` and follow it as written, with `<plugin-root>` being `${CLAUDE_PLUGIN_ROOT}`. Start with its first fixed line and the server question, and use its fixed lines at every step.
- `doctor`: run `node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs" doctor --fix` once, in the background, and wait for it to finish: what a plugin update left behind it repairs on its own, and when the memory server is behind it rebuilds and restarts it, which can take longer than a 10-minute command timeout. Say its `said` field first when it has one, exactly as written. Then explain the checks that still failed, and repair those only with the person's authorization. Never print tokens or secrets.
- Anything else, or nothing: run `node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs" switch` followed by each word the person typed after `/team-memory`, each in single quotes, once, with a 10-minute timeout (`on` can rebuild the server). Reply with the `said` field of its JSON output exactly as written and nothing else. Typing the option was the person's confirmation, so do not ask again and run nothing more. Only if the output has no `said`, say in one Korean sentence what failed.
