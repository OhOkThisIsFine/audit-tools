import { realpathSync } from "node:fs";
import { dirname } from "node:path";

// A live Windows process pins its working directory. Run both halves of
// the stdio wrapper outside the installed package. Callers capture the real
// invocation directory before this change; MCP submissions use absolute paths.
export function windowsStdioCwd(packageRoot) {
  const outside = dirname(realpathSync(packageRoot));
  process.chdir(outside);
  return outside;
}
