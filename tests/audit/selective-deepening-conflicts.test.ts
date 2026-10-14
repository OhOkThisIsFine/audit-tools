import { describe, expect, test } from "vitest";
import type { AuditResult, AuditTask, Finding } from "../../src/audit/types.js";
import { buildSelectiveDeepeningTasks } from "../../src/audit/orchestrator/selectiveDeepening/index.js";
import { taskIdFor, type FindingContext } from "../../src/audit/orchestrator/selectiveDeepening/shared.js";

import { coalescedConflictGroups } from "../../src/audit/orchestrator/selectiveDeepening/conflict.js";

const paths = ["src/a.ts", "src/b.ts", "src/c.ts"];
function result(id: string, severity: Finding["severity"] = "info", scope = paths): AuditResult {
  return {
    task_id: id, unit_id: `unit-${id}`, pass_id: `pass-${id}`, lens: "correctness",
    file_coverage: scope.map(path => ({ path, total_lines: 40 })),
    findings: [{ id: `finding-${id}`, title: "Invariant", category: "invariant", lens: "correctness",
      severity, confidence: "high", summary: "Check invariant", affected_files: scope.map(path => ({ path })), evidence: ["Observed invariant"] }],
  };
}
function conflicts(results: AuditResult[], existingTasks: AuditTask[] = [], lineIndex?: Record<string, number>) {
  return buildSelectiveDeepeningTasks({ results, existingTasks, lineIndex }).filter(task => task.tags?.includes("trigger:conflicting_output"));
}
const pair = () => [result("a", "medium"), result("b")];

test("three identical qualified memberships become one complete legacy-compatible conflict", () => {
  const tasks = conflicts(pair());
  expect(tasks).toHaveLength(1);
  expect(tasks[0]!.task_id).toBe(taskIdFor("conflict", ["correctness:invariant:src/a.ts", "a", "b", "finding-a", "finding-b"]));
  expect(tasks[0]!.file_paths).toEqual(paths);
  for (const path of paths) expect(tasks[0]!.rationale).toContain(`correctness:invariant:${path}`);
});

test("whole task is stable across result, finding, coverage, scope, and object-key order", () => {
  const results = pair();
  for (const item of results) item.findings.push({ ...item.findings[0]!, id: `extra-${item.task_id}` });
  const reversed = structuredClone(results).reverse();
  for (const item of reversed) {
    item.file_coverage.reverse();
    item.findings.reverse();
    item.findings = item.findings.map(finding => Object.fromEntries(Object.entries(finding).reverse()) as Finding);
  }
  expect(conflicts(reversed)).toEqual(conflicts(results));
});

test("equal-primary different-coverage representatives are stable and ordered lexicographically", () => {
  const [first, second] = pair();
  const duplicate = structuredClone(first!);
  duplicate.file_coverage = paths.map(path => ({ path, total_lines: 9 }));
  first!.file_coverage = paths.map(path => ({ path, total_lines: 100 }));
  const expected = conflicts([first!, duplicate, second!]);
  expect(conflicts([second!, duplicate, first!])).toEqual(expected);
  expect(expected[0]!.file_line_counts).toEqual(Object.fromEntries(paths.map(path => [path, 100])));
});

test("duplicate members, reordered object keys, and duplicate coverage buckets do not change output", () => {
  const originals = pair();
  const duplicate = structuredClone(originals[0]!);
  duplicate.findings = duplicate.findings.map(finding => Object.fromEntries(Object.entries(finding).reverse()) as Finding);
  duplicate.file_coverage.push({ path: paths[0]!, total_lines: 999 });
  expect(conflicts([...originals, duplicate])).toEqual(conflicts(originals));
});

test("all source tags and raw unsanitized source references survive with no cap", () => {
  const results = Array.from({ length: 30 }, (_, i) => result(`review/${i}`, i === 0 ? "medium" : "info"));
  const [task] = conflicts(results);
  expect(task!.tags!.filter(tag => tag.startsWith("source_task:"))).toHaveLength(30);
  for (const item of results) expect(task!.rationale).toContain(item.task_id);
  expect(task!.file_paths).toEqual(paths);
});

test("overlapping and subset memberships remain separate", () => {
  const results = [...pair(), result("c", "info", [paths[1]!, paths[2]!]), result("d", "info", [paths[2]!])];
  expect(conflicts(results)).toHaveLength(3);
});

test("existing canonical ID suppresses generation, noncanonical ID does not, and inputs stay unchanged", () => {
  const [fresh] = conflicts(pair());
  const canonical = { ...fresh!, rationale: "Original persisted rationale", unit_id: "original-unit" };
  const other = { ...canonical, task_id: taskIdFor("conflict", ["correctness:invariant:src/b.ts", "a", "b", "finding-a", "finding-b"]) };
  const before = structuredClone([canonical, other]);
  expect(conflicts(pair(), [canonical])).toEqual([]);
  expect(conflicts(pair(), [other])).toEqual([fresh]);
  expect(conflicts(pair(), [canonical, other])).toEqual([]);
  expect([canonical, other]).toEqual(before);
});

test("repeated generation converges and deepening results never recursively conflict", () => {
  const tasks = buildSelectiveDeepeningTasks({ results: pair() });
  expect(conflicts(pair(), tasks)).toEqual([]);
  const recursive = tasks.map(task => ({ ...result(task.task_id, "medium"), unit_id: task.unit_id, pass_id: task.pass_id }));
  expect(conflicts(recursive, tasks)).toEqual([]);
  const changedTask = pair(); changedTask[0]!.task_id = "changed";
  expect(conflicts(changedTask, tasks)).toHaveLength(1);
  const changedFinding = pair(); changedFinding[0]!.findings[0]!.id = "changed";
  expect(conflicts(changedFinding, tasks)).toHaveLength(1);
});

describe("single-file qualification is unchanged", () => {
  test("one task cannot qualify even with conflicting findings", () => {
    const one = result("a", "critical", [paths[0]!]);
    one.findings.push({ ...one.findings[0]!, id: "other", severity: "info" });
    expect(conflicts([one])).toEqual([]);
  });
  test.each([
    ["low", "high", "high", 0],
    ["medium", "high", "high", 1],
    ["info", "low", "high", 1],
    ["info", "medium", "high", 0],
  ] as const)("severity %s and confidence %s/%s yield %i conflicts", (severity, aConfidence, bConfidence, count) => {
    const a = result("a", severity, [paths[0]!]);
    const b = result("b", "info", [paths[0]!]);
    a.findings[0]!.confidence = aConfidence;
    b.findings[0]!.confidence = bConfidence;
    expect(conflicts([a, b])).toHaveLength(count);
  });
});

test("line counts keep task, first result coverage, index, then zero precedence", () => {
  const results = pair();
  const task: AuditTask = { task_id: "a", unit_id: "unit-a", pass_id: "pass-a", lens: "correctness",
    file_paths: paths, file_line_counts: { [paths[0]!]: 0 }, rationale: "original", status: "complete" };
  results[0]!.file_coverage = [{ path: paths[0]!, total_lines: 90 }, { path: paths[1]!, total_lines: 7 }, { path: paths[1]!, total_lines: 9 }];
  expect(conflicts(results, [task], { [paths[0]!]: 500, [paths[1]!]: 500, [paths[2]!]: 500 })[0]!.file_line_counts)
    .toEqual({ [paths[0]!]: 0, [paths[1]!]: 7, [paths[2]!]: 500 });
  expect(conflicts(results, [task])[0]!.file_line_counts![paths[2]!]).toBe(0);
  // The later b member has a result count, but must not override a's fallback.
  delete task.file_line_counts;
  const missingCoverage = structuredClone(results);
  missingCoverage[0]!.file_coverage = [];
  expect(conflicts(missingCoverage, [task], { [paths[0]!]: 500 })[0]!.file_line_counts![paths[0]!]).toBe(500);
});

function contexts(): FindingContext[] {
  return pair().map(result => ({ result, finding: result.findings[0]!, paths: [...paths] }));
}

test("raw path spelling survives lowercased bucket keys and path order is canonical", () => {
  const members = contexts();
  for (const member of members) member.paths = ["src/Z.ts", "src/A.ts", "src/Z.ts"];
  const forward = coalescedConflictGroups(members);
  const reversed = coalescedConflictGroups(members.map(member => ({ ...member, paths: [...member.paths].reverse() })).reverse());
  expect(forward.map(group => group.conflictKeys)).toEqual([["correctness:invariant:src/a.ts", "correctness:invariant:src/z.ts"]]);
  expect(reversed.map(group => group.conflictKeys)).toEqual(forward.map(group => group.conflictKeys));
  expect(forward[0]!.contexts).toHaveLength(2);
});

test.each([
  ["task", (c: FindingContext) => { c.result.task_id += "-changed"; }],
  ["unit", (c: FindingContext) => { c.result.unit_id += "-changed"; }],
  ["pass", (c: FindingContext) => { c.result.pass_id += "-changed"; }],
  ["lens", (c: FindingContext) => { c.result.lens = "security"; }],
  ["role", (c: FindingContext) => { c.result.agent_role = "lens_verifier"; }],
  ["finding id", (c: FindingContext) => { c.finding.id += "-changed"; }],
  ["category", (c: FindingContext) => { c.finding.category += "-changed"; }],
  ["content", (c: FindingContext) => { c.finding.summary += " changed"; }],
  ["array content order", (c: FindingContext) => { c.finding.affected_files.reverse(); }],
  ["raw scope", (c: FindingContext) => { c.paths[0] = "src/A.ts"; }],
] as const)("member identity retains %s", (_name, mutate) => {
  const original = contexts();
  const changed = structuredClone(original[0]!);
  mutate(changed);
  // Lens/category change puts the additional member in an unqualified bucket;
  // all other changes retain a distinct third member in the qualifying group.
  const groups = coalescedConflictGroups([...original, changed]);
  const group = groups.find(group => group.conflictKeys.includes("correctness:invariant:src/b.ts"))!;
  expect(group.contexts).toHaveLength(_name === "lens" || _name === "category" ? 2 : 3);
});

test("same identity and content with unequal member scope creates different memberships", () => {
  const original = contexts();
  const changed = structuredClone(original[0]!);
  changed.paths = [paths[0]!];
  const groups = coalescedConflictGroups([...original, changed]);
  expect(groups).toHaveLength(2);
  expect(groups.map(group => group.contexts.length)).toEqual([3, 2]);
});
