// The leg-2 triage lane's health contract (P11, owner decision sol-4
// 2026-08-06; re-based on llm-relay dispatch by ledger 133f4f815b608ea4,
// owner decision 2026-09-03).
//
// The sweep NAMES NO MODEL. It hands each entry to `llm-relay mcp`'s
// `dispatch` tool and reads back the answer plus the lane that produced it —
// best-lane selection belongs to the relay. These tests pin the stdio MCP
// client (scripts/shared/mcp-dispatch-lane.mjs) against a FAKE server that
// speaks the same newline-delimited JSON-RPC, so every behavior is reachable
// with no relay, no network, and no model: the handshake order, the argument
// binding, terminal statuses returned rather than thrown, transport deaths
// thrown, and the one-child-one-request pool. The coverage-stamp helpers keep
// their read-verbatim contract. Importing the sweep module must not start a
// sweep (the run is guarded behind direct invocation).
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  DispatchLaneError,
  openDispatchLane,
  parseDispatchAnswer,
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

// A stand-in for `llm-relay mcp`: JSON-RPC 2.0, one message per line. It
// refuses `tools/call` until `notifications/initialized` has arrived (the
// handshake order the real server relies on), and it answers by TASK TEXT so a
// test can pick the terminal shape it wants: an echo of the arguments plus its
// own pid (completed), a failed job (`FAIL`), a still-running job to poll
// (`RUNNING`, `STUCK`, `VANISH`, `LATEFAIL`), an RPC refusal (`REFUSE`), or a
// process death (`DIE`). It serves `dispatch_status` and `dispatch_result` too.
const FAKE_SERVER = String.raw`
let buffer = "";
let initialized = false;
let initDone = false;
// A dispatch that comes back STILL RUNNING (the relay clamps the blocking wait
// to routing.mcp.maxWaitMs). Each task names the job it starts; a job reports
// "running" for its first "runningPolls" status polls, then its terminal state.
// VANISH starts a job the server then denies knowing.
const RUNNING_TASKS = { RUNNING: "job-0003", STUCK: "job-0004", VANISH: "job-0005", LATEFAIL: "job-0006" };
const JOBS = {
  "job-0003": { polls: 0, runningPolls: 2, ends: "completed" },
  "job-0004": { polls: 0, runningPolls: Infinity, ends: "completed" },
  "job-0006": { polls: 0, runningPolls: 1, ends: "failed" },
};
const send =(m) => process.stdout.write(JSON.stringify(m) + "\n");
const answer = (id, text, isError) =>
  send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError } });
function handle(msg) {
  if (msg.id === undefined) {
    if (msg.method === "notifications/initialized" && initDone) initialized = true;
    return;
  }
  if (msg.method === "initialize") {
    initDone = true;
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: msg.params.protocolVersion, serverInfo: { name: "fake", version: "0" } } });
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
  const a = msg.params.arguments;
  if (msg.params.name === "dispatch_status" || msg.params.name === "dispatch_result") {
    const job = JOBS[a.jobId];
    if (!job) {
      answer(msg.id, "unknown jobId: " + a.jobId, true);
      return;
    }
    if (msg.params.name === "dispatch_status") {
      job.polls += 1;
      const status = job.polls > job.runningPolls ? job.ends : "running";
      answer(msg.id, "job: " + a.jobId + "\nlane: agy-gemini\nstatus: " + status + "\nelapsed: 6s", false);
      return;
    }
    if (job.ends === "failed") {
      answer(msg.id, "job: " + a.jobId + "\nlane: agy-gemini\nstatus: failed\nelapsed: 7s\nerror: lane exited 1\n\nThe lane returned NO output.", true);
      return;
    }
    answer(msg.id, "job: " + a.jobId + "\nlane: agy-gemini\nstatus: completed\nelapsed: 7s\nexit: 0\n\n" + JSON.stringify({ polls: job.polls }), false);
    return;
  }
  if (msg.params.name !== "dispatch") {
    answer(msg.id, "unknown tool: " + msg.params.name, true);
    return;
  }
  if (a.task in RUNNING_TASKS) {
    const jobId = RUNNING_TASKS[a.task];
    answer(msg.id, "job: " + jobId + "\nlane: agy-gemini\nstatus: running\nelapsed: 5s\n\nwaited 5 s (waitMs 1805000 clamped to routing.mcp.maxWaitMs 5000)\nStill running after 5s. Poll dispatch_status with jobId \"" + jobId + "\", then call dispatch_result.", false);
    return;
  }
  if (a.task === "DIE") process.exit(3);
  if (a.task === "REFUSE") {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "boom" } });
    return;
  }
  if (a.task === "FAIL") {
    answer(msg.id, "job: job-0002\nlane: free-pool (pool/medium)\nstatus: failed\nelapsed: 1s\nerror: relay answered HTTP 429\n\nThe lane returned NO output.", true);
    return;
  }
  const echo = JSON.stringify({ pid: process.pid, args: a });
  const delay = a.task.startsWith("SLOW") ? 300 : 0;
  setTimeout(() => answer(msg.id, "job: job-0001\nlane: free-pool (pool/medium)\nstatus: completed\nelapsed: 0s\nexit: 0\nserved-by: fake/model\r\n\r\n" + echo, false), delay);
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

function fakeLane(size = 1) {
  const dir = tmp();
  const script = join(dir, "fake-mcp.mjs");
  writeFileSync(script, FAKE_SERVER);
  return openDispatchLane({
    size,
    // A running job is polled every 10 ms, and given up 200 ms past its timeout.
    pollMs: 10,
    graceMs: 200,
    command: process.execPath,
    args: [script],
    cwd: dir,
    onStderr: () => {},
  });
}

describe("parseDispatchAnswer", () => {
  it("splits the provenance header from the body and names lane and spec", () => {
    const parsed = parseDispatchAnswer(
      "job: job-0007\nlane: free-pool (pool/medium)\nstatus: completed\nserved-by: nim/x\n\n{\"a\":1}\n",
    );
    expect(parsed.header).toEqual({ job: "job-0007", lane: "free-pool (pool/medium)", status: "completed", "served-by": "nim/x" });
    expect(parsed.lane).toBe("free-pool");
    expect(parsed.spec).toBe("pool/medium");
    expect(parsed.body).toBe('{"a":1}');
  });

  it("tolerates CRLF, a lane with no spec, and a header with no body", () => {
    const parsed = parseDispatchAnswer("lane: agy-gemini\r\nstatus: failed\r\nerror: x\r\n");
    expect(parsed.lane).toBe("agy-gemini");
    expect(parsed.spec).toBeUndefined();
    expect(parsed.header.error).toBe("x");
    expect(parsed.body).toBe("");
  });
});

describe("openDispatchLane", () => {
  it("handshakes before the first call and binds task, answer mode, schema, cwd and a wait past the timeout", async () => {
    const lane = fakeLane();
    try {
      const schema = { type: "object", properties: { v: { type: "string" } } };
      const r = await lane.dispatch("classify me", { schema, maxTokens: 50, timeoutMs: 1_000 });
      expect(r.status).toBe("completed");
      expect(r.lane).toBe("free-pool");
      expect(r.spec).toBe("pool/medium");
      expect(r.servedBy).toBe("fake/model");
      expect(r.error).toBeUndefined();
      const echoed = JSON.parse(r.raw);
      expect(echoed.args.task).toBe("classify me");
      expect(echoed.args.mode).toBe("answer");
      expect(echoed.args.schema).toEqual(schema);
      expect(echoed.args.maxTokens).toBe(50);
      expect(echoed.args.timeoutMs).toBe(1_000);
      expect(echoed.args.waitMs).toBeGreaterThan(1_000);
      expect(typeof echoed.args.cwd).toBe("string");
    } finally {
      await lane.close();
    }
  });

  it("returns a failed job as a terminal status with its reason, never throwing", async () => {
    const lane = fakeLane();
    try {
      const r = await lane.dispatch("FAIL");
      expect(r.status).toBe("failed");
      expect(r.lane).toBe("free-pool");
      expect(r.error).toBe("relay answered HTTP 429");
      expect(r.raw).toContain("NO output");
    } finally {
      await lane.close();
    }
  });

  // Nightly proposal P66 (owner decision 2026-09-16). The relay CLAMPS the
  // blocking wait to routing.mcp.maxWaitMs, so a `running` reply is ordinary:
  // 9 of 62 entries on the 2026-09-16 sweep were thrown away as transport faults.
  it("polls a running job to its terminal state and takes the answer from dispatch_result", async () => {
    const lane = fakeLane();
    try {
      const r = await lane.dispatch("RUNNING", { timeoutMs: 5_000 });
      expect(r.status).toBe("completed");
      expect(r.lane).toBe("agy-gemini");
      expect(r.header.job).toBe("job-0003");
      // Two polls answered `running`; the third named the terminal state.
      expect(JSON.parse(r.raw)).toEqual({ polls: 3 });
    } finally {
      await lane.close();
    }
  });

  it("returns a job that ends FAILED after the poll as a terminal status, never throwing", async () => {
    const lane = fakeLane();
    try {
      const r = await lane.dispatch("LATEFAIL", { timeoutMs: 5_000 });
      expect(r.status).toBe("failed");
      expect(r.error).toBe("lane exited 1");
    } finally {
      await lane.close();
    }
  });

  it("gives up on a job still running past its timeout, naming the job and the elapsed time", async () => {
    const lane = fakeLane();
    try {
      const error = await lane.dispatch("STUCK", { timeoutMs: 50 }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(DispatchLaneError);
      expect((error as Error).message).toMatch(/job-0004 .*still running after \d+ ms/);
      // The slot was released: the lane still serves the next call.
      expect((await lane.dispatch("after stuck")).status).toBe("completed");
    } finally {
      await lane.close();
    }
  });

  it("throws when the server no longer knows the job it said was running", async () => {
    const lane = fakeLane();
    try {
      await expect(lane.dispatch("VANISH", { timeoutMs: 5_000 })).rejects.toThrow(
        /dispatch_status for job-0005 .*unknown jobId: job-0005/,
      );
    } finally {
      await lane.close();
    }
  });

  it("throws on an RPC refusal and a server death — no answer exists", async () => {
    const lane = fakeLane();
    try {
      await expect(lane.dispatch("REFUSE")).rejects.toThrow(/dispatch refused: boom/);
      await expect(lane.dispatch("DIE")).rejects.toBeInstanceOf(DispatchLaneError);
      // Every slot is dead: the pool refuses rather than hanging.
      await expect(lane.dispatch("after death")).rejects.toThrow(/exited/);
    } finally {
      await lane.close();
    }
  });

  it("runs concurrent dispatches on distinct children, one request per child", async () => {
    const lane = fakeLane(2);
    try {
      const [a, b] = await Promise.all([lane.dispatch("SLOW a"), lane.dispatch("SLOW b")]);
      expect(JSON.parse(a.raw).pid).not.toBe(JSON.parse(b.raw).pid);
    } finally {
      await lane.close();
    }
  });

  it("serializes on one child when the pool has one slot", async () => {
    const lane = fakeLane(1);
    try {
      const [a, b] = await Promise.all([lane.dispatch("SLOW a"), lane.dispatch("SLOW b")]);
      expect(JSON.parse(a.raw).pid).toBe(JSON.parse(b.raw).pid);
    } finally {
      await lane.close();
    }
  });
});

describe("the sweep names no model target", () => {
  // The ledger item's property, pinned at the source: lane choice is the
  // relay's. A roster read, a model env var, or a first-entry fallback here
  // would be the 2026-09-03 failure coming back.
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
      model: "llm-relay dispatch",
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
