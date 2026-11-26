// sites-pinned: tests/shared/vitest-windows-cancellation.test.ts
import { basename, resolve } from "node:path";

export function isWindowsNpmTest(repoRoot, platform, env) {
  return platform === "win32" && ["test", "test:single"].includes(env.npm_lifecycle_event ?? "") &&
    typeof env.npm_package_json === "string" &&
    resolve(env.npm_package_json).toLowerCase() === resolve(repoRoot, "package.json").toLowerCase();
}

/** Track the cmd.exe and npm Node ancestors by open handles, never by later PID lookup. */
export async function watchNpmTestOwner(onExit) {
  const { default: koffi } = await import("koffi");
  const kernel = koffi.load("kernel32.dll");
  const entry = koffi.struct({
    size: "uint32_t", usage: "uint32_t", pid: "uint32_t", heap: "uintptr_t",
    module: "uint32_t", threads: "uint32_t", parent: "uint32_t",
    priority: "int32_t", flags: "uint32_t", image: koffi.array("char", 260),
  });
  const snapshot = kernel.func("void * __stdcall CreateToolhelp32Snapshot(uint32_t, uint32_t)");
  const first = kernel.func("__stdcall", "Process32First", "int", ["void *", koffi.inout(koffi.pointer(entry))]);
  const next = kernel.func("__stdcall", "Process32Next", "int", ["void *", koffi.inout(koffi.pointer(entry))]);
  const open = kernel.func("void * __stdcall OpenProcess(uint32_t, int, uint32_t)");
  const wait = kernel.func("uint32_t __stdcall WaitForSingleObject(void *, uint32_t)");
  const close = kernel.func("int __stdcall CloseHandle(void *)");
  const getTimes = kernel.func("int __stdcall GetProcessTimes(void *, _Out_ uint64_t *, _Out_ uint64_t *, _Out_ uint64_t *, _Out_ uint64_t *)");
  const creation = handle => {
    const value = [0n];
    if (!getTimes(handle, value, [0n], [0n], [0n])) throw new Error("Could not verify npm test ancestor identity.");
    return BigInt(value[0]);
  };
  const rows = new Map();
  const snap = snapshot(2, 0); // TH32CS_SNAPPROCESS
  if (!snap || BigInt.asIntN(64, koffi.address(snap)) === -1n) throw new Error("Could not read npm test process ancestry.");
  try {
    const row = { size: koffi.sizeof(entry) };
    for (let ok = first(snap, row); ok; ok = next(snap, row)) rows.set(row.pid, { parent: row.parent, image: row.image.toLowerCase() });
  } finally {
    close(snap);
  }

  const handles = [];
  try {
    const read = pid => {
      // SYNCHRONIZE + PROCESS_QUERY_LIMITED_INFORMATION; never request termination rights.
      const handle = open(0x101000, 0, pid);
      if (!handle) throw new Error("The Windows npm test owner exited before Vitest started.");
      handles.push(handle);
      return handle;
    };
    const gateAge = creation(read(process.pid));
    const parent = rows.get(process.ppid);
    const npmPid = parent?.image === "cmd.exe" ? parent.parent : process.ppid;
    if (rows.get(npmPid)?.image !== basename(process.execPath).toLowerCase()) {
      throw new Error("Could not identify the Windows npm test owner.");
    }
    const shellHandle = npmPid === process.ppid ? undefined : read(process.ppid);
    const shellAge = shellHandle ? creation(shellHandle) : gateAge;
    const npmAge = creation(read(npmPid));
    if (npmAge > shellAge || shellAge > gateAge) throw new Error("The Windows npm test owner was replaced before Vitest started.");
    const gone = () => handles.slice(1).some(handle => wait(handle, 0) !== 258); // WAIT_TIMEOUT means alive.
    if (gone()) throw new Error("The Windows npm test owner exited before Vitest started.");
    const timer = setInterval(() => {
      if (gone()) {
        clearInterval(timer);
        onExit();
      }
    }, 100);
    timer.unref();
    return () => { clearInterval(timer); for (const handle of handles) close(handle); };
  } catch (error) {
    for (const handle of handles) close(handle);
    throw error;
  }
}
