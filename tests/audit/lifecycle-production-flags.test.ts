/**
 * The flags on `LIFECYCLE_PRODUCTIONS`, pinned by member.
 *
 * Three consumers once named these artifacts by hand: the always-updated list
 * in `advance.ts`, `HOST_APPENDED_ARTIFACTS` and a `tooling_manifest.json`
 * branch in `staleness.ts`. Each now reads a set derived from one flag. This
 * test holds each set's exact members, so moving a flag cannot add or lose a
 * member without a red test.
 */
import { describe, expect, it } from "vitest";

import { AGENT_FEEDBACK_FILENAME } from "audit-tools/shared";
import {
  ALWAYS_UPDATED_ARTIFACTS,
  HOST_APPENDED_ARTIFACTS,
  OPTIONAL_PROBE_ARTIFACTS,
} from "../../src/audit/orchestrator/executors.js";

describe("LIFECYCLE_PRODUCTIONS flags", () => {
  it("always_updated: the environment probe and the worker feedback log", () => {
    expect([...ALWAYS_UPDATED_ARTIFACTS].sort()).toEqual(
      [AGENT_FEEDBACK_FILENAME, "tooling_manifest.json"].sort(),
    );
  });

  it("host_appended: only the worker feedback log", () => {
    expect([...HOST_APPENDED_ARTIFACTS]).toEqual([AGENT_FEEDBACK_FILENAME]);
  });

  it("optional_probe: only the tooling manifest", () => {
    expect([...OPTIONAL_PROBE_ARTIFACTS]).toEqual(["tooling_manifest.json"]);
  });
});
