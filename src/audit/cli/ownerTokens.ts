// ownerTokens.ts — run-scoped sidecar persisting audit-task claim owner
// tokens (D-66/67 slice-1, Part A: merge-time ownership gate).
//
// `dispatch.ts` captures `ownerTokenByNode` from `ClaimRegistry.claimMany`
// (task-claims.json) at dispatch time; `mergeAndIngestCommand.ts` reads it
// back at merge time to `heartbeat()`-verify a terminal task's claim is still
// ours before folding its result into the ingest and clearing its claim. A
// task whose lease was reclaimed by a peer (token rotated) fails the
// heartbeat and is excluded — see the ownership gate in mergeAndIngest.
//
// Deliberately RUN-SCOPED (`runs/<runId>/owner-tokens.json`), never parked on
// `active-dispatch.json`: that file is ONE per artifactsDir (no runId in its
// path) and is wholly rebuilt by `prepareDispatchArtifacts` every round, so
// tokens written there would be clobbered by this same run's next dispatch
// round or a cooperative peer's run — defeating the gate exactly where it
// matters. This sidecar instead merges ADDITIVELY per task_id, mirroring how
// `node-claims.json` is run-scoped on the remediate side.
//
// Tokens are opaque local strings minted by `ClaimRegistry`, not secrets.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isFileMissingError, withFileLock, writeJsonFile } from "audit-tools/shared";

type OwnerTokenMap = Record<string, string>;

/** `<runDir>/owner-tokens.json` — see module doc for why this is run-scoped. */
export function ownerTokensPath(runDir: string): string {
  return join(runDir, "owner-tokens.json");
}

function lockPathFor(path: string): string {
  return `${path}.lock`;
}

// Degrades ANY missing/malformed content to `{}` ("no token known for any
// task") rather than throwing — a corrupt or absent sidecar must never crash
// dispatch or merge; at worst every task reads as tokenless, which is the
// gate's documented fail-open case. Mirrors ClaimRegistry's own readClaimMap.
async function readOwnerTokenMap(path: string): Promise<OwnerTokenMap> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isFileMissingError(error)) return {};
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: OwnerTokenMap = {};
  for (const [taskId, token] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof token === "string") out[taskId] = token;
  }
  return out;
}

/**
 * Read the persisted owner-token map for a run. Never throws — see
 * `readOwnerTokenMap`. Absent for a task_id means "no token persisted for it"
 * (fail-open at the ownership gate), not "claim absent".
 */
export async function readOwnerTokens(runDir: string): Promise<OwnerTokenMap> {
  return readOwnerTokenMap(ownerTokensPath(runDir));
}

/**
 * Merge `tokensByTaskId` additively into the run-scoped sidecar: each task_id
 * in `tokensByTaskId` overwrites (or adds) its own entry — a same-run
 * re-dispatch round's re-grant rotates only that task's token — while every
 * OTHER task's previously-persisted token is preserved untouched. Runs under
 * a file lock so concurrent dispatch rounds (same run re-entry, cooperative
 * peers sharing the run) never race a lost update. No-op when there is
 * nothing to persist.
 */
export async function mergeOwnerTokens(
  runDir: string,
  tokensByTaskId: Readonly<OwnerTokenMap>,
): Promise<void> {
  if (Object.keys(tokensByTaskId).length === 0) return;
  const path = ownerTokensPath(runDir);
  await withFileLock(lockPathFor(path), async () => {
    const existing = await readOwnerTokenMap(path);
    await writeJsonFile(path, { ...existing, ...tokensByTaskId });
  });
}
