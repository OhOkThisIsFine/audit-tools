/**
 * Tests for foldAccountCooldown and related account quota state management.
 *
 * TST-af2bfefc: Verify that foldAccountCooldown correctly merges account-scoped
 * 429/cooldown signals from sibling pools' quota state entries, taking the
 * furthest cooldown_until and last_429_at timestamps across the group.
 */

import { test, expect } from "vitest";
import { foldAccountCooldown } from "../../src/shared/quota/accountId.js";
import type { QuotaStateEntry } from "../../src/shared/quota/types.js";

const baseTime = new Date().toISOString();
const pastTime = new Date(Date.now() - 60000).toISOString();
const futureTime = new Date(Date.now() + 60000).toISOString();
const laterFutureTime = new Date(Date.now() + 120000).toISOString();

test("foldAccountCooldown: ownEntry only with no siblings returns ownEntry", () => {
  const own: QuotaStateEntry = {
    updated_at: baseTime,
    cooldown_until: null,
    last_429_at: pastTime,
  };
  const result = foldAccountCooldown(own, []);
  expect(result).toEqual(own);
});

test("foldAccountCooldown: both null and empty siblings returns null", () => {
  const result = foldAccountCooldown(null, []);
  expect(result).toBeNull();
});

test("foldAccountCooldown: all null entries returns null", () => {
  const result = foldAccountCooldown(null, [null, null, undefined]);
  expect(result).toBeNull();
});

test("foldAccountCooldown: picks furthest cooldown_until from siblings", () => {
  const own: QuotaStateEntry = {
    updated_at: baseTime,
    cooldown_until: futureTime,
    last_429_at: null,
  };
  const sibling1: QuotaStateEntry = {
    updated_at: baseTime,
    cooldown_until: laterFutureTime,
    last_429_at: null,
  };
  const sibling2: QuotaStateEntry = {
    updated_at: baseTime,
    cooldown_until: pastTime,
    last_429_at: null,
  };

  const result = foldAccountCooldown(own, [sibling1, sibling2]);
  expect(result?.cooldown_until).toBe(laterFutureTime);
});

test("foldAccountCooldown: picks furthest last_429_at from siblings", () => {
  const own: QuotaStateEntry = {
    updated_at: baseTime,
    cooldown_until: null,
    last_429_at: pastTime,
  };
  const sibling1: QuotaStateEntry = {
    updated_at: baseTime,
    cooldown_until: null,
    last_429_at: futureTime,
  };
  const sibling2: QuotaStateEntry = {
    updated_at: baseTime,
    cooldown_until: null,
    last_429_at: laterFutureTime,
  };

  const result = foldAccountCooldown(own, [sibling1, sibling2]);
  expect(result?.last_429_at).toBe(laterFutureTime);
});

test("foldAccountCooldown: ignores null/undefined siblings in fold", () => {
  const own: QuotaStateEntry = {
    updated_at: baseTime,
    cooldown_until: futureTime,
    last_429_at: pastTime,
  };
  const validSibling: QuotaStateEntry = {
    updated_at: baseTime,
    cooldown_until: laterFutureTime,
    last_429_at: null,
  };

  const result = foldAccountCooldown(own, [null, validSibling, undefined]);
  expect(result?.cooldown_until).toBe(laterFutureTime);
  expect(result?.last_429_at).toBe(pastTime);
});

test("foldAccountCooldown: preserves per-pool budget metadata from ownEntry", () => {
  const own: QuotaStateEntry = {
    updated_at: baseTime,
    cooldown_until: futureTime,
    last_429_at: null,
    consecutive_429_count: 3,
    tokens_per_pct: 1000,
    output_per_input: 0.5,
  };
  const sibling: QuotaStateEntry = {
    updated_at: baseTime,
    cooldown_until: laterFutureTime,
    last_429_at: null,
    consecutive_429_count: 5,
    tokens_per_pct: 2000,
    output_per_input: 0.8,
  };

  const result = foldAccountCooldown(own, [sibling]);
  // Budget fields should come from ownEntry, NOT from sibling
  expect(result?.consecutive_429_count).toBe(3);
  expect(result?.tokens_per_pct).toBe(1000);
  expect(result?.output_per_input).toBe(0.5);
  // But cooldown should pick furthest from group
  expect(result?.cooldown_until).toBe(laterFutureTime);
});

test("foldAccountCooldown: when ownEntry is null, sibling cooldown flows through", () => {
  const sibling: QuotaStateEntry = {
    updated_at: baseTime,
    cooldown_until: futureTime,
    last_429_at: pastTime,
  };

  const result = foldAccountCooldown(null, [sibling]);
  expect(result?.cooldown_until).toBe(futureTime);
  expect(result?.last_429_at).toBe(pastTime);
  // updated_at defaults to now when own is null
  expect(result?.updated_at).toBeDefined();
});

test("foldAccountCooldown: handles invalid date strings by using others", () => {
  const own: QuotaStateEntry = {
    updated_at: baseTime,
    cooldown_until: "not-a-date",
    last_429_at: pastTime,
  };
  const sibling: QuotaStateEntry = {
    updated_at: baseTime,
    cooldown_until: futureTime,
    last_429_at: null,
  };

  const result = foldAccountCooldown(own, [sibling]);
  // Invalid date on own should be replaced by valid sibling
  expect(result?.cooldown_until).toBe(futureTime);
});

test("foldAccountCooldown: never mutates input entries", () => {
  const own: QuotaStateEntry = {
    updated_at: baseTime,
    cooldown_until: futureTime,
    last_429_at: null,
  };
  const sibling: QuotaStateEntry = {
    updated_at: baseTime,
    cooldown_until: laterFutureTime,
    last_429_at: null,
  };
  const siblings = [sibling];

  const ownCopy = JSON.stringify(own);
  const siblingCopy = JSON.stringify(sibling);

  foldAccountCooldown(own, siblings);

  expect(JSON.stringify(own)).toBe(ownCopy);
  expect(JSON.stringify(sibling)).toBe(siblingCopy);
  expect(JSON.stringify(siblings)).toBe(JSON.stringify([sibling]));
});
