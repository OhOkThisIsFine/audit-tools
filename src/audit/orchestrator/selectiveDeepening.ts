// Public entry for selective deepening. The implementation was split by
// task-building strategy into ./selectiveDeepening/ (finding-followup, conflict,
// high-risk-clean, runtime-validation, lens-verification, steward-followup) with
// the shared primitives in ./selectiveDeepening/shared.ts. This barrel preserves
// the original module path so importers and tests are unaffected.
export {
  buildSelectiveDeepeningTasks,
} from "./selectiveDeepening/index.js";
export type { BuildSelectiveDeepeningTaskOptions } from "./selectiveDeepening/index.js";
