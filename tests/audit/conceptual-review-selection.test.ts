/**
 * Packet 4 — "Honor conceptual-review choices exactly" (O04, O05).
 *
 * Production-path coverage for the packet acceptance criteria:
 * missing/stale provenance re-fires confirmation, absent settings keep
 * defaults, legacy counts still work, explicit named lists select exactly
 * those perspectives with no injected defaults, custom {name, lens}
 * definitions resolve, unknown names / duplicates / custom-name collisions
 * are refused, and explicit selections survive shallow defaults and resumed
 * runs.
 */
import { describe, expect, it, afterEach } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IntentCheckpointSchema } from "audit-tools/shared";
import type { IntentCheckpoint } from "audit-tools/shared";
import type { ArtifactBundle } from "../../src/audit/io/artifacts.js";
import { deriveAuditState } from "../../src/audit/orchestrator/state.js";
import { decideNextStep } from "../../src/audit/orchestrator/nextStep.js";
import {
  CONCEPTUAL_PERSPECTIVES,
  DEFAULT_CONCEPTUAL_PERSPECTIVES,
  resolvePerspectiveSet,
  selectPerspectives,
} from "../../src/audit/orchestrator/designReviewPrompt.js";
import {
  prepareConceptualDispatch,
  resolveConceptualReviewSettings,
} from "../../src/audit/cli/conceptualDispatch.js";

const AT = "2026-09-19T00:00:00Z";
const STALE_AT = "2026-01-01T00:00:00Z";

function checkpoint(
  designReview: Record<string, unknown> | undefined,
  at: string = AT,
): IntentCheckpoint {
  return {
    schema_version: "intent-checkpoint/v1",
    confirmed_at: at,
    confirmed_by: "host",
    scope_summary: "src only",
    intent_summary: "full-audit",
    ...(designReview === undefined ? {} : { design_review: designReview }),
  } as IntentCheckpoint;
}

function bundleWithCheckpoint(
  designReview: Record<string, unknown> | undefined,
  at: string = AT,
): ArtifactBundle {
  return {
    repo_manifest: {
      repository: { name: "fixture" },
      generated_at: "2026-01-01T00:00:00.000Z",
      files: [{ path: "src/a.ts", language: "typescript", size_bytes: 1 }],
    },
    file_disposition: { files: [{ path: "src/a.ts", status: "included" }] },
    auto_fixes_applied: {},
    syntax_resolution_status: {},
    external_analyzer_acquisition: { enabled: false, tool_statuses: [] },
    unit_manifest: { units: [] },
    surface_manifest: { surfaces: [] },
    graph_bundle: { graphs: {} },
    critical_flows: { flows: [] },
    risk_register: { items: [] },
    analyzer_capability: { coverage: "not_applicable", analyzers: [] },
    design_assessment: {
      generated_at: "2026-01-01T00:00:00.000Z",
      findings: [],
      contract_reviewed: false,
    },
    docs_digest: { generated_at: "2026-01-01T00:00:00.000Z", docs: [] },
    structure_decomposition: {
      generated_at: "2026-01-01T00:00:00.000Z",
      target: "structure",
      node_universe_size: 0,
      source_ids: [],
      consensus: [],
      contested: [],
      findings: [],
    },
    intent_checkpoint: checkpoint(designReview, at),
  };
}

function obligationState(bundle: ArtifactBundle, id: string): string | undefined {
  return deriveAuditState(bundle).obligations.find((o) => o.id === id)?.state;
}

// ── Schema: shape acceptance ────────────────────────────────────────────────

describe("IntentCheckpointSchema design_review perspective selection", () => {
  it("accepts the legacy integer count", () => {
    const parsed = IntentCheckpointSchema.parse(
      checkpoint({ answered_at: AT, conceptual_depth: "deep", perspectives: 5 }),
    );
    expect(parsed.design_review?.perspectives).toBe(5);
  });

  it("accepts an explicit list of built-in names", () => {
    const parsed = IntentCheckpointSchema.parse(
      checkpoint({
        answered_at: AT,
        conceptual_depth: "deep",
        perspectives: ["Adversary", "Minimalist"],
      }),
    );
    expect(parsed.design_review?.perspectives).toEqual([
      "Adversary",
      "Minimalist",
    ]);
  });

  it("accepts custom definitions referenced by the list", () => {
    const parsed = IntentCheckpointSchema.parse(
      checkpoint({
        answered_at: AT,
        conceptual_depth: "deep",
        perspectives: ["Adversary", "Domain specialist"],
        custom_perspectives: [
          { name: "Domain specialist", lens: "Does this fit the domain's own rules?" },
        ],
      }),
    );
    expect(parsed.design_review?.custom_perspectives).toEqual([
      { name: "Domain specialist", lens: "Does this fit the domain's own rules?" },
    ]);
  });

  it("rejects duplicate names in an explicit list", () => {
    const result = IntentCheckpointSchema.safeParse(
      checkpoint({
        answered_at: AT,
        conceptual_depth: "deep",
        perspectives: ["Adversary", "Adversary"],
      }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects duplicate custom names", () => {
    const result = IntentCheckpointSchema.safeParse(
      checkpoint({
        answered_at: AT,
        conceptual_depth: "deep",
        perspectives: ["Adversary", "Specialist"],
        custom_perspectives: [
          { name: "Specialist", lens: "first" },
          { name: "Specialist", lens: "second" },
        ],
      }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects empty names and empty lists", () => {
    expect(
      IntentCheckpointSchema.safeParse(
        checkpoint({
          answered_at: AT,
          conceptual_depth: "deep",
          perspectives: ["Adversary", ""],
        }),
      ).success,
    ).toBe(false);
    expect(
      IntentCheckpointSchema.safeParse(
        checkpoint({
          answered_at: AT,
          conceptual_depth: "deep",
          perspectives: [],
        }),
      ).success,
    ).toBe(false);
    expect(
      IntentCheckpointSchema.safeParse(
        checkpoint({
          answered_at: AT,
          conceptual_depth: "deep",
          custom_perspectives: [],
        }),
      ).success,
    ).toBe(false);
  });
});

// ── Resolver: the one production reader ─────────────────────────────────────

describe("resolvePerspectiveSet", () => {
  it("legacy count draws exactly as selectPerspectives", () => {
    expect(resolvePerspectiveSet(3)).toEqual(selectPerspectives(3));
    expect(resolvePerspectiveSet(undefined)).toEqual(selectPerspectives());
    expect(resolvePerspectiveSet(undefined)).toHaveLength(
      DEFAULT_CONCEPTUAL_PERSPECTIVES,
    );
  });

  it("an explicit list selects EXACTLY those perspectives, in order, with no injected defaults", () => {
    // Neither required name ("Mathematician seeking elegance", "Minimalist")
    // is listed — the reservation must NOT second-guess the operator.
    const resolved = resolvePerspectiveSet(["Adversary", "Novelty-seeker"]);
    expect(resolved.map((p) => p.name)).toEqual([
      "Adversary",
      "Novelty-seeker",
    ]);
  });

  it("a single-name list stays a single reviewer", () => {
    const resolved = resolvePerspectiveSet(["Minimalist"]);
    expect(resolved.map((p) => p.name)).toEqual(["Minimalist"]);
  });

  it("custom definitions resolve with their own lens", () => {
    const resolved = resolvePerspectiveSet(["Domain specialist"], [
      { name: "Domain specialist", lens: "Does this fit the domain's own rules?" },
    ]);
    expect(resolved).toEqual([
      { name: "Domain specialist", lens: "Does this fit the domain's own rules?" },
    ]);
  });

  it("mixed built-in and custom lists resolve in listed order", () => {
    const adversary = CONCEPTUAL_PERSPECTIVES.find((p) => p.name === "Adversary")!;
    const resolved = resolvePerspectiveSet(["Specialist", "Adversary"], [
      { name: "Specialist", lens: "custom lens" },
    ]);
    expect(resolved).toEqual([{ name: "Specialist", lens: "custom lens" }, adversary]);
  });

  it("unknown names throw naming the value", () => {
    expect(() => resolvePerspectiveSet(["Adversary", "Time traveler"])).toThrow(
      /"Time traveler"/,
    );
  });

  it("duplicates throw", () => {
    expect(() => resolvePerspectiveSet(["Adversary", "Adversary"])).toThrow(
      /duplicate/i,
    );
  });

  it("a custom name colliding with a built-in name throws", () => {
    expect(() =>
      resolvePerspectiveSet(["Adversary"], [
        { name: "Adversary", lens: "a different adversarial take" },
      ]),
    ).toThrow(/collides with a built-in/i);
  });

  it("duplicate custom names throw", () => {
    expect(() =>
      resolvePerspectiveSet(["A", "Adversary"], [
        { name: "A", lens: "first" },
        { name: "A", lens: "second" },
      ]),
    ).toThrow(/duplicate/i);
  });

  it("an empty explicit list throws", () => {
    expect(() => resolvePerspectiveSet([])).toThrow(/at least one/i);
  });

  it("a list naming an undefined custom throws as unknown", () => {
    expect(() => resolvePerspectiveSet(["Specialist"])).toThrow(/unknown/i);
  });
});

// ── Settings: confirmation-time resolution ──────────────────────────────────

describe("resolveConceptualReviewSettings with explicit selection", () => {
  function boundBundle(designReview: Record<string, unknown>): ArtifactBundle {
    return {
      intent_checkpoint: checkpoint({ answered_at: AT, ...designReview }, AT),
    } as never;
  }

  it("absent block retains defaults", () => {
    const settings = resolveConceptualReviewSettings({
      intent_checkpoint: checkpoint(undefined),
    } as never);
    expect(settings.conceptual_depth).toBe("shallow");
    expect(settings.perspectives).toBeUndefined();
    expect(settings.custom_perspectives).toBeUndefined();
    expect(settings.reuse_notice).toBeUndefined();
    expect(settings.ignored_review_notice).toBeUndefined();
  });

  it("a bound named list is honored exactly", () => {
    const settings = resolveConceptualReviewSettings(
      boundBundle({
        conceptual_depth: "deep",
        perspectives: ["Adversary", "Novelty-seeker"],
      }),
    );
    expect(settings.conceptual_depth).toBe("deep");
    expect(settings.perspectives).toEqual(["Adversary", "Novelty-seeker"]);
  });

  it("a bound custom selection is carried with its definitions", () => {
    const settings = resolveConceptualReviewSettings(
      boundBundle({
        conceptual_depth: "deep",
        perspectives: ["Specialist"],
        custom_perspectives: [{ name: "Specialist", lens: "custom lens" }],
      }),
    );
    expect(settings.perspectives).toEqual(["Specialist"]);
    expect(settings.custom_perspectives).toEqual([
      { name: "Specialist", lens: "custom lens" },
    ]);
  });

  it("a legacy count still resolves", () => {
    const settings = resolveConceptualReviewSettings(
      boundBundle({ conceptual_depth: "deep", perspectives: 3 }),
    );
    expect(settings.conceptual_depth).toBe("deep");
    expect(settings.perspectives).toBe(3);
  });

  it("an explicit selection survives the shallow default", () => {
    // The operator named reviewers but left the depth shallow (or omitted it):
    // the selection must be retained, not dropped into the default.
    const settings = resolveConceptualReviewSettings(
      boundBundle({
        conceptual_depth: "shallow",
        perspectives: ["Adversary", "Minimalist"],
      }),
    );
    expect(settings.conceptual_depth).toBe("shallow");
    expect(settings.perspectives).toEqual(["Adversary", "Minimalist"]);
  });

  it("an unbound named block falls back safely AND says so", () => {
    const settings = resolveConceptualReviewSettings({
      intent_checkpoint: checkpoint(
        {
          answered_at: STALE_AT,
          conceptual_depth: "deep",
          perspectives: ["Adversary", "Minimalist"],
        },
        AT,
      ),
    } as never);
    expect(settings.conceptual_depth).toBe("shallow");
    expect(settings.perspectives).toBeUndefined();
    expect(settings.ignored_review_notice).toContain("was ignored");
  });

  it("an invalid bound selection throws at confirmation time, even when shallow", () => {
    expect(() =>
      resolveConceptualReviewSettings(
        boundBundle({
          conceptual_depth: "shallow",
          perspectives: ["Time traveler"],
        }),
      ),
    ).toThrow(/unknown perspective/);
  });

  it("a re-confirmation with fresh provenance honors the choice", () => {
    const fresh = "2026-09-20T00:00:00Z";
    const settings = resolveConceptualReviewSettings({
      intent_checkpoint: checkpoint(
        {
          answered_at: fresh,
          conceptual_depth: "deep",
          perspectives: ["Adversary", "Minimalist"],
        },
        fresh,
      ),
    } as never);
    expect(settings.conceptual_depth).toBe("deep");
    expect(settings.perspectives).toEqual(["Adversary", "Minimalist"]);
    expect(settings.ignored_review_notice).toBeUndefined();
  });
});

// ── State: unbound choice blocks return to confirmation ─────────────────────

describe("intent_checkpoint_current with design_review provenance", () => {
  it("missing answered_at with choice dials re-fires confirm_intent", () => {
    const bundle = bundleWithCheckpoint({
      conceptual_depth: "deep",
      perspectives: 4,
    });
    expect(obligationState(bundle, "intent_checkpoint_current")).toBe("missing");
    const decision = decideNextStep(bundle);
    expect(decision.selected_obligation).toBe("intent_checkpoint_current");
  });

  it("mismatched answered_at with choice dials re-fires confirm_intent", () => {
    const bundle = bundleWithCheckpoint(
      {
        answered_at: STALE_AT,
        conceptual_depth: "deep",
        perspectives: ["Adversary", "Minimalist"],
      },
      AT,
    );
    const obligation = deriveAuditState(bundle).obligations.find(
      (o) => o.id === "intent_checkpoint_current",
    );
    expect(obligation?.state).toBe("missing");
    expect(obligation?.reason ?? "").toMatch(/confirm_intent/);
    expect(decideNextStep(bundle).selected_obligation).toBe(
      "intent_checkpoint_current",
    );
  });

  it("a ceiling-only unbound block does NOT hold the checkpoint open", () => {
    const bundle = bundleWithCheckpoint({ ceiling: { rung: "deep" } });
    expect(obligationState(bundle, "intent_checkpoint_current")).toBe(
      "satisfied",
    );
  });

  it("an absent block stays satisfied", () => {
    expect(
      obligationState(bundleWithCheckpoint(undefined), "intent_checkpoint_current"),
    ).toBe("satisfied");
  });

  it("a bound block stays satisfied", () => {
    const bundle = bundleWithCheckpoint(
      {
        answered_at: AT,
        conceptual_depth: "deep",
        perspectives: ["Adversary", "Minimalist"],
      },
      AT,
    );
    expect(obligationState(bundle, "intent_checkpoint_current")).toBe(
      "satisfied",
    );
  });
});

// ── Resumed runs retain the confirmed choice ────────────────────────────────

describe("explicit selection survives resumed runs", () => {
  const cleanups: string[] = [];
  afterEach(async () => {
    while (cleanups.length > 0) {
      await rm(cleanups.pop()!, { recursive: true, force: true });
    }
  });

  async function artifactsDir(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "packet-4-resume-"));
    cleanups.push(root);
    const dir = join(root, ".audit-tools", "audit");
    await mkdir(dir, { recursive: true });
    return dir;
  }

  it("the same named settings re-emit identical bound paths", async () => {
    const dir = await artifactsDir();
    const bundle = {} as ArtifactBundle;
    const settings = {
      conceptual_depth: "deep" as const,
      perspectives: ["Adversary", "Minimalist"],
    };
    const first = await prepareConceptualDispatch({
      artifactsDir: dir,
      bundle,
      settings: { ...settings },
    });
    const second = await prepareConceptualDispatch({
      artifactsDir: dir,
      bundle,
      settings: { ...settings },
    });
    expect(second.deep).toBe(true);
    expect(second.artifactPaths).toEqual(first.artifactPaths);
    expect(second.writePaths).toEqual(first.writePaths);
    // Exactly the two named reviewers — no injected defaults.
    const promptKeys = Object.keys(second.artifactPaths).filter((k) =>
      k.startsWith("conceptual_perspective_"),
    );
    expect(promptKeys.filter((k) => k.endsWith("_prompt"))).toHaveLength(2);
  });

  it("a custom selection dispatches its own lens and stays stable", async () => {
    const dir = await artifactsDir();
    const bundle = {} as ArtifactBundle;
    const settings = {
      conceptual_depth: "deep" as const,
      perspectives: ["Specialist"],
      custom_perspectives: [
        { name: "Specialist", lens: "Does this fit the domain's own rules?" },
      ],
    };
    const first = await prepareConceptualDispatch({
      artifactsDir: dir,
      bundle,
      settings: { ...settings },
    });
    expect(first.deep).toBe(true);
    const second = await prepareConceptualDispatch({
      artifactsDir: dir,
      bundle,
      settings: { ...settings },
    });
    expect(second.artifactPaths).toEqual(first.artifactPaths);
  });

  it("confirmation-time resolution is deterministic across reads", () => {
    const fresh = "2026-09-20T00:00:00Z";
    const bundle = {
      intent_checkpoint: checkpoint(
        {
          answered_at: fresh,
          conceptual_depth: "deep",
          perspectives: ["Adversary", "Minimalist"],
        },
        fresh,
      ),
    } as never;
    expect(resolveConceptualReviewSettings(bundle)).toEqual(
      resolveConceptualReviewSettings(bundle),
    );
  });
});
