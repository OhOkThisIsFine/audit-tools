/**
 * Named and custom conceptual-review perspective selection — the `perspectives`
 * dial of `intent_checkpoint.design_review`.
 *
 * Ported from the never-landed candidate (0227ddae: conceptual-review-selection +
 * packet-4-conceptual-review), adapted to main's design: custom perspectives are
 * inline `{name, lens}` entries INSIDE the perspective list (there is no separate
 * `custom_perspectives` field), one `selectPerspectives` reads the whole list, and
 * the refusals (unknown names, duplicates, collisions, shallow+list) are schema
 * parse errors raised by `ConceptualPerspectiveSelectionSchema` and the
 * `design_review` block's own refinement — never a second resolver's messages.
 *
 * The candidate's inverted cases this file deliberately flips for main:
 *   - a shallow depth PLUS an explicit list is REFUSED by the schema (the
 *     candidate asserted the list was retained under a shallow depth);
 *   - a ceiling-only UNBOUND `design_review` block HOLDS the `confirm_intent`
 *     checkpoint open (the candidate asserted it stayed satisfied) — every
 *     present block must name the confirmation that answered it.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IntentCheckpointSchema } from "../../src/shared/index.js";
import type { IntentCheckpoint } from "audit-tools/shared";
import type { ArtifactBundle } from "../../src/audit/io/artifacts.js";
import type { ObligationState } from "../../src/audit/types/auditState.js";
import { deriveAuditState } from "../../src/audit/orchestrator/state.js";
import { decideNextStep } from "../../src/audit/orchestrator/nextStep.js";
import {
  CONCEPTUAL_PERSPECTIVES,
  selectPerspectives,
} from "../../src/audit/orchestrator/designReviewPrompt.js";
import {
  prepareConceptualDispatch,
  resolveConceptualReviewSettings,
} from "../../src/audit/cli/conceptualDispatch.js";

const AT = "2026-09-19T00:00:00Z";
const STALE_AT = "2026-01-01T00:00:00Z";

/** A checkpoint as a host would write it, with one `design_review` varied. */
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

/**
 * A bundle whose every obligation up to `intent_checkpoint_current` is
 * satisfied, so the checkpoint obligation's state is the only variable.
 */
function bundleWithCheckpoint(
  designReview: Record<string, unknown> | undefined,
  at: string = AT,
): ArtifactBundle {
  return {
    repo_manifest: {
      repository: { name: "fixture" },
      generated_at: "2026-01-01T00:00:00.000Z",
      files: [{ path: "src/a.ts", language: "typescript", size_bytes: 100 }],
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
      conceptual_reviewed: false,
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

/** A minimal bundle whose checkpoint block is BOUND to its own confirmation. */
function boundBundle(designReview: Record<string, unknown>): ArtifactBundle {
  return {
    intent_checkpoint: checkpoint({ answered_at: AT, ...designReview }, AT),
  } as never;
}

function obligationState(
  bundle: ArtifactBundle,
  id: string,
): ObligationState | undefined {
  return deriveAuditState(bundle).obligations.find((o) => o.id === id)?.state;
}

// ── The checkpoint schema: what a written `design_review` block may say ──────

describe("the design_review perspective selection schema", () => {
  it("accepts the legacy integer count", () => {
    const parsed = IntentCheckpointSchema.parse(
      checkpoint({
        answered_at: AT,
        conceptual_depth: "deep",
        perspectives: 5,
      }),
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

  it("accepts custom {name, lens} definitions inline in the list", () => {
    // Main has no separate `custom_perspectives` field: a custom reviewer is an
    // inline object entry in the same list, read by the same single selection.
    const custom = {
      name: "Domain specialist",
      lens: "Does this fit the domain's own rules?",
    };
    const parsed = IntentCheckpointSchema.parse(
      checkpoint({
        answered_at: AT,
        conceptual_depth: "deep",
        perspectives: ["Adversary", custom],
      }),
    );
    expect(parsed.design_review?.perspectives).toEqual(["Adversary", custom]);
  });

  it("refuses a shallow depth combined with an explicit list", () => {
    // Inverted from the candidate, which asserted an explicit shallow depth
    // "wins while retaining the list": main refuses that combination outright.
    const result = IntentCheckpointSchema.safeParse(
      checkpoint({
        answered_at: AT,
        conceptual_depth: "shallow",
        perspectives: ["Adversary"],
      }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.map((issue) => issue.message),
      ).toContain(
        "An explicit perspective list requires deep review; choose deep or omit the list.",
      );
    }
  });

  it("refuses empty entries, empty lists, and the retired custom_perspectives field", () => {
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
    // The candidate's separate `custom_perspectives` field would be a second
    // reader of the selection; the strict block refuses the key entirely.
    expect(
      IntentCheckpointSchema.safeParse(
        checkpoint({
          answered_at: AT,
          conceptual_depth: "deep",
          perspectives: ["Adversary"],
          custom_perspectives: [],
        }),
      ).success,
    ).toBe(false);
  });
});

// ── selectPerspectives: the one production reader of a selection ─────────────

describe("selectPerspectives", () => {
  it("an explicit list selects EXACTLY those perspectives, in order, with no injected defaults", () => {
    // Neither required name ("Mathematician seeking elegance", "Minimalist")
    // is listed — the count-path reservation must not second-guess an
    // explicit roster.
    const resolved = selectPerspectives(["Adversary", "Novelty-seeker"]);
    expect(resolved.map((p) => p.name)).toEqual(["Adversary", "Novelty-seeker"]);
    expect(resolved.map((p) => p.lens)).toEqual(
      ["Adversary", "Novelty-seeker"].map(
        (name) =>
          CONCEPTUAL_PERSPECTIVES.find((p) => p.name === name)!.lens,
      ),
    );
  });

  it("a single-name list stays a single reviewer", () => {
    expect(selectPerspectives(["Minimalist"]).map((p) => p.name)).toEqual([
      "Minimalist",
    ]);
  });

  it("an inline custom entry resolves with its own lens", () => {
    expect(
      selectPerspectives([
        {
          name: "Domain specialist",
          lens: "Does this fit the domain's own rules?",
        },
      ]),
    ).toEqual([
      {
        name: "Domain specialist",
        lens: "Does this fit the domain's own rules?",
      },
    ]);
  });

  it("a mixed built-in and custom list resolves in listed order", () => {
    const adversary = CONCEPTUAL_PERSPECTIVES.find(
      (p) => p.name === "Adversary",
    )!;
    expect(
      selectPerspectives([
        { name: "Specialist", lens: "custom lens" },
        "Adversary",
      ]),
    ).toEqual([{ name: "Specialist", lens: "custom lens" }, adversary]);
  });

  it("an unknown name is refused by the selection schema, naming the entry", () => {
    // Main has no resolver that throws its own message: the refusal is the
    // schema parse error from ConceptualPerspectiveSelectionSchema.
    expect(() => selectPerspectives(["Adversary", "Time traveler"])).toThrow(
      /Use an exact built-in perspective name or a custom \{name, lens\} definition/,
    );
  });

  it("a duplicate entry is refused by the selection schema", () => {
    expect(() => selectPerspectives(["Adversary", "Adversary"])).toThrow(
      /Perspective names must be unique/,
    );
  });

  it("a custom name colliding with a built-in is refused by the selection schema", () => {
    expect(() =>
      selectPerspectives([
        { name: "Adversary", lens: "a different adversarial take" },
      ]),
    ).toThrow(/Custom perspective names must not collide with built-in names/);
  });
});

// ── Confirmation-time resolution of the recorded dials ───────────────────────

describe("resolveConceptualReviewSettings with an explicit selection", () => {
  it("an absent block retains the defaults", () => {
    const settings = resolveConceptualReviewSettings({
      intent_checkpoint: checkpoint(undefined),
    } as never);
    expect(settings.conceptual_depth).toBe("shallow");
    expect(settings.perspectives).toBeUndefined();
    expect(settings.reuse_notice).toBeUndefined();
    expect(settings.ignored_review_notice).toBeUndefined();
  });

  it("a bound named list without a depth chooses deep and is honored exactly", () => {
    const settings = resolveConceptualReviewSettings(
      boundBundle({ perspectives: ["Minimalist", "Adversary"] }),
    );
    expect(settings.conceptual_depth).toBe("deep");
    expect(settings.perspectives).toEqual(["Minimalist", "Adversary"]);
    expect(settings.reuse_notice).toContain("conceptual depth deep");
  });

  it("a legacy count without a depth keeps the shallow default", () => {
    const settings = resolveConceptualReviewSettings(
      boundBundle({ perspectives: 3 }),
    );
    expect(settings.conceptual_depth).toBe("shallow");
    expect(settings.perspectives).toBe(3);
  });

  it("a bound custom selection is carried with its definition", () => {
    const settings = resolveConceptualReviewSettings(
      boundBundle({
        perspectives: [{ name: "Specialist", lens: "custom lens" }],
      }),
    );
    expect(settings.conceptual_depth).toBe("deep");
    expect(settings.perspectives).toEqual([
      { name: "Specialist", lens: "custom lens" },
    ]);
  });

  it("an unbound named block falls back to the default AND says so", () => {
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
});

// ── An unbound block re-fires the confirm_intent checkpoint ─────────────────

describe("deriveAuditState re-fires confirm_intent for an unbound design_review block", () => {
  it("a missing answered_at with choice dials re-fires confirm_intent", () => {
    const bundle = bundleWithCheckpoint({
      conceptual_depth: "deep",
      perspectives: 4,
    });
    expect(obligationState(bundle, "intent_checkpoint_current")).toBe("missing");
    const decision = decideNextStep(bundle);
    expect(decision.selected_obligation).toBe("intent_checkpoint_current");
    expect(decision.selected_executor).toBe("intent_checkpoint_executor");
  });

  it("a stale answered_at with choice dials re-fires confirm_intent, naming the earlier confirmation", () => {
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
    expect(obligation?.reason ?? "").toMatch(/Confirm design-review choices again/);
    expect(obligation?.reason ?? "").toMatch(/belongs to an earlier confirmation/);
    expect(decideNextStep(bundle).selected_obligation).toBe(
      "intent_checkpoint_current",
    );
  });

  it("a ceiling-only unbound block holds the confirm_intent checkpoint open", () => {
    // Inverted from the candidate, which asserted a ceiling-only unbound block
    // does NOT hold the checkpoint open: on main EVERY present block must name
    // the confirmation that answered it, whatever dials it carries.
    const bundle = bundleWithCheckpoint({ ceiling: { rung: "deep" } });
    expect(obligationState(bundle, "intent_checkpoint_current")).toBe("missing");
    const obligation = deriveAuditState(bundle).obligations.find(
      (o) => o.id === "intent_checkpoint_current",
    );
    expect(obligation?.reason ?? "").toMatch(/Confirm design-review choices again/);
    expect(decideNextStep(bundle).selected_obligation).toBe(
      "intent_checkpoint_current",
    );
  });

  it("an absent block stays satisfied", () => {
    expect(
      obligationState(bundleWithCheckpoint(undefined), "intent_checkpoint_current"),
    ).toBe("satisfied");
  });

  it("a block answered by this confirmation stays satisfied", () => {
    expect(
      obligationState(
        bundleWithCheckpoint(
          {
            answered_at: AT,
            conceptual_depth: "deep",
            perspectives: ["Adversary", "Minimalist"],
          },
          AT,
        ),
        "intent_checkpoint_current",
      ),
    ).toBe("satisfied");
  });
});

// ── The named selection reaches the dispatched lanes ─────────────────────────

describe("prepareConceptualDispatch with an explicit selection", () => {
  const cleanups: string[] = [];
  afterEach(async () => {
    while (cleanups.length > 0) {
      await rm(cleanups.pop()!, { recursive: true, force: true });
    }
  });

  async function artifactsDir(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "conceptual-selection-"));
    cleanups.push(root);
    const dir = join(root, ".audit-tools", "audit");
    await mkdir(dir, { recursive: true });
    return dir;
  }

  it("a named selection dispatches exactly the named deep-review lanes and re-emits identical paths on resume", async () => {
    const dir = await artifactsDir();
    const bundle = {} as ArtifactBundle;
    const settings = resolveConceptualReviewSettings(
      boundBundle({ perspectives: ["Minimalist", "Adversary"] }),
    );

    const first = await prepareConceptualDispatch({
      artifactsDir: dir,
      bundle,
      settings,
    });
    expect(first.deep).toBe(true);
    const manifest = JSON.parse(
      await readFile(first.artifactPaths.conceptual_round_manifest, "utf8"),
    );
    expect(
      manifest.perspectives.map((p: { perspective: string }) => p.perspective),
    ).toEqual(["Minimalist", "Adversary"]);
    expect(
      Object.keys(first.artifactPaths).filter(
        (key) =>
          key.startsWith("conceptual_perspective_") && key.endsWith("_prompt"),
      ),
      "exactly the two named reviewers — no injected defaults",
    ).toHaveLength(2);

    const resumed = await prepareConceptualDispatch({
      artifactsDir: dir,
      bundle,
      settings,
    });
    expect(resumed.artifactPaths).toEqual(first.artifactPaths);
    expect(resumed.writePaths).toEqual(first.writePaths);
    expect(resumed.readPaths).toEqual(first.readPaths);
  });

  it("a custom selection dispatches its own lens and re-emits identical paths on resume", async () => {
    const dir = await artifactsDir();
    const bundle = {} as ArtifactBundle;
    const settings = resolveConceptualReviewSettings(
      boundBundle({
        perspectives: [
          {
            name: "Domain specialist",
            lens: "Does this fit the domain's own rules?",
          },
        ],
      }),
    );

    const first = await prepareConceptualDispatch({
      artifactsDir: dir,
      bundle,
      settings,
    });
    expect(first.deep).toBe(true);
    const manifest = JSON.parse(
      await readFile(first.artifactPaths.conceptual_round_manifest, "utf8"),
    );
    expect(
      manifest.perspectives.map((p: { perspective: string }) => p.perspective),
    ).toEqual(["Domain specialist"]);
    expect(
      await readFile(first.artifactPaths.conceptual_perspective_1_prompt, "utf8"),
      "the custom lens must reach the dispatched perspective prompt",
    ).toContain("Does this fit the domain's own rules?");

    const resumed = await prepareConceptualDispatch({
      artifactsDir: dir,
      bundle,
      settings,
    });
    expect(resumed.artifactPaths).toEqual(first.artifactPaths);
  });
});
