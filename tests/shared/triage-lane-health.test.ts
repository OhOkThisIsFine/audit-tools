// The leg-2 triage lane's health contract (P11, owner decision sol-4
// 2026-08-06; ported off llm-relay onto agent-dispatch by the
// switch/agent-dispatch lap, 2026-09-22).
//
// The sweep NAMES NO MODEL. It hands each entry to the agent-dispatch
// bridge's `opencode_fire`/`opencode_wait`/`opencode_job_cancel` tools and
// reads back the answer plus the provider/model that produced it — the
// bridge's own default capability tier (litellm/medium) is what applies when
// no tier is named, and nothing here picks one. These tests pin the stdio
// MCP client (scripts/shared/mcp-dispatch-lane.mjs) against a FAKE bridge
// that speaks the same newline-delimited JSON-RPC and the same
// structuredContent shapes opencode-mcp actually returns, so every behavior
// is reachable with no real bridge, no worker, and no model: the handshake
// order, the argument binding, terminal statuses returned rather than
// thrown, transport deaths thrown, a client-owned timeout that cancels and
// RETURNS rather than throwing, and one shared bridge process serving
// concurrent calls matched by JSON-RPC id. Importing the sweep module must
// not start a sweep (the run is guarded behind direct invocation).
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  DispatchLaneError,
  openDispatchLane,
  satisfiesAgentDispatchNode,
} from "../../scripts/shared/mcp-dispatch-lane.mjs";
import {
  coverageStampPath,
  writeCoverageStamp,
} from "../../scripts/shared/lane-dispatch.mjs";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "triage-lane-"));
  dirs.push(d);
  return d;
}

// A stand-in for the agent-dispatch bridge: JSON-RPC 2.0, one message per
// line. It refuses `tools/call` until `notifications/initialized` has
// arrived (the handshake order the real bridge relies on), and it answers
// `opencode_fire`/`opencode_wait`/`opencode_job_cancel` with opencode-mcp's
// REAL structuredContent shape — {text, isError, sessionId, jobId, directory,
// status, result?, error?} — rather than a rendered text envelope. A job's
// scenario is selected by its fired PROMPT text; `SLOW a`/`SLOW b` answer
// their `opencode_wait` calls on a reversed delay, so the second-fired job's
// reply arrives first — proving replies are matched by id, not by send order.
const FAKE_SERVER = String.raw`
let buffer = "";
let initialized = false;
let initDone = false;
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");

let seq = 0;
const nextJobId = () => "job-" + String(++seq).padStart(4, "0");

// Each scenario: how many "running" opencode_wait replies precede the
// terminal one ("waits"), and what the terminal reply carries.
const SCENARIOS = {
  RUNNING: { waits: 2, status: "completed" },
  STUCK: { waits: Infinity },
  // The deadline race: the job never answers a wait before the caller's
  // deadline, but upstream JobService.cancel() returns the TERMINAL snapshot
  // unchanged when the job already finished between the last wait and the
  // cancel call — simulated by having THIS scenario's cancel reply itself
  // carry a completed answer rather than status "cancelled".
  FINISHES_AT_DEADLINE: { waits: Infinity, cancelReturnsCompleted: true },
  LATEFAIL: { waits: 1, status: "failed", error: { name: "SessionError", message: "session reported an error" } },
  INPUT: { waits: 0, status: "input_required" },
  UNKNOWN_EARLY: { waits: 1, status: "completed", earlyUnknown: true },
  FAIL: { waits: 0, status: "failed", error: { name: "ProviderAuthError", data: { providerID: "litellm", message: "no credential" } } },
  REASONING_BRACE: { waits: 0, status: "completed", reasoningBrace: true },
  "SLOW a": { waits: 0, status: "completed", slowMs: 40 },
  "SLOW b": { waits: 0, status: "completed", slowMs: 5 },
};

const jobs = new Map();

function partsFor(scenario, prompt, args, job) {
  if (scenario.reasoningBrace) {
    return [
      { type: "reasoning", text: "thinking about { not json at all } here" },
      { type: "text", text: JSON.stringify({ verdict: "actionable_now" }) },
      { type: "step-finish", cost: 0.001, tokens: { input: 10, output: 4 } },
    ];
  }
  // waitAt lets a test PROVE the retry pause actually happened (the gap
  // between the two receive timestamps), rather than measuring wall time
  // from before dispatch() — which also includes the handshake and is
  // already past any reasonable retry-interval floor on its own.
  if (scenario.earlyUnknown) {
    return [{ type: "text", text: JSON.stringify({ prompt, args, waitAt: job.waitAt }) }];
  }
  return [{ type: "text", text: JSON.stringify({ prompt, args }) }];
}

function renderText(snapshot) {
  const lines = [
    snapshot.directory ? "Directory: " + snapshot.directory : "",
    snapshot.sessionId ? "Session: " + snapshot.sessionId : "",
    snapshot.jobId ? "Job: " + snapshot.jobId : "",
    "Status: " + snapshot.status,
  ].filter(Boolean);
  if (snapshot.status === "completed") lines.push("Session completed.");
  if (snapshot.status === "input_required") lines.push("Input required. Inspect pending permissions and questions before continuing.");
  if (snapshot.error) lines.push("Error: " + (typeof snapshot.error === "string" ? snapshot.error : JSON.stringify(snapshot.error)));
  if (snapshot.note) lines.push(snapshot.note);
  return lines.join("\n\n");
}

// withStructuredText() upstream: structuredContent.text is the SAME text as
// the rendered content — never a separate, unrendered "raw answer" field.
function respond(id, snapshot) {
  const text = renderText(snapshot);
  const isError = snapshot.status === "failed";
  send({
    jsonrpc: "2.0",
    id,
    result: {
      content: [{ type: "text", text }],
      isError,
      structuredContent: { ...snapshot, text, isError },
    },
  });
}

function handle(msg) {
  if (msg.id === undefined) {
    if (msg.method === "notifications/initialized" && initDone) initialized = true;
    return;
  }
  if (msg.method === "initialize") {
    initDone = true;
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: msg.params.protocolVersion, serverInfo: { name: "fake-bridge", version: "0" } } });
    return;
  }
  if (msg.method !== "tools/call") {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "unknown method: " + msg.method } });
    return;
  }
  if (!initialized) {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32600, message: "tools/call before notifications/initialized" } });
    return;
  }
  const name = msg.params.name;
  const a = msg.params.arguments;

  if (name === "opencode_fire") {
    if (a.prompt === "DIE") process.exit(3);
    if (a.prompt === "REFUSE") {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "boom" } });
      return;
    }
    const scenario = SCENARIOS[a.prompt] ?? { waits: 0, status: "completed" };
    const jobId = nextJobId();
    jobs.set(jobId, { prompt: a.prompt, args: a, scenario, polls: 0 });
    respond(msg.id, {
      jobId,
      sessionId: "ses_" + jobId,
      directory: a.directory,
      status: "accepted",
      note: "Task dispatched. Use opencode_check or opencode_wait.",
    });
    return;
  }

  if (name === "opencode_wait") {
    const job = jobs.get(a.jobId);
    if (!job) {
      respond(msg.id, { jobId: a.jobId, status: "unknown", error: "unknown jobId: " + a.jobId });
      return;
    }
    job.waitAt = job.waitAt || [];
    job.waitAt.push(Date.now());
    const { scenario } = job;
    const emit = () => {
      if (job.polls < scenario.waits) {
        job.polls += 1;
        const earlyUnknown = scenario.earlyUnknown && job.polls === 1;
        respond(
          msg.id,
          earlyUnknown
            ? { jobId: a.jobId, sessionId: "ses_" + a.jobId, directory: job.args.directory, status: "unknown", error: { name: "MessageHistoryUnavailable", message: "transient read fault" } }
            : { jobId: a.jobId, sessionId: "ses_" + a.jobId, directory: job.args.directory, status: "running", timedOut: true },
        );
        return;
      }
      const parts = partsFor(scenario, job.prompt, job.args, job);
      respond(msg.id, {
        jobId: a.jobId,
        sessionId: "ses_" + a.jobId,
        directory: job.args.directory,
        status: scenario.status,
        error: scenario.error,
        result: scenario.status === "input_required" ? undefined : { info: { providerID: "litellm", modelID: "medium" }, parts },
      });
    };
    if (scenario.slowMs) setTimeout(emit, scenario.slowMs);
    else emit();
    return;
  }

  if (name === "opencode_job_cancel") {
    const job = jobs.get(a.jobId);
    if (!job) {
      respond(msg.id, { jobId: a.jobId, status: "unknown", error: "unknown jobId: " + a.jobId });
      return;
    }
    job.cancelled = true;
    // A marker on stderr a test can observe from the OUTSIDE (the fake bridge
    // runs as a real subprocess, so its in-memory job map is not otherwise
    // readable) — proof the deadline path actually reaches
    // opencode_job_cancel, not just that the client labels its own answer
    // timed_out.
    process.stderr.write("CANCEL " + a.jobId + "\n");
    if (job.scenario.cancelReturnsCompleted) {
      const parts = partsFor(job.scenario, job.prompt, job.args, job);
      respond(msg.id, {
        jobId: a.jobId,
        sessionId: "ses_" + a.jobId,
        directory: job.args.directory,
        status: "completed",
        result: { info: { providerID: "litellm", modelID: "medium" }, parts },
      });
      return;
    }
    respond(msg.id, { jobId: a.jobId, sessionId: "ses_" + a.jobId, directory: job.args.directory, status: "cancelled" });
    return;
  }

  respond(msg.id, { status: "failed", error: "unknown tool: " + name });
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, i).replace(/\r$/, "");
    buffer = buffer.slice(i + 1);
    if (line.trim() !== "") handle(JSON.parse(line));
  }
});
process.stdin.on("end", () => process.exit(0));
`;

function fakeLane(overrides: Record<string, unknown> = {}) {
  const dir = tmp();
  const script = join(dir, "fake-bridge.mjs");
  writeFileSync(script, FAKE_SERVER);
  return openDispatchLane({
    command: process.execPath,
    args: [script],
    cwd: dir,
    onStderr: () => {},
    // A short retry interval so the "returned early" test does not burn the
    // real 2-second upstream default. Production callers never pass this.
    waitRetryMs: 15,
    ...overrides,
  });
}

describe("openDispatchLane: preflight", () => {
  it("fails loudly, before spawning anything, when the agent-dispatch checkout is missing", () => {
    const missingRepo = tmp();
    expect(() => openDispatchLane({ env: { AGENT_DISPATCH_REPO: missingRepo } })).toThrow(
      /agent-dispatch checkout not found/,
    );
  });

  it("checks the exact Node floor agent-dispatch's package.json declares (>=22.18)", () => {
    expect(satisfiesAgentDispatchNode("22.17.0")).toBe(false);
    expect(satisfiesAgentDispatchNode("22.18.0")).toBe(true);
    expect(satisfiesAgentDispatchNode("23.0.0")).toBe(true);
  });

  it("skips both checks when the caller supplies its own command (a test's fake bridge)", async () => {
    // No throw, and no real agent-dispatch checkout is required — every other
    // test in this file relies on exactly this.
    let lane: ReturnType<typeof fakeLane>;
    expect(() => {
      lane = fakeLane();
    }).not.toThrow();
    // The fake bridge child's cwd sits inside the temp dir `afterEach` removes
    // — leaving it open makes that removal fail EPERM on Windows.
    await lane!.close();
  });
});

describe("openDispatchLane: dispatch", () => {
  it("handshakes before the first call, fires with the mode-selected agent and a directory, and omits providerID/modelID", async () => {
    const lane = fakeLane();
    try {
      const r = await lane.dispatch("classify me", { timeoutMs: 5_000 });
      expect(r.status).toBe("completed");
      const echoed = JSON.parse(r.raw);
      expect(echoed.prompt).toBe("classify me");
      expect(echoed.args.agent).toBe("answer"); // default mode
      expect(typeof echoed.args.directory).toBe("string");
      expect(echoed.args.providerID).toBeUndefined();
      expect(echoed.args.modelID).toBeUndefined();

      const agentMode = await lane.dispatch("classify me", { timeoutMs: 5_000, mode: "agent" });
      expect(JSON.parse(agentMode.raw).args.agent).toBe("dispatch");
    } finally {
      await lane.close();
    }
  });

  it("requires timeoutMs — agent-dispatch enforces no job timeout of its own", async () => {
    const lane = fakeLane();
    try {
      // @ts-expect-error — exercising the missing-required-option runtime guard
      await expect(lane.dispatch("classify me", {})).rejects.toBeInstanceOf(DispatchLaneError);
    } finally {
      await lane.close();
    }
  });

  it("extracts only the result's text parts — reasoning (even with a brace) and step-finish are dropped", async () => {
    const lane = fakeLane();
    try {
      const r = await lane.dispatch("REASONING_BRACE", { timeoutMs: 5_000 });
      expect(r.status).toBe("completed");
      expect(r.raw).toBe(JSON.stringify({ verdict: "actionable_now" }));
      expect(r.lane).toBe("litellm/medium");
    } finally {
      await lane.close();
    }
  });

  it("polls a running job to its terminal state across several waits", async () => {
    const lane = fakeLane();
    try {
      const r = await lane.dispatch("RUNNING", { timeoutMs: 5_000 });
      expect(r.status).toBe("completed");
      expect(r.lane).toBe("litellm/medium");
    } finally {
      await lane.close();
    }
  });

  it("retries a non-terminal reply that did NOT use its full time budget after the upstream poll interval, not in a tight loop", async () => {
    // A retry interval generous enough that a tight loop (no sleep at all —
    // the two opencode_wait calls landing back to back) is unmistakably
    // distinguishable from it, without the test itself burning that time:
    // the gap is measured SERVER-SIDE (the fake's own receive timestamps,
    // echoed back in the answer), never against wall time from before
    // dispatch() — which already exceeds a small interval on handshake
    // overhead alone, the defect this replaces.
    const lane = fakeLane({ waitRetryMs: 150 });
    try {
      const r = await lane.dispatch("UNKNOWN_EARLY", { timeoutMs: 5_000 });
      expect(r.status).toBe("completed");
      const { waitAt } = JSON.parse(r.raw);
      expect(waitAt).toHaveLength(2);
      expect(waitAt[1] - waitAt[0]).toBeGreaterThanOrEqual(100);
    } finally {
      await lane.close();
    }
  });

  it("returns an immediate failure as a terminal status with its reason, never throwing", async () => {
    const lane = fakeLane();
    try {
      const r = await lane.dispatch("FAIL", { timeoutMs: 5_000 });
      expect(r.status).toBe("failed");
      expect(r.error).toBe("ProviderAuthError: no credential");
    } finally {
      await lane.close();
    }
  });

  it("returns a job that ends FAILED after a poll as a terminal status, never throwing", async () => {
    const lane = fakeLane();
    try {
      const r = await lane.dispatch("LATEFAIL", { timeoutMs: 5_000 });
      expect(r.status).toBe("failed");
      expect(r.error).toBe("SessionError: session reported an error");
    } finally {
      await lane.close();
    }
  });

  it("cancels and returns a non-completed result on input_required — a headless sweep must never stall on a question", async () => {
    const lane = fakeLane();
    try {
      const r = await lane.dispatch("INPUT", { timeoutMs: 5_000 });
      expect(r.status).toBe("cancelled");
      expect(r.error).toMatch(/asked for input/);
    } finally {
      await lane.close();
    }
  });

  it("gives up on a job still running past its timeout — cancels and RETURNS timed_out, never throwing", async () => {
    const stderrChunks: string[] = [];
    const lane = fakeLane({ onStderr: (chunk: string) => { stderrChunks.push(chunk); } });
    try {
      const r = await lane.dispatch("STUCK", { timeoutMs: 50 });
      expect(r.status).toBe("timed_out");
      expect(r.error).toMatch(/job-\d+ .*still running after \d+ ms/);
      // The deadline path must actually call opencode_job_cancel on the
      // runaway job, not just label the client's own answer timed_out — the
      // fake bridge's cancel handler marks its stderr, observable only from
      // outside the (real, subprocess) fake since its job map is not
      // otherwise readable here.
      const [, jobId] = /(job-\d+)/.exec(r.error ?? "") ?? [];
      expect(jobId).toBeTruthy();
      expect(stderrChunks.join("")).toContain(`CANCEL ${jobId}`);
      // A throw here is what lane-dispatch.mjs retries once; a RETURN must
      // not run the same 20-minute call twice.
      // The lane still serves the next call afterwards.
      const after = await lane.dispatch("classify me", { timeoutMs: 5_000 });
      expect(after.status).toBe("completed");
    } finally {
      await lane.close();
    }
  });

  it("a job that COMPLETES between the last poll and the deadline cancel keeps its real answer, never relabeled timed_out", async () => {
    // Upstream JobService.cancel() returns the terminal snapshot UNCHANGED
    // when the job already finished — the deadline race this pins: the fake
    // answers the cancel call itself as if the job had already completed
    // (upstream's own behavior for a cancel on a terminal job), and the
    // caller must surface that real answer, never discard it as timed_out.
    const lane = fakeLane();
    try {
      const r = await lane.dispatch("FINISHES_AT_DEADLINE", { timeoutMs: 50 });
      expect(r.status).toBe("completed");
      expect(r.error).toBeUndefined();
      expect(JSON.parse(r.raw).prompt).toBe("FINISHES_AT_DEADLINE");
    } finally {
      await lane.close();
    }
  });

  it("throws on an RPC refusal and a bridge death — no answer exists", async () => {
    const lane = fakeLane();
    try {
      await expect(lane.dispatch("REFUSE", { timeoutMs: 5_000 })).rejects.toThrow(/opencode_fire refused: boom/);
      await expect(lane.dispatch("DIE", { timeoutMs: 5_000 })).rejects.toBeInstanceOf(DispatchLaneError);
      // The one shared bridge process is dead: every later call fails fast.
      await expect(lane.dispatch("after death", { timeoutMs: 5_000 })).rejects.toThrow(/exited/);
    } finally {
      await lane.close();
    }
  });

  it("runs concurrent dispatch() calls on ONE shared bridge process, matched by id — even when replies arrive out of order", async () => {
    const lane = fakeLane();
    try {
      // "SLOW a" answers its opencode_wait after 40ms, "SLOW b" after 5ms:
      // b's reply reaches the client first even though a was fired first. A
      // client that demuxed by SEND ORDER rather than JSON-RPC id would
      // resolve a's promise with b's payload.
      const [a, b] = await Promise.all([
        lane.dispatch("SLOW a", { timeoutMs: 5_000 }),
        lane.dispatch("SLOW b", { timeoutMs: 5_000 }),
      ]);
      expect(JSON.parse(a.raw).prompt).toBe("SLOW a");
      expect(JSON.parse(b.raw).prompt).toBe("SLOW b");
    } finally {
      await lane.close();
    }
  });
});

describe("the sweep names no model or tier", () => {
  // The ledger item's property, pinned at the source: the bridge's own
  // default tier applies when none is named. A roster read, a model env var,
  // an explicit tier, or a first-entry fallback here would be the 2026-09-03
  // failure coming back in a new shape.
  it("routes through the dispatch lane and carries no roster, model env var, or chat endpoint", () => {
    const src = readFileSync(join(process.cwd(), "scripts", "shared", "triage-backlog.mjs"), "utf8");
    expect(src).toContain("openDispatchLane");
    for (const banned of ["TRIAGE_MODEL", "TRIAGE_ENDPOINT", "resolveTriageModel", "/v1/", "ids[0]"]) {
      expect(src, `sweep source must not contain ${banned}`).not.toContain(banned);
    }
  });
});

describe("coverage stamp", () => {
  it("derives the sidecar path from the JSONL path", () => {
    expect(coverageStampPath("C:/x/backlog-triage.jsonl").endsWith("backlog-triage-coverage.json")).toBe(true);
  });

  it("round-trips the stamp shape the routine reads", () => {
    const path = coverageStampPath(join(tmp(), "t.jsonl"));
    const stamp = {
      model: "agent-dispatch dispatch",
      started_at: "2026-08-06T00:00:00.000Z",
      finished_at: null,
      aborted: "preflight failed: HTTP 400",
      total_entries: 154,
      prior_classified: 0,
      attempted: 0,
      classified: 0,
      errored: 0,
      retried: 0,
    };
    writeCoverageStamp(path, stamp);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(stamp);
  });

  it("the sweep's own coverage line and the routine both name the retry count", () => {
    // `retried` is driver-owned and read-verbatim by docs/nightly-routine.md,
    // which lists the stamp's fields by name. A field the routine does not read
    // is a number nobody sees, and the retry property is exactly the kind of
    // silent recovery that let three partial sweeps pass as complete ones.
    const routine = readFileSync(join(process.cwd(), "docs", "nightly-routine.md"), "utf8");
    expect(routine).toContain("retried");
    const driver = readFileSync(join(process.cwd(), "scripts", "shared", "lane-dispatch.mjs"), "utf8");
    expect(driver).toContain("stamp.retried");
    const sweep = readFileSync(join(process.cwd(), "scripts", "shared", "triage-backlog.mjs"), "utf8");
    expect(sweep).toContain("stamp.retried");
  });
});
