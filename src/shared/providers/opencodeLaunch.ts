import { existsSync } from "node:fs";
import { join } from "node:path";
import { quoteForShellInterpreterCmd } from "../tooling/exec.js";

const PROBE_SHIM_EXTENSIONS = [".cmd", ".bat", ".ps1"];

/** Injectable so callers/tests can avoid real filesystem/PATH dependence. */
export type ShimExtensionProbe = (command: string) => string | undefined;

/**
 * Best-effort PATH probe for a bare, extension-less command outside the
 * hardcoded `shimBaseNames` allowlist. An npm/pnpm/bun-installed JS CLI is
 * almost always a `.cmd`/`.ps1` shim on Windows regardless of whether its
 * bare name was anticipated here, so a caller invoking an unlisted bare
 * command would otherwise silently skip the shell wrap and hit an ENOENT from
 * `spawn` (which does not do PATHEXT resolution without a shell).
 */
function defaultShimExtensionProbe(command: string): string | undefined {
  if (/[\\/]/.test(command)) return undefined;
  const pathEnv = process.env.PATH ?? process.env.Path ?? "";
  for (const dir of pathEnv.split(";").filter(Boolean)) {
    for (const ext of PROBE_SHIM_EXTENSIONS) {
      try {
        if (existsSync(join(dir, `${command}${ext}`))) return ext;
      } catch {
        // Unreadable PATH entry — skip and keep probing.
      }
    }
  }
  return undefined;
}

/**
 * Resolve how to spawn a package-manager-installed CLI shim per platform. On
 * Windows an npm/pnpm/bun-installed CLI on PATH is a `.cmd` / `.ps1` batch shim
 * (or the bare launcher name) that Node's `spawn` cannot execute without a
 * shell, so it must go through `cmd.exe`. On every other platform the command
 * and args pass through unchanged. Single-sourced so every provider that drives
 * such a shim (opencode, codex, …) routes through identical, correctly-quoted
 * logic rather than each re-deriving — and accidentally diverging on — it.
 *
 * `shimBaseNames` are the bare launcher names that must be wrapped even without a
 * recognized extension (e.g. `opencode`, `codex`, `npx`). The per-token cmd.exe
 * quoting reuses the canonical `quoteForShellInterpreterCmd` from exec.ts.
 */
export function resolveWindowsShimSpawnCommand(
  command: string,
  args: string[],
  shimBaseNames: readonly string[],
  platform: NodeJS.Platform = process.platform,
  shellCommand: string = process.env.ComSpec ?? "cmd.exe",
  probeShimExtension: ShimExtensionProbe = defaultShimExtensionProbe,
): { command: string; args: string[] } {
  if (platform !== "win32") {
    return { command, args };
  }
  const hasRecognizedExt = /\.(cmd|bat|exe|ps1)$/i.test(command);
  const base = command.replace(/\.(cmd|bat|exe|ps1)$/i, "").toLowerCase();
  const needsShim =
    shimBaseNames.includes(base) ||
    command.endsWith(".cmd") ||
    command.endsWith(".ps1") ||
    // Outside the hardcoded allowlist: probe PATH for a .cmd/.bat/.ps1 shim so
    // an unanticipated JS-installed CLI still gets wrapped instead of ENOENT-ing.
    (!hasRecognizedExt && probeShimExtension(command) !== undefined);
  if (needsShim) {
    return {
      command: shellCommand,
      args: ["/d", "/s", "/c", [command, ...args].map(quoteForShellInterpreterCmd).join(" ")],
    };
  }
  return { command, args };
}

/**
 * Resolve how to spawn an `opencode` invocation per platform. Thin wrapper over
 * the shared {@link resolveWindowsShimSpawnCommand} with opencode's launcher
 * names. Shared by the opencode provider in both orchestrators so neither
 * silently loses the Windows shim.
 */
export function resolveOpenCodeSpawnCommand(
  command: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
  shellCommand: string = process.env.ComSpec ?? "cmd.exe",
  probeShimExtension?: ShimExtensionProbe,
): { command: string; args: string[] } {
  return resolveWindowsShimSpawnCommand(
    command,
    args,
    ["opencode", "npx"],
    platform,
    shellCommand,
    probeShimExtension,
  );
}
