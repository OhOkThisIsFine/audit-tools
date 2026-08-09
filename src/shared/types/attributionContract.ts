import { z } from "zod";

import { LensSchema, type Lens } from "./lens.js";
import {
  RemediationOutcomeStatusSchema,
  type RemediationOutcomeStatus,
} from "./remediationOutcome.js";
import {
  PROVIDER_NAMES,
  type ResolvedProviderName,
} from "./sessionConfig.js";
import {
  DispatchModelTierSchema,
  type DispatchModelTier,
} from "./stepContract.js";

export type OpaqueModelId = string & {
  readonly __opaqueModelId: unique symbol;
};

/** Brand a provider-owned model id without interpreting its contents. */
export function asOpaqueModelId(value: string): OpaqueModelId {
  return value as OpaqueModelId;
}

const RESOLVED_PROVIDER_NAMES: ReadonlySet<string> = new Set(
  PROVIDER_NAMES.filter((provider) => provider !== "auto"),
);

const ResolvedProviderNameSchema = z.custom<ResolvedProviderName>(
  (value) =>
    typeof value === "string" && RESOLVED_PROVIDER_NAMES.has(value),
  "resolved provider name",
);

const UnknownSchema = z.literal("unknown");

const OptionalProviderSchema = z
  .union([UnknownSchema, ResolvedProviderNameSchema])
  .optional()
  .transform(
    (value): ResolvedProviderName | "unknown" => value ?? "unknown",
  );

const OptionalModelSchema = z
  .union([
    UnknownSchema,
    z.string().min(1).transform((value) => asOpaqueModelId(value)),
  ])
  .optional()
  .transform((value): OpaqueModelId | "unknown" => value ?? "unknown");

const OptionalRankSchema = z
  .union([UnknownSchema, DispatchModelTierSchema])
  .optional()
  .transform((value): DispatchModelTier | "unknown" => value ?? "unknown");

export const AttributionTripleSchema = z
  .object({
    provider: OptionalProviderSchema,
    model: OptionalModelSchema,
    rank: OptionalRankSchema,
  })
  .strict();
export type AttributionTriple = z.infer<typeof AttributionTripleSchema>;
type AttributionProvider = AttributionTriple["provider"];
type AttributionModel = AttributionTriple["model"];
type AttributionLens = Lens | "unknown";

export const DRAWS = ["audit", "remediate"] as const;
export type Draw = (typeof DRAWS)[number];

export const VERDICT_STAGES = [
  "dedup_or_review",
  "plan_review_gate",
  "terminal_outcome",
  "ingest_refused",
] as const;
export type VerdictStage = (typeof VERDICT_STAGES)[number];

export const VERDICT_DETAILS = {
  dedup_or_review: [
    "dedup_survived",
    "dedup_absorbed",
    "review_confirmed",
    "review_refuted",
  ],
  plan_review_gate: ["approved", "declined"],
  terminal_outcome: RemediationOutcomeStatusSchema.options,
  ingest_refused: [
    "schema_invalid",
    "coverage_mismatch",
    "affirmation_missing",
  ],
} as const;

type VerdictDetailByStage = {
  [Stage in VerdictStage]: (typeof VERDICT_DETAILS)[Stage][number];
};
export type VerdictDetail = VerdictDetailByStage[VerdictStage];

function drawSet(first: Draw, ...rest: Draw[]): ReadonlySet<Draw> {
  return new Set([first, ...rest]);
}

export const STAGE_OWNERSHIP = {
  dedup_or_review: drawSet("audit", "remediate"),
  plan_review_gate: drawSet("remediate"),
  terminal_outcome: drawSet("remediate"),
  ingest_refused: drawSet("audit"),
} as const satisfies Record<VerdictStage, ReadonlySet<Draw>>;

export const AttributionProvenanceSchema = z.enum([
  "stamped",
  "legacy_unstamped",
]);
export type AttributionProvenance = z.infer<
  typeof AttributionProvenanceSchema
>;

export type RowKind = "attempt" | "verdict";

const DrawSchema = z.enum(DRAWS);
const VerdictStageSchema = z.enum(VERDICT_STAGES);
const VerdictDetailSchema = z.union([
  z.enum(VERDICT_DETAILS.dedup_or_review),
  z.enum(VERDICT_DETAILS.plan_review_gate),
  RemediationOutcomeStatusSchema,
  z.enum(VERDICT_DETAILS.ingest_refused),
]);
const OptionalLensSchema = z
  .union([UnknownSchema, LensSchema])
  .optional()
  .transform((value): Lens | "unknown" => value ?? "unknown");

const DispatchAttemptOutcomeSchema = z.enum([
  "completed",
  "ingest_refused",
  "stranded",
  "provider_unavailable",
]);
export type DispatchAttemptOutcome = z.infer<
  typeof DispatchAttemptOutcomeSchema
>;

export const DispatchAttemptRowSchema = z
  .object({
    row_kind: z.literal("attempt"),
    attempt_key: z.string().min(1),
    ...AttributionTripleSchema.shape,
    lens: OptionalLensSchema,
    draw: DrawSchema,
    outcome: DispatchAttemptOutcomeSchema,
    findings_produced: z.number().int().nonnegative(),
  })
  .strict();
export type DispatchAttemptRow = z.infer<typeof DispatchAttemptRowSchema>;

export const FindingVerdictRowSchema = z
  .object({
    row_kind: z.literal("verdict"),
    item_id: z.string().min(1),
    stage: VerdictStageSchema,
    detail: VerdictDetailSchema,
    draw: DrawSchema,
    lens: OptionalLensSchema,
    attempt_ref: z.string().min(1),
    ...AttributionTripleSchema.shape,
    attribution_provenance: AttributionProvenanceSchema,
  })
  .strict()
  .superRefine((row, context) => {
    if (!isLegalDetail(row.stage, row.draw, row.detail)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["detail"],
        message: `detail ${row.detail} is not legal for ${row.draw}/${row.stage}`,
      });
    }
  });
export type FindingVerdictRow = z.infer<typeof FindingVerdictRowSchema>;

function includes<const Values extends readonly string[]>(
  values: Values,
  value: string,
): value is Values[number] {
  return (values as readonly string[]).includes(value);
}

export function isLegalDetail(
  stage: string,
  draw: string,
  detail: string,
): detail is VerdictDetail {
  if (!includes(VERDICT_STAGES, stage) || !includes(DRAWS, draw)) {
    return false;
  }
  return (
    STAGE_OWNERSHIP[stage].has(draw) &&
    includes(VERDICT_DETAILS[stage], detail)
  );
}

export type DetailClassification = "accepted" | "rejected" | "excluded";

function assertNever(value: never): never {
  throw new Error(`unhandled attribution-contract value: ${String(value)}`);
}

function classifyDedupOrReview(
  detail: VerdictDetailByStage["dedup_or_review"],
): DetailClassification {
  switch (detail) {
    case "dedup_survived":
    case "review_confirmed":
      return "accepted";
    case "review_refuted":
      return "rejected";
    case "dedup_absorbed":
      return "excluded";
  }
  return assertNever(detail);
}

function classifyPlanReviewGate(
  detail: VerdictDetailByStage["plan_review_gate"],
): DetailClassification {
  switch (detail) {
    case "approved":
      return "accepted";
    case "declined":
      return "rejected";
  }
  return assertNever(detail);
}

function classifyTerminalOutcome(
  detail: RemediationOutcomeStatus,
): DetailClassification {
  switch (detail) {
    case "resolved":
      return "accepted";
    case "verified_no_change":
    case "inappropriate":
    case "ignored":
      return "rejected";
    case "blocked":
      return "excluded";
  }
  return assertNever(detail);
}

function classifyIngestRefused(
  detail: VerdictDetailByStage["ingest_refused"],
): DetailClassification {
  switch (detail) {
    case "schema_invalid":
    case "coverage_mismatch":
    case "affirmation_missing":
      return "rejected";
  }
  return assertNever(detail);
}

/** Classify a legal stage/detail pair for its within-stage acceptance rate. */
export function classifyDetail(
  stage: VerdictStage,
  detail: VerdictDetail,
): DetailClassification {
  if (!includes(VERDICT_DETAILS[stage], detail)) {
    throw new Error(`detail ${detail} is not legal for ${stage}`);
  }

  switch (stage) {
    case "dedup_or_review":
      return classifyDedupOrReview(
        detail as VerdictDetailByStage["dedup_or_review"],
      );
    case "plan_review_gate":
      return classifyPlanReviewGate(
        detail as VerdictDetailByStage["plan_review_gate"],
      );
    case "terminal_outcome":
      return classifyTerminalOutcome(detail as RemediationOutcomeStatus);
    case "ingest_refused":
      return classifyIngestRefused(
        detail as VerdictDetailByStage["ingest_refused"],
      );
  }
  return assertNever(stage);
}

/** Attempt-level reach population. */
export interface ReachPopulation {
  readonly population: "attempt";
  readonly attempts_admitted: number;
  readonly attempts_by_outcome: Readonly<
    Partial<Record<DispatchAttemptOutcome, number>>
  >;
  readonly findings_produced: number;
}

/** One stage's verdict population and acceptance partition. */
export interface VerdictStagePopulation {
  readonly details: Readonly<Partial<Record<VerdictDetail, number>>>;
  readonly accepted: number;
  readonly rejected: number;
  readonly excluded: number;
  readonly acceptance_rate: number | null;
}

/** Verdict-level population, deliberately distinct from ReachPopulation. */
export interface VerdictPopulation {
  readonly population: "verdict";
  readonly stages: Readonly<
    Partial<Record<VerdictStage, VerdictStagePopulation>>
  >;
}

type ProviderModelLensIndex<Population> = Partial<
  Record<
    AttributionProvider,
    Partial<
      Record<
        AttributionModel,
        Partial<Record<AttributionLens, Population>>
      >
    >
  >
>;

export type ReachAggregate = ProviderModelLensIndex<ReachPopulation>;
export type VerdictAggregate = ProviderModelLensIndex<VerdictPopulation>;

export interface DispatchEffectivenessAggregates {
  readonly reach: ReachAggregate;
  readonly verdicts: VerdictAggregate;
}

type NestedPopulationMap<Population> = Map<
  AttributionProvider,
  Map<AttributionModel, Map<AttributionLens, Population>>
>;

interface MutableReachPopulation {
  attempts_admitted: number;
  attempts_by_outcome: Map<DispatchAttemptOutcome, number>;
  findings_produced: number;
}

interface MutableVerdictStagePopulation {
  details: Map<VerdictDetail, number>;
  accepted: number;
  rejected: number;
  excluded: number;
}

interface MutableVerdictPopulation {
  stages: Map<VerdictStage, MutableVerdictStagePopulation>;
}

function compareContentKey(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function orderedRecord<Key extends string, Value>(
  entries: Iterable<readonly [Key, Value]>,
): Partial<Record<Key, Value>> {
  return Object.fromEntries(
    [...entries].sort(([left], [right]) => compareContentKey(left, right)),
  ) as Partial<Record<Key, Value>>;
}

function populationFor<Population>(
  index: NestedPopulationMap<Population>,
  provider: AttributionProvider,
  model: AttributionModel,
  lens: AttributionLens,
  create: () => Population,
): Population {
  let models = index.get(provider);
  if (!models) {
    models = new Map();
    index.set(provider, models);
  }

  let lenses = models.get(model);
  if (!lenses) {
    lenses = new Map();
    models.set(model, lenses);
  }

  let population = lenses.get(lens);
  if (!population) {
    population = create();
    lenses.set(lens, population);
  }
  return population;
}

function increment<Key extends string>(counts: Map<Key, number>, key: Key): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function addAttempt(
  index: NestedPopulationMap<MutableReachPopulation>,
  row: DispatchAttemptRow,
): void {
  const population = populationFor(
    index,
    row.provider,
    row.model,
    row.lens,
    () => ({
      attempts_admitted: 0,
      attempts_by_outcome: new Map(),
      findings_produced: 0,
    }),
  );
  population.attempts_admitted += 1;
  population.findings_produced += row.findings_produced;
  increment(population.attempts_by_outcome, row.outcome);
}

function addVerdict(
  index: NestedPopulationMap<MutableVerdictPopulation>,
  row: FindingVerdictRow,
): void {
  const population = populationFor(
    index,
    row.provider,
    row.model,
    row.lens,
    () => ({ stages: new Map() }),
  );
  let stage = population.stages.get(row.stage);
  if (!stage) {
    stage = {
      details: new Map(),
      accepted: 0,
      rejected: 0,
      excluded: 0,
    };
    population.stages.set(row.stage, stage);
  }

  increment(stage.details, row.detail);
  stage[classifyDetail(row.stage, row.detail)] += 1;
}

function finishReach(
  index: NestedPopulationMap<MutableReachPopulation>,
): ReachAggregate {
  return orderedRecord(
    [...index].map(([provider, models]) => [
      provider,
      orderedRecord(
        [...models].map(([model, lenses]) => [
          model,
          orderedRecord(
            [...lenses].map(([lens, population]) => [
              lens,
              {
                population: "attempt",
                attempts_admitted: population.attempts_admitted,
                attempts_by_outcome: orderedRecord(
                  population.attempts_by_outcome,
                ),
                findings_produced: population.findings_produced,
              } satisfies ReachPopulation,
            ] as const),
          ),
        ] as const),
      ),
    ] as const),
  );
}

function finishVerdicts(
  index: NestedPopulationMap<MutableVerdictPopulation>,
): VerdictAggregate {
  return orderedRecord(
    [...index].map(([provider, models]) => [
      provider,
      orderedRecord(
        [...models].map(([model, lenses]) => [
          model,
          orderedRecord(
            [...lenses].map(([lens, population]) => [
              lens,
              {
                population: "verdict",
                stages: orderedRecord(
                  [...population.stages].map(([stage, stagePopulation]) => {
                    const denominator =
                      stagePopulation.accepted + stagePopulation.rejected;
                    return [
                      stage,
                      {
                        details: orderedRecord(stagePopulation.details),
                        accepted: stagePopulation.accepted,
                        rejected: stagePopulation.rejected,
                        excluded: stagePopulation.excluded,
                        acceptance_rate:
                          denominator === 0
                            ? null
                            : stagePopulation.accepted / denominator,
                      } satisfies VerdictStagePopulation,
                    ] as const;
                  }),
                ),
              } satisfies VerdictPopulation,
            ] as const),
          ),
        ] as const),
      ),
    ] as const),
  );
}

/** Derive provider/model/lens reach and verdict populations from stable rows. */
export function deriveAggregates(
  rows: readonly (DispatchAttemptRow | FindingVerdictRow)[],
): DispatchEffectivenessAggregates {
  const reach: NestedPopulationMap<MutableReachPopulation> = new Map();
  const verdicts: NestedPopulationMap<MutableVerdictPopulation> = new Map();

  for (const row of rows) {
    switch (row.row_kind) {
      case "attempt":
        addAttempt(reach, row);
        break;
      case "verdict":
        addVerdict(verdicts, row);
        break;
      default:
        assertNever(row);
    }
  }

  return {
    reach: finishReach(reach),
    verdicts: finishVerdicts(verdicts),
  };
}
