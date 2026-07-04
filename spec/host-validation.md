# Host validation checklist

The automated half of multi-host validation lives in `npm run verify:hosts`
(wired into `verify:release`): it deploys every host surface into an isolated
temp `$HOME` and re-runs each host's own `verify()` handler from the same
`INSTALL_HOST_DEFINITIONS` table the postinstall deploy uses. That gate catches
*our* drift — a missing, unparseable, or canonical-body-diverged asset — before
publish.

This checklist covers only what CI **cannot** reach: actually invoking
`/audit-code` inside a GUI host and confirming a real dispatch round-trips. A GUI
host can change its asset format or command-rendering out from under us; the
no-drift guard does not see that, so a human runs these rows at release. A failed
row becomes a backlog item.

Codex is a headless CLI, so its live `/audit-code` dispatch is automated instead
of listed here — see the `RUN_PROVIDER_MATRIX_E2E=1`-gated provider-matrix e2e in
`tests/audit/provider-matrix-dispatch-e2e.test.mjs` (supersedes the former
per-provider `RUN_CODEX_E2E=1` gate). Run it at release with a live Codex
backend present:

```
RUN_PROVIDER_MATRIX_E2E=1 npx vitest run tests/audit/provider-matrix-dispatch-e2e.test.mjs
```

## How to run a row

For each GUI host below:

1. **Install** — from a clean repo, run `npm install -g audit-tools` (or the
   local equivalent) so postinstall deploys the host surface, then open the
   repository in the host.
2. **Command appears** — confirm the host registers/offers `/audit-code` (slash
   command, skill, or agent, per the host's setup kind).
3. **One live dispatch** — invoke `/audit-code` and let it run one bounded audit
   step (a single `audit-code next-step` round-trip).
4. **Result lands** — confirm the step's result artifact is written under
   `.audit-tools/audit/` (e.g. `steps/current-step.json` advances and the
   expected artifact for that step appears).

Mark each cell pass / fail; record the release version and date.

## Checklist (one row per GUI host)

| Host | Surface deployed | 1. Install + open | 2. `/audit-code` visible | 3. One live dispatch | 4. Result lands under `.audit-tools/audit/` |
|---|---|---|---|---|---|
| Antigravity | `.agent/skills/audit-code/SKILL.md` skill, `.gemini/commands/audit-code.toml` slash command, planning guide, AGENTS instructions | ☐ | ☐ | ☐ | ☐ |
| OpenCode | global `/audit-code` command (npm-installed) + generated `opencode.json` project permissions | ☐ | ☐ | ☐ | ☐ |
| VS Code | generated prompt file + custom agent + Copilot instructions (`INSTALL_HOST_DEFINITIONS.vscode`, `setup_kind: 'prompt+agent'`) | ☐ | ☐ | ☐ | ☐ |

Notes / failures (file each as a backlog item):

-
