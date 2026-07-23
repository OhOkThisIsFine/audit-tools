import { test, expect } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, readFile } from "node:fs/promises";

const { createDispatchDecisionLog } = await import(
  "../../src/shared/dispatch/dispatchDecisionLog.ts"
);

test("decision-log sink appends one valid JSON line per record, creating the dir", async () => {
  const dir = await mkdtemp(join(tmpdir(), "decision-log-"));
  const path = join(dir, "runs", "R1", "dispatch-explains.jsonl");
  const sink = createDispatchDecisionLog(path);

  sink({ ts: "2026-07-23T00:00:00Z", seq: 0, kind: "engine_admitted", packet_id: "p1", pool_id: "a", lease_id: null, cost: 5, constraints: [], binding: null, forced: false });
  sink({ ts: "2026-07-23T00:00:01Z", seq: 1, kind: "engine_stranded_packet_too_large_all_pools", packet_id: "p2", skipped_pool_ids: ["a"] });

  const lines = (await readFile(path, "utf8")).trim().split("\n");
  expect(lines.length).toBe(2);
  const parsed = lines.map((l) => JSON.parse(l));
  expect(parsed[0]).toEqual(expect.objectContaining({ kind: "engine_admitted", packet_id: "p1", seq: 0 }));
  expect(parsed[1]).toEqual(expect.objectContaining({ kind: "engine_stranded_packet_too_large_all_pools", packet_id: "p2", seq: 1 }));
  // The SINK stamps the file-authoritative order: several sub-wave dispatchers
  // (each with seq restarting at 0) append through one sink, so engine seq is
  // not file-authoritative — file_seq is.
  expect(parsed.map((p) => p.file_seq)).toEqual([0, 1]);
});

test("decision-log sink degrades loudly on an unwritable path — never throws, records fall back to stderr", async () => {
  // A path whose PARENT is a file: mkdir/append must fail on every OS.
  const dir = await mkdtemp(join(tmpdir(), "decision-log-"));
  const blockerFile = join(dir, "blocker");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(blockerFile, "not a dir", "utf8");
  const sink = createDispatchDecisionLog(join(blockerFile, "sub", "x.jsonl"));

  const stderrLines = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => {
    stderrLines.push(String(chunk));
    return true;
  };
  try {
    // Must not throw — dispatch never aborts on observability failure.
    sink({ ts: "t", seq: 0, kind: "engine_admitted", packet_id: "p1", pool_id: "a", lease_id: null, cost: 1, constraints: [], binding: null, forced: false });
    sink({ ts: "t", seq: 1, kind: "engine_admitted", packet_id: "p2", pool_id: "a", lease_id: null, cost: 1, constraints: [], binding: null, forced: false });
  } finally {
    process.stderr.write = origWrite;
  }
  // One loud degrade warning, then every record still lands on stderr.
  expect(stderrLines.filter((l) => l.includes("[dispatch-decision-log]")).length).toBe(1);
  expect(stderrLines.filter((l) => l.includes('"packet_id":"p1"')).length).toBe(1);
  expect(stderrLines.filter((l) => l.includes('"packet_id":"p2"')).length).toBe(1);
});
