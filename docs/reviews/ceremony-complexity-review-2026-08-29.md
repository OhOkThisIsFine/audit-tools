# Ceremony and complexity review — 2026-08-29

## Question

Where has this project's ceremony grown past what it buys, in the code and in the
meta-process?

## Result

The product converged. The meta-process did not.

Over two months the `src/` tree grew 8% and its obligation list stabilized at 25 for four
weeks. In the same window the hook layer grew 698%, the script layer 387%, the document
set 392%, and the gate count multiplied by 16. Every `check:*` gate ever added is still
present: **32 added since 2026-07-25, zero removed, ever.**

The cause is one rule with no counter-force. `CLAUDE.md:18` rule (3) says whatever can be
enforced in tooling must be. `PH-05` proposed a cost test as the brake, and the owner
refused that half on the correct ground that a working gate's avoided defects are
unobservable. The generator kept running and nothing retires its output.

This is not an argument to enforce less. It is an argument that the enforcement layer
needs the same single-source discipline the product already has — and today it is
explicitly exempt from it (see F1).

## Evidence boundary

- Worktree `C:/Code/audit-tools/.claude/worktrees/ceremony-complexity-review-6f25d8` at
  `f117ac02`.
- `codebase-memory-mcp` failed to connect this session (`CONNECTION_CLOSED`). Evidence
  came from git history, the repo's own profile ledger in `.audit-tools-profile/`,
  `jscpd`, and direct source reads. No graph claim is made.
- Timings are measured on this machine, not estimated.
- Prior art read first and not re-proposed: `complexity-reduction-audit-2026-08-26.md`
  (CX-01..CX-07, 6 of 7 landed) and `philosophy-simplification-audit-2026-08-26.md`
  (PH-01..PH-10). The settled refusals in `docs/backlog/durable-traps.md` — PH-01, PH-02,
  and the refused halves of PH-04, PH-05, PH-08 — are respected throughout.

---

## Part 1 — The shape of the growth

### G1. The governance layer outgrew the product by two orders of magnitude

| Layer | 2026-07-01 | 2026-08-29 | Change |
|---|---:|---:|---|
| `src/` product | 93,189 | 100,829 | **+8%** |
| `.claude/hooks/` | 495 | 3,950 | **+698%** |
| `scripts/` | 3,895 | 18,981 | **+387%** |
| `docs/` + `spec/` | 5,128 | 25,219 | **+392%** |
| `check:*` gates | 2 | 32 | **×16** |

Executable governance today — hooks, guard scripts, and the tests that test them — is
about 27,000 lines. The documents add 25,219 more. Together they are roughly half the
size of the 100,829-line product they govern.

The product's own obligation count tells the contrasting story: 18 on 2026-07-01, 24 on
2026-07-15, 25 on 2026-08-01, and 25 still on 2026-08-29. The design converged.

### G2. The ratchet has no release valve

I walked every commit that changed the gate list since 2026-07-25. Gates were added on
07-25 (+11, +1, +1), 07-28 (+1, +1), 07-29 (+1, +1), 07-30 (+1), 08-07 (+3), 08-18 (+1,
+3), 08-23 (+1, +1), 08-25 (+1, +1), 08-26 (+1, +1) and 08-27 (+1).

The removal column is empty on every line.

### G3. The gates are cheap in time and expensive in surface

`verify:checks` on 2026-08-29: 120.6s over 38 steps. The cost concentrates in four steps
— `smoke:packaged-audit-code` 35.5s, `check:lint` 33.3s,
`smoke:packaged-remediate-code` 10.8s, `pack:smoke` 8.4s. **All 26 bespoke `check:*`
gates together cost 9.5s.** Step count went 27 → 33 → 38 while total time stayed flat.

Do not simplify these gates to save wall-clock time. There is none to save. Simplify them
to reduce the 11,867-line guard surface and the 15,113 lines of tests that test it.

The per-action tax is small but real: 77ms `shell-trap-guard` + 93ms `pre-commit-gate` +
78ms global `shell-conventions-guard` = about **248ms on every shell call**.

### G4. The real time cost is the test suite, and it regrows after every cut

Full `vitest` runs, first per day, from the repo's own ledger:

| date | files | tests | seconds |
|---|---:|---:|---:|
| 2026-08-01 | 307 | 4,520 | 1,502 |
| 2026-08-11 | 601 | 7,757 | 5,439 |
| 2026-08-12 | 394 | 4,967 | 1,449 |
| 2026-08-29 | 458 | 6,102 | 2,231 |

The 2026-08-12 slimdown cut the suite 35%. It has regrown at about +67 tests per day,
monotonically, ever since. Latest recorded run: 472 files / 6,160 tests / 1,610s.

### G5. Duplication is in tests, not in the product

`jscpd` over `src`, `scripts`, `tests`: 1,004 exact clones, 12,615 duplicated lines
(4.64%). By file kind, summed over clone sides:

- **79.9%** test files (`.test.ts`)
- **12.0%** fixtures and JSON
- **6.7%** production TypeScript
- **1.4%** scripts and hooks

The product source is clean. The `check:dup` gate has a 5.5% threshold against a 4.9%
adoption baseline, has never tightened, and currently constrains nothing.

### G6. Twenty-three of the 32 gates guard paperwork

- 6 are off-the-shelf tools pointed at the product: `tsc` ×2, `eslint`, `knip`, `jscpd`,
  `depcruise`.
- 3 bespoke gates guard product source: `check:control-bytes`,
  `check:shared-primitives`, `check:version-gates`.
- **23 bespoke gates guard documents, registries, or the gate layer itself.**

### G7. The history archive is 65% of the documentation, and nothing can retire it

`docs/reviews/` holds 94 dated documents, 16,419 lines — 65% of all documentation. Fifteen
appeared in the last 14 days.

`scripts/doc-manifest-data.mjs:148-155` excludes them **by construction**, and that
exclusion is load-bearing: `check-doc-code-citations.mjs:209-211` filters its scope through
`excludedMatchers()`, and `scripts/nightly/scope-ledger.mjs` drops them from
`inScopeDocs()`. So no staleness review, drift check, or doc-to-code citation check ever
inspects their content — and nothing can ever mark one spent.

One gate is asymmetric. `check-doc-links.mjs` does **not** import `DOC_MANIFEST`; it runs
`git ls-files -- *.md` (line 40) over every tracked markdown file. So a markdown link into
or out of a review doc is genuinely enforced.

**Correction to an earlier draft of this review.** I first reported 1,499 backticked code
citations in the archive as permanent rename-blockers. That is wrong: backticked citations
are checked by `check:doc-code-citations`, which excludes these files. The enforced surface
is markdown links only — **62 distinct link targets, 38 of them `.ts` or `.mjs` source
files.** The rename-blocking is real but two orders of magnitude smaller than first stated.

The genuine problem is the opposite of over-enforcement: the archive is
**permanently unreviewable and therefore permanently growing.**
`docs/documentation-philosophy.md:47-48` forbids exactly this shape — dated run-narratives
and plans-of-record — and `:57-58` says to retire a doc whose reason to exist has lapsed.
The exclusion makes that impossible to detect.

A full citation census of all 94 files partitions cleanly (counts and lines both reconcile
to the repository totals):

| Class | Definition | Files | Lines |
|---|---|---:|---:|
| A | Cited by a script, hook, skill, `src/`, test, config, or a gate-enforced markdown link | 28 | 6,182 |
| B | Cited only as prose or a backticked name in a doc, a nightly record, or memory | 20 | 3,150 |
| C | Cited only by a sibling `docs/reviews/` file | 19 | 3,561 |
| D | **Cited by nothing, anywhere** | **27** | **3,526** |

Class A must stay. `closeout-generation-failure-2026-08-26.md` is cited from
`.claude/hooks/closeout-challenge-gate.mjs:281`, `cx02-hold-time-measurement-2026-08-29.md`
from `src/audit/cli/auditStep.ts:96`, and `low-tier-phase-cost-2026-08-25.md` from
`src/remediate/steps/contractPipeline.ts:183`. Deleting those breaks live code comments.

Class D is a safe immediate delete. Class C is deletable as a connected cluster, since its
only referents are each other.

### G8. Prose is duplicated at measurable scale

433 distinct sentences of 70 characters or more appear verbatim in two or more files
across `docs/`, `spec/`, `.claude/hooks/`, `CLAUDE.md` and `README.md`. That is 41,712
duplicated characters. The worst single case is an entire document-inventory table shared
by `docs/doc-review-guidelines.md` and `docs/nightly-routine-prompt.md`.

The project's own rule is one home per concept, and the mechanism states the trap so the
prose copy is deleted. The prose layer does not follow it.

### G9. The per-session context tax

An agent loads 93,987 bytes — about 23,500 tokens — before it reads one line of product
code: `CLAUDE.md` 44,000 B, global `CLAUDE.md` 30,973 B, `MEMORY.md` 17,322 B,
`AGENTS.md` 1,692 B. `CLAUDE.md` then points at ten further documents.

`MEMORY.md` was deliberately pruned to 14.8 KB on 2026-08-25. It is 17.3 KB four days
later. The same ratchet operates there.

### G10. Documentation now takes more commit activity than the product

Of 721 commits since 2026-08-01: `docs/` 407 (**56%**), `tests/` 216, `src/` 173 (24%),
`scripts/` 86, `.claude/hooks/` 30. Thirty-six commits in that window match
`fix(hooks)`, `fix(gate)`, `false red`, or `false positive`.

### G11. Counter-evidence, stated because it is decisive

Two guards fired correctly on the author of this review during the review itself: the
global heredoc guard and the project inline-interpreter-escape guard. Both caught real
traps that would have corrupted a file.

The guard layer is not noise, and its individual rules are mostly correct. The problem is
unbounded growth, concentration on paperwork, and the absence of any consolidation
pressure — not incorrectness.

---

## Part 2 — Enforcement-layer findings

Surface measured: 12 hooks (3,950 lines / 2,343 code), 17 `scripts/check-*.mjs` (3,480 /
2,215), 4 `*-data.mjs` registries (1,689 / 1,452), 11 `scripts/shared/generate-*.mjs`
(2,759 / 1,921). `verify:checks` = 38 steps. All 32 `check:*` scripts are wired; there are
no orphans. `GUARDS` holds 91 rows (41 gates, 10 hooks, 40 contract tests).

### F2 — A meta-test returns green on exactly the rows it was written to catch (LIVE HOLE)

`tests/shared/generator-gates-run-at-commit.test.ts:14-17` filters on
`typeof g.fix === "string"`. The two live regenerate-shaped gates registered
`preCommit: false` carry no `fix` field:

- `scripts/guard-reach-data.mjs:176` — `check:loop-core-patterns`
- `scripts/guard-reach-data.mjs:177` — `check:constitutional-doc-paths`

Both are regenerate-shaped by implementation
(`generate-loop-core-patterns.mjs:93-98`, `generate-constitutional-doc-paths.mjs:91-96`
both print a "stale or missing … Fix: node scripts/shared/generate-…" message). Running
the test's own predicate against the live registry yields an empty offender list. Eighteen
gate rows carry no `fix` string and are invisible to it. `check-guard-reach.mjs:118-145`
validates `preCommit` but never requires `fix`, so nothing else closes the hole.

**Consequence at HEAD:** an edit to `src/shared/loopCorePaths.ts` without regeneration
passes a green commit gate and surfaces only in release CI — the exact defect class the
test's own header names.

**Fix:** make `fix` mandatory on gate rows in `check-guard-reach.mjs`, then flip both
rows. `check:loop-core-patterns` is already cited by a REACH row
(`guard-reach-data.mjs:841`), so it is a one-token change; `check:constitutional-doc-paths`
needs a REACH row added. Net **+6 lines. Risk: zero. Do this first.**

### F1 — The "generated artifact + parity check" pattern is implemented 15 times

Fifteen scripts independently implement *read source → render → compare to tracked file →
report stale → exit 1*. Eight independently implement *find BEGIN/END markers, refuse if
missing or duplicated, splice*.

- Ten `--check` generators share a byte-near-identical `main()` and footer: 256 lines
  across `generate-cli-surface.mjs:78-106`, `generate-loop-core-patterns.mjs:81-117`,
  `generate-constitutional-doc-paths.mjs:79-115`,
  `generate-runtime-artifact-names.mjs:111-144`, `generate-executor-producers.mjs:218-251`,
  `generate-filelock-export-surface.mjs:229-262`, `generate-backlog-index.mjs:174-203`,
  `generate-ci-trigger-paths.mjs:102-148`, `generate-spec-mirrors.mjs:650-655`,
  `generate-handoff-roadmap.mjs:650-655`.
- The `invokedDirectly` incantation appears 20 times verbatim across `scripts/`.
- Eight separate splice implementations exist.
- **The generic version already exists and is private:**
  `generate-handoff-roadmap.mjs:385` `spliceGeneratedBlock(...)` is a `function`, not an
  `export function`. `spliceRegion` at `generate-spec-mirrors.mjs:550` is the same
  function with different error prose.
- Two opposite CLI conventions for one operation: `generate-*.mjs` treats bare as *write*
  and `--check` as verify; five `check-*.mjs` scripts treat bare as *verify* and `--write`
  as write.
- **`check:shared-primitives` — the repo's own one-definition-per-primitive gate — scans
  `git ls-files 'src/**/*.ts'` only (`check-shared-primitives.mjs:262`). The enforcement
  layer is the one tree exempt from the repo's own single-source rule.** A targeted
  `jscpd --min-lines 5 scripts/shared` reports 15 clones / 141 duplicated lines / 1.73%,
  every clone a generator tail paired with another generator tail. The repo-wide 5.5%
  threshold cannot see it.

**Fix:** one `scripts/shared/generatedArtifacts.mjs` holding a registry of
`{ id, target, render(), markers?, staleMessage, okMessage }`, one runner exposing
`write`/`check`, and one exported splice. Each generator keeps only its `render()` and its
declaration. Pick one convention. **~250–300 lines removed. Risk: low** — every target is
byte-compared and already has a contract test.

This is the single largest safe win, and it is the same defect class the product tree is
already gated against.

### F3 — Two staged-tree attestation mechanisms, duplicated, with a comment saying they are one

`scripts/attest-constitutional-doc-change.mjs` (186 lines) and
`.claude/hooks/attest-loop-core-review.mjs` (207 lines) differ by about 25 code lines
after renaming the record directory, the predicate and the free-text field. The rest —
argument parsing, `--attester-class` validation, the field-length check, the
`git write-tree` bind, `runDerivedFilePreflight`, the record write — is identical.

`scripts/attest-constitutional-doc-change.mjs:14-16` says outright: *"It is deliberately
the SAME mechanism as attest-loop-core-review.mjs, not a second unrelated one."* It is
nonetheless a second implementation.

The consumer is duplicated too: `pre-commit-gate.mjs:934-998` (60 code lines) and
`pre-commit-gate.mjs:1008-1075` (62 code lines) run the identical seven-step sequence, and
line 952 carries the same "SAME mechanism" comment.

**Fix:** one `stagedTreeAttestation({ recordDir, predicate, requiredField, extraFields,
verdictPolicy })` — a shared producer factory plus a shared consumer the gate calls twice.
**~150 lines removed. Risk: low-medium**; it touches loop-core and needs its own
attestation.

### F5 — Nine gate processes and 35.6 seconds for a one-line backlog edit

Staging one line in `docs/backlog/open-bugs.md` fires ten derived legs plus `npm run check`
plus `test:doc-contract` as **12 separate `npm run` child processes**.

Measured, in order: 535 / 559 / 504 / 738 / 1128 / 1995 / 2586 / 1240 / 493 / 531 ms =
10,309ms for the ten legs; `npm run check` 3,921ms; `test:doc-contract` 21,344ms.
**Total ≈ 35.6s.**

Three of the backlog gates enumerate the directory off disk rather than off the git index
— `check-backlog-budget.mjs:268`, `check-backlog-status-tokens.mjs:130`,
`check-backlog-line-numbers.mjs:111` all call `readdirSync(backlogDir)`. Every other gate
uses `git ls-files` and says why (`check-doc-links.mjs:10-12`,
`check-proposal-red-at.mjs:11`). An untracked scratch file in `docs/backlog/` reds the
build, and a fresh CI clone can disagree with a local run.

**Fix:** one `check:backlog` process that enumerates `git ls-files docs/backlog/*.md`
once and runs four pure predicates. `splitBacklogEntries` in
`scripts/shared/backlog-entry-grammar.mjs` is already the shared segmentation. Collapses
4 npm scripts → 1, 4 `GUARDS` rows → 1, 4 spawns → 1, and fixes the disk-versus-index
inconsistency in the same edit. **~60 lines removed, ~1.8s per backlog commit. Risk: low.**

The four properties themselves are genuinely distinct and all four stay.

### F4 — `test:doc-contract` is a 21-second commit leg outside every registry

Its trigger is hand-coded at `pre-commit-gate.mjs:792-793`, while every other leg's
trigger is derived registry data. It carries no `GUARDS` row: `check-guard-reach.mjs:245-252`
requires a row only for scripts named `check:*`, and this one starts with `test:`, so it
slips the bidirectional reconciliation entirely.

It is also excluded from the attest preflight by design
(`derived-file-preflight.mjs:29-31`). So an attestation can bind a tree the gate then
rejects on doc-contract — the double-attestation trap the preflight exists to close, left
open for the costliest leg.

Measured at 21,344ms. Three of its four test files read nothing under `docs/backlog/`, yet
a one-line backlog edit fires all four.

**Fix:** register it as a `GUARDS` row with `preCommit: 'reach'`, derive its trigger from
the REACH rows of the files its tests actually read, and extend
`check-guard-reach.mjs` to any npm script the gate names. **Net ~5 lines, ~21s off most
markdown commits. Risk: low.**

### F6 — The three Stop hooks each re-implement the same 22-line preamble

`friction-stop-gate.mjs`, `question-philosophy-gate.mjs` and `closeout-challenge-gate.mjs`
independently repeat: environment killswitch → stdin read → JSON parse or exit 0 → event
check → `stop_hook_active` → `sanitizeSessionId` → `readSessionRegistry().isUnregisteredChild`
→ per-session marker file → cap. Each writes its own marker under a private state
directory.

The duplication hides a real divergence: two of the three exit on `stop_hook_active`;
`closeout-challenge-gate.mjs:19-21` deliberately does not. You can only learn that by
reading all three.

**Fix:** `scripts/shared/stopGate.mjs` exporting
`openStopGate({ name, envKill, cap, honorStopHookActive })`. Each hook keeps about four
lines. **~50 lines removed. Risk: low.**

### F8 — Six drift tests re-assert byte-for-byte what their gate already asserts

`tests/shared/runtime-artifact-names-drift.test.ts:29-36`,
`tests/shared/cli-surface-drift.test.ts:37-39`,
`tests/shared/loop-core-gate-parity.test.ts:76-80`,
`tests/audit/executor-artifact-production-declaration.test.ts:275-281`, and
`tests/shared/ci-trigger-paths.test.ts:89-95` each assert that a tracked file equals a
fresh render — which the matching `check:*` gate already asserts in the same
`verify:release` chain. `cli-surface-drift.test.ts:3-4` acknowledges this in its own
header. `loop-core-gate-parity.test.ts` is titled *"the generator's `--check` mode fails
when the generated file is stale"* and never invokes `--check`.

`tests/shared/filelock-export-surface.test.ts:28-30` is the one case where the test is the
sole enforcement. **Keep that one.**

Four separate test files each independently assert "refuses a missing marker pair" and
"refuses a duplicated marker pair" — because each tests its own private copy of the same
splice. F1 collapses those to one shared test.

**Fix:** delete the five redundant parity assertions; keep every behavioral `it()` block.
**~25 lines now, ~60 more once F1 lands. Risk: low.**

### F7 — A `--check` arm wired to nothing

`scripts/shared/generate-filelock-export-surface.mjs:232-250` implements a complete
`--check` branch. Grepping `package.json`, `.github/` and `scripts/guard-reach-data.mjs`
for `filelock-export-surface` returns nothing. Enforcement is
`tests/shared/filelock-export-surface.test.ts:28-30` only.

`knip` cannot see it: `knip.json` lists `scripts/**/*.mjs!` as an entry, so the module is
an entry point and the dead intra-file branch is invisible.

**Fix:** delete the branch, or wire the gate and register the row. Do not do both.
**~21 lines removed. Risk: zero.**

### F11 — "Cite a symbol, never a bare line number" is enforced in one shape, in one directory

Three gates touch this rule and none covers the common case.
`check-doc-links.mjs:113-124` flags `path/file.ts:1946` only inside a markdown link
target. `check-backlog-line-numbers.mjs:72-110` flags a backticked `file.ts:123`, but its
`main()` enumerates `docs/backlog` only. `check-doc-code-citations.mjs:52-53` explicitly
**strips** the `:123` suffix before resolving.

Net effect at HEAD: a backticked `` `src/foo.ts:123` `` anywhere in `docs/` outside
`docs/backlog/` is refused by nothing. `findLineNumberCitations` is already fully generic
and pure.

**Fix:** call it from `check-doc-code-citations.mjs` over its existing tracked-markdown
census and delete `check:backlog-line-numbers` as a separate gate. Folds into F5.
**~40 lines removed. Risk: low-medium** — expect a first-run backlog of newly-visible
citations.

### F9 — 158 code lines of shell-text inference at a boundary git owns

`pre-commit-gate.mjs:241-525` is 285 lines / 158 code of reconstruction: `gitSubcommandRe`
(a regex modelling git's global-option grammar, with a documented accepted false negative
at :238-240), `tokenizeStatement` (a hand-rolled quote-aware shell tokenizer, :328-357),
`cdEffect` (models `cd`/`chdir`/`pushd`/`sl`/`Set-Location`/`Push-Location` including
PowerShell `-Path`/`-LiteralPath`, :378-406), `gitTargetDir` (:407-432),
`statementTargetsThisRepo` (:470-490), and the bypass refusal (:508-525).

A second layer, `.claude/hooks/shell-split.mjs` (310 lines / 186 code), is a shell parser
maintained to support two hooks. **Combined: about 344 code lines of shell parsing to
answer "is this repo about to receive a commit?"**

By contrast the six properties the gate actually enforces are compact: constitutional
refusal 60 code lines, loop-core attestation 62, branch-strand 37, child-session 29,
hook-tracking invariant ~20, derived legs ~35.

This is `PH-05`'s named instance, and the *accepted* half of PH-05 is "move a gate that
guesses at a boundary it does not own". The honest framing is a split, not a deletion: a
real `.git/hooks/pre-commit` gets the staged index and the target repository for free and
needs none of the inference — but `--no-verify` skips it, and refusing `--no-verify` is
exactly what `pre-commit-gate.mjs:508-525` exists to do. So move the six property checks
into a native `pre-commit` hook and keep a ~40-line PreToolUse hook whose only job is the
bypass refusal. The round-trip machinery (`:108-235`, 88 code lines) is **not**
attributable to the boundary choice and stays either way.

**~150–200 lines removed. Risk: high** — loop-core-adjacent, needs a design gate, and the
split must be atomic.

### F10 — `check:offload-lanes` gates a per-machine provider roster

`scripts/shared/offload-lane-data.mjs` (465 lines) holds rows such as
`id: 'freellmapi-router'`, `transport: 'http://127.0.0.1:3001'` (lines 98-120), plus
`mcp-pool`, `mcp-agy-recon`, `mcp-agy-opus`, `mcp-codex-recon`, `mcp-codex-write`. With
`check-offload-lanes.mjs` (243), its contract test and `lane-dispatch.mjs` (251), the
machinery is about 708 lines. **Seven of nine rows are `probe: null`** and enforce nothing
at session start.

The data file states its own boundary problem at lines 39-41: *"The lane AUTHORITY is
`~/.claude/CLAUDE.md` — untracked and per-machine. A gate must not ask the local disk."*
So the gate reconciles a copy of an authority it cannot read, and the divergence between
copy and authority is undetectable by construction.

`CLAUDE.md` states: *"No execution inventory in this package … provider rosters are host
concerns. Do not discover, sync, persist, or route on them inside audit-tools."*

**This is an owner decision, not an agent's.** Either move the registry to
`~/.agent-config/` where the authority lives and delete the in-repo copy, gate, contract
test and rows (**~700 lines**), or record in the registry header why the ban does not
apply, so the next audit does not re-raise it. **Risk: high** — behavioral, and it touches
the offload lanes this repo's own workflow plans around.

### Cost concentration — code per property enforced

| File | Code lines | Properties | Lines/property |
|---|---:|---:|---:|
| `closeout-challenge-gate.mjs` | 287 | 1 | **287** |
| `check-version-gates.mjs` | 235 | 1 | **235** |
| `check-backlog-budget.mjs` | 207 | 1 (+1 ratchet) | ~104 |
| `check-offload-lanes.mjs` + data | 468 | 5 | ~94 |
| `pre-commit-gate.mjs` | 802 | 9 | 89 |
| `check-doc-code-citations.mjs` | 209 | 3 | 70 |
| `check-backlog-line-numbers.mjs` | 82 | 2 | 41 |
| `shell-trap-guard.mjs` | 305 | 8 | 38 |
| `check-guard-reach.mjs` | 220 | 8 | 28 |
| `check-shared-primitives.mjs` | 194 | 28 | **7** |

`check-shared-primitives.mjs` is the density benchmark. `closeout-challenge-gate.mjs` and
`check-version-gates.mjs` are the worst by this measure, but their length is spent on
false-positive suppression, which is the correct trade in this repository. **Neither is
proposed for cutting.** The actionable concentration is F9 and F10.

### Negative results — checked, nothing found

- No orphaned `check:*` script. All 32 appear in `verify:checks`; all 38 `verify:checks`
  tokens resolve to real package scripts.
- No stale hook registration. All 11 `.claude/settings.json` entries match live tool
  events; all 10 hook `GUARDS` rows reconcile.
- `check:control-bytes` versus `tool-input-guard.mjs` Rule 1 is duplicate enforcement, and
  `tool-input-guard.mjs:122` says so — but the hook covers write-time and the gate covers
  merge and import paths the hook never sees. Defensible defence in depth. Not removable.
- The four backlog gates enforce four genuinely distinct properties. F5 is about process
  count and enumeration source, not about merging the properties.
- The 20 REACH rows whose files are multiply claimed are not redundant;
  `guard-reach-data.mjs:1045-1048` declares the overlap as intended.

---

## Part 3 — Source-tree findings

Import counts come from a full relative-import graph over `src/` and `tests/`,
cross-checked with `rg` over `src/`, `scripts/`, `wrapper/` and `dispatch/`.

Total: about **2,020 production lines**, roughly 75% of it in CY-01.

### CY-01 — 14 orphan modules, 1,515 lines, that `check:deadcode` cannot see

`knip.json` sets `"include": ["exports","types","nsExports","nsTypes"]` — no `"files"` —
and `"project"` includes `tests/**/*.ts`, so a test counts as a consumer. Each module
below has zero importers outside itself and its own test:

| File | Lines | Live consumers |
|---|---:|---|
| `src/audit/orchestrator/fileAnchors.ts` | 439 | 1 test |
| `src/audit/validation/anchorGrounding.ts` | 242 | 1 test |
| `src/audit/orchestrator/knipGraphCrosscheck.ts` | 144 | 1 test |
| `src/audit/adapters/semgrep.ts` | 138 | 2 tests |
| `src/remediate/state/accessMemory.ts` | 124 | 1 test |
| `src/audit/orchestrator.ts` | 93 | 1 test |
| `src/audit/adapters/codeql.ts` | 87 | 1 test |
| `src/audit/adapters/astGrep.ts` | 69 | 1 test |
| `src/audit/adapters/eslint.ts` | 49 | 1 test |
| `src/audit/adapters/npmAudit.ts` | 42 | 1 test |
| `src/audit/adapters/coverageSummary.ts` | 31 | 1 test |
| `src/audit/orchestrator/chunking.ts` | 24 | 1 test |
| `src/audit/types/workerResult.ts` | 18 | **none** |
| `src/audit/cli/paths.ts` | 15 | **none** |

Three sub-cases each have a live replacement:

- **`src/audit/adapters/` (6 files, 416 lines) is a superseded parallel normalizer set.**
  `normalizeSemgrepJson` (`semgrep.ts:62`) performs the same mapping the live
  `parseSemgrep` performs at `src/shared/analyzers/candidates.ts:177-204`. The one CLI
  that could reach the adapters — `src/audit/cli/importExternalAnalyzerCommand.ts:6-25` —
  reads the JSON and hands it straight to `runAuditStep`, never calling a normalizer.
- **`src/audit/orchestrator.ts:67` `buildAuditTasks`** carries its own hand-written
  validators. Nothing calls it. The file records an in-place dead-code removal at `:4-6` —
  somebody cleaned *inside* a module that is itself unreachable.
- **`src/audit/cli/paths.ts:10`** documents its consumers at `:8` as
  "renderSemanticReviewStep and cmdRunToCompletion". `cmdRunToCompletion` no longer exists
  anywhere; `semanticReviewStep.ts` does not import it; and
  `src/audit/io/toolingManifest.ts:10-15` recomputes the identical expression locally.
- **`src/remediate/state/accessMemory.ts`** documents itself at `:14-17` as the
  "remediate-side parity of the audit access-memory harvest … so continuity works in both
  orchestrators". It does not: `rg 'access_memory|accessMemory' src/remediate/` returns
  nothing outside that file. The audit half is wired
  (`src/audit/orchestrator/ingestionExecutors.ts:20,252`); the remediate half was built and
  never called.

**This is a re-accumulation, and that is the important part.** Project memory already
records `orphan-modules-are-invisible-to-both-knip-modes` — 5,300 lines hid in this exact
class once before and were deleted. No mechanism was added, so the class refilled.

**Fix:** delete the 14 modules and their orphaned tests, **and in the same commit** add
`"files"` to `knip.json`'s `include` (or a `check:orphan-modules` leg). Deleting without
the mechanism leaves the trap armed, which the repo's own rule forbids.

**~1,515 lines removed. Risk: low-medium.** `src/audit/adapters/README.md` is cited by
`scripts/doc-manifest-data.mjs:253`, so that row drops in the same commit;
`anchorGrounding.ts` is named in prose at `src/shared/tooling/allowlistedExec.ts:27,356`,
which needs rewording, not code.

### CY-02, CY-05, CY-06 — Three hand copies of deliberately single-sourced vocabularies

These are one defect class, and two of the three sit directly beneath a comment warning
against exactly that copy.

**CY-02 — the lens vocabulary, copied three times.** `CLAUDE.md` states the eleven-lens
vocabulary is single-sourced in `LensSchema` and must never be read from a copy.
`src/shared/types/lens.ts:1-8` records the incident: a copy omitting `observability` once
caused a lens to be wrongly rejected. Yet `src/audit/types.ts:5-16` holds an 11-member
string union with the same members in the same order; `:31-43` restates all eleven ids in
`LENS_REGISTRY`, typed `readonly LensDefinition[]`, **so omitting a lens compiles clean**;
and `:51-55` is a second `isLens`. The warning against this is five lines above the
offending code, at `:45-48`.

Fix: re-export `Lens` and `isLens` from shared, and retype `LENS_REGISTRY` as
`Record<Lens, {...}>` so a missing lens is a **compile error**. That is the mechanical
enforcement the invariant demands. ~17 lines, plus one live drift surface.

**CY-05 — severities and confidences.** `src/shared/types/lens.ts:46,52` derive
`VALID_SEVERITIES` / `VALID_CONFIDENCES` from the zod schema options. Audit imports them
(`src/audit/validation/auditResults.ts:9-11`). Remediate re-declares both by hand at
`src/remediate/validation/remediationState.ts:9-10`. Fix: import from shared, delete the
two declarations. Very low risk.

**CY-06 — `AnalyzerConsentDecision` declared twice inside `src/shared`.**
`src/shared/analyzerPolicy.ts:36-39` derives it from a one-member zod enum, and `:25-35`
explains that the rule is enforced by the type rather than remembered.
`src/shared/analyzers/acquisitionEngine.ts:223` then writes
`export type AnalyzerConsentDecision = "declined";` by hand. The barrel exports only the
derived one, so the second is a local shadow.
`tests/shared/consent-token-not-persisted.test.ts` pins the *schema* and cannot pin the
literal — so if a grant arm were ever added, the copy would silently not follow. That is
precisely the failure the decline-only design exists to prevent. ~6 lines.

The rest of the tree gets this right: `ITEM_STATUSES`, `CLOSING_ACTIONS`,
`FLOW_COVERAGE_STATUSES`, `OBLIGATION_KIND_DEFINITIONS` and `RUN_LEDGER_STATUSES` all use
`(typeof X)[number]`. These three are the exceptions, not the rule.

### CY-03 — Six compatibility re-export shims in a project that bans compatibility

The standing decision is *"Ideal code over compatibility. One user, no external consumers
→ cleanest design, delete deprecated/legacy paths."* Six modules exist only to keep import
sites stable, and each says so in its own comment.

| Shim | Lines | Production consumers |
|---|---:|---|
| `src/audit/orchestrator/continuityScore.ts` | 8 | **0** (1 test) |
| `src/audit/validation/quoteGrounding.ts` | 22 | **0** (1 test) |
| `src/audit/reporting/findingRanks.ts` | 6 | 2 |
| `src/audit/orchestrator/selectiveDeepening.ts` | 9 | 1 (a barrel over a barrel) |
| `src/audit/cli/dispatch.ts` | 20 | 2, both importing one symbol |
| `src/remediate/steps/dispatch.ts` | 26 | 1, importing one symbol |

The two `dispatch.ts` barrels are the sharpest case: **their host-handoff re-export blocks
have zero production consumers.** Every production site imports the submodule directly and
bypasses the barrel. `src/remediate/steps/nextStep.ts` imports through the barrel at `:60`
*and* around it at `:69`, in the same import block.

**91 production lines removed**, plus one of two addressing schemes for about 20 symbols.
Risk: low. `tests/remediate/backend-independent-planning.test.ts:83` does `vi.mock` on a
barrel path, so that mock must move to the real module in the same commit or it silently
stops intercepting.

### CY-04 — Eight `canEvaluate*` predicates that restate the guard each validator owns

`src/remediate/validation/contractPipelineGates.ts:1629-1707` holds eight predicates plus
a helper, 79 lines. `canEvaluateDesignSpec` (`:1675-1677`) is `return isRecord(x);` — a
one-line wrapper with a single caller. The runner at `:1824-1893` is eight structurally
identical `gateOutcome(name, canEvaluateX(...), validateX(...), "prose reason")` calls.

**The duplication is proved by the function's own doc comment** at `:1795-1822`, which
enumerates, gate by gate, the internal guard each validator already applies. Every one of
those is restated verbatim as a `canEvaluate*` body.

This is a live drift surface: loosening a validator's internal guard without editing its
twin makes `evaluated` lie — and `evaluated` exists precisely to distinguish "ran clean"
from "never ran" (`:1710-1714`).

Fix: each gate returns `{evaluated, reason?, issues}`, so the guard is stated once inside
the validator that owns it; the runner collapses to a table. **~120 lines. Risk: medium**
— issue text and canonical gate order are pinned by OBS-cca3801c and must stay
byte-identical.

### CY-08 — The whole-repo line walk runs 2–3 times per fold

`src/audit/cli/lineIndex.ts:47-70` `buildLineIndex` walks every file in the repo manifest.
A memo exists specifically to stop the fold recomputing it —
`nextStepHelpers.ts:2002-2023`, whose own comment says recomputing per dispatch "would
regress the drain's cost profile".

**The memo has exactly one call site** (`:1948`). The host-delegation path — the product's
most common path — bypasses it twice: directly at `:2736-2738`, and again through
`runAuditStepUnlocked` at `:2776` → `src/audit/cli/auditStep.ts:187-189`.

The comment at `:2731-2733` shows the coupling was deliberate — both gates must see the
same disk truth — but it achieves sameness by recomputing rather than by sharing.

Fix: route `:2737` through the memo and thread the result into `runAuditStepUnlocked` as an
optional pre-built input. **~8 net lines, but it removes 1–2 full-repo file walks per
fold. Risk: low** — the memo already keys on manifest object identity.

### CY-09 — Every accepted audit result is put through the identical rule walk twice

Pass 1 at accept: `src/audit/cli/dispatch/hostHandoff.ts:1145-1149`. Pass 2 at the batch
gate: `src/audit/cli/auditStep.ts:229-231`. Both entry points call the same
`validateSingleAuditResult` (`src/audit/validation/auditResults.ts:1053`);
`validateAuditResults` adds only an `Array.isArray` check and a stderr count line. **No
cross-result rule exists.** The inputs are made identical by construction, and orphans are
already filtered out of `pendingAccepted`.

`validateSingleAuditResult`'s helper scores 42 on cognitive complexity, and the walk is
O(all accepted results) per fold, not O(new).

**Risk: medium, and here is the honest caveat.** The passes are provably identical *within*
a manifest generation, but a result accepted in an earlier fold could have been validated
against a task manifest that re-planning has since changed. The safe form skips
re-validation only for results accepted under the current manifest. Do not delete
`validateAuditResults` — it remains the sole gate for the CLI entry points.

### CY-07 — Review-snapshot lifecycle written twice

`src/audit/orchestrator/designReviewSnapshot.ts` and
`src/remediate/contractPipeline/reviewSnapshot.ts` implement the same store step for step:
the `as const` schema version (`:46` / `:54-55`), the record shape (`:48-57` / `:57-66`),
`snapshotDir()` + `snapshotPath()` (`:64-75` / `:68-77`), the
`discardOnSchemaVersionMismatch(await readOptionalJsonFile(...)) ?? null` read (`:77-91` /
`:94-106`), the `mkdir` + `writeJsonFile` write, and a delta fold ending in the identical
`return { changedInputs, allUnchanged: changedInputs.length === 0 };`. Both files
independently document the same rationale in different words.

`src/shared/reReview/projectionDiff.ts` took the diff and render leaf but not the
lifecycle around it. Genuinely per-mode and preserved: the input universe, the projector,
sync-versus-async as a consequence, and audit's extra `isDesignReviewStale`.

Fix: a shared `reviewSnapshotStore<TKey, TPayload>({ dirname, schemaVersion, payloadKey })`.
The varying part is two functions, not eight, so this is a real policy seam and not the
configuration shell the prior audit rejected for host handoff. **~140 lines. Risk: medium**
— audit's read must stay synchronous over a pre-loaded bundle.

### CY-11 — The transitive-staleness fixpoint is hand-rolled twice, in opposite directions

`src/audit/orchestrator/staleness.ts:348-388` and
`src/remediate/contractPipeline/artifactStore.ts:344-357` each hand-write the same
`while (changed)` closure loop over a declared dependency map. The per-edge compare above
each is the same shape too. `src/shared/graph/directedCycles.ts` exists — CX-01
consolidated cycle detection into it — but exposes no reachability helper, which is why
both hand-rolled one.

**Risk: medium, and this is the highest-risk item in Part 3.** Audit's loop carries real
policy inside the walk: slice-projected edges defer rather than propagate (`:378-386`,
INV-SSP-DEFERRED-SET-REPORTED), plus revision comparison and a metadata-migration
degrade-to-all-stale branch. A shared primitive with a `hold` callback risks becoming the
configuration shell the prior audit rejected. **Do this only if the callback stays to one
predicate. Otherwise leave both.** ~35-45 lines.

### CY-12 — The bound-prompt identity chain is duplicated verbatim

Seven conditions appear verbatim in both `parseWorkItem` implementations, differing only
in the ordering of two lines: `src/audit/cli/dispatch/hostHandoff.ts:636,639,645-649` and
`src/remediate/steps/dispatch/hostHandoff.ts:1088,1094,1096-1101`.

Fix: one shared `parseBoundPromptIdentity` in
`src/shared/submission/hostHandoffCore.ts`, plus its `buildBoundPrompt` inverse. **~16
lines. Risk: low, but scope it tightly** — the prior audit rejected *full* host-handoff
unification, and the two sides carry a genuine trust-model divergence worth preserving:
remediate re-derives the canonical item from trusted state and byte-compares
(`:1119-1121`), while audit accepts the file's fields after shape checks and cross-checks
via `validateHandoffBinding` (`:755`). Do not unify that asymmetry away without deciding
which model is right.

### CY-15 — `collectFiles` implemented twice, and the copies disagree on determinism

`src/audit/io/toolingManifest.ts:35-50` sorts entries with `compareCodeUnits` before
descending. `src/remediate/validation/artifacts.ts:102-115` **does not sort**: its output
order is `readdir` order.

This is more than duplication. The project invariant is *"Extractors emit stable,
content-derived array order … never filesystem / `readdir` / iteration order."* The
remediate copy violates it, so its validation-issue ordering is filesystem-dependent.

Fix: one shared `collectFilesSorted(path)` taking the union of both behaviours. **~14
lines**, and it fixes the ordering defect as a side effect. Expect a fixture update, and
treat that diff as the bug being fixed.

### CY-10, CY-13, CY-14 — Smaller items

**CY-10.** `src/remediate/steps/dispatch/hostHandoff.ts:279` schema-parses the plan, then
`:331` returns the **raw** value; `:988` re-parses the same findings with
`FindingSchema.parse` — a throwing call on a path that can no longer legitimately fail.
Fix: carry `parsedPlan.data`. ~3 lines. **Caveat:** `FindingSchema.parse` also normalizes
before the finding reaches `promptSha256`, so use `parsedPlan.data` (which preserves the
normalization), not the raw value, and verify prompt bytes against a digest fixture.

**CY-13.** Five one-field or alias types with one construction site each:
`EvidenceGrounding` (`src/remediate/phases/grounding.ts:164-167`),
`LaneValidationContext` (`src/audit/cli/laneValidators.ts:155-158` — while `:89` takes the
identical value bare in the same file), `DetectedCycle`
(`src/remediate/contractPipeline/cyclicSeamResolution.ts:32-35`, wrapping a `string[][]`
the helper already returned, with all six reads unwrapping `.members`),
`UnresolvedConstraintClause` (`src/audit/orchestrator/intentInterpreter.ts:95`, where 8 of
9 lines are a comment explaining the alias), and `CrossLensDedupResult`
(`src/remediate/dedup/crossLensDedup.ts:9` — two names one character apart for one shape).
Plus `AnchorRunner`, `RemediationStepStatus`, and `FindingsContainer`. **~35 lines, very
low risk.**

**CY-14.** The `InterpretedClause[] → ConstraintClauseRecord[]` projection is byte-identical
at `src/audit/orchestrator/intentInterpreter.ts:126-134` and
`src/remediate/steps/nextStep.ts:3586-3594`. `src/shared/intent/constraintClauses.ts`
already owns its downstream half and its header states the one-core-two-draws principle;
this projection is the missing member of that module. **~9 lines, very low risk.**

### The 15 largest files, characterized

Size alone is not a finding. This is where the lane looked and what it concluded.

Genuinely essential: `contractPipeline.ts` (4,440 — a real pipeline, 1,260 comment lines),
`nextStepHelpers.ts` (3,159 — the single obligation registry and fold, post-CX-02),
`close.ts` (2,062), `nextStepCommand.ts` (1,488 — its `NEXT_STEP_EMISSION_TABLE` at
`:1429` is the single-table dispatch shape the ceremony findings elsewhere ask for),
`languageMap.generated.ts` (1,456, generated), `auditResults.ts` (1,155),
`candidates.ts` (1,148 — the live counterpart to the dead adapters), `graph.ts` (1,085 —
31 small single-purpose extractors, already well decomposed), `advance.ts` (932).

Two carry real weight:

- **`src/remediate/steps/nextStep.ts` (4,450) is the one genuine split candidate.**
  `decideNextStep` (`:3263`) is a real state machine, but the file also holds
  intent-interpretation persistence (`:3538-3697`), `recoverIngestHostResults` (`:952`),
  friction closeout (`:1240`), path-A filter dispositions (`:1806`), and *two* obligation
  registries (`:3765`, `:4045`). Several are separable without touching the machine.
- **`src/remediate/steps/dispatch/hostHandoff.ts` (2,571)** — `ingestRemediationHostResults`
  (`:2204`) scores 80 on cognitive complexity in one ~500-line function mixing
  corroboration, test rerun, recovery marks and state mutation. Worth a decomposition pass
  on its own merits.

Best remaining readability target outside the top 15:
`src/shared/decompose/charterExtraction.ts` (784 lines, 7 functions) — `assembleCharters`
(~200 lines, CC 44) and `assembleDeltas` (~225 lines, CC 61) are two monoliths.

ESLint `sonarjs/cognitive-complexity` at 25 reports **58 production functions above
threshold**, topping out at 104. It was used only to choose where to look. No finding rests
on a score.

### Verified and explicitly NOT reported

- **`schemas/*.json` are generated, not hand-duplicated.** All six are registered in
  `WORKER_SCHEMA_SOURCES` (`src/audit/contracts/workerSchemas.ts:94-114`) and pinned by
  `tests/audit/worker-schema-generation.test.ts:27-36`. Fields cannot drift. The ~540
  redundant JSON lines from `$refStrategy: "none"` are a deliberate trade: a schema handed
  to an external worker that will not resolve `$ref` should be self-contained.
- **`accessMemory` as an algorithm** is a textbook one-core-two-draws pair. It appears in
  CY-01 only because nothing calls the remediate side.
- **`src/audit/validation/artifacts.ts` vs `src/remediate/validation/artifacts.ts`** —
  sibling names, genuinely different algorithms. Legitimate.
- **`RemediationHostHandoffRecordSchema` `V1ALPHA1`** looks dead by construction count but
  has a live read path recovering pre-0.50.2 state. Legitimate migration union.
- **`src/shared/index.ts`** (1,191 lines, 188 re-exports) is a second addressing scheme
  alongside `./shared/*`, but the prior audit rejected barrels as a finding class and
  nothing here overturns that.
- **Single-field persisted envelopes** are correctly objects; `CriticalFlowManifest`
  already gained a sibling field, proving the shape earns itself.

Adjacent, outside the brief: `src/remediate/utils/fileIntegrity.ts:82-125` and `:233-328`
are the same directory-digest walk written twice — intra-tree, not cross-mode. The repo
root also holds five zero-byte shell-redirect artifacts (the known
`repo-root-empty-files-are-shell-redirect-artifacts` trap), not a source finding.

## Part 4 — Document and process findings

**The code-change path is lean. The document path is where the cost is.** A two-line `src/`
fix fires 2 pre-commit legs. The closeout commit that must accompany it fires 11, nine of
them document governance.

Every finding here reduces the *cost* of a step. None drops a step. PH-08's refusal of any
lightweight closeout (`docs/backlog/durable-traps.md:871-873`) is respected throughout.

### Two corrections to this review's own premises

Both were checked and both failed. Recording them so the next pass does not repeat them.

1. **`doc-review-guidelines.md` (427 lines) and `nightly-routine*.md` (1,282 lines) are not
   per-turn tax.** They are leg-1 inputs to the headless nightly task only; the consumer is
   `~/.claude/scheduled-tasks/nightly-maintenance/nightly-prompt.txt:7`. An interactive
   agent never reads them. That is 1,709 lines wrongly attributed.
2. **The backlog machinery is smaller than the backlog, at 0.72 : 1.** Content is 2,360
   lines across 5 files and 224 entries. Enforcement is 875 lines of scripts plus 820 lines
   of contract tests = 1,695. Each gate has a documented incident behind it and is
   well-calibrated. `check-backlog-budget.mjs:17-32` even records that it corrected *itself*
   after refusing a factually correct edit that cost 14 bytes: *"A gate that makes
   correcting a fact cost more than leaving it wrong is worse than no gate."* **None of
   these should be removed.**

### The measured per-turn tax

| Class | Bytes | ≈ tokens |
|---|---:|---:|
| Always injected — repo `CLAUDE.md`, global `CLAUDE.md`, `MEMORY.md` | 92,295 | ~23,100 |
| Mandated at lap start — `/start-lap` step 3 + 5 backlog files + index + `HANDOFF.md` | 266,349 | ~66,600 |
| **Combined before any work begins** | **358,644** | **~89,700** |

### C-08 — 862 tracked lines of which 847 are byte-copies of two other tracked files

**The largest single duplication in the repository.** Verified by `diff`, exit 0, zero
differing lines: `docs/nightly-routine-prompt.md:435-861` is byte-identical to
`docs/doc-review-guidelines.md:1-427`, and `:12-431` is byte-identical to
`docs/nightly-routine.md:1-420`. The generator
(`scripts/check-nightly-routine-prompt.mjs:32-56`) is pure concatenation and says so: *"The
two canonical contracts follow verbatim."*

The only consumer is `nightly-prompt.txt:7` — *"read `docs/nightly-routine-prompt.md`"*.
The scheduler performs one read of one path. **Nothing requires the two sources to be
pre-joined.**

Cost of that one convenience: 862 tracked lines (3.4% of docs+spec), a 140-line parity
gate, `check:nightly-routine-prompt` in `verify:checks`, the same gate again as a
reach-triggered pre-commit leg, a guard-registry row, and
`tests/shared/nightly-routine-prompt-gate.test.ts`.

**Fix:** change one line outside the repository so the nightly prompt names the two source
documents. Then delete the generated file, the check script, its npm script, its
`verify:checks` leg, its pre-commit leg, its guard row, and its test.

**862 doc lines + ~140 script lines + 2 legs + 1 guard row + 1 test removed. Zero
behavioural change. Very low risk.** This is the single largest win in the audit.

### C-10 — 27 review documents cited by nothing, and no mechanism can ever retire them

See G7 for the full census. The immediate delete set is **Class D: 27 files, 3,526 lines,
with zero citations in the repository, in the external memory index, or from a sibling
review document.**

Many of them document a subsystem `CLAUDE.md:301-303` says was deleted outright: *"the old
provider, quota, routing, backend-sizing, and launch substrate was retired as one
architectural cut; do not recreate it."* Examples with line counts:
`backlog-triage-2026-07-25` (312), `dedup-cluster-2026-08-07b` (247),
`h2-h4-collapse-plan-2026-07-18` (218), `g2-5-source-emitter-plan-2026-07-16` (213),
`dispatch-fork-assessment-2026-07-16` (191), `g2-repo-session-intent-plan-2026-07-16`
(189), `account-metering-design-of-record-2026-07-19` (179),
`s2-sizing-window-design-check-2026-08-09` (167).

**Fix:** `git rm` the 27 now — git retains the history. Then add an existence-review leg for
`docs/reviews/`: a dated record older than N days with zero inbound citations is *proposed
for retirement* rather than left permanently unreviewable. Without that leg the archive
refills, exactly as the orphan-module class did (CY-01).

**~3,526 lines immediately; up to 7,087 if Class C goes with it. Very low risk.**

### C-01 — `/start-lap` mandates the verbatim read its own index exists to prevent

`.claude/skills/start-lap/SKILL.md:50-52` orders: *"Read `docs/HANDOFF.md` and the split
backlog under `docs/backlog/` with the Read tool (these must be verbatim)."*

`docs/backlog.md:20-23` says the opposite: *"`open-bugs.md` is past what one read call
returns. Read THIS list once, then jump straight to an entry with an offset read at its
`file:line` anchor — that is what makes the open-work record navigable in bounded reads
without splitting it."*

The literal reading costs 220,748 bytes — about **55,000 tokens per lap**.

**Fix:** change step 3 to read `HANDOFF.md` plus the generated seek index (310 lines), then
offset-read only the anchors the lap goal needs. **One single-file edit. ~55,000 tokens per
lap. Low risk.**

### C-02 — About 35% of `CLAUDE.md` is history the same file's rules route elsewhere

Fifteen of 353 lines carry 15,259 of 44,000 bytes.

| Site | Bytes | Why it is history |
|---|---:|---|
| `CLAUDE.md:224-247` | 2,340 | A prose inventory of all 13 hooks — immediately followed by `:248` *"Guard wiring + reach are DECLARED DATA, never prose"* and `:252-253` *"The registry — not this paragraph — is the authoritative list"* |
| `CLAUDE.md:282-300` | 1,907 | The routing-removal narrative, including two *"(owner, 2026-08-09, superseding the same day's …)"* clauses recording intra-day decision churn. The rule is one sentence; the rest is provenance |
| `CLAUDE.md:314` | 3,374 | Own-versus-acquire. States its own mechanism is already pinned by `tests/shared/consent-token-not-persisted.test.ts` |
| `CLAUDE.md:258` | 2,884 | The 8-step closeout — a verbatim fourth copy (see C-04) |

The governing rule is in the same file at `:217-221`: *"A trap that can be enforced is
enforced, and its backlog entry is DELETED rather than restated … a contract test … is
equally binding and equally self-describing, so it earns the same deletion."*

**Fix:** apply that rule to `CLAUDE.md` itself. Replace `:224-247` with one pointer to
`scripts/guard-reach-data.mjs`. Cut `:282-300` to the two-sentence rule; the provenance is
in `git log` and a review doc. Cut `:314` to the rule plus the test name.

**~7,600 bytes, about 1,900 tokens off every session. No rule lost** — each survives as
rule plus mechanism pointer.

### C-04 — The closeout schema exists in four full copies, and a fifth defines a different procedure

1. `~/.claude/portable-engineering-principles.md:202-210` — canonical, 8 steps.
2. `~/.claude/CLAUDE.md` — 8 steps, declaring itself the "local expansion".
3. `<repo>/CLAUDE.md:258` — 8 steps, 2,884 bytes, declaring itself the "LOCAL EXPANSION,
   not a second definition".
4. `docs/project-philosophy.md:294-301` — the same 8 as prose.
5. **`~/.claude/skills/closeout/SKILL.md:6-32` — a different 7-step procedure**, headed
   *"Run every step below, in order. Do not skip a step."* Its steps 1-2 invoke
   `verify-green.mjs`, which the global `CLAUDE.md` explicitly says do not apply here:
   *"audit-tools keeps its own equivalent (`suiteGreenStamp` + closeout Stop gate); do not
   double-wire there."* Its step 6 (an independent auditor subagent) appears in no
   repository-side definition.

Copies 1-3 each carry the same self-defence — *"Adding, dropping, or reordering a step in
one without the other is drift"* — which is a drift test made of remembering, the exact
thing `docs/project-philosophy.md:83` bans.

**A 7-step and an 8-step closeout are both currently marked mandatory. That is a live
contradiction, not a stylistic one.**

**Fix:** keep the canonical list in `portable-engineering-principles.md` only. Replace the
repo `CLAUDE.md` enumeration with the repo-specific *bindings* — commands, destinations,
the renderer invocation — plus a pointer. Delete the `project-philosophy.md`
re-enumeration. Then reconcile the skill: state which of its 7 steps audit-tools overrides,
or scope the skill out of this repository. **4 copies → 1. Risk: medium** — it touches
machine-wide configuration, so it needs the owner's scope decision (see below).

### C-03 — The two rules that forbid duplication are the most duplicated rules in the repository

*"Whatever can be enforced in tooling must be"* has **7 hand-maintained homes**:
`CLAUDE.md:18`, `:196`, `:211`, `docs/project-philosophy.md:49`, `:149-158`,
`docs/doc-review-guidelines.md:228`, `spec/audit/audit-goals.md:31`. Three further copies
are legitimately generated and are not violations: `README.md:31`,
`docs/nightly-routine-prompt.md:662`, and the runtime extraction in
`question-philosophy-gate.mjs:136`.

*"One home per concept"* has **5 in-repo homes**: `docs/documentation-philosophy.md:19`
(canonical), `docs/project-philosophy.md:83`, `:307`, `docs/doc-review-guidelines.md:40`,
`docs/end-of-sprint-report-template.md:86`.

**The root cause is structural, not accidental.** `docs/project-philosophy.md:3-8` designs
itself as a second copy — every section ends *"(home: CLAUDE.md → X)"* and the document
states *"when this map and a home ever disagree, the home wins."* It then restates each
conviction a **second** time internally: once in THE BRIEF (`:42-94`), once in the map
(`:99-344`), acknowledged at `:35-38`.

**Fix:** the brief is already single-sourced and machine-consumed, by
`check-philosophy-brief.mjs` and by the runtime extraction in
`question-philosophy-gate.mjs`. Delete the PART A/B map (`:99-344`) and keep the brief plus
a homes table. Promote A8 (`:215-217`, which self-declares *"home: this brief — no other
doc owns these three"*) into the brief first. **~245 lines. Risk: medium.**

### C-09 — The document half of the closeout is gated five times harder than the code

Evaluated against the live derivation, not the prose. `buildPreCommitLegs` over real staged
sets:

| Staged set | Legs fired |
|---|---:|
| `src/audit/orchestrator/staleness.ts` | **2** |
| + its test | 2 |
| + `docs/backlog/open-bugs.md` + `docs/HANDOFF.md` (the closeout commit) | **11** |
| Documents only | 10 |

The 9 extra legs are `check:doc-manifest`, `check:doc-code-citations`,
`check:handoff-roadmap`, `check:backlog-index`, `check:backlog-budget`,
`check:backlog-status`, `check:backlog-line-numbers`, `check:memory-citations`,
`check:doc-links`. The closeout touches those files every sprint by construction, so all
nine run every sprint.

**Fix (cost, not step):** let the closeout commit once. `docs/backlog/minor-bugs.md:410`
already specifies it — the session registry records a dirt baseline but **no starting
HEAD**, so the closeout's commit list, changed-doc list, cleanliness and pushed state stay
author-supplied when all four are derivable. Recording `HEAD` at session start makes the
render self-populate. **0 steps dropped; about 4 of 7 closeout sections become
machine-filled and one commit round-trip disappears.**

### The full mandatory sequence for one two-line fix

About **14 mandatory stages and ~25 discrete gate executions**, of which the code change
itself accounts for 3.

Load-bearing for a small change: the three SessionStart hooks, `/start-lap` steps 1-2, the
Edit-time guard and async typecheck, red-green validation of the regression test, the
commit gate, and the closeout itself.

Fixed overhead regardless of change size: `/start-lap` step 3's verbatim backlog read
(C-01), the full `npm test` re-run on the final tree, and the 11-leg closeout commit (C-09).

Correctly conditional: `/design-check` says outright *"Skip for trivial mechanical edits;
say so in one line and go."* The loop-core attestation fires only inside 12 declared path
patterns.

**Correction on the Stop chain.** Only `closeout-challenge-gate` reliably fires.
`friction-stop-gate.mjs:70-98` exits 0 unless a recent audit or remediate run is on disk —
for an ordinary bug fix it never fires. `question-philosophy-gate.mjs:98` exits 0 unless
the final message's last line ends in `?`. An earlier draft of this review overstated the
ordinary path.

### C-07 — A backlog file reached the generated machinery and none of the prose

`minor-bugs.md` (448 lines, 54 entries) was added 2026-08-28. It is present in the
generated half: `scripts/shared/generate-backlog-index.mjs:68`, 54 indexed rows in
`docs/backlog.md`, and `scripts/doc-manifest-data.mjs:105`.

It is absent from every hand-maintained routing table:

- `docs/backlog.md:12-15` — the router table lists four files. No `minor-bugs` row.
- `docs/documentation-philosophy.md:28` — the canonical-homes table omits it.
- `.claude/skills/disambiguate-backlog/SKILL.md:29` — scope is three files, so **54 entries
  are permanently out of scope for the disambiguation pass.**

This is the repository's own thesis demonstrated: the generated half tracked reality; three
prose copies drifted the moment a file appeared.

**Fix:** add the row in three places, or better, generate `backlog.md`'s router table from
the file list `generate-backlog-index.mjs` already holds. **+3 lines; closes a 54-entry
coverage hole. Very low risk.**

### C-05 — A document claims to be generated from the registry, and nothing checks it

`docs/end-of-sprint-report-template.md:80-81` asserts: *"Adding or removing a section is a
registry edit, not a prose edit — the renderer, the refusal message, and this document's
list all follow from `closeout-sections-data.mjs`."* Lines 56-76 then restate all seven
sections and their prompt text **by hand**. The only consumers of `CLOSEOUT_SECTIONS` are
in `scripts/render-closeout.mjs`; no check script, test, or manifest entry reads the
template document.

**Fix:** generate `:56-76` behind markers using the existing `check-philosophy-brief.mjs`
pattern, or delete the list and have the document invoke
`node scripts/render-closeout.mjs --help`, which already prints every section's prompt.
**21 lines, or one line of gate wiring. Very low risk.** It closes a false mechanical claim.

### C-11 — Thirteen `durable-traps.md` entries name a live guard

`CLAUDE.md:217-218` says a trap that can be enforced is enforced, and its backlog entry is
**deleted** rather than restated. Thirteen entries at `durable-traps.md:68, 84, 100, 175,
204, 374, 467, 523, 531, 539, 642, 795, 825` each name a live hook, `check:*` gate, or
contract test.

**Caveat that changes the recommendation:** `CLAUDE.md:221-224` says a trap enforced only
*partly* is **not** deletable — the uncovered half must be stated. At least one of the 13
(`:795`) is explicitly in that class and must stay. **This needs a per-entry check, not a
bulk delete.** Estimated 8-11 entries, ~120-160 lines.

### C-06 — A backlog entry overstates a problem that is mostly already fixed

`docs/backlog/minor-bugs.md:412` says three consumers hold independent copies of the
friction taxonomy. Verified at HEAD, two of the three are covered:
`.claude/hooks/friction-stop-gate.mjs:70` is a hand copy but is **pinned** by
`tests/shared/friction-derived-observations.test.ts:253-260`, and
`scripts/closeout-sections-data.mjs:20` **imports** `FRICTION_CATEGORIES` and throws at load
on a missing label.

The genuine duplicate is a different thing: two exports named
`FRICTION_CATEGORY_LABELS` — `src/shared/friction/triage.ts:115-122` and a private copy at
`scripts/closeout-sections-data.mjs:27-34`, same keys, different prose, no gate between
them. **Assessment: these are two legitimately different renderings for two audiences, so
this is not a dedup target.** The finding is only that the backlog entry is stale. ~4 lines.

---

---

## Part 5 — The root cause, and the one structural change

Every finding above is an instance, not the disease. The disease is that this project has
a rule that **creates** enforcement and no rule that **consolidates** it.

Three facts, each verified independently, make the same point:

1. **32 gates added, zero removed, ever.** There is no retirement path, by construction.
2. **`check:shared-primitives` — the repository's own one-definition-per-primitive gate —
   scans `git ls-files 'src/**/*.ts'` only** (`check-shared-primitives.mjs:262`). The
   enforcement layer is the single tree exempt from the rule it enforces. That is why F1
   found the same pattern written 15 times and C-03 found the anti-duplication rule stated
   7 times.
3. **Two known traps refilled after being emptied.** Project memory records
   `orphan-modules-are-invisible-to-both-knip-modes`; 5,300 lines were deleted from that
   class once, no mechanism was added, and CY-01 finds 1,515 more. `MEMORY.md` was pruned
   to 14.8 KB on 2026-08-25 and is 17.3 KB four days later.

**This is not the refused half of PH-05.** That half asked for an
avoided-defect-versus-false-positive bar, and the owner correctly refused it because a
working gate's avoided defects are unobservable. Nothing here trades enforcement for cost.
Every recommendation keeps every enforced property; the substrate underneath simply stops
being written fifteen times.

**The one structural change: point the repository's own single-source gates at the
governance tree.** Extend `check:shared-primitives` beyond `src/`, and add `"files"` to
`knip.json`'s `include` so unreferenced modules are visible. Those two edits are what stop
F1, C-03, and CY-01 from refilling after this review lands. Deleting without them repeats
2026-08-12, when a 35% suite cut regrew at +67 tests per day.

---

## Consolidated plan

Grouped by risk. Lines are removals unless marked `+`.

### Tier 0 — Do first; fixes live defects, near-zero risk

| # | ID | Action | Lines | Risk |
|---|---|---|---:|---|
| 1 | **F2** | Require `fix` on gate rows; flip the two flagless rows | +6 | zero |
| 2 | **CY-01a** | Add `"files"` to `knip.json` include | +1 | zero |
| 3 | **F7** | Delete the unwired `--check` arm | −21 | zero |
| 4 | **C-07** | Register `minor-bugs.md` in the 3 prose tables | +3 | very low |

F2 closes an open hole: an edit to `src/shared/loopCorePaths.ts` without regeneration
currently passes a green commit gate. CY-01a is the mechanism that must land *with* the
CY-01 deletion, not after it.

### Tier 1 — Large, safe deletions

| # | ID | Action | Lines | Risk |
|---|---|---|---:|---|
| 5 | **C-08** | Point the nightly prompt at its two sources; delete the joined file, gate, npm script, 2 legs, guard row, test | **−1,002** | very low |
| 6 | **CY-01b** | Delete the 14 orphan modules and their tests | **−1,515** | low-med |
| 7 | **C-10** | `git rm` the 27 uncited review documents; add a retirement leg | **−3,526** | very low |
| 8 | **CY-03** | Delete the 6 compatibility re-export shims | −91 | low |
| 9 | **F1** | One generated-artifact substrate; one splice; one CLI convention | −300 | low |
| 10 | **C-01** | `/start-lap` reads the seek index, not 5 files verbatim | ~55k tok/lap | low |
| 11 | **C-02** | Cut history from `CLAUDE.md` to rule + mechanism pointer | −7.6 KB/session | low |

### Tier 2 — Correctness-improving consolidations

| # | ID | Action | Lines | Risk |
|---|---|---|---:|---|
| 12 | **CY-02/05/06** | Three hand copies → shared imports; `Record<Lens, …>` exhaustiveness | −25 + 3 drift surfaces | low |
| 13 | **CY-15** | One `collectFilesSorted`; fixes a stable-order violation | −14 | low |
| 14 | **CY-14** | Move the clause projection into shared | −9 | very low |
| 15 | **CY-13** | Five one-field/alias types inlined | −35 | very low |
| 16 | **F5** | Four backlog gates → one process; git-index enumeration | −60 | low |
| 17 | **F4** | Register `test:doc-contract`; derive its trigger | −5 | low |
| 18 | **F6** | Shared Stop-gate preamble | −50 | low |
| 19 | **F8** | Delete 5 redundant parity assertions; keep the filelock one | −25 | low |
| 20 | **CY-08** | Route the fold's line index through its memo | −8 | low |
| 21 | **C-05** | Generate or delete the template's section list | −21 | very low |
| 22 | **C-09** | Record start-HEAD so the closeout self-populates | 0 steps | med |

### Tier 3 — Needs a design gate or an owner decision

| # | ID | Action | Lines | Risk |
|---|---|---|---:|---|
| 23 | **CY-04** | Gates return `{evaluated, reason, issues}` | −120 | med |
| 24 | **CY-07** | Shared review-snapshot store | −140 | med |
| 25 | **CY-12** | Shared bound-prompt identity; **keep the trust asymmetry** | −16 | med |
| 26 | **CY-09** | Skip re-validation only under the current manifest | −10 | med |
| 27 | **F3** | One staged-tree attestation mechanism | −150 | med |
| 28 | **C-04** | 4 closeout copies → 1; reconcile the 7-step skill | −2 KB | med |
| 29 | **C-03** | Delete `project-philosophy.md`'s PART A/B map | −245 | med |
| 30 | **C-11** | Per-entry review of 13 durable-traps candidates | −150 | low |
| 31 | **CY-11** | Shared reachability primitive — **only if the callback stays to one predicate** | −40 | med-high |
| 32 | **F9** | Split the pre-commit boundary; native hook + bypass refusal | −200 | high |
| 33 | **F10** | Offload-lane registry — **owner decision** | −700 | high |

### Totals

- **Tiers 0–1: about 6,455 lines removed**, plus ~55,000 tokens per lap and ~7.6 KB per
  session, with no gate weakened and no closeout step dropped.
- **Tiers 0–2: about 6,700 lines**, plus roughly 23 seconds off a typical markdown commit.
- **All tiers: about 8,500 lines.**

For scale: that is roughly a third of the executable governance layer, removed without
losing one enforced property.

---

## Owner decisions this review cannot make

1. **F10 — the offload-lane registry.** 708 lines describing localhost URLs and peer-CLI
   binaries sit inside a package whose `CLAUDE.md` bans execution inventory, and 7 of its 9
   rows are unprobeable. The registry itself states that its authority is untracked and
   per-machine. Either move it to `~/.agent-config/`, or record in its header why the ban
   does not apply. Both are defensible; leaving it undecided is not.
2. **C-04 — the two contradictory closeout definitions.** A 7-step skill and an 8-step
   schema are both marked mandatory. This crosses the repo/machine boundary, so per machine
   policy it is the owner's scope call, not a repo-local edit.
3. **C-01 and C-02 touch `/start-lap` and `CLAUDE.md`.** Both are repo-scoped. The
   `closeout` skill in C-04 is machine-wide.

---

## Scope note

Findings F1–F11, CY-01–CY-15, C-01, C-05–C-11 and the Part 5 structural change are
**repo-scoped** to audit-tools. C-04's fifth copy (`~/.claude/skills/closeout/SKILL.md`)
and the canonical schema in `~/.claude/portable-engineering-principles.md` are
**machine-wide**; changing them affects every repository and needs the owner's decision
before any edit.
