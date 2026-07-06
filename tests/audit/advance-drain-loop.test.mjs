import { test, expect } from "vitest";
import { writeFixtureRepo } from "./helpers/fixture.mjs";

const { advanceAudit } = await import("../../src/audit/orchestrator/advance.ts");
const { decideNextStep } = await import("../../src/audit/orchestrator/nextStep.ts");
const { isHostDelegationExecutor } = await import(
  "../../src/audit/orchestrator/executors.ts"
);
const {
  computeStaleArtifacts,
  emitStalenessRecord,
} = await import("../../src/audit/orchestrator/staleness.ts");
const { withTempDir } = await import("./helpers/withTempDir.mjs");

// Skip-all analyzer policy keeps graph enrichment hermetic under a real root
// (advanceAudit drains graph_enrichment with the root intake/planning require).
const SKIP_ANALYZERS = {
  typescript: "skip",
  python: "skip",
  html: "skip",
  css: "skip",
  sql: "skip",
};

/** Capture everything written to process.stderr while `fn` runs. */
async function captureStderr(fn) {
  const original = process.stderr.write.bind(process.stderr);
  const chunks = [];
  process.stderr.write = (chunk, ...rest) => {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
    // Swallow — do not forward to the real stderr (keeps test output clean) and
    // still return true so callers see a successful write.
    if (typeof rest[rest.length - 1] === "function") rest[rest.length - 1]();
    return true;
  };
  try {
    await fn();
  } finally {
    process.stderr.write = original;
  }
  return chunks.join("");
}

test("advanceAudit drains the consecutive deterministic regen frontier within one call, stopping at the first host-delegation boundary", async () => {
  await withTempDir("advance-drain-", async (root) => {
    await writeFixtureRepo(root);
    const options = { root, analyzers: SKIP_ANALYZERS };

    // First call starts at provider_confirmation (host-delegation, auto-completes
    // headlessly) and then drains the WHOLE deterministic run — intake, auto-fix,
    // syntax, external-analyzer acquisition, structure, graph enrichment, design
    // assessment, structure decomposition — in ONE call, halting at the
    // intent_checkpoint host-delegation boundary.
    const first = await advanceAudit({}, options);

    // The drain wrote many more artifacts than a single deterministic step would.
    expect(
      first.artifacts_written.includes("repo_manifest.json"),
      "intake artifact must be present (drain ran intake)",
    ).toBeTruthy();
    expect(
      first.artifacts_written.includes("graph_bundle.json"),
      "structure artifact must be present (drain ran structure)",
    ).toBeTruthy();
    expect(
      first.artifacts_written.includes("structure_decomposition.json"),
      "structure_decomposition must be present (drain ran the full deterministic frontier)",
    ).toBeTruthy();

    // The drain stopped exactly at the next host-delegation boundary: the step it
    // hands back to the host is intent_checkpoint (a host-delegation executor).
    const next = decideNextStep(first.updated_bundle);
    expect(next.selected_obligation).toBe("intent_checkpoint_current");
    expect(isHostDelegationExecutor(next.selected_executor)).toBe(true);
  });
});

test("a forced preferredExecutor runs EXACTLY one step (no drain)", async () => {
  await withTempDir("advance-drain-forced-", async (root) => {
    await writeFixtureRepo(root);
    const options = { root, analyzers: SKIP_ANALYZERS };

    // Reach a state with a deterministic frontier ahead: provider gate first.
    const provider = await advanceAudit({}, {
      ...options,
      preferredExecutor: "provider_confirmation_executor",
    });
    // Forced provider step ran exactly one step and did NOT drain into intake.
    expect(provider.selected_obligation).toBe(
      "forced:provider_confirmation_executor",
    );
    const afterProvider = decideNextStep(provider.updated_bundle);
    // The very next actionable obligation is still intake's repo_manifest —
    // proving the forced call did not drain past its single step.
    expect(afterProvider.selected_obligation).toBe("repo_manifest");
    expect(provider.updated_bundle.repo_manifest).toBe(undefined);
  });
});

test("computeStaleArtifacts is pure when emit:false and emitStalenessRecord writes exactly one record", async () => {
  // Pure mode: a schema-migration-degraded manifest yields a non-empty stale set
  // but writes NOTHING to stderr.
  const migrationBundle = {
    repo_manifest: { repository: { name: "x" }, generated_at: "t", files: [] },
    artifact_metadata: { artifacts: {} }, // no metadata_schema_version → migration path
  };
  const pureOutput = await captureStderr(async () => {
    const stale = computeStaleArtifacts(migrationBundle, { emit: false });
    expect(stale.size > 0, "migration path should mark present artifacts stale").toBeTruthy();
  });
  expect(pureOutput, "emit:false must not write to stderr").toBe("");

  // emitStalenessRecord writes exactly one JSONL staleness record for a stale set.
  const emitOutput = await captureStderr(async () => {
    emitStalenessRecord(new Set(["a.json", "b.json"]), "unit_test_reason");
  });
  const lines = emitOutput.trim().split("\n").filter(Boolean);
  expect(lines.length, "exactly one staleness record").toBe(1);
  const record = JSON.parse(lines[0]);
  expect(record.kind).toBe("staleness");
  expect(record.reason).toBe("unit_test_reason");
  expect(record.stale_artifacts).toEqual(["a.json", "b.json"]);

  // An empty stale set writes nothing.
  const emptyOutput = await captureStderr(async () => {
    emitStalenessRecord(new Set());
  });
  expect(emptyOutput).toBe("");
});

test("a full drain emits at most ONE staleness stderr record for the whole round-trip", async () => {
  await withTempDir("advance-drain-staleness-", async (root) => {
    await writeFixtureRepo(root);
    const options = { root, analyzers: SKIP_ANALYZERS };

    // The first call drains the whole deterministic intake→structure frontier.
    // Every intermediate re-derivation runs emit-off; only the boundary emits.
    const output = await captureStderr(async () => {
      await advanceAudit({}, options);
    });
    const stalenessRecords = output
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter((record) => record && record.kind === "staleness");
    // A fresh build has no staleness, so zero records here; the invariant is that
    // the drain never emits MORE than one — never one-per-drained-step.
    expect(
      stalenessRecords.length <= 1,
      `drain must emit at most one staleness record, got ${stalenessRecords.length}`,
    ).toBeTruthy();
  });
});
