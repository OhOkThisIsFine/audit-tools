// The durable, human-reviewable record of every finding the intake filter removed
// before planning.
//
// WHY THIS EXISTS. The filter pass drops findings for four different reasons and
// the machine record (`review_filter_dispositions.json`) keeps only their IDS —
// so a person asking "what happened to that finding?" got an id and nothing
// else, and the finding's own title, severity and lens were only recoverable by
// cross-referencing the originals by hand. The no-evidence class was the sharpest
// case: a high-severity, high-confidence finding could be discarded with no trace
// a reader would ever encounter.
//
// WHY IT IS A DOCUMENT AND NOT A STEP (owner decision, 2026-09-06). The review
// gate shows SURVIVORS only — that is a locked decision from 2026-06-16, and this
// record does not reopen it. Nor does the drop belong in the emitted step's
// prompt, which is read aloud in the operator's conversation and would grow a
// block nobody asked for on a run where nothing is wrong. The owner asked for the
// drop to land "in a document that doesn't get surfaced in chat, but can be
// reviewed later". This is that document. Nothing reads it back; it is written
// for a person, after the fact.
//
// It is written on EVERY filter pass, including one that dropped nothing, so its
// absence means the pass did not run rather than "nothing was dropped" — a
// success-shaped empty needs an affirmation, not silence.
import { join } from "node:path";
import type { Finding } from "audit-tools/shared";
import type { FindingFilterResult } from "./findingFilter.js";

/** Canonical file name, relative to the remediation artifacts dir. */
export const DROPPED_FINDINGS_RECORD_FILENAME = "dropped-findings.md";

export function droppedFindingsRecordPath(artifactsDir: string): string {
  return join(artifactsDir, DROPPED_FINDINGS_RECORD_FILENAME);
}

/** One drop class, in the order a reader should meet them. */
interface DropSection {
  heading: string;
  /** Stated once per section, so a reader never has to infer why. */
  why: string;
  /** Finding id → an extra clause specific to this drop, when there is one. */
  entries: { id: string; detail?: string }[];
}

function describe(finding: Finding | undefined, id: string): string {
  if (!finding) return `\`${id}\` — (payload not present in the recorded originals)`;
  const parts = [`\`${id}\``, finding.title ?? "(untitled)"];
  const tags = [finding.severity, finding.confidence, finding.lens].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  return tags.length > 0 ? `${parts.join(" — ")} (${tags.join(", ")})` : parts.join(" — ");
}

/**
 * Render the record. PURE — no IO, so the shape is testable without a filesystem.
 *
 * @param originals every finding the filter pass saw, before any drop
 * @param filter the pass's own dispositions
 */
export function renderDroppedFindingsRecord(
  originals: readonly Finding[],
  filter: FindingFilterResult,
): string {
  const byId = new Map(originals.map((finding) => [finding.id, finding]));

  const sections: DropSection[] = [
    {
      heading: "Dropped — no evidence",
      why:
        "The finding carried no `evidence` entries. Remediation cannot act on a finding with " +
        "nothing to verify against, so it is removed before planning rather than dispatched and failed.",
      entries: filter.droppedNoEvidence.map((id) => ({ id })),
    },
    {
      heading: "Dropped — every cited path was phantom",
      why:
        "Every file the finding cited is absent from the repository, so there is nothing to change. " +
        "A finding that cited SOME real paths was kept, with only the phantom ones stripped.",
      entries: [...filter.droppedPhantomPaths.entries()].map(([id, paths]) => ({
        id,
        detail: `cited: ${paths.map((path) => `\`${path}\``).join(", ")}`,
      })),
    },
    {
      heading: "Dropped — excluded by the intent checkpoint",
      why:
        "The run's own intent checkpoint excluded this finding by severity, lens, package, theme " +
        "or scope. This is a choice the run recorded, not a defect.",
      entries: filter.droppedByCheckpoint.map((id) => ({ id })),
    },
    {
      heading: "Folded into another finding",
      why:
        "Two or more lenses flagged the same thing independently. The finding was merged into the " +
        "surviving one named below; it is not lost, it is represented by its canonical twin.",
      entries: [...filter.mergeMap.entries()].map(([absorbed, canonical]) => ({
        id: absorbed,
        detail: `folded into \`${canonical}\``,
      })),
    },
  ];

  const droppedCount = sections.reduce((total, section) => total + section.entries.length, 0);

  const lines: string[] = [
    "# Findings removed before planning",
    "",
    "> Written by `remediate-code` on every intake filter pass, for review after the fact.",
    "> Nothing reads this file back — it exists so a removal is never invisible.",
    "> The review gate deliberately shows SURVIVORS only; this is where the rest go.",
    "",
    `Findings seen by the filter: **${String(originals.length)}**. `
      + `Survived: **${String(filter.survivors.length)}**. `
      + `Removed or folded: **${String(droppedCount)}**.`,
    "",
  ];

  if (droppedCount === 0) {
    lines.push(
      "Nothing was removed on this pass. Every finding reached the review gate.",
      "",
    );
    return lines.join("\n");
  }

  for (const section of sections) {
    if (section.entries.length === 0) continue;
    lines.push(`## ${section.heading} (${String(section.entries.length)})`, "", section.why, "");
    for (const entry of section.entries) {
      const described = describe(byId.get(entry.id), entry.id);
      lines.push(`- ${described}${entry.detail ? ` — ${entry.detail}` : ""}`);
    }
    lines.push("");
  }

  // Sections with no entries are omitted above rather than printed empty, so the
  // reader meets only what actually happened. Name them here so an omission
  // cannot be misread as a class this pass does not have.
  const silent = sections.filter((section) => section.entries.length === 0);
  if (silent.length > 0) {
    lines.push(
      `No finding was removed for: ${silent.map((section) => `*${section.heading}*`).join("; ")}.`,
      "",
    );
  }

  return lines.join("\n");
}
