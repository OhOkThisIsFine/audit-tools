# P64 — the one generated file with no freshness authority is the one that goes stale

**Leg 3, proposal only. Nothing here is wired or applied.**

## The recurring problem

`AGENTS.md` holds a region written by the machine-wide generator
`~/.agent-config/sync.mjs`. The instruction that keeps it fresh is prose in the
global `CLAUDE.md`: *"Run the generator after you edit any `CLAUDE.md`."* That is
a rule made of memory, and this repository's own convention bans exactly that —
*enforce in tooling, never host discretion*.

The rule is forgotten regularly. Three commits exist for no purpose other than
catching the region up afterwards:

| Commit | Date | Subject |
|---|---|---|
| `e4bfb97f` | 2026-08-26 | docs: regenerate AGENTS.md after the CLAUDE.md closeout edit |
| `1efa125f` | 2026-08-28 | chore: AGENTS.md generated region catches up with the committed CLAUDE.md |
| `590b27b3` | 2026-08-29 | chore: refresh generated AGENTS.md region (sync.mjs) |

It is forgotten right now. `a1616d1d` (2026-09-07, *chore: automate maintenance
guardrails*) edited `CLAUDE.md` and did not regenerate `AGENTS.md`. The committed
region has claimed the wrong size ever since.

**That is five dated occurrences, and the last one is open.**

## What it costs — measured, twice

The generator runs on this machine outside the repository's commits, so the
regenerated `AGENTS.md` shows up as an **uncommitted modification**. The nightly
routine's clean-tree rule then blocks every auto-apply:

- **2026-09-09** — applied nothing. `git status --porcelain` reported `M AGENTS.md`.
- **2026-09-10** (this run) — applied nothing, same file, same cause.

Two consecutive nights of leg-1 auto-apply capacity, spent on a generated file
that nothing in the repository watches. The cost is not the wrong KB figure; it
is that a tracked file drifts silently and takes the routine's write rights with it.

## Why nothing catches it

`check:generated-artifacts` reconciles every **tracked** generator against exactly
one declared freshness authority, and `check:guard-reach` reconciles the registry
against the tracked tree. Both are complete over what they can see.
`~/.agent-config/sync.mjs` is not tracked here — it lives outside the repository —
so `AGENTS.md`'s region is claimed by no `GENERATED` row and has no authority at
all. The completeness gate cannot report a gap it is structurally unable to see.

## The mechanism

A repository-owned check, `check:agents-region`, that never calls the
machine-wide generator.

Read `buildBody` in `~/.agent-config/sync.mjs`: in **pointer** mode the region body
is fixed text plus one computed value —
`(Buffer.byteLength(sourceText,'utf8')/1024).toFixed(1)` — and `buildRegion` hashes
that finished body into `shared-region-id`. CLAUDE.md reaches the region through
that single number and nothing else. **So comparing the stated figure with
CLAUDE.md's real size is exact, not a proxy:** a matching figure means the region
is what the generator would write today, and a differing figure means it is not.

Candidate implementation: [`candidate-check-agents-region.mjs`](candidate-check-agents-region.mjs)
(would land as `scripts/check-agents-region.mjs`, exporting `validateAgentsRegion`
so a contract test can drive it without spawning).

Wiring, in the same commit:

1. `package.json` — `"check:agents-region": "node scripts/check-agents-region.mjs"`,
   added to `verify:checks`.
2. `scripts/guard-reach-data.mjs` — a gate row, `preCommit: 'reach'`, so the leg
   fires when the staged set touches `CLAUDE.md` or `AGENTS.md`:

   ```js
   {
     id: 'check:agents-region',
     kind: 'gate',
     impl: 'check:agents-region',
     preCommit: 'reach',
     fix: 'run `node ~/.agent-config/sync.mjs --projects` and stage AGENTS.md in the same commit as the CLAUDE.md edit',
     note: "the generator lives outside the repository, so check:generated-artifacts cannot claim this region",
   }
   ```
3. A contract test under `tests/` driving `validateAgentsRegion` over both arms.

The gate does not run the generator, so a fresh clone, a CI runner, and a machine
with no `~/.agent-config` all evaluate it identically from the two tracked files.

## What it would have caught

`a1616d1d` — the commit that put the current divergence in the tree. Its staged
set touched `CLAUDE.md`, the `reach` leg would have fired, and the commit would
have been refused with the regeneration command. By extension, the three catch-up
commits above would never have been needed, and the last two nightly runs would
have kept their write rights.

## False-positive surface

- **A CLAUDE.md edit that does not change the rounded size.** The check passes,
  and it is right to: in pointer mode a same-size CLAUDE.md produces a
  byte-identical region. There is no missed staleness here, only a narrower
  definition of stale than a reader might expect.
- **A deliberate mid-edit commit.** An owner committing a CLAUDE.md change and
  regenerating later is refused. The escape is running the generator, which is
  the action the rule already asks for — so the refusal costs one command, not a
  workflow.
- **The generator switching this target to inline mode** (CLAUDE.md dropping below
  the 12 KB inline budget) removes the pointer sentence and the check reports it
  as a missing sentence rather than a size mismatch. That is a loud, accurate
  failure with a stated remedy, not a silent pass.
- **CI never sees a machine-specific red.** The check reads only `AGENTS.md` and
  `CLAUDE.md`, both tracked.

## The refutation this proposal has to answer

**"The size figure is a stated computed value, which this project's own doc
philosophy calls status-noise. A gate that checks it enshrines the thing that
should be deleted."** That is a fair hit, and it has a concrete consequence: if
the machine-wide fix is to stop printing the figure, this repository's check
finds no pointer sentence and turns red on the very commit that improves things.

Three things follow, and they belong in the owner's decision rather than being
resolved here:

- The two options **interact**; they are not independent. Taking the machine-wide
  route means retiring or rewriting this check in the same change.
- Removing the figure does **not** by itself stop the drift. `shared-region-id` is
  `sha256(body)`, and other inputs to `body` (the host appendix, the pointer text
  itself) still change; a target in inline mode carries the whole source. The
  general fix is *regenerate in the same commit*, and the size comparison is only
  the detector available to a repository that cannot see the generator.
- The gate refuses a commit; it never edits `AGENTS.md`. The instruction-file rule
  — never auto-edit `CLAUDE.md` or `AGENTS*.md` — is untouched.

## Red-green evidence

[`RED-AT.txt`](RED-AT.txt) — the verbatim failure at
`a33bc8d91a7cfeca9fc2be4ba42006d74971c602`, run
`node --test agents-region-freshness.test.mjs`
([`red-run.txt`](red-run.txt), exit 1; [`green-run.txt`](green-run.txt), exit 0).

## The scope question the owner must settle

The defect is in this repository's tree, but the generator is machine-wide and
**every** project under `C:/Code` that `sync.mjs` targets has the same gap. Fixing
it here fixes one repository; fixing it in the generator — or in a machine-wide
commit hook — fixes all of them. Filing a machine-wide fact in a repository-scoped
store is the failure the scope-check policy names, so the choice belongs to the
owner and is carried as an inbox item, not decided here.
