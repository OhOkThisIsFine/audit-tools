import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  SOURCE_FILE,
  RENDER_FILE,
  extractFileLockExportSurface,
  renderSurfacePin,
} from "../../scripts/shared/generate-filelock-export-surface.mjs";
import * as liveFileLock from "../../src/shared/io/fileLock.js";

/**
 * cdc-06 drift pin: the generated export-signature snapshot of the shared file
 * lock must match the LIVE surface of src/shared/io/fileLock.ts. This is what
 * makes CP-NODE-18's "identical exported surface" proof mechanical — a renamed
 * export, a changed parameter type, or an added/removed surface member fails
 * here instead of surviving as an unflagged drift the next consumer trips over.
 *
 * Mutation controls below prove the diff actually fires (and that
 * implementation-only edits legitimately do NOT fire it), because a drift test
 * that has never been seen failing is itself the memory-based-control shape
 * this repo bans.
 */
describe("filelock-export-surface.generated.json — cdc-06 snapshot pin", () => {
  const tracked = readFileSync(resolve(process.cwd(), RENDER_FILE), "utf8");
  const source = readFileSync(resolve(process.cwd(), SOURCE_FILE), "utf8");

  it("the tracked generated pin matches a fresh render from the live source", () => {
    expect(tracked).toBe(renderSurfacePin(extractFileLockExportSurface(source)));
  });

  it("every pinned VALUE export is a real runtime binding of the module", () => {
    // Type-only exports (Clock, LockOptions) are erased at runtime by design;
    // they are held by the structural pin above, not by module keys.
    const TYPE_KINDS = new Set(["type_alias", "interface"]);
    const valueNames = JSON.parse(tracked)
      .exports.filter((e: { kind: string }) => !TYPE_KINDS.has(e.kind))
      .map((e: { name: string }) => e.name)
      .sort();
    expect(valueNames.length, "the pin must stay non-empty").toBeGreaterThan(0);
    expect(valueNames).toEqual(Object.keys(liveFileLock).sort());
  });

  it("the full known lock surface is present by name and kind", () => {
    const pinned = new Map(
      JSON.parse(tracked).exports.map((e: { name: string; kind: string }) => [e.name, e.kind]),
    );
    expect(Object.fromEntries(pinned)).toEqual({
      STALE_LOCK_MS: "const",
      Clock: "type_alias",
      isTransientPermissionContention: "function",
      FileLockTimeoutError: "class",
      LockOptions: "interface",
      acquireLock: "function",
      releaseLock: "function",
      withFileLock: "function",
      lockedJsonMutate: "function",
    });
  });

  // ── mutation controls: the pin MUST move when the surface moves ────────────

  it("a renamed export breaks the pin", () => {
    const mutated = source.replace(
      "export async function acquireLock(",
      "export async function acquireLockRenamed(",
    );
    expect(mutated).not.toBe(source); // the anchor must exist
    expect(renderSurfacePin(extractFileLockExportSurface(mutated))).not.toBe(tracked);
  });

  it("a changed parameter type breaks the pin", () => {
    const mutated = source.replace(
      "timeoutMs: number = DEFAULT_TIMEOUT_MS",
      "timeoutMs: string = DEFAULT_TIMEOUT_MS",
    );
    expect(mutated).not.toBe(source);
    expect(renderSurfacePin(extractFileLockExportSurface(mutated))).not.toBe(tracked);
  });

  it("a removed export breaks the pin", () => {
    const mutated = source.replace("export const STALE_LOCK_MS = 30_000;\n", "");
    expect(mutated).not.toBe(source);
    expect(renderSurfacePin(extractFileLockExportSurface(mutated))).not.toBe(tracked);
  });

  it("an added export breaks the pin", () => {
    const mutated = `${source}\nexport const SURFACE_ADDITION = 1;\n`;
    expect(renderSurfacePin(extractFileLockExportSurface(mutated))).not.toBe(tracked);
  });

  it("a new optional interface member breaks the pin", () => {
    const mutated = source.replace(
      "heartbeatIntervalMs?: number;",
      "heartbeatIntervalMs?: number;\n  extraSeam?: boolean;",
    );
    expect(mutated).not.toBe(source);
    expect(renderSurfacePin(extractFileLockExportSurface(mutated))).not.toBe(tracked);
  });

  // ── negative controls: implementation-only edits must NOT churn the pin ────

  it("an internal constant tweak does not break the pin", () => {
    const mutated = source.replace(
      "const RETRY_INTERVAL_INITIAL_MS = 50;",
      "const RETRY_INTERVAL_INITIAL_MS = 60;",
    );
    expect(mutated).not.toBe(source);
    expect(renderSurfacePin(extractFileLockExportSurface(mutated))).toBe(tracked);
  });

  it("a private helper rename does not break the pin", () => {
    const mutated = source.replaceAll("bestEffortUnlink(", "bestEffortUnlinkImpl(");
    expect(mutated).not.toBe(source);
    expect(renderSurfacePin(extractFileLockExportSurface(mutated))).toBe(tracked);
  });

  it("a changed default EXPRESSION on a defaulted parameter does not break the pin", () => {
    // Defaultedness is surface; which private binding supplies it is not.
    const mutated = source.replace(
      "timeoutMs: number = DEFAULT_TIMEOUT_MS",
      "timeoutMs: number = FALLBACK_TIMEOUT_MS",
    );
    expect(mutated).not.toBe(source);
    expect(renderSurfacePin(extractFileLockExportSurface(mutated))).toBe(tracked);
  });

  it("refuses an unrecognized export shape instead of silently dropping it", () => {
    expect(() =>
      extractFileLockExportSurface(`${source}\nexport default class NotInSurface {}\n`),
    ).toThrow(/default export/);
  });
});
