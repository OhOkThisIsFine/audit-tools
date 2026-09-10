/**
 * Generated host configs are BYTE-STABLE under repeated ensure (open-bugs:
 * "`ensure` writes opencode.json with unstable key order" — property to hold:
 * generated host configs are byte-stable under repeated ensure).
 *
 * The defect: the merged permission blocks were emitted in COMPOSITION order
 * (generated keys, then existing keys, then managed keys), so the committed key
 * order depended on which installer/deployer touched the file last. The audit
 * deployer's edit block seeded `.audit-code/**` before `.audit-tools/**` while
 * the remediate one seeded `.remediate-code/**` first, so running `ensure` (or
 * either postinstall) rewrote `opencode.json` as a pure key-reorder diff with
 * no value changed — dirtying every tree it touched. `stableRuleOrder` in
 * src/shared/opencodePermissions.ts is the fix.
 *
 * Two levels are pinned here, because they fail independently:
 *   1. the shared merge helper emits a stable order for the same rule set
 *      regardless of which installer produced it (pure, no IO), and
 *   2. a real `ensureBootstrap` re-run produces IDENTICAL BYTES (the property
 *      the backlog entry states) — the end-to-end proof.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { scratchDir } from "../helpers/scratch.js";
import { ensureBootstrap as ensureAudit } from "../../wrapper/audit-code-wrapper-install-hosts.mjs";
import { ensureBootstrap as ensureRemediate } from "../../wrapper/remediate-code-wrapper-install-hosts.mjs";
import { buildMergedOpenCodeProjectConfig as mergeAudit } from "../../wrapper/audit-code-wrapper-opencode.mjs";
import { buildMergedOpenCodeProjectConfig as mergeRemediate } from "../../wrapper/remediate-code-wrapper-opencode.mjs";
import { mergeOpenCodeGlobalPermissionRule as mergeGlobalAudit } from "../../src/shared/opencodePermissions.js";

const SCRATCH = scratchDir(".test-ensure-opencode-stability");

/** The permission-key order of a merged config, as a flat printable list. */
function editKeyOrder(config: unknown): string[] {
  const permission = (config as { permission?: { edit?: Record<string, string> } })
    ?.permission;
  return Object.keys(permission?.edit ?? {});
}

describe("generated opencode.json is byte-stable under repeated ensure", () => {
  beforeEach(async () => {
    await rm(SCRATCH, { recursive: true, force: true });
    await mkdir(SCRATCH, { recursive: true });
  });

  afterEach(async () => {
    await rm(SCRATCH, { recursive: true, force: true });
  });

  it("re-running ensure (forcing the rewrite) produces identical bytes", async () => {
    const configPath = join(SCRATCH, "opencode.json");
    const ensure = (force: boolean) =>
      // --force is what makes the second run REACH the merge instead of
      // answering "skipped": the property under test is that the write path is
      // a fixpoint, not that ensure declines to write.
      ensureAudit([
        "--root",
        SCRATCH,
        "--host",
        "opencode",
        "--quiet",
        ...(force ? ["--force"] : []),
      ]);

    await ensure(false);
    const first = await readFile(configPath, "utf8");
    await ensure(true);
    const second = await readFile(configPath, "utf8");
    await ensure(true);
    const third = await readFile(configPath, "utf8");

    // A pure key-reorder diff shows up as a byte difference with an identical
    // parsed value — assert both, so the failure names which one it is.
    expect(
      JSON.parse(second),
      "a forced re-ensure must not change any opencode.json VALUE",
    ).toEqual(JSON.parse(first));
    expect(
      second,
      "a forced re-ensure must not rewrite opencode.json as a key-reorder diff " +
        "(generated host configs are byte-stable)",
    ).toBe(first);
    expect(third, "the write path must be a fixpoint from the second run on").toBe(second);
  });

  it("alternating the two orchestrators' ensure leaves the bytes alone", async () => {
    // The real-world churn: both orchestrators deploy into the SAME
    // opencode.json, so once both key sets are present, every alternation used
    // to rewrite the file as a pure key-reorder diff — the audit deployer
    // emitting its `.audit-code/**` first and the remediate one its
    // `.remediate-code/**` first. Settle the file first (both sets present),
    // then prove each orchestrator's rewrite is a no-op.
    const configPath = join(SCRATCH, "opencode.json");
    const force = (run: typeof ensureAudit) =>
      run(["--root", SCRATCH, "--host", "opencode", "--quiet", "--force"]);

    await force(ensureAudit);
    await force(ensureRemediate);
    const settled = await readFile(configPath, "utf8");
    // Both orchestrators' key sets are present, so a reorder is now possible.
    for (const pattern of [".audit-code/**", ".remediate-code/**"]) {
      expect(settled, `the settled file must carry both orchestrators' keys (${pattern})`).toContain(pattern);
    }

    await force(ensureAudit);
    const afterAudit = await readFile(configPath, "utf8");
    await force(ensureRemediate);
    const afterRemediate = await readFile(configPath, "utf8");

    expect(
      afterAudit,
      "audit-code ensure must not reorder the opencode.json remediate-code ensure left behind",
    ).toBe(settled);
    expect(
      afterRemediate,
      "remediate-code ensure must not reorder the opencode.json audit-code ensure just wrote",
    ).toBe(settled);
  });

  it("the audit and remediate deployers emit the SAME key order for the same key set", async () => {
    // Start from a file that already carries both orchestrators' edit keys, so
    // the two merges see an identical key set and only their emission order can
    // differ. Historically the audit deployer emitted `.audit-code/**` first
    // and the remediate one `.remediate-code/**` first, so whichever ran last
    // reordered the file the other had just written.
    const seed = {
      permission: {
        read: "allow",
        glob: "allow",
        grep: "allow",
        edit: {
          "*": "ask",
          ".audit-code/**": "allow",
          ".audit-tools/**": "allow",
          ".remediate-code/**": "allow",
        },
        bash: { "*": "ask" },
      },
    };
    const afterAudit = mergeAudit(structuredClone(seed), SCRATCH);
    const afterRemediate = mergeRemediate(structuredClone(seed), SCRATCH);

    expect(
      editKeyOrder(afterAudit),
      "the audit deployer must emit the permission edit keys in the one shared stable order",
    ).toEqual(editKeyOrder(afterRemediate));
    expect(editKeyOrder(afterAudit), "…and that order is '*' then lexicographic").toEqual([
      "*",
      ".audit-code/**",
      ".audit-tools/**",
      ".remediate-code/**",
    ]);

    // And each is a fixpoint: merging the other's output changes no order.
    expect(editKeyOrder(mergeRemediate(structuredClone(afterAudit), SCRATCH))).toEqual(
      editKeyOrder(afterAudit),
    );
    expect(editKeyOrder(mergeAudit(structuredClone(afterRemediate), SCRATCH))).toEqual(
      editKeyOrder(afterRemediate),
    );
  });

  it("the GLOBAL-scope merge emits the same key order whatever order it is fed", () => {
    // The global (top-level) scope is the other merged block, and it is reached
    // by a different code path than the agent scope above: the two installers
    // hand it DIFFERENT bash seeds (audit-first vs remediate-first), so an
    // emission in composition order would churn the top-level bash block on
    // every alternation exactly as the edit map used to. Pinned by feeding one
    // key set in two deliberately opposite orders and requiring ONE output.
    // A surviving user wildcard is part of the shape (the global scope never
    // SEEDS one, but preserves a non-managed one), so it rides the fixture.
    const managed = { ".audit-code/**": "allow", ".audit-tools/**": "allow", ".remediate-code/**": "allow" };
    const auditFirst = { "*": "ask", ".audit-code/**": "allow", ".audit-tools/**": "allow", ".remediate-code/**": "allow" };
    const remediateFirst = { "*": "ask", ".remediate-code/**": "allow", ".audit-tools/**": "allow", ".audit-code/**": "allow" };

    const afterAuditFirst = mergeGlobalAudit(auditFirst, auditFirst, managed);
    const afterRemediateFirst = mergeGlobalAudit(remediateFirst, remediateFirst, managed);

    expect(
      Object.keys(afterRemediateFirst),
      "the global merge must emit one canonical key order regardless of the order it was fed",
    ).toEqual(Object.keys(afterAuditFirst));
    expect(Object.keys(afterAuditFirst), "…and that order is '*' then lexicographic").toEqual([
      "*",
      ".audit-code/**",
      ".audit-tools/**",
      ".remediate-code/**",
    ]);
  });

  it("re-running ensure after the other deployer reordered the file converges", async () => {
    // Worst case: an opencode.json hand-ordered remediate-first. One ensure
    // must settle it into the canonical order and then never touch it again.
    const configPath = join(SCRATCH, "opencode.json");
    await writeFile(
      configPath,
      JSON.stringify(
        {
          permission: {
            read: "allow",
            glob: "allow",
            grep: "allow",
            edit: {
              "*": "ask",
              ".remediate-code/**": "allow",
              ".audit-tools/**": "allow",
              ".audit-code/**": "allow",
            },
            bash: { "*": "ask" },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    await ensureAudit(["--root", SCRATCH, "--host", "opencode", "--quiet"]);
    const settled = await readFile(configPath, "utf8");
    await ensureAudit(["--root", SCRATCH, "--host", "opencode", "--quiet", "--force"]);
    const reRun = await readFile(configPath, "utf8");

    expect(
      reRun,
      "ensure must converge a foreign key order to a fixpoint in one run, then leave the bytes alone",
    ).toBe(settled);
  });
});
