// sites-pinned: tests/audit/frozen-snapshot.test.ts
import { lstat, readFile, readdir, realpath, rename, rm, rmdir, stat } from "node:fs/promises";
import { isArtifactTreeHoldEntry, withArtifactTreeHold } from "../../shared/io/artifactTreeHold.js";
import { foldReceiptPath, hasPendingFoldReceipt } from "../io/foldReceiptPath.js";
import { basename, join, relative, sep } from "node:path";
import { artifactTreeLockPath, auditArtifactsDir, auditToolsDir, hashContent, isFileMissingError, isJsonParseError, readJsonFile, readOptionalJsonFile, resolveWithinRoot, writeJsonFile } from "audit-tools/shared";
import { ARTIFACT_DEFINITIONS, isWorkingDirFullyPromoted, retiredRunEvidenceIsArchived } from "../io/artifacts.js";
import { assertCleanupSnapshotOwnership, removeRunSnapshot, runSnapshotPath } from "../io/runSnapshot.js";
import { AuditTopLevelStatusSchema, type AuditState } from "../types/auditState.js";

import { nextStepCommand } from "./prompts.js";

const terminalField = "cleanup_terminal_sweep";
const markerName = ARTIFACT_DEFINITIONS.audit_state.fileName;
const sweepName = "cleanup-sweep.json";
const terminalReceiptName = "cleanup-terminal-sweep.json";
type PayloadIdentity = [string, number, number, number, number, number | null, number | null];
type SweepReceipt = { state_sha256?: unknown; snapshot_record?: unknown; payload?: unknown };

function isDefaultSweepPayload(artifactsDir: string, entry: string): boolean {
  return entry !== markerName && entry !== sweepName && entry !== terminalReceiptName &&
    entry !== "run-snapshot.json" && entry !== "run-snapshot-acquiring.json" &&
    !isArtifactTreeHoldEntry(artifactsDir, entry);
}

async function defaultSweepPayload(artifactsDir: string): Promise<PayloadIdentity[]> {
  const entries: PayloadIdentity[] = [];
  for (const name of await readdir(artifactsDir)) {
    if (!isDefaultSweepPayload(artifactsDir, name)) continue;
    const info = await inspectEntry(join(artifactsDir, name));
    if (!info) continue; // A cooperating writer may have finished before the read-only probe.
    // Directory metadata can legitimately change during a partial recursive
    // removal. Identity still detects a replacement at its top-level name.
    entries.push([name, info.dev, info.ino, info.birthtimeMs, info.mode,
      info.isDirectory() ? null : info.size, info.isDirectory() ? null : info.mtimeMs]);
  }
  return entries;
}

function unexpectedSweepPayload(current: PayloadIdentity[], previous: unknown): PayloadIdentity | undefined {
  const owned = new Set(Array.isArray(previous) ? previous.map(entry => JSON.stringify(entry)) : []);
  return current.find(entry => !owned.has(JSON.stringify(entry)));
}

async function isOriginalReceiptAtTail(artifactsDir: string, state: Record<string, unknown>): Promise<boolean> {
  if (state.status !== "not_started" && state.status !== "complete") return false;
  const path = join(artifactsDir, sweepName);
  const info = await inspectEntry(path);
  if (!info?.isFile() || info.isSymbolicLink()) return false;
  const receipt = await readJsonFile<SweepReceipt | null>(path).catch(error => {
    if (isJsonParseError(error) || isFileMissingError(error)) return undefined;
    throw error;
  });
  if (receipt?.state_sha256 !== hashContent(JSON.stringify(state))) return false;
  const remaining = await defaultSweepPayload(artifactsDir);
  // Do not enter the hold during the terminal probe for an ordinary partial
  // sweep. A drained or ambiguous receipt must be rechecked before rollover.
  return remaining.length === 0 || !!unexpectedSweepPayload(remaining, receipt.payload);
}



export class TerminalCleanupError extends Error {
  constructor(root: string, artifactsDir: string, cause: unknown) {
    super(`Terminal cleanup failed: ${cause instanceof Error ? cause.message : String(cause)}. Fix the reported problem and retry: ${nextStepCommand(root, artifactsDir)}`, { cause });
  }
}

export type CleanupOptions = {
  repositoryRoot?: string;
  force?: boolean;
  dryRun?: boolean;
  requireAuditMarker?: boolean;
  terminalOnly?: boolean;
  explicitTarget?: { root: string; custom: boolean };
};

export type CleanupResult = {
  action: "deleted" | "already-complete" | "skipped" | "dry-run";
  status: AuditState["status"] | "unknown";
  reason?: string;
};

async function inspectDirectory(root: string, target: string): Promise<void> {
  if (resolveWithinRoot(root, target, { allowRoot: false }) === null) {
    throw new Error(`Refusing cleanup: ${target} is not strictly inside the audit root ${root}.`);
  }
  let current = root;
  for (const segment of ["", ...relative(root, target).split(sep)]) {
    current = join(current, segment);
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`Refusing cleanup: unsafe directory topology at ${current}.`);
    }
  }
  const physicalRoot = await realpath(root);
  const physicalTarget = await realpath(target);
  if (resolveWithinRoot(physicalRoot, physicalTarget, { allowRoot: false }) === null) {
    throw new Error(`Refusing cleanup: the resolved target escapes the audit root: ${target}.`);
  }
  if (relative(physicalRoot, physicalTarget).split(sep).some(part => part.toLowerCase() === ".git")) {
    throw new Error(`Refusing cleanup: ${target} is inside repository Git metadata.`);
  }
  if (resolveWithinRoot(physicalTarget, auditToolsDir(physicalRoot)) !== null) {
    throw new Error(`Refusing cleanup: ${target} contains the shared audit tools output directory.`);
  }
}

async function inspectEntry(path: string) {
  return lstat(path).catch(error => {
    if (isFileMissingError(error)) return undefined;
    throw error;
  });
}

async function isTerminalCleanupResidue(
  artifactsDir: string,
  sweepPath: string,
  snapshotRecord: string,
): Promise<boolean> {
  const sweepName = basename(sweepPath);
  const recordName = basename(snapshotRecord);
  for (const entry of await readdir(artifactsDir)) {
    if (entry === recordName || isArtifactTreeHoldEntry(artifactsDir, entry)) continue;
    if (entry !== sweepName) return false;
    const info = await inspectEntry(sweepPath);
    if (!info?.isFile() || info.isSymbolicLink()) return false;
  }
  return true;
}

async function optionalSnapshotRecord(
  root: string, artifactsDir: string, snapshotAlreadyRemoved: boolean,
): Promise<string | undefined> {
  if (await inspectEntry(runSnapshotPath(artifactsDir)) ||
      await inspectEntry(join(artifactsDir, "run-snapshot-acquiring.json"))) {
    return assertCleanupSnapshotOwnership(root, artifactsDir, { snapshotAlreadyRemoved });
  }
}

async function hasOnlyHold(artifactsDir: string, assertOwnership: () => Promise<void>): Promise<boolean> {
  await assertOwnership();
  for (const entry of await readdir(artifactsDir)) {
    if (!isArtifactTreeHoldEntry(artifactsDir, entry)) return false;
    const info = await inspectEntry(join(artifactsDir, entry));
    if (!info?.isFile() || info.isSymbolicLink()) return false;
  }
  await assertOwnership();
  return true;
}

async function finishDefaultTail(
  root: string, artifactsDir: string, status: CleanupResult["status"], stateDigest: string,
  terminal: unknown, dryRun: boolean, assertOwnership: () => Promise<void>,
  preparation?: { marker: Record<string, unknown>; transitionReceipt: boolean },
): Promise<CleanupResult> {
  if ((status !== "complete" && status !== "not_started") || !terminal || typeof terminal !== "object" ||
      !("version" in terminal) || terminal.version !== 1 ||
      !("state_sha256" in terminal) || terminal.state_sha256 !== stateDigest ||
      !("snapshot_record" in terminal) ||
      (terminal.snapshot_record !== null && terminal.snapshot_record !== "run-snapshot.json" &&
        terminal.snapshot_record !== "run-snapshot-acquiring.json")) {
    throw new Error("Invalid terminal sweep identity");
  }
  await assertOwnership();
  const record = await optionalSnapshotRecord(root, artifactsDir, true);
  const allowedReceipt = preparation?.transitionReceipt ? sweepName : terminalReceiptName;
  const outputMarker = preparation && { ...preparation.marker, [terminalField]: terminal };
  const markerBytes = outputMarker && Buffer.from(JSON.stringify(outputMarker, null, 2) + "\n");
  const markerTempPattern = /^\.audit_state\.json\.\d+\.[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\.tmp$/i;
  let markerTemp: string | undefined;
  for (const entry of await readdir(artifactsDir)) {
    const path = join(artifactsDir, entry);
    const info = await inspectEntry(path);
    if (!info?.isFile() || info.isSymbolicLink()) throw new Error(`Unsafe terminal sweep entry: ${entry}`);
    if (entry === markerName || entry === allowedReceipt || entry === (record && basename(record)) ||
        isArtifactTreeHoldEntry(artifactsDir, entry)) continue;
    // A process can die after writeJsonFile wrote its private temp but
    // before rename. Admit only one complete, byte-identical marker temp.
    if (markerBytes && !preparation?.transitionReceipt && !markerTemp && markerTempPattern.test(entry) &&
        info.size === markerBytes.byteLength && (await readFile(path)).equals(markerBytes)) {
      markerTemp = path;
      continue;
    }
    throw new Error(`Unexpected terminal sweep entry: ${entry}`);
  }
  const receiptPath = join(artifactsDir, allowedReceipt);
  const receipt = await inspectEntry(receiptPath);
  if ((record && basename(record) !== terminal.snapshot_record) ||
      (receipt && !record && terminal.snapshot_record !== null)) {
    throw new Error("Terminal sweep snapshot ownership no longer matches");
  }
  const receiptData = receipt && await readJsonFile<SweepReceipt | null>(receiptPath);
  if ((preparation && !receipt) ||
      (receipt && (receiptData?.state_sha256 !== stateDigest || receiptData.snapshot_record !== terminal.snapshot_record))) {
    throw new Error("Invalid terminal sweep receipt");
  }
  if (dryRun) return { action: "dry-run", status };
  const terminalReceiptPath = join(artifactsDir, terminalReceiptName);
  if (outputMarker) {
    if (preparation?.transitionReceipt) {
      // The same state-bound receipt crosses the terminal boundary in one
      // rename. Every later retry is strict, even if the marker is still original.
      await assertOwnership();
      await rename(receiptPath, terminalReceiptPath);
    }
    if (markerTemp) {
      await assertOwnership();
      await rm(markerTemp, { force: true });
    }
    await assertOwnership();
    await writeJsonFile(join(artifactsDir, markerName), outputMarker);
  }
  for (const path of [receipt && terminalReceiptPath, record, join(artifactsDir, markerName)]) {
    if (!path) continue;
    await assertOwnership();
    await rm(path, { force: true });
  }
  return { action: "deleted", status };
}

// Remove a stale working artifacts directory. Two callers, ONE rule: the
// `cleanup` CLI command (cmdCleanup) and the next-step pre-run sweep
// (cmdNextStepBody) call this identically — owner decision 74c89b226ab9b9cd
// (2026-08-31), which reversed the not_started-only pre-run narrowing of
// 7ebeccc8 while keeping its protection.
//
// A dir is stale (eligible without --force) when nothing in it is still owed to
// the host: its run is `not_started` (nothing was produced), or `complete` with
// nothing left for the completion transition to do — every artifact promotion
// archives is already one level up, byte-identical, as decided by promotion's
// own archive walk in verify-only mode (isWorkingDirFullyPromoted), never by a
// second list. A `complete` dir with work left — an unpromoted render, an
// unarchived contract, friction triage pending — is a live continuation for
// BOTH callers: at next-step entry the fold's terminal step presents and
// promotes it; the verb refuses it without --force. Sweeping it would destroy
// the only copy of a finished audit. (At next-step entry an ENDED run never
// reaches this sweep: `rollOverFinishedRun` runs first and turns it into the
// next run's starting point, so for that caller the complete arm covers only
// a promoted run whose terminal step never wrote the run-ended marker.)
//
// Deletion contract: only the working artifacts dir is removed. The promoted
// final reports live one level up (promotedAuditReportPath /
// promotedAuditFindingsPath, and the remediation pair beside them) and no
// cleanup path touches them. A missing state file means there is nothing to
// clean.
//
// With options:
//   force=true  — delete even when the run is active/blocked, complete with
//                 work left; explicit cleanup still requires a state marker.
//   dryRun=true — skip the actual rm call and return action='dry-run'.
// Both default to false.
export async function cleanupStaleArtifactsDir(
  artifactsDir: string,
  options: CleanupOptions = {},
): Promise<CleanupResult> {
  const root = options.explicitTarget?.root ?? options.repositoryRoot;
  const defaultRoot = root !== undefined && !options.explicitTarget?.custom &&
    relative(auditArtifactsDir(root), artifactsDir) === "" ? root : undefined;
  if (options.terminalOnly && defaultRoot === undefined) return { action: "skipped", status: "unknown" };
  let terminalTail = options.terminalOnly ?? false;
  try {
    const validationRoot = options.explicitTarget?.root ?? defaultRoot;
    if (validationRoot) await inspectDirectory(validationRoot, artifactsDir);
    else await stat(artifactsDir);
    if (defaultRoot) {
      // Probe read-only; ordinary terminal-only input does not acquire a lock.
      // All decisions are repeated under the hold.
      const terminalReceipt = await inspectEntry(join(artifactsDir, terminalReceiptName));
      const path = join(artifactsDir, markerName);
      const info = await inspectEntry(path);
      const state = !terminalReceipt && info?.isFile() && !info.isSymbolicLink()
        ? await readJsonFile<Record<string, unknown> | null>(path).catch(error => {
          if (isFileMissingError(error) || isJsonParseError(error)) return undefined;
          throw error;
        })
        : undefined;
      const candidate = terminalReceipt || (state &&
        (Object.hasOwn(state, terminalField) || await isOriginalReceiptAtTail(artifactsDir, state)));
      if (options.terminalOnly && !candidate) return { action: "skipped", status: "unknown" };
      if (candidate) {
        terminalTail = true;
        const lockPath = artifactTreeLockPath(artifactsDir);
        // Shared lock acquisition can inspect both names before our held
        // checks. The preflight relies on the same cooperative-writer model.
        for (const path of [lockPath, lockPath + ".steal"]) {
          const entry = await inspectEntry(path);
          if (entry && (!entry.isFile() || entry.isSymbolicLink())) throw new Error("Unsafe artifact tree hold entry");
        }
      }
    }
  } catch (error) {
    if (isFileMissingError(error)) return { action: "skipped", status: "unknown" };
    if (terminalTail && defaultRoot) throw new TerminalCleanupError(defaultRoot, artifactsDir, error);
    throw error;
  }
  let result: CleanupResult;
  try {
    result = await withArtifactTreeHold(artifactsDir, undefined, assertOwnership => cleanupHeld(
      artifactsDir, options, defaultRoot, () => { terminalTail = true; }, assertOwnership,
    ));
    if (result.action === "deleted") {
      try {
        await rmdir(artifactsDir);
      } catch (error) {
        if (!isFileMissingError(error) &&
          !(error && typeof error === "object" && "code" in error && error.code === "ENOTEMPTY")) throw error;
      }
    }
  } catch (error) {
    if (terminalTail && defaultRoot) throw new TerminalCleanupError(defaultRoot, artifactsDir, error);
    throw error;
  }
  return result;
}

async function cleanupHeld(
  artifactsDir: string,
  options: CleanupOptions,
  defaultRoot: string | undefined,
  markTerminalTail: () => void,
  assertOwnership: () => Promise<void>,
): Promise<CleanupResult> {
  const { force = false, dryRun = false } = options;
  const target = options.explicitTarget;
  const validationRoot = target?.root ?? defaultRoot;
  if (validationRoot) await inspectDirectory(validationRoot, artifactsDir);
  const pendingFold = target || defaultRoot ? await inspectEntry(foldReceiptPath(artifactsDir)) : await hasPendingFoldReceipt(artifactsDir);
  if (pendingFold && !defaultRoot) {
    return { action: "skipped", status: "unknown", reason: "An incomplete fold receipt must be recovered using next-step." };
  }

  const sweepPath = join(artifactsDir, sweepName);
  let status: AuditState["status"] | "unknown" = "unknown";
  let stateDigest: string | undefined;
  let invalidMarker: string | undefined;
  const markerPath = join(artifactsDir, markerName);
  const info = validationRoot ? await inspectEntry(markerPath) : undefined;
  if (validationRoot) {
    if (info && (!info.isFile() || info.isSymbolicLink())) {
      throw new Error(`Refusing cleanup: unsafe audit state marker at ${markerPath}.`);
    }
  }
  let markerFields: (AuditState & Record<string, unknown>) | undefined;
  try {
    const state = await readJsonFile<AuditState & Record<string, unknown>>(markerPath);
    markerFields = state;
    if (target) {
      const parsed = AuditTopLevelStatusSchema.safeParse(state?.status);
      if (parsed.success) status = parsed.data;
      else invalidMarker = "Invalid audit_state.json: unrecognized audit status.";
    } else {
      status = state?.status ?? "unknown";
    }
    if (!invalidMarker) stateDigest = hashContent(JSON.stringify(state));
  } catch (error) {
    if (target && isJsonParseError(error)) invalidMarker = "Invalid audit_state.json: malformed JSON.";
    else if (!isFileMissingError(error)) throw error;
  }

  const terminalReceiptPath = join(artifactsDir, terminalReceiptName);
  const terminalReceipt = defaultRoot ? await inspectEntry(terminalReceiptPath) : undefined;
  const hasEmbeddedIdentity = markerFields && Object.hasOwn(markerFields, terminalField);
  if (defaultRoot && (terminalReceipt || hasEmbeddedIdentity)) {
    markTerminalTail();
    if (!markerFields || !info) throw new Error("Missing terminal sweep identity marker");
    if (pendingFold) throw new Error("An incomplete fold receipt prevents terminal cleanup");
    if (terminalReceipt && (!terminalReceipt.isFile() || terminalReceipt.isSymbolicLink())) {
      throw new Error("Unsafe terminal sweep receipt");
    }
    const { [terminalField]: embedded, ...original } = markerFields;
    const terminal = hasEmbeddedIdentity ? embedded :
      await readJsonFile<SweepReceipt | null>(terminalReceiptPath).then(receipt => ({
        version: 1, state_sha256: receipt?.state_sha256, snapshot_record: receipt?.snapshot_record,
      }));
    return finishDefaultTail(
      defaultRoot, artifactsDir, status, hashContent(JSON.stringify(original)), terminal, dryRun, assertOwnership,
      hasEmbeddedIdentity ? undefined : { marker: original, transitionReceipt: false },
    );
  }
  if (pendingFold) {
    if (defaultRoot && markerFields && await isOriginalReceiptAtTail(artifactsDir, markerFields)) {
      markTerminalTail();
      throw new Error("An incomplete fold receipt prevents terminal cleanup");
    }
    return { action: "skipped", status: "unknown", reason: "An incomplete fold receipt must be recovered using next-step." };
  }
  if (defaultRoot && !info && !await inspectEntry(markerPath) && await hasOnlyHold(artifactsDir, assertOwnership)) {
    return { action: "already-complete", status: "unknown" };
  }
  if (invalidMarker && !force) return { action: "skipped", status, reason: invalidMarker };

  const missingRequiredMarker = force && options.requireAuditMarker && status === "unknown" && !invalidMarker;
  let retainedRecord: string | undefined;
  if (missingRequiredMarker) {
    if (target?.custom) {
      await assertOwnership();
      // Only the exact owned record can authorize finishing the tail after
      // removal of the state marker, and no run payload may remain.
      retainedRecord = await assertCleanupSnapshotOwnership(target.root, artifactsDir, { snapshotAlreadyRemoved: true })
        .catch(() => undefined);
    }
    if (retainedRecord === undefined || !(await isTerminalCleanupResidue(artifactsDir, sweepPath, retainedRecord))) {
      return { action: "skipped", status, reason: "The working audit no longer has its identity marker; refusing forced cleanup." };
    }
  }

  const requireSnapshot = target !== undefined && (target.custom || invalidMarker !== undefined || missingRequiredMarker);
  if (requireSnapshot && retainedRecord === undefined) {
    await assertOwnership();
    try {
      retainedRecord = await assertCleanupSnapshotOwnership(target.root, artifactsDir);
    } catch (error) {
      if (!invalidMarker || !(error instanceof Error)) throw error;
      throw new Error(`${invalidMarker} ${error.message}`, { cause: error });
    }
  }

  const defaultSweep = defaultRoot !== undefined && !force;
  if (defaultSweep) {
    const receipt = await inspectEntry(sweepPath);
    if (receipt && (!receipt.isFile() || receipt.isSymbolicLink())) {
      throw new Error(`Refusing cleanup: unsafe sweep receipt at ${sweepPath}.`);
    }
  }
  const sweep = !force && stateDigest && (status === "not_started" || status === "complete")
    ? await readOptionalJsonFile<SweepReceipt>(sweepPath)
    : undefined;
  const sweepReady = stateDigest !== undefined && sweep?.state_sha256 === stateDigest;
  if (options.terminalOnly && !sweepReady) return { action: "skipped", status: "unknown" };
  const remaining = defaultSweep ? await defaultSweepPayload(artifactsDir) : [];
  if (defaultSweep && sweepReady) {
    const unexpected = unexpectedSweepPayload(remaining, sweep?.payload);
    if (unexpected) {
      markTerminalTail();
      throw new Error(`Unexpected sweep payload not covered by its receipt: ${unexpected[0]}`);
    }
    if (options.terminalOnly && remaining.length > 0) return { action: "skipped", status: "unknown" };
    if (!remaining.length) markTerminalTail();
  }
  if (!force && !sweepReady && status === "not_started" && !(await retiredRunEvidenceIsArchived(artifactsDir))) {
    return { action: "skipped", status, reason: "Historical audit evidence is not safely archived. The working audit was kept." };
  }

  const stale =
    status === "not_started" ||
    (status === "complete" && (force || sweepReady || (await isWorkingDirFullyPromoted(artifactsDir))));
  const resumable = status === "active" || status === "blocked";

  if (!stale && !force) {
    // active/blocked — caller may want to resume; skip unless forced
    if (resumable) {
      const reason = `audit is ${status} and may be resumed — use --force to delete anyway`;
      return { action: "skipped", status, reason };
    }
    // complete with work left — the dir holds the only copy of the finished
    // audit until the completion transition promotes it.
    if (status === "complete") {
      const reason =
        "audit is complete but its final report is not fully promoted — this dir holds the only copy; run next-step to present and promote it (or, for a run that already ended, to archive it and start the next audit from it), or use --force to delete anyway";
      return { action: "skipped", status, reason };
    }
    // unknown (missing state file) — no-op by default; caller decides how to
    // surface this (the cleanup command sets exitCode=1)
    return { action: "skipped", status: "unknown" };
  }

  if (dryRun) {
    return { action: "dry-run", status };
  }

  // The run's frozen snapshot lives outside the repository; its record is in
  // this dir, so it goes first. When it cannot be removed the dir is kept —
  // deleting the record would leak the snapshot (a checkout, a worktree
  // registration and a ref in the user's repository) — unless the operator
  // forces it: `--force` is the escape hatch, and a corrupt record would
  // otherwise refuse it for good. A forced delete names what it leaves behind.
  await assertOwnership();
  if (defaultSweep) retainedRecord = await optionalSnapshotRecord(defaultRoot, artifactsDir, false);
  const snapshotRecord = retainedRecord ? basename(retainedRecord) : null;
  if (defaultSweep && sweepReady && sweep?.snapshot_record !== undefined && sweep.snapshot_record !== snapshotRecord) {
    throw new Error("Default sweep snapshot ownership no longer matches its receipt");
  }
  const problems = await removeRunSnapshot(artifactsDir, options.repositoryRoot, { retainRecord: retainedRecord });
  if (problems.length > 0) {
    if (!force || requireSnapshot) {
      return {
        action: "skipped",
        status,
        reason: (invalidMarker ? `${invalidMarker} ` : "") +
          `the run's snapshot could not be removed (${problems.join("; ")})` +
          (requireSnapshot ? "; refusing cleanup without safe snapshot removal" : "; fix that, or use --force to delete anyway"),
      };
    }
    for (const problem of problems) {
      process.stderr.write(`[audit-code] run snapshot cleanup (left behind): ${problem}\n`);
    }
  }
  if (!force && stateDigest !== undefined && (!sweepReady || (defaultSweep && sweep?.snapshot_record === undefined))) {
    // Custody was verified above; do not ask a retry to reread the copy it
    // already removed. Bind the permission to this exact working run state.
    await assertOwnership();
    await writeJsonFile(sweepPath, defaultSweep
      ? { state_sha256: stateDigest, snapshot_record: snapshotRecord, payload: sweep?.payload ?? remaining }
      : { state_sha256: stateDigest });
  }
  const retainedEntry = retainedRecord === undefined ? undefined : basename(retainedRecord);
  if (!missingRequiredMarker) {
    const entries = defaultSweep ? remaining.map(entry => entry[0]) : await readdir(artifactsDir);
    for (const entry of entries) {
      if (entry === markerName || entry === sweepName || entry === retainedEntry || isArtifactTreeHoldEntry(artifactsDir, entry)) continue;
      await assertOwnership();
      await rm(join(artifactsDir, entry), { recursive: true, force: true });
    }
    if (defaultSweep && stateDigest && markerFields) {
      markTerminalTail();
      const terminal = {
        version: 1, state_sha256: stateDigest, snapshot_record: snapshotRecord,
      };
      // Verify strict inventory and retained ownership before publishing the
      // terminal authorization; the original receipt still protects a failed rewrite.
      return finishDefaultTail(
        defaultRoot, artifactsDir, status, stateDigest, terminal, false, assertOwnership,
        { marker: markerFields, transitionReceipt: true },
      );
    }
    // Custom and forced paths retain their existing recovery contract.
    await assertOwnership();
    await rm(markerPath, { force: true });
  }
  await assertOwnership();
  await rm(sweepPath, { force: true });
  if (retainedRecord !== undefined) {
    await assertOwnership();
    await rm(retainedRecord, { force: true });
  }
  return { action: "deleted", status };
}
