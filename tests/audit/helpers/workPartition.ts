import type { WorkPartitionPolicy } from "audit-tools/shared";

/** Explicit capability used by audit tests that exercise real packet/report partitioning. */
export const TEST_WORK_PARTITION = {
  capacityTokens: 192_000,
  availableParallelism: 4,
} satisfies Pick<WorkPartitionPolicy, "capacityTokens" | "availableParallelism">;
