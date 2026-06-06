export function stripYamlComment(line: string): string {
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (quote) {
      if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "#") {
      return line.slice(0, index);
    }
  }
  return line;
}

export function unquoteYamlScalar(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) {
    return trimmed;
  }
  const quote = trimmed[0];
  if ((quote === '"' || quote === "'") && trimmed.at(-1) === quote) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

export function splitYamlInlineList(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    return [];
  }

  const values: string[] = [];
  let quote: '"' | "'" | undefined;
  let start = 1;
  for (let index = 1; index < trimmed.length - 1; index++) {
    const char = trimmed[index];
    if (quote) {
      if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === ",") {
      values.push(unquoteYamlScalar(trimmed.slice(start, index)));
      start = index + 1;
    }
  }
  values.push(unquoteYamlScalar(trimmed.slice(start, -1)));
  return values.filter((item) => item.length > 0);
}
