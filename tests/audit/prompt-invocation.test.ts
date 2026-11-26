import { test, expect } from "vitest";
import { spawnSyncHidden } from "../helpers/spawn.mjs";
import { nextStepCommand, renderAuditCommand } from "../../src/audit/cli/prompts.js";

function withInvocation(value: string | undefined, fn: () => void): void {
  const prev = process.env.AUDIT_CODE_INVOCATION;
  if (value === undefined) delete process.env.AUDIT_CODE_INVOCATION;
  else process.env.AUDIT_CODE_INVOCATION = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.AUDIT_CODE_INVOCATION;
    else process.env.AUDIT_CODE_INVOCATION = prev;
  }
}

test("next-step commands default to the audit-code bin when no invocation hint is set", () => {
  withInvocation(undefined, () => {
    expect(nextStepCommand("/repo", "/repo/.audit-tools/audit")).toMatch(/^audit-code next-step --root \/repo --artifacts-dir /);
  });
});

test("next-step commands honor AUDIT_CODE_INVOCATION (source-checkout dogfooding)", () => {
  withInvocation(
    JSON.stringify(["node", "C:/Code/audit-tools/packages/audit-code/audit-code.mjs"]),
    () => {
      const cmd = nextStepCommand("/repo", "/repo/.audit-tools/audit");
      expect(cmd).toMatch(/^node /);
      expect(cmd).toMatch(/audit-code\.mjs next-step/);
      expect(cmd).not.toMatch(/^audit-code /);
    },
  );
});

test("next-step commands emit POSIX separators so Windows backslash paths survive a bash host", () => {
  withInvocation(
    JSON.stringify(["node", "C:\\Code\\audit-tools\\packages\\audit-code\\audit-code.mjs"]),
    () => {
      // Backslash invocation path AND backslash root/artifacts-dir args.
      const next = nextStepCommand("C:\\Code\\repo", "C:\\Code\\repo\\.audit-tools/audit");
      // No backslash may survive: a bash host treats `\` as an escape and would
      // collapse `node C:\a\b.mjs` to `node C:ab.mjs`.
      expect(next).not.toMatch(/\\/);
      expect(next).toMatch(/^node C:\/Code\/audit-tools\/packages\/audit-code\/audit-code\.mjs next-step --root C:\/Code\/repo --artifacts-dir C:\/Code\/repo\/\.audit-tools\/audit$/);
    },
  );
});

test("malformed AUDIT_CODE_INVOCATION falls back to the audit-code bin", () => {
  withInvocation("not-json", () => {
    expect(nextStepCommand("/repo", "/a")).toMatch(/^audit-code next-step /);
  });
  // Non-array JSON and empty array are also rejected.
  withInvocation("{}", () => {
    expect(nextStepCommand("/repo", "/a")).toMatch(/^audit-code /);
  });
  withInvocation("[]", () => {
    expect(nextStepCommand("/repo", "/a")).toMatch(/^audit-code /);
  });
});

test.skipIf(process.platform === "win32")("POSIX audit command preserves literal graph paths", () => {
  withInvocation(JSON.stringify([process.execPath]), () => {
    const path = "/tmp/$TEAM's audit/graph\\index.json";
    const rendered = renderAuditCommand([
      "-e", "process.stdout.write(process.argv[1])", "--", path,
    ], "linux");
    const run = spawnSyncHidden("sh", ["-c", rendered], {
      encoding: "utf8", env: { ...process.env, TEAM: "should-not-expand" },
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(path);
  });
});

test("PowerShell audit command uses literal tokens and calls a quoted launcher", () => {
  withInvocation(JSON.stringify(["C:\\Audit Tools\\audit-code.cmd", "--expect-version=0.57.11"]), () => {
    expect(renderAuditCommand(["review-graph", "--graph-index", "C:\\$TEAM's audit\\graph.json"], "win32"))
      .toBe("& 'C:/Audit Tools/audit-code.cmd' --expect-version=0.57.11 review-graph --graph-index 'C:/$TEAM''s audit/graph.json'");
  });
});
