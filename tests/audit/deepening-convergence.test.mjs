import { test, describe, it, expect } from "vitest";
import { join } from "node:path";

const { validateAuditResults, defaultFindingLensFromResult } = await import(
  "../../src/audit/validation/auditResults.ts"
);
const { validateAndCollectResults, packetMembersByPacketId } = await import(
  "../../src/audit/cli/mergeAndIngestCommand.ts"
);

// A deepening:* member task (single file). The worker is meant to copy this
// exact task_id into its result; the convergence bug was the result carrying the
// synthetic packet_id instead, plus omitting the per-finding lens.
function deepeningTask(id, lens = "security") {
  return {
    task_id: id,
    unit_id: "flow:auth:security",
    pass_id: `deepening:${id}`,
    lens,
    rationale: "deepen a high-severity finding",
    file_paths: ["src/auth.ts"],
    file_line_counts: { "src/auth.ts": 10 },
  };
}

function findingWithoutLens() {
  return {
    id: "SEC-001",
    title: "Missing auth check",
    category: "missing-validation",
    severity: "high",
    confidence: "high",
    // lens deliberately omitted — weaker/deepening workers set only AuditResult.lens.
    summary: "No auth check on the handler.",
    affected_files: [{ path: "src/auth.ts", line_start: 1, line_end: 2 }],
    evidence: ["src/auth.ts:1 - handler has no auth guard"],
  };
}

function resultFor(taskId, { lens = "security", findings } = {}) {
  return {
    task_id: taskId,
    unit_id: "flow:auth:security",
    pass_id: `deepening:${taskId}`,
    lens,
    file_coverage: [{ path: "src/auth.ts", total_lines: 10 }],
    findings: findings ?? [findingWithoutLens()],
  };
}

test("defaultFindingLensFromResult — backfills omitted finding lens from AuditResult.lens", () => {
  const payload = [resultFor("deepening:finding:e0e34e19f3", { lens: "reliability" })];
  defaultFindingLensFromResult(payload);
  expect(payload[0].findings[0].lens).toBe("reliability");
});

describe("defaultFindingLensFromResult — never overwrites an explicit finding lens (mismatch still surfaced)", () => {
  it("explicit lens preserved", () => {
    const finding = { ...findingWithoutLens(), lens: "performance" };
    const payload = [resultFor("t1", { lens: "security", findings: [finding] })];
    defaultFindingLensFromResult(payload);
    expect(payload[0].findings[0].lens).toBe("performance");
  });

  it("a genuine explicit-vs-result lens mismatch is still a validation error", () => {
    const task = deepeningTask("t1", "security");
    const finding = { ...findingWithoutLens(), lens: "performance" };
    const payload = [resultFor("t1", { lens: "security", findings: [finding] })];
    defaultFindingLensFromResult(payload);
    const issues = validateAuditResults(payload, [task], {
      lineIndex: { "src/auth.ts": 10 },
    });
    expect(issues.some(
        (i) => i.severity === "error" && /findings\[0\]\.lens must match/.test(i.message),
      ), "mismatched explicit finding lens must still error").toBeTruthy();
  });
});

describe("missing findings[].lens sub-bug — red without the default, green with it", () => {
  const task = deepeningTask("deepening:finding:e0e34e19f3", "security");
  const lineIndex = { "src/auth.ts": 10 };

  it("RED: validator rejects a finding that omits lens", () => {
    const payload = [resultFor(task.task_id, { lens: "security" })];
    const issues = validateAuditResults(payload, [task], { lineIndex });
    expect(issues.some(
        (i) => i.severity === "error" && /findings\[0\]\.lens/.test(i.field ?? i.message),
      ), "a finding with no lens must be rejected before the fix").toBeTruthy();
  });

  it("GREEN: force-defaulting the lens first clears every error", () => {
    const payload = [resultFor(task.task_id, { lens: "security" })];
    defaultFindingLensFromResult(payload);
    const issues = validateAuditResults(payload, [task], { lineIndex });
    const errors = issues.filter((i) => i.severity === "error");
    expect(errors, `expected no errors, got: ${errors.map((e) => e.message).join("; ")}`).toEqual([]);
    expect(payload[0].findings[0].lens).toBe("security");
  });
});

test("packetMembersByPacketId — groups member task_ids per packet, drops the prior-dispatch sentinel", () => {
  const entries = [
    { packet_id: "P1", task_id: "deepening:finding:a" },
    { packet_id: "P1", task_id: "deepening:finding:b" },
    { packet_id: "__prior_dispatch__", task_id: "old" },
    { packet_id: "P2", task_id: "deepening:steward:c" },
  ];
  const map = packetMembersByPacketId(entries);
  expect(map.get("P1")).toEqual(["deepening:finding:a", "deepening:finding:b"]);
  expect(map.get("P2")).toEqual(["deepening:steward:c"]);
  expect(map.has("__prior_dispatch__")).toBe(false);
});

test("packet-id leak sub-bug — result keyed under packet_id rebinds to the sole outstanding member", async () => {
  const member = deepeningTask("deepening:finding:e0e34e19f3", "security");
  const packetId = "flow:auth:security:packet-3-abc1234567";
  // The worker keyed its single result under the synthetic packet_id, not the
  // assigned member id (the leak). No file at the member's result_path.
  const leaked = resultFor(packetId, { lens: "security" });

  const entryByTaskId = new Map([
    [member.task_id, { task_id: member.task_id, packet_id: packetId, result_path: join("/nonexistent", "missing.json") }],
  ]);
  const fallbackByTaskId = new Map([[packetId, leaked]]);
  const packetMembers = packetMembersByPacketId([
    { packet_id: packetId, task_id: member.task_id },
  ]);

  const { passing, failing, recoveredCount } = await validateAndCollectResults(
    [member],
    entryByTaskId,
    fallbackByTaskId,
    packetMembers,
  );

  expect(failing.length, `expected no failures, got: ${JSON.stringify(failing)}`).toBe(0);
  expect(passing.length).toBe(1);
  expect(recoveredCount).toBe(1);
  // Rebound onto the member id, lens backfilled — ready to ingest, loop broken.
  expect(passing[0].task_id).toBe(member.task_id);
  expect(passing[0].findings[0].lens).toBe("security");
});

test("multi-member fan-out — a partially-answered packet completes its remaining member without re-running the done one", async () => {
  // Packet originally had two members; member-a was answered + ingested in a
  // prior round, so only member-b is OUTSTANDING (in allTasks) this round. The
  // worker re-emitted the whole-packet array under the packet_id.
  const memberA = "deepening:finding:aaa";
  const memberB = deepeningTask("deepening:finding:bbb", "security");
  const packetId = "flow:auth:security:packet-1-deadbeef99";

  // Only member-b is still pending (outstanding).
  const allTasks = [memberB];

  const entryByTaskId = new Map([
    [memberB.task_id, { task_id: memberB.task_id, packet_id: packetId, result_path: join("/nonexistent", "b.json") }],
  ]);
  // The whole-packet array landed keyed under the packet_id.
  const fallbackByTaskId = new Map([[packetId, resultFor(packetId, { lens: "security" })]]);
  // Full packet membership (both members) — the function intersects with allTasks
  // to find the single OUTSTANDING member.
  const packetMembers = packetMembersByPacketId([
    { packet_id: packetId, task_id: memberA },
    { packet_id: packetId, task_id: memberB.task_id },
  ]);

  const { passing, failing } = await validateAndCollectResults(
    allTasks,
    entryByTaskId,
    fallbackByTaskId,
    packetMembers,
  );

  expect(failing.length, `expected no failures, got: ${JSON.stringify(failing)}`).toBe(0);
  expect(passing.length).toBe(1);
  expect(passing[0].task_id, "rebound onto the outstanding member, not the completed one").toBe(memberB.task_id);
});

test("ambiguity guard — packet with >1 outstanding member does NOT rebind (no false completion)", async () => {
  const memberA = deepeningTask("deepening:finding:aaa", "security");
  const memberB = deepeningTask("deepening:finding:bbb", "security");
  const packetId = "flow:auth:security:packet-2-cafebabe11";

  const entryByTaskId = new Map([
    [memberA.task_id, { task_id: memberA.task_id, packet_id: packetId, result_path: join("/nonexistent", "a.json") }],
    [memberB.task_id, { task_id: memberB.task_id, packet_id: packetId, result_path: join("/nonexistent", "b.json") }],
  ]);
  const fallbackByTaskId = new Map([[packetId, resultFor(packetId, { lens: "security" })]]);
  const packetMembers = packetMembersByPacketId([
    { packet_id: packetId, task_id: memberA.task_id },
    { packet_id: packetId, task_id: memberB.task_id },
  ]);

  const { passing, failing } = await validateAndCollectResults(
    [memberA, memberB],
    entryByTaskId,
    fallbackByTaskId,
    packetMembers,
  );

  // Both members stay missing (no result file): a >1-outstanding packet is never
  // rebound, so neither is falsely completed.
  expect(passing.length).toBe(0);
  expect(failing.length).toBe(2);
});
