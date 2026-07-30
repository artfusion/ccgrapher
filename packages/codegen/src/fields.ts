// SPDX-License-Identifier: Apache-2.0
/**
 * The `in`/`out` maps hold freeform type descriptors — "string", "url",
 * "YYYY-MM-DD", "string[]", "keep|drop". They are documentation first, but they
 * are regular enough to turn into a real schema, which is what makes a node's
 * output wire-able rather than just human-readable.
 */

export interface JsonSchema {
  type: string;
  items?: JsonSchema;
  enum?: string[];
  description?: string;
}

const PRIMITIVE: Record<string, string> = {
  string: "string",
  text: "string",
  url: "string",
  path: "string",
  markdown: "string",
  html: "string",
  boolean: "boolean",
  bool: "boolean",
  number: "number",
  int: "number",
  integer: "number",
  object: "object",
  json: "object",
};

export function jsonSchemaFor(descriptor: string): JsonSchema {
  const raw = descriptor.trim();

  if (raw.endsWith("[]")) {
    return { type: "array", items: jsonSchemaFor(raw.slice(0, -2)) };
  }
  if (raw.includes("|")) {
    return { type: "string", enum: raw.split("|").map((s) => s.trim()) };
  }

  const primitive = PRIMITIVE[raw.toLowerCase()];
  if (primitive) {
    // Keep the original descriptor: "url" and "markdown" say more than "string".
    return primitive === "string" && raw.toLowerCase() !== "string"
      ? { type: "string", description: raw }
      : { type: primitive };
  }

  // Anything else (a date mask like YYYY-MM-DD) is a string with a note.
  return { type: "string", description: raw };
}

/** The whole `out` map as one object schema. */
export function objectSchema(fields: Readonly<Record<string, string>>): {
  type: "object";
  properties: Record<string, JsonSchema>;
  required: string[];
  additionalProperties: false;
} {
  const properties: Record<string, JsonSchema> = {};
  for (const [name, descriptor] of Object.entries(fields)) {
    properties[name] = jsonSchemaFor(descriptor);
  }
  return {
    type: "object",
    properties,
    required: Object.keys(fields),
    additionalProperties: false,
  };
}

/** TypeScript type text for a descriptor, for the plain-ts target. */
export function tsType(descriptor: string): string {
  const raw = descriptor.trim();
  if (raw.endsWith("[]")) return `${tsType(raw.slice(0, -2))}[]`;
  if (raw.includes("|")) return raw.split("|").map((s) => JSON.stringify(s.trim())).join(" | ");

  const primitive = PRIMITIVE[raw.toLowerCase()];
  if (primitive === "object") return "Record<string, unknown>";
  return primitive ?? "string";
}

/**
 * `url`, `path`, `markdown` and `YYYY-MM-DD` all narrow to `string` in
 * TypeScript, so the descriptor rides along in a trailing comment. That keeps
 * the generated file honest about what a field means — and it is what lets
 * `ingest` read the spec back out without losing anything.
 */
export function tsInterfaceBody(
  fields: Readonly<Record<string, string>>,
  indent = "  ",
): string {
  const entries = Object.entries(fields);
  if (entries.length === 0) return `${indent}[key: string]: never;`;
  return entries
    .map(([name, descriptor]) => {
      const type = tsType(descriptor);
      const note = type === descriptor ? "" : ` // ${descriptor}`;
      return `${indent}${safeKey(name)}: ${type};${note}`;
    })
    .join("\n");
}

const safeKey = (name: string) =>
  /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
