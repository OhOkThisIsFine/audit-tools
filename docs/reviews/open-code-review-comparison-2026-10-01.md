<!-- review-routing: backlog-forward -->
# audit-tools compared with alibaba/open-code-review

Date: 2026-10-01. Source for Open Code Review (OCR): its GitHub README only
(https://github.com/alibaba/open-code-review), read through a summarizer. Its source code was not read.
Treat each OCR claim below as the README's claim, not a verified fact.

## What each tool is

| Axis | Open Code Review (OCR) | audit-tools |
| --- | --- | --- |
| Main job | Review a change (diff, branch range, commit); `ocr scan` also reviews whole files | Audit a whole repository (`audit-code`), then fix the findings (`remediate-code`) |
| Who calls the LLM | OCR calls it: OpenAI- and Anthropic-compatible endpoints, set with `ocr config` | Never audit-tools. The host agent executes every semantic step (conversation-first) |
| Agent-driven mode | "Delegation mode": `ocr delegate preview`, `ocr delegate rule <files>`; OCR selects files and resolves rules, the external agent reviews | This is the only mode. Each `next-step` returns one bounded prompt contract; the host returns a bound result |
| Work partition | "Smart file bundling": related files become one review unit, one sub-agent with isolated context | Content-coherence partitioning into review packets and `work_blocks`; packets are built at dispatch time |
| Review criteria | Rule set (NPE, thread safety, XSS, SQL injection), template-engine matching with path filters | Eleven lenses, single-sourced in `LensSchema` (`src/shared/types/lens.ts`) |
| Accuracy control | Separate comment-positioning and comment-reflection modules | Contract validation at ingestion: task identity, `file_coverage[].total_lines` against real line counts, write-scope checks; citation grounding rejects out-of-range or misquoted citations and never repairs them |
| Deterministic analyzers | Not described in the README | Acquired analyzers (knip, eslint and others) behind `admitSpawn`; their output enters as leads, never as findings |
| Resume | `ocr session list`, `--resume <session-id>` | Every call is resumable; the artifact dependency DAG decides staleness |
| Output | Console, JSON file, PR comments in GitHub Actions, GitLab CI, GitFlic, Gerrit | `audit-findings.json` + `audit-report.md`; `remediation-outcomes.json` + `remediation-report.md`. No PR comments |
| Fixes | None described | `remediate-code`: plan, critique, judge, scoped implementation, triage, close |
| Hosts | Plugins for Claude Code, Codex, Cursor, Kimi Code | Host assets rendered from one prompt body per bin (`src/shared/hostAssets.ts`) |
| Evidence of quality | Benchmark: 50 repos, 200 PRs, 10 languages, 1,505 annotated issues; claims higher precision and F1 than Claude Code at ~1/9 of the tokens, with lower recall | No public benchmark. The benchmark track was retired by the owner on 2026-09-10 |
| Scale of use | Alibaba internal use for two years; 43.2k stars, Apache-2.0 | One owner, no external consumers |

## Where the designs agree

1. Both put deterministic code around the LLM. OCR selects files, bundles them and matches rules
   mechanically. audit-tools does the same with its obligation registry, packets and validators.
2. Both split large work into isolated units with their own context. OCR calls a unit a bundle.
   audit-tools calls a unit a packet or a task.
3. Both let an external coding agent do the review. For OCR this is one mode. For audit-tools this is
   the whole architecture.

## Where the designs differ, and why

1. **LLM ownership.** OCR owns provider configuration and the agent loop. audit-tools deliberately
   owns no provider, model, quota or routing data (the routing substrate was retired on 2026-08-09).
   OCR can therefore tune prompts and tools to one loop and measure token cost. audit-tools cannot
   measure token cost, because the host spends the tokens.
2. **Unit of work.** OCR reviews a change. audit-tools audits a repository state. A diff review needs
   no staleness model. A repository audit needs one, so audit-tools keeps a dependency DAG.
3. **Precision tactics.** OCR adds a reflection pass and a positioning pass after the agent writes a
   comment. audit-tools has citation grounding (`src/shared/validation/citationGrounding.ts`): it
   checks a cited line range against the file's real length and can re-verify a quoted span. The
   remediate draw uses it on finding evidence; the audit draw uses it on charter provenance. The
   important contrast: audit-tools REJECTS a bad position and never REPAIRS it. A repair pass
   (nearest enclosing declaration) was tried and rejected on 2026-07-28, because it replaced an
   honest stale number with a confident wrong one. OCR's positioning module appears to repair.
4. **Fix loop.** OCR stops at the comment. audit-tools continues into remediation with a reviewed
   plan and an enforced write scope.

## Ideas that could transfer (leads, not decisions)

1. **Derive line numbers from the quote.** *Shipped in the same lap as this record: `groundFinding`
   now derives the lines.* Audit ingestion already grounded findings by quote
   (`src/shared/validation/findingGrounding.ts`): each `affected_files`
   entry must carry `quoted_text` or `no_quotable_span`, and the tool re-reads the quote from disk.
   Two gaps remain. The quote matches anywhere in the file, so a short common quote grounds
   trivially. The host-supplied `line_start`/`line_end` are never compared with the quote's real
   position. The fix: the tool locates a unique quote and computes the lines itself. This is not the
   rejected repair, which guessed content from a number; it derives a number from content the tool
   just verified.
2. **Reflection step.** A bounded host step that re-reads each finding against source and drops weak
   ones. This trades recall for precision, as OCR does. It costs one more host step per packet.
3. **Diff-scoped audit.** OCR's main input is a diff. An `audit-code` draw scoped to changed files
   plus their graph neighbours would serve pull-request use. The DAG already supports partial
   refresh.
4. **CI and PR output.** A render of `audit-findings.json` as PR review comments. This is a renderer,
   not a new pipeline.
5. **Per-path rule targeting.** OCR matches rules to files by path filters. audit-tools selects lenses
   per run. Per-path lens targeting could reduce packet size.

Item 2 and the benchmark question touch the retired benchmark track and recall policy. They need an
owner decision before any work starts.
