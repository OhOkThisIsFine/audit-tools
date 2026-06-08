import type { AuditTask, Lens, UnitManifest } from "./types.js";
import { isLens } from "./types.js";
import { coerceJsonObjectArg } from "@audit-tools/shared";

const DEFAULT_LENS_ORDER: Lens[] = [
  "correctness",
  "architecture",
  "maintainability",
  "security",
  "reliability",
  "performance",
  "data_integrity",
  "tests",
  "operability",
  "config_deployment",
];

export interface TaskBuildOptions {
  pass_prefix?: string;
  limit_lenses?: Lens[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function assertStringArray(
  value: unknown,
  label: string,
): asserts value is string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new TypeError(`${label} must be an array of strings.`);
  }
}

function assertLensArray(value: unknown, label: string): asserts value is Lens[] {
  if (!Array.isArray(value) || value.some((item) => !isLens(item))) {
    throw new TypeError(`${label} must be an array of supported lenses.`);
  }
}

function assertUnitManifest(
  value: unknown,
): asserts value is UnitManifest {
  if (!isRecord(value) || !Array.isArray(value.units)) {
    throw new TypeError("buildAuditTasks requires unitManifest.units to be an array.");
  }

  value.units.forEach((unit, index) => {
    const label = `unitManifest.units[${index}]`;
    if (!isRecord(unit)) {
      throw new TypeError(`${label} must be an object.`);
    }
    if (typeof unit.unit_id !== "string" || unit.unit_id.length === 0) {
      throw new TypeError(`${label}.unit_id must be a non-empty string.`);
    }
    if (typeof unit.name !== "string" || unit.name.length === 0) {
      throw new TypeError(`${label}.name must be a non-empty string.`);
    }
    assertStringArray(unit.files, `${label}.files`);
    assertLensArray(unit.required_lenses, `${label}.required_lenses`);
  });
}

function normalizedOptions(rawOptions: unknown): {
  passPrefix: string;
  allowed: Set<Lens>;
} {
  const options = coerceJsonObjectArg<Record<string, unknown>>(
    rawOptions as Record<string, unknown> | string | undefined,
    "buildAuditTasks options",
  );

  if (options.pass_prefix !== undefined && typeof options.pass_prefix !== "string") {
    throw new TypeError("buildAuditTasks options.pass_prefix must be a string.");
  }
  if (options.limit_lenses !== undefined) {
    assertLensArray(options.limit_lenses, "buildAuditTasks options.limit_lenses");
  }

  return {
    passPrefix: options.pass_prefix ?? "pass",
    allowed: new Set(options.limit_lenses ?? DEFAULT_LENS_ORDER),
  };
}

export function buildAuditTasks(
  unitManifest: UnitManifest,
  options: TaskBuildOptions | string = {},
): AuditTask[] {
  assertUnitManifest(unitManifest);
  const { allowed, passPrefix } = normalizedOptions(options);
  const tasks: AuditTask[] = [];

  for (const unit of unitManifest.units) {
    for (const lens of unit.required_lenses) {
      if (!allowed.has(lens)) {
        continue;
      }

      tasks.push({
        task_id: `${unit.unit_id}:${lens}`,
        unit_id: unit.unit_id,
        pass_id: `${passPrefix}:${lens}`,
        lens,
        file_paths: unit.files,
        rationale: `Audit ${unit.name} under the ${lens} lens.`,
      });
    }
  }

  return tasks;
}
