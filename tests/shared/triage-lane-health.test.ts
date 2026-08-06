// P11 (nightly sol-4, owner decision 2026-08-06): the leg-2 triage lane's
// health contract. The model target is resolved LIVE from llm-relay (a
// hardcoded pool name is a hand-held copy of the relay's config and died twice
// at relay v0.15.4); an unresolvable lane aborts naming the TRIAGE_MODEL
// escape; coverage is a recorded stamp, not a wc -l. These tests cover the
// exported resolution + stamp helpers; importing the module must not start a
// sweep (the run is guarded behind direct invocation).
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  resolveTriageModel,
  coverageStampPath,
  writeCoverageStamp,
} from "../../scripts/shared/triage-backlog.mjs";

describe("resolveTriageModel", () => {
  it("uses an explicit TRIAGE_MODEL verbatim, never touching discovery", () => {
    const model = resolveTriageModel({ TRIAGE_MODEL: "nim/z-ai/glm-5.2" }, () => {
      throw new Error("discovery must not run when the operator pinned a spec");
    });
    expect(model).toBe("nim/z-ai/glm-5.2");
  });

  it("discovers the live roster and prefers the medium tier", () => {
    const model = resolveTriageModel(
      {},
      () => JSON.stringify({ low: {}, medium: {}, high: {}, xhigh: {} }),
    );
    expect(model).toBe("pool/medium");
  });

  it("falls through the preference order when the preferred tiers are absent", () => {
    expect(resolveTriageModel({}, () => JSON.stringify({ xhigh: {}, high: {} }))).toBe("pool/high");
    expect(resolveTriageModel({}, () => JSON.stringify({ bespoke: {} }))).toBe("pool/bespoke");
  });

  it("aborts loudly when discovery fails, naming the escape", () => {
    expect(() =>
      resolveTriageModel({}, () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:8791");
      }),
    ).toThrow(/DEAD, not slow.*TRIAGE_MODEL=/s);
  });

  it("aborts loudly on an unparseable or empty roster", () => {
    expect(() => resolveTriageModel({}, () => "not json")).toThrow(/TRIAGE_MODEL=/);
    expect(() => resolveTriageModel({}, () => "{}")).toThrow(/no configured pools/);
  });
});

describe("coverage stamp", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("derives the sidecar path from the JSONL path", () => {
    expect(coverageStampPath("C:/x/backlog-triage.jsonl").endsWith("backlog-triage-coverage.json")).toBe(true);
  });

  it("round-trips the stamp shape the routine reads", () => {
    const dir = mkdtempSync(join(tmpdir(), "triage-stamp-"));
    dirs.push(dir);
    const path = coverageStampPath(join(dir, "t.jsonl"));
    const stamp = {
      model: "pool/medium",
      started_at: "2026-08-06T00:00:00.000Z",
      finished_at: null,
      aborted: "preflight failed: HTTP 400",
      total_entries: 154,
      prior_classified: 0,
      attempted: 0,
      classified: 0,
      errored: 0,
    };
    writeCoverageStamp(path, stamp);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(stamp);
  });
});
