import { readOptionalJsonFile } from "../io/json.js";
import { createReservationLedger } from "../quota/reservationLedger.js";
import type { DispatchAdmission } from "./admissionLoop.js";

/**
 * Reconcile (free) the reservation-ledger leases a dispatch grant took for a run's
 * granted set — the "reconcile at result-ingest" half of admission control
 * (spec/audit/dispatch-admission-control.md). Once the host has reported the granted
 * set's results those reservations are no longer in flight, so their budget returns
 * to the shared account for the NEXT grant.
 *
 * Single-sourced across both orchestrators (audit `mergeAndIngest` + remediate
 * `mergeImplementResults`) so the best-effort semantics can't drift: reading a lease
 * is provider/domain-neutral, so unlike the launch-input or contract-adjudication
 * paths there is no read-only-vs-git-mutating split to keep forked. Each orchestrator
 * resolves its own `dispatch-quota.json` path and passes it here.
 *
 * Best-effort + token-checked (a missing/already-freed lease is a no-op), so a lost
 * reconcile self-heals via the lease TTL and never blocks ingestion. Only the
 * host-subagent grant persists leases (`grantLeases: true`); the in-process path
 * leases per-packet in the rolling engine and reconciles there.
 */
export async function reconcileAdmissionLeasesFromQuotaFile(
  quotaFilePath: string,
): Promise<void> {
  const quota = await readOptionalJsonFile<{ admission?: DispatchAdmission }>(
    quotaFilePath,
  );
  const leases = quota?.admission?.leases;
  if (!leases || leases.length === 0) return;
  const ledger = createReservationLedger();
  for (const lease of leases) {
    try {
      await ledger.reconcile(lease.resource_key, lease.lease_id);
    } catch {
      // Best-effort: the lease TTL reclaims budget if a reconcile is lost.
    }
  }
}
