// SPDX-License-Identifier: Apache-2.0
/**
 * A small YAML writer for the shapes the managed-agents target emits: objects,
 * arrays, strings, numbers and booleans. Object keys come out sorted and every
 * string is double-quoted, so the same value always writes the same bytes and
 * no label in a spec can be read back as YAML structure. A JSON string literal
 * is a valid YAML double-quoted scalar, which is what makes the quoting safe.
 */
export type YamlValue = string | number | boolean | YamlValue[] | { [key: string]: YamlValue };

export function toYaml(value: { [key: string]: YamlValue }): string {
  return block(value, 0).join("\n") + "\n";
}

function block(value: YamlValue, depth: number): string[] {
  const pad = "  ".repeat(depth);
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (isScalar(item) || isEmpty(item)) return [`${pad}- ${inline(item)}`];
      // The first line of a nested block moves up onto the dash; the rest keep
      // the indentation the dash gives them.
      const [first, ...rest] = block(item, depth + 1);
      return [`${pad}- ${first!.trimStart()}`, ...rest];
    });
  }
  if (typeof value === "object") {
    return Object.keys(value)
      .sort()
      .flatMap((key) => {
        const child = value[key]!;
        return isScalar(child) || isEmpty(child)
          ? [`${pad}${yamlKey(key)}: ${inline(child)}`]
          : [`${pad}${yamlKey(key)}:`, ...block(child, depth + 1)];
      });
  }
  return [`${pad}${inline(value)}`];
}

const isScalar = (value: YamlValue): value is string | number | boolean => typeof value !== "object";

const isEmpty = (value: YamlValue) =>
  Array.isArray(value) ? value.length === 0 : typeof value === "object" && Object.keys(value).length === 0;

function inline(value: YamlValue): string {
  if (Array.isArray(value)) return "[]";
  if (typeof value === "object") return "{}";
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

const yamlKey = (key: string) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? key : JSON.stringify(key));
