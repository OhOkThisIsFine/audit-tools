import { test, expect } from "vitest";
import assert from "node:assert/strict";

const { buildAuditTasks } = await import("../../src/audit/orchestrator.ts");

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

  expect(tasks.map((task) => task.task_id)).toEqual(["src-auth:security", "infra-deploy:config_deployment"]);
  expect(tasks[0]).toEqual({
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
            required_lenses: [42],
          },
        ],
      }),
    /unitManifest\.units\[0\]\.required_lenses must be an array of strings/i,
  );

  assert.throws(
    () => buildAuditTasks({ units: [{ unit_id: "missing-fields" }] }),
    /unitManifest\.units\[0\]\.name must be a non-empty string/i,
  );
});

test("buildAuditTasks accepts custom (non-canonical) lens names", () => {
  const tasks = buildAuditTasks({
    units: [
      {
        unit_id: "src-auth",
        name: "Auth",
        files: ["src/api/auth.ts"],
        required_lenses: ["security", "whimsy"],
      },
    ],
  });
  expect(tasks.some((t) => t.lens === "whimsy")).toBeTruthy();
  expect(tasks.some((t) => t.lens === "security")).toBeTruthy();
});

test("buildAuditTasks validates options before generating tasks", () => {
  assert.throws(
    () =>
      buildAuditTasks(createUnitManifest(), {
        limit_lenses: [123],
      }),
    /options\.limit_lenses must be an array of strings/i,
  );
  assert.throws(
    () => buildAuditTasks(createUnitManifest(), { pass_prefix: 42 }),
    /options\.pass_prefix must be a string/i,
  );
});

test("buildAuditTasks accepts options supplied as a JSON string", () => {
  const tasks = buildAuditTasks(
    createUnitManifest(),
    '{"pass_prefix":"json","limit_lenses":["correctness"]}',
  );

  expect(tasks.map((task) => task.task_id)).toEqual(["src-auth:correctness"]);
  expect(tasks[0].pass_id).toBe("json:correctness");
});

test("buildAuditTasks rejects malformed JSON string and array options", () => {
  assert.throws(
    () => buildAuditTasks(createUnitManifest(), "{bad"),
    /buildAuditTasks options must be an object or JSON object string/i,
  );
  assert.throws(
    () => buildAuditTasks(createUnitManifest(), "[]"),
    /buildAuditTasks options must be an object or JSON object string/i,
  );
});
