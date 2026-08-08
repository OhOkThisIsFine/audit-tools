import { readFile } from "node:fs/promises";
import { writeJsonFile } from "../io/json.js";

// The JSON-map store substrate shared by claimRegistry (nodeId → claim) and
// reservationLedger (resourceKey → leases[]). Both had byte-copied the token
// mint and the atomic write, and both spell the same read→parse→degrade→filter
// skeleton. Only the per-key admission differs, so that is the parameter.
//
// What deliberately does NOT live here: the domain guards and the two classes.
// A claim (single grant, heartbeat staleness) and a lease (multi-per-key, cost
// summation, TTL) are different domain objects, and `withFileLock` is already
// single-sourced in ./fileLock.js — neither store carries lock scaffolding of
// its own.

/**
 * Opaque, process-unique token. Both stores minted this identically: a claim's
 * `ownerToken` and a lease's `leaseId` are the same kind of thing — a value only
 * the minting caller can present back to release what it took.
 */
export function mintToken(): string {
  return `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Read a `Record<string, T>` JSON store, degrading ANY malformed or absent state
 * to an empty map. A corrupt store must never throw into the dispatch loop; the
 * failure direction is fail-open (a claim re-granted / a reservation missed),
 * the same class as INV-QD-15.
 *
 * `pick` decides what a key's value becomes, returning `undefined` to drop the
 * key entirely. It is a PICK rather than a type guard on purpose: the ledger
 * filters junk leases out of an array and keeps the survivors, so a whole-value
 * guard would wrongly discard a key over one bad element.
 */
export async function readRecordMap<T>(
  path: string,
  pick: (value: unknown) => T | undefined,
): Promise<Record<string, T>> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: Record<string, T> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const kept = pick(value);
    if (kept !== undefined) out[key] = kept;
  }
  return out;
}

/**
 * Atomic (temp + rename, via the shared `writeJsonFile`). A truncating in-place
 * write would leave a permanently-torn store behind a crash mid-write, which the
 * readers above then degrade to `{}`.
 */
export async function writeRecordMap<T>(
  path: string,
  map: Record<string, T>,
): Promise<void> {
  await writeJsonFile(path, map);
}
