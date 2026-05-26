# Operator Guide

## Install and bootstrap

Install once:

```bash
npm install -g auditor-lambda
```

Then invoke `/audit-code` in a supported host. The prompt self-bootstraps the
current repository with:

```bash
audit-code ensure --quiet
```

Use these commands when you want to manage setup manually:

```bash
audit-code ensure
audit-code ensure --force
audit-code install
audit-code verify-install
audit-code prompt-path
```

`ensure` is idempotent. `install` rewrites the supported repo-local host
surfaces.

## Generated files

Shared install files:

- `.audit-code/install/audit-code.import.md`
- `.audit-code/install/SKILL.md`
- `.audit-code/install/GETTING-STARTED.md`
- `.audit-code/install/manifest.json`
- `.audit-code/install/run-mcp-server.mjs`
- `.audit-artifacts/session-config.json` when no backend fallback config exists

Host-specific files may include:

- Codex: managed `AGENTS.md` fallback guidance
- Claude Desktop: project template, remote MCP connector, local MCP bundle
- OpenCode: `opencode.json` with auditor MCP server and permission wiring; the `/audit-code` command is global npm-installed state
- VS Code/Copilot: prompt, custom agent, instructions, and `.vscode/mcp.json`
- Antigravity: planning-mode and MCP-oriented guidance

Use `.audit-code/install/GETTING-STARTED.md` as the repo-local handoff after
bootstrap.

## Host guidance

ChatGPT-style project conversations are the intended product surface. Use
`/audit-code` in conversation and let the active model and project files be the
default context.

Codex should normally use the global skill seeded by the npm install plus
repo-local `AGENTS.md` fallback guidance. The installed skill includes
`agents/openai.yaml` metadata so Codex can keep the slash-list display aligned
with the canonical `/audit-code` spelling.

Claude Desktop is treated as an MCP-first host. Use the generated project
template and local bundle artifacts when installing the integration.

OpenCode uses the global command seeded by `npm install -g auditor-lambda`.
The generated project `opencode.json` should not define `command["audit-code"]`;
it only wires the auditor MCP server and project permissions. VS Code uses
repo-local prompt and MCP configuration files.

Antigravity should be treated as a workflow-and-artifacts host until it has a
stable project-local config surface. Use generated planning-mode guidance,
MCP tools/resources, or the backend fallback from an Antigravity-managed
terminal when needed.

Manual prompt-import hosts can use:

```bash
audit-code prompt-path
```

## Backend fallback

From the target repository root:

```bash
audit-code
```

The wrapper:

- defaults artifacts to `<repo-root>/.audit-artifacts`
- advances deterministic work automatically
- stops cleanly when semantic review is required and no configured bridge can
  continue
- emits `contract_version: "audit-code/v1alpha1"`
- refreshes `.audit-artifacts/operator-handoff.json` and
  `.audit-artifacts/operator-handoff.md`

Useful fallback commands:

```bash
audit-code next-step
audit-code --single-step
audit-code --results /path/to/audit_results.json
audit-code --batch-results /path/to/results-dir
audit-code --updates /path/to/runtime_validation_update.json
audit-code --external-analyzer-results /path/to/external_analyzer_results.json
audit-code explain-task <task_id>
audit-code validate
audit-code cleanup
audit-code mcp
```

`audit-code next-step` is the backend-rendered step engine used by the
conversation prompt. It writes `.audit-artifacts/steps/current-step.json` and
`.audit-artifacts/steps/current-prompt.md`, then the host should follow only
that prompt.

`audit-code validate` checks artifact shape, cross-artifact consistency,
session config, and explicit provider readiness.

`audit-code cleanup` removes the `.audit-artifacts/` directory when safe to
do so. It reads `audit_state.json` before acting: `complete` and `not_started`
states are deleted unconditionally; `active` and `blocked` states are refused
(the audit is resumable). If `audit_state.json` is missing — typically a
crashed run — cleanup also refuses unless `--force` is passed. `--dry-run`
previews the action without deleting anything.

## Session config

Backend fallback configuration lives at:

```text
.audit-artifacts/session-config.json
```

The canonical `/audit-code` conversation route should not require users to
touch this file.

Default:

```json
{
  "provider": "local-subprocess"
}
```

Supported providers:

- `local-subprocess`
- `auto`
- `subprocess-template`
- `claude-code`
- `opencode`
- `vscode-task`

`local-subprocess` is the safest fallback default. `auto` is explicit opt-in.
External providers are compatibility bridges, not the intended default review
owner.

Common fields:

```json
{
  "provider": "local-subprocess",
  "timeout_ms": 1800000,
  "ui_mode": "headless",
  "agent_task_batch_size": 1,
  "parallel_workers": 1
}
```

Use `ui_mode: "visible"` when debugging provider stdout/stderr. Use
`subprocess-template` or `vscode-task` only when you have a reliable launcher
bridge.

## Model selection

Conversation-level model choice belongs to the host conversation. The backend
should not force a model in normal usage.

For backend provider bridges, let the chosen provider own its own model
selection unless the operator has a concrete reason to configure it.

Packet dispatch may emit provider-neutral model hints such as `small`,
`standard`, or `deep`. Hosts can map those hints to their own models.

## Windows notes

Prefer command arrays over shell strings in `session-config.json`. Avoid nested
shell quoting when possible. For PowerShell templates, keep the executable and
arguments separate and prefer `{workerCommandJson}` when a launcher can consume
structured command data.

Runtime validation wraps package-manager shims such as `npm`, `npx`, `pnpm`,
and `yarn` through the Windows command shell automatically. A runtime
`not_confirmed` result can still be environmental when the target repo command
starts but cannot write its own build output.

If final report promotion to `<repo-root>/audit-report.md` is blocked by local
permissions, the audit can still complete. Use the artifact-bundle copy of
`audit-report.md` and run `audit-code validate`.

Run `audit-code validate` after editing session config so command-template
issues fail before a long audit run.
