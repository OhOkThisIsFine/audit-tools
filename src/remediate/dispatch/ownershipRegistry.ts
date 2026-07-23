/**
 * OwnershipRegistry — tracks which DAG node owns which file paths (write-scope
 * declared in its contract). Used by the rolling-dispatch loop to gate
 * amendment claims: a worker that discovers a necessary edit outside its declared
 * contract scope may unilaterally extend write-scope ONLY into unowned files.
 *
 * Atomicity: claim registration is a synchronous in-memory CAS within a
 * single-threaded orchestrator (no TOCTOU). The registry is checkpointed to
 * `dispatch/ownership-registry.json` after each mutation so it survives a restart.
 * Stale in-flight claims (node ID not in the current implementation DAG) are
 * purged on load.
 */

import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
// Path canonicalization for ownership identity (INV-SOO-09) is single-sourced in
// `audit-tools/shared` so both orchestrators' scheduling key file identity the same
// way. Re-exported here for this module's existing consumers.
import { canonicalizeFilePath } from "audit-tools/shared";
export { canonicalizeFilePath };

/**
 * The disposition a node reaches when the rolling engine stops driving it for the
 * current pass. INV-SOO-10 (releasing-disposition discipline) keys the claim
 * lifecycle off this: a RELEASING disposition frees the node's in-flight claim
 * (`releaseInFlight`); a CLAIM-RETAINING disposition keeps it held so no foreign
 * same-file node can be admitted on the still-contested key.
 */
export type NodeClaimDisposition =
  // Releasing — the node is done with its file(s); the claim is freed.
  | "merged"
  | "blocked_final"
  | "abandoned"
  | "failed_no_retry"
  | "no_op_satisfied"
  // Claim-retaining — the node is still live on its file(s); the claim is held.
  | "blocked_pending_triage"
  | "triage_retry_handoff" // CE-006: A→A' hand-off retains K across the window
  | "redispatch"; // CE-007: an M4 RepairOutcome.redispatch of an in-flight node

/**
 * Single source of truth for INV-SOO-10: whether `disposition` RELEASES the
 * node's in-flight file claim. A redispatch (CE-007) and a triage-retry hand-off
 * (CE-006) are explicitly claim-RETAINING — the key stays held by the node across
 * the re-emit / recomputation window so the re-run can never run boundary-ungated
 * alongside a foreign same-file writer. The enumeration is exhaustive (a `never`
 * fallthrough keeps it in lockstep with `NodeClaimDisposition`).
 */
export function isReleasingDisposition(disposition: NodeClaimDisposition): boolean {
  switch (disposition) {
    case "merged":
    case "blocked_final":
    case "abandoned":
    case "failed_no_retry":
    case "no_op_satisfied":
      return true;
    case "blocked_pending_triage":
    case "triage_retry_handoff":
    case "redispatch":
      return false;
    default: {
      const _exhaustive: never = disposition;
      return _exhaustive;
    }
  }
}

export interface OwnershipRegistryJson {
  /** nodeId → set of paths from that node's original contract scope */
  contractScopes: Record<string, string[]>;
  /** nodeId → set of in-flight amendment claims (dispatched but not yet merged) */
  amendmentClaims: Record<string, string[]>;
  /**
   * canonical path → nodeId: the scheduling-time in-flight WRITER claims
   * (INV-SOO-01). Serialized so a restart cannot silently drop every live
   * writer claim — without it a resumed run admits a foreign same-file node
   * boundary-ungated alongside the still-running writer (COR-0ad18f1a).
   * Optional for checkpoints written before this field existed (treated empty).
   */
  inFlightClaims?: Record<string, string>;
  /**
   * The canonicalization root (INV-SOO-09). Serialized so a restored registry
   * keys file identity the same way the live one did — dropping it made every
   * post-restart canonical comparison use raw spellings (COR-70a46faa).
   */
  root?: string;
}

/**
 * OwnershipRegistry tracks write-scope ownership per DAG node.
 *
 * Initialization:
 *   const registry = new OwnershipRegistry(checkpointPath);
 *   registry.initialize(dagNodes);   // call once before dispatching
 *
 * Per-node lifecycle:
 *   const claim = registry.claimAmendment(nodeId, path);
 *   // on merge or triage:
 *   registry.releaseAmendments(nodeId);
 */
export class OwnershipRegistry {
  /** nodeId → paths from the node's original contract scope */
  private contractScopes: Map<string, Set<string>> = new Map();

  /**
   * path → nodeId: which live parallel sibling (dispatched, not yet merged) has
   * claimed this path via an amendment.
   */
  private amendmentClaims: Map<string, string> = new Map();

  /**
   * canonical path → nodeId: scheduling-time in-flight WRITER claim. Lifted from
   * the merge-time amendment signal into scheduling-time admission (INV-SOO):
   * the rolling scheduler holds at most one in-flight writer per canonical path,
   * so same-file nodes serialize while different-file nodes parallelize. Keyed by
   * `canonicalizeFilePath` so all spellings of one file collide (INV-SOO-09).
   */
  private inFlightClaims: Map<string, string> = new Map();

  /** Optional path for checkpoint persistence. When provided, every mutation
   * atomically writes the registry state to this path. */
  private checkpointPath: string | undefined;

  /** Repo root for canonicalizing relative scope/claim paths to physical identity. */
  private root: string | undefined;

  constructor(checkpointPath?: string, root?: string) {
    this.checkpointPath = checkpointPath;
    this.root = root;
  }

  /** Canonicalize a path to physical-file identity under this registry's root. */
  private canon(path: string): string {
    return canonicalizeFilePath(path, { root: this.root });
  }

  /**
   * Initialize the registry from the implementation DAG nodes. Each node's
   * `affected_files` (or `write_paths`) constitutes its contract scope.
   * Call once before any node is dispatched.
   */
  initialize(nodes: Array<{ node_id: string; affected_files?: string[]; write_paths?: string[] }>): void {
    this.contractScopes.clear();
    this.amendmentClaims.clear();
    for (const node of nodes) {
      const paths = node.affected_files ?? node.write_paths ?? [];
      this.contractScopes.set(node.node_id, new Set(paths));
    }
    this._persist();
  }

  /**
   * Attempt to claim `path` for `nodeId` as an amendment (write outside the
   * node's original contract scope).
   *
   * Returns:
   *  - `'granted'`    — path was unowned and uncontended; claim is recorded.
   *  - `'owned'`      — path is in another node's contract scope; routes to seam protocol.
   *  - `'contended'`  — path has been claimed by a live parallel sibling; routes to seam protocol.
   */
  claimAmendment(nodeId: string, path: string): "granted" | "owned" | "contended" {
    const key = this.canon(path);
    // Check if path is in any OTHER node's contract scope (canonical identity).
    for (const [scopeNodeId, scopePaths] of this.contractScopes) {
      if (scopeNodeId !== nodeId && this._scopeHasCanonical(scopePaths, key)) {
        return "owned";
      }
    }

    // Check if path has already been amendment-claimed by a live parallel sibling
    // (canonical identity, so a differently-spelled same file collides).
    const existingClaimant = this._amendmentClaimantByCanonical(key);
    if (existingClaimant !== undefined && existingClaimant !== nodeId) {
      return "contended";
    }

    // Grant-time disjointness (INV-SOO-06 / CE-001): refuse a scope-widening grant
    // onto a file another in-flight node is actively writing, so a post-admission
    // grant can never make the in-flight owned-file union non-disjoint.
    const inFlightOwner = this.inFlightClaims.get(key);
    if (inFlightOwner !== undefined && inFlightOwner !== nodeId) {
      return "contended";
    }

    // Grant: record the claim under the ORIGINAL spelling (merge attribution reads
    // the raw path); canonical identity is applied on comparison, not on storage.
    this.amendmentClaims.set(path, nodeId);
    this._persist();
    return "granted";
  }

  /** The node holding an amendment claim whose canonical key matches `canonicalKey`. */
  private _amendmentClaimantByCanonical(canonicalKey: string): string | undefined {
    for (const [p, claimant] of this.amendmentClaims) {
      if (this.canon(p) === canonicalKey) return claimant;
    }
    return undefined;
  }

  /** Whether a contract-scope set contains a path with the given canonical key. */
  private _scopeHasCanonical(scopePaths: Set<string>, canonicalKey: string): boolean {
    for (const p of scopePaths) {
      if (this.canon(p) === canonicalKey) return true;
    }
    return false;
  }

  /**
   * Release all amendment claims for `nodeId`. Call when a node finishes
   * (merge or triage). Makes the previously claimed files available again.
   */
  releaseAmendments(nodeId: string): void {
    let changed = false;
    for (const [path, claimant] of this.amendmentClaims) {
      if (claimant === nodeId) {
        this.amendmentClaims.delete(path);
        changed = true;
      }
    }
    if (changed) {
      this._persist();
    }
  }

  /**
   * Returns the union of the node's original contract `affected_files` and its
   * granted amendment claims — used to re-derive the write-scope for verification
   * and blast-radius attribution.
   */
  getScope(nodeId: string): string[] {
    const contractPaths = this.contractScopes.get(nodeId) ?? new Set<string>();
    const amendmentPaths: string[] = [];
    for (const [path, claimant] of this.amendmentClaims) {
      if (claimant === nodeId) {
        amendmentPaths.push(path);
      }
    }
    return [...contractPaths, ...amendmentPaths];
  }

  /**
   * Return the node ID that owns this path via contract scope, or undefined if
   * the path is unowned.
   */
  contractOwner(path: string): string | undefined {
    const key = this.canon(path);
    for (const [nodeId, scopePaths] of this.contractScopes) {
      if (this._scopeHasCanonical(scopePaths, key)) return nodeId;
    }
    return undefined;
  }

  /**
   * Return the node ID that has an in-flight amendment claim for this path, or
   * undefined if uncontended. Canonical identity (INV-SOO-09).
   */
  amendmentClaimant(path: string): string | undefined {
    // Exact-spelling hit first (cheap), else canonical match.
    return (
      this.amendmentClaims.get(path) ??
      this._amendmentClaimantByCanonical(this.canon(path))
    );
  }

  // ── Scheduling-time file-ownership queries (INV-SOO) ───────────────────────

  /**
   * Canonical write-scope of a node for scheduling: its contract scope ∪ live
   * amendment claims, each canonicalized to physical-file identity (INV-SOO-09).
   */
  canonicalScope(nodeId: string): Set<string> {
    const out = new Set<string>();
    for (const p of this.contractScopes.get(nodeId) ?? []) out.add(this.canon(p));
    for (const [key, claimant] of this.amendmentClaims) {
      if (claimant === nodeId) out.add(key);
    }
    return out;
  }

  /**
   * The union of canonical file paths owned by currently in-flight nodes (their
   * scheduling claims). The scheduling-time complement of the merge-time owner
   * signal — a path in this set has a live writer, so a same-file node must wait
   * (INV-SOO-01).
   */
  filesClaimedByInFlight(): Set<string> {
    return new Set(this.inFlightClaims.keys());
  }

  /** The node holding the in-flight scheduling claim on `path`, or undefined. */
  inFlightOwner(path: string): string | undefined {
    return this.inFlightClaims.get(this.canon(path));
  }

  /**
   * Whether `nodeId`'s declared write-scope is file-ownership-DISJOINT from the
   * current in-flight set — i.e. it shares no canonical path with any OTHER
   * in-flight node, so it can be admitted without two in-flight writers per file
   * (INV-SOO-01).
   *
   * Conservative empty-scope gating (INV-SOO-01 / CE-008): a node whose declared
   * scope canonicalizes to the EMPTY set (unresolved/undeclared) is treated as
   * NON-disjoint — it is NOT admitted as vacuously-disjoint, because an
   * under-declared writer could collide with anything. Such a node admits only
   * when no other node is in flight (`requireSoloWhenEmpty`).
   */
  isFileOwnershipDisjoint(
    nodeId: string,
    declaredScope: Iterable<string>,
  ): boolean {
    const scope = new Set<string>();
    for (const p of declaredScope) scope.add(this.canon(p));
    if (scope.size === 0) {
      // Empty/unresolved scope: disjoint only if nothing else is in flight.
      for (const owner of this.inFlightClaims.values()) {
        if (owner !== nodeId) return false;
      }
      return true;
    }
    for (const key of scope) {
      const owner = this.inFlightClaims.get(key);
      if (owner !== undefined && owner !== nodeId) return false;
    }
    return true;
  }

  /**
   * Record `nodeId`'s scheduling-time in-flight WRITER claim over `paths`
   * (declared scope, canonicalized). Idempotent for a node re-claiming its own
   * paths (a rate-limited re-queue). Call BEFORE dispatching the node.
   */
  claimInFlight(nodeId: string, paths: Iterable<string>): void {
    let changed = false;
    for (const p of paths) {
      const key = this.canon(p);
      const existing = this.inFlightClaims.get(key);
      if (existing === nodeId) continue;
      // Caller guarantees disjointness via isFileOwnershipDisjoint; a foreign
      // owner here is a precondition violation, surfaced rather than overwritten.
      if (existing !== undefined && existing !== nodeId) {
        throw new Error(
          `OwnershipRegistry.claimInFlight: ${key} already in-flight by ${existing}, ` +
            `cannot claim for ${nodeId} (file-ownership-disjoint precondition violated).`,
        );
      }
      this.inFlightClaims.set(key, nodeId);
      changed = true;
    }
    if (changed) this._persist();
  }

  /**
   * Release `nodeId`'s scheduling-time in-flight claims (and any amendment claims
   * it holds). Call on a RELEASING disposition (INV-SOO-10):
   * blocked-final / abandoned / merged / failed-no-retry / no-op-satisfied. A
   * blocked-PENDING-triage node is still live and must NOT call this — it retains.
   */
  releaseInFlight(nodeId: string): void {
    let changed = false;
    for (const [key, owner] of this.inFlightClaims) {
      if (owner === nodeId) {
        this.inFlightClaims.delete(key);
        changed = true;
      }
    }
    if (changed) this._persist();
  }

  /**
   * Atomic triage-retry claim hand-off A→A' (INV-SOO-07): transfer all of the
   * failed node's in-flight + amendment claims to its successor in one step, so
   * there is no observable window in which both hold the file, nor one in which a
   * foreign same-file node is admitted between release and re-claim. A no-op when
   * `fromNodeId === toNodeId`.
   */
  handoffInFlight(fromNodeId: string, toNodeId: string): void {
    if (fromNodeId === toNodeId) return;
    let changed = false;
    for (const [key, owner] of this.inFlightClaims) {
      if (owner === fromNodeId) {
        this.inFlightClaims.set(key, toNodeId);
        changed = true;
      }
    }
    for (const [key, owner] of this.amendmentClaims) {
      if (owner === fromNodeId) {
        this.amendmentClaims.set(key, toNodeId);
        changed = true;
      }
    }
    if (changed) this._persist();
  }

  /**
   * Redispatch of an in-flight node (CE-007 / INV-SOO-10): an M4
   * RepairOutcome.redispatch re-emits the SAME node without releasing its claim.
   * This is a claim-RETAINING disposition — `nodeId` keeps every in-flight +
   * amendment claim it holds across the re-emit, so the re-run cannot be admitted
   * boundary-ungated alongside a foreign same-file writer. A no-op on the registry
   * by construction (the claim is simply not released); this named affordance
   * exists so callers route a redispatch through it (and `isReleasingDisposition`)
   * rather than reasoning about claim retention by hand. Verifies the node still
   * holds a live claim so a redispatch of an already-released node surfaces as a
   * precondition violation instead of silently running ungated.
   */
  redispatchInFlight(nodeId: string): void {
    for (const owner of this.inFlightClaims.values()) {
      if (owner === nodeId) return; // still holds at least one claim — retained.
    }
    for (const owner of this.amendmentClaims.values()) {
      if (owner === nodeId) return;
    }
    throw new Error(
      `OwnershipRegistry.redispatchInFlight: ${nodeId} holds no live claim; ` +
        `a redispatch must retain an existing claim (claim-retaining disposition, CE-007). ` +
        `Re-claim via claimInFlight before redispatching.`,
    );
  }

  /**
   * Apply a node's terminal-for-this-pass disposition to its claim lifecycle in
   * one call (INV-SOO-10). A releasing disposition frees the claim; a
   * claim-retaining one leaves it held. Single entry-point so the release-vs-retain
   * decision is never re-derived by callers (auditor-agnostic robustness). For a
   * `triage_retry_handoff` pass the successor id via `toNodeId` so the claim is
   * atomically transferred (CE-006) rather than released-then-reclaimed.
   */
  applyDisposition(
    nodeId: string,
    disposition: NodeClaimDisposition,
    toNodeId?: string,
  ): void {
    if (disposition === "triage_retry_handoff") {
      this.handoffInFlight(nodeId, toNodeId ?? nodeId);
      return;
    }
    if (isReleasingDisposition(disposition)) {
      this.releaseInFlight(nodeId);
      this.releaseAmendments(nodeId);
      return;
    }
    // blocked_pending_triage / redispatch: claim-retaining — leave it held.
  }

  /** Serialize to a plain JSON-safe object. */
  serialize(): OwnershipRegistryJson {
    const contractScopes: Record<string, string[]> = {};
    for (const [nodeId, paths] of this.contractScopes) {
      contractScopes[nodeId] = [...paths];
    }
    const amendmentClaims: Record<string, string[]> = {};
    // Group by nodeId for storage: Record<nodeId, path[]>
    const byNode = new Map<string, string[]>();
    for (const [path, nodeId] of this.amendmentClaims) {
      if (!byNode.has(nodeId)) byNode.set(nodeId, []);
      byNode.get(nodeId)!.push(path);
    }
    for (const [nodeId, paths] of byNode) {
      amendmentClaims[nodeId] = paths;
    }
    const inFlightClaims: Record<string, string> = {};
    for (const [key, nodeId] of this.inFlightClaims) {
      inFlightClaims[key] = nodeId;
    }
    return {
      contractScopes,
      amendmentClaims,
      inFlightClaims,
      ...(this.root !== undefined ? { root: this.root } : {}),
    };
  }

  /**
   * Restore an OwnershipRegistry from a serialized JSON object.
   * `knownNodeIds` is the set of node IDs in the current implementation DAG;
   * any in-flight (scheduling or amendment) claim for a node NOT in this set
   * is purged (stale). The canonicalization root round-trips from the payload
   * (INV-SOO-09) so restored comparisons key file identity identically.
   */
  static fromJson(
    json: OwnershipRegistryJson,
    knownNodeIds: Set<string>,
    checkpointPath?: string,
  ): OwnershipRegistry {
    const registry = new OwnershipRegistry(checkpointPath, json.root);

    for (const [nodeId, paths] of Object.entries(json.contractScopes)) {
      registry.contractScopes.set(nodeId, new Set(paths));
    }

    // Restore amendment claims; purge stale ones whose node is no longer in DAG.
    for (const [nodeId, paths] of Object.entries(json.amendmentClaims)) {
      if (!knownNodeIds.has(nodeId)) {
        // Stale node — drop all its amendment claims.
        continue;
      }
      for (const path of paths) {
        registry.amendmentClaims.set(path, nodeId);
      }
    }

    // Restore the scheduling-time in-flight writer claims (INV-SOO-01 restart
    // survival); purge claims held by nodes no longer in the DAG.
    for (const [key, nodeId] of Object.entries(json.inFlightClaims ?? {})) {
      if (!knownNodeIds.has(nodeId)) continue;
      registry.inFlightClaims.set(key, nodeId);
    }

    return registry;
  }

  /** Write checkpoint synchronously after each mutation. */
  private _persist(): void {
    if (!this.checkpointPath) return;
    const json = JSON.stringify(this.serialize(), null, 2) + "\n";
    try {
      mkdirSync(dirname(this.checkpointPath), { recursive: true });
      writeFileSync(this.checkpointPath, json, "utf8");
    } catch (err) {
      // Best-effort: a checkpoint write failure must not crash the orchestrator.
      process.stderr.write(
        JSON.stringify({
          level: "warn",
          event: "ownership_registry_persist_failed",
          path: this.checkpointPath,
          code: (err as NodeJS.ErrnoException).code ?? null,
          message: String(err),
          ts: new Date().toISOString(),
        }) + "\n",
      );
    }
  }

  /** Load from a checkpoint file; returns undefined if the file doesn't exist or can't be parsed. */
  static loadFromCheckpoint(
    checkpointPath: string,
    knownNodeIds: Set<string>,
  ): OwnershipRegistry | undefined {
    let raw: string;
    try {
      raw = readFileSync(checkpointPath, "utf8");
    } catch {
      return undefined;
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return undefined;
    }
    if (
      typeof json !== "object" ||
      json === null ||
      !("contractScopes" in json) ||
      !("amendmentClaims" in json)
    ) {
      return undefined;
    }
    return OwnershipRegistry.fromJson(json as OwnershipRegistryJson, knownNodeIds, checkpointPath);
  }
}
