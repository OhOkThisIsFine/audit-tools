# P57 — classify a load-flake at the gate instead of reporting a bare red

**Leg 3 (recurring-problem solutions). Proposal only — nothing was landed.**
**Scope: THIS REPOSITORY. Form: OPEN, and declining is a legitimate answer.**
Nightly 2026-09-06, HEAD `97f3033a`.

## Read the recurrence count first

**Two records, on two dates — 2026-08-09 and 2026-09-03. That is exactly the
recurrence bar and no more, and it is thinner than it looks: both live inside
ONE `docs/backlog/durable-traps.md` entry, the second as an addendum to the
first.** Every other proposal in tonight's set carries four or five records
across four or five dates from three or four independent homes. This one does
not, and no amount of framing changes that.

Option (C) below is *decline as under-evidenced*, and it is a real option, not a
courtesy. The rest of this record exists so the owner can judge the mechanism on
its merits — but the evidence bar is the first thing to weigh, not the last.

## The trap

The full suite goes red on a file that has failed under load before and passed
alone immediately after. The gate reports a bare red. The reader must then know,
from prose, that this particular file is a known load-flake, and must re-run it
alone by hand to find out which it was.

`durable-traps.md:668`:

> **The `audit-code-completion-*` files can flake together under full-suite load,
> and the symptom reads exactly like a regression (2026-08-09).** Seen:
> `-present`, `-promote`, and `-ingest-dir` failed in one full run with
> `next-step did not reach present_report within 10 calls`… All passed **alone**,
> and a second full run on the **identical tree** was green — 597 files, 0
> failed. **They are not in `scripts/shared/test-flake-baseline.json`, so nothing
> tells you this.**

And the addendum:

> ⚠ **A second pair flakes the same way but with the TIMEOUT symptom
> (2026-09-03).** `tests/audit/io-remediation.test.ts` and
> `tests/audit/finalization-convergence.test.ts` each hit the 120s per-file
> vitest timeout in one full-suite run on this machine and passed alone
> immediately after. Same protocol, different tell.

Both verified at HEAD this run. Five files across the two records:
`audit-code-completion-present`, `-promote`, `-ingest-dir`, `io-remediation`,
`finalization-convergence`.

The sentence that carries the proposal is *"nothing tells you this"* — the entry
prescribes a protocol (run alone, then re-run the full suite, two greens plus a
mechanism argument) that lives entirely in a human's head.

## Why the existing mechanism does not catch it

`scripts/shared/run-vitest-gate.mjs` already owns a two-sided verdict, extracted
into `scripts/shared/vitestGateVerdict.mjs` so it can be tested directly. Its
header states the design this proposal has to respect:

> The gate defends BOTH false signals, and they are mirror images:
> • false GREEN — vitest exits 0 while the ledger reports failures…
> • false RED — vitest exits nonzero because its worker RPC timed out under
> load, while every test passed and the reporter finished cleanly. This is just
> as corrosive: a green run that reads red by exit code teaches a reader to wave
> at reds, which is how `main` sat red for ~a dozen laps while every lap reported
> green.

So the machinery exists — and it is deliberately narrow. It downgrades on a
**known transport signature** (`HARNESS_FAULT`), with four conjoined conditions
including `unfinished === 0`, precisely so a crashed worker with zero counted
failures stays red. Its own comment rejects the shape this proposal must not
become: *"never 'no failures were counted, so it must be fine'."*

A load flake is a different animal. The tests genuinely ran and genuinely failed;
there is no transport fault to recognize. Nothing in the gate can see it, and
nothing should silently downgrade it.

## The mechanism

Declare a `loadSensitive` file list (the five files above). When the gate reds and
a failing file is on that list, **re-run that file alone** and print a three-way
verdict:

- `regression` — failed solo too.
- `load-flake: passed solo, failed parallel` — the protocol the trap entry
  prescribes, executed.
- `red both ways` — for a file that fails solo for a different reason than it
  failed in parallel.

**Hard constraints, and they are the point:**

- **READ-side classification only.** The gate's exit code is unchanged. A red
  stays red in every branch. This adds a *sentence*, never a *verdict change* —
  which is what keeps it on the correct side of the `vitestGateVerdict` design
  above.
- **Never writes the flake baseline.** That stays behind
  `npm run test:rebaseline-flakes`, deliberately, for the reason the memory
  `flake-baseline-write-is-deliberate` records. An automatic baseline write is
  how a real regression gets absorbed into the accepted set.

## What it would have caught

Both records, in the sense that matters: it does not prevent them — nothing
prevents a load flake — it collapses the diagnosis. The 2026-08-09 incident cost
a full solo run of three of the slowest files in the suite plus a second full-suite
run, entered by hand after reading a prose entry. The 2026-09-03 pair cost the
same, with a different symptom that the entry itself notes *"does not look
load-related"*.

Stated against the bar this repo applies elsewhere: this is a **diagnostic
affordance**, not a defect fix. It would not have made any past run correct. It
would have made two red runs interpretable in one command instead of four.

## False-positive surface

Genuinely low, because the mechanism cannot change a verdict:

- Exit code untouched in all three branches, so there is no false-green path.
- No baseline write, so nothing accumulates.
- The declared list is the only input, and a stale list degrades to today's
  behaviour (a bare red).

The real costs are elsewhere and are worth more than the false-positive question:

- **Wall time.** The re-run is a solo run of the slowest files in the suite. The
  2026-08-09 entry says these "spin real audit runs through real subprocesses",
  and the 2026-09-03 pair each hit a 120s per-file timeout. A red full suite
  would get materially slower — paid on every red, including ordinary
  regressions on a declared file.
- **The three-way verdict is one sample.** The entry's stated bar is *"two greens
  plus a mechanism argument… a single alone-pass is not"*. A printed
  `load-flake` from one solo pass is therefore **weaker than the protocol it
  automates**, and if the message does not say so it will be read as the verdict.
  That is a false-confidence risk of the same family as a false green, and it is
  the strongest argument against option (A) as drafted.
- **A declared list is a grandfathered measurement.** Same objection the repo
  already made against the 25 loop-core-closure exclusions: the rows record what
  the tree measured, not a judgment that each is correctly classified.

## The form is the question — three options

**No patch is written**, and here the reason is sharper than usual: options (A)
and (B) disagree about where the list comes from, which decides whether this is a
registry edit or a consumer of the timing ledger, and option (C) discards both.

**(A) A declared `loadSensitive` list.** Five rows today, beside the flake
baseline or in the guard registry.
*Pros:* explicit, reviewable, diffable, and it says *why* each file is on it —
which is the half the prose entry actually carries and the half a derived list
would lose. Cheapest to build.
*Cons:* hand-maintained, so it decays exactly like the prose it replaces; the
sixth load-sensitive file is not on it until someone is bitten and remembers. It
converts a durable-traps entry into a registry row without converting the
knowledge into a *derivation* — and this repo's stated preference is to delete a
trap entry only when the mechanism states the trap, which a hand list only half
does.

**(B) Derived from the timing ledger.** The gate already emits per-file wall
timings; a file whose parallel duration is a large multiple of its solo duration,
or which sits near the per-file timeout, is load-sensitive by measurement.
*Pros:* self-maintaining, catches the sixth file before anyone is bitten, and the
data is already being collected — the timing reporter prints it on every run.
*Cons:* it is a threshold, and a threshold is a new false-positive surface where
(A) has almost none: a slow-but-honest file gets a re-run on every red. It also
does not answer *why*, so the classification carries no reason a reader can
check. And the entry's own point is that the 2026-08-09 symptom was a **call-count
limit, not a timeout** — the tell that "does not look load-related" — so a
timing-derived list may not have contained three of the five files at all. That
is a concrete argument that (B) does not cover the founding incident.

**(C) Do nothing mechanical.** Leave the protocol in `durable-traps.md`.
*Pros:* **honest about the evidence.** Two dated observations inside one entry,
five files, on one machine, over four weeks. The repo's rule is that a durable
trap is enforced *when it can be* — and it is equally the repo's rule that a
mechanism is justified by recurrence, which this barely meets. It costs nothing,
adds no wall time to a red run, and creates no grandfathered list. The trap entry
already states the protocol clearly and names the two symptoms.
*Cons:* the entry's own complaint — *"nothing tells you this"* — stays true, and
the cost is paid by whoever next reads a red as a regression. The class is also
plausibly growing rather than closed: two distinct symptoms in two records
suggests the mechanism (contention on real subprocesses) is general to the
slowest files, not specific to five.

## Recommendation, stated but not decided

If the owner wants a mechanism, **(A) with the message corrected to state its own
weakness** — a single solo pass printed as `load-flake (one solo pass; the
entry's bar is two greens plus a mechanism argument)`. A verdict that overstates
its evidence is the failure this record is most exposed to.

If the owner does not, **(C) is defensible and this record does not argue against
it.** The evidence is two observations in one entry, and the honest thing is to
say so rather than to dress two into a pattern.

## Files in this proposal

This record only. No patch, no test — see *The form is the question*.
