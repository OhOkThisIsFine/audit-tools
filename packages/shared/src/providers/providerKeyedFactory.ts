/**
 * Build a provider-keyed lookup: given a record of provider-name → value and a
 * generic `fallback`, return a function that resolves a provider name to its
 * specific value or the fallback when the name is unknown.
 *
 * This is the shared shape behind the quota error-parser factory and the audit
 * header-extractor factory (drift-plan E5): both kept their own
 * `Record<string, T>[name] ?? fallback` lookup, which is the same primitive.
 * Centralizing it guarantees the unknown-key → generic-fallback contract is
 * identical and tested once. Values are looked up by reference, so callers that
 * want singleton strategies simply pass singletons in `record` / `fallback`.
 */
export function makeProviderKeyedFactory<T>(
  record: Record<string, T>,
  fallback: T,
): (providerName: string) => T {
  return (providerName: string): T => record[providerName] ?? fallback;
}
