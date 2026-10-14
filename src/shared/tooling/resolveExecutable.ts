// sites-pinned: tests/shared/resolve-executable.test.ts
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { posix, win32 } from "node:path";

export interface ExecutableLookupOptions {
  platform?: NodeJS.Platform;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Follows normal installation symlinks; returns physical spelling or absence. */
  executableFile?: (path: string, platform: NodeJS.Platform) => string | null;
}

/** Deterministic PATH lookup: no shell and no implicit Windows cwd search. */
export function resolveExecutableFile(name: string, options: ExecutableLookupOptions = {}): string | null {
  const platform = options.platform ?? process.platform;
  const cwd = options.cwd ?? process.cwd();
  const env = { ...(options.env ?? process.env) };
  const paths = platform === "win32" ? win32 : posix;
  const value = (key: string): string | undefined => platform === "win32"
    ? env[Object.keys(env).find(k => k.toUpperCase() === key) ?? key]
    : env[key];
  const pathValue = value("PATH");
  if (pathValue === undefined) return null;
  const admit = options.executableFile ?? ((file: string, os: NodeJS.Platform): string | null => {
    try {
      if (!statSync(file).isFile()) return null;
      if (os !== "win32") accessSync(file, constants.X_OK);
      return realpathSync(file);
    } catch { return null; }
  });
  const supported = new Set([".COM", ".EXE", ".BAT", ".CMD"]);
  const extensions = (value("PATHEXT") ?? ".COM;.EXE;.BAT;.CMD")
    .split(";").filter(ext => supported.has(ext.toUpperCase()));
  const ext = paths.extname(name);
  const names = platform !== "win32" ? [name]
    : supported.has(ext.toUpperCase()) ? [name]
      : extensions.map(extension => name + extension);
  for (let directory of pathValue.split(platform === "win32" ? ";" : ":")) {
    if (platform === "win32" && directory.startsWith('"') && directory.endsWith('"')) directory = directory.slice(1, -1);
    for (const file of names) {
      const admitted = admit(paths.resolve(cwd, directory, file), platform);
      if (admitted !== null) return admitted;
    }
  }
  return null;
}
