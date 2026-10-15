#!/usr/bin/env node
// sites-pinned: tests/audit/publish-source-contract.test.ts
// Release source admission only. Qualification and packing consume the returned
// commit; release target_commitish metadata is never ancestry evidence.
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { guardArgv } from "./argvGuard.mjs";

/** @typedef {{status: number | null, stdout: string, stderr: string, error?: Error}} GitResult */
/** @typedef {(args: string[]) => GitResult} Git */
/**
 * @typedef {object} ReleaseSource
 * @property {string} eventSha Captured immutable event object ID.
 * @property {string} eventName
 * @property {string} defaultBranch Trusted repository default branch name.
 * @property {string} ref Full event ref (not ref_name).
 * @property {string} releaseTag Exact release tag name, empty for dispatch.
 * @property {boolean} dryRun
 * @property {string} [expectedSha] Qualification output, required by publish wiring.
 */

/** @param {string} value */
function objectId(value) {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)) {
    throw new Error("Release source must resolve to a full object ID.");
  }
  return value;
}

/** @type {Git} */
const runGit = (args) => spawnSync("git", args, {
  encoding: "utf8", timeout: 120_000, maxBuffer: 1024 * 1024, windowsHide: true,
  env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
});

/**
 * Resolve and validate exactly one commit. Imports do not spawn or write.
 * Git is injectable so failures and disposable local graphs exercise this same
 * algorithm, not a test-only policy. All failures throw before output is emitted.
 * @param {ReleaseSource} input
 * @param {Git} git
 * @returns {string}
 */
export function verifyReleaseSource(input, git = runGit) {
  const eventSha = objectId(input.eventSha);
  if (!["release", "workflow_dispatch"].includes(input.eventName)) {
    throw new Error("Unsupported release source event.");
  }
  const live = input.eventName === "release" || input.dryRun !== true;
  /** @param {string[]} args */
  function command(args) {
    const result = git(["--no-replace-objects", ...args]);
    if (result.error || result.status !== 0 || typeof result.stdout !== "string") {
      throw new Error(`Release source git ${args.slice(0, 2).join(" ")} failed: ${String(result.error ?? result.stderr).slice(0, 1024)}`);
    }
    return result.stdout.trim();
  }
  /** @param {string} revision */
  const resolveCommit = (revision) => objectId(command(["rev-parse", "--verify", `${revision}^{commit}`]));
  /** @param {string} name @param {'heads'|'tags'} kind */
  function validateRef(name, kind) {
    if (!name || name.startsWith("-")) throw new Error(`Invalid release ${kind} ref.`);
    const ref = `refs/${kind}/${name}`;
    command(["check-ref-format", ref]);
    return ref;
  }
  const branchRef = validateRef(input.defaultBranch, "heads");
  const tagRef = input.eventName === "release" ? validateRef(input.releaseTag, "tags") : null;
  if (tagRef && input.ref !== tagRef) throw new Error("Release event ref does not match its exact tag ref.");
  if (live && input.eventName === "workflow_dispatch" && input.ref !== branchRef) {
    throw new Error("Live manual publish must run from the default branch.");
  }
  const commit = resolveCommit(eventSha);
  if (input.expectedSha !== undefined && objectId(input.expectedSha) !== commit) {
    throw new Error("Release source differs from the validated qualification commit.");
  }
  if (resolveCommit("HEAD") !== commit) throw new Error("HEAD differs from the captured release source commit.");
  const requireFullHistory = () => {
    if (command(["rev-parse", "--is-shallow-repository"]) !== "false") {
      throw new Error("Release source has shallow or unresolved history.");
    }
  };
  requireFullHistory();
  if (live) {
    const defaultRef = "refs/remotes/release-source/default";
    const fetchedTagRef = "refs/release-source/event-tag";
    const refspecs = [`+${branchRef}:${defaultRef}`];
    if (tagRef) refspecs.push(`+${tagRef}:${fetchedTagRef}`);
    command(["fetch", "--atomic", "--no-tags", "--force", "origin", ...refspecs]);
    requireFullHistory();
    const defaultCommit = resolveCommit(defaultRef);
    if (tagRef && resolveCommit(fetchedTagRef) !== commit) {
      throw new Error("Release tag no longer matches the captured event commit.");
    }
    // A trivial merge-base (e.g. source == tip) alone need not walk missing
    // parents. Require both complete commit histories before checking ancestry.
    command(["rev-list", "--count", commit, defaultCommit, "--"]);
    command(["merge-base", "--is-ancestor", commit, defaultCommit]);
  }
  return commit;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  guardArgv(process.argv.slice(2), {
    name: "verify-release-source",
    usage: "node scripts/shared/verify-release-source.mjs",
  });
  try {
    const commit = verifyReleaseSource({
      eventSha: process.env.RELEASE_EVENT_SHA ?? "",
      eventName: process.env.RELEASE_EVENT_NAME ?? "",
      defaultBranch: process.env.RELEASE_DEFAULT_BRANCH ?? "",
      ref: process.env.RELEASE_REF ?? "",
      releaseTag: process.env.RELEASE_TAG ?? "",
      dryRun: process.env.RELEASE_DRY_RUN === "true",
      expectedSha: process.env.VERIFIED_RELEASE_SHA,
    });
    if (!process.env.GITHUB_OUTPUT) throw new Error("Missing GITHUB_OUTPUT for verified release source.");
    appendFileSync(process.env.GITHUB_OUTPUT, `commit=${commit}\n`);
    console.log(`Verified release source: ${commit}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
