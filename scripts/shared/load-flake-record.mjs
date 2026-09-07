// Tool-owned record for the exact full-suite-fail / isolated-pass observation.
// It is intentionally FILE-scoped: the gate reruns a whole failing file, so a
// file is the narrowest claim the tool can prove without guessing which leaf a
// solo pass repaired. Every occurrence is bound to a worktree tree id; rerunning
// the same red command on unchanged content cannot manufacture a recurrence.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { withFileLock } from "../../dist/shared/io/fileLock.js";

export const LOAD_FLAKE_RECORD_SCHEMA = 1;

export function emptyLoadFlakeRecord() {
  return { schema: LOAD_FLAKE_RECORD_SCHEMA, environments: {} };
}

export function readLoadFlakeRecord(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (
      parsed?.schema === LOAD_FLAKE_RECORD_SCHEMA &&
      parsed.environments &&
      typeof parsed.environments === "object"
    ) {
      return parsed;
    }
  } catch {}
  return emptyLoadFlakeRecord();
}

export function observationFor(record, environment, file) {
  return record?.environments?.[environment]?.files?.[file] ?? null;
}

/**
 * Fold one gate-proven observation into the record.
 * @returns {{record: any, observation: any, added: boolean, repeated: boolean}}
 */
export function addLoadOnlyObservation({ record, environment, file, tree, observedAt }) {
  const priorBucket = record?.environments?.[environment] ?? { files: {} };
  const prior = priorBucket.files?.[file] ?? {
    count: 0,
    observed_trees: [],
    first_observed_at: observedAt,
    last_observed_at: observedAt,
    investigation_requested_at: null,
    investigation_report: null,
  };
  const alreadyObserved = prior.observed_trees.includes(tree);
  const observation = alreadyObserved
    ? prior
    : {
        ...prior,
        count: prior.count + 1,
        observed_trees: [...prior.observed_trees, tree],
        last_observed_at: observedAt,
      };
  const next = {
    schema: LOAD_FLAKE_RECORD_SCHEMA,
    environments: {
      ...record.environments,
      [environment]: {
        ...priorBucket,
        files: { ...priorBucket.files, [file]: observation },
      },
    },
  };
  return { record: next, observation, added: !alreadyObserved, repeated: observation.count >= 2 };
}

export function markInvestigationRequested({ record, environment, file, requestedAt, reportPath }) {
  const prior = observationFor(record, environment, file);
  if (!prior) return record;
  const bucket = record.environments[environment];
  return {
    ...record,
    environments: {
      ...record.environments,
      [environment]: {
        ...bucket,
        files: {
          ...bucket.files,
          [file]: {
            ...prior,
            investigation_requested_at: requestedAt,
            investigation_report: reportPath,
          },
        },
      },
    },
  };
}

export function writeLoadFlakeRecord(path, record) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  renameSync(temp, path);
}

/**
 * Serialize the record's complete read-fold-write transaction. The callback may
 * wait for a child process to emit `spawn`: keeping that claim inside the lock
 * means a second failing suite cannot start the same investigation meanwhile.
 * @template T
 * @param {string} path
 * @param {(record: any) => Promise<{record: any, value: T}>} mutate
 * @returns {Promise<T>}
 */
export async function mutateLoadFlakeRecord(path, mutate) {
  return withFileLock(`${path}.lock`, async () => {
    const { record, value } = await mutate(readLoadFlakeRecord(path));
    writeLoadFlakeRecord(path, record);
    return value;
  });
}

/**
 * Atomically fold one observation and, once it is repeated, claim its single
 * investigation. `startInvestigation` runs while the record lock is held so
 * concurrent suites cannot both dispatch. A failed start is recorded only as
 * evidence, not as a claim; a later observation (including the same tree) may
 * retry it.
 * @param {object} input
 * @param {string} input.path
 * @param {string} input.environment
 * @param {string} input.file
 * @param {string} input.tree
 * @param {string} input.observedAt
 * @param {(observation: any) => Promise<{started: boolean, requestedAt?: string,
 *   reportPath?: string, error?: unknown}>} input.startInvestigation
 */
export async function observeAndClaimLoadFlake({
  path,
  environment,
  file,
  tree,
  observedAt,
  startInvestigation,
}) {
  return mutateLoadFlakeRecord(path, async (current) => {
    const prior = observationFor(current, environment, file);
    const folded = addLoadOnlyObservation({ record: current, environment, file, tree, observedAt });
    let next = folded.record;
    let investigation = { attempted: false, started: false };

    if (folded.repeated && !folded.observation.investigation_requested_at) {
      try {
        investigation = { attempted: true, ...(await startInvestigation(folded.observation)) };
      } catch (error) {
        investigation = { attempted: true, started: false, error };
      }
      if (investigation.started) {
        if (!investigation.requestedAt || !investigation.reportPath) {
          throw new Error("a started load-flake investigation must name requestedAt and reportPath");
        }
        next = markInvestigationRequested({
          record: next,
          environment,
          file,
          requestedAt: investigation.requestedAt,
          reportPath: investigation.reportPath,
        });
      }
    }

    return { record: next, value: { prior, folded, investigation } };
  });
}
