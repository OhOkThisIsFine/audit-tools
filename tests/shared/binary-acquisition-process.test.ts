import { expect, test } from "vitest";
import { fork, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { hashContent } from "../../src/shared/hash.js";
import type { BinaryResolution } from "../../src/shared/analyzers/binaryAcquisition.js";

interface Message { kind: string; id: number; url: string; result: BinaryResolution }
function worker(root: string, arch: string, onRequest: (child: ChildProcess, message: Message) => void) {
  const child = fork(fileURLToPath(new URL("./fixtures/binary-acquisition-worker.mjs", import.meta.url)), [], {
    execArgv: ["--import", "tsx/esm"], stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let start!: () => void;
  const started = new Promise<void>(resolve => { start = resolve; });
  const result = new Promise<BinaryResolution>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", code => { if (code) reject(new Error(`worker exit ${code}`)); });
    child.on("message", (message: Message) => {
      if (message.kind === "ready") child.send({ kind: "start", root, arch });
      else if (message.kind === "started") start();
      else if (message.kind === "request") onRequest(child, message);
      else if (message.kind === "result") resolve(message.result);
    });
  });
  return { child, started, result };
}
const payload = new TextEncoder().encode("inert process payload");
function reply(child: ChildProcess, request: Message) {
  const bytes = request.url.endsWith("checksums") ? new TextEncoder().encode(`${hashContent(payload)}  asset`) : payload;
  child.send({ kind: "bytes", id: request.id, bytes: [...bytes] });
}
test("two real cooperative processes share one checksum and payload fetch", async () => {
  const root = mkdtempSync(join(tmpdir(), "binary-process-"));
  let count = 0;
  const requests: Array<[ChildProcess, Message]> = [];
  let release = false;
  const request = (child: ChildProcess, message: Message) => { count++; if (release) reply(child, message); else requests.push([child, message]); };
  const first = worker(root, "x64", request); const second = worker(root, "x64", request);
  try {
    await Promise.all([first.started, second.started]);
    release = true; for (const [child, message] of requests) reply(child, message);
    const results = await Promise.all([first.result, second.result]);
    expect(results.map(result => result.status).sort()).toEqual(["cached", "downloaded"]);
    expect(results[0].command).toBe(results[1].command); expect(count).toBe(2);
  } finally { first.child.kill(); second.child.kill(); rmSync(root, { recursive: true, force: true }); }
}, 15000);
test("unrelated identity proceeds while another process holds its acquisition lock", async () => {
  const root = mkdtempSync(join(tmpdir(), "binary-independent-"));
  let held!: [ChildProcess, Message];
  let acquired!: () => void;
  const acquiredPromise = new Promise<void>(resolve => { acquired = resolve; });
  const first = worker(root, "x64", (child, message) => {
    if (message.url.endsWith("checksums")) { held = [child, message]; acquired(); } else reply(child, message);
  });
  let second: ReturnType<typeof worker> | undefined;
  try {
    await acquiredPromise;
    second = worker(root, "arm64", reply);
    expect((await second.result).status).toBe("downloaded");
    reply(...held);
    expect((await first.result).status).toBe("downloaded");
  } finally { first.child.kill(); second?.child.kill(); rmSync(root, { recursive: true, force: true }); }
}, 15000);
