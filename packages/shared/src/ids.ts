/**
 * Shared id primitives.
 *
 * `mintUniqueId` is the single source for the collision-disambiguation
 * convention used wherever a stable id is generated against a set of ids already
 * in use (finding ids, derived obligation/node ids, …). Keeping the suffix
 * scheme in one place matters: any producer and any parser of these ids must
 * agree on it, or a re-keyed id on one side won't round-trip a parse on the
 * other.
 */

/**
 * Mint a unique id from `base`, disambiguating a collision against `used`
 * deterministically with a numeric `-2`, `-3`, … suffix (the first collision
 * becomes `${base}-2`). Adds the minted id to `used` and returns it, so callers
 * can mint a run of ids by threading one `Set`.
 */
export function mintUniqueId(used: Set<string>, base: string): string {
  let id = base;
  let n = 2;
  while (used.has(id)) {
    id = `${base}-${n}`;
    n += 1;
  }
  used.add(id);
  return id;
}
