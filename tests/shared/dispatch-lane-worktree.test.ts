// A repository-reading dispatch lane runs in a worktree the helper owns (owner
// answer f78305ac08246ae5, 2026-09-24): scripts/shared/mcp-dispatch-lane.mjs
// adds a detached worktree OUTSIDE every repository root
// (`<container>-worktrees/<repo>/dispatch-lane-<pid>-<hex>`), points the job at
// it, and removes it on success, on a failed job, on a thrown transport death
// and — through the stale sweep — after the dispatching process is killed. The
// caller's checkout is never the job's directory, and its git state is
// untouched.
//
// A fake bridge speaks the same newline-delimited JSON-RPC as the
// agent-dispatch bridge and appends, for every `opencode_fire`, what the job's
// directory looked like WHILE the job ran: the path, whether its `.git` is a
// FILE (a linked worktree) and the committed file it can read.
import { spawnHidden, spawnSyncHidden } from "../helpers/spawn.mjs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DispatchLaneError,
  laneWorktreeContainer,
  openDispatchLane,
} from "../../scripts/shared/mcp-dispatch-lane.mjs";

const HELPER = resolve(__dirname, "../../scripts/shared/mcp-dispatch-lane.mjs");

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "lane-worktree-"));
  dirs.push(d);
  return d;
}

function git(args: string[], cwd: string): string {
  const r = spawnSyncHidden("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

/** A committed repository at `<parent>/<name>`, left with an uncommitted edit. */
function makeRepo(parent: string, name = "myrepo"): string {
  const top = join(parent, name);
  mkdirSync(join(top, "sub"), { recursive: true });
  git(["init", "-q", "-b", "main"], top);
  writeFileSync(join(top, "README.md"), "committed\n");
  writeFileSync(join(top, "sub", "file.txt"), "sub\n");
  git(["add", "README.md", "sub/file.txt"], top);
  git(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"], top);
  writeFileSync(join(top, "README.md"), "uncommitted edit\n");
  return top;
}

/** Everything about a checkout's git state a lane must not change. */
function gitState(top: string) {
  return {
    head: git(["rev-parse", "HEAD"], top),
    status: git(["status", "--porcelain=v1", "--untracked-files=all"], top),
    index: git(["ls-files", "-s"], top),
    refs: git(["for-each-ref"], top),
    worktrees: git(["worktree", "list", "--porcelain"], top),
  };
}

const FAKE_BRIDGE = String.raw`
import { appendFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
const log = process.argv[2];
let buffer = "";
let n = 0;
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
const respond = (id, sc) => send({ jsonrpc: "2.0", id, result: { content: [], structuredContent: sc } });
function observe(directory) {
  let dir = directory;
  while (!existsSync(join(dir, ".git")) && dirname(dir) !== dir) dir = dirname(dir);
  const marker = join(dir, ".git");
  return {
    directory,
    top: dir,
    gitIsFile: existsSync(marker) && statSync(marker).isFile(),
    readme: existsSync(join(dir, "README.md")) ? readFileSync(join(dir, "README.md"), "utf8") : null,
  };
}
const jobs = new Map();
function handle(msg) {
  if (msg.id === undefined) return;
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: msg.params.protocolVersion } });
    return;
  }
  const a = msg.params.arguments;
  if (msg.params.name === "opencode_fire") {
    const seen = observe(a.directory);
    appendFileSync(log, JSON.stringify(seen) + "\n");
    if (a.prompt === "DIE") process.exit(3);
    const jobId = "job-" + ++n;
    jobs.set(jobId, { prompt: a.prompt, seen });
    respond(msg.id, { jobId, status: "running" });
    return;
  }
  const job = jobs.get(a.jobId);
  if (msg.params.name === "opencode_job_cancel") {
    respond(msg.id, { jobId: a.jobId, status: "cancelled" });
    return;
  }
  if (job.prompt === "STUCK") {
    setTimeout(() => respond(msg.id, { jobId: a.jobId, status: "running", timedOut: true }), 20);
    return;
  }
  const parts = [{ type: "text", text: JSON.stringify(job.seen) }];
  respond(msg.id, job.prompt === "FAIL"
    ? { jobId: a.jobId, status: "failed", error: { name: "WorkerError", message: "boom" }, result: { parts } }
    : { jobId: a.jobId, status: "completed", result: { info: { providerID: "litellm", modelID: "medium" }, parts } });
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

/** A fake bridge and the log its fires are appended to. */
function fakeBridge() {
  const dir = tmp();
  const script = join(dir, "fake-bridge.mjs");
  const log = join(dir, "fires.jsonl");
  writeFileSync(script, FAKE_BRIDGE);
  writeFileSync(log, "");
  const fires = () =>
    readFileSync(log, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as { directory: string; top: string; gitIsFile: boolean; readme: string | null });
  return { dir, script, log, fires };
}

function fakeLane(cwd: string) {
  const bridge = fakeBridge();
  const lane = openDispatchLane({
    command: process.execPath,
    args: [bridge.script, bridge.log],
    cwd: bridge.dir,
    onStderr: () => {},
    waitRetryMs: 15,
  });
  return { lane, fires: bridge.fires, cwd };
}

function laneEntries(container: string): string[] {
  return existsSync(container) ? readdirSync(container) : [];
}

describe("a repository-reading dispatch runs in a worktree the helper owns", () => {
  it("runs the job in a detached worktree of HEAD outside every repo root, never the checkout, and removes it on success", async () => {
    const top = makeRepo(join(tmp(), "repos"));
    const before = gitState(top);
    const container = laneWorktreeContainer(top);
    const { lane, fires } = fakeLane(top);
    try {
      const r = await lane.dispatch("OK", { timeoutMs: 5_000, mode: "agent", cwd: top });
      expect(r.status).toBe("completed");
    } finally {
      await lane.close();
    }
    const [seen] = fires();
    // The <container>-worktrees/<repo>/<name> convention, with the main checkout's name.
    expect(resolve(seen.directory).startsWith(resolve(join(`${resolve(top, "..")}-worktrees`, "myrepo")) + sep)).toBe(true);
    expect(resolve(seen.directory).startsWith(resolve(top) + sep)).toBe(false);
    expect(seen.gitIsFile).toBe(true); // a linked worktree, not the main checkout
    expect(seen.readme?.trim()).toBe("committed"); // HEAD (checked out with the host's line endings), not the caller's uncommitted edit
    expect(existsSync(seen.directory)).toBe(false);
    expect(laneEntries(container)).toEqual([]);
    expect(gitState(top)).toEqual(before);
  });

  it("maps a subdirectory to the same subdirectory inside the lane worktree", async () => {
    const top = makeRepo(join(tmp(), "repos"));
    const { lane, fires } = fakeLane(top);
    try {
      await lane.dispatch("OK", { timeoutMs: 5_000, mode: "agent", cwd: join(top, "sub") });
    } finally {
      await lane.close();
    }
    const [seen] = fires();
    expect(resolve(seen.directory).endsWith(`${sep}sub`)).toBe(true);
    expect(resolve(seen.top)).not.toBe(resolve(top));
  });

  it("removes the worktree when the job fails, times out, or the bridge dies mid-call", async () => {
    const top = makeRepo(join(tmp(), "repos"));
    const before = gitState(top);
    const container = laneWorktreeContainer(top);
    const { lane, fires } = fakeLane(top);
    try {
      const failed = await lane.dispatch("FAIL", { timeoutMs: 5_000, mode: "agent", cwd: top });
      expect(failed.status).toBe("failed");
      const timedOut = await lane.dispatch("STUCK", { timeoutMs: 60, mode: "agent", cwd: top });
      expect(timedOut.status).toBe("timed_out");
      await expect(lane.dispatch("DIE", { timeoutMs: 5_000, mode: "agent", cwd: top })).rejects.toThrow(DispatchLaneError);
    } finally {
      await lane.close();
    }
    const seen = fires();
    expect(seen).toHaveLength(3);
    for (const s of seen) {
      expect(s.gitIsFile).toBe(true);
      expect(existsSync(s.directory)).toBe(false);
    }
    expect(laneEntries(container)).toEqual([]);
    expect(gitState(top)).toEqual(before);
  });

  it("names the MAIN checkout's repo and the linked worktree's HEAD when dispatched from a linked worktree", async () => {
    const parent = join(tmp(), "repos");
    const top = makeRepo(parent);
    const lap = join(`${parent}-worktrees`, "myrepo", "some-lap");
    git(["worktree", "add", "-q", "-b", "lap", lap], top);
    writeFileSync(join(lap, "README.md"), "lap commit\n");
    git(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-am", "lap"], lap);
    const lapBefore = gitState(lap);
    const { lane, fires } = fakeLane(lap);
    try {
      await lane.dispatch("OK", { timeoutMs: 5_000, mode: "agent", cwd: lap });
    } finally {
      await lane.close();
    }
    const [seen] = fires();
    expect(resolve(seen.top)).not.toBe(resolve(lap));
    expect(resolve(seen.top).startsWith(resolve(join(`${parent}-worktrees`, "myrepo")) + sep)).toBe(true);
    expect(seen.readme?.trim()).toBe("lap commit");
    expect(laneEntries(join(`${parent}-worktrees`, "myrepo"))).toEqual(["some-lap"]);
    expect(gitState(lap)).toEqual(lapBefore);
  });

  it("refuses, creating nothing, when the worktree location would nest inside another repository", async () => {
    const outer = join(tmp(), "outer");
    mkdirSync(outer, { recursive: true });
    git(["init", "-q"], outer);
    const top = makeRepo(join(outer, "repos"));
    const { lane, fires } = fakeLane(top);
    try {
      await expect(lane.dispatch("OK", { timeoutMs: 5_000, mode: "agent", cwd: top })).rejects.toThrow(
        /nested worktree breaks/,
      );
    } finally {
      await lane.close();
    }
    expect(fires()).toEqual([]);
    expect(existsSync(laneWorktreeContainer(top))).toBe(false);
  });

  it("sweeps a worktree left by a dispatching process that was killed mid-job", async () => {
    const top = makeRepo(join(tmp(), "repos"));
    const before = gitState(top);
    const container = laneWorktreeContainer(top);
    const bridge = fakeBridge();
    const child = join(bridge.dir, "dispatcher.mjs");
    writeFileSync(
      child,
      `import { openDispatchLane } from ${JSON.stringify(pathToFileURL(HELPER).href)};
const lane = openDispatchLane({ command: process.execPath, args: ${JSON.stringify([bridge.script, bridge.log])}, onStderr: () => {} });
await lane.dispatch("STUCK", { timeoutMs: 600_000, mode: "agent", cwd: ${JSON.stringify(top)} });
`,
    );
    const proc = spawnHidden(process.execPath, [child], { stdio: ["ignore", "pipe", "pipe"] });
    const exited = new Promise((done) => proc.once("exit", done));
    await vi.waitFor(() => expect(bridge.fires()).toHaveLength(1), { timeout: 30_000, interval: 50 });
    proc.kill("SIGKILL");
    await exited;
    const [orphan] = bridge.fires();
    expect(existsSync(orphan.directory)).toBe(true); // the killed process never reached its finally

    const { lane, fires } = fakeLane(top);
    try {
      await lane.dispatch("OK", { timeoutMs: 5_000, mode: "agent", cwd: top });
    } finally {
      await lane.close();
    }
    expect(fires()).toHaveLength(1);
    expect(existsSync(orphan.directory)).toBe(false);
    expect(laneEntries(container)).toEqual([]);
    expect(gitState(top)).toEqual(before);
  });

  it("passes the answer agent and a directory outside git through unchanged", async () => {
    const top = makeRepo(join(tmp(), "repos"));
    const snapshot = tmp();
    const { lane, fires } = fakeLane(top);
    try {
      await lane.dispatch("OK", { timeoutMs: 5_000, cwd: top });
      await lane.dispatch("OK", { timeoutMs: 5_000, mode: "agent", cwd: snapshot });
    } finally {
      await lane.close();
    }
    const [answer, outside] = fires();
    expect(resolve(answer.directory)).toBe(resolve(top));
    expect(resolve(outside.directory)).toBe(resolve(snapshot));
    expect(existsSync(laneWorktreeContainer(top))).toBe(false);
  });
});
