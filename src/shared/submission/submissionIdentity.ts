/**
 * The ONE tool-owned submission path rule.
 *
 * A host submission lands at `<submissionDir>/<sha256(submission_id)>.json` and
 * nowhere else. The id is minted by the tool at step-emit time and the path is
 * derived from it, so a host cannot invent, mistype, or re-render the name of a
 * file the tool will read — a write to any other path is simply not read.
 *
 * Both draws share this module: the audit host handoff binds its work-item
 * results through it, and the audit gate lanes bind their submissions through
 * it. It replaces the two hand-rolled `resultPathFor` copies that carried the
 * same rule in two places.
 */
import { relative, resolve } from "node:path";
import { resolveWithinRoot } from "../io/pathContainment.js";

import { hashContent } from "../hash.js";
import { stableStringify } from "../stableStringify.js";

/**
 * Where submissions live for one draw: the repository root a bound path is
 * expressed relative to, and the directory the payload files sit in.
 */
export interface SubmissionRoots {
  readonly root: string;
  readonly submissionDir: string;
}

/** The identity components a submission id is derived from. */
export interface SubmissionIdParts {
  /** The obligation/gate family the submission answers. */
  readonly kind: string;
  /** The content-coherent lane within that family. */
  readonly lane: string;
  /** The run (or run-equivalent scope) the lane belongs to. */
  readonly runId: string;
}

/** Non-path-safe characters collapse so the id stays readable in a ledger. */
function slug(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "");
}

/**
 * Mint the submission id for one lane. DETERMINISTIC: the same kind + lane +
 * run always yields the same id, so a re-emitted step re-declares the identical
 * bound path and an already-satisfied lane is recognized on resume (K-of-N).
 * No timestamp, no randomness — an id that changed per call would re-ask for
 * work the host already delivered.
 *
 * The readable prefix is for humans reading the ledger; the trailing digest is
 * what makes distinct lanes distinct.
 */
export function mintSubmissionId(parts: SubmissionIdParts): string {
  const digest = hashContent(
    stableStringify({ kind: parts.kind, lane: parts.lane, run_id: parts.runId }),
    { length: 16 },
  );
  return `${slug(parts.kind)}.${slug(parts.lane)}.${digest}`;
}

/** The single filename rule: the sha256 of the id, nothing else. */
function submissionFilename(submissionId: string): string {
  if (typeof submissionId !== "string" || submissionId.length === 0) {
    throw new Error("submission id must be a non-empty string");
  }
  return `${hashContent(submissionId)}.json`;
}

/**
 * Absolute on-disk path of one submission payload.
 *
 * The containment of the landing path is CHECKED, never inferred from the fact
 * that `submissionFilename` happens to hash. Hashing is what makes an escape
 * impossible today; `resolveContainedPath` is what makes it impossible to
 * REINTRODUCE one — a future filename derivation that passed the id through
 * would otherwise steer a write outside `submissionDir` with nothing going red.
 * The refusal fires here, before any caller has a path to write to.
 */
export function absoluteSubmissionPath(
  paths: SubmissionRoots,
  submissionId: string,
): string {
  return resolveContainedPath(
    paths.submissionDir,
    submissionFilename(submissionId),
    `submission landing path for ${submissionId}`,
  );
}

/**
 * The bound path as it is declared in a step contract and rendered to a host:
 * repository-relative and forward-slashed, so the same contract reads
 * identically on win32 / darwin / linux.
 */
export function submissionPathFor(
  paths: SubmissionRoots,
  submissionId: string,
): string {
  return repoRelativePath(
    paths.root,
    absoluteSubmissionPath(paths, submissionId),
    `submission path for ${submissionId}`,
  );
}

/**
 * Resolve `candidate` against `base` and refuse anything that escapes it. The
 * containment rule both host handoffs hand-rolled.
 */
export function resolveContainedPath(
  base: string,
  candidate: string,
  label: string,
): string {
  const absoluteBase = resolve(base);
  // Predicate from the ONE containment guard; only the error message (pinned
  // by the submission-path tests) stays caller-specific.
  const resolved = resolveWithinRoot(absoluteBase, candidate);
  if (resolved === null) {
    throw new Error(`${label} must remain beneath ${absoluteBase}`);
  }
  return resolved;
}

/** Repository-relative, forward-slashed form of a contained absolute path. */
export function repoRelativePath(
  root: string,
  absolutePath: string,
  label: string,
): string {
  const contained = resolveContainedPath(root, absolutePath, label);
  const rel = relative(resolve(root), contained).replaceAll("\\", "/");
  if (rel.length === 0) {
    throw new Error(`${label} must identify a path beneath the repository root`);
  }
  return rel;
}

/**
 * The shared run-id grammar. A run id becomes a directory segment, so it may
 * carry nothing that could climb out of the artifacts tree.
 */
export function assertSubmissionRunId(runId: string, label = "run id"): void {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(runId) ||
    runId === "." ||
    runId === ".."
  ) {
    throw new Error(`Invalid ${label}: ${JSON.stringify(runId)}`);
  }
}
