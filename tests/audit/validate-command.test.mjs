import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { captureConsole } from "./helpers/captureConsole.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const distCliUrl = pathToFileURL(join(repoRoot, "dist", "audit", "cli.js")).href;
const { runCli } = await import(distCliUrl);

async function runValidate(root) {
  const argv = [
    process.execPath,
    join(repoRoot, "dist", "audit", "cli.js"),
    "validate",
    "--root",
    root,
    "--artifacts-dir",
    join(root, ".audit-tools/audit"),
  ];
  return captureConsole(() => runCli(argv));
}

function parseJsonOutput(result) {
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    assert.fail(
      [
        "Expected audit-code validate to write JSON to stdout.",
        `stdout: ${result.stdout}`,
        `stderr: ${result.stderr}`,
        `parse error: ${error instanceof Error ? error.message : String(error)}`,
      ].join("\n"),
    );
  }
}

async function withTempRepo(fn) {
  const tempDir = await mkdtemp(join(tmpdir(), "audit-code-validate-"));
  const root = join(tempDir, "repo");
  try {
    await mkdir(root, { recursive: true });
    return await fn(root);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

test("audit-code validate exits non-zero when validation issues exist", async () => {
  await withTempRepo(async (root) => {
    const artifactsDir = join(root, ".audit-tools/audit");
    await mkdir(artifactsDir, { recursive: true });

    await writeFile(
      join(artifactsDir, "repo_manifest.json"),
      JSON.stringify(
        {
          repository: { name: "fixture" },
          generated_at: "2026-04-17T00:00:00Z",
          files: [
            {
              path: "src/api/auth.ts",
              size_bytes: 10,
              language: "ts",
            },
            {
              path: "src/lib/session.ts",
              size_bytes: 12,
              language: "ts",
            },
          ],
        },
        null,
        2,
      ),
    );
    await writeFile(
      join(artifactsDir, "file_disposition.json"),
      JSON.stringify(
        {
          files: [
            {
              path: "src/api/auth.ts",
              status: "included",
            },
          ],
        },
        null,
        2,
      ),
    );
    await writeFile(
      join(artifactsDir, "unit_manifest.json"),
      JSON.stringify(
        {
          units: [
            {
              unit_id: "auth-unit",
              name: "auth-unit",
              files: ["src/api/auth.ts", "src/ghost.ts"],
              required_lenses: ["security"],
            },
          ],
        },
        null,
        2,
      ),
    );
    await writeFile(
      join(artifactsDir, "coverage_matrix.json"),
      JSON.stringify(
        {
          files: [
            {
              path: "src/api/auth.ts",
              unit_ids: ["auth-unit"],
              classification_status: "classified",
              audit_status: "pending",
              required_lenses: ["security"],
              completed_lenses: ["security", "tests"],
            },
            {
              path: "src/ghost.ts",
              unit_ids: ["ghost-unit"],
              classification_status: "classified",
              audit_status: "pending",
              required_lenses: ["security"],
              completed_lenses: [],
            },
          ],
        },
        null,
        2,
      ),
    );

    const result = await runValidate(root);
    const parsed = parseJsonOutput(result);

    assert.notEqual(result.code, 0);
    // The fixture intentionally also seeds src/ghost.ts / ghost-unit in the
    // coverage matrix without backing repo_manifest / unit_manifest entries,
    // which yields two further coverage-integrity issues on top of the four
    // asserted below (6 total).
    assert.equal(parsed.issue_count, 6);
    assert.ok(
      parsed.issues.some(
        (issue) =>
          issue.path === "file_disposition" &&
          /missing disposition entry for src\/lib\/session\.ts/i.test(
            issue.message,
          ),
      ),
    );
    assert.ok(
      parsed.issues.some(
        (issue) =>
          issue.path === "coverage_matrix" &&
          /missing coverage entry for src\/lib\/session\.ts/i.test(
            issue.message,
          ),
      ),
    );
    assert.ok(
      parsed.issues.some(
        (issue) =>
          issue.path === "unit_manifest:auth-unit" &&
          /unknown file src\/ghost\.ts/i.test(issue.message),
      ),
    );
    assert.ok(
      parsed.issues.some(
        (issue) =>
          issue.path === "coverage_matrix:src/api/auth.ts" &&
          /completed lens tests is not listed in required_lenses/i.test(
            issue.message,
          ),
      ),
      "expected a completed_lenses superset violation issue for src/api/auth.ts",
    );
  });
});

test("audit-code validate exits zero when no validation issues exist", async () => {
  await withTempRepo(async (root) => {
    const artifactsDir = join(root, ".audit-tools/audit");
    await mkdir(artifactsDir, { recursive: true });

    await writeFile(
      join(artifactsDir, "repo_manifest.json"),
      JSON.stringify(
        {
          repository: { name: "fixture" },
          generated_at: "2026-04-17T00:00:00Z",
          files: [],
        },
        null,
        2,
      ),
    );

    const result = await runValidate(root);
    const parsed = parseJsonOutput(result);

    assert.equal(result.code, 0);
    assert.equal(parsed.issue_count, 0);
    assert.equal(parsed.session_config_present, false);
    // TST-c0432a78-3: do not pin the provider name — auto-resolution picks the
    // contextually appropriate fallback; verify only that a name is returned.
    assert.ok(typeof parsed.resolved_provider === "string" && parsed.resolved_provider.length > 0,
      "resolved_provider must be a non-empty string");
    assert.deepEqual(parsed.issues, []);
  });
});

test("audit-code validate exits non-zero when session-config has provider issues", async () => {
  await withTempRepo(async (root) => {
    const artifactsDir = join(root, ".audit-tools/audit");
    await mkdir(artifactsDir, { recursive: true });

    await writeFile(
      join(artifactsDir, "session-config.json"),
      JSON.stringify(
        {
          provider: "subprocess-template",
          subprocess_template: {
            command_template: [],
            env: {
              AUDIT_TOKEN: 42,
            },
          },
        },
        null,
        2,
      ),
    );

    const result = await runValidate(root);
    const parsed = parseJsonOutput(result);

    assert.notEqual(result.code, 0);
    assert.equal(parsed.session_config_present, true);
    assert.equal(parsed.resolved_provider, null);
    assert.equal(parsed.artifact_issue_count, 0);
    assert.equal(parsed.session_config_issue_count, parsed.issue_count);
    assert.ok(
      parsed.issues.some(
        (issue) =>
          issue.path ===
            "session_config.subprocess_template.command_template" &&
          /must not be empty/i.test(issue.message),
      ),
    );
    assert.ok(
      parsed.issues.some(
        (issue) =>
          issue.path === "session_config.subprocess_template.env.AUDIT_TOKEN" &&
          /must be strings/i.test(issue.message),
      ),
    );
  });
});

