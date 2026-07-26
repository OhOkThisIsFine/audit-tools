// Process + logging substrate shared by every smoke script.
//
// The linked and packaged smokes are the same flow run against two installation
// shapes, so their spawn/quote/log helpers were byte-identical copies. A copy is
// a drift source: a fix applied to one silently leaves the other behind. This is
// the single home — a smoke script names its own label and gets the rest.

import { spawn } from "node:child_process";
import { formatCommand, resolveSpawn } from "./spawn-shell.mjs";

export function platformCommand(base) {
  return process.platform === "win32" ? `${base}.cmd` : base;
}

// `[smoke:linked] step: …` style progress lines, keyed to one smoke's label.
export function createSmokeLog(smokeLabel) {
  const prefix = `[smoke:${smokeLabel}]`;
  const write = (kind, message) =>
    process.stderr.write(`${prefix} ${kind}: ${message}\n`);
  return {
    prefix,
    step: (label) => write("step", label),
    detail: (message) => write("detail", message),
    success: (message) => write("success", message),
    warning: (message) => write("warning", message),
    elapsed: (label, startedAt) =>
      process.stderr.write(`${prefix} elapsed: ${label} — ${Date.now() - startedAt}ms\n`),
  };
}

function buildCommandFailureMessage({
  prefix,
  label,
  command,
  args,
  cwd,
  code,
  stdout,
  stderr,
  failureHint,
}) {
  const detailSections = [];
  if (stderr.trim().length > 0) {
    detailSections.push(`stderr:\n${stderr.trim()}`);
  }
  if (stdout.trim().length > 0) {
    detailSections.push(`stdout:\n${stdout.trim()}`);
  }

  const lines = [
    `${prefix} ${label} failed with exit code ${code}.`,
    `command: ${formatCommand(command, args)}`,
    `cwd: ${cwd}`,
  ];
  if (failureHint) {
    lines.push(`hint: ${failureHint}`);
  }
  if (detailSections.length > 0) {
    lines.push(detailSections.join("\n---\n"));
  } else {
    lines.push("No stdout/stderr was captured from the failed command.");
  }
  return lines.join("\n");
}

// Returns a runCommand bound to one smoke's label + default cwd. Rejects with a
// message carrying the command, cwd, captured output and the caller's hint —
// a gate that catches a broken CLI must say WHY.
export function createRunCommand({ smokeLabel, defaultCwd }) {
  const prefix = `[smoke:${smokeLabel}]`;
  return function runCommand(command, args, options = {}) {
    return new Promise((resolve, reject) => {
      const resolved = resolveSpawn(command, args);
      const cwd = options.cwd ?? defaultCwd;
      const label = options.label ?? formatCommand(command, args);
      const child = spawn(resolved.command, resolved.args, {
        cwd,
        env: options.env ?? process.env,
        stdio: ["ignore", "pipe", "pipe"],
        // Suppress the console window a windowless parent pops when spawning a
        // console child (npm, the packaged bins) on win32.
        windowsHide: true,
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
        if (options.liveOutput) process.stdout.write(chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
        if (options.liveOutput) process.stderr.write(chunk);
      });
      child.on("error", reject);
      child.on("exit", (code) => {
        if (code === 0) {
          resolve({ stdout, stderr });
          return;
        }
        reject(new Error(buildCommandFailureMessage({
          prefix,
          label,
          command,
          args,
          cwd,
          code,
          stdout,
          stderr,
          failureHint: options.failureHint,
        })));
      });
    });
  };
}
