# remediator-lambda

Conversation-first remediation orchestrator for arbitrary repositories. It
accepts the auditor's `audit-findings.json` (the deterministic machine contract)
from [auditor-lambda](https://github.com/OhOkThisIsFine/auditor-lambda), an
`audit-report.md` or other feedback document (LLM-extracted), or conversational
feedback — then advances through one backend-rendered step prompt at a time.

## Primary Usage

```bash
npm install -g remediator-lambda
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
that one prompt. Each prompt carries its own allowed commands and stop
condition.

If the starting point is not already a structured auditor report, the backend
first creates an intake brief from the supplied document(s) or conversational
feedback. It asks for clarification when the goals, non-goals, affected areas,
or success criteria are ambiguous. The normal remediation workflow starts only
after that brief is clear enough to convert into bounded findings.

## Runtime Artifacts

Active runs use `.remediation-artifacts/` in the target repository. The current
state is `.remediation-artifacts/state.json`, and the current step contract is
written to:

- `.remediation-artifacts/steps/current-step.json`
- `.remediation-artifacts/steps/current-prompt.md`

After close, the durable outputs are written at the repo root:

- `remediation-report.md`
- `remediation-report.json`
- `remediation-closing-result.json`

## Development From Source

The global `npm install -g remediator-lambda` path is for users. For repository
development in a fresh clone or git worktree, run `npm install` at the repo root
before build, check, test, or package-scoped workflows so workspace links point
at the current `@audit-tools/shared` sources instead of stale compiled output.

## CLI

| Command | Description |
| --- | --- |
| `remediate-code next-step [--input <path>] [--host-can-dispatch-subagents true\|false]` | Decide and render exactly one next action |
| `remediate-code prepare-document-dispatch --run-id <id>` | Write bounded item-spec prompts |
| `remediate-code merge-document-results --run-id <id>` | Validate item specs or clarification requests and advance state |
| `remediate-code prepare-implement-dispatch --run-id <id>` | Write bounded implementation prompts |
| `remediate-code merge-implement-results --run-id <id>` | Validate implementation results and update item state |
| `remediate-code validate-artifacts` | Validate runtime artifacts |
| `remediate-code run --input <path>` | Deprecated compatibility alias that prints one `next-step` JSON contract |
| `remediate-code install` | Deprecated alias that repairs global assets and writes no repo-local host files |
| `remediate-code ensure [--quiet]` | Repair/check global Claude, Codex, and OpenCode assets |

`next-step` is the single canonical execution path. Hosts and IDEs should call
it repeatedly, read the returned `prompt_path`, follow that one prompt, and then
call `next-step` again only when the prompt says to continue. The deprecated
`run` and `mcp` surfaces remain non-breaking adapters for older integrations.

## Auditor Compatibility

The auditor's canonical `audit-findings.json` is parsed **deterministically** —
findings, work-block assignments, and synthesis themes are adopted verbatim, with
no LLM involved. A Markdown `audit-report.md` (or any other free-form or partial
document) is instead routed through intake synthesis and bounded LLM finding
extraction, so it cannot silently produce a zero-finding plan. The deterministic
contract is locked by `tests/fixtures/auditor-contract-audit-findings.json`,
regenerated with `npm run fixtures:auditor-contract` from auditor-lambda's
findings renderer.

## Intake

The remediator can start from any of these inputs:

- a structured auditor report
- one or more feedback or planning documents
- conversational feedback typed directly after `/remediate-code`
- a mix of documents and conversation

Runtime intake artifacts live under `.remediation-artifacts/intake/`:

- `source-manifest.json`
- `conversation-start.md`
- `intake-summary.json`
- `intake-clarifications.json`
- `remediation-brief.md`

Structured auditor reports skip intake and go directly to planning. All other
starting points go through synthesis first, and ambiguous requests pause for a
single batched clarification before findings are extracted.

## Closing

The default closing action is `none`. Actions such as `commit`, `push`,
`open-pr`, `publish`, `tag`, and `custom` record command exit codes and captured
output in `remediation-closing-result.json`; reports only claim success after
the command succeeds. Closing is advanced by a generated `next-step` finalization
command, not the broad compatibility `run` loop.
