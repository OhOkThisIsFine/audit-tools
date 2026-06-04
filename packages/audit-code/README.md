# auditor-lambda

Skill-first audit orchestration backend for the `/audit-code` product surface.

## Canonical Product Route

The primary product is `/audit-code` in conversation.

Normal product usage should:

- use the active conversation model by default
- use project files and attached repository context by default
- avoid manual paths, provider flags, and model-selection arguments
- keep semantic review with the active conversation agent by default
- advance the audit automatically until it completes or no further automatic progress is possible

## Conversation Setup

The canonical asset for editor and conversation integrations is:

`skills/audit-code/audit-code.prompt.md`

Packaged installs and repository checkouts both ship that prompt asset.

The intended user install is one global tool install:

```bash
npm install -g auditor-lambda
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

Typical examples include custom instructions, `.cursorrules`, prompt libraries, or comparable editor-specific prompt surfaces.

## Repo-Local Backend Fallback

The CLI in this repository is backend infrastructure and a repo-local fallback surface.

From the target repository root:

```bash
audit-code
```

Repository-local equivalent:

```bash
node /path/to/auditor-lambda/audit-code.mjs
```

This wrapper:

- defaults artifacts to `<repo-root>/.audit-artifacts`
- creates that directory automatically
- auto-builds `dist/` if it is missing
- advances fresh worker sessions automatically until the audit completes or the remaining work requires imported results or an interactive provider
- continues through provider-assisted audit review automatically when `.audit-artifacts/session-config.json` selects an interactive provider bridge
- keeps those provider bridges as fallback compatibility modes rather than the primary product path
- emits `contract_version: "audit-code/v1alpha1"`
- refreshes `.audit-artifacts/operator-handoff.json` and `.audit-artifacts/operator-handoff.md` with suggested evidence-import paths and continuation hints

Explicit root override still exists for callers running from outside the target repository:

```bash
audit-code --root /path/to/repo
```

For one bounded debug step instead of run-to-completion:

```bash
audit-code --single-step
```

For the conversation step engine used by `/audit-code`:

```bash
audit-code next-step
```

This writes `.audit-artifacts/steps/current-step.json` and
`.audit-artifacts/steps/current-prompt.md`; hosts should follow only the
returned step prompt.

For an operator-side artifact consistency check:

```bash
audit-code validate
```

That check now covers the artifact bundle plus `session-config.json` and explicit provider readiness.

For native batch ingestion of multiple result files:

```bash
audit-code --batch-results /path/to/audit-results-dir
```

For task-to-coverage inspection without reverse-engineering multiple artifacts:

```bash
audit-code explain-task <task_id>
```

To remove a leftover `.audit-artifacts/` directory from an interrupted or
crashed audit:

```bash
audit-code cleanup
audit-code cleanup --dry-run   # preview without deleting
audit-code cleanup --force     # delete even if state is unknown
```

Refuses to delete if the audit state is `active` or `blocked` (resumable).
Pass `--force` when `audit_state.json` is missing (crashed run).

The backend wrapper response schema is `schemas/audit-code-v1alpha1.schema.json`.

## Backend Provider Modes

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

Optional backend config:

`.audit-artifacts/session-config.json`

## Practical Guidance

- use `/audit-code` in conversation as the canonical product surface
- install once with `npm install -g auditor-lambda`, then let `/audit-code` run `audit-code ensure --quiet` in each repository
- use `audit-code install` when you want to repair or force-refresh repo-local host assets
- use `audit-code prompt-path` to locate the packaged prompt asset
- use `audit-code` from the repository root only when you need the repo-local backend fallback
- use omitted provider or `local-subprocess` for the safest deterministic fallback behavior
- use `provider: "auto"` only when you want best-effort routing across installed backends
- treat explicit provider bridges as compatibility fallback, not as the intended owner of semantic review

## Build And Test

```bash
npm install
npm run verify:release
npm run release:patch
npm run release:patch:publish
```

For GitHub Actions publication and npm Trusted Publishing setup, see `docs/release.md`.

## Key Docs

- `docs/product.md`
- `docs/operator-guide.md`
- `docs/contracts.md`
- `docs/release.md`
- `docs/development.md`
- `docs/history.md`
- `skills/audit-code/SKILL.md`
