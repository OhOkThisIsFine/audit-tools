// P20 (owner decision sol-2, 2026-08-12): parsing is not classifying. The
// sweep's coverage stamp exists so coverage is read, never eyeballed — which
// only works if what counts as "classified" is actually a triage record. Five
// of one night's "120 classified" carried no verdict at all (one was the JSON
// schema echoed back), and one record's model-written `file` overwrote the
// sweep's own identity fields. buildTriageRecord is the single chokepoint:
// salvage, parse, own the identity, and shape-validate; a mismatch throws into
// the worker's existing errored/resume path (errored rows are dropped from
// `done` on resume, so these retry like any transport failure).
import { describe, expect, it } from "vitest";

import {
  buildTriageRecord,
  TRIAGE_VERDICTS,
  resolveCodePaths,
} from "../../scripts/shared/triage-backlog.mjs";

const ENTRY = { id: "open-bugs#c5ba56ab", file: "open-bugs.md" };

/**
 * A tracked-file query over a fixed tree, answering in the same shape
 * `resolveProbes`'s `trackedMatches` does (a list, or null when git cannot
 * answer) — the two use ONE bound, so the same fixture drives both.
 */
function trackedIn(files: string[]) {
  return (args: string[]): string[] | null => {
    if (args[0] !== "ls-files") return null;
    const patterns = args.slice(2);
    return files.filter((f) =>
      patterns.some((p) => (p.startsWith("*/") ? f.endsWith(p.slice(1)) : f === p)),
    );
  };
}

describe("buildTriageRecord shape validation", () => {
  it("REFUSES the schema envelope echoed back as an answer", () => {
    const raw = JSON.stringify({
      type: "object",
      properties: { title: "Dispatch children inherit repo .claude SKILLS", verdict: "actionable_now" },
    });
    expect(() => buildTriageRecord(ENTRY, raw)).toThrow(/did not match the triage schema/);
  });

  it("REFUSES a bare probe fragment carrying no verdict/why/action", () => {
    const raw = JSON.stringify({ symbol: "{repo_url, commit_sha, labels[]}", contains: "x" });
    expect(() => buildTriageRecord(ENTRY, raw)).toThrow(/did not match the triage schema/);
  });

  it("REFUSES a verdict outside the schema's enum", () => {
    const raw = JSON.stringify({ verdict: "looks_fine_to_me", why: "w", action: "a" });
    expect(() => buildTriageRecord(ENTRY, raw)).toThrow(/verdict="looks_fine_to_me"/);
  });

  it("never lets the model overwrite the sweep's identity fields", () => {
    const raw = JSON.stringify({
      id: "whatever",
      file: "src/shared/dispatch/admissionLoop.ts",
      verdict: "actionable_now",
      why: "because",
      action: "do the thing",
    });
    const rec = buildTriageRecord(ENTRY, raw);
    expect(rec.id).toBe(ENTRY.id);
    expect(rec.file).toBe(ENTRY.file);
  });

  it("still accepts a fully valid record, including one wrapped in prose", () => {
    const body = {
      title: "t",
      verdict: "already_shipped_or_stale",
      why: "the entry says shipped",
      action: "delete the entry",
      effort: "trivial",
      code_paths: [],
      premise_probes: [],
    };
    const rec = buildTriageRecord(ENTRY, `Here is my answer:\n${JSON.stringify(body)}`);
    expect(rec.verdict).toBe("already_shipped_or_stale");
    expect(rec.id).toBe(ENTRY.id);
  });

  it("keeps refusing a response with no JSON object at all", () => {
    expect(() => buildTriageRecord(ENTRY, "I could not classify this entry.")).toThrow(
      /no JSON object/,
    );
  });

  it("stays single-sourced on the schema's verdict enum", () => {
    // If the enum gains a value, the validator accepts it with no second edit.
    expect(TRIAGE_VERDICTS.has("actionable_now")).toBe(true);
    expect(TRIAGE_VERDICTS.size).toBe(5);
  });
});

describe("the Paths column is resolved against the tree, never invented", () => {
  /**
   * The duplicated-guard lap (2026-07-25). The sweep's per-entry `Paths:` are
   * MODEL-INVENTED for entries whose prose names no file — the friction walk
   * recorded three of them verbatim (`src/scheduler/populate.ts`,
   * `src/review/mapCache.ts`, `src/pinning-gate.ts`, none of which exist) and
   * drew the rule this implements: a generated triage emits a path only when it
   * resolves against the tree, and marks the rest `unresolved`. A path column
   * that reads like evidence but is a routing guess is worse than no column.
   */
  const TREE = ["src/audit/orchestrator/hostInputPause.ts", "scripts/shared/triage-backlog.mjs"];
  const tracked = trackedIn(TREE);

  it("resolves a full path the entry actually names", () => {
    expect(resolveCodePaths(["src/audit/orchestrator/hostInputPause.ts"], tracked)).toEqual({
      resolved: ["src/audit/orchestrator/hostInputPause.ts"],
      unresolved: [],
      recovered: [],
    });
  });

  it("marks a path that does not resolve `unresolved`, keeping what the model wrote", () => {
    // The verbatim live case: a fabricated directory for a real-looking module.
    const out = resolveCodePaths(["src/scheduler/populate.ts"], tracked);
    expect(out.resolved).toEqual([]);
    expect(out.unresolved).toEqual([{ written: "src/scheduler/populate.ts", reason: "not_tracked" }]);
  });

  it("an INVENTED directory on a bare basename is refused, not accepted as a path", () => {
    // The whole defect in one row: the model was given `triage-backlog.mjs` and
    // invented `scripts/triage/` for it. Refusing is what stops the column
    // reading as evidence.
    const out = resolveCodePaths(["scripts/triage/triage-backlog.mjs"], tracked);
    expect(out.resolved).toEqual([]);
    expect(out.unresolved[0].reason).toBe("not_tracked");
    // …while the bare basename the entry actually gave DOES resolve, and says so.
    expect(resolveCodePaths(["triage-backlog.mjs"], tracked)).toEqual({
      resolved: ["scripts/shared/triage-backlog.mjs"],
      unresolved: [],
      recovered: [
        { from: "triage-backlog.mjs", via: "basename", to: "scripts/shared/triage-backlog.mjs" },
      ],
    });
  });

  it("refuses to guess when a basename matches MORE than one tracked file", () => {
    const ambiguous = trackedIn(["src/a/dispatch.ts", "src/b/dispatch.ts"]);
    const out = resolveCodePaths(["dispatch.ts"], ambiguous);
    expect(out.resolved).toEqual([]);
    expect(out.recovered).toEqual([]);
    expect(out.unresolved).toEqual([{ written: "dispatch.ts", reason: "ambiguous" }]);
  });

  it("deduplicates, and drops empty or non-string entries rather than emitting them", () => {
    const out = resolveCodePaths(
      ["triage-backlog.mjs", "triage-backlog.mjs", "", null as unknown as string],
      tracked,
    );
    expect(out.resolved).toEqual(["scripts/shared/triage-backlog.mjs"]);
    expect(out.recovered).toHaveLength(1);
  });

  it("resolves a backslashed Windows path rather than calling it unresolvable", () => {
    // OS-agnostic: the model may echo a path the way the host spelled it.
    const out = resolveCodePaths(["src\\audit\\orchestrator\\hostInputPause.ts"], tracked);
    expect(out.resolved).toEqual(["src/audit/orchestrator/hostInputPause.ts"]);
  });

  it("survives a git that cannot answer — every path is unresolved, none is dropped", () => {
    const out = resolveCodePaths(["src/a.ts", "b.mjs"], () => null);
    expect(out.resolved).toEqual([]);
    expect(out.unresolved.map((u) => u.written)).toEqual(["src/a.ts", "b.mjs"]);
  });
});
