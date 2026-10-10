// SPDX-License-Identifier: Apache-2.0
/**
 * The plain-code steps of examples/research-desk.yaml, and nothing else. With
 * `--managed-agents`, the model steps run as sessions and these run here.
 */

export async function dedupe(context) {
  return { output: { finding: context.inputs.map((input) => input.output) } };
}

export async function vote(context) {
  const keep = context.inputs.filter((input) => input.output.vote === "keep").length;
  return { output: { survivor: { keep } } };
}
