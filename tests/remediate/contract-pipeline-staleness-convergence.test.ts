/**
 * Convergence + staleness-correctness guard for the SINGLE content-hash
 * dependency-DAG staleness implementation (ARC-5c944fbb).
 *
 * Context: the content-hash staleness logic for the contract pipeline used to
 * exist twice — the hash-based `DEPENDENCY_MAP` + `detectStaleArtifacts` DAG in
 * `artifactStore.ts`, AND an ad-hoc linear phase-slice re-run authority
 * (`repairDownstreamPhases` / `CONTRACT_PHASE_SEQUENCE` in
 * `validation/contractPipelineGates.ts`). The two drifted, which is the latent
 * finalization-oscillation risk. The linear slice was deleted (commit 2229f736,
 * determinism S4 dogfood) so there is now ONE implementation. These tests lock
 * that property in:
 *
 *  1. Single source — only `artifactStore.ts` may define `detectStaleArtifacts`
 *     / `DEPENDENCY_MAP` / `StalenessResult`; no second copy may be reintroduced.
 *  2. Convergence — repeatedly running the finalize loop (detect stale → re-emit
 *     each stale artifact with current upstream hashes → re-detect) reaches a
 *     stable fixed point with NO oscillation, regardless of which artifact is
 *     touched.
 *  3. Staleness correctness — downstream is stale iff an upstream content hash
 *     changed; a missing dependency hash is treated as stale (safe); a hash
 *     mismatch recomputes downstream exactly once (one iteration clears it), it
 *     never loops forever.
 *
 * The finalize loop modelled here mirrors the production loop in
 * `buildNextContractPipelineStep` (`steps/contractPipeline.ts`): on each pass it
 * calls `detectStaleArtifacts`, archives every reported-stale artifact, then the
 * producing phase re-emits it. Archiving + re-emitting with the current upstream
 * content is observationally identical to re-writing the artifact via
 * `writeContractArtifact` (which re-captures upstream dependency hashes at write
 * time), so the loop here re-writes stale artifacts to reproduce that behaviour
 * on the public artifact-store surface.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  writeContractArtifact,
  readContractArtifact,
  detectStaleArtifacts,
  DEPENDENCY_MAP,
  CP_ARTIFACT_NAMES,
  type ContractPipelineArtifactName,
} from "../../src/remediate/contractPipeline/artifactStore.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function makeArtifactsDir(root: string): string {
  return join(root, ".audit-tools", "remediation");
}

const AT = "2026-06-15T00:00:00.000Z";

/**
 * A minimal-but-valid-enough payload for every artifact name. The staleness DAG
 * is schema-agnostic (it hashes whatever payload it is given and walks
 * DEPENDENCY_MAP), so these payloads only need a stable goal_id + a mutable
 * field to perturb. Each carries an explicit `nonce` we bump to change content.
 */
function makePayload(name: ContractPipelineArtifactName, nonce = 0): Record<string, unknown> {
  return { goal_id: "g", artifact: name, nonce, created_at: AT };
}

/**
 * Write every artifact in topological order so each captures fresh upstream
 * hashes — a fully-consistent starting state with nothing stale.
 */
async function seedFullChain(artifactsDir: string): Promise<void> {
  for (const name of CP_ARTIFACT_NAMES) {
    await writeContractArtifact(artifactsDir, name, makePayload(name));
  }
}

/**
 * One pass of the production finalize loop: detect stale, then re-emit each
 * stale artifact with the current upstream hashes (mirrors archive + producing
 * phase re-emit). Returns the staleness set observed BEFORE the re-emit so the
 * caller can watch it shrink toward the empty fixed point.
 */
async function finalizePass(artifactsDir: string): Promise<ContractPipelineArtifactName[]> {
  const { stale } = await detectStaleArtifacts(artifactsDir);
  // Re-emit in topological (CP_ARTIFACT_NAMES) order so a re-emitted upstream's
  // new hash is captured by its downstream within the same pass when possible.
  for (const name of CP_ARTIFACT_NAMES) {
    if (!stale.includes(name)) continue;
    const existing = await readContractArtifact(artifactsDir, name);
    const payload = (existing?.payload as Record<string, unknown>) ?? makePayload(name);
    // Re-emit identical payload content; only dependency_hashes get refreshed.
    await writeContractArtifact(artifactsDir, name, payload);
  }
  return stale;
}

/**
 * Drive the finalize loop to a fixed point, capped. Returns the number of passes
 * taken to converge and the per-pass stale-count history. A cap reached without
 * convergence is the oscillation/infinite-loop bug this guards against.
 */
async function runToFixedPoint(
  artifactsDir: string,
  cap = 50,
): Promise<{ passes: number; history: number[]; converged: boolean }> {
  const history: number[] = [];
  for (let i = 0; i < cap; i++) {
    const stale = await finalizePass(artifactsDir);
    history.push(stale.length);
    if (stale.length === 0) {
      return { passes: i + 1, history, converged: true };
    }
  }
  return { passes: cap, history, converged: false };
}

describe("contract-pipeline staleness — single source of truth", () => {
  it("only artifactStore.ts defines detectStaleArtifacts / DEPENDENCY_MAP / StalenessResult", async () => {
    // Guard against re-introducing the deleted ad-hoc linear-slice copy
    // (repairDownstreamPhases / CONTRACT_PHASE_SEQUENCE). The DAG staleness
    // logic must live in exactly one module.
    const srcRoot = join(__dirname, "..", "..", "src", "remediate");
    const { readdir } = await import("node:fs/promises");
    const files: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) await walk(p);
        else if (e.isFile() && p.endsWith(".ts")) files.push(p);
      }
    };
    await walk(srcRoot);

    const definers = { detect: [] as string[], map: [] as string[], result: [] as string[] };
    for (const f of files) {
      const text = await readFile(f, "utf8");
      if (/export\s+async\s+function\s+detectStaleArtifacts\b/.test(text)) definers.detect.push(f);
      if (/export\s+const\s+DEPENDENCY_MAP\b/.test(text)) definers.map.push(f);
      if (/export\s+interface\s+StalenessResult\b/.test(text)) definers.result.push(f);
    }

    expect(definers.detect).toHaveLength(1);
    expect(definers.map).toHaveLength(1);
    expect(definers.result).toHaveLength(1);
    expect(definers.detect[0].replace(/\\/g, "/")).toContain("contractPipeline/artifactStore.ts");
    expect(definers.map[0]).toBe(definers.detect[0]);
    expect(definers.result[0]).toBe(definers.detect[0]);
  });

  it("DEPENDENCY_MAP is acyclic — staleness propagation can always terminate", () => {
    // A cycle in the dependency map would make the transitive-propagation loop
    // and the finalize loop unable to reach a fixed point. Topologically sort to
    // prove acyclicity. (CP_ARTIFACT_NAMES is the declared topo order; verify it
    // actually respects every edge.)
    const index = new Map<ContractPipelineArtifactName, number>(
      CP_ARTIFACT_NAMES.map((n, i) => [n, i]),
    );
    for (const name of CP_ARTIFACT_NAMES) {
      for (const dep of DEPENDENCY_MAP[name]) {
        // Every dependency must appear strictly earlier than its dependent.
        expect(index.get(dep)!).toBeLessThan(index.get(name)!);
      }
    }
  });
});

describe("contract-pipeline staleness — convergence (no oscillation)", () => {
  let tmpDir: string;
  let artifactsDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "cp-stale-conv-"));
    artifactsDir = makeArtifactsDir(tmpDir);
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("a fully-consistent chain reports nothing stale and converges in one pass", async () => {
    await seedFullChain(artifactsDir);
    const before = await detectStaleArtifacts(artifactsDir);
    expect(before.stale).toEqual([]);
    expect(before.absent).toEqual([]);

    const { converged, passes, history } = await runToFixedPoint(artifactsDir);
    expect(converged).toBe(true);
    expect(passes).toBe(1);
    expect(history).toEqual([0]);
  });

  it("touching the root (goal_spec) re-stales the whole DAG, then converges to a stable fixed point", async () => {
    await seedFullChain(artifactsDir);

    // Mutate the root artifact's content → every downstream becomes stale.
    await writeContractArtifact(artifactsDir, "goal_spec", makePayload("goal_spec", 999));

    const { converged, history } = await runToFixedPoint(artifactsDir);
    expect(converged).toBe(true);
    // Monotonic non-increasing then zero — never oscillates back up.
    for (let i = 1; i < history.length; i++) {
      expect(history[i]).toBeLessThanOrEqual(history[i - 1]);
    }
    expect(history[history.length - 1]).toBe(0);

    // Idempotence: a second run from the converged state stays converged in one pass.
    const second = await runToFixedPoint(artifactsDir);
    expect(second.converged).toBe(true);
    expect(second.passes).toBe(1);
  });

  it("converges to a stable fixed point no matter which single artifact is touched", async () => {
    // Exhaustively perturb each artifact and confirm the finalize loop always
    // settles with nothing stale — the core no-oscillation property.
    for (const touched of CP_ARTIFACT_NAMES) {
      await rm(tmpDir, { recursive: true, force: true });
      await seedFullChain(artifactsDir);

      await writeContractArtifact(artifactsDir, touched, makePayload(touched, 42));

      const { converged, history } = await runToFixedPoint(artifactsDir);
      expect(converged, `touching ${touched} must converge`).toBe(true);
      expect(history[history.length - 1], `touching ${touched} ends stable`).toBe(0);
      const final = await detectStaleArtifacts(artifactsDir);
      expect(final.stale, `touching ${touched} leaves nothing stale`).toEqual([]);
    }
  });

  it("repeated finalize over an already-converged chain never reintroduces staleness (10x)", async () => {
    await seedFullChain(artifactsDir);
    for (let i = 0; i < 10; i++) {
      const { stale } = await detectStaleArtifacts(artifactsDir);
      expect(stale, `pass ${i} must stay empty`).toEqual([]);
      // A redundant re-emit of nothing-stale must not perturb the fixed point.
      await finalizePass(artifactsDir);
    }
  });
});

describe("contract-pipeline staleness — correctness", () => {
  let tmpDir: string;
  let artifactsDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "cp-stale-corr-"));
    artifactsDir = makeArtifactsDir(tmpDir);
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("downstream is stale IFF an upstream content hash changed", async () => {
    await seedFullChain(artifactsDir);
    expect((await detectStaleArtifacts(artifactsDir)).stale).toEqual([]);

    // Re-write context_bundle with DIFFERENT content → its direct/transitive
    // downstream go stale; goal_spec (its only upstream) does NOT.
    await writeContractArtifact(artifactsDir, "context_bundle", makePayload("context_bundle", 7));

    const { stale } = await detectStaleArtifacts(artifactsDir);
    expect(stale).not.toContain("goal_spec");
    expect(stale).not.toContain("context_bundle"); // just re-written → fresh
    // Direct dependents of context_bundle:
    expect(stale).toContain("module_decomposition");
    expect(stale).toContain("module_contracts");
    // A node NOT downstream of context_bundle must stay fresh.
    // (conceptual_design_critique depends on goal_spec + finalized_module_contracts;
    //  finalized_module_contracts IS downstream of context_bundle, so it is stale —
    //  assert instead on obligation_ledger's *non*-dependence path via goal_spec only.)
    // Concretely: every artifact whose dependency set transitively includes
    // context_bundle must be stale; goal_spec must not.
    expect(stale).toContain("finalized_module_contracts");
  });

  it("re-writing an artifact with IDENTICAL content does not stale downstream (hash-stable)", async () => {
    await seedFullChain(artifactsDir);
    // Re-emit goal_spec with byte-identical payload — content hash is stable, so
    // recorded downstream dependency hashes still match → nothing stale.
    const existing = await readContractArtifact(artifactsDir, "goal_spec");
    await writeContractArtifact(artifactsDir, "goal_spec", existing!.payload);

    const { stale } = await detectStaleArtifacts(artifactsDir);
    expect(stale).toEqual([]);
  });

  it("a missing dependency hash is treated as stale (safe default)", async () => {
    // Write goal_spec, then write module_decomposition while its intermediate
    // dependency (context_bundle) is ABSENT. The missing dependency must mark the
    // dependent stale rather than silently treating it as fresh.
    await writeContractArtifact(artifactsDir, "goal_spec", makePayload("goal_spec"));
    await writeContractArtifact(artifactsDir, "module_decomposition", makePayload("module_decomposition"));

    const { stale, absent } = await detectStaleArtifacts(artifactsDir);
    expect(absent).toContain("context_bundle"); // never written
    expect(stale).toContain("module_decomposition"); // depends on the absent context_bundle
    expect(stale).not.toContain("goal_spec");
  });

  it("a hash mismatch recomputes downstream EXACTLY ONCE — one pass clears it, no infinite loop", async () => {
    await seedFullChain(artifactsDir);

    // Introduce a hash mismatch: rewrite finalized_module_contracts content.
    await writeContractArtifact(
      artifactsDir,
      "finalized_module_contracts",
      makePayload("finalized_module_contracts", 123),
    );

    // Before any re-emit: downstream of finalized_module_contracts is stale.
    const before = await detectStaleArtifacts(artifactsDir);
    expect(before.stale.length).toBeGreaterThan(0);
    expect(before.stale).toContain("obligation_ledger");

    // Exactly ONE finalize pass must clear all staleness (recompute once).
    await finalizePass(artifactsDir);
    const after = await detectStaleArtifacts(artifactsDir);
    expect(after.stale).toEqual([]);

    // And a further pass is a no-op (it did not bounce back to stale).
    const staleSecondPass = await finalizePass(artifactsDir);
    expect(staleSecondPass).toEqual([]);
  });

  it("absent artifacts are reported absent (never written) and do not crash", async () => {
    const { stale, absent } = await detectStaleArtifacts(artifactsDir);
    expect(Array.isArray(stale)).toBe(true);
    expect(absent).toContain("goal_spec");
    // An absent root must not itself be classified stale (absent ≠ stale).
    expect(stale).not.toContain("goal_spec");
  });
});
