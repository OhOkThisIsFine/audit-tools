/**
 * Versioned seam contract for Gate-0/Gate-1 Provider Confirmation (N-X06).
 *
 * Pins the output shape of the provider confirmation step so that
 * consumers (audit-code, remediate-code) can be validated against a single,
 * version-stamped result interface.
 *
 * The implementing functions live in src/providers/providerConfirmation.ts.
 * This file ONLY declares the contract types and the version constant.
 */

import type { ResolvedProviderName } from "./sessionConfig.js";
import type { CapabilityTier } from "../providers/providerConfirmation.js";

// ---------------------------------------------------------------------------
// Version constant
// ---------------------------------------------------------------------------

/**
 * Version string for the ProviderConfirmationResult contract.
 * Increment when any breaking interface change lands.
 */
export const PROVIDER_CONFIRMATION_RESULT_VERSION = "1.0.0" as const;

// ---------------------------------------------------------------------------
// Contract types
// ---------------------------------------------------------------------------

/** One entry in the confirmed provider pool. */
export interface ConfirmedPoolEntry {
  /** Canonical provider name. */
  name: ResolvedProviderName;
  /** Capability tier assessed at discovery time. */
  capability_tier: CapabilityTier;
  /**
   * Whether this provider was explicitly excluded from the pool by the user
   * (or by self-spawn guard). Excluded entries are recorded but not dispatched.
   */
  excluded: boolean;
  /** Optional reason for exclusion or detection restriction. */
  reason?: string;
}

/**
 * Output of Gate-0 / Gate-1 provider confirmation.
 *
 * session_level: true because the pool applies to the entire audit run,
 * not to individual dispatch waves.
 */
export interface ProviderConfirmationResult {
  /** Schema version — must equal PROVIDER_CONFIRMATION_RESULT_VERSION. */
  schema_version: typeof PROVIDER_CONFIRMATION_RESULT_VERSION;
  /** ISO-8601 timestamp of when the pool was confirmed. */
  confirmed_at: string;
  /** All discovered (and any manually added) providers, with exclusion flag. */
  provider_pool: ConfirmedPoolEntry[];
  /**
   * True: the confirmation is session-level and applies to the whole run.
   * False would mean per-step confirmation (not currently used).
   */
  session_level: boolean;
}
