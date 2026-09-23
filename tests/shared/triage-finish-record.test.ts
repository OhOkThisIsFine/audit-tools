// P68 (nightly leg 3, 2026-09-17): the P65 unearned-shipped downgrade must run
// on the stored record, not merely exist.
//
// `downgradeUnearnedShippedVerdict` is exported from
// scripts/shared/triage-backlog.mjs and covered by its own unit test, and it is
// called from NOWHERE in the sweep. Both record-finishing paths — `buildRecord`
// on write and `reviveRecord` on load — compute the premise stamp and stop,
// each under a comment claiming the downgrade applies there. So the mechanism
// the owner approved on 2026-09-05 has never fired.
//
// The 2026-09-17 sweep wrote the proof: forward-tracks#55883634 is stored as
// `already_shipped_or_stale` with `premise: "unprobed"` — exactly the pairing
// P65 was built to make unrepresentable.
//
// The cause is structural, which is why the fix is an extraction rather than a
// call: the two paths duplicate the identity + premise + path-resolution fold as
// anonymous inline closures, so nothing in the suite can reach either one, and a
// step present in neither is invisible.
import { describe, expect, it } from "vitest";

import {
  finishTriageRecord,
  UNVERIFIED_SHIPPED_VERDICT,
} from "../../scripts/shared/triage-backlog.mjs";

const ENTRY = { id: "forward-tracks#55883634", file: "forward-tracks.md" };

/** A lane answer whose probes quote nothing checkable — the `unprobed` class. */
function shippedClaimWithNoProbes() {
  return {
    id: ENTRY.id,
    file: ENTRY.file,
    title: "pointer-only entry",
    verdict: "already_shipped_or_stale",
    why: "nothing open in this backlog",
    action: "delete the entry",
    effort: "S",
    code_paths: [],
    premise_probes: [],
  };
}

describe("finishTriageRecord — the one fold both sweep paths use", () => {
  it("DOWNGRADES a shipped claim whose premise was never checked", () => {
    const out = finishTriageRecord(shippedClaimWithNoProbes(), { lane: "agy-gemini" });
    expect(out.premise).toBe("unprobed");
    expect(out.verdict).toBe(UNVERIFIED_SHIPPED_VERDICT);
  });

  it("stamps the premise and records the lane that answered", () => {
    const out = finishTriageRecord(
      { ...shippedClaimWithNoProbes(), verdict: "actionable_now" },
      { lane: "free-pool", servedBy: "some-rung" },
    );
    expect(out.verdict).toBe("actionable_now");
    expect(out.premise).toBe("unprobed");
    expect(out.lane).toBe("free-pool");
    expect(out.served_by).toBe("some-rung");
  });

  it("is idempotent — re-finishing a stored record cannot re-upgrade it", () => {
    const once = finishTriageRecord(shippedClaimWithNoProbes(), { lane: "agy-gemini" });
    const twice = finishTriageRecord(once, { lane: "agy-gemini" });
    expect(twice.verdict).toBe(UNVERIFIED_SHIPPED_VERDICT);
    expect(twice.premise).toBe("unprobed");
  });
});
