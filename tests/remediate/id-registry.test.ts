/**
 * S4 (single ID authority): the id registry owns the CP-BLOCK- block-id <-> bare
 * node-id mapping, and the dispatch merge resolves block ids through it
 * deterministically — so the tolerant alias remap is defence-in-depth, not
 * load-bearing.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CP_BLOCK_PREFIX,
  toBlockId,
  isBlockId,
  fromBlockId,
  ensureNodeId,
} from "../../src/remediate/contractPipeline/idRegistry.js";
import { collapseItemResults } from "../../src/remediate/steps/dispatch.js";
import { promoteImplementationDagToExtractedPlan } from "../../src/remediate/steps/contractPipeline.js";
import { writeContractArtifact } from "../../src/remediate/contractPipeline/artifactStore.js";
import { intakePaths } from "../../src/remediate/intake.js";

describe("idRegistry (S4 single ID authority)", () => {
  it("toBlockId applies the CP-BLOCK- prefix", () => {
    expect(toBlockId("N-foo")).toBe("CP-BLOCK-N-foo");
    expect(toBlockId("N-foo").startsWith(CP_BLOCK_PREFIX)).toBe(true);
  });

  it("isBlockId distinguishes a block id from a bare id", () => {
    expect(isBlockId("CP-BLOCK-N-foo")).toBe(true);
    expect(isBlockId("N-foo")).toBe(false);
  });

  it("fromBlockId reverses toBlockId and returns null for a non-block id", () => {
    expect(fromBlockId("CP-BLOCK-N-foo")).toBe("N-foo");
    expect(fromBlockId("N-foo")).toBeNull();
    expect(fromBlockId("OBL-x-inv-1")).toBeNull();
  });

  it("is a bijection on bare node ids: fromBlockId(toBlockId(n)) === n", () => {
    for (const n of ["N-foo", "N-1", "node.with.dots", "CP-BLOCK-weird"]) {
      expect(fromBlockId(toBlockId(n))).toBe(n);
    }
  });
});

describe("ensureNodeId (single fallback authority — closes the finding<->block merge trap)", () => {
  it("returns the planner-authored id verbatim when present", () => {
    expect(ensureNodeId("N-foo", 0)).toBe("N-foo");
    expect(ensureNodeId("N-foo", 5)).toBe("N-foo");
  });

  it("applies the deterministic 1-indexed zero-padded CP-NNN fallback when the id is missing", () => {
    expect(ensureNodeId(undefined, 0)).toBe("CP-001");
    expect(ensureNodeId(undefined, 9)).toBe("CP-010");
    expect(ensureNodeId(undefined, 122)).toBe("CP-123");
  });

  it("the finding id and the block id stay consistent when node.id is missing (the bug this closes)", () => {
    // Before: finding id used the CP-NNN fallback but block_id/items used the raw
    // (undefined) node.id -> finding `CP-001` vs block `CP-BLOCK-undefined`, so the
    // worker result could not be resolved back to the finding. Routing both through
    // ensureNodeId makes them round-trip.
    const index = 0;
    const findingId = ensureNodeId(undefined, index);
    const blockId = toBlockId(ensureNodeId(undefined, index));
    expect(blockId).toBe("CP-BLOCK-CP-001");
    expect(fromBlockId(blockId)).toBe(findingId);
  });
});

describe("collapseItemResults resolves block ids via the registry (S4), not the alias remap", () => {
  const known = new Set(["N-foo"]);

  it("a worker that reports the CP-BLOCK- block id resolves to the node id with an EMPTY alias map", () => {
    // An empty alias map proves the resolution came from the id registry, not the
    // tolerant remap — the registry is load-bearing, the remap is not (INV-DISPATCH).
    const { collapsed, unresolved } = collapseItemResults(
      [{ finding_id: toBlockId("N-foo"), status: "resolved" }],
      new Map(),
      known,
    );
    expect(unresolved).toEqual([]);
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0].finding_id).toBe("N-foo");
  });

  it("a bare node id resolves directly", () => {
    const { collapsed } = collapseItemResults(
      [{ finding_id: "N-foo", status: "resolved" }],
      new Map(),
      known,
    );
    expect(collapsed[0].finding_id).toBe("N-foo");
  });

  it("a non-block alias (e.g. a mislabelled obligation id) still falls back to the tolerant alias map", () => {
    const aliasMap = new Map([["OBL-x", "N-foo"]]);
    const { collapsed, unresolved } = collapseItemResults(
      [{ finding_id: "OBL-x", status: "resolved" }],
      aliasMap,
      known,
    );
    expect(unresolved).toEqual([]);
    expect(collapsed[0].finding_id).toBe("N-foo");
  });

  it("a block id whose node is not known does not silently resolve (fail-closed)", () => {
    const { collapsed, unresolved } = collapseItemResults(
      [{ finding_id: toBlockId("N-unknown"), status: "resolved" }],
      new Map(),
      known,
    );
    expect(collapsed).toEqual([]);
    expect(unresolved).toHaveLength(1);
  });
});

// ── INV-FID-01 (end-to-end regression for the finding<->block merge trap) ──────
//
// The unit tests above prove ensureNodeId + toBlockId/fromBlockId round-trip in
// isolation. This exercises the actual plan-extraction path: a DAG whose node
// carries NO `id` (the LLM envelope is an unchecked cast, so `id` can be absent
// at runtime). The promoted plan's finding id, block_id, and items MUST all use
// the same minted fallback id — never `CP-BLOCK-undefined` / `items: [undefined]`
// — so a worker result for that block resolves back to the finding instead of
// landing in `unresolved`.
describe("INV-FID-01: a node with node.id undefined still resolves end-to-end", () => {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const TEST_DIR = join(__dirname, ".test-inv-fid-01");
  const ARTIFACTS_DIR = join(TEST_DIR, ".audit-tools", "remediation");

  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it("promotes a missing-id node to a finding+block that round-trip through fromBlockId", async () => {
    await mkdir(ARTIFACTS_DIR, { recursive: true });

    // A two-node DAG: the FIRST node is missing `id` entirely (the runtime hole),
    // the second has one. Both must promote to resolvable blocks.
    await writeContractArtifact(ARTIFACTS_DIR, "implementation_dag", {
      goal_id: "G-INV-FID-01",
      nodes: [
        {
          // id intentionally omitted — the unchecked-cast runtime hole.
          title: "Node without an id",
          description: "Must still promote to a resolvable block.",
          satisfies_obligations: ["OBL-x"],
          verification_obligation_ids: ["OBL-x"],
          output_files: ["src/x.ts"],
          depends_on: [],
        },
        {
          id: "N-second",
          title: "Node with an id",
          description: "Depends on the first (missing-id) node.",
          satisfies_obligations: ["OBL-y"],
          verification_obligation_ids: ["OBL-y"],
          output_files: ["src/y.ts"],
          // Depends on the index-0 fallback id — its dep block id must point at
          // the SAME fallback, not CP-BLOCK-undefined.
          depends_on: ["CP-001"],
        },
      ],
    });

    await promoteImplementationDagToExtractedPlan(ARTIFACTS_DIR);

    const plan = JSON.parse(
      await readFile(intakePaths(ARTIFACTS_DIR).extractedPlan, "utf8"),
    ) as {
      findings: Array<{ id: string }>;
      blocks: Array<{ block_id: string; items: string[]; dependencies: string[] }>;
    };

    // The missing-id node got the deterministic CP-001 fallback for its finding.
    const findingIds = new Set(plan.findings.map((f) => f.id));
    expect(findingIds.has("CP-001")).toBe(true);
    // No finding id is undefined/blank.
    expect([...findingIds].every((id) => typeof id === "string" && id.length > 0)).toBe(
      true,
    );

    const firstBlock = plan.blocks[0];
    // The block id is NOT CP-BLOCK-undefined, and its single item is NOT undefined.
    expect(firstBlock.block_id).toBe(toBlockId("CP-001"));
    expect(firstBlock.block_id).not.toContain("undefined");
    expect(firstBlock.items).toEqual(["CP-001"]);
    expect(firstBlock.items).not.toContain(undefined);

    // The block id reverses to a KNOWN finding id — i.e. a worker result keyed by
    // this block id would resolve, not land in `unresolved`.
    const recovered = fromBlockId(firstBlock.block_id);
    expect(recovered).toBe("CP-001");
    expect(findingIds.has(recovered!)).toBe(true);

    // The second node's dependency edge resolves to the first node's block id
    // (the dependency was authored against the CP-001 fallback).
    const secondBlock = plan.blocks.find((b) => b.block_id === toBlockId("N-second"))!;
    expect(secondBlock.dependencies).toContain(toBlockId("CP-001"));
    expect(secondBlock.dependencies.every((d) => !d.includes("undefined"))).toBe(true);
  });
});
