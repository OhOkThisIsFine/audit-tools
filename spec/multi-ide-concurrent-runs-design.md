# Multi-agent cooperative runs — design of record

Audit-tools coordinates shared repository state; it does not coordinate execution resources.
Any number of IDEs or agents may help with one audit or remediation run, but the conversation host
owns assignment, concurrency, retries, and recovery.

## Contract

There is one shared audit state tree and one shared remediation state tree per repository. A host
joins the current run by reading the next step or prepared workload, executing only the work it was
given, and returning results through the documented ingestion boundary.

Cooperation rests on four rules:

1. **Emit complete work.** Every host workload contains stable work-item ids, the full prompt, a
   prompt digest, declared scope, deterministic metadata, and an exact result path. A host does not
   need hidden routing state to execute it.
2. **Bind every result.** Ingestion checks the workload version, run id, work-item id, prompt digest,
   and declared task or finding coverage before accepting a result.
3. **Serialize shared mutation.** Result and state stores use the shared locked JSON/file-lock
   substrate for read-modify-write transitions. Hosts may execute concurrently; accepted mutations
   still land atomically.
4. **Make replay harmless.** Accepted audit results are idempotent at the ledger boundary.
   Remediation ingestion records completed work items in state, so replay cannot advance the same
   item twice.

## Audit

The audit handoff writer in src/audit/cli/dispatch/hostHandoff.ts emits a versioned workload and
persists its trusted task bindings beneath the run directory. The host may split or schedule that
work however it chooses.

The ingestion path accepts only results that match those persisted bindings and the assigned file
coverage. Missing, malformed, stale, or mismatched results remain pending and are reported
explicitly. Accepted results enter the append-only audit ledger and the normal artifact/staleness
pipeline.

Concurrent hosts therefore cooperate by consuming disjoint workload items and submitting bound
results. Audit-tools never needs a provider roster, claim registry, execution lease, or worker
heartbeat to make that safe.

## Remediation

The remediation boundary in src/remediate/steps/dispatch/hostHandoff.ts derives the dependency-ready
frontier and emits complete work items. Each item carries its allowed files, baseline commit,
required tests, prompt digest, and result path.

Ingestion re-reads the persisted handoff record and verifies result identity, commit ancestry,
changed-file evidence, run-start dirt overlap, and required-test evidence before advancing state.
A result that fails any check remains pending. The state transition is persisted through the locked
state store in src/remediate/state/store.ts.

The host owns worktree creation and concurrency. Audit-tools owns the evidence required to prove
that the host's completed work is the work that was emitted.

## Shared-state behavior

- A second host reads current state before choosing work; it does not rely on a cached frontier.
- Only dependency-ready remediation items may appear in a workload.
- A result for an old workload or prompt is rejected, even if its work-item id still exists.
- Missing results are normal partial progress, not permission to infer success.
- No host, IDE, provider, model, or routing identity is persisted as workflow authority.
- Shared current-step files are observability artifacts. Correctness comes from the returned step
  contract and persisted workload/result bindings, not from which process wrote a prompt last.

## Non-goals

- Audit-tools does not launch workers or choose execution backends.
- Audit-tools does not meter quota, size work to model windows, or maintain execution leases.
- Audit-tools does not promise that two hosts will choose disjoint items without coordination.
  The host is responsible for assignment; duplicate submissions are contained by binding and
  idempotent ingestion.
- Audit-tools does not maintain an agent roster, presence protocol, or per-IDE run namespace.

This is a cooperative data contract, not an internal scheduler. The durable safety property is that
concurrent execution may produce partial or duplicate submissions, but it cannot make unbound work
look accepted or corrupt shared state.
