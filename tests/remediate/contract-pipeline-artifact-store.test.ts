import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  writeContractArtifact,
  readContractArtifact,
  detectStaleArtifacts,
  contractArtifactExists,
  contractPipelineDir,
  contractArtifactFilePath,
  DEPENDENCY_MAP,
} from "../../src/remediate/contractPipeline/artifactStore.js";
import {
  CONTRACT_PIPELINE_GOAL_SPEC_VERSION,
  CONTRACT_PIPELINE_CONTEXT_BUNDLE_VERSION,
} from "audit-tools/shared";
import {
  CP_MODULE_DECOMPOSITION_VERSION,
  CP_FINALIZED_MODULE_CONTRACTS_VERSION,
} from "../../src/remediate/validation/contractPipeline.js";
import { scratchDir } from "../helpers/scratch.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DIR = scratchDir(".test-cp-artifact-store");
const ARTIFACTS_DIR = join(TEST_DIR, ".audit-tools", "remediation");

function makeGoalSpec(goalId = "GOAL-001") {
  return {
    contract_version: CONTRACT_PIPELINE_GOAL_SPEC_VERSION,
    goal_id: goalId,
    objective: "Improve test coverage.",
    non_goals: [],
    success_criteria: ["All tests pass."],
    source_type: "conversation" as const,
    created_at: new Date().toISOString(),
  };
}

function makeContextBundle(goalId = "GOAL-001") {
  return {
    contract_version: CONTRACT_PIPELINE_CONTEXT_BUNDLE_VERSION,
    goal_id: goalId,
    entries: [],
    context_summary: "Minimal context.",
    created_at: new Date().toISOString(),
  };
}

function makeModuleDecomposition(goalId = "GOAL-001") {
  return {
    contract_version: CP_MODULE_DECOMPOSITION_VERSION,
    goal_id: goalId,
    modules: [{ name: "mod-a", responsibilities: "Does A.", file_scope: ["src/a.ts"] }],
    created_at: new Date().toISOString(),
  };
}

function makeFinalizedModuleContracts(goalId = "GOAL-001") {
  return {
    contract_version: CP_FINALIZED_MODULE_CONTRACTS_VERSION,
    goal_id: goalId,
    module_contracts: [{
      name: "mod-a",
      inputs: ["x"],
      outputs: ["y"],
      invariants: [],
      side_effects: [],
      validation_boundary: "validates x",
      failure_modes: [],
      seam_adjustments: [],
    }],
    created_at: new Date().toISOString(),
  };
}

/**
 * Capture the structured `level: "warn"` stderr lines the store emits.
 *
 * The warning's whole point is that it is OBSERVABLE — it goes to stderr as one
 * JSON object per line, the same shape as the repository's other structured
 * warnings, so a log reader that already parses those needs no new case. A spy
 * that captured anything else would be testing a mechanism nothing consumes, so
 * this reads the real stream and parses it as the consumer would.
 */
function captureStructuredWarnings(): { events: Array<Record<string, unknown>>; restore: () => void } {
  const events: Array<Record<string, unknown>> = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
    for (const line of String(chunk).split("\n")) {
      if (line.trim().length === 0) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (parsed !== null && typeof parsed === "object") {
          events.push(parsed as Record<string, unknown>);
        }
      } catch {
        // A non-JSON write is some other library's stderr chatter, not this
        // module's event; ignoring it keeps the assertion about THIS event.
      }
    }
    return (original as (...args: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stderr.write;
  return { events, restore: () => { process.stderr.write = original; } };
}

let warnings: { events: Array<Record<string, unknown>>; restore: () => void };

/** The content-hash-mismatch events captured in the current test, in order. */
function hashMismatchEvents(): Array<Record<string, unknown>> {
  return warnings.events.filter(
    (event) => event.event === "contract_artifact_content_hash_mismatch",
  );
}

beforeEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
  await mkdir(ARTIFACTS_DIR, { recursive: true });
  warnings = captureStructuredWarnings();
});

afterEach(async () => {
  warnings.restore();
  await rm(TEST_DIR, { recursive: true, force: true });
});

describe("contract pipeline artifact store", () => {
  it("writes a GoalSpec artifact and creates the expected JSON file", async () => {
    const payload = makeGoalSpec();
    const envelope = await writeContractArtifact(ARTIFACTS_DIR, "goal_spec", payload);

    expect(envelope.artifact_name).toBe("goal_spec");
    expect(typeof envelope.content_hash).toBe("string");
    expect(envelope.content_hash.length).toBeGreaterThan(0);
    expect(contractArtifactExists(ARTIFACTS_DIR, "goal_spec")).toBe(true);
  });

  it("reads the artifact back and returns the original payload", async () => {
    const payload = makeGoalSpec("READ-TEST");
    await writeContractArtifact(ARTIFACTS_DIR, "goal_spec", payload);

    const read = await readContractArtifact(ARTIFACTS_DIR, "goal_spec");
    expect(read).not.toBeNull();
    expect(read!.artifact_name).toBe("goal_spec");
    expect(read!.payload).toMatchObject(payload);
  });

  it("rewriting the same payload keeps the computed content hash stable", async () => {
    const payload = makeGoalSpec();
    const first = await writeContractArtifact(ARTIFACTS_DIR, "goal_spec", payload);
    const second = await writeContractArtifact(ARTIFACTS_DIR, "goal_spec", payload);
    expect(first.content_hash).toBe(second.content_hash);
  });

  it("stores the file under the contract-pipeline subdirectory", async () => {
    await writeContractArtifact(ARTIFACTS_DIR, "goal_spec", makeGoalSpec());
    const cpDir = contractPipelineDir(ARTIFACTS_DIR);
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(cpDir, "goal_spec.json"))).toBe(true);
  });
});

describe("contract pipeline staleness", () => {
  it("no artifacts are reported stale when all are freshly written", async () => {
    // Write a minimal chain: goal_spec → context_bundle → module_decomposition
    await writeContractArtifact(ARTIFACTS_DIR, "goal_spec", makeGoalSpec());
    await writeContractArtifact(ARTIFACTS_DIR, "context_bundle", makeContextBundle());
    await writeContractArtifact(ARTIFACTS_DIR, "module_decomposition", makeModuleDecomposition());

    const result = await detectStaleArtifacts(ARTIFACTS_DIR);
    expect(result.stale).not.toContain("goal_spec");
    expect(result.stale).not.toContain("context_bundle");
    expect(result.stale).not.toContain("module_decomposition");
  });

  it("changing GoalSpec causes every downstream artifact to be reported stale", async () => {
    // Write chain.
    await writeContractArtifact(ARTIFACTS_DIR, "goal_spec", makeGoalSpec("OLD"));
    await writeContractArtifact(ARTIFACTS_DIR, "context_bundle", makeContextBundle("OLD"));
    await writeContractArtifact(ARTIFACTS_DIR, "module_decomposition", makeModuleDecomposition("OLD"));

    // Now rewrite goal_spec with different content.
    await writeContractArtifact(ARTIFACTS_DIR, "goal_spec", makeGoalSpec("NEW"));

    const result = await detectStaleArtifacts(ARTIFACTS_DIR);
    // goal_spec itself is fresh (we just wrote it).
    expect(result.stale).not.toContain("goal_spec");
    // context_bundle and module_decomposition have goal_spec in their dependency hashes, but
    // those hashes were recorded from the OLD goal_spec.
    expect(result.stale).toContain("context_bundle");
    expect(result.stale).toContain("module_decomposition");
  });

  it("changing ContextBundle causes module_decomposition stale without marking GoalSpec stale", async () => {
    await writeContractArtifact(ARTIFACTS_DIR, "goal_spec", makeGoalSpec());
    await writeContractArtifact(ARTIFACTS_DIR, "context_bundle", makeContextBundle("OLD"));
    await writeContractArtifact(ARTIFACTS_DIR, "module_decomposition", makeModuleDecomposition());

    // Rewrite context_bundle.
    await writeContractArtifact(ARTIFACTS_DIR, "context_bundle", { ...makeContextBundle(), context_summary: "Updated." });

    const result = await detectStaleArtifacts(ARTIFACTS_DIR);
    expect(result.stale).not.toContain("goal_spec");
    expect(result.stale).not.toContain("context_bundle");
    expect(result.stale).toContain("module_decomposition");
  });

  it("an IN-PLACE load-bearing payload edit (header untouched) re-stales downstream and reconverges on re-read", async () => {
    await writeContractArtifact(ARTIFACTS_DIR, "goal_spec", makeGoalSpec());
    await writeContractArtifact(ARTIFACTS_DIR, "context_bundle", makeContextBundle());
    await writeContractArtifact(ARTIFACTS_DIR, "module_decomposition", makeModuleDecomposition());

    // Edit goal_spec's payload directly on disk WITHOUT touching the stored
    // header — semantic_hash is no longer recorded, and the recompute-on-read
    // path must still detect the change. (Previously a cached header hash would
    // have hidden this edit.)
    const goalPath = contractArtifactFilePath(ARTIFACTS_DIR, "goal_spec");
    const stored = JSON.parse(await readFile(goalPath, "utf8"));
    stored.payload.objective = "A different, load-bearing objective.";
    await writeFile(goalPath, JSON.stringify(stored), "utf8");

    const result = await detectStaleArtifacts(ARTIFACTS_DIR);
    // goal_spec's own dependency_hashes are empty (no deps) so it is not stale,
    // but downstreams recorded the OLD recomputed hash and must now be stale.
    expect(result.stale).toContain("context_bundle");
    expect(result.stale).toContain("module_decomposition");

    // Reconverge: rewrite the downstreams against the edited goal_spec.
    await writeContractArtifact(ARTIFACTS_DIR, "context_bundle", makeContextBundle());
    await writeContractArtifact(ARTIFACTS_DIR, "module_decomposition", makeModuleDecomposition());
    const after = await detectStaleArtifacts(ARTIFACTS_DIR);
    expect(after.stale).not.toContain("context_bundle");
    expect(after.stale).not.toContain("module_decomposition");
  });

  it("an IN-PLACE COSMETIC payload edit (same semantic projection) does NOT stale downstream", async () => {
    await writeContractArtifact(ARTIFACTS_DIR, "goal_spec", makeGoalSpec());
    await writeContractArtifact(ARTIFACTS_DIR, "context_bundle", makeContextBundle());
    await writeContractArtifact(ARTIFACTS_DIR, "module_decomposition", makeModuleDecomposition());

    // Edit only a cosmetic field (created_at) — semantic projection strips it,
    // so the recomputed hash is unchanged and downstreams stay fresh.
    const goalPath = contractArtifactFilePath(ARTIFACTS_DIR, "goal_spec");
    const stored = JSON.parse(await readFile(goalPath, "utf8"));
    stored.payload.created_at = new Date(Date.now() + 100000).toISOString();
    await writeFile(goalPath, JSON.stringify(stored), "utf8");

    const result = await detectStaleArtifacts(ARTIFACTS_DIR);
    expect(result.stale).not.toContain("context_bundle");
    expect(result.stale).not.toContain("module_decomposition");
  });

  it("reports absent artifacts correctly when they have never been written", async () => {
    // Write only goal_spec.
    await writeContractArtifact(ARTIFACTS_DIR, "goal_spec", makeGoalSpec());

    const result = await detectStaleArtifacts(ARTIFACTS_DIR);
    expect(result.absent).toContain("context_bundle");
    expect(result.absent).toContain("module_decomposition");
    expect(result.absent).not.toContain("goal_spec");
  });

  it("missing dependency causes downstream to be reported stale", async () => {
    // Write goal_spec and finalized_module_contracts but NOT context_bundle or module_decomposition.
    await writeContractArtifact(ARTIFACTS_DIR, "goal_spec", makeGoalSpec());
    await writeContractArtifact(ARTIFACTS_DIR, "finalized_module_contracts", makeFinalizedModuleContracts());

    const result = await detectStaleArtifacts(ARTIFACTS_DIR);
    // finalized_module_contracts depends on module_contracts (→ module_decomposition → context_bundle) which are absent.
    expect(result.stale).toContain("finalized_module_contracts");
  });

  it("absent artifacts are reported as absent rather than crashing", async () => {
    // Nothing written at all — should not throw and should report all as absent.
    const result = await detectStaleArtifacts(ARTIFACTS_DIR);
    expect(Array.isArray(result.absent)).toBe(true);
    expect(result.absent).toContain("goal_spec");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// A read is PARSED and BOUND, never cast.
//
// `readContractArtifact` used to be `readOptionalJsonFile<Envelope>(path)` — a
// generic type parameter, which is an assertion the compiler erases. Anything
// JSON that happened to sit at `<name>.json` came back typed as an envelope.
// The three checks below are all one property: the file at `<name>.json` must
// BE the artifact `<name>`. `artifact_name` is a key into DEPENDENCY_MAP and
// `semanticProjection`, and `content_hash` is the identity the judge/critique
// repair ledger keys on, so neither can be taken on the header's word.
// ───────────────────────────────────────────────────────────────────────────

describe("the contract artifact read is parsed and identity-bound", () => {
  it("returns null for a file that is not an envelope at all", async () => {
    await mkdir(contractPipelineDir(ARTIFACTS_DIR), { recursive: true });
    await writeFile(
      contractArtifactFilePath(ARTIFACTS_DIR, "goal_spec"),
      JSON.stringify({ hello: "not an envelope" }),
      "utf8",
    );

    expect(
      await readContractArtifact(ARTIFACTS_DIR, "goal_spec"),
      "a JSON document at the right path is not the artifact the caller asked for",
    ).toBeNull();
  });

  it("returns null when artifact_name does not match the name requested", async () => {
    // Written under goal_spec's path but naming itself context_bundle — what a
    // hand copy or a rename that missed the header leaves behind. The name is a
    // KEY into DEPENDENCY_MAP and semanticProjection, so reading it as
    // goal_spec would consult another artifact's projection table.
    const envelope = await writeContractArtifact(
      ARTIFACTS_DIR,
      "context_bundle",
      makeContextBundle(),
    );
    await mkdir(contractPipelineDir(ARTIFACTS_DIR), { recursive: true });
    await writeFile(
      contractArtifactFilePath(ARTIFACTS_DIR, "goal_spec"),
      JSON.stringify(envelope),
      "utf8",
    );

    expect(await readContractArtifact(ARTIFACTS_DIR, "goal_spec")).toBeNull();
    // ...and the same bytes at their OWN path are still perfectly readable, so
    // the refusal is the binding and not a general strictness about envelopes.
    expect(await readContractArtifact(ARTIFACTS_DIR, "context_bundle")).not.toBeNull();
  });

  it("returns null when an artifact_name outside the fifteen is stored", async () => {
    await mkdir(contractPipelineDir(ARTIFACTS_DIR), { recursive: true });
    await writeFile(
      contractArtifactFilePath(ARTIFACTS_DIR, "goal_spec"),
      JSON.stringify({
        artifact_name: "a_misspelled_artifact",
        content_hash: "deadbeef",
        dependency_hashes: {},
        payload: makeGoalSpec(),
      }),
      "utf8",
    );

    expect(await readContractArtifact(ARTIFACTS_DIR, "goal_spec")).toBeNull();
  });

  it("recomputes content_hash rather than reading the header's stale value", async () => {
    const written = await writeContractArtifact(ARTIFACTS_DIR, "goal_spec", makeGoalSpec());
    const path = contractArtifactFilePath(ARTIFACTS_DIR, "goal_spec");
    const stored = JSON.parse(await readFile(path, "utf8"));
    // Edit the payload, leave the header's hash alone — the header now claims
    // an identity the bytes do not have.
    stored.payload.objective = "Tampered.";
    await writeFile(path, JSON.stringify(stored), "utf8");

    const read = await readContractArtifact(ARTIFACTS_DIR, "goal_spec");

    expect(read).not.toBeNull();
    expect(
      read!.content_hash,
      "content_hash is identity (judge_hash / critique_hash in repairState.ts): a header that no longer describes its payload must not keep speaking",
    ).not.toBe(written.content_hash);
    // ...and the value it now reports is the one the WRITER would compute for
    // these bytes, established by round-tripping the edited payload through
    // `writeContractArtifact` rather than by repeating the hash expression here.
    // Repeating it would let the reader's definition and the writer's drift
    // while both still agreed with the test.
    const rewritten = await writeContractArtifact(ARTIFACTS_DIR, "goal_spec", read!.payload);
    expect(read!.content_hash).toBe(rewritten.content_hash);
    // The payload itself is authoritative and is returned as edited — the
    // consumer reads the bytes that are there, not a header's account of them.
    expect((read!.payload as { objective: string }).objective).toBe("Tampered.");
  });

  it("does not report a tamper when only the payload's KEY ORDER differs", async () => {
    // A content_hash must depend on the payload's content and nothing else, and
    // raw `JSON.stringify` makes it depend on key insertion order too. This
    // writer hashes through `stableStringify` (INV-CK-2, "exactly ONE such
    // serializer"), so a payload whose keys were serialized in another order —
    // which every JSON round trip is entitled to do — recomputes equal instead
    // of reading as an edited artifact and re-staling the DAG.
    const payload = makeGoalSpec();
    const written = await writeContractArtifact(ARTIFACTS_DIR, "goal_spec", payload);
    const path = contractArtifactFilePath(ARTIFACTS_DIR, "goal_spec");
    const stored = JSON.parse(await readFile(path, "utf8"));
    stored.payload = Object.fromEntries(
      Object.entries(stored.payload as Record<string, unknown>).reverse(),
    );
    await writeFile(path, JSON.stringify(stored), "utf8");

    const read = await readContractArtifact(ARTIFACTS_DIR, "goal_spec");

    expect(
      read!.content_hash,
      "a reordered payload is the same payload",
    ).toBe(written.content_hash);
  });

  it("WARNS on a mismatching content_hash, naming the artifact and both hashes", async () => {
    // The correction is right; the SILENCE was the defect. A stored header that
    // disagrees with its payload means the envelope was edited in place, copied,
    // or written under an older hash definition — and the recorded value is the
    // identity the judge/critique repair ledger keys on (`judge_hash` /
    // `critique_hash`), so "already repaired for this report" would answer about
    // the wrong report. Rewriting the header in memory fixes the read and hides
    // the fact; the warning is what keeps it observable.
    const written = await writeContractArtifact(ARTIFACTS_DIR, "goal_spec", makeGoalSpec());
    const path = contractArtifactFilePath(ARTIFACTS_DIR, "goal_spec");
    const stored = JSON.parse(await readFile(path, "utf8"));
    stored.payload.objective = "Tampered.";
    await writeFile(path, JSON.stringify(stored), "utf8");

    const read = await readContractArtifact(ARTIFACTS_DIR, "goal_spec");
    const events = hashMismatchEvents();

    expect(events.length, "a corrected header must leave a trace").toBe(1);
    expect(events[0]).toMatchObject({
      level: "warn",
      event: "contract_artifact_content_hash_mismatch",
      artifact_name: "goal_spec",
      stored_content_hash: written.content_hash,
      recomputed_content_hash: read!.content_hash,
    });
  });

  it("does NOT warn when the header agrees with its payload", async () => {
    // The other half, and the one that keeps the warning worth reading: a warn
    // that fires on the healthy path trains its reader to skip it, which is how
    // a gate dies. Every ordinary write-then-read must be silent.
    await writeContractArtifact(ARTIFACTS_DIR, "goal_spec", makeGoalSpec());
    await readContractArtifact(ARTIFACTS_DIR, "goal_spec");

    expect(
      hashMismatchEvents(),
      "the healthy round trip is silent — a warning here would be noise, not a signal",
    ).toEqual([]);
  });

  it("does not PERSIST the corrected header — the file keeps what it was written with", async () => {
    // Stated because the doc comment claims it. The payload is authoritative for
    // the READ; the stored bytes are left alone, so a mismatch stays re-reportable
    // instead of being laundered into agreement by the first reader.
    const written = await writeContractArtifact(ARTIFACTS_DIR, "goal_spec", makeGoalSpec());
    const path = contractArtifactFilePath(ARTIFACTS_DIR, "goal_spec");
    const stored = JSON.parse(await readFile(path, "utf8"));
    stored.payload.objective = "Tampered.";
    await writeFile(path, JSON.stringify(stored), "utf8");

    await readContractArtifact(ARTIFACTS_DIR, "goal_spec");

    const onDisk = JSON.parse(await readFile(path, "utf8"));
    expect(
      onDisk.content_hash,
      "the correction is in memory only — the header must not be rewritten under the caller's feet",
    ).toBe(written.content_hash);
  });

  it("returns the envelope when every check passes, and staleness still converges", async () => {
    // The guard must not refuse the healthy path: a freshly written envelope
    // reads back, and the DAG built from those reads is unchanged.
    const written = await writeContractArtifact(ARTIFACTS_DIR, "goal_spec", makeGoalSpec());
    await writeContractArtifact(ARTIFACTS_DIR, "context_bundle", makeContextBundle());

    const read = await readContractArtifact(ARTIFACTS_DIR, "goal_spec");
    expect(read).not.toBeNull();
    expect(read!.content_hash).toBe(written.content_hash);

    const result = await detectStaleArtifacts(ARTIFACTS_DIR);
    expect(result.stale).not.toContain("context_bundle");
    expect(result.absent).not.toContain("goal_spec");
  });
});

describe("artifact store dependency map — test_validator_plan", () => {
  it("DEPENDENCY_MAP test_validator_plan contains goal_spec and obligation_ledger", () => {
    expect(DEPENDENCY_MAP["test_validator_plan"]).toContain("goal_spec");
    expect(DEPENDENCY_MAP["test_validator_plan"]).toContain("obligation_ledger");
  });

  it("DEPENDENCY_MAP contract_assessment_report contains test_validator_plan", () => {
    expect(DEPENDENCY_MAP["contract_assessment_report"]).toContain("test_validator_plan");
  });

  it("DEPENDENCY_MAP counterexample contains test_validator_plan", () => {
    expect(DEPENDENCY_MAP["counterexample"]).toContain("test_validator_plan");
  });

  it("DEPENDENCY_MAP judge_report contains test_validator_plan", () => {
    expect(DEPENDENCY_MAP["judge_report"]).toContain("test_validator_plan");
  });

  it("DEPENDENCY_MAP implementation_dag contains test_validator_plan", () => {
    expect(DEPENDENCY_MAP["implementation_dag"]).toContain("test_validator_plan");
  });
});
