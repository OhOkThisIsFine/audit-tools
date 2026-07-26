# The version gate cannot see unstamped state — and that is usually correct

`check:version-gates` reports "N persisted payloads read back under a version check, 0
unchecked". That sentence is narrower than it reads, and the gap is worth stating once so a
future pass does not re-derive it.

## What the gate enumerates

The script discovers a "persisted payload" structurally: a type declaring a version-key
member (`schema_version` / `contract_version` / `*_schema_version`) as `typeof C`. State
written with **no** version field is therefore not counted as `unchecked` — it is invisible
to the enumeration entirely. `0 unchecked` means *every stamped payload is gated on read*,
never *all persisted state is version-safe*.

## Why that is not the defect it looks like

Two loop-core modules persist state carrying no stamp. Both were checked as candidates for
the shared read policy, and both correctly stay as they are:

- **`src/shared/dispatch/settledPools.ts`** persists a bare `string[]`. There is no field to
  rename. `readSettledPools` filters `Array.isArray(raw) ? raw.filter(isString) : []`, which
  is already "treat as absent and rebuild". Adding a stamp would require changing the on-disk
  shape from array to object — introducing exactly the old-bytes-under-new-semantics hazard
  the policy exists to remove, to fix nothing.

- **`src/shared/quota/claimRegistry.ts`** persists a `nodeId → record` map and validates every
  field it reads, per record (`isClaimRecord`). A renamed field fails that check, the record is
  dropped, and the node reads as unclaimed — discard semantics at record granularity. A
  whole-file version discard would be strictly *worse*: it would drop a live peer's in-flight
  leases wholesale and break the disjoint-partition invariant. A throwing gate is refused
  outright by the documented fail-open rule — a corrupt registry must never throw into the
  dispatch loop, because at worst a claim is re-granted and the lock-serialized write
  reconciles it.

## The rule

**Per-field structural validation on read is the second correct version policy**, alongside the
two in `src/shared/io/schemaVersion.ts`. A validator that guards every field the caller reads
already degrades a shape change to absent; a version stamp on top is redundant, and on
concurrent state it is a regression, because it discards at file granularity what the
validator discards at record granularity.

So: unstamped state is not automatically a gap. Ask which of the three policies the state is
under, and only call it a defect if it is under none of them.
