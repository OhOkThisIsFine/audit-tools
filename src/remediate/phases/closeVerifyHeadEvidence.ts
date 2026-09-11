import {
  enumerateTrackedFilePaths,
  fileContentAtRef,
  gitRefExists,
  headCommit,
  isBareBasename,
  normalizeForMatch,
  quoteMatches,
  resolveBasenameToTrackedPath,
  stripEmittedLinePrefix,
  toPosixPath,
} from "audit-tools/shared";
import type { Evidence } from "../../shared/types/remediationOutcome.js";
import type { Finding, PerFindingDisposition, RemediationItemState } from "../state/types.js";

/**
 * CDC-25/CDC-26 (INV-ISC-EVIDENCE-EMITTED) — the PRODUCER for the two
 * evidence-bearing terminal dispositions. `verified_already_fixed` and
 * `refuted` are reachable from a real run ONLY through
 * `RemediationItemState.disposition_override`, and the writer
 * (`buildRemediationOutcomesReport` in `close.ts`) refuses that override unless
 * the item also carries a complete `evidence` triple and the module stamp that
 * recorded it. Nothing wrote those three fields, so both dispositions were
 * dead letters: the only route from a determination to run state was a human
 * transcribing a markdown document no code reads.
 *
 * This leg is that producer, and it is a REAL determination rather than a
 * record of one: it re-reads the finding's own CITED location at TWO refs and
 * decides from what it read. The triple it records names the file and the line
 * it actually read (that is the whole content of INV-ISC-EVIDENCE-EMITTED — the
 * recorded triple must name what was read), so a triple naming a location this
 * leg never opened cannot be produced here.
 *
 * ── WHY TWO READS, NEVER ONE ────────────────────────────────────────────────
 * Let B be the commit the AUDIT read when it produced the finding, and HEAD the
 * commit the fix has landed on by the time this leg runs (close.ts executes the
 * closing action BEFORE its verify legs, so HEAD contains the remediation
 * result — the same point `verifyAnalyzerLeads` and the combined-test leg
 * read). A read at HEAD ALONE cannot support either verdict:
 *
 *   span at B | span at HEAD | result
 *   ----------|--------------|------------------------------------------
 *   present   | absent       | `verified_already_fixed` — the code the audit
 *             |              | read is gone; the fix landed.
 *   absent    | (any)        | `refuted` — the audit read a location that
 *             |              | never showed the span it quoted.
 *   present   | present      | WITHHELD — the cited code still stands, so
 *             |              | this leg makes no determination at all.
 *   B unknown/unreadable     | WITHHELD, with the reason.
 *
 * The single-read form this leg used to carry was WRONG in both directions, and
 * the two errors were mirror images. It called "span still present at HEAD"
 * `refuted` on the stated ground that "the cited location never showed the
 * defect" — an inference no read at HEAD can make. A span still standing proves
 * only that the code the finding quoted is still there; if the defect was real
 * when the audit read it, it is still real. Symmetrically it called "span absent
 * at HEAD" `verified_already_fixed`, when an absent span has TWO causes: the
 * code changed after the audit read it (the fix landed), or the span was never
 * in the file (a misquote — the `refuted` case). B is what tells them apart, so
 * without B neither verdict is reachable and every candidate is withheld.
 *
 * ── WHERE B COMES FROM, AND WHY IT IS USUALLY UNKNOWN ───────────────────────
 * B must be a commit the AUDIT itself recorded. A remediation-side commit is
 * NOT B: code can change between the audit and the remediation run, so a span
 * absent at the remediation's own start could be a fix made in between rather
 * than a misquote — the very confusion this leg exists to avoid. The obvious
 * candidate, the host-handoff `baseline_commit`, is exactly that remediation-
 * side value and is therefore refused here BY NAME.
 *
 * The audit-side search (the findings contract and `Finding` schema, the report
 * intake path, `intake.ts`, `plan.ts`) finds no recorded upstream commit: the
 * `Finding` fields are the quote grounding (`quoted_text`), the plan-time
 * content hash (`hash_at_plan_time`, stamped by the REMEDIATOR at plan time),
 * the evidence lane, the verification status and the analyzer provenance —
 * none of which is a rev. `audit-findings.json`'s only envelope fields are
 * `contract_version` and the derived `summary`. The audit artifacts that DO
 * carry a rev (`artifact_metadata.git_history_baseline.head`) are internal
 * staleness caches and are never promoted into the deliverable the remediator
 * consumes. So at the time this leg was written B was UNKNOWN on every real
 * run, and every candidate resolved to WITHHELD.
 *
 * The resolution is NOT to invent a B and not to keep the false single-read
 * rule: it is to make B an OPTIONAL INPUT with a RESOLVER SEAM, so the rule
 * above is the shipped rule and a later packet that stamps the audit's rev only
 * has to supply the value. `HeadEvidenceOverrides.findingBase` is that seam.
 * Absent means "no B was supplied"; a caller that supplies one gets the
 * two-read determination, and any B that does not resolve to a real commit in
 * this repo is refused as unknown rather than read.
 *
 * PROVENANCE IS STRUCTURAL. Only `resolved_no_change` items are considered: the
 * host has already asserted "I changed nothing because nothing needed
 * changing", so this leg CONFIRMS or leaves that assertion standing — it can
 * never manufacture a disposition for an item nobody resolved. The outcome is
 * then still subject to the writer's own backstop, which refuses a triple whose
 * mechanism contradicts the disposition (`mechanismContradictsOutcome`) or that
 * arrives incomplete; a mechanism/disposition pair is reachable here only
 * because the branch above chose both together.
 *
 * It is a close-gate VERIFY leg, never a `CLOSING_ACTIONS` entry: it runs
 * beside `verifyAnalyzerLeads`, dispatches no host work, and a run with no
 * qualifying item is a no-op.
 */

/**
 * The commit the AUDIT read when it produced the findings — the `B` of the
 * two-read rule above. Production passes none: nothing in the audit contract
 * records one (see the module header), so a real run resolves to WITHHELD
 * rather than to a fabricated verdict.
 */
export interface FindingBase {
  /** Full commit id the audit read. Resolved against the repo before use. */
  commit: string;
}

export interface HeadEvidenceOverrides {
  /**
   * Test-injectable source; production callers pass none. Reads one file's
   * content at a ref — the seam BOTH of the leg's reads go through, so a test
   * can drive the two-read rule without a second commit on disk.
   */
  readAtRef?: (root: string, ref: string, file: string) => Promise<string | undefined>;
  /**
   * The audit-read commit `B`, when a caller has one. Absent (the production
   * default) means B is unknown and no candidate can be determined.
   */
  findingBase?: FindingBase;
}

/**
 * One candidate item's fate. A withheld record deliberately carries no
 * `disposition`/`evidence`: it is the statement that NEITHER was determined,
 * and giving it a triple would be giving it the very shape this whole leg
 * exists to keep meaningful.
 */
export type HeadEvidenceRecord =
  | {
      finding_id: string;
      determined: true;
      disposition: PerFindingDisposition;
      evidence: Evidence;
    }
  | {
      finding_id: string;
      determined: false;
      /** Why an item that qualified was NOT determined — recorded, never silent. */
      reason: string;
    };

export interface HeadEvidenceOutcome {
  /** False when no item was a candidate (leg is a no-op). */
  ran: boolean;
  /** The commit this leg's HEAD reads were made against; null when HEAD did not resolve. */
  head: string | null;
  /** The audit-read commit `B`, when one was supplied AND resolved; null otherwise. */
  base: string | null;
  /** Per finding_id, the triple + disposition this leg RECORDED onto the item. */
  recorded: Record<string, HeadEvidenceRecord>;
  /** Candidate items the leg declined to determine, with the reason. */
  withheld: HeadEvidenceRecord[];
}

const NO_OP: HeadEvidenceOutcome = {
  ran: false,
  head: null,
  base: null,
  recorded: {},
  withheld: [],
};

/** The module stamp carried into `recorded_by_module` (the ATTRIBUTION ROUND-TRIP). */
export const HEAD_EVIDENCE_MODULE = "closeVerifyHeadEvidence";

/**
 * How wide an emitted `NNN| ` line prefix this leg will strip when asking
 * whether a quote is absent. The emitter's own widths are per-delivery, and no
 * delivery manifest reaches close — so rather than guess one width, the leg
 * strips the widest prefix the emitted form can carry. That direction is the
 * safe one: over-stripping can only turn a "present" into a withheld record,
 * never an absent into a false `verified_already_fixed`.
 */
const PREFIX_WIDTH_MAX = 8;

/** Which cited anchor this leg will read, or `undefined` when none carries a quoted span. */
function anchorFor(finding: Finding): { path: string; quoted: string } | undefined {
  for (const location of finding.affected_files ?? []) {
    const quoted = location.quoted_text;
    if (typeof quoted === "string" && quoted.trim().length > 0) {
      return { path: location.path, quoted };
    }
  }
  return undefined;
}

/** The cited 1-based line the triple names, or `""` when the finding cites no line. */
function citedLineLabel(finding: Finding): string {
  for (const location of finding.affected_files ?? []) {
    if (location.line_start === undefined) continue;
    const end = location.line_end ?? location.line_start;
    return end === location.line_start ? `${location.line_start}` : `${location.line_start}-${end}`;
  }
  return "";
}

/**
 * Resolve a cited path to the repo-relative path it names, or `undefined` when
 * nothing is there. A bare basename resolves against the tracked corpus exactly
 * as the grounding pass resolves it (INV-B3-3), so a nested `advance.ts` is not
 * false-negatived into looking like a phantom path.
 */
function resolveCitedFile(
  cited: string,
  corpus: ReadonlySet<string>,
): string | undefined {
  const trimmed = cited.trim();
  if (trimmed.length === 0) return undefined;
  if (!isBareBasename(trimmed)) return toPosixPath(trimmed);
  return resolveBasenameToTrackedPath(trimmed, corpus);
}

/** What one read of the cited file at one ref found. */
type SpanPresence =
  | { kind: "present" }
  | { kind: "absent" }
  /** The span is absent unnormalized but present once the emitted prefix is stripped. */
  | { kind: "ambiguous" }
  | { kind: "withheld"; reason: string };

/**
 * Whether a quoted span is present in `content` — the ONE predicate both reads
 * go through, so B and HEAD cannot disagree about what "present" means, and
 * neither can drift from the grounding pass whose identical test admitted the
 * finding (S7 tier-1).
 *
 * The emitted-`NNN| `-prefix branch strips the QUOTE, not the content, exactly
 * as `checkCitations` does (`quoteMatches(content, stripEmittedLinePrefix(quote,
 * width))`) — the prefix is attached to the span the worker was shown, so it
 * rides the quote. Stripping the CONTENT instead is not the same operation and
 * is silently wrong: it de-prefixes the file's other lines rather than the
 * quote's, so a quote that was genuinely recoverable reads as absent.
 *
 * The ambiguity is applied to BOTH reads, not only to HEAD: a quote the emitted
 * prefix was not stripped from reads as ABSENT under the raw test even when the
 * code is right there, so admitting that shape on one side and not the other
 * would let the prefix alone manufacture a verdict.
 */
function spanPresence(content: string, quoted: string): SpanPresence {
  if (normalizeForMatch(quoted).length === 0) {
    return { kind: "withheld", reason: "the cited quoted_text span is empty after normalization" };
  }
  if (quoteMatches(content, quoted)) return { kind: "present" };
  if (quoteMatches(content, stripEmittedLinePrefix(quoted, PREFIX_WIDTH_MAX))) {
    return { kind: "ambiguous" };
  }
  return { kind: "absent" };
}

/**
 * Determine one item from its finding's own cited anchor, read at BOTH B and
 * HEAD. Returns the disposition + triple, or a reason why no determination was
 * possible.
 */
async function determine(
  params: {
    root: string;
    head: string;
    base: string;
    corpus: ReadonlySet<string>;
    finding: Finding;
    readAtRef: NonNullable<HeadEvidenceOverrides["readAtRef"]>;
  },
): Promise<
  { disposition: PerFindingDisposition; evidence: Evidence } | { withheld: string }
> {
  const { root, head, base, corpus, finding, readAtRef } = params;
  const anchor = anchorFor(finding);
  if (!anchor) {
    // Too little evidence to decide. Stated, never guessed at: this is the
    // per-file lane's normal shape (it carries an `evidence` array, not
    // `quoted_text` spans), so the leg must decline rather than infer a defect
    // claim out of prose the finding never bound to a location.
    return { withheld: "the finding carries no verbatim quoted_text span on any cited location" };
  }
  const file = resolveCitedFile(anchor.path, corpus);
  if (!file) {
    return { withheld: `cited path '${anchor.path}' does not resolve to a tracked file` };
  }
  const shortHead = head.slice(0, 12);
  const baseContent = await readAtRef(root, base, file);
  if (baseContent === undefined) {
    return { withheld: `'${file}' is not a readable file at the audit-read commit ${base.slice(0, 12)}` };
  }
  const basePresence = spanPresence(baseContent, anchor.quoted);
  if (basePresence.kind === "withheld") return { withheld: basePresence.reason };
  if (basePresence.kind === "ambiguous") {
    return {
      withheld:
        "the cited span matches at the audit-read commit only after stripping an emitted line prefix, so its presence there cannot be established",
    };
  }
  const line = citedLineLabel(finding);
  if (basePresence.kind === "present") {
    const headContent = await readAtRef(root, head, file);
    if (headContent === undefined) {
      return { withheld: `'${file}' is not a readable file at HEAD` };
    }
    const headPresence = spanPresence(headContent, anchor.quoted);
    if (headPresence.kind === "withheld") return { withheld: headPresence.reason };
    if (headPresence.kind === "ambiguous") {
      return {
        withheld:
          "the cited span matches at HEAD only after stripping an emitted line prefix, so its absence there cannot be established",
      };
    }
    if (headPresence.kind === "present") {
      // The code the finding quoted still stands at both reads. That is not a
      // refutation: a span still present proves only that the code is still
      // there — if the defect was real at B, it is still real at HEAD. This leg
      // makes no claim about the English of the finding, so it declines.
      return {
        withheld:
          `the cited span is present both at the audit-read commit ${base.slice(0, 12)} and at HEAD ${shortHead}, ` +
          "so this leg cannot tell a still-standing defect from a finding the code never showed",
      };
    }
    return {
      disposition: "verified_already_fixed",
      evidence: {
        file,
        line,
        mechanism: "read_at_head_verification",
        mechanism_detail:
          `read '${file}' at the audit-read commit ${base.slice(0, 12)} and at HEAD ${shortHead}: ` +
          "the cited span the finding quotes was present there and is no longer present, so the defect it cites was fixed by the time of the HEAD read",
      },
    };
  }
  // Absent at B, whatever HEAD says: the cited location never showed the quoted
  // span, so the finding's own citation cannot evidence the defect it claims.
  // HEAD is not read at all here — its state cannot change this verdict, and a
  // read we do not need is a read whose result we would have to ignore.
  return {
    disposition: "refuted",
    evidence: {
      file,
      line,
      mechanism: "read_at_head_refutation",
      mechanism_detail:
        `read '${file}' at the audit-read commit ${base.slice(0, 12)}: the cited span the finding quotes ` +
        "is not present there, so the cited location never showed the defect the finding claims",
    },
  };
}

export async function verifyHeadEvidenceAgainstFindings(params: {
  state: { plan?: { findings?: Finding[] } | undefined; items?: Record<string, RemediationItemState> | undefined };
  root: string;
  overrides?: HeadEvidenceOverrides;
}): Promise<HeadEvidenceOutcome> {
  const { state, root, overrides } = params;
  const findingsById = new Map(
    (state.plan?.findings ?? []).map((finding) => [finding.id, finding]),
  );

  // Provenance first: only a `resolved_no_change` item is a candidate, because
  // only there has the host asserted a no-change resolution for this leg to
  // confirm. An item that already carries an override is left alone — a
  // determination someone else recorded is not this leg's to overwrite.
  const candidates: Array<{ item: RemediationItemState; finding: Finding }> = [];
  for (const item of Object.values(state.items ?? {})) {
    if (item.status !== "resolved_no_change") continue;
    if (item.disposition_override !== undefined) continue;
    const finding = findingsById.get(item.finding_id);
    if (!finding) continue;
    candidates.push({ item, finding });
  }
  if (candidates.length === 0) return NO_OP;

  const withholdAll = (head: string | null, reason: string): HeadEvidenceOutcome => ({
    ran: true,
    head,
    base: null,
    recorded: {},
    withheld: candidates.map(({ finding }) => ({
      finding_id: finding.id,
      determined: false as const,
      reason,
    })),
  });

  // No resolvable HEAD means no read-at-HEAD determination exists to record, so
  // the leg refuses to run rather than record a triple it cannot stand behind.
  const head = await headCommit(root);
  if (head === null) {
    return withholdAll(null, "no resolvable HEAD — a read-at-HEAD determination cannot be made");
  }

  // B is an INPUT, never a guess, and it is verified before it is read: a
  // supplied commit that does not resolve in THIS repo is not a read the leg can
  // honestly attribute a triple to, so it is refused as unknown rather than
  // handed to `git show`. `gitRefExists` is what distinguishes "the caller gave
  // us a B this repo does not have" from "the caller gave us none" — both end in
  // the same withhold, but only one of them is a caller error worth naming.
  const base = overrides?.findingBase?.commit;
  if (base === undefined) {
    return withholdAll(
      head,
      "no audit-read commit is recorded for these findings, so neither a verification nor a refutation can be determined",
    );
  }
  if (!(await gitRefExists(root, base))) {
    return withholdAll(
      head,
      `the supplied audit-read commit '${base}' does not resolve to a commit in this repository`,
    );
  }

  const corpus = await enumerateTrackedFilePaths(root);
  const readAtRef =
    overrides?.readAtRef ??
    ((readRoot: string, ref: string, file: string) =>
      fileContentAtRef(readRoot, ref, file));

  const recorded: Record<string, HeadEvidenceRecord> = {};
  const withheld: HeadEvidenceRecord[] = [];
  for (const { item, finding } of candidates) {
    const verdict = await determine({ root, head, base, corpus, finding, readAtRef });
    if ("withheld" in verdict) {
      withheld.push({
        finding_id: finding.id,
        determined: false,
        reason: verdict.withheld,
      });
      continue;
    }
    item.disposition_override = verdict.disposition;
    item.evidence = verdict.evidence;
    item.recorded_by_module = HEAD_EVIDENCE_MODULE;
    recorded[finding.id] = {
      finding_id: finding.id,
      determined: true,
      disposition: verdict.disposition,
      evidence: verdict.evidence,
    };
  }

  return { ran: true, head, base, recorded, withheld };
}
