import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { withFileLock, STALE_LOCK_MS } from "./fileLock.js";

// On-disk node-claim registry (A-10). A claim is a soft lease a dispatch loop
// takes on a node before it starts work, so two concurrent loops driving the
// same goal can never both pick the same node. The registry file is a plain JSON
// map of nodeId → claim; the coordinator supplies its path (driver/path-agnostic,
// never derived here), and every read-modify-write runs inside withFileLock so
// the check-then-claim is atomic across processes.
//
// Staleness reuses the file lock's STALE_LOCK_MS verbatim (imported, not a second
// literal): a claim whose heartbeat is older than STALE_LOCK_MS is reclaimable,
// exactly mirroring the lock's own abandoned-holder recovery window. Release and
// reclaim are token-checked so a live owner that re-heartbeated is never clobbered
// by a stale-observation racer. The CE-002 accept/merge lifecycle gap is closed
// separately at the accept/merge layer by A-8 — this module is purely the mutual
// exclusion primitive.

export interface ClaimRecord {
  /** Opaque token minted at claim time; required to release or survive a reclaim. */
  ownerToken: string;
  /** Pool the claim was taken for (diagnostic / routing — not part of identity). */
  poolId: string;
  /** Epoch ms of the last heartbeat. Drives staleness against STALE_LOCK_MS. */
  heartbeatAt: number;
}

export type ClaimResult =
  | { acquired: true; ownerToken: string }
  | { acquired: false; heldBy: string };

type ClaimMap = Record<string, ClaimRecord>;

function mintOwnerToken(): string {
  return `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function isClaimRecord(value: unknown): value is ClaimRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.ownerToken === "string" &&
    typeof obj.poolId === "string" &&
    typeof obj.heartbeatAt === "number" &&
    Number.isFinite(obj.heartbeatAt)
  );
}

// Read the registry, degrading ANY malformed/absent state to an empty map. A
// corrupt registry must never throw into the dispatch loop — at worst a claim is
// re-granted, which the lock-serialized write then makes consistent again. Only
// well-formed individual records are retained; junk entries are dropped silently.
async function readClaimMap(registryPath: string): Promise<ClaimMap> {
  let raw: string;
  try {
    raw = await readFile(registryPath, "utf8");
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
  const out: ClaimMap = {};
  for (const [nodeId, record] of Object.entries(parsed as Record<string, unknown>)) {
    if (isClaimRecord(record)) out[nodeId] = record;
  }
  return out;
}

async function writeClaimMap(registryPath: string, claims: ClaimMap): Promise<void> {
  await mkdir(dirname(registryPath), { recursive: true });
  await writeFile(registryPath, `${JSON.stringify(claims, null, 2)}\n`, "utf8");
}

/**
 * File-backed claim registry. The caller owns the path (and may point two
 * coordinators at the same file — that is the whole point). Every mutating op
 * runs its entire read-modify-write inside `withFileLock(registryPath + '.lock')`
 * so concurrent loops are serialized and the single-grant invariant holds.
 *
 * The stale-reclaim window defaults to the file lock's `STALE_LOCK_MS` but is
 * per-registry configurable (`staleMs`): a claim guarding a long unit of work
 * (e.g. an audit task whose LLM execution outruns 30s) needs a longer lease than
 * a short state mutation, so a genuinely-live owner heartbeating on a timer is
 * never reclaimed mid-flight (OD3, `spec/multi-ide-concurrent-runs-design.md`).
 */
export class ClaimRegistry {
  private readonly lockPath: string;
  private readonly staleMs: number;

  constructor(
    private readonly registryPath: string,
    private readonly now: () => number = () => Date.now(),
    staleMs: number = STALE_LOCK_MS,
  ) {
    this.lockPath = `${registryPath}.lock`;
    this.staleMs = staleMs;
  }

  private isStale(record: ClaimRecord, now: number): boolean {
    return now - record.heartbeatAt > this.staleMs;
  }

  /**
   * Attempt to claim `nodeId` for `poolId`. Granted when the node is unclaimed or
   * the existing claim is stale (heartbeat older than STALE_LOCK_MS). Returns the
   * fresh ownerToken on success, or `{ acquired: false, heldBy }` carrying the
   * live owner's token when another loop holds it.
   */
  async claim(nodeId: string, poolId: string): Promise<ClaimResult> {
    return withFileLock(this.lockPath, async () => {
      const claims = await readClaimMap(this.registryPath);
      const now = this.now();
      const existing = claims[nodeId];
      if (existing && !this.isStale(existing, now)) {
        return { acquired: false, heldBy: existing.ownerToken };
      }
      const ownerToken = mintOwnerToken();
      claims[nodeId] = { ownerToken, poolId, heartbeatAt: now };
      await writeClaimMap(this.registryPath, claims);
      return { acquired: true, ownerToken };
    });
  }

  /**
   * Claim as many of `nodeIds` as are free (unclaimed or stale) in ONE lock-held
   * read-modify-write — the batch analogue of `claim`, so a peer partitioning a
   * pool of N tasks pays a single file write instead of N. Returns the granted
   * subset (nodeIds this call now owns) with their fresh owner tokens.
   *
   * `poolId` doubles as the OWNER identity for re-grant: a node already held by a
   * DIFFERENT live pool is omitted (that peer's disjoint partition), but a node
   * already held by the SAME `poolId` is RE-GRANTED (heartbeat refreshed). This
   * makes a caller that re-runs the partition under a stable poolId idempotent —
   * it reclaims its own in-flight nodes instead of skipping them — while distinct
   * pools still partition disjointly. (Audit passes the runId as poolId: one run's
   * repeated dispatch re-grants; two IDEs' runs skip each other.)
   */
  async claimMany(
    nodeIds: readonly string[],
    poolId: string,
  ): Promise<{ granted: string[]; ownerTokenByNode: Record<string, string> }> {
    return withFileLock(this.lockPath, async () => {
      const claims = await readClaimMap(this.registryPath);
      const now = this.now();
      const granted: string[] = [];
      const ownerTokenByNode: Record<string, string> = {};
      for (const nodeId of nodeIds) {
        const existing = claims[nodeId];
        // Skip only when a DIFFERENT pool holds it live; my own live claim is
        // re-grantable (idempotent re-partition).
        if (existing && !this.isStale(existing, now) && existing.poolId !== poolId) {
          continue;
        }
        const ownerToken = mintOwnerToken();
        claims[nodeId] = { ownerToken, poolId, heartbeatAt: now };
        granted.push(nodeId);
        ownerTokenByNode[nodeId] = ownerToken;
      }
      if (granted.length > 0) await writeClaimMap(this.registryPath, claims);
      return { granted, ownerTokenByNode };
    });
  }

  /**
   * Unconditionally remove claims for `nodeIds` (no token check), returning how
   * many were present. For authoritative release points where the work is known
   * done regardless of who dispatched it — e.g. releasing a task claim once its
   * result has been ingested — and for releasing over-claimed (deferred) nodes a
   * peer should be free to take. Distinct from `release`, which is token-checked.
   */
  async clear(nodeIds: readonly string[]): Promise<number> {
    return withFileLock(this.lockPath, async () => {
      const claims = await readClaimMap(this.registryPath);
      let removed = 0;
      for (const nodeId of nodeIds) {
        if (claims[nodeId]) {
          delete claims[nodeId];
          removed += 1;
        }
      }
      if (removed > 0) await writeClaimMap(this.registryPath, claims);
      return removed;
    });
  }

  /**
   * Refresh the heartbeat on a claim we still hold. Token-checked: a no-op if the
   * node is unclaimed or held under a different token. Returns whether the
   * heartbeat was applied. This is how a long-running owner stays "live" and so
   * survives a concurrent `reclaimStale()`.
   */
  async heartbeat(nodeId: string, ownerToken: string): Promise<boolean> {
    return withFileLock(this.lockPath, async () => {
      const claims = await readClaimMap(this.registryPath);
      const existing = claims[nodeId];
      if (!existing || existing.ownerToken !== ownerToken) return false;
      existing.heartbeatAt = this.now();
      await writeClaimMap(this.registryPath, claims);
      return true;
    });
  }

  /**
   * Release a claim we hold. Token-checked: only the owner can release, so a
   * stale-observation racer can never drop a claim another loop legitimately
   * holds. Returns whether a claim was removed.
   */
  async release(nodeId: string, ownerToken: string): Promise<boolean> {
    return withFileLock(this.lockPath, async () => {
      const claims = await readClaimMap(this.registryPath);
      const existing = claims[nodeId];
      if (!existing || existing.ownerToken !== ownerToken) return false;
      delete claims[nodeId];
      await writeClaimMap(this.registryPath, claims);
      return true;
    });
  }

  /**
   * Reclaim every claim whose heartbeat is older than STALE_LOCK_MS, returning
   * the freed nodeIds. A claim that was re-heartbeated since the staleness check
   * is — by the same single-lock serialization — observed fresh here and left
   * intact, so a live owner is never clobbered.
   */
  async reclaimStale(): Promise<string[]> {
    return withFileLock(this.lockPath, async () => {
      const claims = await readClaimMap(this.registryPath);
      const now = this.now();
      const reclaimed: string[] = [];
      for (const [nodeId, record] of Object.entries(claims)) {
        if (this.isStale(record, now)) {
          delete claims[nodeId];
          reclaimed.push(nodeId);
        }
      }
      if (reclaimed.length > 0) await writeClaimMap(this.registryPath, claims);
      return reclaimed;
    });
  }

  /** Snapshot of all current claims, keyed by nodeId. Read under the lock. */
  async listClaims(): Promise<ClaimMap> {
    return withFileLock(this.lockPath, async () => readClaimMap(this.registryPath));
  }

  /**
   * Whether `nodeId` currently has a LIVE (non-stale) claim. A stale claim reads
   * as not-claimed, since the next `claim()` would grant over it.
   */
  async isClaimed(nodeId: string): Promise<boolean> {
    return withFileLock(this.lockPath, async () => {
      const claims = await readClaimMap(this.registryPath);
      const existing = claims[nodeId];
      return existing !== undefined && !this.isStale(existing, this.now());
    });
  }
}
