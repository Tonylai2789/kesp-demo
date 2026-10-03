export interface FirestoreSanitizedOutput {
  output: unknown;
  sanitized: boolean;
  issues: string[];
}

const MAX_SANITIZER_DEPTH = 40;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function sanitizeValue(
  value: unknown,
  path: string,
  issues: string[],
  seen: WeakSet<object>,
  depth: number,
  parentIsArray: boolean
): unknown {
  if (depth > MAX_SANITIZER_DEPTH) {
    issues.push(`${path}:max_depth`);
    return null;
  }

  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return value;
    issues.push(`${path}:non_finite_number`);
    return null;
  }
  if (typeof value === "undefined") {
    issues.push(`${path}:undefined_to_null`);
    return null;
  }
  if (typeof value === "bigint") {
    issues.push(`${path}:bigint_to_string`);
    return value.toString();
  }
  if (typeof value === "symbol" || typeof value === "function") {
    issues.push(`${path}:unsupported_to_null`);
    return null;
  }

  if (Array.isArray(value)) {
    const rows = value.map((item, index) => sanitizeValue(item, `${path}[${index}]`, issues, seen, depth + 1, true));
    if (parentIsArray) {
      issues.push(`${path}:nested_array_wrapped`);
      return { items: rows };
    }
    return rows;
  }

  if (value instanceof Date) {
    issues.push(`${path}:date_to_iso`);
    return value.toISOString();
  }

  if (typeof value === "object") {
    if (seen.has(value)) {
      issues.push(`${path}:circular_to_null`);
      return null;
    }
    seen.add(value);

    if (!isPlainObject(value)) {
      issues.push(`${path}:non_plain_object_to_json`);
      try {
        return sanitizeValue(JSON.parse(JSON.stringify(value)), path, issues, seen, depth + 1, parentIsArray);
      } catch {
        return String(value);
      }
    }

    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      result[key] = sanitizeValue(child, path ? `${path}.${key}` : key, issues, seen, depth + 1, false);
    }
    return result;
  }

  issues.push(`${path}:unknown_to_null`);
  return null;
}

export function sanitizeSubagentOutputForFirestore(output: unknown): FirestoreSanitizedOutput {
  const issues: string[] = [];
  const sanitizedOutput = sanitizeValue(output, "output", issues, new WeakSet<object>(), 0, false);
  return {
    output: sanitizedOutput,
    sanitized: issues.length > 0,
    issues,
  };
}
