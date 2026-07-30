// SPDX-License-Identifier: Apache-2.0
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { SpecError } from "./graph.js";
import { WorkflowSpec } from "./schema.js";

/**
 * Parse and validate a spec from a YAML or JSON string.
 *
 * Filesystem access lives in `./node.js` instead, so this entry point stays
 * importable from a browser bundle — the web canvas runs the same parser and
 * the same linter as the CLI.
 */
export function parseSpec(source: string, origin = "<inline>"): WorkflowSpec {
  let raw: unknown;
  try {
    raw = parseYaml(source);
  } catch (cause) {
    throw new SpecError(`${origin}: not valid YAML — ${(cause as Error).message}`, cause);
  }

  const result = WorkflowSpec.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("\n");
    throw new SpecError(`${origin}: spec failed validation\n${issues}`, result.error.issues);
  }
  return result.data;
}

/** Serialise a spec back to YAML — used when reconstructing one from code. */
export function formatSpec(spec: WorkflowSpec): string {
  return stringifyYaml(spec, {
    lineWidth: 100,
    flowCollectionPadding: true,
    defaultStringType: "PLAIN",
    defaultKeyType: "PLAIN",
  });
}
