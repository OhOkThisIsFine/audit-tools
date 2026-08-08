// Split from the former single audit-code-completion.test.ts (wall-clock brief
// T4: no single test file may dominate a CI shard). Test bodies are a verbatim
// move; the shared fixture lives in helpers/completion-harness.ts.
import { test, expect } from "vitest";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { HEAVY_AUDIT_TEST_TIMEOUT_MS } from "../helpers/heavy-timeout.mjs";
import {
  withTempRepo,
  advanceToDispatchReady,
  disableNarrative,
  callForceSynthesis,
} from "./helpers/completion-harness.js";

test("force-synthesis on a PAUSED run stamps the terminal onto the existing state and clears paused_state (the documented stamp-clears-pause invariant)", { timeout: HEAVY_AUDIT_TEST_TIMEOUT_MS }, async () => {
  await withTempRepo(async (root) => {
    const artifactsDir = join(root, ".audit-tools/audit");
    await advanceToDispatchReady(root);

    const tasks = JSON.parse(
      await readFile(join(artifactsDir, "audit_tasks.json"), "utf8"),
    );
    await disableNarrative(artifactsDir);

    // A wedged run that is ALSO paused — the realistic force-synthesis scenario
    // (a run wedged on undispatchable tasks is typically sitting at a provider
    // pause). The operator stamp must ride the same one-way ratchet as the
    // engine's own terminal: paused_state cleared atomically in the same write.
    await writeFile(
      join(artifactsDir, "active-dispatch.json"),
      JSON.stringify({
        run_id: "R-paused",
        created_at: "2026-01-01T00:00:00Z",
        packet_count: 1,
        task_count: tasks.length,
        status: "active",
        paused_state: {
          lifecycle: {
            kind: "waiting_for_provider",
            paused_at: "2026-01-01T00:00:00Z",
            pause_count: 1,
            stranded_node_ids: [],
          },
          settled_exclusions: [],
        },
      }),
    );

    const forced = await callForceSynthesis([
      "--root", root, "--artifacts-dir", artifactsDir,
    ]);
    expect(forced.selected_executor).toBe("synthesis_executor");
    expect(forced.newly_stranded_count >= 1).toBeTruthy();

    const active = JSON.parse(
      await readFile(join(artifactsDir, "active-dispatch.json"), "utf8"),
    );
    // Overlay branch: the existing run's identity and bookkeeping survive.
    expect(active.run_id).toBe("R-paused");
    expect(active.partial_completion_terminal.reason).toBe("operator_forced");
    expect(
      active.paused_state,
      "the operator terminal stamp must clear paused_state in the same write — " +
        "preserving it leaves a run that is both terminal and waiting on a dead provider",
    ).toBeUndefined();
  });
});
