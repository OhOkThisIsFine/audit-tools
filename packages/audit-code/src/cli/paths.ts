import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Absolute path to the package root (packages/audit-code). Computed relative to
// this module's location (src/cli/), so it stays correct regardless of which
// command module imports it. Shared by renderSemanticReviewStep and
// cmdRunToCompletion to locate packaged assets when preparing dispatch.
export const packageRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
