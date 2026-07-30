# P3 — state written by a previous version is read under new semantics, and the green suite cannot see it

**Leg 3 proposal. Nothing here has been landed.**

## The recurrence (counted, after adversarial correction)

The reviewer claimed 4 entries / 4 dates. The adversary refuted two:

- **2026-07-21** (`memory/review-blocked-branch-may-be-stale-not-blocked.md`) is the *same
  incident* as 07-19 — the memory itself closes with "Related:
  renaming-a-persisted-field-is-not-a-rename" — and the artifact is in-repo test fixtures,
  not tool-written persisted state.
- **2026-07-22** (the `artifact_metadata` freeze) **does not describe this pattern at all**:
  no version change, same-version writer and reader; it was a write/stamp coupling gap.
  It is also already fixed ("the frozen-record class is unrepresentable").

**Honest count: 2 distinct dates.**

| Date | Entry | What happened |
|---|---|---|
| 2026-07-18 | `docs/backlog.md` Durable traps | a retired `repair_proxy` key in `~/.audit-code/sources-declared.json` "fails as a MISSING lane, not a loud error" — the lived symptom was "the proxy lane is gone". The entry notes outright: *"the repo's tests will not catch a stale operator config."* |
| 2026-07-19 | `memory/renaming-a-persisted-field-is-not-a-rename.md` | `provider`→`transport`. Build + check + 6800 tests green; an adversary reproduced two real breaks **by execution** — `~/.audit-code/catalog-cache.json` on any existing machine held the old shape with no TTL and no version stamp, re-splitting a proxied lane from its direct lane and reopening the double-grant boundary |

Two dates is the floor for a pattern, not a comfortable margin. Reported honestly so the
owner can weigh it as such.

## Why it keeps happening

On-disk shapes carry no version. `PROXY_CATALOG_VERSION` was added ad hoc for one cache
*after* the 2026-07-19 incident. Every other tool-written state file and every
operator-authored file is read with a shape check that answers "does this parse?", never
"was this written by this version?". Verified uncovered: `src/shared/io/` holds `json.ts`,
`lockedJsonStore.ts`, `stateDir.ts`; grep for `state_version` / `readVersionedJson` /
`schemaVersion` across `src/shared/io/` returns nothing.

A green suite proves nothing here by construction: fixtures are written by the code under
test. Both incidents were found by execution or by an adversary, never by CI.

## Proposed mechanism — class (a), scoped down from the reviewer's version

One shared reader in `src/shared/io/` —
`readVersionedJson(path, { version, parse })` — **scoped to tool-written, regenerable
state only**, where "unknown version ⇒ treat as absent ⇒ caller repopulates" is free.
`PROXY_CATALOG_VERSION` is the proven precedent; this generalises it.

⚠ **The reviewer's two-policy version is refused on the operator-authored half.** It
proposed a loud versioned error for operator files. That re-opens a door the owner
deliberately closed: `memory/renaming-a-persisted-field-is-not-a-rename.md` records that
`sources-declared.json` / `session-config.json` got *"no compat parsing at all, just a
loud validator error naming both renames"*, citing `[[prefer-ideal-code-no-backcompat]]`.
Requiring a version key on hand-edited config is a different thing from that, and would
fail closed on every existing file on the owner's box today. **Leave operator-authored
files on the existing loud-validator policy.**

## What it would have caught

- The `catalog-cache.json` double-grant re-opening (2026-07-19) — literally the fix that
  was applied to that one file, generalised.
- The `repair_proxy` silent lane loss (2026-07-18) would have been a named error rather
  than a missing lane — **but only if that file is reclassified as tool-written, which it
  is not.** Under the scoping above this proposal does *not* catch the 07-18 case. Stated
  plainly rather than claimed.

That leaves the honest hit-rate at 1 of 2 cited incidents. The owner should weigh whether
a shared reader is worth building for that, or whether extending the
`PROXY_CATALOG_VERSION` pattern by hand to the two or three other tool-written caches is
the proportionate move.

## False-positive surface

One forced regeneration per machine per version bump on tool-written caches — cheap, and
already accepted for the proxy catalog. No user-visible blocking.

## The part most likely to rot

The reviewer's enforcing half — "a test enumerating every tool-written path" — is a
hand-maintained table, the same class the 2026-07-24 loop-core entry (`docs/backlog.md:78`)
is complaining about (`LOOP_CORE_PATTERNS` triplicated across three files). If this is
built, the enumeration needs a *generation* story, or it becomes the next triplicated list.
