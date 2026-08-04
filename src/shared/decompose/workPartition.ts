/**
 * Deterministic, overlap-tolerant partitioning for audit/remediation work.
 *
 * Shared units and files are affinity signals, not union-find edges. Capacity is
 * expressed only in estimated input tokens supplied by the current runtime; no
 * finding-count target or ceiling exists. The optimizer compares dimensionless
 * objectives with equal weight, so there is no hand-tuned coefficient table.
 *
 * PURE + DETERMINISTIC: no IO, clock, randomness, or incidental iteration order.
 */

export interface WorkPartitionItem {
  id: string;
  unitIds: string[];
  files: string[];
  semanticTags: string[];
  /** Finding/obligation context cost, excluding affected-file contents. */
  estimatedTokens: number;
  /** Explicit upstream classification; systemic work is never guessed from counts. */
  role?: "implementation" | "coordination";
}

/** Runtime facts, not tuning knobs. */
export interface WorkPartitionPolicy {
  /** Usable input-token capacity after output reservation and safety margin. */
  capacityTokens: number;
  /** Provider/host-declared parallelism. Absent means unknown/unbounded, never guessed. */
  availableParallelism?: number | null;
  /** Estimated source tokens by normalized affected-file path. */
  fileTokenCosts?: Readonly<Record<string, number>>;
}

export interface WorkPartitionGroup {
  itemIds: string[];
  unitIds: string[];
  files: string[];
  role: "implementation" | "coordination";
  estimatedTokens: number;
}

export interface WorkPartitionSeam {
  leftGroup: number;
  rightGroup: number;
  kind: "predicted_write_conflict" | "shared_context" | "systemic_coordination";
  sharedFiles: string[];
  sharedUnitIds: string[];
  requiresPreparation: boolean;
}

export interface WorkPartitionResult {
  groups: WorkPartitionGroup[];
  seams: WorkPartitionSeam[];
  objective: {
    sizeBalance: number;
    semanticCrossEntropy: number;
    unitEntropy: number;
    unitCount: number;
    writeOverlap: number;
    seamCost: number;
    blockCount: number;
    parallelism: number;
    total: number;
  };
}

interface NormalizedItem {
  id: string;
  unitIds: string[];
  files: string[];
  semanticTags: string[];
  estimatedTokens: number;
  role: WorkPartitionGroup["role"];
}

interface AssignmentGroupState {
  items: NormalizedItem[];
  findingTokens: number;
  fileTokens: number;
  files: Set<string>;
  semanticCounts: Map<string, number>;
  semanticWeights: Map<string, number>;
  semanticWeightedLogCounts: number;
  semanticTotal: number;
  unitCounts: Map<string, number>;
  unitCountLogCounts: number;
  unitTotal: number;
}

const UNTAGGED = "(untagged)";
const NO_UNIT = "(no-unit)";

function stableUnique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))].sort((a, b) =>
    a.localeCompare(b),
  );
}

function resolvePolicy(
  policy: WorkPartitionPolicy,
): Required<
  Pick<WorkPartitionPolicy, "capacityTokens" | "availableParallelism">
> & { fileTokenCosts: Readonly<Record<string, number>> } {
  if (!Number.isFinite(policy.capacityTokens) || policy.capacityTokens < 0) {
    throw new Error(
      "work partition capacityTokens must be a finite non-negative number",
    );
  }
  if (
    policy.availableParallelism != null &&
    (!Number.isSafeInteger(policy.availableParallelism) ||
      policy.availableParallelism <= 0)
  ) {
    throw new Error(
      "work partition availableParallelism must be a positive integer when supplied",
    );
  }
  return {
    capacityTokens: policy.capacityTokens,
    availableParallelism: policy.availableParallelism ?? null,
    fileTokenCosts: policy.fileTokenCosts ?? {},
  };
}

function normalizeItems(items: readonly WorkPartitionItem[]): NormalizedItem[] {
  const byId = new Map<string, NormalizedItem>();
  for (const item of items) {
    if (byId.has(item.id)) {
      throw new Error(`work partition item id must be unique: ${item.id}`);
    }
    if (!Number.isFinite(item.estimatedTokens) || item.estimatedTokens < 0) {
      throw new Error(
        `work partition item ${item.id} requires finite non-negative estimatedTokens`,
      );
    }
    byId.set(item.id, {
      id: item.id,
      unitIds: stableUnique(item.unitIds),
      files: stableUnique(item.files),
      semanticTags: stableUnique(item.semanticTags),
      estimatedTokens: item.estimatedTokens,
      role: item.role ?? "implementation",
    });
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function intersection(a: readonly string[], b: readonly string[]): string[] {
  const shared: string[] = [];
  let left = 0;
  let right = 0;
  while (left < a.length && right < b.length) {
    const comparison = a[left]!.localeCompare(b[right]!);
    if (comparison === 0) {
      shared.push(a[left]!);
      left += 1;
      right += 1;
    } else if (comparison < 0) {
      left += 1;
    } else {
      right += 1;
    }
  }
  return shared;
}

function mean(values: readonly number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function jaccard(a: readonly string[], b: readonly string[]): number | null {
  if (a.length === 0 || b.length === 0) return null;
  let shared = 0;
  let left = 0;
  let right = 0;
  while (left < a.length && right < b.length) {
    const comparison = a[left]!.localeCompare(b[right]!);
    if (comparison === 0) {
      shared += 1;
      left += 1;
      right += 1;
    } else if (comparison < 0) {
      left += 1;
    } else {
      right += 1;
    }
  }
  return shared / (a.length + b.length - shared);
}

function normalizedEntropy(
  values: readonly string[],
  universeSize: number,
): number {
  if (values.length === 0 || universeSize <= 1) return 0;
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / values.length;
    entropy -= probability * Math.log(probability);
  }
  return Math.min(1, entropy / Math.log(universeSize));
}

/** Average item-to-group semantic cross entropy, normalized to the input vocabulary. */
function semanticCrossEntropy(
  groupItems: readonly NormalizedItem[],
  semanticUniverseSize: number,
): number {
  if (groupItems.length === 0 || semanticUniverseSize <= 1) return 0;
  const counts = new Map<string, number>();
  let total = 0;
  for (const item of groupItems) {
    const tags = item.semanticTags.length > 0 ? item.semanticTags : [UNTAGGED];
    for (const tag of tags) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
      total += 1;
    }
  }
  const itemScores = groupItems.map((item) => {
    const tags = item.semanticTags.length > 0 ? item.semanticTags : [UNTAGGED];
    return mean(tags.map((tag) => -Math.log((counts.get(tag) ?? 0) / total)));
  });
  return Math.min(1, mean(itemScores) / Math.log(semanticUniverseSize));
}

function fileTokenCost(
  path: string,
  fileTokenCosts: Readonly<Record<string, number>>,
): number {
  const value = fileTokenCosts[path];
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

function countLogCount(count: number): number {
  return count <= 1 ? 0 : count * Math.log(count);
}

function semanticValues(item: NormalizedItem): readonly string[] {
  return item.semanticTags.length > 0 ? item.semanticTags : [UNTAGGED];
}

function unitValues(item: NormalizedItem): readonly string[] {
  return item.unitIds.length > 0 ? item.unitIds : [NO_UNIT];
}

function emptyAssignmentGroup(): AssignmentGroupState {
  return {
    items: [],
    findingTokens: 0,
    fileTokens: 0,
    files: new Set<string>(),
    semanticCounts: new Map<string, number>(),
    semanticWeights: new Map<string, number>(),
    semanticWeightedLogCounts: 0,
    semanticTotal: 0,
    unitCounts: new Map<string, number>(),
    unitCountLogCounts: 0,
    unitTotal: 0,
  };
}

function addItemToAssignmentGroup(
  group: AssignmentGroupState,
  item: NormalizedItem,
  fileTokenCosts: Readonly<Record<string, number>>,
): void {
  group.items.push(item);
  group.findingTokens += item.estimatedTokens;
  for (const file of item.files) {
    if (group.files.has(file)) continue;
    group.files.add(file);
    group.fileTokens += fileTokenCost(file, fileTokenCosts);
  }

  const tags = semanticValues(item);
  const tagWeight = 1 / tags.length;
  for (const tag of tags) {
    const previousCount = group.semanticCounts.get(tag) ?? 0;
    const previousWeight = group.semanticWeights.get(tag) ?? 0;
    if (previousCount > 0) {
      group.semanticWeightedLogCounts -=
        previousWeight * Math.log(previousCount);
    }
    const nextCount = previousCount + 1;
    const nextWeight = previousWeight + tagWeight;
    group.semanticCounts.set(tag, nextCount);
    group.semanticWeights.set(tag, nextWeight);
    group.semanticWeightedLogCounts += nextWeight * Math.log(nextCount);
  }
  group.semanticTotal += tags.length;

  for (const unit of unitValues(item)) {
    const previousCount = group.unitCounts.get(unit) ?? 0;
    group.unitCountLogCounts -= countLogCount(previousCount);
    const nextCount = previousCount + 1;
    group.unitCounts.set(unit, nextCount);
    group.unitCountLogCounts += countLogCount(nextCount);
    group.unitTotal += 1;
  }
}

function createAssignmentGroup(
  seed: NormalizedItem,
  fileTokenCosts: Readonly<Record<string, number>>,
): AssignmentGroupState {
  const group = emptyAssignmentGroup();
  addItemToAssignmentGroup(group, seed, fileTokenCosts);
  return group;
}

function projectedGroupTokens(
  group: AssignmentGroupState,
  item: NormalizedItem,
  fileTokenCosts: Readonly<Record<string, number>>,
): number {
  let tokens = group.findingTokens + group.fileTokens + item.estimatedTokens;
  for (const file of item.files) {
    if (!group.files.has(file)) tokens += fileTokenCost(file, fileTokenCosts);
  }
  return tokens;
}

function projectedSemanticCrossEntropy(
  group: AssignmentGroupState,
  item: NormalizedItem,
  semanticUniverseSize: number,
): number {
  const tags = semanticValues(item);
  const tagWeight = 1 / tags.length;
  let weightedLogCounts = group.semanticWeightedLogCounts;
  for (const tag of tags) {
    const previousCount = group.semanticCounts.get(tag) ?? 0;
    const previousWeight = group.semanticWeights.get(tag) ?? 0;
    if (previousCount > 0)
      weightedLogCounts -= previousWeight * Math.log(previousCount);
    weightedLogCounts +=
      (previousWeight + tagWeight) * Math.log(previousCount + 1);
  }
  const itemCount = group.items.length + 1;
  const tagCount = group.semanticTotal + tags.length;
  const crossEntropy =
    (itemCount * Math.log(tagCount) - weightedLogCounts) / itemCount;
  return Math.min(
    1,
    crossEntropy / Math.log(Math.max(2, semanticUniverseSize)),
  );
}

function projectedUnitEntropy(
  group: AssignmentGroupState,
  item: NormalizedItem,
  unitUniverseSize: number,
): number {
  const values = unitValues(item);
  let countLogCounts = group.unitCountLogCounts;
  for (const unit of values) {
    const previousCount = group.unitCounts.get(unit) ?? 0;
    countLogCounts -= countLogCount(previousCount);
    countLogCounts += countLogCount(previousCount + 1);
  }
  const total = group.unitTotal + values.length;
  const entropy = Math.log(total) - countLogCounts / total;
  return Math.min(1, entropy / Math.log(Math.max(2, unitUniverseSize)));
}

function estimateGroupTokens(
  items: readonly NormalizedItem[],
  fileTokenCosts: Readonly<Record<string, number>>,
): number {
  const findingTokens = items.reduce(
    (sum, item) => sum + item.estimatedTokens,
    0,
  );
  const files = stableUnique(items.flatMap((item) => item.files));
  return (
    findingTokens +
    files.reduce((sum, path) => sum + fileTokenCost(path, fileTokenCosts), 0)
  );
}

function materializeGroup(
  items: readonly NormalizedItem[],
  role: WorkPartitionGroup["role"],
  fileTokenCosts: Readonly<Record<string, number>>,
): WorkPartitionGroup {
  return {
    itemIds: items.map((item) => item.id).sort((a, b) => a.localeCompare(b)),
    unitIds: stableUnique(items.flatMap((item) => item.unitIds)),
    files: stableUnique(items.flatMap((item) => item.files)),
    role,
    estimatedTokens: estimateGroupTokens(items, fileTokenCosts),
  };
}

function itemAffinity(left: NormalizedItem, right: NormalizedItem): number {
  const signals = [
    jaccard(left.files, right.files),
    jaccard(left.unitIds, right.unitIds),
    jaccard(left.semanticTags, right.semanticTags),
  ].filter((value): value is number => value != null);
  return mean(signals);
}

function itemGroupAffinity(
  item: NormalizedItem,
  group: readonly NormalizedItem[],
): number {
  if (group.length === 0) return 0;
  return Math.max(...group.map((entry) => itemAffinity(item, entry)));
}

function orderForAssignment(
  items: readonly NormalizedItem[],
): NormalizedItem[] {
  const fileFrequency = new Map<string, number>();
  const unitFrequency = new Map<string, number>();
  const semanticFrequency = new Map<string, number>();
  for (const item of items) {
    for (const file of item.files)
      fileFrequency.set(file, (fileFrequency.get(file) ?? 0) + 1);
    for (const unit of item.unitIds)
      unitFrequency.set(unit, (unitFrequency.get(unit) ?? 0) + 1);
    for (const tag of item.semanticTags) {
      semanticFrequency.set(tag, (semanticFrequency.get(tag) ?? 0) + 1);
    }
  }
  const frequencyDensity = (
    values: readonly string[],
    frequencies: Map<string, number>,
  ): number | null =>
    values.length === 0
      ? null
      : mean(
          values.map((value) => (frequencies.get(value) ?? 0) / items.length),
        );
  const connectivity = (item: NormalizedItem): number =>
    mean(
      [
        frequencyDensity(item.files, fileFrequency),
        frequencyDensity(item.unitIds, unitFrequency),
        frequencyDensity(item.semanticTags, semanticFrequency),
      ].filter((value): value is number => value != null),
    );
  return [...items].sort((a, b) => {
    const connectivityDelta = connectivity(b) - connectivity(a);
    if (connectivityDelta !== 0) return connectivityDelta;
    const tokenDelta = b.estimatedTokens - a.estimatedTokens;
    if (tokenDelta !== 0) return tokenDelta;
    return a.id.localeCompare(b.id);
  });
}

function selectSeeds(
  items: readonly NormalizedItem[],
  count: number,
): NormalizedItem[] {
  const ordered = orderForAssignment(items);
  const seeds: NormalizedItem[] = [ordered[0]!];
  const remaining = new Map(ordered.slice(1).map((item) => [item.id, item]));
  const nearestSeedAffinity = new Map(
    [...remaining.values()].map((item) => [
      item.id,
      itemAffinity(item, seeds[0]!),
    ]),
  );
  while (seeds.length < count && remaining.size > 0) {
    let next: NormalizedItem | undefined;
    for (const candidate of remaining.values()) {
      if (next === undefined) {
        next = candidate;
        continue;
      }
      const candidateNear = nearestSeedAffinity.get(candidate.id) ?? 0;
      const nextNear = nearestSeedAffinity.get(next.id) ?? 0;
      if (
        candidateNear < nextNear ||
        (candidateNear === nextNear &&
          (candidate.estimatedTokens > next.estimatedTokens ||
            (candidate.estimatedTokens === next.estimatedTokens &&
              candidate.id.localeCompare(next.id) < 0)))
      ) {
        next = candidate;
      }
    }
    if (next === undefined) break;
    seeds.push(next);
    remaining.delete(next.id);
    nearestSeedAffinity.delete(next.id);
    for (const candidate of remaining.values()) {
      nearestSeedAffinity.set(
        candidate.id,
        Math.max(
          nearestSeedAffinity.get(candidate.id) ?? 0,
          itemAffinity(candidate, next),
        ),
      );
    }
  }
  return seeds;
}

function placementObjective(
  group: AssignmentGroupState,
  item: NormalizedItem,
  policy: ReturnType<typeof resolvePolicy>,
  unitUniverseSize: number,
  semanticUniverseSize: number,
): number {
  const tokens = projectedGroupTokens(group, item, policy.fileTokenCosts);
  const load =
    policy.capacityTokens > 0 ? Math.min(1, tokens / policy.capacityTokens) : 1;
  let uniqueUnits = group.unitCounts.size;
  for (const unit of unitValues(item)) {
    if (!group.unitCounts.has(unit)) uniqueUnits += 1;
  }
  const unitSpan = uniqueUnits / Math.max(1, unitUniverseSize);
  return mean([
    load,
    projectedSemanticCrossEntropy(group, item, semanticUniverseSize),
    projectedUnitEntropy(group, item, unitUniverseSize),
    unitSpan,
    1 - itemGroupAffinity(item, group.items),
  ]);
}

function buildCandidate(
  items: readonly NormalizedItem[],
  requestedGroupCount: number,
  policy: ReturnType<typeof resolvePolicy>,
  unitUniverseSize: number,
  semanticUniverseSize: number,
): NormalizedItem[][] {
  const seeds = selectSeeds(items, Math.min(items.length, requestedGroupCount));
  const seedIds = new Set(seeds.map((item) => item.id));
  const groups = seeds.map((seed) =>
    createAssignmentGroup(seed, policy.fileTokenCosts),
  );

  for (const item of orderForAssignment(items).filter(
    (entry) => !seedIds.has(entry.id),
  )) {
    let bestIndex = -1;
    let bestScore = Number.POSITIVE_INFINITY;
    for (let index = 0; index < groups.length; index += 1) {
      const group = groups[index]!;
      const afterTokens = projectedGroupTokens(
        group,
        item,
        policy.fileTokenCosts,
      );
      if (afterTokens > policy.capacityTokens) continue;
      const score = placementObjective(
        group,
        item,
        policy,
        unitUniverseSize,
        semanticUniverseSize,
      );
      if (score < bestScore || (score === bestScore && index < bestIndex)) {
        bestScore = score;
        bestIndex = index;
      }
    }
    if (bestIndex < 0)
      groups.push(createAssignmentGroup(item, policy.fileTokenCosts));
    else
      addItemToAssignmentGroup(groups[bestIndex]!, item, policy.fileTokenCosts);
  }
  return groups.map((group) =>
    [...group.items].sort((a, b) => a.id.localeCompare(b.id)),
  );
}

function deriveSeams(
  groups: readonly WorkPartitionGroup[],
): WorkPartitionSeam[] {
  const seams: WorkPartitionSeam[] = [];
  for (let left = 0; left < groups.length; left += 1) {
    for (let right = left + 1; right < groups.length; right += 1) {
      const a = groups[left]!;
      const b = groups[right]!;
      const sharedFiles = intersection(a.files, b.files);
      const sharedUnitIds = intersection(a.unitIds, b.unitIds);
      if (sharedFiles.length === 0 && sharedUnitIds.length === 0) continue;
      const systemic = a.role === "coordination" || b.role === "coordination";
      const kind = systemic
        ? "systemic_coordination"
        : sharedFiles.length > 0
          ? "predicted_write_conflict"
          : "shared_context";
      seams.push({
        leftGroup: left,
        rightGroup: right,
        kind,
        sharedFiles,
        sharedUnitIds,
        requiresPreparation: systemic || sharedFiles.length > 0,
      });
    }
  }
  return seams;
}

function scorePartition(
  groups: readonly WorkPartitionGroup[],
  groupItems: readonly NormalizedItem[][],
  seams: readonly WorkPartitionSeam[],
  normalItemCount: number,
  policy: ReturnType<typeof resolvePolicy>,
  unitUniverseSize: number,
  semanticUniverseSize: number,
): WorkPartitionResult["objective"] {
  const implementationGroups = groups
    .map((group, index) => ({ group, items: groupItems[index]! }))
    .filter((entry) => entry.group.role === "implementation");
  const tokenLoads = implementationGroups.map(
    ({ group }) => group.estimatedTokens,
  );
  const sizeBalance =
    tokenLoads.length <= 1
      ? 0
      : (Math.max(...tokenLoads) - Math.min(...tokenLoads)) /
        Math.max(policy.capacityTokens, Math.max(...tokenLoads));
  const semantic = mean(
    implementationGroups.map(({ items }) =>
      semanticCrossEntropy(items, Math.max(2, semanticUniverseSize)),
    ),
  );
  const unitEntropy = mean(
    implementationGroups.map(({ items }) =>
      normalizedEntropy(
        items.flatMap((item) =>
          item.unitIds.length > 0 ? item.unitIds : ["(no-unit)"],
        ),
        Math.max(2, unitUniverseSize),
      ),
    ),
  );
  const unitCount = mean(
    implementationGroups.map(
      ({ group }) => group.unitIds.length / Math.max(1, unitUniverseSize),
    ),
  );
  const fileAppearances = new Map<string, number>();
  for (const group of groups) {
    for (const file of group.files) {
      fileAppearances.set(file, (fileAppearances.get(file) ?? 0) + 1);
    }
  }
  const totalFileAppearances = [...fileAppearances.values()].reduce(
    (sum, count) => sum + count,
    0,
  );
  const duplicateFileAppearances = [...fileAppearances.values()].reduce(
    (sum, count) => sum + Math.max(0, count - 1),
    0,
  );
  const writeOverlap =
    duplicateFileAppearances / Math.max(1, totalFileAppearances);
  const possibleSeams = (groups.length * (groups.length - 1)) / 2;
  const seamCost =
    seams.filter((seam) => seam.requiresPreparation).length /
    Math.max(1, possibleSeams);
  const implementationGroupCount = implementationGroups.length;
  const blockCount =
    normalItemCount <= 1
      ? 0
      : (implementationGroupCount - 1) / (normalItemCount - 1);
  const usefulParallelism =
    policy.availableParallelism == null
      ? null
      : Math.min(policy.availableParallelism, normalItemCount);
  const parallelism =
    usefulParallelism == null || usefulParallelism === 0
      ? 0
      : Math.max(0, usefulParallelism - implementationGroupCount) /
        usefulParallelism;
  const dimensions = [
    sizeBalance,
    semantic,
    unitEntropy,
    unitCount,
    writeOverlap,
    seamCost,
    blockCount,
    parallelism,
  ];
  return {
    sizeBalance,
    semanticCrossEntropy: semantic,
    unitEntropy,
    unitCount,
    writeOverlap,
    seamCost,
    blockCount,
    parallelism,
    total: mean(dimensions),
  };
}

function emptyObjective(): WorkPartitionResult["objective"] {
  return {
    sizeBalance: 0,
    semanticCrossEntropy: 0,
    unitEntropy: 0,
    unitCount: 0,
    writeOverlap: 0,
    seamCost: 0,
    blockCount: 0,
    parallelism: 0,
    total: 0,
  };
}

/**
 * Partition work items without forcing shared-unit/file transitive closure.
 * Every input item appears in exactly one group; group file/unit scopes may
 * overlap and every overlap is returned explicitly as a seam.
 */
export function partitionWorkItems(
  input: readonly WorkPartitionItem[],
  runtimePolicy: WorkPartitionPolicy,
): WorkPartitionResult {
  const policy = resolvePolicy(runtimePolicy);
  const items = normalizeItems(input);
  if (items.length === 0)
    return { groups: [], seams: [], objective: emptyObjective() };

  const allUnits = stableUnique(items.flatMap((item) => item.unitIds));
  const allSemanticTags = stableUnique(
    items.flatMap((item) =>
      item.semanticTags.length > 0 ? item.semanticTags : ["(untagged)"],
    ),
  );
  const coordination = items.filter((item) => item.role === "coordination");
  const normal = items.filter((item) => item.role === "implementation");
  const coordinationGroups = coordination.map((item) =>
    materializeGroup([item], "coordination", policy.fileTokenCosts),
  );
  const coordinationGroupItems = coordination.map((item) => [item]);
  if (normal.length === 0) {
    const seams = deriveSeams(coordinationGroups);
    return {
      groups: coordinationGroups,
      seams,
      objective: scorePartition(
        coordinationGroups,
        coordinationGroupItems,
        seams,
        0,
        policy,
        allUnits.length,
        allSemanticTags.length,
      ),
    };
  }

  const requestedCounts = stableUnique([
    "1",
    ...(policy.availableParallelism == null
      ? []
      : [String(Math.min(normal.length, policy.availableParallelism))]),
  ]).map(Number);

  let best: WorkPartitionResult | undefined;
  let bestSignature = "";
  for (const requestedCount of requestedCounts) {
    const candidateItems = buildCandidate(
      normal,
      requestedCount,
      policy,
      allUnits.length,
      allSemanticTags.length,
    );
    const implementationGroups = candidateItems.map((group) =>
      materializeGroup(group, "implementation", policy.fileTokenCosts),
    );
    const groups = [...coordinationGroups, ...implementationGroups];
    const groupItems = [...coordinationGroupItems, ...candidateItems];
    const seams = deriveSeams(groups);
    const objective = scorePartition(
      groups,
      groupItems,
      seams,
      normal.length,
      policy,
      allUnits.length,
      allSemanticTags.length,
    );
    const signature = groups
      .map((group) => `${group.role}:${group.itemIds.join(",")}`)
      .join("|");
    if (
      best === undefined ||
      objective.total < best.objective.total ||
      (objective.total === best.objective.total &&
        signature.localeCompare(bestSignature) < 0)
    ) {
      best = { groups, seams, objective };
      bestSignature = signature;
    }
  }
  return best!;
}
