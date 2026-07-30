// SPDX-License-Identifier: Apache-2.0
/**
 * The inverse of codegen's descriptor mapping. `url`, `path`, `markdown` and
 * date masks all narrow to `string` in TypeScript, so the generated interfaces
 * carry the original descriptor in a trailing comment; when one is present it
 * wins, because it says more than the type does.
 */
export function descriptorFor(typeText: string, trailingComment?: string): string {
  const note = trailingComment?.replace(/^\s*\/\/\s?/, "").trim();
  if (note) return note;

  const text = typeText.trim();
  if (text.endsWith("[]")) return `${descriptorFor(text.slice(0, -2))}[]`;
  if (text === "Record<string, unknown>") return "object";

  // A union of string literals came from a "keep|drop" descriptor.
  if (text.includes("|")) {
    const parts = text.split("|").map((p) => p.trim().replace(/^["']|["']$/g, ""));
    if (parts.every(Boolean)) return parts.join("|");
  }
  return text;
}
