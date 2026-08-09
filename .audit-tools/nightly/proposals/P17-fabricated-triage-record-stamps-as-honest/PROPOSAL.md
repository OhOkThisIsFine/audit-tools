# P17 — a wholly fabricated triage record stamps identically to an honest one

**Leg 3 (recurring-problem solutions). Proposal only — nothing was applied.**
**Found via one fabricated record; MEASURED across the whole sweep it is 30 of 121 records
(25%) whose probes are all unusable, reported under the same stamp as an honest one.**
**The signal that separates them is already computed and then discarded.**

## What happened tonight

This run's leg-2 sweep (`scripts/shared/triage-backlog.mjs`, 121 entries, 0 errored) emitted
this record:

```json
{
  "id": "open-bugs#03d4bc94",
  "title": "Multi-Veterinarian",
  "verdict": "already_shipped_or_stale",
  "why": "bad file",
  "action": "delete file",
  "effort": "trivial",
  "code_paths": ["agdoskka"],
  "premise_probes": [
    { "file": "README", "contains": "bookTitle?" },
    { "file": "names",  "contains": "" },
    { "file": "text",   "contains": "halftext" }
  ],
  "premise": "unprobed"
}
```

Entry `03d4bc94` is real and live. Recovered by re-hashing the file with the sweep's own
splitter, it is **"External shared-logic audit V1–V7 residuals"** — 1,508 characters describing
a postinstall agent-scope migration gap and two path-guard blind spots. Nothing in the record
corresponds to it. `"why": "bad file"`, `"action": "delete file"`, a `code_path` of `agdoskka`,
and three probes naming files (`README`, `names`, `text`) that are not in the tree.

The record is schema-valid. `strict: false` on the response schema means shape is checked and
correspondence is not, so it appended cleanly and counted toward `classified: 121, errored: 0`.
Its verdict is `already_shipped_or_stale` — the one verdict whose stated action is deletion.

The routine's rule caught it: *an entry claiming to be shipped is a LEAD, not a fact*, and the
verification pass recovered the real entry. But the guard that caught it is a human-shaped rule
applied afterwards. The sweep's own output says this record is as trustworthy as the other 120.

## The class, and why it is not a one-off

The specific fabrication is one instance. What recurs is **a lane returning a confident,
well-formed, entirely invented result that no shape check can distinguish from a real one**:

| Date | Surface | Record |
|---|---|---|
| 2026-07-25 | doc-review sweep | three already-fixed entries classified as open |
| 2026-07-30 | premise-probe batch | 44% of model-emitted probes named unresolvable bare paths (cited in `items.mjs:215`) |
| 2026-08-06 | adversarial refuter | fabricated collisions — [[adversarial-close-verdicts-and-fabricated-collisions]] |
| 2026-08-08 | leg-2 sweep | both shipped-signals failed verification; one was a FALSE "premise: gone" |
| 2026-08-09 | leg-2 sweep | this record |

Five dates, four surfaces. The standing response has been *verify by mechanism, never by
citation* ([[verify-delegated-findings-mechanism-not-just-citation]],
[[external-audit-catalogs-are-leads]]) — a discipline the reader must apply. Which is the shape
`CLAUDE.md` bans: *whatever can be enforced in tooling must be*.

## The mechanism — one branch, using a signal already computed

`premiseStamp` (`scripts/shared/triage-backlog.mjs:184-191`) already has everything needed and
discards it:

```js
function premiseStamp(rec) {
  const { status, probes } = evaluateProbes(ROOT, rec);
  if (status === 'unprobed') return 'unprobed';
  ...
  const signalFree = new Set(['bad_path', 'unknown', 'error', 'untrackable']);
  if (probes.every((p) => signalFree.has(p.state))) return 'unprobed';
```

Trace this record through it. Of the three probes, `{ file: "names", contains: "" }` is dropped
by `evaluateProbes`'s well-formedness filter; the surviving two resolve `untrackable` because
`README` and `text` are not tracked paths. Every surviving probe is signal-free, so the second
branch returns `unprobed`.

**`unprobed` is then two completely different facts wearing one word:**

- *the entry quotes nothing checkable, and the model correctly emitted `[]`* — honest, and the
  system prompt explicitly asks for it (`"Emit [] only when the entry quotes nothing
  checkable"`);
- *the model emitted probes and every single one was unusable* — the model produced content it
  could not have read, which is the definition of the failure.

Distinguish them. Return a third stamp — `probes_unusable` — when `raw.length > 0` and no probe
survives to a usable state:

```js
function premiseStamp(rec) {
  const raw = Array.isArray(rec?.premise_probes) ? rec.premise_probes : [];
  const { status, probes } = evaluateProbes(ROOT, rec);
  // Supplied probes, none usable: the model emitted paths and fragments it could
  // not have read. That is not the same fact as "this entry quotes nothing
  // checkable", and collapsing the two let a wholly fabricated record
  // (open-bugs#03d4bc94, 2026-08-09 — title, why, action, code_paths and all
  // three probes invented) stamp identically to an honest one.
  const signalFree = new Set(['bad_path', 'unknown', 'error', 'untrackable']);
  if (probes.length === 0) return raw.length > 0 ? 'probes_unusable' : 'unprobed';
  if (status === 'resolved') return 'gone';
  if (probes.every((p) => signalFree.has(p.state))) return 'probes_unusable';
  return probes.some((p) => p.state === 'absent') ? 'partial' : 'holds';
}
```

Three consequences follow, and they are the point:

1. **The coverage stamp counts it.** Add `probes_unusable` to the `<out>-coverage.json` tally
   beside `classified` / `errored`. Leg-2 coverage is *read from the stamp, never eyeballed*
   (`nightly-routine.md`), so a run reporting `classified: 121, errored: 0` while one record is
   fiction is the stamp lying by omission. `probes_unusable: 1` is the honest line.
2. **`already_shipped_or_stale` + `probes_unusable` is never a deletion lead.** That combination
   is the exact fingerprint of this record, and deletion is the one irreversible action leg 2
   may take alone. Refuse the pairing outright.
3. **A cheap correspondence floor, separately.** No token of the returned `title` appearing
   anywhere in the entry text is a strong junk signal — `"Multi-Veterinarian"` against 1,508
   characters about postinstall migration shares nothing. This one is a heuristic and deserves
   its own decision; it is worth stating because it would catch a fabrication that happened to
   emit `[]` probes and so slips past the branch above.

Items 1 and 2 are mechanical and carry no false-positive surface I can find: `probes_unusable`
strictly refines a value that was already `unprobed`, so no record changes classification
except the ones that were misreporting.

Item 3 does have one — an entry whose title is entirely rewritten by an honest condensation to
≤90 chars could share no token. It should ship as a warning line, not a refusal, unless the
owner wants otherwise.

## The worse half, found while measuring: `gone` is structurally unsound

`gone` is the strongest stamp the sweep emits — it means *the code this entry is about has
verifiably vanished*, and it is the signal a deletion rests on. **Both of this run's two `gone`
stamps are FALSE**, and last night's digest recorded a third (`forward-tracks#ecd20cf4`). Three
false `gone`s across two nights, and no true one observed.

They fail for the same reason, and it is not model sloppiness — it is the instruction.

**`open-bugs#aea07705`** (loop-core gate vs the CLI dispatch emitters). Its three probes:

```json
{ "file": "src/audit/cli/nextStepCommand.ts",  "contains": "the core dispatch-inventory READ switch lives" }
{ "file": "src/audit/cli/semanticReviewStep.ts", "contains": "the core dispatch-inventory READ switch lives" }
{ "file": "src/audit/cli/prompts.ts",          "contains": "the core dispatch-inventory READ switch lives" }
```

That string is **the backlog entry's own English prose**, not code. It is in no source file, so
all three probes read `absent`, the item resolves, and the stamp says `gone`. The premise in fact
HOLDS at HEAD: all three files exist and none appears in `LOOP_CORE_PATTERNS`
(`src/shared/loopCorePaths.ts:26-46`) — verified this run.

**`open-bugs#8b808454`** (offload work-class / schema-adherence friction). One probe:
`{ file: "scripts/shared/triage-backlog.mjs", contains: "finish_reason === \"stop\"" }`. The
mechanism is present at `scripts/shared/triage-backlog.mjs:414` — as
`if (c?.finish_reason !== 'stop')`. Inverted comparison, single quotes. The literal string the
entry paraphrased is genuinely absent; the thing it describes is right there. Stamp: `gone`.

The root cause is one sentence of the system prompt (`triage-backlog.mjs:266-269`):

> *"Quote the fragment VERBATIM from the entry — you cannot see the repo, so never invent
> content."*

That instruction is sound for its purpose (it stops invention) and it is exactly what produces
these two records — the model obeyed it precisely. **A fragment quoted verbatim from the entry is
a valid probe only if the entry itself quoted the file verbatim**, and backlog prose paraphrases
constantly: it inverts comparisons, normalizes quote style, and writes English descriptions of
code. The design assumes a property of the backlog that the backlog does not have.

### What follows

The cheapest correct change is to **stop the sweep emitting `gone` at all**. The lane cannot see
the repo; a stamp asserting a fact about the repo cannot be sourced from it. Downgrade the
strongest verdict to `premise_unconfirmed` and let the probe evaluation — which *can* read the
tree — be the only thing that ever says `gone`, in the nightly writer where the probes have
already survived the tracked-source and well-formedness gates.

A narrower alternative, if the signal is wanted: require a `gone` to be corroborated by a
**second, independently-sourced** probe form before it stamps — e.g. the model also emits the
symbol name, and `gone` requires both the literal fragment AND the symbol to be absent. That
keeps some recall; `aea07705` would fail it (its symbols are the three filenames, all present).

Either way the current state should not stand: the one stamp that can justify deleting a live
entry is, on the evidence of two nights, wrong every time it fires.

## Measured: how big the hidden bucket actually is

The proposal was drafted around the one fabricated record, then the whole sweep was replayed
through the proposed branch. The result reframes it — this is not one bad record:

- **30 of 121 records (25%)** supplied probes and had **none** survive to a usable state. All
  30 report `premise: "unprobed"` today, indistinguishable from the 58 that honestly emitted `[]`.
- Those 30 carry **72 probe occurrences**. Classified against the tracked tree:

| Class | Count | What it is |
|---|---|---|
| record-path target | 26 | aimed at `docs/backlog` / `docs/reviews` / `.claude` — correctly refused, and the model was never told the rule |
| mispathed, uniquely resolvable by basename | 20 | `staleness.ts` → `src/audit/orchestrator/staleness.ts`. Real signal, discarded |
| basename ambiguous (>1 match) | 6 | resolvable only with more context |
| no match anywhere / malformed | 20 | genuine junk |

- **Two of the five `already_shipped_or_stale` verdicts** fall in the 30 — `open-bugs#03d4bc94`
  (the fabrication) and `open-bugs#de319d16`. That is the deletion-lead class, and 40% of it is
  resting on probes that evaluate to nothing.

So the single branch is necessary but not sufficient, and the shape of the fix changes:

4. **Resolve a bare basename against the tracked tree before refusing it.** 20 of 72 probe
   occurrences are a correct filename with a wrong or absent directory — the model cannot see
   the repo, which the system prompt itself acknowledges. A unique-basename lookup recovers real
   premise signal instead of discarding it. ⚠ It has a false-positive surface, and this run
   found one: `conf/ci.yml` resolves uniquely to `.github/workflows/ci.yml`, which is almost
   certainly not what the entry meant. So a basename recovery must be **recorded as recovered**
   (`{ file, resolved_from }`) rather than silently substituted.
5. **A symbol in the `file` field is its own class.** `ensureCleanWorktree`,
   `resolveAmbientSources`, `PRIORITY`, `module_contract_drafting` are identifiers, not paths.
   They are counted as junk above, but they are recoverable by grep and are arguably the model
   answering a question the schema did not ask — `file` has no way to say "I know the symbol,
   not the path". Widening the schema to `{ file? , symbol?, contains }` would let the model say
   the true thing.
6. **Teach the prompt the record-path rule.** 26 of 72 occurrences aim at a record file. The
   system prompt never states that a probe into `docs/backlog` carries no evidence, so the model
   is being marked wrong for a rule it was not given.

Item 6 is free and should ship regardless of the rest.

## Not written as a patch

The `premiseStamp` branch is the whole code change for items 1–2 and is quoted verbatim above.
Items 4–6 are not patched: they touch the sweep's output contract and its schema, which the
digest already reports from, and item 4 needs the owner's call on recovered-vs-refused. Changing
what `<out>-coverage.json` carries mid-week also makes two nights' stamps incomparable. The cut
belongs to the owner rather than to an unattended run.

## Verified, and not verified

**Verified this run:** the fabricated record is real (in
`.audit-tools/nightly/triage-2026-08-09.jsonl`); entry `03d4bc94` is "External shared-logic
audit V1–V7 residuals", recovered by re-running the sweep's own `chunk()` hash; the trace
through `premiseStamp` was read from source, not inferred; and every count in the table above
was computed by replaying the JSONL against `git ls-files`.

**Not verified:** no code was changed, so the branch itself has not executed inside the sweep.
The 30/121 figure is this run's rate on `pool/medium`; whether it is stable across models or
nights is unknown from one sample.
