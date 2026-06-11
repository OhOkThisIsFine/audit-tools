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

export interface OwnershipRegistryJson {
  /** nodeId → set of paths from that node's original contract scope */
  contractScopes: Record<string, string[]>;
  /** nodeId → set of in-flight amendment claims (dispatched but not yet merged) */
  amendmentClaims: Record<string, string[]>;
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

  /** Optional path for checkpoint persistence. When provided, every mutation
   * atomically writes the registry state to this path. */
  private checkpointPath: string | undefined;

  constructor(checkpointPath?: string) {
    this.checkpointPath = checkpointPath;
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
    // Check if path is in any OTHER node's contract scope.
    for (const [scopeNodeId, scopePaths] of this.contractScopes) {
      if (scopeNodeId !== nodeId && scopePaths.has(path)) {
        return "owned";
      }
    }

    // Check if path has already been amendment-claimed by a live parallel sibling.
    const existingClaimant = this.amendmentClaims.get(path);
    if (existingClaimant !== undefined && existingClaimant !== nodeId) {
      return "contended";
    }

    // Grant: record the claim.
    this.amendmentClaims.set(path, nodeId);
    this._persist();
    return "granted";
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
    for (const [nodeId, scopePaths] of this.contractScopes) {
      if (scopePaths.has(path)) return nodeId;
    }
    return undefined;
  }

  /**
   * Return the node ID that has an in-flight amendment claim for this path, or
   * undefined if uncontended.
   */
  amendmentClaimant(path: string): string | undefined {
    return this.amendmentClaims.get(path);
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
    return { contractScopes, amendmentClaims };
  }

  /**
   * Restore an OwnershipRegistry from a serialized JSON object.
   * `knownNodeIds` is the set of node IDs in the current implementation DAG;
   * any in-flight amendment claim for a node NOT in this set is purged (stale).
   */
  static fromJson(
    json: OwnershipRegistryJson,
    knownNodeIds: Set<string>,
    checkpointPath?: string,
  ): OwnershipRegistry {
    const registry = new OwnershipRegistry(checkpointPath);

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

    return registry;
  }

  /** Write checkpoint synchronously after each mutation. */
  private _persist(): void {
    if (!this.checkpointPath) return;
    const json = JSON.stringify(this.serialize(), null, 2) + "\n";
    try {
      mkdirSync(dirname(this.checkpointPath), { recursive: true });
      writeFileSync(this.checkpointPath, json, "utf8");
    } catch {
      // Best-effort: a checkpoint write failure must not crash the orchestrator.
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
