// sites-pinned: tests/audit/f1.test.ts, tests/remediate/checkpoint-filter.test.ts
import type { IntentCheckpoint } from "../types/intentCheckpoint.js";

/**
 * Shared path matching and structured scope policy. Review and write scope both
 * honor explicit exclusions; only write scope honors `must_not_touch` globs.
 * All matching is case-sensitive and OS-agnostic (separators normalized to "/").
 */
function normalize(p: string): string {
  return p.replace(/\\/g, "/");
}

/** Exact path or directory-prefix match (e.g. "src/api" matches "src/api/x.ts"). */
export function pathMatchesPrefix(filePath: string, entryPath: string): boolean {
  const f = normalize(filePath);
  const p = normalize(entryPath).replace(/\/+$/, "");
  if (!p) return false;
  return f === p || f.startsWith(`${p}/`);
}

/**
 * Translate one ordinary (non-`**`) glob segment to a regex fragment: `*`
 * within a segment matches any run of non-separator characters, `?` matches
 * one, and every other character is escaped — no placeholder substitution.
 */
function translateGlobSegment(segment: string): string {
  let re = "";
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i];
    if (c === "*") {
      re += "[^/]*";
    } else if (c === "?") {
      re += "[^/]";
    } else if (/[.+^${}()|[\]\\]/.test(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return re;
}

/**
 * Minimal glob match supporting `*` (within a segment), `**` (across
 * segments, matching ZERO or more whole path segments — conventional glob
 * semantics), `?`.
 *
 * A `**` segment folds its ADJACENT separator into its own regex fragment
 * (optional) rather than emitting it as a mandatory literal, so a
 * zero-segment match is possible on either side: `**\/*.env` matches a
 * <!-- comment-citation-exempt: illustrative glob match -->
 * repo-root `secrets.env`, `src/**\/*.ts` matches `src/index.ts`, and
 * `vendor/**` matches the bare `vendor` entry itself (COR-ef7a209d /
 * COR-ef7a209d-2) — not only paths with an intermediate directory.
 */
export function globMatches(filePath: string, glob: string): boolean {
  const f = normalize(filePath);
  const g = normalize(glob);
  if (!g.includes("*") && !g.includes("?")) {
    return pathMatchesPrefix(f, g);
  }

  const segments = g.split("/");
  const pieces: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]!;
    if (segment === "**") {
      if (i === 0 && i === segments.length - 1) {
        // The WHOLE glob is `**` — matches any path, including nested ones.
        pieces.push(".*");
      } else if (i === 0) {
        // Leading `**` — optionally consume any number of leading segments.
        pieces.push("(?:.*/)?");
      } else {
        // Trailing or interior `**` — optionally consume any number of
        // segments AFTER the preceding one, folding in the boundary `/` so
        // zero segments (i.e. nothing after) is a valid match too.
        pieces.push("(?:/.*)?");
      }
      continue;
    }
    if (i > 0 && segments[i - 1] !== "**") {
      pieces.push("/");
    }
    pieces.push(translateGlobSegment(segment));
  }
  return new RegExp(`^${pieces.join("")}$`).test(f);
}

/**
 * `disposition_overrides` statuses that mean "out of scope" for BOTH orchestrators.
 * `binary` / `doc_only` are dispositions but not exclusions, so they are absent.
 */
export const EXCLUDED_OVERRIDE_STATUSES: ReadonlySet<string> = new Set([
  "excluded",
  "generated",
  "vendor",
]);

/**
 * A file's structured exclusion reason (null when in scope). Explicit exclusions
 * and excluded dispositions apply to both review and write scope. `must_not_touch`
 * forbids writes only; it must not hide read-only audit targets from reviewers.
 * Write scope is the default so remediation callers retain their write guard.
 * Precedence is `excluded_scope`, `disposition_overrides`, then `must_not_touch`.
 * Never reads `free_form_intent` (INV-S04).
 *
 * Aggregation stays with the caller: audit excludes a unit only when EVERY file
 * is excluded; remediation drops a finding when ANY affected file is forbidden.
 */
export function fileExclusionReason(
  filePath: string,
  checkpoint: IntentCheckpoint | undefined,
  scope: "review" | "write" = "write",
): string | null {
  if (!checkpoint) return null;
  for (const entry of checkpoint.excluded_scope ?? []) {
    if (pathMatchesPrefix(filePath, entry.path)) return entry.reason;
  }
  for (const ov of checkpoint.disposition_overrides ?? []) {
    if (EXCLUDED_OVERRIDE_STATUSES.has(ov.status) && pathMatchesPrefix(filePath, ov.path)) {
      return ov.reason;
    }
  }
  if (scope === "write") {
    for (const glob of checkpoint.must_not_touch ?? []) {
      if (globMatches(filePath, glob)) return `must-not-touch scope (${glob})`;
    }
  }
  return null;
}
