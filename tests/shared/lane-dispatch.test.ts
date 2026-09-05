// Contract tests for the shared one-item-per-call dispatch driver
// (scripts/shared/lane-dispatch.mjs, P28 wrapper half / nightly sol-3). The
// lane is FAKED with an in-process async fn — the same seam pattern as
// resolveTriageModel's rosterSource and profile.mjs's spawnImpl: no spawn, no
// network, every behavior reachable by injection.
//
// The coverage-stamp assertions pin a READ-VERBATIM contract:
// docs/nightly-routine.md consumes `<out>-coverage.json` by exact field name
// (model/attempted/classified/errored/aborted, plus the cumulative
// classified_total family). Renaming a persisted field is not a rename.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  coverageStampPath,
  dispatchBoundedItems,
  LanePreflightError,
} from "../../scripts/shared/lane-dispatch.mjs";

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "lane-dispatch-"));
  dirs.push(d);
  return d;
}

function readRows(out: string): any[] {
  return readFileSync(out, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l));
}

describe("dispatchBoundedItems", () => {
  it("makes exactly one lane call per item, each carrying that single item", async () => {
    const out = join(tmp(), "t.jsonl");
    const seen: string[] = [];
    const { stamp, records } = await dispatchBoundedItems({
      items: [{ id: "a" }, { id: "b" }, { id: "c" }],
      outPath: out,
      callLane: async (item: any) => {
        seen.push(item.id);
        return { raw: "{}", finishReason: "stop" };
      },
      buildRecord: (item: any) => ({ id: item.id, ok: true }),
    });
    expect([...seen].sort()).toEqual(["a", "b", "c"]);
    expect(records).toHaveLength(3);
    expect(stamp.attempted).toBe(3);
    expect(stamp.classified).toBe(3);
    expect(stamp.errored).toBe(0);
    const rows = readRows(out);
    expect(rows.map((r) => r.id).sort()).toEqual(["a", "b", "c"]);
  });

  it("resume: drops errored rows from the file, re-queues exactly those items, skips completed ids", async () => {
    const out = join(tmp(), "t.jsonl");
    writeFileSync(
      out,
      [
        JSON.stringify({ id: "a", verdict: "x" }),
        JSON.stringify({ id: "b", verdict: "y" }),
        JSON.stringify({ id: "c", error: "boom" }),
      ].join("\n") + "\n",
    );
    const called: string[] = [];
    const { stamp } = await dispatchBoundedItems({
      items: [{ id: "a" }, { id: "b" }, { id: "c" }],
      outPath: out,
      concurrency: 1,
      callLane: async (item: any) => {
        called.push(item.id);
        return { raw: "", finishReason: "stop" };
      },
      buildRecord: (item: any) => ({ id: item.id, retried: true }),
    });
    // An id in `done` means a verdict exists, never that an attempt happened —
    // the errored item is the ONLY one retried (the old add-errored-too
    // behaviour retried nothing and exited 0: a false green).
    expect(called).toEqual(["c"]);
    const rows = readRows(out);
    expect(rows.map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(rows[2].retried).toBe(true);
    expect(rows.some((r) => r.error)).toBe(false);
    expect(stamp.prior_classified).toBe(2);
    expect(stamp.attempted).toBe(1);
    expect(stamp.classified).toBe(1);
    expect(stamp.classified_total).toBe(3);
    expect(stamp.total_entries).toBe(3);
  });

  it("applies reviveRecord to kept rows on load and rewrites the file with the revived shape", async () => {
    const out = join(tmp(), "t.jsonl");
    writeFileSync(
      out,
      [
        JSON.stringify({ id: "a", verdict: "x", premise: "holds" }),
        JSON.stringify({ id: "b", verdict: "y" }),
      ].join("\n") + "\n",
    );
    const { stamp } = await dispatchBoundedItems({
      items: [{ id: "a" }, { id: "b" }],
      outPath: out,
      reviveRecord: (rec: any) => ({ ...rec, premise: "premise_unconfirmed" }),
      callLane: async () => {
        throw new Error("nothing to dispatch — every item already has a verdict");
      },
      buildRecord: () => ({}),
    });
    expect(stamp.attempted).toBe(0);
    const rows = readRows(out);
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r.premise).toBe("premise_unconfirmed");
  });

  it("preflight failure: aborted stamp written, typed error thrown, lane never invoked", async () => {
    const out = join(tmp(), "t.jsonl");
    let laneCalls = 0;
    const run = dispatchBoundedItems({
      items: [{ id: "a" }],
      outPath: out,
      stampSeed: { model: "m1" },
      preflight: async () => {
        throw new Error("HTTP 500 : router dead");
      },
      callLane: async () => {
        laneCalls += 1;
        return { raw: "" };
      },
      buildRecord: (item: any) => ({ id: item.id }),
    });
    await expect(run).rejects.toBeInstanceOf(LanePreflightError);
    expect(laneCalls).toBe(0);
    const stamp = JSON.parse(readFileSync(coverageStampPath(out), "utf8"));
    expect(stamp.aborted).toBe("preflight failed: HTTP 500 : router dead");
    expect(stamp.model).toBe("m1");
    expect(stamp.attempted).toBe(0);
    expect(stamp.finished_at).toBeNull();
    // Nothing was appended: the lane is DEAD, not slow.
    expect(existsSync(out)).toBe(false);
  });

  it("a throwing lane lands an error row (item file echoed) and the sweep continues", async () => {
    const out = join(tmp(), "t.jsonl");
    const { stamp } = await dispatchBoundedItems({
      items: [
        { id: "a", file: "open-bugs.md" },
        { id: "b", file: "deferred.md" },
      ],
      outPath: out,
      concurrency: 1,
      callLane: async (item: any) => {
        if (item.id === "a") throw new Error("ECONNRESET");
        return { raw: "x", finishReason: "stop" };
      },
      buildRecord: (item: any) => ({ id: item.id, file: item.file, ok: true }),
    });
    const rows = readRows(out);
    expect(rows[0]).toEqual({ id: "a", file: "open-bugs.md", error: "ECONNRESET" });
    expect(rows[1].ok).toBe(true);
    expect(stamp.attempted).toBe(2);
    expect(stamp.errored).toBe(1);
    expect(stamp.classified).toBe(1);
  });

  it("records finish_reason and output_bytes on success AND on a buildRecord-rejected row", async () => {
    const out = join(tmp(), "t.jsonl");
    await dispatchBoundedItems({
      items: [{ id: "a" }, { id: "b" }],
      outPath: out,
      concurrency: 1,
      callLane: async (item: any) =>
        item.id === "a"
          ? { raw: '{"v":1}', finishReason: "stop" }
          : { raw: "x".repeat(4000), finishReason: "length" },
      buildRecord: (item: any, laneResult: any) => {
        // The caller-side policy (OpenAI-chat semantics, never the driver's):
        // a non-stop finish is an error row — which must still carry the
        // driver's finish_reason/output_bytes diagnostic.
        if (laneResult.finishReason !== "stop") {
          throw new Error(`finish_reason=${laneResult.finishReason}`);
        }
        return { id: item.id, v: JSON.parse(laneResult.raw).v };
      },
    });
    const rows = readRows(out);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get("a")).toMatchObject({ v: 1, finish_reason: "stop", output_bytes: 7 });
    // Large-but-truncated: the size is the "cap to raise" signal (P28) — a
    // near-zero output_bytes here would instead read as dialect death.
    expect(byId.get("b")).toMatchObject({
      error: "finish_reason=length",
      finish_reason: "length",
      output_bytes: 4000,
    });
  });

  it("omits finish_reason/output_bytes when the lane itself threw (no output existed)", async () => {
    const out = join(tmp(), "t.jsonl");
    await dispatchBoundedItems({
      items: [{ id: "a" }],
      outPath: out,
      callLane: async () => {
        throw new Error("timeout");
      },
      buildRecord: (item: any) => ({ id: item.id }),
    });
    const [row] = readRows(out);
    expect(row.error).toBe("timeout");
    expect("finish_reason" in row).toBe(false);
    expect("output_bytes" in row).toBe(false);
  });

  it("redirects the raw lane output to the per-item log BEFORE buildRecord runs", async () => {
    const dir = tmp();
    const out = join(dir, "t.jsonl");
    const raw = "PROSE the lane prepended despite the schema, then no JSON at all";
    await dispatchBoundedItems({
      items: [{ id: "a" }],
      outPath: out,
      itemLogPath: (item: any) => join(dir, `${item.id}.log`),
      callLane: async () => ({ raw, finishReason: "stop" }),
      buildRecord: () => {
        throw new Error("no JSON object in response");
      },
    });
    // buildRecord rejected the item, but the evidence is already on disk.
    expect(readFileSync(join(dir, "a.log"), "utf8")).toBe(raw);
    const [row] = readRows(out);
    expect(row.error).toBe("no JSON object in response");
  });

  it("rewrites the stamp per completion and accumulates caller counters via stampExtra", async () => {
    const out = join(tmp(), "t.jsonl");
    const stampPath = coverageStampPath(out);
    const midFlight: any[] = [];
    const { stamp } = await dispatchBoundedItems({
      items: [{ id: "a" }, { id: "b" }],
      outPath: out,
      concurrency: 1,
      stampInit: { probes_unusable: 0 },
      stampExtra: (s: any, rec: any) => {
        if (rec.flagged) s.probes_unusable += 1;
      },
      callLane: async () => ({ raw: "", finishReason: "stop" }),
      buildRecord: (item: any) => ({ id: item.id, flagged: item.id === "b" }),
      onProgress: () => {
        // Fires after the per-completion stamp rewrite: a killed run leaves an
        // honest partial stamp, not silence.
        midFlight.push(JSON.parse(readFileSync(stampPath, "utf8")));
      },
    });
    expect(midFlight[0].attempted).toBe(1);
    expect(midFlight[0].finished_at).toBeNull();
    expect(stamp.finished_at).toEqual(expect.any(String));
    expect(stamp.probes_unusable).toBe(1);
    expect(JSON.parse(readFileSync(stampPath, "utf8"))).toEqual(stamp);
  });

  it("an unwritable stamp path warns once and never kills the sweep", async () => {
    const out = join(tmp(), "t.jsonl");
    // A DIRECTORY where the stamp file wants to be: every write fails, on
    // every platform.
    mkdirSync(coverageStampPath(out));
    const writes: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: any) => {
      writes.push(String(chunk));
      return true;
    }) as any);
    const { stamp, records } = await dispatchBoundedItems({
      items: [{ id: "a" }, { id: "b" }],
      outPath: out,
      concurrency: 1,
      callLane: async () => ({ raw: "", finishReason: "stop" }),
      buildRecord: (item: any) => ({ id: item.id }),
    });
    expect(records).toHaveLength(2);
    expect(readRows(out)).toHaveLength(2);
    expect(stamp.classified).toBe(2);
    const warns = writes.filter((w) => w.includes("coverage stamp not writable"));
    expect(warns).toHaveLength(1);
  });
});
