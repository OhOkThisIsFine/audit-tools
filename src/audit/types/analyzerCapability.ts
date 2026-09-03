import { z } from "zod";
import {
  AnalyzerSettingSchema,
  MeasuredOutcomeSchema,
  worstMeasuredOutcome,
  type MeasuredOutcome,
} from "audit-tools/shared";
import {
  AnalyzerResolutionSchema,
  type AnalyzerResolution,
} from "../extractors/analyzers/types.js";

// Marker artifact recording the outcome of the optional Phase 5 graph-enrichment
// pass. Its presence (and freshness against `graph_bundle.json`) satisfies the
// `graph_enrichment_current` obligation; the merged analyzer edges themselves
// live in `graph_bundle.json` (with `analyzers_used[]` provenance).

export const AnalyzerCapabilityEntrySchema = z
  .object({
    id: z.string().min(1),
    resolution: AnalyzerResolutionSchema,
    setting: AnalyzerSettingSchema,
    edges_added: z.number().int().min(0),
    routes_added: z.number().int().min(0),
    note: z.string().optional(),
  })
  .strict();
export type AnalyzerCapabilityEntry = z.infer<
  typeof AnalyzerCapabilityEntrySchema
>;

export const AnalyzerCapabilityRecordSchema = z
  .object({
    /**
     * What the graph-enrichment channel actually PRODUCED, in the shared
     * measured-outcome vocabulary — derived from the entries below by
     * {@link analyzerCapabilityCoverage}, never asserted.
     *
     * It replaces `status: "applied" | "omitted"`, which was a success-predicate
     * over a partial set (`analyzersUsed.length > 0`) and therefore read
     * `applied` while operator-requested analyzers had failed and the weaker
     * regex floor stood in — a field that answered "did ANY analyzer contribute
     * edges" while every reader took it for "did enrichment work".
     */
    coverage: MeasuredOutcomeSchema,
    analyzers: z.array(AnalyzerCapabilityEntrySchema),
  })
  .strict();
export type AnalyzerCapabilityRecord = z.infer<
  typeof AnalyzerCapabilityRecordSchema
>;

/**
 * What ONE analyzer's row says it produced.
 *
 * DERIVED AT READ TIME, never persisted: it is a total function of `resolution`
 * plus `edges_added`/`routes_added`, and a persisted total derivation is a field
 * that can disagree with its own inputs. `AnalyzerCapabilityEntrySchema` is
 * therefore deliberately unchanged.
 *
 * Dispatched through an exhaustive `Record` over {@link AnalyzerResolution}, so
 * a new resolution member without a classification is a compile error. The
 * dispatch holds FUNCTIONS rather than outcomes because three members
 * (`repo`/`cache`/`installed`) cannot be classified from the resolution alone —
 * whether a parser that ran produced anything is a property of the ENTRY.
 */
const ENTRY_OUTCOME_BY_RESOLUTION: Record<
  AnalyzerResolution,
  (entry: AnalyzerCapabilityEntry) => MeasuredOutcome
> = {
  repo: contributed,
  cache: contributed,
  installed: contributed,
  /** Requested, but the dependency never resolved — the regex floor stood in. */
  absent: () => "degraded",
  /** The operator disabled it. No coverage, and none was owed. */
  skip: () => "not_run",
  /** No file in scope is supported. There was nothing to measure. */
  not_applicable: () => "not_applicable",
};

function contributed(entry: AnalyzerCapabilityEntry): MeasuredOutcome {
  // A RESOLVED analyzer carries a note only when its run failed — the executor
  // writes none on the success path — so a resolved-but-noted entry that added
  // nothing is a crashed run, never `clean`. Reading the presence of the note
  // rather than matching its text: the note is a human sentence, and
  // recognizing a failure by its prose is the drift this record exists to stop.
  if (entry.note !== undefined) return "degraded";
  return entry.edges_added + entry.routes_added > 0 ? "findings" : "clean";
}

export function analyzerEntryOutcome(
  entry: AnalyzerCapabilityEntry,
): MeasuredOutcome {
  return ENTRY_OUTCOME_BY_RESOLUTION[entry.resolution](entry);
}

/**
 * Whether an entry was OWED coverage at all — the population the roll-up runs
 * over.
 *
 * An operator decline and an analyzer with no supported files were never asked
 * to produce anything, so neither can be a shortfall of this channel. Rolling
 * them in would make a run that added 1932 edges and skipped one analyzer report
 * `not_run` — the same partial-set roll-up defect this record exists to remove,
 * inverted. Their own rows still say exactly what happened; what they do not do
 * is speak for the channel.
 */
function wasOwedCoverage(entry: AnalyzerCapabilityEntry): boolean {
  return entry.resolution !== "skip" && entry.resolution !== "not_applicable";
}

/**
 * Roll the entries up into the one outcome a reader must be told about:
 * worst-first over everything that was asked for. An empty population — nothing
 * was asked for — is `not_applicable`, never `clean`.
 */
export function analyzerCapabilityCoverage(
  entries: readonly AnalyzerCapabilityEntry[],
): MeasuredOutcome {
  return worstMeasuredOutcome(
    entries.filter(wasOwedCoverage).map(analyzerEntryOutcome),
  );
}

/**
 * The entries a reader must NAME. The scalar roll-up cannot state "1932 edges
 * added AND two analyzers degraded", so no reader is asked to infer the second
 * half from it: both readers (the report's limitations section and the shared
 * structural context every design-review lane renders) list these rows.
 */
export function degradedAnalyzerEntries(
  record: AnalyzerCapabilityRecord | undefined,
): readonly AnalyzerCapabilityEntry[] {
  return (record?.analyzers ?? []).filter(
    (entry) => analyzerEntryOutcome(entry) === "degraded",
  );
}
