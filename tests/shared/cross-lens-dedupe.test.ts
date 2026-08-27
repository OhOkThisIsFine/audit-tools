import { describe, it, expect } from "vitest";
import {
  crossLensDedupe,
  mergeGrounding,
  sameLensDedupe,
  upsertFindingByIdentity,
} from "audit-tools/shared";
import type { CrossLensDedupePolicy, Finding } from "audit-tools/shared";

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "F-1",
    title: "Example finding",
    category: "general",
    severity: "medium",
    confidence: "medium",
    lens: "correctness",
    summary: "Example summary.",
    affected_files: [{ path: "src/foo.ts" }],
    evidence: ["ev-1"],
    ...overrides,
  };
}

// The two orchestrators' DRAWS of the one shared core.
const AUDIT_POLICY: CrossLensDedupePolicy = {
  categoryGate: "soft",
  exactIdentityShortCircuit: false,
  survivorMutation: "mutate",
  mergeGrounding: true,
  sortAffectedFiles: true,
  idDiscipline: "local",
};
const REMEDIATE_POLICY: CrossLensDedupePolicy = {
  categoryGate: "hard",
  exactIdentityShortCircuit: true,
  survivorMutation: "clone",
  mergeGrounding: false,
  sortAffectedFiles: false,
  idDiscipline: "global",
};

describe("crossLensDedupe — one core, per-mode policy", () => {
  it("soft category gate merges cross-category; hard gate blocks it", () => {
    const findings = () => [
      makeFinding({ id: "A", title: "Race on shared counter", lens: "correctness", category: "concurrency" }),
      makeFinding({ id: "B", title: "Race on shared counter", lens: "reliability", category: "data-integrity" }),
    ];
    // Same title (sim 1.0 >= 0.5 cross-category threshold), same file → soft merges.
    expect(crossLensDedupe(findings(), AUDIT_POLICY).findings).toHaveLength(1);
    // Hard gate never collapses two different-category fixes.
    expect(crossLensDedupe(findings(), REMEDIATE_POLICY).findings).toHaveLength(2);
  });

  it("mutate returns the survivor original; clone leaves the caller's objects untouched", () => {
    const mk = () => [
      makeFinding({ id: "A", title: "Duplicated auth check", lens: "security", category: "auth", severity: "high" }),
      makeFinding({ id: "B", title: "Duplicated auth check", lens: "correctness", category: "auth", severity: "low", evidence: ["ev-2"] }),
    ];

    const auditIn = mk();
    const auditOut = crossLensDedupe(auditIn, AUDIT_POLICY);
    expect(auditOut.findings).toHaveLength(1);
    // Survivor is the SAME object (higher-severity A), mutated in place.
    expect(auditOut.findings[0]).toBe(auditIn[0]);
    expect(auditIn[0].evidence).toContain("ev-2");

    const remIn = mk();
    const remOut = crossLensDedupe(remIn, REMEDIATE_POLICY);
    expect(remOut.findings).toHaveLength(1);
    // Survivor is a CLONE — the caller's original A is never mutated.
    expect(remOut.findings[0]).not.toBe(remIn[0]);
    expect(remIn[0].evidence).toEqual(["ev-1"]);
    expect(remOut.mergeMap.get("B")).toBe("A");
  });

  it("fires onMerge for each merge (the remediate audit log hook)", () => {
    const merges: Array<[string, string]> = [];
    crossLensDedupe(
      [
        makeFinding({ id: "A", title: "Same defect here", lens: "security", category: "auth" }),
        makeFinding({ id: "B", title: "Same defect here", lens: "tests", category: "auth" }),
      ],
      { ...REMEDIATE_POLICY, onMerge: ({ absorbed, survivor }) => merges.push([absorbed.id, survivor.id]) },
    );
    expect(merges).toEqual([["B", "A"]]);
  });

  it("normalizes lens/category consistently (trim+lowercase) — a whitespace-only category difference is the SAME category", () => {
    // Deliberate one-core convergence: a trailing-space category typo must NOT
    // bypass the hard gate — the two are the same category and merge.
    const out = crossLensDedupe(
      [
        makeFinding({ id: "A", title: "Same defect", lens: "security", category: "auth" }),
        makeFinding({ id: "B", title: "Same defect", lens: "tests", category: "auth " }),
      ],
      REMEDIATE_POLICY,
    );
    expect(out.findings).toHaveLength(1);
  });

  // COR-5c71a9ff (clone-mode canonical accumulation): with N>=3 duplicates in
  // clone mode there must be exactly ONE canonical clone per original survivor —
  // every subsequent merge mutates that same clone, so nothing absorbed after the
  // first merge is silently dropped from the returned survivor.
  it("REPEATED SURVIVOR (clone mode, N>=3): successive merges accumulate on ONE clone; originals never mutated", () => {
    // TST-286008a5: with 3+ duplicates the survivor is absorbed into REPEATEDLY.
    // In clone mode the second merge must land on the SAME clone as the first —
    // a re-clone from the original would silently drop B's already-absorbed
    // evidence (finding-loss).
    const mk = () => [
      makeFinding({ id: "A", title: "Timeout not enforced", lens: "reliability", category: "net", severity: "high", evidence: ["ev-A"] }),
      makeFinding({ id: "B", title: "Timeout not enforced", lens: "correctness", category: "net", severity: "low", evidence: ["ev-B"] }),
      makeFinding({ id: "C", title: "Timeout not enforced", lens: "security", category: "net", severity: "low", evidence: ["ev-C"] }),
    ];
    const input = mk();
    const out = crossLensDedupe(input, REMEDIATE_POLICY);

    expect(out.findings).toHaveLength(1);
    const survivor = out.findings[0];
    expect(survivor.id).toBe("A");
    // BOTH absorbed findings' evidence accumulated on the one clone.
    expect(survivor.evidence).toContain("ev-A");
    expect(survivor.evidence, "first merge's evidence must survive the second merge").toContain("ev-B");
    expect(survivor.evidence).toContain("ev-C");
    // Every merge is recorded against the same survivor id.
    expect(out.mergeMap.get("B")).toBe("A");
    expect(out.mergeMap.get("C")).toBe("A");
    // Clone mode: the caller's ORIGINALS are untouched after repeated merges.
    expect(survivor).not.toBe(input[0]);
    expect(input[0].evidence).toEqual(["ev-A"]);
    expect(input[1].evidence).toEqual(["ev-B"]);
    expect(input[2].evidence).toEqual(["ev-C"]);
  });

  it("REPEATED SURVIVOR (mutate mode, N>=3): the one original survivor absorbs every duplicate", () => {
    const input = [
      makeFinding({ id: "A", title: "Timeout not enforced", lens: "reliability", category: "net", severity: "high", evidence: ["ev-A"] }),
      makeFinding({ id: "B", title: "Timeout not enforced", lens: "correctness", category: "net", severity: "low", evidence: ["ev-B"] }),
      makeFinding({ id: "C", title: "Timeout not enforced", lens: "security", category: "net", severity: "low", evidence: ["ev-C"] }),
    ];
    const out = crossLensDedupe(input, AUDIT_POLICY);
    expect(out.findings).toHaveLength(1);
    // Mutate mode: the survivor IS the caller's original object.
    expect(out.findings[0]).toBe(input[0]);
    expect(input[0].evidence).toEqual(expect.arrayContaining(["ev-A", "ev-B", "ev-C"]));
  });

  // COR-5c71a9ff-2 (conservation — no resurrection, no duplicate survivor
  // emission): when a finding that already absorbed others is ITSELF absorbed by
  // a stronger finding, it must vanish from the output — its accumulated data
  // lands on the final survivor and every mergeMap chain collapses to an id that
  // is present in the returned array.
  it("ABSORBED SURVIVOR (clone mode): a survivor later absorbed is never re-emitted; mergeMap chains collapse to the final survivor", () => {
    const input = [
      makeFinding({ id: "A", title: "Timeout not enforced", lens: "reliability", category: "net", severity: "medium", evidence: ["ev-A"] }),
      makeFinding({ id: "B", title: "Timeout not enforced", lens: "correctness", category: "net", severity: "low", evidence: ["ev-B"] }),
      makeFinding({ id: "C", title: "Timeout not enforced", lens: "security", category: "net", severity: "critical", evidence: ["ev-C"] }),
    ];
    // Pair (A,B): A survives, absorbs B. Pair (A,C): C outranks A — the A-clone
    // (carrying ev-A + ev-B) is absorbed into C's clone.
    const out = crossLensDedupe(input, REMEDIATE_POLICY);

    expect(out.findings, "the absorbed A-clone must not be resurrected next to C").toHaveLength(1);
    const survivor = out.findings[0];
    expect(survivor.id).toBe("C");
    expect(survivor.evidence).toEqual(expect.arrayContaining(["ev-A", "ev-B", "ev-C"]));
    // Chain B→A→C collapses: every mergeMap value is an id present in the output.
    expect(out.mergeMap.get("A")).toBe("C");
    expect(out.mergeMap.get("B"), "the merge chain must collapse to the FINAL survivor").toBe("C");
    expect(out.dispositionById!.get("A")).toEqual({
      status: "merged",
      terminalFindingId: "C",
      mergePath: ["A", "C"],
    });
    expect(out.dispositionById!.get("B")).toEqual({
      status: "merged",
      terminalFindingId: "C",
      mergePath: ["B", "A", "C"],
    });
    expect(out.dispositionById!.get("C")).toEqual({
      status: "retained",
      terminalFindingId: "C",
      mergePath: ["C"],
    });
    const emittedIds = new Set(out.findings.map((f) => f.id));
    for (const target of out.mergeMap.values()) {
      expect(emittedIds.has(target), `mergeMap target ${target} must be an emitted finding`).toBe(true);
    }
    // Conservation: every input id is emitted exactly once XOR absorbed.
    for (const f of input) {
      expect(emittedIds.has(f.id) !== out.mergeMap.has(f.id)).toBe(true);
    }
    // Clone mode: caller originals untouched.
    expect(input[2].evidence).toEqual(["ev-C"]);
  });

  // COR-5c71a9ff-2 (mutate mode / audit draw): once absorbed, a finding never
  // acts as a survivor in later pairwise comparisons — later duplicates merge
  // into the LIVE survivor, so their data is not stranded on a dropped finding.
  it("ABSORBED SURVIVOR (mutate mode): an absorbed i-slot finding never absorbs later candidates", () => {
    const input = [
      makeFinding({ id: "A", title: "Timeout not enforced", lens: "correctness", category: "net", severity: "low", evidence: ["ev-A"] }),
      makeFinding({ id: "B", title: "Timeout not enforced", lens: "security", category: "net", severity: "high", evidence: ["ev-B"] }),
      makeFinding({ id: "C", title: "Timeout not enforced", lens: "tests", category: "net", severity: "low", evidence: ["ev-C"] }),
    ];
    // Pair (A,B): B outranks A → A absorbed. A must then be EXCLUDED: C merges
    // with B (the live survivor), not with the removed A.
    const out = crossLensDedupe(input, AUDIT_POLICY);

    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]).toBe(input[1]);
    expect(input[1].evidence, "C's evidence must land on the live survivor, not the removed A").toEqual(
      expect.arrayContaining(["ev-A", "ev-B", "ev-C"]),
    );
    expect(out.mergeMap.get("A")).toBe("B");
    expect(out.mergeMap.get("C"), "C must be recorded against the live survivor").toBe("B");
  });

  it("IDEMPOTENCE (clone mode): re-running on its own output is a fixpoint", () => {
    const input = [
      makeFinding({ id: "A", title: "Timeout not enforced", lens: "reliability", category: "net", severity: "medium", evidence: ["ev-A"] }),
      makeFinding({ id: "B", title: "Timeout not enforced", lens: "correctness", category: "net", severity: "low", evidence: ["ev-B"] }),
      makeFinding({ id: "C", title: "Timeout not enforced", lens: "security", category: "net", severity: "critical", evidence: ["ev-C"] }),
    ];
    const first = crossLensDedupe(input, REMEDIATE_POLICY);
    const second = crossLensDedupe(first.findings, REMEDIATE_POLICY);
    expect(second.mergeMap.size, "a second run must find nothing left to merge").toBe(0);
    expect(second.findings).toEqual(first.findings);
  });

  it("never merges same-lens pairs (that is the same-lens pass' job)", () => {
    const out = crossLensDedupe(
      [
        makeFinding({ id: "A", title: "Identical", lens: "correctness", category: "x" }),
        makeFinding({ id: "B", title: "Identical", lens: "correctness", category: "x" }),
      ],
      AUDIT_POLICY,
    );
    expect(out.findings).toHaveLength(2);
  });

  it("rejects duplicate ids because an id-keyed terminal disposition would be ambiguous", () => {
    expect(() =>
      crossLensDedupe(
        [
          makeFinding({ id: "duplicate", lens: "security" }),
          makeFinding({ id: "duplicate", lens: "tests" }),
        ],
        REMEDIATE_POLICY,
      ),
    ).toThrow(/duplicate finding id/i);
  });

  // Audit's draw feeds packet-scoped ids that collide across units BY
  // CONSTRUCTION (global ids are minted downstream at assignStableFindingIds),
  // so the local discipline must accept them — and must NOT hand back an
  // id-keyed disposition map that would be mis-keyed.
  it("local id discipline accepts colliding packet-scoped ids and withholds dispositionById", () => {
    const out = crossLensDedupe(
      [
        makeFinding({ id: "MNT-001", title: "Unrelated one", lens: "security", affected_files: [{ path: "src/a.ts" }] }),
        makeFinding({ id: "MNT-001", title: "Different thing", lens: "tests", affected_files: [{ path: "src/b.ts" }] }),
      ],
      AUDIT_POLICY,
    );
    expect(out.findings).toHaveLength(2);
    expect(out.dispositionById, "packet-local ids cannot key a disposition map").toBeNull();
  });

  it("global id discipline emits a terminal disposition for every input id", () => {
    const input = [
      makeFinding({ id: "A", title: "Timeout not enforced", lens: "reliability", category: "net", severity: "low", evidence: ["ev-A"] }),
      makeFinding({ id: "B", title: "Timeout not enforced", lens: "correctness", category: "net", severity: "critical", evidence: ["ev-B"] }),
      makeFinding({ id: "C", title: "Wholly unrelated", lens: "tests", category: "other", affected_files: [{ path: "src/z.ts" }] }),
    ];
    const out = crossLensDedupe(input, REMEDIATE_POLICY);
    expect(out.dispositionById).not.toBeNull();
    expect(out.dispositionById!.get("A")).toEqual({ status: "merged", terminalFindingId: "B", mergePath: ["A", "B"] });
    expect(out.dispositionById!.get("B")).toEqual({ status: "retained", terminalFindingId: "B", mergePath: ["B"] });
    expect(out.dispositionById!.get("C")).toEqual({ status: "retained", terminalFindingId: "C", mergePath: ["C"] });
  });

  // In the shared `compareFindingPair`, the hard category gate runs AHEAD of both
  // the exact-identity short-circuit and the fuzzy title/overlap layer: an
  // exact-identity match must never cross categories under 'hard' policy, even
  // though on its own the exact-identity layer would happily collapse it.
  it("hard category gate blocks an exact-identity match across categories (gate precedes exact-identity)", () => {
    const findings = [
      // Same structural anchor (path + symbol) → discriminating exact-identity
      // match — but DIFFERENT categories, and the policy is 'hard'.
      makeFinding({
        id: "A",
        title: "Totally different wording one",
        lens: "security",
        category: "auth",
        affected_files: [{ path: "src/session.ts", symbol: "refresh" }],
      }),
      makeFinding({
        id: "B",
        title: "Totally different wording two",
        lens: "correctness",
        category: "resource-leak",
        affected_files: [{ path: "src/session.ts", symbol: "refresh" }],
      }),
    ];
    const out = crossLensDedupe(findings, { ...REMEDIATE_POLICY, categoryGate: "hard" });
    expect(out.findings, "the hard gate must block the merge even though exact-identity alone would collapse it").toHaveLength(2);
    expect(out.mergeMap.size).toBe(0);
  });

  // `crossLensDedupe`'s post-fold chain collapse walks mergeMap via a `visited`
  // guard so a malformed input (duplicate caller-supplied ids, precondition 2 of
  // the published contract violated) TERMINATES instead of spinning on the id
  // cycle it produces. The resulting chain target in that malformed case is
  // deliberately unspecified — this test proves termination, not a target value.
  it("chain collapse terminates on a malformed duplicate-id cycle instead of spinning (visited guard)", () => {
    const policy: CrossLensDedupePolicy = {
      categoryGate: "soft",
      exactIdentityShortCircuit: false,
      survivorMutation: "clone",
      mergeGrounding: false,
      sortAffectedFiles: false,
      idDiscipline: "local",
    };
    // Two DIFFERENT primary-path groups, each producing one absorb event, wired
    // so the two mergeMap entries reference each other's id (DUP1<->DUP2) —
    // a 2-cycle that only a malformed (duplicate-id) input can produce, since
    // ids are supposed to be unique per call.
    const findings = [
      makeFinding({ id: "DUP1", title: "Group one issue", category: "g1", lens: "correctness", severity: "low", affected_files: [{ path: "src/one.ts" }] }),
      makeFinding({ id: "DUP2", title: "Group one issue", category: "g1", lens: "security", severity: "high", affected_files: [{ path: "src/one.ts" }] }),
      makeFinding({ id: "DUP2", title: "Group two issue", category: "g2", lens: "correctness", severity: "low", affected_files: [{ path: "src/two.ts" }] }),
      makeFinding({ id: "DUP1", title: "Group two issue", category: "g2", lens: "tests", severity: "high", affected_files: [{ path: "src/two.ts" }] }),
    ];

    let result: ReturnType<typeof crossLensDedupe> | undefined;
    expect(() => {
      result = crossLensDedupe(findings, policy);
    }, "the call must return synchronously — a spin on the id cycle would hang the test").not.toThrow();

    expect(result).toBeDefined();
    // Both groups still each absorb one finding: 4 inputs - 2 absorbed = 2 survivors.
    expect(result!.findings).toHaveLength(2);
    // Every recorded target is a resolved string id — collapse always halts on
    // SOME value rather than leaving an entry unresolved.
    for (const target of result!.mergeMap.values()) {
      expect(typeof target).toBe("string");
      expect(target.length).toBeGreaterThan(0);
    }
  });

  // Conservation (explicit count form): every input finding is emitted exactly
  // once in findings[] XOR recorded as a mergeMap key — never both, never
  // neither. |findings| + |mergeMap keys| == |input findings| whenever ids are
  // unique per call (the published contract's precondition 2).
  describe("conservation: |output.findings| + |mergeMap keys| == |input findings|", () => {
    const cases: Array<[string, () => Finding[], CrossLensDedupePolicy]> = [
      [
        "no merges",
        () => [
          makeFinding({ id: "A", title: "Alpha issue", lens: "security" }),
          makeFinding({ id: "B", title: "Totally unrelated beta", lens: "correctness", affected_files: [{ path: "src/other.ts" }] }),
        ],
        AUDIT_POLICY,
      ],
      [
        "one merge",
        () => [
          makeFinding({ id: "A", title: "Duplicated auth check", lens: "security", category: "auth" }),
          makeFinding({ id: "B", title: "Duplicated auth check", lens: "correctness", category: "auth" }),
        ],
        REMEDIATE_POLICY,
      ],
      [
        "chained absorb-then-absorbed (3 findings, 1 survivor)",
        () => [
          makeFinding({ id: "A", title: "Timeout not enforced", lens: "reliability", category: "net", severity: "medium" }),
          makeFinding({ id: "B", title: "Timeout not enforced", lens: "correctness", category: "net", severity: "low" }),
          makeFinding({ id: "C", title: "Timeout not enforced", lens: "security", category: "net", severity: "critical" }),
        ],
        REMEDIATE_POLICY,
      ],
    ];

    for (const [label, build, policy] of cases) {
      it(label, () => {
        const input = build();
        const out = crossLensDedupe(input, policy);
        expect(out.findings.length + out.mergeMap.size).toBe(input.length);
      });
    }
  });
});

// ── sameLensDedupe: the mid-scan absorbed-survivor conservation guard ────────
//
// The i-slot finding can be absorbed MID-SCAN (as the `b` of an earlier pair).
// Without the unconditional `removed.has(group[i])` break, that dead i-slot
// keeps winning later pairs, and the closing `findings.filter` then discards it
// TOGETHER with everything it absorbed after its own removal — a silent finding
// loss. The guard shipped without a regression test; this is it.

describe("sameLensDedupe — an absorbed i-slot survivor never absorbs again (conservation)", () => {
  function sameLensFinding(overrides: Partial<Finding> & { id: string }): Finding {
    return {
      title: "Retry loop never terminates",
      category: "reliability",
      severity: "medium",
      confidence: "medium",
      lens: "correctness",
      summary: "Same summary.",
      affected_files: [{ path: "src/retry.ts", line_start: 10, line_end: 20 }],
      evidence: [],
      ...overrides,
    };
  }

  it("drops the mid-scan-absorbed survivor AND lands every input's evidence on an emitted finding", () => {
    // One same-lens, same-primary-path group of three mutually-matching
    // findings: identical titles (Jaccard 1.0 >= the 0.35 same-category floor)
    // and identical line ranges (lineRangeOverlaps true), so every pair clears
    // the match gates and only the survivor rule decides the outcome.
    //
    //   X medium/high · Y critical/low · Z medium/low
    //
    // (X,Y): Y outranks X on severity, so the i-slot X is absorbed MID-SCAN.
    // (X,Z): X would still outrank Z on confidence — so WITHOUT the guard the
    //        dead X absorbs Z, and the final filter drops both: ev-Z is lost.
    // With the guard the inner scan breaks, and (Y,Z) lands Z's data on the
    // LIVE survivor instead.
    const x = sameLensFinding({ id: "X", severity: "medium", confidence: "high", evidence: ["ev-X"] });
    const y = sameLensFinding({ id: "Y", severity: "critical", confidence: "low", evidence: ["ev-Y"] });
    const z = sameLensFinding({ id: "Z", severity: "medium", confidence: "low", evidence: ["ev-Z"] });

    const out = sameLensDedupe([x, y, z]);

    // No resurrection: the absorbed X is never emitted beside the live survivor.
    expect(out.map((f) => f.id), "only the live survivor Y is emitted").toEqual(["Y"]);
    // Conservation: no input's evidence is stranded on a finding that was itself
    // dropped — every input contributes to the emitted set.
    const emittedEvidence = new Set(out.flatMap((f) => f.evidence ?? []));
    for (const ev of ["ev-X", "ev-Y", "ev-Z"]) {
      expect(emittedEvidence.has(ev), `${ev} must reach an emitted finding`).toBe(true);
    }
  });
});

// ── mergeGrounding: precedence grounded > refuted > ungrounded > absent ──────────

describe("mergeGrounding — precedence grounded > refuted > ungrounded > absent", () => {
  it("grounded beats refuted, refuted beats ungrounded, ungrounded beats absent", () => {
    const grounded: Finding["grounding"] = { status: "grounded" };
    const refuted: Finding["grounding"] = { status: "refuted", reason: "anchor disproved it" };
    const ungrounded: Finding["grounding"] = { status: "ungrounded", reason: "quote not found" };
    const absent: Finding["grounding"] = undefined;

    expect(mergeGrounding(refuted, grounded)).toEqual({ status: "grounded" });
    expect(mergeGrounding(grounded, refuted)).toEqual({ status: "grounded" });
    expect(mergeGrounding(ungrounded, refuted)).toEqual(refuted);
    expect(mergeGrounding(refuted, ungrounded)).toEqual(refuted);
    expect(mergeGrounding(absent, ungrounded)).toEqual(ungrounded);
    expect(mergeGrounding(ungrounded, absent)).toEqual(ungrounded);
    expect(mergeGrounding(absent, absent)).toBeUndefined();
  });

  it("a grounded winner is normalized to the bare verdict — any reason on either side is dropped", () => {
    // mergeGrounding's own doc: "grounded carries no reason" — even if the
    // LOSING side (or a malformed grounded side) carried a reason, the merged
    // result must be exactly {status:'grounded'}, nothing else.
    const groundedWithStray = { status: "grounded" as const, reason: "should never appear" };
    const refuted: Finding["grounding"] = { status: "refuted", reason: "anchor disproved it" };
    expect(mergeGrounding(refuted, groundedWithStray)).toEqual({ status: "grounded" });
    expect(Object.keys(mergeGrounding(refuted, groundedWithStray) ?? {})).toEqual(["status"]);
  });

  it("an ungrounded/absent verdict never downgrades an already-grounded finding", () => {
    const grounded: Finding["grounding"] = { status: "grounded" };
    expect(mergeGrounding(grounded, { status: "ungrounded", reason: "x" })).toEqual({ status: "grounded" });
    expect(mergeGrounding(grounded, undefined)).toEqual({ status: "grounded" });
  });
});

// ── upsertFindingByIdentity: escalate-only, OR, backfill-when-unset (:389-398) ─

describe("upsertFindingByIdentity — escalate severity/confidence, OR systemic, backfill impact/likelihood only when unset", () => {
  function identityFinding(overrides: Partial<Finding> = {}): Finding {
    return {
      id: "F-1",
      title: "Same identity title",
      category: "same-category",
      severity: "low",
      confidence: "low",
      lens: "correctness",
      summary: "short",
      affected_files: [{ path: "src/x.ts" }],
      evidence: ["ev-1"],
      ...overrides,
    };
  }

  it("severity and confidence only ESCALATE — a lower-rank incoming finding never downgrades the existing entry", () => {
    const merged = new Map<string, Finding>();
    upsertFindingByIdentity(merged, identityFinding({ id: "A", severity: "critical", confidence: "high" }));
    // Incoming re-emission carries a LOWER severity/confidence than what's
    // already recorded — the escalate-only rule must leave the higher ranks in
    // place, never downgrade to match the incoming.
    upsertFindingByIdentity(merged, identityFinding({ id: "B", severity: "low", confidence: "low" }));

    const [entry] = [...merged.values()];
    expect(entry.severity, "severity must not downgrade from critical to low").toBe("critical");
    expect(entry.confidence, "confidence must not downgrade from high to low").toBe("high");
  });

  it("severity and confidence DO escalate when the incoming finding outranks the existing entry", () => {
    const merged = new Map<string, Finding>();
    upsertFindingByIdentity(merged, identityFinding({ id: "A", severity: "low", confidence: "low" }));
    upsertFindingByIdentity(merged, identityFinding({ id: "B", severity: "critical", confidence: "high" }));

    const [entry] = [...merged.values()];
    expect(entry.severity).toBe("critical");
    expect(entry.confidence).toBe("high");
  });

  it("systemic ORs across re-emissions (true once true, never reverts to false)", () => {
    const merged = new Map<string, Finding>();
    upsertFindingByIdentity(merged, identityFinding({ id: "A", systemic: true }));
    upsertFindingByIdentity(merged, identityFinding({ id: "B", systemic: false }));
    const [entry] = [...merged.values()];
    expect(entry.systemic).toBe(true);
  });

  it("impact/likelihood backfill ONLY when unset on the existing entry — an already-set value is never overwritten", () => {
    const merged = new Map<string, Finding>();
    upsertFindingByIdentity(merged, identityFinding({ id: "A", impact: "original impact", likelihood: undefined }));
    upsertFindingByIdentity(
      merged,
      identityFinding({ id: "B", impact: "incoming impact — must NOT win", likelihood: "backfilled likelihood" }),
    );
    const [entry] = [...merged.values()];
    // impact was already set on the first insert — the second upsert must not
    // overwrite it.
    expect(entry.impact, "an already-set impact must never be overwritten by a later re-emission").toBe("original impact");
    // likelihood was unset — the second upsert backfills it.
    expect(entry.likelihood, "an unset likelihood must be backfilled from a later re-emission").toBe("backfilled likelihood");
  });
});
