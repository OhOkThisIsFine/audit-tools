import { dropAcceptedResults } from "./dispatch/hostHandoff.js";
import {
  getArtifactsDir,
  getFlag,
  getRootDir,
  hasFlag,
} from "./args.js";
import { loadCurrentActiveReviewRun } from "./reviewRun.js";

/**
 * `audit-code unaccept-results --work-item <id> [--work-item <id> …] | --all`
 *
 * Remove entries from the run's accepted host-results pair — the supported path
 * back out of an acceptance, per the recovery-verb doctrine: operator-facing,
 * refusing what it cannot validate (the strict accepted-ledger loader throws on
 * a corrupt pair), recording the removal so a repaired run stays
 * distinguishable from a clean one, and invalidating the persisted step
 * contract. After dropping, the next fold re-reads the bound result files.
 *
 * Argument validation lives in {@link dropAcceptedResults} — the ONE copy of
 * the "requires --work-item or --all" refusal; this command parses argv only.
 *
 * The run id resolves from the persisted review-run manifest, not an argv flag:
 * the operator names WHAT to drop, never WHERE the state lives.
 */
export async function cmdUnacceptResults(argv: string[]): Promise<void> {
  const root = getRootDir(argv);
  const artifactsDir = getArtifactsDir(argv);
  const all = hasFlag(argv, "--all");
  const workItemIds = argv
    .flatMap((token, index) =>
      token === "--work-item" ? [argv[index + 1]] : [],
    )
    .filter((value): value is string => typeof value === "string");

  // Canonical run resolution: the same manifest `next-step`'s ingest fold reads.
  // A hand-supplied run id would be a second way to be wrong about which state
  // is being mutated.
  const overrideRunId = getFlag(argv, "--run-id");
  const runId =
    overrideRunId ?? (await loadCurrentActiveReviewRun(artifactsDir))?.run_id;
  if (runId === undefined) {
    throw new Error(
      `unaccept-results could not resolve the active review run under ${artifactsDir} ` +
        "(no dispatch manifest); pass --run-id <id> only if the manifest was removed",
    );
  }

  const outcome = await dropAcceptedResults({
    root,
    artifactsDir,
    runId,
    ...(all ? { all: true } : { workItemIds }),
  });

  console.log(
    JSON.stringify(
      {
        status: "unaccepted",
        run_id: runId,
        dropped_work_item_ids: outcome.dropped_work_item_ids,
        next: "audit-code next-step re-reads the bound result files for the dropped items",
      },
      null,
      2,
    ),
  );
}
