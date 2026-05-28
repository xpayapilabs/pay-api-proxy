export function stripJsonComments(value: string): string {
  let output = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    const next = value[index + 1];

    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      output += char;
      continue;
    }

    if (char === "/" && next === "/") {
      index += 2;
      while (index < value.length && value[index] !== "\n" && value[index] !== "\r") index += 1;
      if (index < value.length) output += value[index];
      continue;
    }

    if (char === "/" && next === "*") {
      index += 2;
      while (index < value.length && !(value[index] === "*" && value[index + 1] === "/")) index += 1;
      index += 1;
      continue;
    }

    output += char;
  }

  return output;
}

export function parseJsoncObject(value: string, sourceName: string): Record<string, unknown> {
  const parsed = JSON.parse(stripJsonComments(value)) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${sourceName} must contain a JSON object`);
  }
  return parsed as Record<string, unknown>;
}
