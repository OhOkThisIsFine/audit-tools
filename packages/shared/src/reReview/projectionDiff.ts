/**
 * Diff-based re-review primitives (shared, B2/B3).
 *
 * Both orchestrators make staleness content/semantics-aware: a dependency is
 * recorded and compared by the hash of its *semantic projection* (only the
 * load-bearing structure a downstream consumes), and a verdict-bearing review
 * that must re-run after a genuine upstream change is handed its prior verdict
 * plus the precise changed-since-last-review delta — so it re-affirms cheaply or
 * revises only the affected items, never a blind full re-run.
 *
 * Each orchestrator owns its own *projection table* (which fields of which
 * artifact are load-bearing — remediate's `semanticProjection`, audit-code's
 * `designReviewProjection`), but the GENERIC machinery is single-sourced here:
 * the order-independent stable serialization, the leaf-level projection diff,
 * and the re-review prompt section. This keeps the two halves of the pipeline in
 * lockstep (one diff algorithm, one prompt shape) while leaving the
 * domain-specific projection to each side.
 */

/**
 * Order-independent stable serialization of a projection. Object keys are sorted
 * so two payloads that differ only in key order project to the same string (and
 * thus the same semantic hash); arrays preserve order (element order can be
 * load-bearing). `undefined` is encoded as `null` so a present-but-undefined
 * field and an absent field collapse — they carry the same meaning here.
 */
export function stableStringifyProjection(value: unknown): string {
  if (value === undefined || value === null) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringifyProjection(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringifyProjection(item)}`)
    .join(",")}}`;
}

// ── Projection diffing ─────────────────────────────────────────────────────────

/** Flatten a projection to leaf path → stable string value. */
function flatten(value: unknown, prefix: string, out: Map<string, string>): void {
  if (value === null || value === undefined) {
    out.set(prefix || "(root)", "null");
    return;
  }
  if (typeof value !== "object") {
    out.set(prefix || "(root)", JSON.stringify(value));
    return;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      out.set(prefix || "(root)", "[]");
      return;
    }
    value.forEach((item, i) => flatten(item, `${prefix}[${i}]`, out));
    return;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  if (keys.length === 0) {
    out.set(prefix || "(root)", "{}");
    return;
  }
  for (const key of keys) {
    flatten(
      (value as Record<string, unknown>)[key],
      prefix ? `${prefix}.${key}` : key,
      out,
    );
  }
}

const MAX_DIFF_LINES = 40;

/** A truncated value for display (long strings get an ellipsis). */
function short(value: string): string {
  return value.length > 120 ? `${value.slice(0, 117)}...` : value;
}

/**
 * Render a leaf-level diff between two projections as `+`/`-`/`~` lines. Returns
 * an empty array when the projections are identical. Bounded to MAX_DIFF_LINES
 * with an explicit overflow note (never silently truncated).
 */
export function diffProjections(prior: unknown, current: unknown): string[] {
  const a = new Map<string, string>();
  const b = new Map<string, string>();
  flatten(prior, "", a);
  flatten(current, "", b);

  const allKeys = [...new Set([...a.keys(), ...b.keys()])].sort();
  const lines: string[] = [];
  for (const key of allKeys) {
    const before = a.get(key);
    const after = b.get(key);
    if (before === after) continue;
    if (before === undefined) lines.push(`+ ${key}: ${short(after!)}`);
    else if (after === undefined) lines.push(`- ${key}: ${short(before)}`);
    else lines.push(`~ ${key}: ${short(before)} → ${short(after)}`);
  }
  if (lines.length > MAX_DIFF_LINES) {
    const shown = lines.slice(0, MAX_DIFF_LINES);
    shown.push(`… and ${lines.length - MAX_DIFF_LINES} more changed field(s).`);
    return shown;
  }
  return lines;
}

// ── Re-review prompt section ─────────────────────────────────────────────────────

/** One changed upstream input: its label plus the field-level diff lines. */
export interface ProjectionDiffEntry {
  /** Human-readable name of the changed input (artifact / dependency name). */
  label: string;
  /** Leaf-level `+`/`-`/`~` diff lines from `diffProjections`. */
  lines: string[];
}

export interface ReReviewSectionInput {
  /**
   * The verdict the prior review emitted — what a re-review re-affirms verbatim
   * when the changes below do not affect it.
   */
  priorPayload: unknown;
  /** Per-input diffs, empty when nothing changed. */
  changedInputs: ProjectionDiffEntry[];
  /** True when no upstream projection actually changed (re-affirm verbatim). */
  allUnchanged: boolean;
  /**
   * The noun for the thing being re-reviewed, e.g. `"artifact"` or
   * `"design-review pass"`. Used only in the section prose. Defaults to
   * `"review"`.
   */
  subjectNoun?: string;
}

/**
 * Render the diff-based re-review section appended to a review's re-emit prompt.
 * Carries the prior verdict and the precise changed-since-last-review delta, and
 * instructs the worker to re-affirm the prior verdict when the delta does not
 * affect it, or revise only the affected items otherwise. Enforced by the tool
 * (the re-emit prompt carries the delta), never left to the host to remember.
 */
export function renderDiffReReviewSection(input: ReReviewSectionInput): string {
  const subjectNoun = input.subjectNoun ?? "review";
  const priorJson = JSON.stringify(input.priorPayload, null, 2);
  const deltaBlock = input.allUnchanged
    ? "_No upstream semantic change was detected._ The inputs you reviewed are unchanged in substance; re-emit your prior verdict verbatim (only the provenance/timestamp differs)."
    : input.changedInputs
        .map(
          (entry) =>
            `### Changed: \`${entry.label}\`\n\n\`\`\`diff\n${entry.lines.join("\n")}\n\`\`\``,
        )
        .join("\n\n");

  return `## Diff-Based Re-Review — only re-examine what changed

This ${subjectNoun} was already reviewed; its upstreams then changed, so it must be
re-emitted. **Do NOT re-run the full review.** Diff against your prior verdict
and re-examine ONLY the changes below.

### Your prior verdict (re-affirm it verbatim if the changes below do not affect it)

\`\`\`json
${priorJson}
\`\`\`

### Changed since your prior verdict

${deltaBlock}

### How to respond

- If the changes above do **not** affect any item in your prior verdict, re-emit
  the prior verdict unchanged (you may freshen ids/timestamps the schema requires).
- If they **do**, revise ONLY the affected items and leave the rest as they were.
- Do not invent new findings unrelated to the changes above.
`;
}
