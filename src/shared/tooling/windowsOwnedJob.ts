// sites-pinned: tests/shared/windows-owned-job.test.ts, tests/shared/exec-owned-bounds.test.ts
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type OwnedJobMessage =
  | { type: "ready" }
  | { type: "started"; pid: number }
  | { type: "root_exit"; code: number | null; signal: string | null }
  | { type: "empty" }
  | { type: "error"; message: string; code: string };

/** The inherited IPC channel carries lifecycle metadata, never target output. */
export function isOwnedJobMessage(value: unknown): value is OwnedJobMessage {
  if (!value || typeof value !== "object" || !("type" in value)) return false;
  switch (value.type) {
    case "ready": case "empty": return true;
    case "started": return "pid" in value && Number.isSafeInteger(value.pid) && Number(value.pid) > 0;
    case "root_exit": return "code" in value && (value.code === null || Number.isInteger(value.code)) && "signal" in value && (value.signal === null || typeof value.signal === "string");
    case "error": return "message" in value && typeof value.message === "string" && "code" in value && typeof value.code === "string";
    default: return false;
  }
}

export interface WindowsJobRuntime {
  platform: NodeJS.Platform;
  send(message: OwnedJobMessage, done?: () => void): void;
  onStart(handler: (payload: unknown) => void): void;
  onDisconnect(handler: () => void): void;
  spawn(argv: string[], env: NodeJS.ProcessEnv): ChildProcess;
  closeInheritedStdio(): void;
  exit(code: number): void;
}

export interface WindowsJobOwnership {
  activeCount(): number;
  releaseEmpty(): void;
}

async function createNativeJob(): Promise<WindowsJobOwnership> {
  const { default: koffi } = await import("koffi");
  const kernel = koffi.load("kernel32.dll");
  // Koffi lays out pointer-sized fields for the running ABI; no x64 offsets.
  const basic = koffi.struct({ user: "int64_t", jobUser: "int64_t", flags: "uint32_t", min: "size_t", max: "size_t", count: "uint32_t", affinity: "uintptr_t", priority: "uint32_t", scheduling: "uint32_t" });
  const limits = koffi.struct({ basic, io: koffi.array("uint64_t", 6), processMemory: "size_t", jobMemory: "size_t", peakProcess: "size_t", peakJob: "size_t" });
  const accounting = koffi.struct({ user: "int64_t", kernel: "int64_t", periodUser: "int64_t", periodKernel: "int64_t", pageFaults: "uint32_t", total: "uint32_t", active: "uint32_t", terminated: "uint32_t" });
  const create = kernel.func("void * __stdcall CreateJobObjectW(void *, str16)");
  const set = kernel.func("__stdcall", "SetInformationJobObject", "int", ["void *", "int", koffi.pointer(limits), "uint32_t"]);
  const assign = kernel.func("int __stdcall AssignProcessToJobObject(void *, void *)");
  const current = kernel.func("void * __stdcall GetCurrentProcess()");
  const query = kernel.func("__stdcall", "QueryInformationJobObject", "int", ["void *", "int", koffi.out(koffi.pointer(accounting)), "uint32_t", "void *"]);
  const close = kernel.func("int __stdcall CloseHandle(void *)");
  const lastError = kernel.func("uint32_t __stdcall GetLastError()");
  const values = { basic: { user: 0, jobUser: 0, flags: 0x2000, min: 0, max: 0, count: 0, affinity: 0, priority: 0, scheduling: 0 }, io: [0, 0, 0, 0, 0, 0], processMemory: 0, jobMemory: 0, peakProcess: 0, peakJob: 0 };
  // Null security attributes make this sole Job handle noninheritable. Assign
  // OURSELVES before launching target code: no create-then-assign fork race.
  const job: unknown = create(null, null);
  if (!job || !set(job, 9, values, koffi.sizeof(limits)) || !assign(job, current())) {
    if (job) close(job);
    throw new Error(`Windows Job ownership setup failed (${String(lastError())})`);
  }
  const activeCount = (): number => {
    const info: { active?: number } = {};
    if (!query(job, 1, info, koffi.sizeof(accounting), null) || typeof info.active !== "number" || !Number.isInteger(info.active) || info.active < 1) throw new Error(`Windows Job accounting failed (${String(lastError())})`);
    return info.active;
  };
  return { activeCount, releaseEmpty() {
    if (activeCount() !== 1) throw new Error("Windows Job still owns target processes");
    values.basic.flags = 0;
    if (!set(job, 9, values, koffi.sizeof(limits)) || !close(job)) throw new Error(`Windows Job release failed (${String(lastError())})`);
  } };
}

/** Injectable protocol/ownership seams never send synthetic identities to OS APIs. */
export async function runWindowsOwnedJob(
  runtime: WindowsJobRuntime,
  createJob: () => Promise<WindowsJobOwnership> = createNativeJob,
): Promise<void> {
  if (runtime.platform !== "win32") throw new Error("owned Job helper requires Windows");
  const job = await createJob();
  let poll: NodeJS.Timeout | undefined;
  const exit = (code: number): void => { clearInterval(poll); runtime.exit(code); };
  // Unexpected owner disappearance closes the last handle and terminates all
  // ordinary Job members. No breakaway flags and no process-name discovery.
  runtime.onDisconnect(() => exit(1));
  const releaseEmptyJob = (code: number): void => {
    try {
      job.releaseEmpty();
      runtime.send({ type: "empty" }, () => exit(code));
    } catch (error) {
      runtime.send({ type: "error", code: "EOWNERSHIP", message: error instanceof Error ? error.message : "Windows Job release failed" });
      exit(1);
    }
  };
  runtime.onStart((payload: unknown) => {
    try {
      if (!payload || typeof payload !== "object" || !("argv" in payload) || !Array.isArray(payload.argv) || payload.argv.length === 0 || !payload.argv.every((part: unknown) => typeof part === "string")) throw new Error("invalid owned Job start message");
      if (!("env" in payload) || !payload.env || typeof payload.env !== "object") throw new Error("missing owned Job environment");
      if ("deadlineAt" in payload && typeof payload.deadlineAt === "number" && Date.now() >= payload.deadlineAt) {
        runtime.send({ type: "error", code: "ETIMEDOUT", message: "owned subprocess deadline expired before target start" });
        releaseEmptyJob(1);
        return;
      }
      const child = runtime.spawn(payload.argv as string[], payload.env as NodeJS.ProcessEnv);
      child.once("spawn", () => {
        if (child.pid) runtime.send({ type: "started", pid: child.pid });
        // The target has inherited its copies. The helper must not itself keep
        // capture writers or the input reader open while descendants run.
        runtime.closeInheritedStdio();
      });
      child.once("error", (error: NodeJS.ErrnoException) => {
        runtime.send({ type: "error", code: error.code ?? "EOWNERSHIP", message: error.message });
        releaseEmptyJob(1);
      });
      child.once("exit", (code, signal) => {
        runtime.send({ type: "root_exit", code, signal });
        poll = setInterval(() => {
          try {
            if (job.activeCount() !== 1) return;
            clearInterval(poll);
            releaseEmptyJob(code ?? 1);
          } catch (error) {
            clearInterval(poll);
            runtime.send({ type: "error", code: "EOWNERSHIP", message: error instanceof Error ? error.message : "Windows Job accounting failed" });
            exit(1);
          }
        }, 10);
      });
    } catch (error) {
      runtime.send({ type: "error", code: "EOWNERSHIP", message: error instanceof Error ? error.message : "Windows Job start failed" });
      exit(1);
    }
  });
  runtime.send({ type: "ready" });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.send) process.exit(1);
  runWindowsOwnedJob({
    platform: process.platform,
    send: (message, done) => { if (done) process.send?.(message, done); else process.send?.(message); },
    onStart: (handler) => { process.once("message", handler); },
    onDisconnect: (handler) => { process.once("disconnect", handler); },
    spawn: (argv, env) => spawn(argv[0]!, argv.slice(1), { env, stdio: "inherit", windowsHide: true, shell: false }),
    closeInheritedStdio: () => { for (const fd of [0, 1, 2]) { try { closeSync(fd); } catch { /* already closed */ } } },
    exit: (code) => { process.exit(code); },
  }).catch((error: unknown) => {
    process.send?.({ type: "error", code: "EOWNERSHIP", message: error instanceof Error ? error.message : "Windows Job setup failed" } satisfies OwnedJobMessage, () => process.exit(1));
  });
}
