import { test, expect } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { emitBlindDispatchFrictionIfBlind } = await import(
  "../../src/shared/friction/blindDispatchFriction.ts"
);
const { frictionCapturePath } = await import("../../src/shared/io/frictionCapture.ts");

async function readFrictions(dir, runId) {
  const raw = JSON.parse(await readFile(frictionCapturePath(dir, runId), "utf8"));
  return raw.frictions;
}

test("blind dispatch (no live snapshot) emits a quota_blind_dispatch friction and returns true", async () => {
  const dir = await mkdtemp(join(tmpdir(), "blind-disp-"));
  try {
    const fired = await emitBlindDispatchFrictionIfBlind({
      artifactsDir: dir,
      runId: "run-1",
      schedule: { quota_source_snapshot: null, host_concurrency_limit: null },
      itemCount: 7,
      waveKind: "review",
      toolName: "audit-code",
    });
    expect(fired).toBe(true);
    const frictions = await readFrictions(dir, "run-1");
    expect(frictions.length).toBe(1);
    // eventType is encoded as the first segment of the collision-free id (CE-006).
    expect(frictions[0].id).toMatch(/^quota_blind_dispatch/);
    expect(frictions[0].area).toBe("dispatch/quota");
    expect(frictions[0].severity).toBe("high");
    expect(frictions[0].note).toMatch(/uncapped/i); // no declared cap ⇒ uncapped wording
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a live snapshot is NOT blind — no friction, returns false", async () => {
  const dir = await mkdtemp(join(tmpdir(), "blind-disp-"));
  try {
    const fired = await emitBlindDispatchFrictionIfBlind({
      artifactsDir: dir,
      runId: "run-2",
      schedule: {
        quota_source_snapshot: {
          remaining_pct: 0.6,
          reset_at: null,
          requests_remaining: null,
          tokens_remaining: null,
          captured_at: new Date().toISOString(),
          source: "test",
        },
        host_concurrency_limit: null,
      },
      itemCount: 3,
      waveKind: "implement",
      toolName: "remediate-code",
    });
    expect(fired).toBe(false);
    // No friction file written (nothing captured).
    await expect(readFrictions(dir, "run-2")).rejects.toThrow();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("parity: remediate-code emits the identical blind-dispatch friction (single-sourced)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "blind-disp-"));
  try {
    const fired = await emitBlindDispatchFrictionIfBlind({
      artifactsDir: dir,
      runId: "run-r",
      schedule: { quota_source_snapshot: null, host_concurrency_limit: null },
      itemCount: 5,
      waveKind: "implement",
      toolName: "remediate-code",
    });
    expect(fired).toBe(true);
    const frictions = await readFrictions(dir, "run-r");
    expect(frictions.length).toBe(1);
    // Same event kind + area + severity as the audit path — proves no per-tool drift.
    expect(frictions[0].id).toMatch(/^quota_blind_dispatch/);
    expect(frictions[0].id).toContain("implement"); // discriminator carries the wave kind + count
    expect(frictions[0].area).toBe("dispatch/quota");
    expect(frictions[0].severity).toBe("high");
    expect(frictions[0].category).toBe("trap");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("blind dispatch with a declared host cap notes the cap instead of 'uncapped'", async () => {
  const dir = await mkdtemp(join(tmpdir(), "blind-disp-"));
  try {
    await emitBlindDispatchFrictionIfBlind({
      artifactsDir: dir,
      runId: "run-3",
      schedule: {
        quota_source_snapshot: null,
        host_concurrency_limit: { active_subagents: 4 },
      },
      itemCount: 10,
      waveKind: "review",
      toolName: "audit-code",
    });
    const frictions = await readFrictions(dir, "run-3");
    expect(frictions[0].note).toMatch(/declared host cap 4/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
