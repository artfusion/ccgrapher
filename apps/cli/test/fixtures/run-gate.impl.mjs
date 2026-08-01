// SPDX-License-Identifier: Apache-2.0
/** run-gate.yaml. No `review` export: a gate is answered, never executed. */

export async function draft() {
  return { output: { text: "# draft" } };
}

export async function ship() {
  return { output: { done: true } };
}
