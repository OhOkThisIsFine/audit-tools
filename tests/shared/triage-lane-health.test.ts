// P11 (nightly sol-4, owner decision 2026-08-06): the leg-2 triage lane's
// health contract. The model target is resolved LIVE from the router's own
// /v1/models (a hardcoded model id is a hand-held copy of the router's roster
// and has gone stale twice, across two different transports); an unresolvable
// lane aborts naming the TRIAGE_MODEL escape; coverage is a recorded stamp, not
// a wc -l. These tests cover the exported resolution + stamp helpers; importing
// the module must not start a sweep (the run is guarded behind direct
// invocation).
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { resolveTriageModel } from "../../scripts/shared/triage-backlog.mjs";
import {
  coverageStampPath,
  writeCoverageStamp,
} from "../../scripts/shared/lane-dispatch.mjs";

describe("resolveTriageModel", () => {
  it("uses an explicit TRIAGE_MODEL verbatim, never touching discovery", () => {
    const model = resolveTriageModel({ TRIAGE_MODEL: "kimi-k2.6" }, () => {
      throw new Error("discovery must not run when the operator pinned a spec");
    });
    expect(model).toBe("kimi-k2.6");
  });

  it("discovers the live roster and prefers the router's own auto alias", () => {
    const model = resolveTriageModel({}, () =>
      JSON.stringify({ data: [{ id: "kimi-k2.6" }, { id: "auto" }, { id: "glm-4.7" }] }),
    );
    // `auto` delegates the speed/cost tradeoff to the only component that knows
    // live health and quota, rather than this script guessing a tier.
    expect(model).toBe("auto");
  });

  it("falls back to the first advertised model when auto is absent", () => {
    expect(
      resolveTriageModel({}, () => JSON.stringify({ data: [{ id: "glm-4.7" }, { id: "kimi-k2.6" }] })),
    ).toBe("glm-4.7");
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
    expect(() => resolveTriageModel({}, () => JSON.stringify({ data: [] }))).toThrow(
      /no available models/,
    );
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
