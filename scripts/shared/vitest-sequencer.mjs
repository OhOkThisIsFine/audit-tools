import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { BaseSequencer } from "vitest/node";

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
    if (!parsed.files || typeof parsed.files !== "object") return null;
    const durations = new Map();
    for (const [file, ms] of Object.entries(parsed.files)) {
      if (Number.isFinite(ms)) {
        durations.set(normalizePathToRepoSlashStyle(file), Number(ms));
      }
    }
    return durations;
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
    const relativePath = relative(repoRoot, absolutePath);
    if (relativePath === "" || relativePath.startsWith("..")) return "";
    const normalized = normalizePathToRepoSlashStyle(relativePath);
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

function compareLongestFirst(a, b) {
  return b.duration - a.duration;
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
    const weightedSpecs = [];
    const unmeasuredSpecs = [];

    for (const spec of specs) {
      const filePath = toRepoRelativeTestPath(spec, repoRoot);
      const duration = durations.get(filePath);
      if (Number.isFinite(duration) && duration >= 0) {
        weightedSpecs.push({ spec, duration });
      } else {
        unmeasuredSpecs.push(spec);
      }
    }

    if (unmeasuredSpecs.length > 0) {
      // All-or-nothing by design (the brief's T3: unmeasured files degrade to the
      // inherited behavior) — but never silently, or the balance win evaporates
      // unnoticed the first time a test file lands without a baseline refresh.
      const names = unmeasuredSpecs
        .slice(0, 3)
        .map((spec) => toRepoRelativeTestPath(spec, repoRoot) || "<unresolved>");
      console.log(
        `[vitest-sequencer] ${unmeasuredSpecs.length} test file(s) missing from the duration baseline ` +
          `(${names.join(", ")}${unmeasuredSpecs.length > 3 ? ", …" : ""}); falling back to hash sharding. ` +
          `Refresh with: npm run generate:shard-baseline (after a green full run).`,
      );
      return super.shard(specs);
    }

    const sorted = weightedSpecs.sort(compareLongestFirst);
    const buckets = Array.from({ length: count }, () => []);
    const bucketTotals = Array.from({ length: count }, () => 0);

    for (const item of sorted) {
      let targetBucket = 0;
      for (let i = 1; i < count; i += 1) {
        if (bucketTotals[i] < bucketTotals[targetBucket]) {
          targetBucket = i;
        }
      }
      buckets[targetBucket].push(item.spec);
      bucketTotals[targetBucket] += item.duration;
    }

    const shardIndex = Math.max(1, Math.min(index, count));
    return buckets[shardIndex - 1];
  }
}
