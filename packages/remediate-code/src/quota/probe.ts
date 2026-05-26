export interface ProbeResult {
  supported: boolean;
  reason: string;
}

/**
 * @deprecated Phase 3A replaces this with the QuotaSource abstraction.
 */
export async function probeProvider(
  providerName: string,
  probeMode: "auto" | "never" | "force" = "auto",
): Promise<ProbeResult> {
  if (probeMode === "never") {
    return { supported: false, reason: "probe disabled by config" };
  }

  if (providerName !== "subprocess-template") {
    return {
      supported: false,
      reason: `probe not applicable for ${providerName} — limits come from known-model metadata or learned behavior`,
    };
  }

  return { supported: false, reason: "subprocess-template probe not yet implemented" };
}
