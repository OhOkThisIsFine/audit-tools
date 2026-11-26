import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { BaseSequencer } from "vitest/node";
import { compareCodeUnits, resolveWithinRoot } from './primitives.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const defaultBaselinePath = resolve(here, "vitest-shard-duration-baseline.json");

function normalizePathToRepoSlashStyle(filePath) {
  return String(filePath ?? "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "");
}

function toFilePath(candidate) {
  if (typeof candidate !== "string") return "";
  if (candidate.startsWith("file://")) {
    try {
      return fileURLToPath(candidate);
    } catch {
      return candidate;
    }
  }
  return candidate;
}

function readDurationMap(path) {
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    if (!parsed.files || typeof parsed.files !== "object" || Array.isArray(parsed.files)) return null;
    const durations = new Map();
    for (const [file, ms] of Object.entries(parsed.files)) {
      if (Number.isFinite(ms) && ms >= 0) {
        durations.set(normalizePathToRepoSlashStyle(file), Number(ms));
      }
    }
    return durations.size > 0 ? durations : null;
  } catch {
    return null;
  }
}

function toRepoRelativeTestPath(spec, repoRoot) {
  const candidate = toFilePath(
    spec?.moduleId ?? spec?.filepath ?? spec?.path ?? spec?.filePath ?? spec?.name ?? "",
  );
  if (candidate.length === 0) return "";

  try {
    const absolutePath = isAbsolute(candidate) ? candidate : resolve(repoRoot, candidate);
    // allowRoot:false — a spec resolving to the repo root is not a test file.
    const contained = resolveWithinRoot(repoRoot, absolutePath, { allowRoot: false });
    if (contained === null) return "";
    const normalized = normalizePathToRepoSlashStyle(relative(repoRoot, contained));
    return normalized.startsWith("./") ? normalized.slice(2) : normalized;
  } catch {
    const normalized = normalizePathToRepoSlashStyle(candidate);
    return normalized.startsWith("./") ? normalized.slice(2) : normalized;
  }
}

function toShardTarget(ctx) {
  const shard = ctx?.config?.shard ?? {};
  const index = Number(shard.index);
  const count = Number(shard.count);
  if (!Number.isInteger(index) || !Number.isInteger(count) || count <= 0) {
    return { index: 1, count: 1 };
  }
  return { index, count };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function compareLongestFirst(a, b) {
  const byDuration = b.duration - a.duration;
  return byDuration || compareCodeUnits(a.key, b.key);
}

export default class VitestDurationSequencer extends BaseSequencer {
  getShardingTarget() {
    return toShardTarget(this.ctx);
  }

  async shard(files) {
    const specs = Array.isArray(files) ? files : [];
    const { index, count } = this.getShardingTarget();

    if (specs.length === 0 || count <= 1) {
      return specs;
    }

    const durationPath = process.env.VITEST_SHARD_DURATIONS_PATH ?? defaultBaselinePath;
    const durations = readDurationMap(durationPath);
    if (!durations) {
      console.log(
        `[vitest-sequencer] timing baseline not available at ${durationPath}; using default sharding.`,
      );
      return super.shard(specs);
    }

    const repoRoot = resolve(this.ctx?.config?.root ?? process.cwd());
    const weightedSpecs = specs.map((spec) => {
      const file = toRepoRelativeTestPath(spec, repoRoot);
      return {
        spec,
        key: JSON.stringify([file || String(spec?.moduleId ?? spec?.name ?? ""), spec?.project?.name ?? "", spec?.pool ?? ""]),
        duration: durations.get(file),
      };
    });
    const measured = weightedSpecs.flatMap(({ duration }) => duration === undefined ? [] : [duration]);
    if (measured.length === 0) {
      console.log("[vitest-sequencer] 0 measured specs in this selection; using default sharding.");
      return super.shard(specs);
    }

    // Estimate only missing specs using the current selection's median, so a few
    // heavyweight specs do not dominate the estimate and deleted files do not count.
    const estimate = Math.max(1, median(measured));
    const sorted = weightedSpecs
      .map((item) => ({ ...item, duration: item.duration ?? estimate }))
      .sort(compareLongestFirst);
    /** @type {typeof specs[]} */
    const buckets = Array.from({ length: count }, () => []);
    const bucketTotals = Array.from({ length: count }, () => 0);

    for (const item of sorted) {
      let targetBucket = 0;
      for (let i = 1; i < count; i += 1) {
        if (bucketTotals[i] < bucketTotals[targetBucket] ||
            (bucketTotals[i] === bucketTotals[targetBucket] && buckets[i].length < buckets[targetBucket].length)) {
          targetBucket = i;
        }
      }
      buckets[targetBucket].push(item.spec);
      bucketTotals[targetBucket] += item.duration;
    }

    const estimated = specs.length - measured.length;
    console.log(
      `[vitest-sequencer] ${measured.length} measured, ${estimated} estimated` +
        (estimated > 0 ? ` (${estimate} ms/spec)` : "") +
        `; predicted shard workloads: ${bucketTotals.map((ms) => `${Math.round(ms)} ms`).join(", ")}.`,
    );

    const shardIndex = Math.max(1, Math.min(index, count));
    return buckets[shardIndex - 1];
  }
}
