import { realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, sep } from "node:path";

// A live Windows process pins its working directory and hence the npm package
// containing it. Neither half of the long-lived stdio wrapper should pin it.
// Capture the real caller separately; the child's CWD is not caller evidence.
export function windowsStdioCwd(packageRoot, caller) {
  const physicalRoot = realpathSync(packageRoot);
  const relativeCaller = relative(physicalRoot, realpathSync(caller));
  const outside = dirname(physicalRoot);
  if (!isAbsolute(relativeCaller) && relativeCaller !== ".." && !relativeCaller.startsWith(`..${sep}`)) {
    process.chdir(outside);
  }
  return outside;
}
