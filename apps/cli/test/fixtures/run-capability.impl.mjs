// SPDX-License-Identifier: Apache-2.0
/**
 * run-clean.yaml again, this time reporting capabilities.
 *
 * `capabilities` is what this module verified was reachable before the run;
 * `context.capability(id)` is a node saying it actually reached for one. The
 * second id is never invoked on purpose: available and used are different
 * facts, and a fixture where they always coincide would prove neither.
 */

export const capabilities = ["mcp:docs/fetch", "skill:unused"];

export async function alpha(context) {
  context.capability("mcp:docs/fetch");
  return { output: { seed: "s" } };
}

export async function beta() {
  return { output: { body: "# body" } };
}

export async function gamma(context) {
  return { output: { page: context.inputs.length } };
}
