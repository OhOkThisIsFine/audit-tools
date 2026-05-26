import test from "node:test";
import assert from "node:assert/strict";

const { buildAuditTasks } = await import("../dist/orchestrator.js");

function createUnitManifest() {
  return {
    units: [
      {
        unit_id: "src-auth",
        name: "Auth",
        files: ["src/api/auth.ts", "src/lib/session.ts"],
        required_lenses: ["security", "correctness"],
      },
      {
        unit_id: "infra-deploy",
        name: "Deployment",
        files: ["infra/deploy.yml"],
        required_lenses: ["config_deployment"],
      },
    ],
  };
}

test("buildAuditTasks emits deterministic task structures and honors lens limits", () => {
  const tasks = buildAuditTasks(createUnitManifest(), {
    pass_prefix: "focused",
    limit_lenses: ["security", "config_deployment"],
  });

  assert.deepEqual(
    tasks.map((task) => task.task_id),
    ["src-auth:security", "infra-deploy:config_deployment"],
  );
  assert.deepEqual(tasks[0], {
    task_id: "src-auth:security",
    unit_id: "src-auth",
    pass_id: "focused:security",
    lens: "security",
    file_paths: ["src/api/auth.ts", "src/lib/session.ts"],
    rationale: "Audit Auth under the security lens.",
  });
});

test("buildAuditTasks rejects malformed unit manifests with path-aware errors", () => {
  assert.throws(
    () =>
      buildAuditTasks({
        units: [
          {
            unit_id: "src-auth",
            name: "Auth",
            files: ["src/api/auth.ts"],
            required_lenses: ["security", "mystery"],
          },
        ],
      }),
    /unitManifest\.units\[0\]\.required_lenses must be an array of supported lenses/i,
  );

  assert.throws(
    () => buildAuditTasks({ units: [{ unit_id: "missing-fields" }] }),
    /unitManifest\.units\[0\]\.name must be a non-empty string/i,
  );
});

test("buildAuditTasks validates options before generating tasks", () => {
  assert.throws(
    () =>
      buildAuditTasks(createUnitManifest(), {
        limit_lenses: ["security", "mystery"],
      }),
    /options\.limit_lenses must be an array of supported lenses/i,
  );
  assert.throws(
    () => buildAuditTasks(createUnitManifest(), { pass_prefix: 42 }),
    /options\.pass_prefix must be a string/i,
  );
});
