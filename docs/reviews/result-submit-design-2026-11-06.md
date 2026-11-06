# Mechanical result writing — design check (2026-11-06)

<!-- review-routing: no-forward-work -->

Status: design-check done; no code. The owner chooses between the options below before any build.

## Proposal under test

The owner (relayed 2026-11-06) replaced D10 decision 2: the reviewer never picks or writes a file
path. A reader ends by running one command (for example `audit-code submit <token>`) with its result
JSON on stdin. The tool validates the result against the schema and the task binding, derives the
destination, writes it atomically, and prints exact errors on a failure. The prompt carries only a
token, at the end. Fallback: the host pipes the reader's final output into the same command. Apply
the same shape to remediate.

## Retirement collision

- `docs/reviews/p25-design-check-2026-08-12.md` §6, owner answer of 2026-08-12: "the submit verb is
  RECOVERY-ONLY — the normal path stays a file write to a tool-owned, expected-set-recorded name".
  The proposal reverses that answer. The owner may do so; this record states it.
- Commit `13dd9288` (2026-06-10) replaced the worker `submit-packet` command with "Do NOT run
  submit-packet or any shell command to record results". Commit `467b1e8f` deleted
  `submitPacketCommand.ts` with the packet substrate.
- What is different now: stdin, not argv (P25 R4, the Windows 32 767-character limit, no longer
  applies); a work-item token, not a packet id (P25 §1.2: ingestion, allowed); immediate validation
  feedback (new).
- What still applies: P25 R3, the recorded shell failures (~15 and ~30 sessions). I measured both
  shells of the owner's main host on 2026-11-06 with one payload, `{"quoted_text":"a\\b \"q\" $x `y`"}`:
  - Bash tool, quoted heredoc piped to node: `a\\b` arrived as `a\b`. One backslash level was lost
    with no error, and JSON reads `\b` as a backspace character, so the quote changes silently.
  - PowerShell tool, here-string piped to node: the global hook `block-powershell-inline-json.mjs`
    refused the command; its stated remedy is "write the JSON to a temp file".
  Findings carry verbatim source in `quoted_text`, and source holds backslashes often. A shell
  payload therefore fails on this host on both shells.

## Independent refutation (AGY, gemini-3.8-flash-high, 6 min), verified

| Lead | Verdict after my check |
|---|---|
| Reverses the P25 owner answer; the shell corpus still applies to a stdin payload | Holds (measured above) |
| A submit verb causes artifact-tree lock contention | Rejected: a validated atomic write to the bound path needs no tree lock; next-step still ingests |
| A token churns the `prompt_sha256` binding | Rejected: a token is per item, as the path is today |
| A remediate reader works in a git worktree, so a cwd-derived root finds the wrong tree | Holds: the command must carry the absolute artifact directory. It is the same for every item, so the shared prompt prefix keeps it |
| No test is red today: the tool already refuses an unbound path | Holds: the change is a new behaviour, and its failing test is the new behaviour's test |
| Alternative: the host writes the reader's final output with its file tool and runs a read-only check | Holds as an option; see C |

## Options

| | A. stdin submit (as proposed) | B. file tool + check by token (recommended) | C. host writes, then checks |
|---|---|---|---|
| Reader picks a path | No | Copies one tool-named path, written with its file tool | No |
| Shell payload | Yes: corrupts backslashes (Bash); refused (PowerShell hook) | None: the command carries only the token | None |
| Validation before the reader ends | Yes | Yes: `validate-results` gains `--work-item <id>`, finds the bound path, applies the ingest judgment including the quote re-read, and reports "no result at the bound path" | Yes, if the host resumes the reader |
| Result passes through the host context | Only in the fallback | No | Yes, every result |
| Owner decision of 2026-08-12 | Reversed | Kept | Kept |
| New verb | Yes (a second normal-path writer beside the file) | No: extends `validate-results` | No |

B in detail: the prompt's per-item tail is the work-item id, the path and the identity values, all
at the end, so the prefix is shared (decision 1-B keeps content out). The last instruction is one
command with an absolute artifact directory and the work-item id, for example
`audit-code validate-results --artifacts-dir <abs> --work-item <id>`. The reader fixes its file and
runs it again until it passes. Remediate gets the same check through the shared host-handoff core.

## Failing tests (for the chosen option)

- B: `tests/audit/host-handoff.test.ts` — `validate-results --work-item <id>` on a missing bound
  result exits non-zero and names the bound path; on a result whose quote is not in the snapshot it
  prints the grounding refusal; on a valid result it exits 0. The remediate twin in
  `tests/remediate/`. Red today: `--work-item` does not exist.
- A: a stdin submit with a backslash-holding quote is written byte-exact and grounds; red today: no
  verb.

## Decision 4 — the owner's design (2026-11-06, after the options above)

The owner rejected A, B and C and asked for a design check of:

1. PRIMARY: an MCP server shipped by audit-tools with one tool, `submit_result(work_item_id,
   result)`. The result is a structured JSON argument: no shell and no escaping. The server judges it
   by the ingest rules (including the quote re-read), derives the bound path, writes atomically, and
   returns the exact refusal so the reader can submit again.
2. FALLBACK for a host without MCP: the reader writes the JSON with its file tool to any file, then
   runs `audit-code submit --work-item <id> --from <file>`. Only an id and a path pass the shell.
3. The prompt carries only the work-item id, at its end. Remediate uses the same shared core.

Refutation lanes: AGY failed twice before it started (headless mode refused the shell tool it
needed; I did not bypass the refusal). An agent-dispatch worker (`xhigh`) read the repository. I
verified each point below against source.

### Retirement collisions

| Decision | What it removed, and why | Verdict |
|---|---|---|
| P25 §6 (owner, 2026-08-12): "the submit verb is RECOVERY-ONLY" | Its reason (R3) was the shell payload: about 15 and 30 sessions lost to inline JSON. | The new design removes the payload from the shell on both routes, so R3 no longer applies. The ruling itself is reversed for the normal path; the owner made that call on 2026-11-06. Record the amendment in the P25 record. |
| `13dd9288` ("Do NOT run submit-packet or any shell command to record results") and `467b1e8f` (deleted `submitPacketCommand.ts`) | `submit-packet` was keyed on a packet, a sizing identity, and went with the execution substrate (P25 §2). | Clean: P25 §2 classes a validating submit keyed on run and work item as ingestion. |
| `a80cb74f` (2026-06-03): removed the MCP server, the `mcp` verb, and postinstall registration of the Claude Desktop MCP server and OpenCode `mcp.auditor` | That server was a second copy of the next-step contract ("a compatibility adapter over the same step contract"). The reason was the duplicate surface, not MCP as a transport. | **Collision to surface.** The new server has another role (result ingestion only), but it brings back per-host MCP registration, which that commit removed on purpose. Tests pin the removal: `tests/audit/audit-code-wrapper-install.test.ts` (no `.vscode/mcp.json`, no `mcp.auditor`) and `scripts/audit/smoke-audit-flow.mjs` (no `mcp_server_launcher_path`). The owner decides whether the removal still holds for a submit-only server. |

### The other checks

- **"audit-tools never launches work".** Holds. The server runs no model and starts no worker; it
  consumes a result, which P25 §2 classes as ingestion. Constraint for the build: the server exposes
  `submit_result` only (and at most a read-only check), never `next-step` or any step verb, or it is
  the retired duplicate surface again.
- **Registration without a manual flag.** postinstall already writes global assets for each host
  (`scripts/shared/install-host-assets.mjs`, `scripts/shared/host-asset-plan.mjs`): the Claude plugin
  directory by path convention, the OpenCode global `opencode.json` by merge, Codex skills, VS Code
  prompt files, Antigravity guides. The server entry goes into the same writes: the Claude plugin's
  MCP declaration, a merged `mcp` key in the OpenCode global config, `[mcp_servers]` in the Codex
  config (TOML through the vetted parser), the VS Code user MCP file and the Antigravity MCP config.
  The exact per-host file names and keys are general knowledge, not verified in this repository; the
  build must verify each against the host's current documentation. The command is the global bin
  (`audit-code mcp`), so no path is baked in.
- **Windows.** A structured argument has no escaping, so backslashes in `quoted_text` arrive intact.
  Quote matching already normalizes CRLF and whitespace (`src/shared/validation/findingGrounding.ts`).
  The atomic write uses the shared `writeFileAtomic` (`src/shared/io/json.ts`), which already retries
  transient Windows errors (`withFsRetry`). The fallback path argument is one token; the prompt
  states an absolute path with forward slashes, as line 2 does today.
- **Do subagents get the tool?** Not established in this repository for any host. Claude Code
  sub-agents get the parent's MCP tools by default (general knowledge; unverified here). Codex, OpenCode,
  VS Code and Antigravity are unverified. The design does not depend on it: the prompt names both
  routes, and a reader without the tool uses the fallback. The tool cannot see which route a host
  supports, so the fallback must stay a first-class route, never a hidden one.
- **Concurrency and stale state.** `checkAuditHostResult` (`src/audit/cli/dispatch/hostHandoff.ts`)
  already judges one result by the ingest rules with no lock and no write. A submit adds one atomic
  write to the bound path — the same write a reader makes today — and the fold ingests later under the
  artifact-tree lock. The server must read the workload and bindings on each call, never cache them:
  after a re-plan the old work item then fails its binding with the exact refusal.
- **Worktree guard.** `WORKER_SAFE_COMMANDS` in `src/audit/cli.ts` is empty, and its own comment
  names "result-scoped submission and validation" as the only class a worker may run from a
  tool-created worktree. `submit` belongs to that class and must join the set.
- **One validator.** `recover-submission --from` (the gate-lane rescue verb) and the new `submit`
  must share the judgment, as `tests/shared/hand-recovery-uses-the-same-validator.test.ts` pins for
  recovery today. A submit through either route records the same ledger events as a file write.

### Smallest failing test

`tests/audit/host-handoff.test.ts`: publish one work item; write a result whose `quoted_text` holds a
backslash to a scratch file; run `submit --work-item <id> --from <file>`. Expect exit 0, the bound
path holding the same bytes, and the check finding no issue. A second result with a quote that is not
in the snapshot exits non-zero with the grounding refusal, and the bound path stays absent. Red today:
there is no `submit` verb. The MCP tool calls the same function, so its test is one call through the
server's handler with the same two cases.

### Residue found on the way (D14)

The `mcp` verb in `wrapper/audit-code-wrapper-lib.mjs` (help line and route to a missing
`dist/cli.js`), and in `scripts/audit/postinstall.mjs` the allow rules for `run-mcp-server.mjs`, the
"command and MCP" comment, and the manual text that still names `mcp.auditor`. The decision-4 build
replaces or deletes them.
