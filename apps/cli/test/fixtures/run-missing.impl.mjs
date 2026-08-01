// SPDX-License-Identifier: Apache-2.0
/**
 * run-clean.yaml with two of its three nodes unimplemented. `gamma` is exported
 * but is not a function, which is the same hole as not exporting it at all.
 */

export async function alpha() {
  return { output: { seed: "s" } };
}

export const gamma = "not a function";
