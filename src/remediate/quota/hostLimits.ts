import { buildHostLimitBindings } from "audit-tools/shared";
import { REMEDIATE_CODE_DESCRIPTOR } from "../providers/index.js";

// The quota half of the per-orchestrator draw: the env prefix is declared once,
// on the descriptor, and the shared binding builder does the rest.
export const { detectHostActiveSubagentLimit, resolveHostActiveSubagentLimit } =
  buildHostLimitBindings(REMEDIATE_CODE_DESCRIPTOR);
