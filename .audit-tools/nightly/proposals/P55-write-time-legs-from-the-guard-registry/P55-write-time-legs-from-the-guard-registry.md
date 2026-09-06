# P55 — run the guard registry's file-scoped legs at WRITE time, advisory, so the author sees the refusal while the text is still theirs

**Leg 3 (recurring-problem solutions). Proposal only — nothing was landed.**
**Scope: THIS REPOSITORY. Form: OPEN.** Nightly 2026-09-06, HEAD `97f3033a`.

## The trap

Every content gate in this repo fires at **commit**. The staged-set legs are
derived correctly, they are fast, and they refuse the right things — but they
refuse them to whoever is committing, which is routinely not whoever wrote the
text, and routinely a different session. The cost is not the refusal; it is that
the refusal arrives against text nobody present authored, so a fix that is
seconds at the keystroke becomes a serialized gate → fix → re-run loop.

The repo already knows this shape works in the other direction: a PostToolUse
hook typechecks edited TypeScript the moment it is written, so a type error
never reaches the commit gate at all.

## Recurrence — 4 records across 4 distinct dates

| # | Record | Date | The late refusal |
|---|---|---|---|
| 1 | `docs/backlog/durable-traps.md:831` | 2026-08-09 | an attestation binds to the staged tree; a stale derived file makes the gate demand a regeneration that changes that tree and voids it. Its own falsified first remedy is the tell: *"leg order was never the mechanism, because **the gate runs at commit time and the attestation is written in an earlier tool call**"* |
| 2 | `docs/backlog/open-bugs.md:390` | 2026-08-20 | a wave item coining an `INV-*` id in `src/` cannot satisfy the glossary gate — `docs/glossary-ids.md` is outside every module's `file_scope` and the pre-commit gate does not run the glossary test, so **the red lands silently and is discovered by the NEXT item's worker**. Happened twice in one session |
| 3 | `docs/backlog/minor-bugs.md:25` | 2026-08-30 | `check:backlog-budget` reports the overage and nothing about what to cut, so satisfying it is a guess-and-rerun loop: **SEVEN full re-runs in one lap**, the last three moving 11, 2 and 1 bytes |
| 4 | `docs/backlog/open-bugs.md:966` | 2026-09-03 | nine entries written in an **earlier session** hit `check:doc-code-citations` (13 unresolved backticked paths) and then, on the next attempt, `check:backlog-line-numbers` (3 `path:line` forms) — *"in sequence at landing, in a different session from the one that wrote them"* |

Four records, four distinct dates. All verified at HEAD this run.

Record 4 does not merely exhibit the class — it **specifies this proposal**, in
the entry's own Property:

> the backlog gates run at write time for `docs/backlog/` — a PostToolUse check
> on Edit/Write, as `.claude/hooks/async-typecheck.mjs` does for TypeScript — so
> the writer sees the refusal while the text is still theirs.

Record 3 is the weakest member and is counted honestly: its stated Property is
about the *content* of a refusal, not its *timing*. It belongs here because the
seven re-runs are seven whole-file re-scans against a commit-time gate, and a
write-time leg collapses that loop from the other side. It is an adjacent
member, not an identical one.

## Why the existing mechanism does not catch it

`scripts/shared/derived-file-preflight.mjs` `buildPreCommitLegs` already derives
the leg set from `scripts/guard-reach-data.mjs` — a gate row's `preCommit`
(`'reach'` / `'always'` / `'final'`) plus the union of the `files` globs of every
REACH row citing that gate. Three consumers share it: the commit gate, the attest
scripts' preflight, and `check-guard-reach`.

That is the right substrate, and it has already been moved **once** in this
direction: record 1's fix pulled the derived legs earlier, from the commit gate to
the attest scripts, so an attestation could not be written that the gate would
reject. This proposal moves the same derivation one step earlier again — from
"before the attestation" to "at the edit".

What it cannot express today is **which legs are cheap and narrow enough to run
per file**. `preCommit: 'always'` exists because tree membership changes on any
add or delete; that is exactly the wrong trigger for a per-edit hook. And a leg
that costs 240s at commit is fine and unusable at a keystroke.

## The mechanism

1. Add a `writeTime` classification to the gate rows in
   `scripts/guard-reach-data.mjs`. A gate qualifies on **two** conjoined
   properties, both stated in the row rather than inferred:
   - **path-scoped** — the gate's verdict for a file depends on that file, so it
     can be run against one path. (`check:backlog-line-numbers`,
     `check:doc-code-citations`, `check:backlog-budget` and
     `check:memory-citations` are per-document scans; `check:guard-reach` is a
     whole-tree reconciliation and is *not* eligible.)
   - **sub-second** — measured, declared, and reconciled, not asserted. A gate
     that stops being fast reds the declaration rather than silently slowing
     every edit.
2. Add `buildWriteTimeLegs(path)` beside `buildPreCommitLegs` in
   `scripts/shared/derived-file-preflight.mjs` — the same derivation, filtered to
   `writeTime` rows whose REACH globs match the edited path. One module, two
   draws, which is the repo's own shape for exactly this.
3. The existing PostToolUse hook runs them for the edited file.
   `.claude/settings.json` already wires `Edit|Write` →
   `async-typecheck.mjs` (`asyncRewake: true`, `timeout: 240`), so this is a
   branch inside a live hook, not new wiring.

Nothing about the commit gate changes. The write-time legs are strictly
additional and strictly earlier; the commit boundary stays the authority.

## The false-positive surface is ALREADY MEASURED, and it is the whole argument

This is not a projected risk. The identical mechanism — a PostToolUse hook that
judges a file the moment it is edited — is **live on this machine and is
recorded as causing false reds today**. `C:\Code\docs\backlog.md:32`:

> **`~/.claude/hooks/posttooluse-typecheck.mjs` blocks a two-step edit at its
> midpoint (2026-09-05, medium, friction: false_red).** Adding an import in one
> Edit and its first use in the next is refused, because the first edit alone
> leaves an unused import; the same happens when a helper is added in one edit
> and its call sites rewired in the next. **Hit three times in one lap, and FOUR
> more** at the llm-relay Phase 1b lap on 2026-09-05 (v0.72.3) — every one a
> module extraction, which is the shape that always needs import-then-use across
> two edits, so a duplication programme meets this on essentially every item.

Seven blocks in a day, on one repo, from one hook. And the recorded workarounds
are both worse than the thing they avoid: land the whole change in a single
`Write` (worse for review), or edit through `Bash` (which defeats the hook
entirely).

The entry's own diagnosis is the design constraint for this proposal, verbatim:

> ⚠ The hook is right that the FINAL state must be clean; it is wrong to judge an
> intermediate one.

**A document under construction is an intermediate state in exactly the same
way.** A backlog entry written across three edits has a dangling citation after
the first and a `path:line` form before its exemption marker is added. Every
record in the recurrence table above is about a *finished* text refused too late;
a blocking write-time leg would refuse *unfinished* text too early, and the
repo has already measured what that costs.

The second, smaller surface, also worth naming: this repo's own
`posttooluse-typecheck` note warns that an eslint baseline is line-number
sensitive, so an edit that only shifts lines can surface a pre-existing finding
as new. A per-file doc leg has the same hazard — `check:backlog-line-numbers` is
literally about `path:line` forms.

## What it would have caught

- **Record 4** directly and completely: nine entries, two gates, two sequential
  landing failures, in a different session from the author. Each would have
  surfaced on the edit that introduced it.
- **Record 2** partially. The glossary red would surface at the edit that coined
  the id — but only if `check:gate-enumeration`/the glossary test is
  path-scopeable, and the entry's deeper half is that `docs/glossary-ids.md` is
  outside the worker's `file_scope`, which a write-time hook does not change.
  It converts "discovered by the NEXT item's worker" into "discovered by this
  worker, who still cannot fix it". That is a real improvement and it is not the
  fix.
- **Record 3** in the shape described above: the budget overage surfaces on the
  edit that crosses it, so the guess-and-rerun loop is against one entry in one
  session rather than seven whole-file re-scans.
- **Record 1** not at all, and this is worth being exact about. Its mechanism is
  the *attestation binding*, and its fix already landed in the right place (both
  sides derive the leg set from one module since P34). It is in the count as the
  earliest member of the "the gate runs at commit time and the author was two
  tool calls ago" class, and as the precedent that moving the derivation earlier
  is a thing this repo already does successfully.

## The form is the question — three options

**No patch is written.** The three options differ in the hook's *verdict*, which
determines the hook's exit code, the shape of the state it must keep, and whether
`buildWriteTimeLegs` needs a per-file history at all. Option (C) needs persisted
per-path state that (A) and (B) do not; writing (A)'s patch would discard that.

**(A) Advisory only** — the hook prints the refusal and exits 0. Never blocks.
*Pros:* **the measured evidence points here.** It cannot reproduce the
seven-blocks-a-day failure, because it never blocks; it strictly adds
information at the moment it is cheapest to act on. An intermediate document
state costs a message, not a wall. Reversible: if it turns out to be noise, it
is deleted with nothing depending on it.
*Cons:* an advisory that fires and is read past is worth nothing — and
`.claude/hooks/shell-trap-guard.mjs` cites exactly that principle, by the name
`an-advisory-that-fires-and-is-read-past`, as its own reason for choosing DENY
over advise on the backtick rule. (Checked this run: no memory file of that name
exists in the project store — the hook carries a wikilink to a note that is not
there. `check:memory-citations` scans tracked markdown, so a citation inside a
`.mjs` is outside its reach. Noted as a finding, not fixed: leg 3 lands
nothing.) The commit gate remains the only
thing that actually stops the text, so record 4 recurs for any author who
ignores the advisory. Honest framing: (A) buys *earliness*, not *enforcement*,
and earliness is what all four records are actually complaining about.

**(B) Blocking** — the hook exits non-zero, as the typecheck hook does.
*Pros:* the strongest reading of *whatever can be enforced in tooling must be*;
the text cannot reach the commit gate carrying the defect at all.
*Cons:* **this is the configuration already measured as harmful.** Seven false
reds in a day, from the same hook shape, on a repo where multi-edit construction
is the normal workflow — and prose is *more* incrementally constructed than
code, not less. It would also make the two recorded workarounds (single-Write, or
editing through Bash) attractive for documents, and the second one defeats the
mechanism while looking like compliance.

**(C) Advisory, escalating to blocking on a second unfixed edit** — advise on
first sight; refuse if the same file is edited again with the same finding still
present.
*Pros:* closes (A)'s read-past hole while giving construction a full edit of
grace. It distinguishes "still building" from "not going to fix it", which is the
distinction (A) and (B) each collapse in opposite directions.
*Cons:* it needs **per-path, per-finding, cross-tool-call state**, which is new
persistence in a hook, and hook state on this machine has already produced one
recorded incident class of its own (the session-registry split). It also guesses
at intent: a three-edit construction of one entry escalates on edit two while
still legitimately unfinished, so the false red returns in a narrower window
rather than being removed. And the escalation is a *second* judgment the author
must model, which cuts against the standing preference for changes that make the
process simpler rather than adding a step to remember.

## Recommendation, stated but not decided

(A), on the measured evidence — the only option whose false-positive behaviour is
known rather than assumed, and the only one that cannot reproduce the seven-blocks
incident. Its weakness (read-past) is real but is a weakness of *degree*; (B)'s is
a weakness of *kind*, already measured, on this machine, this month.

## Files in this proposal

This record only. No patch, no test — see *The form is the question*.
