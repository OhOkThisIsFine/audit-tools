/**
 * Provider-neutral audit handoff boundary.
 *
 * Audit-tools derives the pending semantic-review tasks, publishes their
 * complete workload, and validates the host's bound results. It does not
 * launch workers, admit packets, choose a backend, or track execution quota.
 */
export { buildPendingAuditTasks } from "./dispatch/packetFilter.js";
export {
  dropAcceptedResults,
  ingestAuditHostResults,
  prepareAuditHostHandoff,
  type AuditHostIngestSummary,
  type AuditHostResultMap,
  type AuditHostResultMapEntry,
  type AuditHostTask,
  type AuditHostWorkItem,
  type AuditHostWorkload,
  type PreparedAuditHostHandoff,
} from "./dispatch/hostHandoff.js";
