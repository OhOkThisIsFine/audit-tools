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

import { buildTriageRecord, TRIAGE_VERDICTS } from "../../scripts/shared/triage-backlog.mjs";

const ENTRY = { id: "open-bugs#c5ba56ab", file: "open-bugs.md" };

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
