// SPDX-License-Identifier: Apache-2.0
/** Implements every node of run-clean.yaml. `beta` is the slow one, on purpose. */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function alpha(context) {
  context.log("seeding");
  return { output: { seed: "s" } };
}

export async function beta() {
  await sleep(60);
  return {
    output: { body: "# body" },
    usage: { model: "demo", inputTokens: 10, outputTokens: 5, costUsd: 0.0002 },
  };
}

export async function gamma(context) {
  return { output: { page: context.inputs.length } };
}
