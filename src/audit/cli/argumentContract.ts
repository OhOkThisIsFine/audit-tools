// sites-pinned: tests/audit/functional-preflight.test.ts
/** Declared beside each CLI route; parsing and help share the same supported surface. */
export interface AuditArgumentContract {
  values?: readonly string[];
  switches?: readonly string[];
  positionals?: number;
  acceptsSemanticResults?: boolean;
}
const COMMON_VALUES = ["--root", "--artifacts-dir"] as const;
export const NEXT_STEP_ARGUMENTS: AuditArgumentContract = {
  values: ["--guidance", "--guidance-file", "--timeout", "--since"],
  switches: ["--auto-fix", "--dry-run"],
};
export function auditArgumentNames(contract: AuditArgumentContract): string[] {
  return [...COMMON_VALUES, ...(contract.values ?? []), ...(contract.switches ?? []), "--help", "-h"];
}

export function validateAuditArguments(command: string, args: readonly string[], contract: AuditArgumentContract): void {
  const values = new Set<string>([...COMMON_VALUES, ...(contract.values ?? [])]);
  const switches = new Set(["--help", "-h", ...(contract.switches ?? [])]);
  let positionalCount = 0;
  let positionalOnly = false;
  for (let index = 0; index < args.length; index++) {
    const token = args[index]!;
    if (token === "--" && !positionalOnly) { positionalOnly = true; continue; }
    if (!positionalOnly && token.startsWith("-")) {
      const equal = token.indexOf("=");
      const name = equal < 0 ? token : token.slice(0, equal);
      if (switches.has(name)) {
        if (equal >= 0) throw new Error(`${command}: ${name} does not take a value.`);
        continue;
      }
      if (!values.has(name)) throw new Error(`${command}: unsupported argument ${name}. Supported options: ${auditArgumentNames(contract).join(", ")}`);
      if (equal >= 0) {
        if (token.slice(equal + 1).length === 0) throw new Error(`${command}: ${name} requires a value.`);
      } else {
        const value = args[++index];
        if (!value || value.startsWith("--")) throw new Error(`${command}: ${name} requires a value; use ${name}=<value> for a value beginning with --.`);
      }
    } else if (++positionalCount > (contract.positionals ?? 0)) {
      throw new Error(`${command}: unexpected positional argument ${token}.`);
    }
  }
}
