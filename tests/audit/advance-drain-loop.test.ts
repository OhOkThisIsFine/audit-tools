import { test, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFixtureRepo } from "./helpers/fixture.mjs";
import type { AnalyzerSetting } from "audit-tools/shared";
import type { ArtifactBundle } from "../../src/audit/io/artifacts.js";
import { EMPTY_REGISTER_BODY } from "../helpers/charterRegisterFixture.js";
import { CHARTER_REGISTER_SCHEMA_VERSION } from "../../src/audit/types/charterRegister.js";
import { computeArtifactMetadata } from "../../src/audit/orchestrator/artifactMetadata.js";
import { runIntentEquivalenceResolve } from "../../src/audit/orchestrator/intentEquivalenceExecutor.js";
import { LATE_INPUT_EDGES } from "../../src/audit/orchestrator/dependencyMap.js";

// A late-input deferral (dependencyMap.ts) is held until its upstream, which
// the drain schedules after the downstream, re-derives — by design, so the
// within-one-drain guarantee below is about the EARLY slice deferrals.
const earlyDeferred = (deferred: ReadonlySet<string>): string[] =>
  [...deferred].filter((name) => !(name in LATE_INPUT_EDGES));

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const {
  advanceAudit,
  engineMaxTransitions,
  ExecutorFailure,
  findExecutorFailure,
  findPriorityOrderingViolations,
  MAX_DRAIN_STEPS,
} = await import("../../src/audit/orchestrator/advance.js");
const { deriveObligationState } = await import(
  "../../src/audit/orchestrator/obligationDerive.js"
);
const { decideNextStep, PRIORITY } = await import("../../src/audit/orchestrator/nextStep.js");
const { EXECUTOR_RUNNERS } = await import(
  "../../src/audit/orchestrator/executorRunners.js"
);
const { isHostDelegationExecutor } = await import(
  "../../src/audit/orchestrator/executors.js"
);
const {
  computeStaleArtifacts,
  emitStalenessRecord,
} = await import("../../src/audit/orchestrator/staleness.js");
const { withTempDir } = await import("./helpers/withTempDir.mjs");

// Skip-all analyzer policy keeps graph enrichment hermetic under a real root
// (advanceAudit drains graph_enrichment with the root intake/planning require).
const SKIP_ANALYZERS: Record<string, AnalyzerSetting> = {
  typescript: "skip",
  python: "skip",
  html: "skip",
  css: "skip",
  sql: "skip",
};

/** Capture everything written to process.stderr while `fn` runs. */
async function captureStderr(fn: () => Promise<void>): Promise<string> {
  const original = process.stderr.write.bind(process.stderr);
  const chunks: string[] = [];
  process.stderr.write = (chunk, ...rest) => {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
    // Swallow — do not forward to the real stderr (keeps test output clean) and
    // still return true so callers see a successful write.
    const maybeCb = rest[rest.length - 1];
    if (typeof maybeCb === "function") maybeCb();
    return true;
  };
  try {
    await fn();
  } finally {
    process.stderr.write = original;
  }
  return chunks.join("");
}

test("advanceAudit drains the consecutive deterministic regen frontier by default within one call, stopping at the first host-delegation boundary", async () => {
  await withTempDir("advance-drain-", async (root) => {
    await writeFixtureRepo(root);
    // The drain is the DEFAULT now (no opt-in flag); a bare call drains.
    const options = { root, analyzers: SKIP_ANALYZERS };

    // First call starts at intake and then drains the WHOLE deterministic run — intake, auto-fix,
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
    if (next.selected_executor === null) {
      throw new Error("expected a selected_executor");
    }
    expect(isHostDelegationExecutor(next.selected_executor)).toBe(true);
  });
});

test("a forced preferredExecutor runs EXACTLY one step (no drain)", async () => {
  await withTempDir("advance-drain-forced-", async (root) => {
    await writeFixtureRepo(root);
    const options = { root, analyzers: SKIP_ANALYZERS };

    // Force the first deterministic executor.
    const intake = await advanceAudit({}, {
      ...options,
      preferredExecutor: "intake_executor",
    });
    expect(intake.selected_obligation).toBe("forced:intake_executor");
    const afterIntake = decideNextStep(intake.updated_bundle);
    expect(afterIntake.selected_obligation).toBe("auto_fixes_applied");
    expect(intake.updated_bundle.repo_manifest).toBeDefined();
    expect(intake.updated_bundle.auto_fixes_applied).toBe(undefined);
  });
});

test("computeStaleArtifacts is pure when emit:false and emitStalenessRecord writes exactly one record", async () => {
  // Pure mode: a schema-migration-degraded manifest yields a non-empty stale set
  // but writes NOTHING to stderr.
  const migrationBundle: ArtifactBundle = {
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

// ── MAX_DRAIN_STEPS is a HARD dispatch ceiling (COR-03034c94) ─────────────────
//
// The cap used to be checked AFTER the step it was meant to prevent, with `>`
// rather than `>=`, so a call whose frontier never ran dry dispatched 65 steps
// under a bound stated as 64. These tests hold the ceiling at "no more than
// MAX_DRAIN_STEPS steps are DISPATCHED", not "the 65th is noticed afterwards".

/** Swap in a stub runner for the duration of `fn`, then restore the real one. */
async function withStubbedRunner<T>(
  executor: string,
  stub: (typeof EXECUTOR_RUNNERS)[string],
  fn: () => Promise<T>,
): Promise<T> {
  const original = EXECUTOR_RUNNERS[executor];
  EXECUTOR_RUNNERS[executor] = stub;
  try {
    return await fn();
  } finally {
    EXECUTOR_RUNNERS[executor] = original!;
  }
}

test("one advanceAudit call dispatches AT MOST MAX_DRAIN_STEPS steps, never one more", async () => {
  let dispatches = 0;
  // A runner that never satisfies its own obligation: the frontier stays
  // actionable forever, so the ONLY thing that can stop the fold is the cap.
  const result = await withStubbedRunner(
    "intake_executor",
    async (bundle) => {
      dispatches += 1;
      return {
        updated: { ...bundle },
        artifacts_written: [],
        progress_summary: `stub dispatch ${dispatches}`,
      };
    },
    () => advanceAudit({}, {}),
  );

  expect(
    dispatches,
    `the drain must stop AT the ceiling (${MAX_DRAIN_STEPS}), not one dispatch past it`,
  ).toBe(MAX_DRAIN_STEPS);
  expect(result.progress_made, "the capped drain still made progress").toBe(true);
  // The frontier is deliberately undrained: the host resumes on its next call.
  expect(decideNextStep(result.updated_bundle).selected_obligation).toBe(
    "repo_manifest",
  );
});

test("the engine's throwing backstop is DERIVED from MAX_DRAIN_STEPS, never a literal", async () => {
  expect(engineMaxTransitions()).toBe(MAX_DRAIN_STEPS + 2);
  // Raising the cap re-derives the backstop with no second edit anywhere.
  expect(engineMaxTransitions(10)).toBe(12);
  expect(engineMaxTransitions(1000)).toBe(1002);

  const source = await readFile(
    join(REPO_ROOT, "src/audit/orchestrator/advance.ts"),
    "utf8",
  );
  expect(
    source,
    "the advance() call site must pass the derived bound, not a hand-written number",
  ).toMatch(/maxTransitions: engineMaxTransitions\(\)/);
  expect(
    /maxTransitions: MAX_DRAIN_STEPS \+ \d+/.test(source),
    "a re-inlined literal decouples the graceful cap from the derived backstop",
  ).toBe(false);
  // CP-NODE-7: the derivation itself lives in the shared engine, so this file
  // consumes the invariant rather than restating it. A local headroom constant
  // here would be the second home the single-source obligation bans.
  expect(
    /(?:const|let|var)\s+ENGINE_TRANSITION_HEADROOM\b/.test(source),
    "the headroom belongs to the shared engine, not to this consumer",
  ).toBe(false);
  expect(source).toMatch(/deriveEngineBound/);
});

// ── The zero-dispatch result has ONE construction site (MNT-03034c94) ─────────

test("the no-actionable-obligation result is constructed in exactly ONE place", async () => {
  const source = await readFile(
    join(REPO_ROOT, "src/audit/orchestrator/advance.ts"),
    "utf8",
  );
  const zeroDispatchConstructions = source.match(/next_likely_step: null,/g) ?? [];
  expect(
    zeroDispatchConstructions.length,
    "two hand-maintained copies of the zero-dispatch shape is how a field added to AdvanceAuditResult reaches only one of the paths",
  ).toBe(1);
  expect(source).toMatch(/function noActionableObligationResult\(/);
  // The obligation log event is single-sourced for the same reason.
  const obligationEvents = source.match(/kind: "obligation",/g) ?? [];
  expect(obligationEvents.length).toBe(1);
  expect(source).toMatch(/function logObligationSelection\(/);
});

test("the zero-dispatch path returns the shared shape", async () => {
  const result = await advanceAudit(
    { audit_state: { status: "complete", blockers: [], obligations: [] } },
    {},
  );
  expect(result.progress_made).toBe(false);
  expect(result.artifacts_written).toEqual(["audit_state.json"]);
  expect(result.next_likely_step).toBe(null);
});

// ── The PRIORITY-ordering guarantee the staleness deferral rides on ───────────

test("PRIORITY schedules every slice-projected upstream BEFORE its downstream", () => {
  expect(findPriorityOrderingViolations()).toEqual([]);
});

test("a PRIORITY order that puts a slice-projected downstream first is REPORTED", () => {
  // Move the charter-extraction obligation (which writes the slice-projected
  // downstream charter_register.json) ahead of the structure decomposition that
  // one of its projected upstreams comes from. The deferred staleness decision
  // could then never fire before the downstream is selected.
  const reordered = PRIORITY.filter((id) => id !== "charter_extraction_current");
  reordered.splice(
    reordered.indexOf("structure_decomposition_current"),
    0,
    "charter_extraction_current",
  );

  const violations = findPriorityOrderingViolations(reordered);
  expect(violations.length > 0).toBe(true);
  expect(violations.some((v) => v.downstream === "charter_register.json")).toBe(
    true,
  );
  expect(violations[0]!.reason).toMatch(/at or after the downstream/);
});

test("a declared late-input edge whose upstream is scheduled before its downstream is REPORTED", () => {
  // systemic_challenge.json is a LATE input of audit_tasks.json; moving its pass
  // ahead of planning makes it an ordinary early edge, which must be declared so.
  const reordered = PRIORITY.filter((id) => id !== "systemic_challenge_current");
  reordered.splice(reordered.indexOf("planning_artifacts"), 0, "systemic_challenge_current");
  const violations = findPriorityOrderingViolations(reordered);
  expect(violations.some((v) => v.downstream === "audit_tasks.json" &&
    v.upstream === "systemic_challenge.json" && /late-input/.test(v.reason))).toBe(true);
});

test("a slice participant whose producing obligation is absent from the order is REPORTED, never assumed safe", () => {
  const withoutStructure = PRIORITY.filter(
    (id) => id !== "structure_decomposition_current",
  );
  const violations = findPriorityOrderingViolations(withoutStructure);
  expect(
    violations.some((v) => /absent from the priority order/.test(v.reason)),
    "an unschedulable producer must not read as an ordering that holds",
  ).toBe(true);
});

test("the drain re-derives obligation state at every transition (the memo is per-bundle identity)", () => {
  const cache = new WeakMap<ArtifactBundle, ReturnType<typeof decideNextStep>["state"]>();
  const derive = deriveObligationState("repo_manifest", cache);

  const before: ArtifactBundle = {};
  expect(derive(before)).toBe("missing");
  // Same object → memoized; the answer cannot change without a transition.
  expect(derive(before)).toBe("missing");

  // A transition builds a FRESH bundle object, which is what forces the
  // re-derivation a deferred (slice-guarded) staleness decision depends on.
  const after: ArtifactBundle = {
    ...before,
    repo_manifest: { repository: { name: "x" }, generated_at: "t", files: [] },
  };
  expect(cache.has(after), "a fresh bundle is never served from the memo").toBe(
    false,
  );
  expect(derive(after)).toBe("satisfied");
});

// ── An executor throw carries its own identity out of advanceAudit ────────────

test("an executor throw surfaces as ExecutorFailure naming the ACTUAL failing executor and propagates out", async () => {
  const thrown = new Error("stub executor blew up");
  let caught: unknown;
  await withStubbedRunner(
    "intake_executor",
    async () => {
      throw thrown;
    },
    async () => {
      try {
        await advanceAudit({}, {});
      } catch (error) {
        caught = error;
      }
    },
  );

  expect(caught instanceof ExecutorFailure).toBe(true);
  const failure = findExecutorFailure(caught);
  expect(failure?.executor).toBe("intake_executor");
  expect(failure?.obligation).toBe("repo_manifest");
  expect((failure?.cause as Error | undefined)?.message).toBe(
    "stub executor blew up",
  );
});


// O22: exercise the real drain, not two manually sequenced state derivations.
// Only the structure producer is controlled; metadata refresh, slice comparison,
// downstream charter omission and shared-engine continuation remain production.
test.each([true, false])("a populated deferred slice is resolved within one drain (membership changes: %s)", async (changed) => {
  await withTempDir("advance-deferred-slice-", async (root) => {
    await writeFixtureRepo(root);
    const initial = await advanceAudit({}, { root, analyzers: SKIP_ANALYZERS });
    const member = "src/api/auth.ts";
    const outside = "src/lib/session.ts";
    const prepared: ArtifactBundle = {
      ...initial.updated_bundle,
      structure_decomposition: {
        generated_at: "2026-07-23T00:00:00Z",
        target: "structure",
        node_universe_size: 2,
        source_ids: ["call_import"],
        consensus: [{ node_id: member, members: [member], agreed_across_source: 1,
          stable_across_scale: 1, contested: false }],
        contested: [], findings: [],
      },
      intent_checkpoint: {
        schema_version: "intent-checkpoint/v1", confirmed_at: "2026-07-23T00:00:00Z",
        confirmed_by: "host", scope_summary: "fixture", intent_summary: "fixture",
        design_review: { answered_at: "2026-07-23T00:00:00Z", ceiling: { rung: "shallow" } },
      },
      charter_register: {
        schema_version: CHARTER_REGISTER_SCHEMA_VERSION,
        generated_at: "2026-07-23T00:00:00Z", target: "charter",
        ceiling: { rung: "shallow" }, status: "omitted", ...EMPTY_REGISTER_BODY,
      },
    };
    const baseline = runIntentEquivalenceResolve(prepared).updated;
    const names = [...new Set([
      ...Object.keys(baseline.artifact_metadata!.artifacts),
      "intent_checkpoint.json", "charter_register.json",
    ])];
    baseline.artifact_metadata = computeArtifactMetadata(baseline, baseline.artifact_metadata, names);
    const pending: ArtifactBundle = {
      ...baseline,
      repo_manifest: {
        ...baseline.repo_manifest!,
        files: baseline.repo_manifest!.files.map((file) => file.path === outside
          ? { ...file, hash: "unrelated-content-churn" } : file),
      },
    };
    // All other producers are already current. Structure alone still owes a
    // regeneration; charter's protected membership/content slices haven't moved.
    pending.artifact_metadata = computeArtifactMetadata(pending, baseline.artifact_metadata,
      names.filter((name) => !["structure_decomposition.json", "charter_register.json"].includes(name)));
    const before = computeStaleArtifacts(pending, { emit: false });
    expect(before.has("structure_decomposition.json")).toBe(true);
    expect(before.has("charter_register.json")).toBe(false);
    expect([...before.deferred]).toContain("charter_register.json");
    expect(decideNextStep(pending).selected_obligation).toBe("structure_decomposition_current");

    const executions: string[] = [];
    const realCharter = EXECUTOR_RUNNERS.charter_extraction_executor!;
    const result = await withStubbedRunner("structure_decomposition_executor", async (bundle) => {
      executions.push("structure");
      return {
        updated: { ...bundle, structure_decomposition: {
          ...bundle.structure_decomposition!,
          consensus: [{ ...bundle.structure_decomposition!.consensus[0]!,
            members: changed ? [member, outside] : [member] }],
        } },
        artifacts_written: ["structure_decomposition.json"],
        progress_summary: "Controlled structure regeneration",
      };
    }, () => withStubbedRunner("charter_extraction_executor", async (...args) => {
      executions.push("charter");
      expect(earlyDeferred(computeStaleArtifacts(args[0], { emit: false }).deferred)).toEqual([]);
      return realCharter(...args);
    }, () => advanceAudit(pending, { root, analyzers: SKIP_ANALYZERS })));

    expect(executions).toEqual(changed ? ["structure", "charter"] : ["structure"]);
    expect(result.artifacts_written.includes("charter_register.json")).toBe(changed);
    const after = computeStaleArtifacts(result.updated_bundle, { emit: false });
    expect(after.deferred.size).toBe(0);
    expect(after.has("structure_decomposition.json")).toBe(false);
    expect(after.has("charter_register.json")).toBe(false);
  });
});
