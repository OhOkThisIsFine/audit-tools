/**
 * The ONE derivation of `lens_coverage` — what each lens the operator selected
 * actually delivered.
 *
 * Single-sourced because FOUR places need the same answer and a hand copy in any
 * of them would be a map that contradicts the findings beside it: the synthesis
 * boundary that mints it, the re-normalizer that carries it through a
 * re-synthesis, the approved-subset projection that must re-derive it over the
 * surviving findings, and the validator that refuses a map its own inputs do not
 * derive. The validator is a CONSUMER of this function, so "what the report
 * claims" and "what the gate checks" cannot drift.
 */
import type { Finding } from "../types/finding.js";
import type { LensCoverageEntry } from "../types/finding.js";
import type { MeasuredOutcome } from "../measurement/measuredOutcome.js";
import { compareCodeUnits } from "../compareCodeUnits.js";

/**
 * Count findings per lens. The same `countBy` shape `lens_breakdown` uses, kept
 * here so the coverage map and the breakdown can never be counted differently.
 */
function countByLens(findings: readonly Finding[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const finding of findings) {
    counts.set(finding.lens, (counts.get(finding.lens) ?? 0) + 1);
  }
  return counts;
}

/**
 * What one lens's count means, given whether ANY lens-open channel was ingested.
 *
 * `clean` is the load-bearing distinction: it may be read as "asked, and there
 * was nothing there", so it is reachable only when a channel that carried the
 * operator's selection actually came back. With no such channel, zero findings
 * means the lens was never exercised — `not_run` — which is true, and is the
 * whole point of the field.
 */
export function lensOutcome(
  findingsCount: number,
  lensOpenChannelIngested: boolean,
): MeasuredOutcome {
  if (findingsCount > 0) return "findings";
  return lensOpenChannelIngested ? "clean" : "not_run";
}

/**
 * Whether ONE entry's outcome contradicts its own count — the check a consumer
 * holding the map but not the run that produced it can actually establish.
 *
 * It deliberately does NOT re-decide `clean` versus `not_run`. Which of the two
 * a zero-count lens deserves depends on whether a lens-open channel was
 * ingested, and that is not in the report — so a validator that picked one would
 * refuse legitimate output rather than catch a defect. Abstaining there is the
 * verdict; what it refuses is the contradiction: a lens with findings that is
 * not `findings`, or a lens with none that is.
 */
export function lensCoverageEntryContradictsCount(
  entry: Pick<LensCoverageEntry, "findings_count" | "outcome">,
): boolean {
  return entry.findings_count > 0
    ? entry.outcome !== "findings"
    : entry.outcome === "findings";
}

/**
 * Derive the coverage map for a resolved selection.
 *
 * Order is `selectedLenses`' own — `resolveIntentLensSelection` emits canonical
 * registry order then the operator's custom lenses in input order, which is
 * content-derived and stable. A lens that produced findings while NOT being
 * selected is appended after them, sorted, so the map never silently omits a
 * lens the report counts.
 */
export function deriveLensCoverage(params: {
  readonly selectedLenses: readonly string[];
  readonly findings: readonly Finding[];
  readonly lensOpenChannelIngested: boolean;
}): LensCoverageEntry[] {
  const counts = countByLens(params.findings);
  const selected = new Set(params.selectedLenses);
  const entries: LensCoverageEntry[] = params.selectedLenses.map((lens) => {
    const findingsCount = counts.get(lens) ?? 0;
    return {
      lens,
      selected: true,
      findings_count: findingsCount,
      outcome: lensOutcome(findingsCount, params.lensOpenChannelIngested),
    };
  });
  const unselected = [...counts.keys()]
    .filter((lens) => !selected.has(lens))
    .sort(compareCodeUnits);
  for (const lens of unselected) {
    const findingsCount = counts.get(lens)!;
    entries.push({
      lens,
      selected: false,
      findings_count: findingsCount,
      // A lens nobody selected that nonetheless produced findings is
      // `findings`; it cannot be `clean`, because nothing asked for it.
      outcome: findingsCount > 0 ? "findings" : "not_run",
    });
  }
  return entries;
}

/**
 * Re-derive an EXISTING map's counts and outcomes over a (possibly narrowed)
 * finding set, preserving each entry's membership and `selected` flag.
 *
 * Used wherever the findings change but the SELECTION cannot be recovered: a
 * re-synthesis of a promoted report, and the approved-subset projection. Copying
 * the map through unchanged there would leave it contradicting a re-derived
 * `lens_breakdown`, and the projection validates itself at the write boundary —
 * so a subset that drops every finding of one lens would throw at the remediate
 * intake that requests it.
 *
 * Whether a lens was EXERCISED is read PER ENTRY, from the outcome the parent
 * map already recorded — an entry that was `findings` or `clean` was exercised,
 * and filtering findings out of a subset cannot un-exercise it. Re-deciding it
 * globally would turn a lens whose only finding the subset dropped into
 * `not_run`, which claims the run never looked.
 */
export function reprojectLensCoverage(
  coverage: readonly LensCoverageEntry[],
  findings: readonly Finding[],
): LensCoverageEntry[] {
  const counts = countByLens(findings);
  return coverage.map((entry) => {
    const findingsCount = counts.get(entry.lens) ?? 0;
    return {
      ...entry,
      findings_count: findingsCount,
      outcome: lensOutcome(findingsCount, entry.outcome !== "not_run"),
    };
  });
}
