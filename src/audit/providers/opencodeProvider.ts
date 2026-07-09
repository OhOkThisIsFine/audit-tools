// The opencode provider class AND its construction factory are single-sourced
// in audit-tools/shared (drift-plan E4). opencode has no skip-permissions
// flag, so there is no per-orchestrator delta — this module is a pure
// re-export preserving the import surface `./providers/index.ts` and tests
// rely on.
export { createOpenCodeProvider, OpenCodeProvider } from "audit-tools/shared";
