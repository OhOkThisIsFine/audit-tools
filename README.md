# audit-tools

Portable, hybrid code **auditing** + **remediation** orchestrators for arbitrary repositories,
shipped as one package exposing two CLIs / slash workflows:

- **`audit-code`** (`/audit-code`) — audits a codebase one bounded, backend-rendered step at a time
  and produces a findings report (`audit-findings.json` + `audit-report.md`).
- **`remediate-code`** (`/remediate-code`) — consumes that report (or free-form feedback) and applies
  fixes step by step, emitting `remediation-outcomes.json` + `remediation-report.md`.

Both are **conversation-first**: the product is the slash workflow inside a host agent; the CLI is the
backend/fallback. Each `next-step` call returns one prompt contract (JSON + markdown); the host agent
executes it and calls back for the next. State persists to an artifact directory, so runs are resumable.

## Install

```bash
npm install -g audit-tools
```

This installs both the `audit-code` and `remediate-code` bins and deploys the host slash-command assets
(Claude Code, Codex, OpenCode, Antigravity) via the package postinstall.

## Usage

```bash
audit-code next-step        # advance the audit one step
remediate-code next-step    # advance a remediation one step
```

In a host agent, drive the workflow with `/audit-code` then `/remediate-code`.

## Concepts

One pipeline, two halves: audit → findings contract; remediate → consumes + fixes. The JSON contract is
the source of truth; the markdown is its human render. Neither tool runs to completion in a single call —
each derives state, does one bounded unit of work, persists, and returns. See `CLAUDE.md` for the full
design concepts and standing decisions.

---

## audit-code

### Canonical Product Route

The primary product is `/audit-code` in conversation.

Normal product usage should:

- use the active conversation model by default
- use project files and attached repository context by default
- avoid manual paths, provider flags, and model-selection arguments
- keep semantic review with the active conversation agent by default
- advance the audit automatically until it completes or no further automatic progress is possible

### Conversation Setup

The canonical asset for editor and conversation integrations is:

`skills/audit-code/audit-code.prompt.md`

Packaged installs and repository checkouts both ship that prompt asset.

The intended user install is one global tool install:

```bash
npm install -g audit-tools
```

That makes `audit-code` available on `PATH`. During package install, the package
also writes user-level command/skill assets for hosts we can seed safely, including
the Claude command file, the global Codex skill bundle with `audit-code` display
metadata, and the global OpenCode slash command entry in
`~/.config/opencode/opencode.json`.

After that, invoke `/audit-code` in a supported host. The prompt self-bootstraps
the current repository by running:

```bash
audit-code ensure --quiet
```

That command writes or refreshes the repo-local assets only when they are missing
or stale, then normal audit execution continues without manual paths, provider
flags, or model-selection arguments.

The explicit repair and compatibility setup path remains:

```bash
audit-code install
```

That bootstraps repo-local supporting surfaces for the hosts we can automate today, including:

- Codex `AGENTS.md` fallback guidance for the global skill surface
- Claude Desktop local MCP bundle artifacts and project template guidance
- OpenCode `opencode.json` with auditor agent and permission wiring; the `/audit-code` command stays in the global npm-installed OpenCode config
- VS Code prompt, custom agent, Copilot instructions, and `.vscode/mcp.json`
- Antigravity planning-mode guidance plus the shared repo-local MCP launcher

`audit-code ensure` refreshes those files automatically when the packaged prompt
or skill changes. Use `audit-code install` or `audit-code ensure --force` when
you intentionally want to rewrite every generated host surface on demand.

After bootstrap, you can smoke-test the generated host assets and launcher from the repository root:

```bash
audit-code verify-install
```

After that, open a supported conversation surface in the repository and invoke `/audit-code`.

If a host still needs manual prompt import after bootstrap, open:

```text
.audit-code/install/GETTING-STARTED.md
```

That repo-local guide now includes dedicated quick-start sections for Codex, Claude Desktop, OpenCode, VS Code, and Antigravity, plus the installed canonical prompt asset path for prompt-import fallback flows.

For narrower compatibility, `audit-code install-host --host copilot` still exists.

For hosts that still need manual import after bootstrap, or for environments with no repo-local install surface, after installing the package or checking out the repository, use:

```bash
audit-code prompt-path
```

Import the reported file into your editor or conversation environment's custom prompt configuration, then invoke `/audit-code` in conversation.

### Repo-Local Backend Fallback

The CLI in this repository is backend infrastructure and a repo-local fallback surface.

The conversation step engine used by `/audit-code` — the single execution loop —
runs from the target repository root:

```bash
audit-code next-step
```

Repository-local equivalent:

```bash
node /path/to/audit-tools/audit-code.mjs next-step
```

This advances deterministic audit state one bounded step, writes
`.audit-tools/audit/steps/current-step.json` and
`.audit-tools/audit/steps/current-prompt.md`, auto-builds `dist/` if it is
missing, and creates the artifacts directory automatically. Hosts follow only
the returned step prompt, then call `next-step` again. A bare `audit-code`
invocation prints usage; there is no implicit batch loop.

Explicit root override still exists for callers running from outside the target repository:

```bash
audit-code next-step --root /path/to/repo
```

### Backend Provider Modes

If `provider` is omitted, the backend defaults to the safest mode:

```json
{
  "provider": "local-subprocess"
}
```

If you want best-effort cross-editor or provider routing, opt into:

```json
{
  "provider": "auto",
  "ui_mode": "visible"
}
```

Optional backend config: `.audit-tools/audit/session-config.json`

### Key Docs

- `docs/audit-pkg/product.md`
- `docs/audit-pkg/operator-guide.md`
- `docs/audit-pkg/contracts.md`
- `docs/audit-pkg/release.md`
- `docs/audit-pkg/development.md`
- `skills/audit-code/SKILL.md`

---

## remediate-code

Conversation-first remediation orchestrator. Accepts `audit-findings.json` (the deterministic machine
contract from audit-code), an `audit-report.md` or other feedback document, or conversational feedback —
then advances through one backend-rendered step prompt at a time.

### Primary Usage

```bash
npm install -g audit-tools
```

Then start from a conversation:

```text
/remediate-code path/to/audit-findings.json
```

You can also start with free-form feedback:

```text
/remediate-code clean up the auth flow and make the session refresh behavior easier to test
```

The global loader runs `remediate-code ensure --quiet`, then
`remediate-code next-step`, reads only the returned `prompt_path`, and follows
that one prompt. Each prompt carries its own allowed commands and stop condition.

### Runtime Artifacts

Active runs use `.audit-tools/remediation/` in the target repository:

- `.audit-tools/remediation/state.json`
- `.audit-tools/remediation/steps/current-step.json`
- `.audit-tools/remediation/steps/current-prompt.md`

After close, durable outputs land at `.audit-tools/`:

- `remediation-report.md`
- `remediation-outcomes.json`
- `remediation-closing-result.json`

### CLI

| Command | Description |
| --- | --- |
| `remediate-code next-step [--input <path>] [--host-can-dispatch-subagents]` | Decide and render exactly one next action |
| `remediate-code prepare-implement-dispatch --run-id <id>` | Write bounded implementation prompts |
| `remediate-code merge-implement-results --run-id <id>` | Validate implementation results and update item state |
| `remediate-code validate-artifacts` | Validate runtime artifacts |
| `remediate-code ensure [--quiet]` | Repair/check global Claude, Codex, and OpenCode assets |

### Auditor Compatibility

The auditor's canonical `audit-findings.json` is parsed **deterministically** —
findings, work-block assignments, and synthesis themes are adopted verbatim, with
no LLM involved. A Markdown `audit-report.md` (or any other free-form or partial
document) is instead routed through intake synthesis and bounded LLM finding
extraction, so it cannot silently produce a zero-finding plan.

---

## Build and Test

```bash
npm install
npm run build && npm run check
npm test
npm run verify:release
```

When developing from a fresh clone or git worktree, run `npm install` at the repo root
before build, check, or test workflows. Missing `node_modules` can cause misleading type errors.

For GitHub Actions publication and npm Trusted Publishing setup, see `docs/audit-pkg/release.md`.

## License

ISC
