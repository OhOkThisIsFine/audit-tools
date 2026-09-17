// P67 (nightly leg 3, 2026-09-17): the triage coverage stamp counts an
// UNPROBED row, not only an unusable-probe row.
//
// The sweep's own module header says a row whose probes were all unusable
// stamps `probes_unusable`, "visibly distinct from one that honestly quoted
// nothing checkable, counted in the coverage stamp". Only the first half is
// true: `stampExtra` increments `probes_unusable` and nothing else, so a row
// that carried NO probes at all leaves no trace in the stamp. On the
// 2026-09-17 sweep that hid 16 of 40 rows — a reader of the stamp sees
// `probes_unusable: 7` and concludes the other 33 verdicts were premise-checked
// when 16 of them were not checked at all.
//
// Coverage is read from the stamp, never eyeballed — so a stamp that
// undercounts is a false green about its own evidence.
import { describe, expect, it } from "vitest";

import {
  TRIAGE_STAMP_INIT,
  countTriageStamp,
  PREMISE_STAMP_CLASSES,
} from "../../scripts/shared/triage-backlog.mjs";

describe("the triage coverage stamp counts every premise class", () => {
  it("declares a counter for every premise stamp a record can carry", () => {
    for (const cls of PREMISE_STAMP_CLASSES) {
      expect(TRIAGE_STAMP_INIT).toHaveProperty(cls);
    }
  });

  it("counts an UNPROBED row — the class that carried no probes at all", () => {
    const stamp: Record<string, unknown> = { ...TRIAGE_STAMP_INIT, lanes: {} };
    countTriageStamp(stamp, { premise: "unprobed", lane: "agy-gemini" });
    countTriageStamp(stamp, { premise: "unprobed", lane: "agy-gemini" });
    countTriageStamp(stamp, { premise: "probes_unusable", lane: "free-pool" });
    expect(stamp.unprobed).toBe(2);
    expect(stamp.probes_unusable).toBe(1);
  });

  it("still counts which lane answered each row", () => {
    const stamp: Record<string, unknown> = { ...TRIAGE_STAMP_INIT, lanes: {} };
    countTriageStamp(stamp, { premise: "holds", lane: "free-pool" });
    countTriageStamp(stamp, { premise: "holds", lane: "agy-gemini" });
    expect(stamp.lanes).toEqual({ "free-pool": 1, "agy-gemini": 1 });
    expect(stamp.holds).toBe(2);
  });
});
