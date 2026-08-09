import { describe, expect, it } from "vitest";

import * as attributionContract from "../../src/shared/types/attributionContract.js";
import {
  AttributionProvenanceSchema,
  AttributionTripleSchema,
  DRAWS,
  DispatchAttemptRowSchema,
  FindingVerdictRowSchema,
  RemediationOutcomeStatusSchema,
  STAGE_OWNERSHIP,
  VERDICT_DETAILS,
  VERDICT_STAGES,
  asOpaqueModelId,
  buildAttemptKey,
  buildResultContentDiscriminator,
  classifyDetail,
  deriveAggregates,
  isLegalDetail,
  type AttributionProvenance,
  type AttributionTriple,
  type DispatchAttemptRow,
  type FindingVerdictRow,
  type OpaqueModelId,
  type ReachPopulation,
  type RowKind,
  type RunLedgerEntry,
  type VerdictPopulation,
} from "audit-tools/shared";

type IsExact<Left, Right> = [Left] extends [Right]
  ? [Right] extends [Left]
    ? true
    : false
  : false;

type ExpectedRunLedgerEntryKeys =
  | "run_id"
  | "provider"
  | "obligation_id"
  | "selected_executor"
  | "status"
  | "started_at"
  | "ended_at"
  | "result_path";

type ExpectedAttemptRowKeys =
  | "row_kind"
  | "attempt_key"
  | "provider"
  | "model"
  | "rank"
  | "lens"
  | "draw"
  | "outcome"
  | "findings_produced";

type ExpectedVerdictRowKeys =
  | "row_kind"
  | "item_id"
  | "stage"
  | "detail"
  | "draw"
  | "lens"
  | "attempt_ref"
  | "provider"
  | "model"
  | "rank"
  | "attribution_provenance";

const runLedgerEntryKeysAreUnchanged: IsExact<
  keyof RunLedgerEntry,
  ExpectedRunLedgerEntryKeys
> = true;
const attributionTripleKeysAreExact: IsExact<
  keyof AttributionTriple,
  "provider" | "model" | "rank"
> = true;
const attemptRowKeysAreExact: IsExact<
  keyof DispatchAttemptRow,
  ExpectedAttemptRowKeys
> = true;
const verdictRowKeysAreExact: IsExact<
  keyof FindingVerdictRow,
  ExpectedVerdictRowKeys
> = true;

const ATTEMPT_OUTCOMES = [
  "completed",
  "ingest_refused",
  "stranded",
  "provider_unavailable",
] as const;

const PRIMARY_MODEL_ID = asOpaqueModelId("provider-owned-model-a");

const baseAttemptInput = {
  row_kind: "attempt",
  attempt_key: "attempt-a",
  provider: "codex",
  model: "provider-owned-model-a",
  rank: "standard",
  lens: "security",
  draw: "audit",
  outcome: "completed",
  findings_produced: 1,
} as const;

const baseVerdictInput = {
  row_kind: "verdict",
  item_id: "finding-a",
  stage: "dedup_or_review",
  detail: "review_confirmed",
  draw: "audit",
  lens: "security",
  attempt_ref: "attempt-a",
  provider: "codex",
  model: "provider-owned-model-a",
  rank: "standard",
  attribution_provenance: "stamped",
} as const;

function attempt(
  overrides: Readonly<Record<string, unknown>> = {},
): DispatchAttemptRow {
  return DispatchAttemptRowSchema.parse({ ...baseAttemptInput, ...overrides });
}

function verdict(
  overrides: Readonly<Record<string, unknown>> = {},
): FindingVerdictRow {
  return FindingVerdictRowSchema.parse({ ...baseVerdictInput, ...overrides });
}

function withoutField(
  value: Readonly<Record<string, unknown>>,
  field: string,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([candidate]) => candidate !== field),
  );
}

function populatedCells(
  index: object,
): string[] {
  const serializedIndex = index as Readonly<
    Record<string, Readonly<Record<string, Readonly<Record<string, unknown>>>>>
  >;
  return Object.entries(serializedIndex)
    .flatMap(([provider, models]) =>
      Object.entries(models).flatMap(([model, lenses]) =>
        Object.keys(lenses).map((lens) => `${provider}/${model}/${lens}`),
      ),
    )
    .sort();
}

describe("dispatch effectiveness attribution contract", () => {
  it("re-exports the sole vocabulary declarations through audit-tools/shared", () => {
    expect(DRAWS).toBe(attributionContract.DRAWS);
    expect(VERDICT_STAGES).toBe(attributionContract.VERDICT_STAGES);
    expect(VERDICT_DETAILS).toBe(attributionContract.VERDICT_DETAILS);
    expect(STAGE_OWNERSHIP).toBe(attributionContract.STAGE_OWNERSHIP);
    expect(AttributionProvenanceSchema).toBe(
      attributionContract.AttributionProvenanceSchema,
    );
    expect(AttributionTripleSchema).toBe(
      attributionContract.AttributionTripleSchema,
    );
    expect(DispatchAttemptRowSchema).toBe(
      attributionContract.DispatchAttemptRowSchema,
    );
    expect(FindingVerdictRowSchema).toBe(
      attributionContract.FindingVerdictRowSchema,
    );
    expect(asOpaqueModelId).toBe(attributionContract.asOpaqueModelId);
    expect(isLegalDetail).toBe(attributionContract.isLegalDetail);
    expect(classifyDetail).toBe(attributionContract.classifyDetail);
    expect(deriveAggregates).toBe(attributionContract.deriveAggregates);
    expect(runLedgerEntryKeysAreUnchanged).toBe(true);
    expect(attributionTripleKeysAreExact).toBe(true);
    expect(attemptRowKeysAreExact).toBe(true);
    expect(verdictRowKeysAreExact).toBe(true);
  });

  it("declares the exact draw, stage, detail, ownership, provenance, and row-kind vocabulary", () => {
    expect(DRAWS).toEqual(["audit", "remediate"]);
    expect(VERDICT_STAGES).toEqual([
      "dedup_or_review",
      "plan_review_gate",
      "terminal_outcome",
      "ingest_refused",
    ]);
    expect(VERDICT_DETAILS).toEqual({
      dedup_or_review: [
        "dedup_survived",
        "dedup_absorbed",
        "review_confirmed",
        "review_refuted",
      ],
      plan_review_gate: ["approved", "declined"],
      terminal_outcome: [
        "resolved",
        "verified_no_change",
        "inappropriate",
        "ignored",
        "blocked",
      ],
      ingest_refused: [
        "schema_invalid",
        "coverage_mismatch",
        "affirmation_missing",
      ],
    });
    expect(
      Object.fromEntries(
        VERDICT_STAGES.map((stage) => [stage, [...STAGE_OWNERSHIP[stage]]]),
      ),
    ).toEqual({
      dedup_or_review: ["audit", "remediate"],
      plan_review_gate: ["remediate"],
      terminal_outcome: ["remediate"],
      ingest_refused: ["audit"],
    });
    expect(AttributionProvenanceSchema.options).toEqual([
      "stamped",
      "legacy_unstamped",
    ]);

    const rowKinds: RowKind[] = ["attempt", "verdict"];
    const provenances: AttributionProvenance[] = [
      "stamped",
      "legacy_unstamped",
    ];
    expect(rowKinds).toEqual(["attempt", "verdict"]);
    expect(provenances).toEqual(["stamped", "legacy_unstamped"]);

    // @ts-expect-error `unknown` is not a row discriminator.
    const invalidRowKind: RowKind = "unknown";
    // @ts-expect-error `unattributed` is an attempt reference, not provenance.
    const invalidProvenance: AttributionProvenance = "unattributed";
    void invalidRowKind;
    void invalidProvenance;
  });

  it("defaults only the attribution triple and lens to unknown", () => {
    expect(AttributionTripleSchema.parse({})).toEqual({
      provider: "unknown",
      model: "unknown",
      rank: "unknown",
    });

    expect(
      DispatchAttemptRowSchema.parse({
        row_kind: "attempt",
        attempt_key: "attempt-minimal",
        draw: "audit",
        outcome: "completed",
        findings_produced: 0,
      }),
    ).toEqual({
      row_kind: "attempt",
      attempt_key: "attempt-minimal",
      provider: "unknown",
      model: "unknown",
      rank: "unknown",
      lens: "unknown",
      draw: "audit",
      outcome: "completed",
      findings_produced: 0,
    });

    expect(
      FindingVerdictRowSchema.parse({
        row_kind: "verdict",
        item_id: "legacy-item",
        stage: "dedup_or_review",
        detail: "dedup_survived",
        draw: "audit",
        attempt_ref: "unattributed",
        attribution_provenance: "legacy_unstamped",
      }),
    ).toEqual({
      row_kind: "verdict",
      item_id: "legacy-item",
      stage: "dedup_or_review",
      detail: "dedup_survived",
      draw: "audit",
      lens: "unknown",
      attempt_ref: "unattributed",
      provider: "unknown",
      model: "unknown",
      rank: "unknown",
      attribution_provenance: "legacy_unstamped",
    });

    expect(
      AttributionTripleSchema.safeParse({ pool_id: "codex/model" }).success,
    ).toBe(false);
    expect(
      DispatchAttemptRowSchema.safeParse({
        ...baseAttemptInput,
        pool_id: "codex/model",
      }).success,
    ).toBe(false);
  });

  it("requires every structural attempt and verdict field", () => {
    for (const field of [
      "row_kind",
      "attempt_key",
      "draw",
      "outcome",
      "findings_produced",
    ]) {
      expect(
        DispatchAttemptRowSchema.safeParse(
          withoutField(baseAttemptInput, field),
        ).success,
        `attempt.${field}`,
      ).toBe(false);
    }

    for (const field of [
      "row_kind",
      "item_id",
      "stage",
      "detail",
      "draw",
      "attempt_ref",
      "attribution_provenance",
    ]) {
      expect(
        FindingVerdictRowSchema.safeParse(
          withoutField(baseVerdictInput, field),
        ).success,
        `verdict.${field}`,
      ).toBe(false);
    }

    expect(
      DispatchAttemptRowSchema.safeParse({
        ...baseAttemptInput,
        row_kind: "dispatch_attempt",
      }).success,
    ).toBe(false);
    expect(
      FindingVerdictRowSchema.safeParse({
        ...baseVerdictInput,
        row_kind: "finding_verdict",
      }).success,
    ).toBe(false);
    expect(
      FindingVerdictRowSchema.safeParse({
        ...baseVerdictInput,
        row_kind: "unknown",
      }).success,
    ).toBe(false);
  });

  it("keeps stamped-but-unattributed distinct from legacy unstamped items", () => {
    const stamped = verdict({
      attempt_ref: "unattributed",
      provider: undefined,
      model: undefined,
      rank: undefined,
      lens: undefined,
      attribution_provenance: "stamped",
    });
    const legacy = verdict({
      item_id: "legacy-item",
      attempt_ref: "unattributed",
      provider: undefined,
      model: undefined,
      rank: undefined,
      lens: undefined,
      attribution_provenance: "legacy_unstamped",
    });

    expect(stamped.attribution_provenance).toBe("stamped");
    expect(legacy.attribution_provenance).toBe("legacy_unstamped");
    expect(stamped.attempt_ref).toBe("unattributed");
    expect(legacy.attempt_ref).toBe("unattributed");
    expect(stamped.provider).toBe("unknown");
    expect(legacy.provider).toBe("unknown");

    for (const invalid of ["direct", "inherited", "unattributed", "unknown"]) {
      expect(
        FindingVerdictRowSchema.safeParse({
          ...baseVerdictInput,
          attribution_provenance: invalid,
        }).success,
        invalid,
      ).toBe(false);
    }
  });

  it("accepts only the declared attempt outcomes and non-negative integer finding counts", () => {
    for (const outcome of ATTEMPT_OUTCOMES) {
      expect(attempt({ outcome }).outcome).toBe(outcome);
    }
    for (const outcome of ["unknown", "failed", "unavailable", ""]) {
      expect(
        DispatchAttemptRowSchema.safeParse({ ...baseAttemptInput, outcome })
          .success,
        outcome,
      ).toBe(false);
    }

    expect(attempt({ findings_produced: 0 }).findings_produced).toBe(0);
    expect(attempt({ findings_produced: 5 }).findings_produced).toBe(5);
    for (const findingsProduced of [
      -1,
      1.5,
      "unknown",
      [],
      ["finding-a"],
    ]) {
      expect(
        DispatchAttemptRowSchema.safeParse({
          ...baseAttemptInput,
          findings_produced: findingsProduced,
        }).success,
        JSON.stringify(findingsProduced),
      ).toBe(false);
    }
  });

  it("validates attribution and lens values against their existing vocabularies", () => {
    expect(
      DispatchAttemptRowSchema.safeParse({
        ...baseAttemptInput,
        provider: "provider-a",
      }).success,
    ).toBe(false);
    expect(
      DispatchAttemptRowSchema.safeParse({
        ...baseAttemptInput,
        rank: "top",
      }).success,
    ).toBe(false);
    expect(
      DispatchAttemptRowSchema.safeParse({
        ...baseAttemptInput,
        lens: "made-up-lens",
      }).success,
    ).toBe(false);
    expect(
      DispatchAttemptRowSchema.safeParse({
        ...baseAttemptInput,
        provider: "unknown",
        model: "unknown",
        rank: "unknown",
        lens: "unknown",
      }).success,
    ).toBe(true);
  });

  it("brands raw model ids at construction and reload boundaries", () => {
    const constructedModel = asOpaqueModelId("provider-owned-model");
    const opaqueModel: OpaqueModelId = constructedModel;
    // @ts-expect-error A bare string is not an OpaqueModelId.
    const unbrandedModel: OpaqueModelId = "provider-owned-model";
    void unbrandedModel;

    const original = attempt({ model: opaqueModel });
    const loaded = DispatchAttemptRowSchema.parse(
      JSON.parse(JSON.stringify(original)),
    );
    expect(loaded).toEqual(original);

    if (loaded.model === "unknown") {
      throw new Error("fixture model unexpectedly normalized to unknown");
    }
    const reloadedOpaqueModel: OpaqueModelId = loaded.model;
    // @ts-expect-error Reloaded model ids remain nominal, not plain strings.
    const invalidReloadedModel: typeof loaded.model = "provider-owned-model";
    void invalidReloadedModel;
    expect(reloadedOpaqueModel).toBe(constructedModel);
  });

  it("accepts exactly the declared stage, draw, and detail triples", () => {
    const allDetails = [...new Set(Object.values(VERDICT_DETAILS).flat())];

    for (const stage of VERDICT_STAGES) {
      for (const draw of DRAWS) {
        for (const detail of allDetails) {
          const expected =
            STAGE_OWNERSHIP[stage].has(draw) &&
            (VERDICT_DETAILS[stage] as readonly string[]).includes(detail);

          expect(isLegalDetail(stage, draw, detail), `${stage}/${draw}/${detail}`).toBe(
            expected,
          );
          expect(
            FindingVerdictRowSchema.safeParse({
              ...baseVerdictInput,
              stage,
              draw,
              detail,
            }).success,
            `row ${stage}/${draw}/${detail}`,
          ).toBe(expected);
        }
      }
    }
  });

  it("classifies every legal detail into the declared acceptance partition", () => {
    const expectedClasses = {
      dedup_or_review: {
        dedup_survived: "accepted",
        dedup_absorbed: "excluded",
        review_confirmed: "accepted",
        review_refuted: "rejected",
      },
      plan_review_gate: {
        approved: "accepted",
        declined: "rejected",
      },
      terminal_outcome: {
        resolved: "accepted",
        verified_no_change: "rejected",
        inappropriate: "rejected",
        ignored: "rejected",
        blocked: "excluded",
      },
      ingest_refused: {
        schema_invalid: "rejected",
        coverage_mismatch: "rejected",
        affirmation_missing: "rejected",
      },
    } as const;

    for (const stage of VERDICT_STAGES) {
      for (const detail of VERDICT_DETAILS[stage]) {
        const expectedForStage = expectedClasses[stage] as Readonly<
          Record<string, "accepted" | "rejected" | "excluded">
        >;
        expect(classifyDetail(stage, detail), `${stage}/${detail}`).toBe(
          expectedForStage[detail],
        );
      }
    }

    expect(new Set(VERDICT_DETAILS.terminal_outcome)).toEqual(
      new Set(RemediationOutcomeStatusSchema.options),
    );
  });

  it("matches a persisted aggregate fixture independently of row construction", () => {
    const rows = [
      attempt({ findings_produced: 2 }),
      verdict({ detail: "review_confirmed" }),
    ];

    expect(deriveAggregates(rows)).toEqual({
      reach: {
        codex: {
          "provider-owned-model-a": {
            security: {
              population: "attempt",
              attempts_admitted: 1,
              attempts_by_outcome: { completed: 1 },
              findings_produced: 2,
            },
          },
        },
      },
      verdicts: {
        codex: {
          "provider-owned-model-a": {
            security: {
              population: "verdict",
              stages: {
                dedup_or_review: {
                  details: { review_confirmed: 1 },
                  accepted: 1,
                  rejected: 0,
                  excluded: 0,
                  acceptance_rate: 1,
                },
              },
            },
          },
        },
      },
    });
  });

  it("derives reach and stage-local verdict rates from independent populations", () => {
    const rows: Array<DispatchAttemptRow | FindingVerdictRow> = [
      attempt({
        attempt_key: "attempt-five",
        findings_produced: 5,
      }),
      attempt({
        attempt_key: "attempt-zero",
        findings_produced: 0,
      }),
      attempt({
        attempt_key: "attempt-refused",
        outcome: "ingest_refused",
        findings_produced: 0,
      }),
      verdict({ item_id: "dedup-survived", detail: "dedup_survived" }),
      verdict({ item_id: "dedup-absorbed", detail: "dedup_absorbed" }),
      verdict({ item_id: "review-confirmed", detail: "review_confirmed" }),
      verdict({ item_id: "review-refuted", detail: "review_refuted" }),
      verdict({
        item_id: "plan-approved",
        stage: "plan_review_gate",
        detail: "approved",
        draw: "remediate",
      }),
      verdict({
        item_id: "plan-declined",
        stage: "plan_review_gate",
        detail: "declined",
        draw: "remediate",
      }),
      verdict({
        item_id: "terminal-resolved",
        stage: "terminal_outcome",
        detail: "resolved",
        draw: "remediate",
      }),
      verdict({
        item_id: "terminal-no-change",
        stage: "terminal_outcome",
        detail: "verified_no_change",
        draw: "remediate",
      }),
      verdict({
        item_id: "terminal-blocked",
        stage: "terminal_outcome",
        detail: "blocked",
        draw: "remediate",
      }),
      verdict({
        item_id: "ingest-schema",
        stage: "ingest_refused",
        detail: "schema_invalid",
        draw: "audit",
      }),
      verdict({
        item_id: "ingest-coverage",
        stage: "ingest_refused",
        detail: "coverage_mismatch",
        draw: "audit",
      }),
    ];
    const rowsBeforeDerivation = JSON.parse(JSON.stringify(rows)) as unknown;
    const aggregates = deriveAggregates(rows);
    const reach =
      aggregates.reach.codex?.[PRIMARY_MODEL_ID]?.security;
    const verdicts =
      aggregates.verdicts.codex?.[PRIMARY_MODEL_ID]?.security;

    expect(reach).toEqual({
      population: "attempt",
      attempts_admitted: 3,
      attempts_by_outcome: { completed: 2, ingest_refused: 1 },
      findings_produced: 5,
    });
    expect(verdicts).toEqual({
      population: "verdict",
      stages: {
        dedup_or_review: {
          details: {
            dedup_absorbed: 1,
            dedup_survived: 1,
            review_confirmed: 1,
            review_refuted: 1,
          },
          accepted: 2,
          rejected: 1,
          excluded: 1,
          acceptance_rate: 2 / 3,
        },
        ingest_refused: {
          details: { coverage_mismatch: 1, schema_invalid: 1 },
          accepted: 0,
          rejected: 2,
          excluded: 0,
          acceptance_rate: 0,
        },
        plan_review_gate: {
          details: { approved: 1, declined: 1 },
          accepted: 1,
          rejected: 1,
          excluded: 0,
          acceptance_rate: 0.5,
        },
        terminal_outcome: {
          details: { blocked: 1, resolved: 1, verified_no_change: 1 },
          accepted: 1,
          rejected: 1,
          excluded: 1,
          acceptance_rate: 0.5,
        },
      },
    });
    expect(JSON.parse(JSON.stringify(rows))).toEqual(rowsBeforeDerivation);

    const reachPopulation = reach!;
    const verdictPopulation = verdicts!;
    // @ts-expect-error Attempt and verdict populations must not be summable.
    const invalidPopulationSum = reachPopulation + verdictPopulation;
    // @ts-expect-error Reach populations cannot inhabit verdict cells.
    const wrongVerdictPopulation: VerdictPopulation = reachPopulation;
    // @ts-expect-error Verdict populations cannot inhabit reach cells.
    const wrongReachPopulation: ReachPopulation = verdictPopulation;
    void invalidPopulationSum;
    expect(wrongVerdictPopulation).toBe(reachPopulation);
    expect(wrongReachPopulation).toBe(verdictPopulation);
  });

  it("keeps every populated provider/model/lens combination in both sections", () => {
    const combinations = [
      ["codex", "model-a", "security"],
      ["codex", "model-a", "tests"],
      ["codex", "model-b", "security"],
      ["codex", "model-b", "tests"],
      ["agy", "model-a", "security"],
      ["agy", "model-a", "tests"],
      ["agy", "model-b", "security"],
      ["agy", "model-b", "tests"],
    ] as const;
    const rows: Array<DispatchAttemptRow | FindingVerdictRow> = [];

    for (const [provider, model, lens] of combinations) {
      const key = `${provider}-${model}-${lens}`;
      rows.push(
        attempt({
          attempt_key: `attempt-${key}`,
          provider,
          model,
          lens,
          findings_produced: 0,
        }),
        verdict({
          item_id: `finding-${key}`,
          attempt_ref: `attempt-${key}`,
          provider,
          model,
          lens,
        }),
      );
    }
    rows.push(
      DispatchAttemptRowSchema.parse({
        row_kind: "attempt",
        attempt_key: "attempt-unknown",
        draw: "audit",
        outcome: "completed",
        findings_produced: 0,
      }),
      FindingVerdictRowSchema.parse({
        row_kind: "verdict",
        item_id: "finding-unknown",
        stage: "dedup_or_review",
        detail: "review_confirmed",
        draw: "audit",
        attempt_ref: "unattributed",
        attribution_provenance: "stamped",
      }),
    );

    const aggregates = deriveAggregates(rows);
    const expectedCells = [
      "agy/model-a/security",
      "agy/model-a/tests",
      "agy/model-b/security",
      "agy/model-b/tests",
      "codex/model-a/security",
      "codex/model-a/tests",
      "codex/model-b/security",
      "codex/model-b/tests",
      "unknown/unknown/unknown",
    ];
    expect(populatedCells(aggregates.reach)).toEqual(expectedCells);
    expect(populatedCells(aggregates.verdicts)).toEqual(expectedCells);
    expect(aggregates.reach.unknown?.unknown?.unknown?.attempts_admitted).toBe(
      1,
    );
    expect(
      aggregates.verdicts.unknown?.unknown?.unknown?.stages.dedup_or_review
        ?.accepted,
    ).toBe(1);
  });

  it("uses row_kind, not incidental properties, to discriminate mixed rows", () => {
    const attemptWithForeignVerdictProperty = {
      ...attempt({ findings_produced: 0 }),
      attribution_provenance: "stamped" as const,
    };
    const aggregates = deriveAggregates([attemptWithForeignVerdictProperty]);

    expect(
      aggregates.reach.codex?.[PRIMARY_MODEL_ID]?.security
        ?.attempts_admitted,
    ).toBe(1);
    expect(aggregates.verdicts).toEqual({});
  });
});

// The attempt_key repair. The originating contract derived this key from "the
// admission identity the admission-control seam already mints", which does not
// exist — the design survived three adversarial laps because those lanes were
// scoped to the pipeline's own artifacts and could not read src/. These tests pin
// the properties the replacement derivation must actually have.
describe("buildAttemptKey", () => {
  const DISCRIMINATOR = buildResultContentDiscriminator({ source: "base" });

  it("is deterministic for the same packet, pool and emit-source", () => {
    const a = buildAttemptKey({
      packet_task_ids: ["task-b", "task-a"],
      bound_pool_id: "pool-1",
      result_content_discriminator: DISCRIMINATOR,
    });
    const b = buildAttemptKey({
      packet_task_ids: ["task-b", "task-a"],
      bound_pool_id: "pool-1",
      result_content_discriminator: DISCRIMINATOR,
    });
    expect(a).toBe(b);
  });

  // The defect this repair exists for. partitionTaskGraph assigns packet_id as a
  // position ordinal (`packet-${i + 1}`) AFTER a sort, so a resume that
  // re-partitions the remaining tasks renumbers it. A key keyed on packet_id would
  // move for the same tasks; keying on the task ids is what survives the resume.
  it("is replay-stable: identical for the same task SET regardless of order", () => {
    const before = buildAttemptKey({
      packet_task_ids: ["alpha", "beta", "gamma"],
      bound_pool_id: "pool-1",
      result_content_discriminator: DISCRIMINATOR,
    });
    const afterRepartition = buildAttemptKey({
      packet_task_ids: ["gamma", "alpha", "beta"],
      bound_pool_id: "pool-1",
      result_content_discriminator: DISCRIMINATOR,
    });
    expect(afterRepartition).toBe(before);
  });

  // INV-CAP-1: a provider that ran and failed must be distinguishable from one
  // that never ran. An unbound attempt therefore cannot share a key with a bound
  // one over the same packet. This is where candidate (c) died.
  it("keys an unbound (stranded) attempt distinctly from a bound one", () => {
    const shared = {
      packet_task_ids: ["task-a"],
      result_content_discriminator: DISCRIMINATOR,
    };
    expect(buildAttemptKey({ ...shared, bound_pool_id: null })).not.toBe(
      buildAttemptKey({ ...shared, bound_pool_id: "pool-1" }),
    );
  });

  it("moves when any single component moves", () => {
    const base = {
      packet_task_ids: ["task-a"],
      bound_pool_id: "pool-1",
      result_content_discriminator: DISCRIMINATOR,
    } as const;
    const baseline = buildAttemptKey(base);
    expect(buildAttemptKey({ ...base, packet_task_ids: ["task-z"] })).not.toBe(baseline);
    expect(buildAttemptKey({ ...base, bound_pool_id: "pool-2" })).not.toBe(baseline);
    expect(
      buildAttemptKey({
        ...base,
        result_content_discriminator: buildResultContentDiscriminator({
          source: "redispatch",
          attempt: 2,
        }),
      }),
    ).not.toBe(baseline);
  });

  // A re-dispatch is distinguished by EMIT SOURCE, exactly as idempotencyKey does
  // it — no minted id, no counter the dispatch layer would have to persist.
  it("separates a redispatch from the base attempt, and each retry from the last", () => {
    const shared = { packet_task_ids: ["task-a"], bound_pool_id: "pool-1" } as const;
    const first = buildAttemptKey({
      ...shared,
      result_content_discriminator: buildResultContentDiscriminator({
        source: "redispatch",
        attempt: 1,
      }),
    });
    const second = buildAttemptKey({
      ...shared,
      result_content_discriminator: buildResultContentDiscriminator({
        source: "redispatch",
        attempt: 2,
      }),
    });
    const base = buildAttemptKey({ ...shared, result_content_discriminator: DISCRIMINATOR });
    expect(new Set([first, second, base]).size).toBe(3);
  });

  // fail-3: refuse rather than mint a key that silently collides.
  it("refuses a missing component instead of hashing a hole", () => {
    expect(() =>
      buildAttemptKey({
        packet_task_ids: [],
        bound_pool_id: "pool-1",
        result_content_discriminator: DISCRIMINATOR,
      }),
    ).toThrow(/packet_task_ids/u);
    expect(() =>
      buildAttemptKey({
        packet_task_ids: ["task-a"],
        bound_pool_id: "",
        result_content_discriminator: DISCRIMINATOR,
      }),
    ).toThrow(/bound_pool_id/u);
    expect(() =>
      buildAttemptKey({
        packet_task_ids: ["task-a"],
        bound_pool_id: "pool-1",
        result_content_discriminator: "",
      }),
    ).toThrow(/result_content_discriminator/u);
  });

  it("produces a key the contract schema accepts", () => {
    const key = buildAttemptKey({
      packet_task_ids: ["task-a"],
      bound_pool_id: "pool-1",
      result_content_discriminator: DISCRIMINATOR,
    });
    expect(DispatchAttemptRowSchema.shape.attempt_key.safeParse(key).success).toBe(true);
  });
});
