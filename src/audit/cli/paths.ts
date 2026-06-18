import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Absolute path to the package root (the single `audit-tools` package). Computed
// relative to this module's location (src/audit/cli/ in source, dist/audit/cli/
// when built), so it stays correct regardless of which command module imports it.
// Three levels up reaches the package root, which holds the packaged asset dirs
// (dispatch/, schemas/, skills/). Shared by renderSemanticReviewStep and
// cmdRunToCompletion to locate packaged assets when preparing dispatch.
export const packageRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
