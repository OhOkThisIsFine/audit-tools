import { test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, sep } from "node:path";

const {
  resolveHostDispatchCapability,
  optionalBooleanEnv,
  getArtifactsDir,
  getRootDir,
} = await import("../../src/audit/cli/args.ts");

const ARGS_SOURCE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "src",
  "audit",
  "cli",
  "args.ts",
);

// ---------------------------------------------------------------------------
// resolveHostDispatchCapability
// ---------------------------------------------------------------------------

test("resolveHostDispatchCapability: explicit=true wins over sessionConfig false and env false", () => {
  expect(resolveHostDispatchCapability({
      explicit: true,
      sessionConfig: /** @type {any} */ ({ host_can_dispatch_subagents: false }),
      env: { AUDIT_CODE_HOST_CAN_DISPATCH: "false" },
    })).toBe(true);
});

test("resolveHostDispatchCapability: explicit=false wins over sessionConfig true and env true", () => {
  expect(resolveHostDispatchCapability({
      explicit: false,
      sessionConfig: /** @type {any} */ ({ host_can_dispatch_subagents: true }),
      env: { AUDIT_CODE_HOST_CAN_DISPATCH: "true" },
    })).toBe(false);
});

test("resolveHostDispatchCapability: sessionConfig false wins when explicit is undefined", () => {
  expect(resolveHostDispatchCapability({
      sessionConfig: /** @type {any} */ ({ host_can_dispatch_subagents: false }),
      env: { AUDIT_CODE_HOST_CAN_DISPATCH: "true" },
    })).toBe(false);
});

test("resolveHostDispatchCapability: sessionConfig true wins when explicit is undefined", () => {
  expect(resolveHostDispatchCapability({
      sessionConfig: /** @type {any} */ ({ host_can_dispatch_subagents: true }),
    })).toBe(true);
});

test("resolveHostDispatchCapability: env AUDIT_CODE_HOST_CAN_DISPATCH=false used when explicit and sessionConfig both absent", () => {
  expect(resolveHostDispatchCapability({
      sessionConfig: /** @type {any} */ ({}),
      env: { AUDIT_CODE_HOST_CAN_DISPATCH: "false" },
    })).toBe(false);
});

test("resolveHostDispatchCapability: env AUDIT_CODE_HOST_CAN_DISPATCH=true used when explicit and sessionConfig both absent", () => {
  expect(resolveHostDispatchCapability({
      sessionConfig: /** @type {any} */ ({}),
      env: { AUDIT_CODE_HOST_CAN_DISPATCH: "true" },
    })).toBe(true);
});

test("resolveHostDispatchCapability: defaults to true when all inputs absent", () => {
  expect(resolveHostDispatchCapability({
      sessionConfig: /** @type {any} */ ({}),
      env: {},
    })).toBe(true);
});

test("resolveHostDispatchCapability: garbage env var value falls back to default true", () => {
  expect(resolveHostDispatchCapability({
      sessionConfig: /** @type {any} */ ({}),
      env: { AUDIT_CODE_HOST_CAN_DISPATCH: "yes" },
    })).toBe(true);
});

// ---------------------------------------------------------------------------
// optionalBooleanEnv
// ---------------------------------------------------------------------------

test("optionalBooleanEnv: 'true' → true", () => {
  expect(optionalBooleanEnv("true")).toBe(true);
});

test("optionalBooleanEnv: 'false' → false", () => {
  expect(optionalBooleanEnv("false")).toBe(false);
});

test("optionalBooleanEnv: undefined → undefined", () => {
  expect(optionalBooleanEnv(undefined)).toBe(undefined);
});

test("optionalBooleanEnv: empty string → undefined", () => {
  expect(optionalBooleanEnv("")).toBe(undefined);
});

test("optionalBooleanEnv: '1' → undefined", () => {
  expect(optionalBooleanEnv("1")).toBe(undefined);
});

test("optionalBooleanEnv: 'yes' → undefined", () => {
  expect(optionalBooleanEnv("yes")).toBe(undefined);
});

test("optionalBooleanEnv: 'TRUE' (uppercase) → undefined", () => {
  expect(optionalBooleanEnv("TRUE")).toBe(undefined);
});

// ---------------------------------------------------------------------------
// getArtifactsDir / getRootDir — default rebases onto --root (latent bug fix)
// ---------------------------------------------------------------------------

test("getArtifactsDir: --root <X> with no --artifacts-dir resolves under <X>/.audit-tools/audit", () => {
  const rootX = resolve(sep, "tmp", "some-target-root");
  const argv = ["--root", rootX];
  expect(getRootDir(argv)).toBe(rootX);
  // The default MUST rebase onto --root, not resolve `.audit-tools/audit`
  // against the process CWD.
  expect(getArtifactsDir(argv)).toBe(join(rootX, ".audit-tools", "audit"));
});

test("getArtifactsDir: bare default (no flags) resolves under CWD/.audit-tools/audit", () => {
  expect(getArtifactsDir([])).toBe(join(resolve("."), ".audit-tools", "audit"));
});

test("getArtifactsDir: explicit --artifacts-dir is honored verbatim (ignores --root)", () => {
  const rootX = resolve(sep, "tmp", "some-target-root");
  const explicit = resolve(sep, "var", "artifacts", "elsewhere");
  const argv = ["--root", rootX, "--artifacts-dir", explicit];
  expect(getArtifactsDir(argv)).toBe(explicit);
});

// ---------------------------------------------------------------------------
// Guard: no other `.audit-tools` path-join literal in CLI args code.
// The single allowed `.audit-tools` literal is the DIRECT_CLI_DEFAULTS default
// sentinel (which getArtifactsDir rebases through the shared auditToolsPaths
// helper). Any other occurrence in code means a join literal was reintroduced
// instead of routing through audit-tools/shared — which is exactly the drift
// this module exists to prevent.
// ---------------------------------------------------------------------------

/** Strip `//` line comments and `/* *\/` block comments so only code remains. */
function stripComments(source) {
  const withoutBlock = source.replace(/\/\*[\s\S]*?\*\//g, "");
  return withoutBlock
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

test("CLI args code has no `.audit-tools` path-join literal beyond the single default sentinel", () => {
  const code = stripComments(readFileSync(ARGS_SOURCE_PATH, "utf8"));
  const occurrences = (code.match(/\.audit-tools/g) ?? []).length;
  expect(occurrences, `Expected exactly one '.audit-tools' literal (the DIRECT_CLI_DEFAULTS default) in ${ARGS_SOURCE_PATH}, found ${occurrences}. Route path construction through audit-tools/shared auditToolsPaths instead of re-spelling the join literal.`).toBe(1);
  // The one allowed occurrence is the default-value sentinel, not a join() arg.
  expect(code).toMatch(/artifactsDir:\s*"\.audit-tools\/audit"/);
  expect(code, "No join()/resolve() call in CLI args code may take a '.audit-tools' literal — use the shared auditToolsPaths helpers.").not.toMatch(/(?:join|resolve)\([^)]*\.audit-tools/);
});
