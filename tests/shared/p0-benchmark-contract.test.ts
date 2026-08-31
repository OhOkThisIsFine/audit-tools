import { expect, test } from "vitest";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

const root = resolve(process.cwd());
const json = (path: string) => JSON.parse(readFileSync(resolve(root, path), "utf8"));

test("P0 opportunity corpus has exactly O-01 through O-24 with required fields", () => {
  const payload = json("benchmarks/p0/corpus/primary-opportunities.json");
  const rows = payload.opportunities as Array<Record<string, unknown>>;
  expect(Array.isArray(rows)).toBe(true);
  expect(rows).toHaveLength(24);
  expect(rows.map((row) => row.id).sort()).toEqual(Array.from({ length: 24 }, (_, i) => `O-${String(i + 1).padStart(2, "0")}`));
  for (const row of rows) {
    expect(Object.keys(row).sort()).toEqual(["anchor", "id", "mechanism", "title"]);
    for (const field of ["anchor", "id", "mechanism", "title"]) {
      expect(row[field]).toEqual(expect.any(String));
      expect((row[field] as string).trim()).not.toBe("");
    }
  }
});

test("P0 score schema and held-out labels use exact contract", () => {
  const schema = json("benchmarks/p0/score-schema.json");
  expect(schema.outcomes).toEqual({ recovered: 1, validly_subsumed: 1, partial: 0.5, evidence_refuted: 1, missed: 0 });
  expect(schema.axes).toEqual(["structural_recall", "philosophy_telos_recall", "grounding_precision", "telos_to_code_linkage", "reduction_value", "false_positive_discipline"]);
  const labels = json("benchmarks/p0/corpus/held-out/labels.json");
  const corpus = resolve(root, "benchmarks/p0/held-out-corpus");
  expect(statSync(corpus).isDirectory()).toBe(true);
  expect(labels).toEqual([
    { path: "src/duplicate.js", class: "duplicated_machinery" },
    { path: "src/state.js", class: "duplicated_advancement_state_ownership" },
    { path: "docs/goals.md", class: "goal_conflict" },
    { path: "src/lifecycle.js", class: "disproportionate_lifecycle_ceremony" },
    { path: "src/bounded-context.js", class: "intentional_bounded_context_duplication" },
    { path: "src/safety-gate.js", class: "safety_gate_removal_increases_risk" },
  ]);
  for (const label of labels) {
    const path = resolve(corpus, label.path);
    const relativePath = relative(corpus, path);
    expect(isAbsolute(relativePath) || relativePath === ".." || relativePath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)).toBe(false);
    expect(statSync(path).isFile()).toBe(true);
  }
});
